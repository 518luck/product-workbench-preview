import fs from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import { digest, locationId } from './analysis-facts.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
await Parser.init();
const result = {
  units: [],
  types: [],
  imports: [],
  gaps: [],
  facts: { values: [], edges: [], entries: [] },
};
const grammars = new Map(),
  declarations = new Map(),
  calls = [];
const fnKinds = new Set([
  'function_definition',
  'function_declaration',
  'method_declaration',
  'func_literal',
  'lambda',
  'lambda_expression',
]);
const callKinds = new Set(['call', 'call_expression', 'new_expression']);
const children = (node) => node?.namedChildren || [];
const field = (node, key) => node.childForFieldName(key);
const position = (text, start) => {
  const prefix = text.slice(0, start).split(/\r\n|[\r\n\u2028\u2029]/);
  return { line: prefix.length, column: prefix.at(-1).length + 1 };
};
for (const { file, text, language } of input.files) {
  if (!grammars.has(language))
    grammars.set(
      language,
      await Language.load(new URL(`../assets/grammars/${language}.wasm`, import.meta.url).pathname),
    );
  const parser = new Parser();
  parser.setLanguage(grammars.get(language));
  const tree = parser.parse(text);
  if (tree.rootNode.hasError) {
    result.gaps.push({
      file,
      kind: 'parse',
      message: `${language} 语法存在错误或超出当前语法版本。`,
    });
    tree.delete();
    parser.delete();
    continue;
  }
  const addType = (node) =>
    result.types.push({
      id: `t-${digest(`${file}:${node.startIndex}:${node.endIndex}`).slice(0, 24)}`,
      file,
      kind: node.type,
      name: field(node, 'name')?.text || node.type,
      start: node.startIndex,
      end: node.endIndex,
      sourceHash: digest(text),
      contentHash: digest(node.text),
    });
  if (/\.pyi$/.test(file)) {
    addType(tree.rootNode);
    tree.delete();
    parser.delete();
    continue;
  }
  const owned = new Map(),
    byStart = new Map(),
    returns = new Map();
  function nameOf(node) {
    let name = field(node, 'name') || field(node, 'declarator');
    while (
      name &&
      !['identifier', 'field_identifier', 'operator_name', 'destructor_name'].includes(name.type)
    )
      name = field(name, 'declarator') || field(name, 'name') || children(name)[0];
    return name?.text || `<anonymous@${position(text, node.startIndex).line}>`;
  }
  function add(node, kind, scope) {
    const start = node.startIndex,
      end = node.endIndex;
    const unit = {
      id: `u-${digest(`${file}:${kind}:${start}:${end}`).slice(0, 24)}`,
      file,
      language,
      kind,
      name: kind === 'top-level' ? `<top-level@${position(text, start).line}>` : nameOf(node),
      scope,
      start,
      end,
      startPosition: position(text, start),
      endPosition: position(text, end),
      sourceHash: digest(text),
      contentHash: digest(text.slice(start, end)),
      role: /(^|\/)(__tests__|tests?|spec)(\/|$)|(^|\/)test_[^/]+\.py$|(?:_test\.go|\.(?:test|spec)\.[^.]+)$/.test(
        file,
      )
        ? 'verification'
        : 'product',
      calls: [],
      reviewPoints: [],
      parameters: [],
      returns: [],
    };
    result.units.push(unit);
    owned.set(node.id, unit);
    byStart.set(start, node);
    returns.set(unit.id, []);
    if (kind !== 'top-level') declarations.set(`${file}:${scope.join('.')}:${unit.name}`, unit);
    if (kind !== 'top-level' && !scope.length && unit.role === 'product')
      result.facts.entries.push({
        id: `entry-${unit.id}`,
        unitId: unit.id,
        file,
        kind: 'declaration',
        name: unit.name,
      });
    return unit;
  }
  function discover(node, scope = []) {
    if (
      [
        'class_definition',
        'class_specifier',
        'struct_specifier',
        'namespace_definition',
        'type_declaration',
        'type_definition',
        'enum_specifier',
        'import_statement',
        'import_from_statement',
        'import_declaration',
        'preproc_include',
        'package_clause',
      ].includes(node.type)
    )
      addType(node);
    if (fnKinds.has(node.type) && (field(node, 'body') || node.type === 'lambda')) {
      const unit = add(
        node,
        ['lambda', 'lambda_expression', 'func_literal'].includes(node.type)
          ? 'function-expression'
          : 'function',
        scope,
      );
      scope = [...scope, unit.name];
    }
    for (const child of children(node)) discover(child, scope);
  }
  discover(tree.rootNode);
  for (const statement of children(tree.rootNode)) {
    if (
      owned.has(statement.id) ||
      [
        'comment',
        'package_clause',
        'import_declaration',
        'preproc_include',
        'type_definition',
        'struct_specifier',
        'class_specifier',
        'namespace_definition',
      ].includes(statement.type)
    )
      continue;
    // Decorators and classes can execute module-level behavior; nested bodies still have independent owners.
    add(statement, 'top-level', []);
  }
  function point(unit, node, kind, targetField) {
    const start = node.startIndex,
      end = node.endIndex;
    const item = {
      id: locationId('p', unit.id, kind, start, end),
      kind,
      field: targetField,
      start,
      end,
      position: position(text, start),
      code: node.text.replace(/\s+/g, ' ').slice(0, 240),
    };
    if (!unit.reviewPoints.some((existing) => existing.id === item.id))
      unit.reviewPoints.push(item);
  }
  function data(unit, node, kind, extra = {}) {
    const item = {
      id: locationId('d', unit.id, kind, node.startIndex, node.endIndex),
      unitId: unit.id,
      file,
      start: node.startIndex,
      end: node.endIndex,
      kind,
      label: node.text.slice(0, 200),
      ...extra,
    };
    if (!result.facts.values.some((value) => value.id === item.id)) result.facts.values.push(item);
    return item;
  }
  const edge = (from, to, kind, certain = true) => {
    if (from && to && from !== to) result.facts.edges.push({ from, to, kind, certain });
  };
  for (const [nodeId, unit] of owned) {
    const node = byStart.get(unit.start),
      bindings = new Map(),
      mutable = new Set(),
      values = new Map();
    let parameters = field(node, 'parameters');
    if (!parameters) {
      let declarator = field(node, 'declarator');
      while (declarator && !parameters) {
        parameters = field(declarator, 'parameters');
        declarator = field(declarator, 'declarator');
      }
    }
    for (const parameter of children(parameters)) {
      const names =
        parameter.type === 'identifier'
          ? [parameter]
          : children(parameter).filter((child) =>
              ['identifier', 'field_identifier'].includes(child.type),
            );
      const name =
        field(parameter, 'name') || field(parameter, 'declarator') || names[0] || parameter;
      const parameterNames = language === 'go' && names.length ? names : [name];
      for (const actual of parameterNames) {
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(actual.text)) continue;
        const item = data(unit, actual, 'parameter', {
          index: unit.parameters.length,
          name: actual.text,
        });
        unit.parameters.push(item.id);
        bindings.set(actual.text, item.id);
        point(unit, actual, 'parameter', 'inputs');
      }
    }
    function inspectWrites(current) {
      if (current.id !== nodeId && owned.has(current.id)) return;
      if (
        [
          'assignment',
          'assignment_statement',
          'augmented_assignment',
          'augmented_assignment_statement',
          'update_expression',
          'inc_statement',
          'dec_statement',
        ].includes(current.type)
      ) {
        const target = field(current, 'left') || field(current, 'argument') || children(current)[0];
        if (target) mutable.add(target.text);
      }
      children(current).forEach(inspectWrites);
    }
    inspectWrites(node);
    function value(current) {
      if (!current || (current.id !== nodeId && owned.has(current.id))) return;
      if (values.has(current.id)) return values.get(current.id);
      const kind =
        current.type === 'identifier'
          ? 'read'
          : callKinds.has(current.type)
            ? 'call-result'
            : /(?:integer|float|string|number_literal|int_literal|true|false|none|null)$/.test(
                  current.type,
                )
              ? 'constant'
              : 'expression';
      const item = data(unit, current, kind);
      values.set(current.id, item);
      if (kind === 'read') {
        if (!mutable.has(current.text)) edge(bindings.get(current.text), item.id, 'binding-read');
        else item.requiresRuntime = '可变绑定需由实际执行确认。';
      } else if (kind === 'call-result') {
        const callee =
          field(current, 'function') || field(current, 'constructor') || children(current)[0];
        const call = {
          id: locationId('k', unit.id, 'call', current.startIndex, current.endIndex),
          expression: callee?.text || current.text,
          start: current.startIndex,
          end: current.endIndex,
          target: null,
          status: 'unknown',
          reason: '尚未由语义适配器或运行确认目标。',
          callbacks: [],
          argumentIds: children(field(current, 'arguments')).map(
            (argument) => value(argument)?.id || null,
          ),
          resultId: item.id,
        };
        unit.calls.push(call);
        calls.push({ unit, call, calleeType: callee?.type });
        item.callId = call.id;
      } else {
        const conditional =
          /conditional|boolean_operator/.test(current.type) ||
          /^(?:attribute|selector_expression|subscript|subscript_expression|index_expression|field_expression|dictionary|list|set|tuple|composite_literal|keyed_element|initializer_list)$/.test(
            current.type,
          ) ||
          current.children.some((node) => ['&&', '||'].includes(node.type));
        for (const child of children(current))
          edge(value(child)?.id, item.id, 'transform', !conditional);
      }
      return item;
    }
    function visit(current) {
      if (current.id !== nodeId && owned.has(current.id)) return;
      if (callKinds.has(current.type)) {
        value(current);
        point(unit, current, 'call', 'calls');
        if (language === 'go' && field(current, 'function')?.text === 'panic')
          point(unit, current, 'panic', 'exceptions');
      }
      if (
        current.type === 'return_statement' ||
        (language === 'python' && current.type === 'lambda')
      ) {
        const output = data(unit, current, 'return');
        unit.returns.push(output.id);
        point(unit, current, 'return', 'outputs');
        for (const child of children(current)) edge(value(child)?.id, output.id, 'return');
      }
      if (
        [
          'if_statement',
          'elif_clause',
          'while_statement',
          'for_statement',
          'for_in_statement',
          'switch_statement',
          'expression_switch_statement',
          'conditional_expression',
          'case_clause',
          'expression_case',
          'default_case',
          'boolean_operator',
        ].includes(current.type)
      )
        point(
          unit,
          field(current, 'condition') || field(current, 'value') || current,
          'condition',
          'conditions',
        );
      if (
        [
          'assignment',
          'assignment_statement',
          'augmented_assignment',
          'augmented_assignment_statement',
          'update_expression',
          'inc_statement',
          'dec_statement',
          'delete_statement',
          'go_statement',
          'send_statement',
        ].includes(current.type)
      ) {
        point(unit, current, 'write', 'sideEffects');
        value(current);
      }
      if (
        [
          'raise_statement',
          'throw_statement',
          'except_clause',
          'catch_clause',
          'finally_clause',
          'defer_statement',
          'with_statement',
        ].includes(current.type)
      )
        point(unit, current, current.type, 'exceptions');
      if (
        [
          'assignment',
          'short_var_declaration',
          'var_spec',
          'const_spec',
          'init_declarator',
        ].includes(current.type)
      ) {
        const left =
          field(current, 'left') || field(current, 'name') || field(current, 'declarator');
        const right = field(current, 'right') || field(current, 'value');
        const target = children(left).length === 1 ? children(left)[0] : left;
        if (target && right && !mutable.has(target.text))
          bindings.set(target.text, value(right)?.id);
      }
      for (const child of children(current)) visit(child);
    }
    const body = field(node, 'body');
    visit(body || node);
    unit.reviewPoints.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  }
  tree.delete();
  parser.delete();
}
console.log(JSON.stringify(result));
