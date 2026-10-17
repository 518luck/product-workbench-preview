import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './analysis-facts.mjs';
import { BlueprintError } from './errors.mjs';

const assets = fileURLToPath(new URL('../assets/analyzers/', import.meta.url));
const binaryHashes = new Map();
const goKey = () =>
  digest(
    ['go.mod', 'go.sum', 'main.go']
      .map((file) => fs.readFileSync(path.join(assets, 'go', file)))
      .join(''),
  ).slice(0, 20);
export const goAnalyzerPath = () =>
  process.env.PRODUCT_BLUEPRINT_GO_ANALYZER ||
  path.join(
    os.tmpdir(),
    `product-blueprint-go-${goKey()}`,
    process.platform === 'win32' ? 'analyzer.exe' : 'analyzer',
  );
export const cppAnalyzerPath = () =>
  process.env.PRODUCT_BLUEPRINT_CPP_ANALYZER ||
  path.join(
    os.tmpdir(),
    `product-blueprint-cpp-${digest(fs.readFileSync(path.join(assets, 'cpp/main.cpp'))).slice(0, 20)}`,
    'analyzer',
  );
export function nativeConfiguration() {
  const binary = goAnalyzerPath();
  let goBinary = null;
  if (fs.existsSync(binary)) {
    const stat = fs.statSync(binary, { bigint: true }),
      key = `${stat.size}:${stat.mtimeNs}`;
    if (binaryHashes.get(binary)?.key !== key)
      binaryHashes.set(binary, { key, hash: digest(fs.readFileSync(binary)) });
    goBinary = binaryHashes.get(binary).hash;
  }
  const cpp = cppAnalyzerPath();
  let cppBinary = null;
  if (fs.existsSync(cpp)) {
    const stat = fs.statSync(cpp, { bigint: true }),
      key = `${stat.size}:${stat.mtimeNs}`;
    if (binaryHashes.get(cpp)?.key !== key)
      binaryHashes.set(cpp, { key, hash: digest(fs.readFileSync(cpp)) });
    cppBinary = binaryHashes.get(cpp).hash;
  }
  return {
    pythonHelper: digest(fs.readFileSync(path.join(assets, 'python-analysis.py'))),
    goHelper: goKey(),
    goBinary,
    cppHelper: digest(fs.readFileSync(path.join(assets, 'cpp/main.cpp'))),
    cppBinary,
    clang: 'ast-json-compile-db-v1',
  };
}
export function prepareLanguage(language) {
  if (language === 'cpp') {
    const config =
      process.env.LLVM_CONFIG ||
      [
        '/opt/homebrew/opt/llvm@21/bin/llvm-config',
        '/opt/homebrew/opt/llvm/bin/llvm-config',
        '/usr/bin/llvm-config',
      ].find((file) => fs.existsSync(file)) ||
      'llvm-config';
    const query = (args) => {
      const result = spawnSync(config, args, { encoding: 'utf8', timeout: 10000 });
      if (result.error || result.status !== 0)
        throw new BlueprintError(
          'ENVIRONMENT_UNAVAILABLE',
          '缺少可选 LLVM/Clang LibTooling 开发库及 llvm-config；由 AI 准备环境后重试。',
        );
      return result.stdout.trim();
    };
    const prefix = query(['--prefix']),
      version = query(['--version']),
      destination = cppAnalyzerPath();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const result = spawnSync(
      path.join(prefix, 'bin/clang++'),
      [
        '-std=c++17',
        path.join(assets, 'cpp/main.cpp'),
        '-I' + path.join(prefix, 'include'),
        '-L' + path.join(prefix, 'lib'),
        '-Wl,-rpath,' + path.join(prefix, 'lib'),
        '-lclang-cpp',
        '-lLLVM',
        '-o',
        destination,
      ],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 1048576 },
    );
    if (result.error || result.status !== 0)
      throw new BlueprintError(
        'ENVIRONMENT_UNAVAILABLE',
        `LibTooling 构建失败：${result.error?.message || result.stderr}`,
      );
    return {
      language,
      available: true,
      path: destination,
      version,
      hash: digest(fs.readFileSync(destination)),
    };
  }
  if (language !== 'go')
    throw new BlueprintError('INVALID_ARGUMENT', '可准备 go 或 cpp；Python 使用本机 ast。');
  const destination = goAnalyzerPath(),
    directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(destination)) {
    const build = path.join(directory, 'build');
    fs.cpSync(path.join(assets, 'go'), build, { recursive: true });
    const result = spawnSync('go', ['build', '-mod=readonly', '-o', destination, '.'], {
      cwd: build,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 1048576,
      env: { ...process.env, GOTOOLCHAIN: 'local' },
    });
    if (result.error || result.status !== 0)
      throw new BlueprintError(
        'ENVIRONMENT_UNAVAILABLE',
        `Go 语义工具构建失败：${result.error?.message || result.stderr}`,
      );
  }
  return {
    language,
    available: true,
    path: destination,
    hash: digest(fs.readFileSync(destination)),
    dependency: 'golang.org/x/tools@v0.50.0',
  };
}
const utf16 = (text, offset) => Buffer.from(text).subarray(0, offset).toString('utf8').length;
export function enrichNative(input, result) {
  const sources = new Map(
    [...input.foreignSources].map(([absolute, text]) => [
      path.relative(input.root, absolute).split(path.sep).join('/'),
      text,
    ]),
  );
  const unitMap = new Map(result.units.map((unit) => [unit.id, unit]));
  const locate = (file, offset) =>
    result.units
      .filter(
        (unit) =>
          unit.file === file &&
          unit.start <= offset &&
          unit.end > offset &&
          unit.kind !== 'top-level',
      )
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  const resolve = (call, target, backend) => {
    if (!target) return;
    call.target = target.id;
    call.status = 'resolved';
    call.backend = backend;
    delete call.reason;
  };
  const python = [...sources]
    .filter(([file]) => /\.py$/.test(file))
    .map(([file, text]) => ({ file, text }));
  if (python.length) {
    const run = spawnSync('python3', ['-I', path.join(assets, 'python-analysis.py')], {
      input: JSON.stringify({ files: python }),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (run.error || run.status !== 0)
      result.gaps.push({
        kind: 'semantic',
        language: 'python',
        message: `Python ast 不可用：${run.error?.message || run.stderr}`,
      });
    else {
      const native = JSON.parse(run.stdout),
        declarations = new Map();
      result.gaps.push(...native.gaps);
      for (const fn of native.functions) {
        const unit = locate(fn.file, fn.start);
        if (!unit) continue;
        unit.semantic = { backend: 'python-ast', ...fn };
        declarations.set(`${fn.file}:${fn.scope.join('.')}:${fn.name}`, unit);
      }
      for (const item of native.calls) {
        const owner = locate(item.file, item.start),
          call = owner?.calls.find((call) => call.start === item.start && call.end === item.end);
        if (!call || !item.direct || item.keywords) continue;
        const meta = owner.semantic;
        if (
          !meta ||
          meta.parameters.includes(item.name) ||
          meta.writes.includes(item.name) ||
          native.moduleWrites[item.file]?.includes(item.name)
        )
          continue;
        let target;
        for (let depth = meta.scope.length + 1; depth >= 0 && !target; depth--)
          target = declarations.get(
            `${item.file}:${[...meta.scope, meta.name].slice(0, depth).join('.')}:${item.name}`,
          );
        if (!target) {
          const imported = native.imports.find(
            (entry) => entry.file === item.file && entry.alias === item.name && entry.name !== '*',
          );
          if (imported && imported.level <= 1) {
            const module = imported.module.replaceAll('.', '/');
            const base = imported.level ? path.posix.dirname(item.file) : '.';
            target = declarations.get(`${path.posix.join(base, module + '.py')}::${imported.name}`);
          }
        }
        if (target && !target.semantic?.decorated) resolve(call, target, 'python-ast-scope');
      }
    }
  }
  if ([...sources.keys()].some((file) => file.endsWith('.go'))) {
    const binary = goAnalyzerPath();
    if (!fs.existsSync(binary))
      result.gaps.push({
        kind: 'semantic',
        language: 'go',
        message:
          'Go packages/SSA 工具尚未准备；AI 可执行 analysis prepare --language go，语法解析不等于语义核验。',
      });
    else {
      const run = spawnSync(binary, [input.root], {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CGO_ENABLED: '0' },
      });
      if (run.error || run.status !== 0)
        result.gaps.push({
          kind: 'semantic',
          language: 'go',
          message: run.error?.message || run.stderr,
        });
      else {
        const native = JSON.parse(run.stdout);
        result.gaps.push(
          ...native.gaps.map((message) => ({ kind: 'semantic', language: 'go', message })),
        );
        const toPosition = (position) => {
          const file = path.relative(input.root, position.file).split(path.sep).join('/');
          return {
            file,
            offset: sources.has(file) ? utf16(sources.get(file), position.offset) : -1,
          };
        };
        for (const fn of native.functions) {
          const p = toPosition(fn),
            unit = locate(p.file, p.offset);
          if (unit)
            unit.semantic = {
              backend: 'go-packages-ssa',
              result: fn.result,
              parameters: fn.parameters,
            };
        }
        for (const item of native.calls) {
          const p = toPosition(item),
            owner = locate(p.file, p.offset),
            candidates =
              owner?.calls.filter((call) => call.start <= p.offset && call.end > p.offset) || [],
            // SSA positions may identify a closing parenthesis. Only an unambiguous
            // matching expression is evidence; never pick an arbitrary nested call.
            precise = candidates.filter((call) => call.end - 1 === p.offset),
            call =
              precise.length === 1 ? precise[0] : candidates.length === 1 ? candidates[0] : null;
          if (!call) continue;
          call.ssaArguments = item.arguments;
          if (item.invoke || !item.target) continue;
          const target = toPosition(item.target);
          resolve(call, locate(target.file, target.offset), 'go-ssa-static-callee');
        }
      }
    }
  }
  if ([...sources.keys()].some((file) => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(file))) {
    const database = [...input.contexts].find(
      ([file]) => path.basename(file) === 'compile_commands.json',
    );
    if (!database)
      result.gaps.push({
        kind: 'semantic',
        language: 'cpp',
        message: '缺少 compile_commands.json，编译参数未知；仅有语法索引，C++ 连接不能静态通过。',
      });
    else {
      let commands;
      try {
        commands = JSON.parse(database[1]);
      } catch {
        commands = [];
      }
      for (const entry of commands) {
        let directory = path.resolve(input.root, entry.directory || '.');
        if (fs.existsSync(directory)) directory = fs.realpathSync(directory);
        const absolute = path.resolve(directory, entry.file),
          file = path.relative(input.root, absolute).split(path.sep).join('/');
        if (!sources.has(file)) continue;
        if (
          !Array.isArray(entry.arguments) ||
          entry.arguments.some(
            (arg) =>
              typeof arg !== 'string' ||
              /(?:^-fplugin|^-load|^-o.|^@|^-Xclang|^-save-temps|^-MJ)/.test(arg),
          )
        ) {
          result.gaps.push({
            file,
            kind: 'semantic',
            language: 'cpp',
            message:
              '编译数据库需要 arguments 数组，插件、响应文件和额外输出参数不支持安全静态扫描。',
          });
          continue;
        }
        const args = [];
        for (let i = 1; i < entry.arguments.length; i++) {
          const arg = entry.arguments[i];
          if (arg === '-o') {
            i++;
            continue;
          }
          if (arg === '-c' || path.resolve(directory, arg) === absolute) continue;
          args.push(arg);
        }
        const tooling = cppAnalyzerPath();
        if (fs.existsSync(tooling)) {
          const report = spawnSync(tooling, [absolute, directory, ...args], {
            encoding: 'utf8',
            timeout: 60000,
            maxBuffer: 64 * 1024 * 1024,
          });
          if (report.error || report.status !== 0) {
            result.gaps.push({
              file,
              kind: 'semantic',
              language: 'cpp',
              message: `LibTooling 无法按编译数据库分析：${report.error?.message || report.stderr.slice(0, 2000)}`,
            });
            continue;
          }
          const native = JSON.parse(report.stdout),
            at = (position) => {
              let name = position.file;
              try {
                name = fs.realpathSync(name);
              } catch {}
              const relative = path.relative(input.root, name).split(path.sep).join('/');
              return {
                file: relative,
                offset: sources.has(relative) ? utf16(sources.get(relative), position.offset) : -1,
              };
            };
          for (const item of native.functions) {
            const p = at(item),
              unit = locate(p.file, p.offset);
            if (unit && !item.macro)
              unit.semantic = {
                backend: 'clang-libtooling',
                name: item.name,
                type: item.type,
                virtual: item.virtual,
              };
          }
          for (const item of native.calls) {
            if (item.macro || item.virtual || !item.target) continue;
            const p = at(item),
              owner = locate(p.file, p.offset),
              end = item.end ? at(item.end) : null,
              candidates =
                owner?.calls.filter(
                  (call) => call.start === p.offset && (!end || call.end === end.offset),
                ) || [],
              call = candidates.length === 1 ? candidates[0] : null,
              target = at(item.target);
            if (call)
              resolve(call, locate(target.file, target.offset), 'clang-libtooling-direct-callee');
          }
          continue;
        }
        const run = spawnSync(
          'clang++',
          [...args, '-fsyntax-only', '-Xclang', '-ast-dump=json', absolute],
          { cwd: directory, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
        );
        if (run.error || run.status !== 0) {
          result.gaps.push({
            file,
            kind: 'semantic',
            language: 'cpp',
            message: `Clang 无法按编译数据库分析：${run.error?.message || run.stderr.slice(0, 2000)}`,
          });
          continue;
        }
        const ast = JSON.parse(run.stdout),
          definitions = new Map(),
          declarations = new Map(),
          ownedCalls = new Map();
        const nodes = [];
        function walk(node) {
          nodes.push(node);
          for (const child of node.inner || []) walk(child);
        }
        walk(ast);
        for (const node of nodes.filter((node) => node.kind === 'FunctionDecl')) {
          declarations.set(node.id, node);
          if (
            !node.range?.begin ||
            node.range.begin.spellingLoc ||
            node.loc?.includedFrom ||
            !node.inner?.some((child) => child.kind === 'CompoundStmt')
          )
            continue;
          const unit = locate(file, utf16(sources.get(file), node.range.begin.offset));
          if (unit) {
            unit.semantic = {
              backend: 'clang-frontend',
              name: node.name,
              type: node.type?.qualType,
              virtual: Boolean(node.virtual),
            };
            definitions.set(node.mangledName || node.name, unit);
            const own = (item) => {
              if (['CallExpr', 'CXXMemberCallExpr'].includes(item.kind))
                ownedCalls.set(item.id, unit);
              for (const next of item.inner || []) own(next);
            };
            for (const item of node.inner || []) own(item);
          }
        }
        for (const node of nodes.filter((node) =>
          ['CallExpr', 'CXXMemberCallExpr'].includes(node.kind),
        )) {
          if (!Number.isInteger(node.range?.begin?.offset) || node.range.begin.spellingLoc)
            continue;
          const start = utf16(sources.get(file), node.range.begin.offset),
            end = Number.isInteger(node.range?.end?.offset)
              ? utf16(sources.get(file), node.range.end.offset + (node.range.end.tokLen || 1))
              : null,
            owner = ownedCalls.get(node.id),
            call = owner?.calls.find((call) => call.start === start && call.end === end);
          if (!call || node.kind !== 'CallExpr') continue;
          let reference;
          const find = (node) => {
            if (node.referencedDecl?.kind === 'FunctionDecl') reference = node.referencedDecl;
            for (const child of node.inner || []) find(child);
          };
          find(node.inner?.[0] || {});
          const declaration = declarations.get(reference?.id);
          resolve(
            call,
            definitions.get(declaration?.mangledName || reference?.name),
            'clang-direct-callee',
          );
        }
      }
    }
  }
  for (const unit of result.units)
    for (const call of unit.calls) {
      const target = unitMap.get(call.target);
      if (!target) continue;
      for (const [index, argument] of call.argumentIds.entries())
        if (argument && target.parameters[index])
          result.facts.edges.push({
            from: argument,
            to: target.parameters[index],
            kind: 'argument',
            certain: true,
          });
      for (const returned of target.returns)
        result.facts.edges.push({
          from: returned,
          to: call.resultId,
          kind: 'call-return',
          certain: target.returns.length === 1,
        });
    }
  return result;
}
