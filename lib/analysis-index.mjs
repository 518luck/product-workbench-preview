import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { BlueprintError } from './errors.mjs';

export const PARSER_VERSION = '6.0.2';
// Changing indexing rules invalidates old symbol maps even when the source snapshot is unchanged.
export const INDEX_VERSION = 2;
export const hash = (text) => createHash('sha256').update(text).digest('hex');
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const unsupported = new Set([
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.c',
  '.cpp',
  '.cs',
  '.vue',
  '.svelte',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.lua',
  '.ex',
  '.exs',
  '.elm',
  '.clj',
  '.cljs',
  '.dart',
  '.scala',
  '.groovy',
  '.pl',
  '.r',
  '.R',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.h',
  '.hpp',
  '.m',
  '.mm',
  '.zig',
  '.fs',
  '.fsx',
  '.vb',
  '.jl',
]);
const excludedDirectories = new Map([
  ['.git', '版本控制'],
  ['.hg', '版本控制'],
  ['.svn', '版本控制'],
  ['node_modules', '依赖库'],
  ['vendor', '依赖库'],
  ['.venv', '依赖库'],
  ['dist', '生成目录'],
  ['build', '生成目录'],
  ['coverage', '生成目录'],
  ['.next', '生成目录'],
  ['.nuxt', '生成目录'],
  ['.blueprint-analysis', '分析输出自身'],
]);
const contextName = (file) =>
  /(^|\/)(package\.json|(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json|pnpm-workspace\.yaml|(?:vite|webpack|rollup|next)\.config\.[^/]+|[^/]+\.config\.(?:json|yaml|yml|toml))$/.test(
    file,
  );
const posix = (text) => text.split(path.sep).join('/');
const inScope = (file, entry) =>
  entry === '.' || file === entry || file.startsWith(`${entry}/`) || path.matchesGlob(file, entry);

export function normalizeScope(scope = {}) {
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    Object.keys(scope).some((key) => !['include', 'exclude'].includes(key))
  )
    throw new BlueprintError(
      'INVALID_ARGUMENT',
      '扫描配置仅接受 include、exclude 路径／glob 数组。',
    );
  const result = { include: scope.include ?? ['.'], exclude: scope.exclude ?? [] };
  for (const [key, values] of Object.entries(result)) {
    if (
      !Array.isArray(values) ||
      (key === 'include' && !values.length) ||
      values.some(
        (value) =>
          typeof value !== 'string' ||
          !value.trim() ||
          path.isAbsolute(value) ||
          value.split('/').includes('..'),
      )
    )
      throw new BlueprintError('INVALID_ARGUMENT', `${key} 应是项目内相对路径／glob 数组。`);
    result[key] = [
      ...new Set(values.map((value) => value.replace(/^\.\//, '').replace(/\/$/, '') || '.')),
    ].sort();
  }
  return result;
}

export function readText(filename) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    fs.readFileSync(filename),
  );
}
export function textPosition(source, offset) {
  let line = 1,
    lineStart = 0;
  for (const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) {
    const next = match.index + match[0].length;
    if (next > offset) break;
    line += 1;
    lineStart = next;
  }
  return { line, column: offset - lineStart + 1 };
}

export function inventory(root, scope = {}) {
  root = fs.realpathSync(path.resolve(root));
  scope = normalizeScope(scope);
  const directories = ['.'];
  const manifest = [],
    sources = new Map(),
    contexts = new Map(),
    gaps = [];
  function walk(directory) {
    let entries;
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    } catch (error) {
      const file = posix(path.relative(root, directory)) || '.';
      manifest.push({ file, kind: 'unreadable', reason: error.code });
      gaps.push({ file, kind: 'read', message: `无法列出目录：${error.code}` });
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name),
        file = posix(path.relative(root, absolute));
      const reason = scope.exclude.find((item) => inScope(file, item))
        ? '用户排除'
        : entry.isDirectory()
          ? excludedDirectories.get(entry.name)
          : /(?:\.min\.[cm]?js|\.map|\.tsbuildinfo)$/.test(entry.name)
            ? '生成文件'
            : undefined;
      if (entry.isSymbolicLink()) {
        manifest.push({ file, kind: 'excluded', reason: '符号链接（不跟随）' });
        continue;
      }
      if (reason) {
        manifest.push({ file, kind: 'excluded', reason, directory: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory()) {
        directories.push(file);
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        manifest.push({ file, kind: 'excluded', reason: '非普通文件' });
        continue;
      }
      if (
        !scope.include.some((item) => item === '.' || inScope(file, item)) &&
        !contextName(file)
      ) {
        manifest.push({ file, kind: 'excluded', reason: '扫描范围外' });
        continue;
      }
      const extension = path.extname(file).toLowerCase();
      const kind = contextName(file)
        ? 'context'
        : sourceExtensions.has(extension)
          ? /\.d\.[cm]?ts$/.test(file)
            ? 'types'
            : 'source'
          : unsupported.has(extension)
            ? 'unsupported'
            : 'other';
      const item = { file, kind };
      if (['source', 'types', 'context', 'unsupported'].includes(kind)) {
        try {
          const content = readText(absolute);
          Object.assign(item, { hash: hash(content), utf16Length: content.length });
          if (kind === 'source' || kind === 'types') sources.set(absolute, content);
          if (kind === 'context') contexts.set(absolute, content);
          if (kind === 'unsupported')
            gaps.push({ file, kind: 'language', message: `暂不分析 ${extension} 源码。` });
        } catch (error) {
          item.reason = error.code || error.message;
          gaps.push({ file, kind: 'read', message: `无法读取 UTF-8 内容：${item.reason}` });
        }
      }
      manifest.push(item);
    }
  }
  walk(root);
  if (!manifest.some((item) => item.file === '.blueprint-analysis'))
    manifest.push({
      file: '.blueprint-analysis',
      kind: 'excluded',
      reason: '分析输出自身',
      directory: true,
    });
  for (const entry of scope.include)
    if (
      !directories.some((file) => inScope(file, entry)) &&
      !manifest.some((item) => inScope(item.file, entry))
    )
      gaps.push({ file: entry, kind: 'scope', message: '扫描 include 未匹配任何文件或目录。' });
  manifest.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const fingerprint = hash(
    JSON.stringify({
      root,
      parser: PARSER_VERSION,
      protocol: 1,
      indexVersion: INDEX_VERSION,
      scope,
      manifest: manifest.filter((item) =>
        ['source', 'types', 'context', 'unsupported', 'unreadable'].includes(item.kind),
      ),
    }),
  );
  return { root, scope, manifest, sources, contexts, gaps, fingerprint };
}

function point(source, offset) {
  const position = source.getLineAndCharacterOfPosition(offset);
  return { line: position.line + 1, column: position.character + 1 };
}
function functionKind(node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return 'getter';
  if (ts.isSetAccessorDeclaration(node)) return 'setter';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isArrowFunction(node)) return 'arrow';
  return ts.isFunctionDeclaration(node) ? 'function' : 'function-expression';
}
function executable(node) {
  return ts.isFunctionLike(node) && !!node.body;
}
function label(node, source) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (node.name) return node.name.getText(source);
  if (
    ts.isVariableDeclaration(node.parent) ||
    ts.isPropertyAssignment(node.parent) ||
    ts.isPropertyDeclaration(node.parent)
  )
    return node.parent.name.getText(source);
  return `<anonymous@${point(source, node.getStart(source)).line}:${point(source, node.getStart(source)).column}>`;
}
function typeOnlyStatement(statement) {
  return (
    ts.isImportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isEmptyStatement(statement) ||
    (ts.isExportDeclaration(statement) && !statement.moduleSpecifier) ||
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

export function indexSnapshot(input) {
  const { root, sources, contexts } = input;
  const diagnostics = [],
    options = {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
      noLib: true,
    };
  // Read project options without executing plugins or reading files outside the inventory.
  const configFile =
    [...contexts.keys()].find((file) => file === path.join(root, 'tsconfig.json')) ||
    [...contexts.keys()].find((file) => file === path.join(root, 'jsconfig.json'));
  const configErrors = [];
  for (const [filename, content] of contexts) {
    let error;
    if (/\.[cm]?[jt]sx?$/.test(filename)) {
      const parsed = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
      for (const diagnostic of parsed.parseDiagnostics)
        diagnostics.push({
          file: posix(path.relative(root, filename)),
          kind: 'config',
          position: point(parsed, diagnostic.start ?? 0),
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        });
    } else if (filename.endsWith('.json')) {
      if (/^(?:tsconfig|jsconfig)(?:\..*)?\.json$/.test(path.basename(filename))) {
        const parsed = ts.parseConfigFileTextToJson(filename, content);
        if (parsed.error) error = ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n');
        else if (
          !parsed.config ||
          typeof parsed.config !== 'object' ||
          Array.isArray(parsed.config)
        )
          error = '配置顶层必须为对象。';
      } else {
        try {
          const parsed = JSON.parse(content.replace(/^\uFEFF/, ''));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            error = '配置顶层必须为对象。';
        } catch (failure) {
          error = failure.message;
        }
      }
      if (error)
        diagnostics.push({
          file: posix(path.relative(root, filename)),
          kind: 'config',
          message: `JSON 配置无法解析：${error}`,
        });
    }
  }
  if (configFile) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configFile,
      { noEmit: true, allowJs: true },
      {
        useCaseSensitiveFileNames: true,
        getCurrentDirectory: () => root,
        fileExists: (file) => sources.has(path.resolve(file)) || contexts.has(path.resolve(file)),
        readFile: (file) => contexts.get(path.resolve(file)) ?? sources.get(path.resolve(file)),
        readDirectory: () => [...sources.keys()],
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => configErrors.push(diagnostic),
      },
    );
    if (parsed) {
      Object.assign(options, parsed.options, {
        noEmit: true,
        noLib: true,
        allowJs: true,
        plugins: [],
        types: [],
        typeRoots: [],
      });
      configErrors.push(...parsed.errors.filter((error) => error.code !== 18003));
    }
  }
  for (const diagnostic of configErrors)
    diagnostics.push({
      file: diagnostic.file
        ? posix(path.relative(root, diagnostic.file.fileName))
        : posix(path.relative(root, configFile || root)),
      kind: 'config',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    });
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (file) => sources.has(path.resolve(file)) || contexts.has(path.resolve(file));
  host.readFile = (file) => sources.get(path.resolve(file)) ?? contexts.get(path.resolve(file));
  host.directoryExists = (directory) =>
    [...sources.keys(), ...contexts.keys()].some((file) =>
      file.startsWith(`${path.resolve(directory)}${path.sep}`),
    );
  host.getDirectories = () => [];
  host.getCurrentDirectory = () => root;
  host.realpath = (file) => path.resolve(file);
  host.getSourceFile = (file, languageVersion) => {
    const content = host.readFile(file);
    return content === undefined
      ? undefined
      : ts.createSourceFile(file, content, languageVersion, true);
  };
  const program = ts.createProgram({ rootNames: [...sources.keys()], options, host });
  const checker = program.getTypeChecker(),
    units = [],
    types = [],
    imports = [],
    nodeUnits = new Map(),
    topUnits = new Map();
  for (const source of program.getSourceFiles()) {
    if (!sources.has(path.resolve(source.fileName))) continue;
    const file = posix(path.relative(root, source.fileName));
    const errors = program.getSyntacticDiagnostics(source);
    for (const diagnostic of errors)
      diagnostics.push({
        file,
        kind: 'parse',
        position: point(source, diagnostic.start ?? 0),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      });
    if (errors.length) continue;
    const test = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/.test(file);
    const addUnit = (node, kind, scope, name) => {
      const start = node.getStart(source),
        end = node.end;
      const unit = {
        id: `u-${hash(`${file}:${kind}:${start}:${end}`).slice(0, 24)}`,
        file,
        kind,
        name,
        scope,
        start,
        end,
        startPosition: point(source, start),
        endPosition: point(source, end),
        sourceHash: hash(source.text),
        contentHash: hash(source.text.slice(start, end)),
        role: test ? 'verification' : 'product',
        calls: [],
      };
      units.push(unit);
      nodeUnits.set(node, unit);
      return unit;
    };
    if (!source.isDeclarationFile)
      for (const statement of source.statements) {
        if (!typeOnlyStatement(statement))
          topUnits.set(
            statement,
            addUnit(
              statement,
              'top-level',
              [],
              `<top-level@${point(source, statement.getStart(source)).line}>`,
            ),
          );
      }
    function visit(node, scope = []) {
      let next = scope;
      if (
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isObjectLiteralExpression(node)
      )
        next = [...scope, label(node, source)];
      if (executable(node) && !source.isDeclarationFile) {
        const name = label(node, source);
        addUnit(node, functionKind(node), scope, name);
        next = [...scope, name];
      } else if (
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        (source.isDeclarationFile &&
          (ts.isClassDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isVariableDeclaration(node) ||
            ts.isPropertyDeclaration(node))) ||
        (ts.isFunctionLike(node) && !node.body)
      ) {
        types.push({
          id: `t-${hash(`${file}:${node.getStart(source)}:${node.end}`).slice(0, 24)}`,
          file,
          kind: ts.SyntaxKind[node.kind],
          name: label(node, source),
          start: node.getStart(source),
          end: node.end,
          sourceHash: hash(source.text),
          contentHash: hash(source.text.slice(node.getStart(source), node.end)),
        });
      }
      ts.forEachChild(node, (child) => visit(child, next));
    }
    visit(source);
  }
  function resolveDeclaration(node) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration || symbol?.declarations?.[0];
  }
  function targetUnit(declaration) {
    if (!declaration) return;
    if (nodeUnits.has(declaration) && nodeUnits.get(declaration).kind !== 'top-level')
      return nodeUnits.get(declaration);
    if (declaration.initializer && nodeUnits.has(declaration.initializer))
      return nodeUnits.get(declaration.initializer);
  }
  function unwrapped(expression) {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      expression = expression.expression;
    return expression;
  }
  const writtenSymbols = new Set();
  function symbolAt(node) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  }
  function written(node) {
    node = unwrapped(node);
    const symbol = symbolAt(node);
    if (symbol) writtenSymbols.add(symbol);
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node))
      ts.forEachChild(node, written);
    if (ts.isShorthandPropertyAssignment(node)) {
      const value = checker.getShorthandAssignmentValueSymbol(node);
      if (value) writtenSymbols.add(value);
    }
    if (ts.isPropertyAssignment(node)) written(node.initializer);
  }
  for (const source of program.getSourceFiles())
    if (sources.has(path.resolve(source.fileName))) {
      function writes(node) {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          written(node.left);
        if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
        )
          written(node.operand);
        if (
          (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
          !ts.isVariableDeclarationList(node.initializer)
        )
          written(node.initializer);
        ts.forEachChild(node, writes);
      }
      writes(source);
    }
  function staticTarget(expression, seen = new Set()) {
    expression = unwrapped(expression);
    if (executable(expression)) return targetUnit(expression);
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = unwrapped(expression.expression),
        receiverSymbol = checker.getSymbolAtLocation(receiver);
      if (!ts.isIdentifier(receiver) || !receiverSymbol?.declarations?.some(ts.isNamespaceImport))
        return;
    } else if (!ts.isIdentifier(expression)) return;
    const symbol = symbolAt(expression);
    if (!symbol || seen.has(symbol) || writtenSymbols.has(symbol)) return;
    seen.add(symbol);
    for (const declaration of symbol.declarations || []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) return targetUnit(declaration);
      if (
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        declaration.initializer
      )
        return staticTarget(declaration.initializer, seen);
      if (ts.isClassDeclaration(declaration))
        return declaration.members
          .filter(ts.isConstructorDeclaration)
          .map(targetUnit)
          .find(Boolean);
    }
  }
  for (const source of program.getSourceFiles()) {
    if (
      !sources.has(path.resolve(source.fileName)) ||
      program.getSyntacticDiagnostics(source).length
    )
      continue;
    function visit(node, owner) {
      owner = nodeUnits.get(node) || topUnits.get(node) || owner;
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node)
      ) {
        const moduleNode = node.moduleSpecifier || node.moduleReference?.expression;
        if (moduleNode && ts.isStringLiteral(moduleNode)) {
          const resolved = ts.resolveModuleName(
            moduleNode.text,
            source.fileName,
            options,
            host,
          ).resolvedModule;
          const aliases = [];
          if (ts.isImportDeclaration(node)) {
            if (node.importClause?.name)
              aliases.push({ local: node.importClause.name.text, imported: 'default' });
            const bindings = node.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings))
              for (const specifier of bindings.elements)
                aliases.push({
                  local: specifier.name.text,
                  imported: specifier.propertyName?.text || specifier.name.text,
                });
            if (bindings && ts.isNamespaceImport(bindings))
              aliases.push({ local: bindings.name.text, imported: '*' });
          }
          imports.push({
            file: posix(path.relative(root, source.fileName)),
            module: moduleNode.text,
            aliases,
            target:
              resolved && sources.has(path.resolve(resolved.resolvedFileName))
                ? posix(path.relative(root, resolved.resolvedFileName))
                : null,
            status: resolved ? 'static' : 'unknown',
          });
        }
      }
      if (owner && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
        const declaration =
          checker.getResolvedSignature(node)?.declaration || resolveDeclaration(node.expression);
        // Type signatures identify candidate declarations, not necessarily runtime values.
        // Parameters, mutable bindings and receiver dispatch remain unknown in this first version.
        const target = staticTarget(node.expression);
        // Only a concrete declaration is evidence; don't infer callback/framework/dynamic edges by names.
        owner.calls.push({
          expression: node.expression.getText(source),
          start: node.getStart(source),
          target: target?.id || null,
          status: target ? 'resolved' : 'unknown',
          ...(target
            ? {}
            : {
                candidateTargets: targetUnit(declaration) ? [targetUnit(declaration).id] : [],
                reason: declaration
                  ? '外部／声明签名／动态目标，未确认执行关系'
                  : '无法静态解析调用目标',
              }),
          callbacks: (node.arguments || [])
            .filter(executable)
            .map((arg) => nodeUnits.get(arg)?.id)
            .filter(Boolean),
        });
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    }
    visit(source);
  }
  let gitCommit = null;
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    /* Git is supplementary; source hashes are authoritative. */
  }
  return {
    ...input,
    units: units.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.start - b.start),
    types,
    imports,
    gaps: [...input.gaps, ...diagnostics],
    gitCommit,
  };
}
