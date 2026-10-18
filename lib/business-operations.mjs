import ts from 'typescript';
import { digest } from './analysis-facts.mjs';

const unwrap = (node) => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)))
    node = node.expression;
  return node;
};

// An operation is a source registration/dispatch identity, not a product feature.
// Unknown receivers and computed triggers remain candidates, never resolved calls.
export function indexBusinessOperations(program, nodeUnits, entries, mutableSymbols) {
  const checker = program.getTypeChecker(),
    operations = [];
  const unitMap = new Map([...nodeUnits.values()].map((u) => [u.id, u]));
  const declaration = (node) => {
    if (!node) return;
    let symbol = checker.getSymbolAtLocation(node);
    if (mutableSymbols.has(symbol)) return;
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration;
  };
  const literal = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return literal(declaration(node)?.initializer, seen);
  };
  const owner = (node) => {
    for (let current = node; current; current = current.parent)
      if (nodeUnits.has(current)) return nodeUnits.get(current);
  };
  const target = (node) => {
    const d = declaration(node);
    return nodeUnits.get(node) || nodeUnits.get(d) || nodeUnits.get(d?.initializer);
  };
  const imported = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node)) {
      const base = imported(node.expression, seen);
      return base && { module: base.module, name: node.name.text };
    }
    for (const d of checker.getSymbolAtLocation(node)?.declarations || []) {
      if (ts.isImportSpecifier(d))
        return {
          module: d.parent.parent.parent.moduleSpecifier.text,
          name: (d.propertyName || d.name).text,
        };
      if (ts.isImportClause(d)) return { module: d.parent.moduleSpecifier.text, name: 'default' };
      if (ts.isNamespaceImport(d))
        return { module: d.parent.parent.moduleSpecifier.text, name: '*' };
    }
    const d = declaration(node);
    if (d?.initializer && ts.isIdentifier(d.initializer)) return imported(d.initializer, seen);
  };
  const expressReceiver = (node) => {
    const init = declaration(node)?.initializer;
    if (!init || !ts.isCallExpression(init)) return false;
    const source = imported(init.expression);
    return source?.module === 'express' && ['default', 'Router'].includes(source.name);
  };
  const add = (node, unit, surface, trigger, certainty, extra = {}) => {
    if (!unit || unit.role !== 'product') return;
    const source = node.getSourceFile(),
      file = owner(node)?.file || unit.file;
    const registration = { file, start: node.getStart(source), end: node.end };
    const operation = {
      id: `op-${digest(JSON.stringify([registration, surface, trigger, unit.id])).slice(0, 24)}`,
      surface,
      trigger,
      certainty,
      unitId: unit.id,
      file: unit.file,
      registration,
      ...extra,
    };
    operations.push(operation);
  };
  const visitTree = (node, visitor) => {
    visitor(node);
    ts.forEachChild(node, (child) => visitTree(child, visitor));
  };
  function argvDerived(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (node.getText() === 'process.argv') return true;
    if (ts.isIdentifier(node)) {
      const d = declaration(node);
      return argvDerived(
        d?.initializer || (d && ts.isBindingElement(d) ? d.parent.parent.initializer : undefined),
        seen,
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return argvDerived(node.expression, seen);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['slice', 'shift', 'at'].includes(node.expression.name.text)
    )
      return argvDerived(node.expression.expression, seen);
    return false;
  }

  // Recognize request discriminants, including a local pathname alias. This is
  // deliberately bounded: reflection and arbitrary transformations are unknown.
  function requestField(node, request, seen = new Set(), aliases = new Map()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === request &&
        ['url', 'method'].includes(node.name.text)
      )
        return node.name.text === 'url' ? 'path' : 'method';
      if (
        node.name.text === 'pathname' &&
        ts.isNewExpression(node.expression) &&
        node.expression.arguments?.some(
          (arg) => requestField(arg, request, seen, aliases) === 'path',
        )
      )
        return 'path';
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      return requestField(
        aliases.get(symbol) || declaration(node)?.initializer,
        request,
        seen,
        aliases,
      );
    }
  }
  function routePredicates(condition, request, aliases) {
    const paths = [],
      methods = [];
    visitTree(condition, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'startsWith' &&
        requestField(node.expression.expression, request, new Set(), aliases) === 'path' &&
        literal(node.arguments[0]) !== undefined
      )
        paths.push({ pathPrefix: literal(node.arguments[0]) });
      if (
        !ts.isBinaryExpression(node) ||
        ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
          node.operatorToken.kind,
        )
      )
        return;
      for (const [expr, value] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        const field = requestField(expr, request, new Set(), aliases),
          text = literal(value);
        if (text !== undefined && field === 'path') paths.push({ path: text });
        if (text !== undefined && field === 'method') methods.push(text);
      }
    });
    return {
      paths: [...new Map(paths.map((p) => [JSON.stringify(p), p])).values()],
      methods: [...new Set(methods)],
    };
  }
  function nodeRoutes(callback, unit) {
    const request = callback.parameters?.[0]?.name;
    if (!request || !ts.isIdentifier(request)) return;
    const aliases = new Map();
    function assignments(node) {
      if (node !== callback && ts.isFunctionLike(node)) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      )
        aliases.set(checker.getSymbolAtLocation(node.left), node.right);
      ts.forEachChild(node, assignments);
    }
    assignments(callback);
    function methodOptions(node, seen = new Set()) {
      if (!node || seen.has(node)) return [];
      seen.add(node);
      const value = literal(node);
      if (value !== undefined)
        return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value) ? [value] : [];
      if (ts.isArrayLiteralExpression(node))
        return node.elements.flatMap((n) => methodOptions(n, seen));
      if (ts.isConditionalExpression(node))
        return [...methodOptions(node.whenTrue, seen), ...methodOptions(node.whenFalse, seen)];
      if (ts.isIdentifier(node)) return methodOptions(declaration(node)?.initializer, seen);
      return [];
    }
    function walk(node) {
      if (node !== callback && ts.isFunctionLike(node)) return;
      if (ts.isIfStatement(node)) {
        const { paths, methods } = routePredicates(node.expression, request.text, aliases);
        if (!methods.length)
          visitTree(node.thenStatement, (guard) => {
            if (
              ts.isCallExpression(guard) &&
              ts.isPropertyAccessExpression(guard.expression) &&
              guard.expression.name.text === 'includes' &&
              guard.arguments.some(
                (arg) => requestField(arg, request.text, new Set(), aliases) === 'method',
              )
            )
              methods.push(...methodOptions(guard.expression.expression));
          });
        for (const path of paths)
          for (const method of methods.length ? methods : ['*'])
            add(node, unit, 'http', { method, ...path }, 'candidate', {
              adapter: 'node-http-dispatch',
              execution: {
                file: unit.file,
                start: node.thenStatement.getStart(),
                end: node.thenStatement.end,
              },
              predicate: node.expression.getText(),
              limitation: '静态路径分支；通配方法不代表所有方法可用，需核对内部方法/配置守卫。',
            });
      }
      if (
        ts.isSwitchStatement(node) &&
        requestField(node.expression, request.text, new Set(), aliases) === 'path'
      )
        for (const clause of node.caseBlock.clauses)
          if (ts.isCaseClause(clause) && literal(clause.expression) !== undefined)
            add(
              clause,
              unit,
              'http',
              { method: '*', path: literal(clause.expression) },
              'candidate',
              { adapter: 'node-http-dispatch' },
            );
      ts.forEachChild(node, walk);
    }
    walk(callback);
  }
  for (const [node, unit] of nodeUnits) {
    if (unit.role !== 'product') continue;
    function walk(current) {
      if (current !== node && ts.isFunctionLike(current)) return;
      if (ts.isSwitchStatement(current) && argvDerived(current.expression))
        for (const clause of current.caseBlock.clauses)
          if (ts.isCaseClause(clause) && literal(clause.expression) !== undefined)
            add(clause, unit, 'cli', { command: literal(clause.expression) }, 'candidate', {
              adapter: 'argv-dispatch',
            });
      if (
        ts.isIfStatement(current) &&
        ts.isBinaryExpression(current.expression) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
          current.expression.operatorToken.kind,
        )
      ) {
        for (const [expr, val] of [
          [current.expression.left, current.expression.right],
          [current.expression.right, current.expression.left],
        ])
          if (argvDerived(expr) && literal(val) !== undefined)
            add(current, unit, 'cli', { command: literal(val) }, 'candidate', {
              adapter: 'argv-dispatch',
              execution: {
                file: unit.file,
                start: current.thenStatement.getStart(),
                end: current.thenStatement.end,
              },
            });
      }
      if (ts.isCallExpression(current)) {
        const expression = current.expression,
          source = imported(expression);
        if (
          source &&
          ['node:http', 'http', 'node:https', 'https'].includes(source.module) &&
          source.name === 'createServer'
        ) {
          const arg = current.arguments.at(-1),
            handler = target(arg);
          if (handler) {
            add(current, handler, 'http-server', { kind: 'server' }, 'declared', {
              adapter: 'node-http',
            });
            const d = declaration(arg);
            const callback = nodeUnits.has(arg) ? arg : d?.initializer || d;
            if (callback) nodeRoutes(callback, handler);
          }
        }
        if (ts.isPropertyAccessExpression(expression)) {
          const method = expression.name.text,
            first = literal(current.arguments[0]);
          if (
            ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'].includes(method) &&
            first?.startsWith('/')
          ) {
            const known = expressReceiver(expression.expression);
            for (const arg of current.arguments.slice(1)) {
              const handler = target(arg);
              if (handler)
                add(
                  current,
                  handler,
                  'http',
                  { method: method.toUpperCase(), path: first },
                  known ? 'declared' : 'candidate',
                  {
                    adapter: known ? 'express' : 'route-shaped-registration',
                    ...(!known
                      ? { limitation: '接收者未确认是 HTTP router；仅为待审阅候选。' }
                      : {}),
                  },
                );
            }
          }
          if (['addEventListener', 'on', 'once'].includes(method)) {
            for (const arg of current.arguments.slice(1)) {
              const handler = target(arg);
              if (handler)
                add(
                  current,
                  handler,
                  'event',
                  {
                    event: first ?? current.arguments[0]?.getText(),
                    receiver: expression.expression.getText(),
                  },
                  'candidate',
                  {
                    adapter: 'event-registration',
                    limitation: '事件接收者及宿主触发需核对；静态注册不证明事件实际发生。',
                  },
                );
            }
          }
          if (method === 'command' && first) {
            add(current, unit, 'cli', { command: first }, 'candidate', {
              adapter: 'command-registration',
              limitation: '命令声明；需继续核对 builder/action 注册与实际调度。',
            });
          }
          if (['subscribe', 'schedule'].includes(method)) {
            for (const arg of current.arguments.slice(1)) {
              const handler = target(arg);
              if (handler)
                add(
                  current,
                  handler,
                  method === 'subscribe' ? 'message' : 'scheduled-task',
                  {
                    name: first ?? current.arguments[0]?.getText(),
                    receiver: expression.expression.getText(),
                  },
                  'candidate',
                  {
                    adapter: 'subscription-registration',
                    limitation: '需核对库身份、配置及实际启动条件，不能仅凭方法名确认运行。',
                  },
                );
            }
          }
        }
        if (
          ts.isIdentifier(expression) &&
          ['setInterval', 'setTimeout'].includes(expression.text)
        ) {
          const handler = target(current.arguments[0]);
          if (handler)
            add(current, handler, 'scheduled-task', { name: expression.text }, 'candidate', {
              adapter: 'timer-registration',
              limitation: '定时注册候选，需核对宿主及调度条件。',
            });
        }
      }
      if (
        ts.isJsxAttribute(current) &&
        /^on[A-Z]/.test(current.name.getText()) &&
        current.initializer &&
        ts.isJsxExpression(current.initializer)
      ) {
        const handler = target(current.initializer.expression);
        if (handler)
          add(current, handler, 'page-event', { event: current.name.getText() }, 'declared', {
            adapter: 'jsx-event',
          });
      }
      ts.forEachChild(current, walk);
    }
    walk(node);
  }
  // A consumed declarative CLI table often lives in one dispatcher. Keep every
  // key, but do not infer that unrelated object properties are user commands.
  for (const source of program.getSourceFiles()) {
    const top = owner(source);
    const hasArgv = source.text.includes('process.argv');
    if (!hasArgv) continue;
    const accessed = new Set();
    visitTree(source, (node) => {
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression))
        accessed.add(checker.getSymbolAtLocation(node.expression));
    });
    visitTree(source, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        !node.initializer ||
        !ts.isObjectLiteralExpression(node.initializer) ||
        !accessed.has(checker.getSymbolAtLocation(node.name))
      )
        return;
      for (const property of node.initializer.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isObjectLiteralExpression(property.initializer)
        )
          continue;
        const usage = property.initializer.properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === 'usage',
        );
        if (!usage || literal(usage.initializer) === undefined) continue;
        add(
          property,
          owner(property) || top,
          'cli',
          {
            command: ts.isIdentifier(property.name) ? property.name.text : literal(property.name),
            usage: literal(usage.initializer),
          },
          'candidate',
          {
            adapter: 'cli-dispatch-table',
            limitation: '已被索引访问的参数表；需对照实际分发路径核对实现。',
          },
        );
      }
    });
  }
  // Preserve exported library surfaces and uncovered registrations as candidates.
  // Their classification belongs to business discovery, not an exporter heuristic.
  for (const entry of entries) {
    if (
      entry.registration &&
      operations.some(
        (op) => op.unitId === entry.unitId && op.registration.start === entry.registration.start,
      )
    )
      continue;
    const unit = unitMap.get(entry.unitId);
    if (!unit) continue;
    const registration = entry.registration || {
      file: entry.file,
      start: unit.start,
      end: unit.end,
    };
    operations.push({
      id: `op-${digest(entry.id).slice(0, 24)}`,
      entryId: entry.id,
      surface:
        entry.kind === 'export'
          ? 'library'
          : entry.kind === 'cli'
            ? 'cli-dispatch'
            : 'registration',
      trigger: { name: entry.name },
      certainty: 'candidate',
      unitId: entry.unitId,
      file: entry.file,
      registration,
      adapter: 'symbol-entry',
      limitation: '符号入口不是独立业务；需审阅其使用者与结果。',
    });
  }
  return [...new Map(operations.map((op) => [op.id, op])).values()];
}
