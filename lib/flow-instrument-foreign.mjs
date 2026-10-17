import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const quote = JSON.stringify;
const child = (node, key) => node.childForFieldName(key);
const editsApply = (text, edits) =>
  edits
    .sort((a, b) => b.start - a.start || b.end - a.end || (b.order || 0) - (a.order || 0))
    .reduce(
      (content, edit) => content.slice(0, edit.start) + edit.text + content.slice(edit.end),
      text,
    );
export async function instrumentForeign(root, state, selected) {
  const unsupported = [],
    python = state.units.some((unit) => unit.language === 'python' && selected.has(unit.id));
  if (python) {
    const destination = path.join(root, '__product_blueprint_probe.py');
    if (fs.existsSync(destination)) throw Error('项目已占用探针保留文件名。');
    fs.copyFileSync(path.join(assets, 'runtime/python-probe.py'), destination);
    const result = spawnSync(
      'python3',
      ['-I', path.join(assets, 'analyzers/python-instrument.py')],
      {
        input: JSON.stringify({
          root,
          units: state.units,
          values: state.facts.values,
          selected: [...selected],
        }),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1048576,
      },
    );
    if (result.error || result.status !== 0)
      throw Error(`Python 探针注入失败：${result.error?.message || result.stderr}`);
    unsupported.push(...JSON.parse(result.stdout));
  }
  await Parser.init();
  for (const language of ['go', 'cpp']) {
    const units = state.units.filter(
      (unit) => unit.language === language && selected.has(unit.id) && unit.kind !== 'top-level',
    );
    if (!units.length) continue;
    const parser = new Parser();
    parser.setLanguage(await Language.load(path.join(assets, 'grammars', language + '.wasm')));
    for (const file of [...new Set(units.map((unit) => unit.file))]) {
      const filename = path.join(root, file),
        text = fs.readFileSync(filename, 'utf8'),
        tree = parser.parse(text),
        nodes = new Map();
      const visit = (node) => {
        nodes.set(node.startIndex + ':' + node.endIndex, node);
        for (const item of node.namedChildren) visit(item);
      };
      visit(tree.rootNode);
      const edits = [],
        fileUnits = units.filter((unit) => unit.file === file);
      for (const unit of fileUnits) {
        const node = nodes.get(unit.start + ':' + unit.end),
          body = node && child(node, 'body');
        const scalar =
          /^(?:int|int32|int64|float32|float64|bool|string|double|float|long|long long|unsigned|unsigned int)$/;
        const supported =
          language === 'go'
            ? node?.type === 'function_declaration' &&
              unit.semantic?.result &&
              scalar.test(unit.semantic.result) &&
              unit.semantic.parameters.every((type) => scalar.test(type))
            : node?.type === 'function_definition' &&
              ['clang-frontend', 'clang-libtooling'].includes(unit.semantic?.backend) &&
              /^(?:int|bool|double|float|long) \((?:int|bool|double|float|long|,| )*\)$/.test(
                unit.semantic.type || '',
              ) &&
              !/\b(?:constexpr|consteval|virtual|template)\b/.test(node.text);
        if (!body || !supported) {
          unsupported.push({
            unitId: unit.id,
            message:
              '此语言运行探针目前仅支持有语义信息的标量参数和单返回值自由函数；方法、泛型、宏、指针及动态分派保留未核验。',
          });
          continue;
        }
        const params = unit.parameters.map((id) =>
          state.facts.values.find((value) => value.id === id),
        );
        const frame = '__product_blueprint_frame';
        if (unit.language === 'go')
          edits.push({
            start: body.startIndex + 1,
            end: body.startIndex + 1,
            text: `\n${frame} := __pbEnter(${quote(unit.id)}, []string{${params.map((p) => quote(p.id)).join(',')}}, []any{${params.map((p) => p.name).join(',')}}); defer __pbExit(${frame})\n`,
          });
        else
          edits.push({
            start: body.startIndex + 1,
            end: body.startIndex + 1,
            text: `\n__pb::Frame ${frame}(${quote(unit.id)}, {${params.map((p) => quote(p.id)).join(',')}}, {${params.map((p) => `__pb::scalar(${p.name})`).join(',')}});\n`,
          });
        for (const point of unit.reviewPoints.filter((point) =>
          ['conditions', 'exceptions'].includes(point.field),
        )) {
          const target = [...nodes.values()].find(
            (node) => node.startIndex === point.start && node.endIndex === point.end,
          );
          if (!target) continue;
          const expression =
            point.field === 'conditions' && point.kind === 'condition'
              ? child(target, 'value') || target
              : point.kind === 'throw_statement'
                ? target.namedChildren[0]
                : point.kind === 'panic'
                  ? child(target, 'arguments')?.namedChildren[0]
                  : null;
          if (!expression) continue;
          edits.push({
            start: expression.startIndex,
            end: expression.startIndex,
            order: 2,
            text: `${language === 'go' ? (point.field === 'conditions' ? '__pbBranch' : '__pbPoint') : point.field === 'conditions' ? '__pb::branch' : '__pb::point'}(${frame},${quote(point.id)},`,
          });
          edits.push({
            start: expression.endIndex,
            end: expression.endIndex,
            order: -1,
            text: ')',
          });
        }
        // Paired insertions preserve nested call evaluation; no original expression is duplicated.
        for (const returned of unit.returns.map((id) =>
          state.facts.values.find((value) => value.id === id),
        )) {
          const returnedNode = [...nodes.values()].find(
            (node) => node.type === 'return_statement' && node.startIndex === returned.start,
          );
          const expression = returnedNode?.namedChildren[0];
          if (!expression) continue;
          edits.push({
            start: expression.startIndex,
            end: expression.startIndex,
            order: 0,
            text:
              language === 'go'
                ? `__pbReturn(${frame},${quote(returned.id)},`
                : `__pb::returned(${frame},${quote(returned.id)},`,
          });
          edits.push({ start: expression.endIndex, end: expression.endIndex, order: 1, text: ')' });
        }
        for (const call of unit.calls) {
          const target = state.units.find((unit) => unit.id === call.target),
            callNode = [...nodes.values()].find(
              (node) =>
                ['call_expression', 'call'].includes(node.type) &&
                node.startIndex === call.start &&
                node.endIndex === call.end,
            );
          if (
            !callNode ||
            !target ||
            target.file !== unit.file ||
            !units.some((unit) => unit.id === target.id)
          )
            continue;
          const callee = child(callNode, 'function'),
            args = child(callNode, 'arguments')?.namedChildren || [];
          if (
            !callee ||
            callee.type !== 'identifier' ||
            args.some(
              (node) =>
                !/^(identifier|int_literal|float_literal|true|false|interpreted_string_literal|number_literal)$/.test(
                  node.type,
                ),
            )
          ) {
            unsupported.push({
              unitId: unit.id,
              callId: call.id,
              message: '复杂参数求值需要额外适配；未合成其调用证据。',
            });
            continue;
          }
          const resultType = target.semantic?.result;
          if (language === 'go' && resultType) {
            const prefix = `__pbCall(${frame},${quote(call.id)},${quote(target.id)},${quote(call.resultId)},[]string{${call.argumentIds.map(quote).join(',')}},${callee.text},${quote(target.name)},func() ${resultType} { return `;
            edits.push({ start: call.start, end: call.start, order: 1, text: prefix });
            edits.push({ start: call.end, end: call.end, order: 0, text: ' })' });
          } else if (language === 'cpp') {
            edits.push({
              start: call.start,
              end: call.start,
              order: 1,
              text: `__pb::invoke(${frame},${quote(call.id)},${quote(target.id)},${quote(call.resultId)},{${call.argumentIds.map(quote).join(',')}},[&](){return `,
            });
            edits.push({ start: call.end, end: call.end, order: 0, text: ';})' });
          }
        }
      }
      if (language === 'cpp')
        edits.push({ start: 0, end: 0, text: '#include "__product_blueprint_probe.hpp"\n' });
      fs.writeFileSync(filename, editsApply(text, edits));
      const directory = path.dirname(filename),
        destination = path.join(
          directory,
          language === 'go' ? 'zz_product_blueprint_probe.go' : '__product_blueprint_probe.hpp',
        );
      if (!fs.existsSync(destination)) {
        if (language === 'go') {
          const packageName = tree.rootNode.namedChildren.find(
            (node) => node.type === 'package_clause',
          )?.namedChildren[0]?.text;
          fs.writeFileSync(
            destination,
            fs
              .readFileSync(path.join(assets, 'runtime/go-probe.go.txt'), 'utf8')
              .replace('__PACKAGE__', packageName),
          );
        } else fs.copyFileSync(path.join(assets, 'runtime/cpp-probe.hpp'), destination);
      }
      tree.delete();
    }
    parser.delete();
  }
  return unsupported;
}
