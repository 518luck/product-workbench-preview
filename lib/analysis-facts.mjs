import { createHash } from 'node:crypto';
import ts from 'typescript';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const locationId = (prefix, unitId, kind, start, end) =>
  `${prefix}-${digest(`${unitId}:${kind}:${start}:${end}`).slice(0, 24)}`;

// Source-owned facts. AI descriptions and equal-looking values never create these edges.
export function indexJavaScriptFacts(program, units, nodeUnits, mutableSymbols) {
  const checker = program.getTypeChecker(),
    values = [],
    edges = [],
    entries = [];
  const expressions = new Map(),
    parameters = new Map();
  const symbol = (node) => {
    let result = checker.getSymbolAtLocation(node);
    if (result?.flags & ts.SymbolFlags.Alias) result = checker.getAliasedSymbol(result);
    return result;
  };
  const addEdge = (from, to, kind, certain = true) => {
    if (from && to && from !== to) edges.push({ from, to, kind, certain });
  };
  const exported = new Set(),
    visitedExports = new Set();
  const publicMember = (node) =>
    !ts.isPrivateIdentifier(node.name || {}) &&
    !node.modifiers?.some((m) =>
      [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind),
    );
  function exportDeclaration(node) {
    if (!node) return;
    if (nodeUnits.has(node) && nodeUnits.get(node).kind !== 'top-level') exported.add(node);
    if (
      ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node)
    ) {
      let value = node.initializer;
      while (
        value &&
        (ts.isAsExpression(value) ||
          ts.isParenthesizedExpression(value) ||
          ts.isSatisfiesExpression(value))
      )
        value = value.expression;
      if (
        value &&
        (ts.isFunctionLike(value) ||
          ts.isObjectLiteralExpression(value) ||
          ts.isClassExpression(value))
      )
        exportDeclaration(value);
      else if (value && ts.isIdentifier(value) && !mutableSymbols.has(symbol(value)))
        exportSymbol(symbol(value));
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members.filter(publicMember)) exportDeclaration(member);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const member of node.properties) {
        if (ts.isShorthandPropertyAssignment(member)) exportSymbol(symbol(member.name));
        else exportDeclaration(member);
      }
    } else if (ts.isModuleDeclaration(node)) {
      for (const member of checker.getExportsOfModule(symbol(node.name))) exportSymbol(member);
    } else if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) exportSymbol(symbol(node.expression));
      else exportDeclaration(node.expression);
    }
  }
  function exportSymbol(value) {
    if (!value || visitedExports.has(value)) return;
    visitedExports.add(value);
    if (
      value.declarations?.some(
        (d) => ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent?.parent?.isTypeOnly),
      )
    )
      return;
    if (value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    if (!(value.flags & ts.SymbolFlags.Value)) return;
    for (const declaration of value.declarations || []) exportDeclaration(declaration);
  }
  for (const source of program.getSourceFiles()) {
    const module = checker.getSymbolAtLocation(source);
    if (module) for (const value of checker.getExportsOfModule(module)) exportSymbol(value);
  }
  function fact(node, unit, kind, extra = {}) {
    const source = node.getSourceFile(),
      start = node.getStart(source),
      end = node.end;
    const item = {
      id: locationId('d', unit.id, kind, start, end),
      unitId: unit.id,
      file: unit.file,
      kind,
      start,
      end,
      label: node.getText(source).slice(0, 200),
      ...extra,
    };
    values.push(item);
    return item;
  }
  for (const [node, unit] of nodeUnits) {
    unit.language = 'javascript';
    unit.parameters = [];
    unit.returns = [];
    for (const [index, parameter] of (node.parameters || []).entries()) {
      const item = fact(parameter, unit, 'parameter', { index, name: parameter.name.getText() });
      unit.parameters.push(item.id);
      parameters.set(parameter, item);
    }
    for (const call of unit.calls) {
      call.id = locationId('k', unit.id, 'call', call.start, call.end);
      call.argumentIds = [];
    }
    if (exported.has(node) && unit.role === 'product')
      entries.push({
        id: `entry-${unit.id}`,
        unitId: unit.id,
        file: unit.file,
        kind: 'export',
        name: unit.name,
      });
  }
  function owningUnit(node) {
    let current = node;
    while (current) {
      if (nodeUnits.has(current)) return nodeUnits.get(current);
      current = current.parent;
    }
  }
  function value(node, unit) {
    if (!node) return;
    if (expressions.has(node)) return expressions.get(node);
    if (ts.isFunctionLike(node)) return;
    const kind = ts.isIdentifier(node)
      ? 'read'
      : ts.isCallExpression(node) || ts.isNewExpression(node)
        ? 'call-result'
        : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
          ? 'property-read'
          : ts.isLiteralExpression(node) ||
              [
                ts.SyntaxKind.TrueKeyword,
                ts.SyntaxKind.FalseKeyword,
                ts.SyntaxKind.NullKeyword,
              ].includes(node.kind)
            ? 'constant'
            : 'expression';
    const result = fact(node, unit, kind);
    expressions.set(node, result);
    if (ts.isIdentifier(node)) {
      const bound = symbol(node),
        declaration = bound?.valueDeclaration || bound?.declarations?.[0];
      if (parameters.has(declaration) && !mutableSymbols.has(bound))
        addEdge(parameters.get(declaration).id, result.id, 'parameter-read');
      else if (declaration?.initializer && !mutableSymbols.has(bound)) {
        const owner = owningUnit(declaration);
        if (owner)
          addEdge(value(declaration.initializer, owner)?.id, result.id, 'immutable-binding');
      }
      if (bound && mutableSymbols.has(bound)) result.requiresRuntime = '可变绑定需要实际执行证据。';
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const call = unit.calls.find(
        (item) => item.start === node.getStart() && item.end === node.end,
      );
      if (call) {
        call.resultId = result.id;
        call.argumentIds = (node.arguments || []).map(
          (argument) => value(argument, unit)?.id || null,
        );
        result.callId = call.id;
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = value(node.expression, unit);
      result.receiverId = receiver?.id;
      result.property = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression) ||
            ts.isNumericLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      // An aggregate dependency does not identify which field supplied this value.
      addEdge(receiver?.id, result.id, 'projection', false);
    } else if (ts.isBinaryExpression(node)) {
      const assignment =
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const conditional = [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind);
      if (!assignment) addEdge(value(node.left, unit)?.id, result.id, 'transform', !conditional);
      addEdge(
        value(node.right, unit)?.id,
        result.id,
        assignment ? 'assignment' : 'transform',
        !conditional,
      );
      if (assignment) result.write = node.left.getText();
    } else if (ts.isConditionalExpression(node)) {
      value(node.condition, unit);
      addEdge(value(node.whenTrue, unit)?.id, result.id, 'branch-merge', false);
      addEdge(value(node.whenFalse, unit)?.id, result.id, 'branch-merge', false);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const input = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isSpreadAssignment(property)
              ? property.expression
              : null;
        addEdge(value(input, unit)?.id, result.id, 'object-field', false);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements)
        addEdge(value(element, unit)?.id, result.id, 'array-element', false);
    } else if (node.expression) addEdge(value(node.expression, unit)?.id, result.id, 'transform');
    return result;
  }
  for (const [node, unit] of nodeUnits) {
    function visit(current) {
      if (current !== node && ts.isFunctionLike(current)) return;
      if (ts.isReturnStatement(current)) {
        const result = fact(current, unit, 'return');
        unit.returns.push(result.id);
        addEdge(value(current.expression, unit)?.id, result.id, 'return');
      }
      if (ts.isArrowFunction(current) && !ts.isBlock(current.body)) {
        const result = fact(current.body, unit, 'return');
        unit.returns.push(result.id);
        addEdge(value(current.body, unit)?.id, result.id, 'return');
      }
      if (ts.isExpression(current) && !ts.isFunctionLike(current)) value(current, unit);
      if (
        unit.role === 'product' &&
        ts.isPropertyAccessExpression(current) &&
        current.getText() === 'process.argv'
      )
        entries.push({
          id: `entry-${unit.id}`,
          unitId: unit.id,
          file: unit.file,
          kind: 'cli',
          name: 'process.argv',
        });
      if (
        unit.role === 'product' &&
        ts.isCallExpression(current) &&
        /(?:addEventListener|createServer|\.on|\.once|\.get|\.post|\.put|\.delete|\.patch|\.action|\.command)$/.test(
          current.expression.getText(),
        )
      ) {
        const method = current.expression.getText().split('.').at(-1);
        const callbackArguments = ['on', 'once', 'addEventListener'].includes(method)
          ? current.arguments.slice(1)
          : ['get', 'post', 'put', 'delete', 'patch', 'command'].includes(method)
            ? current.arguments.length > 1 && !ts.isFunctionLike(current.arguments[0])
              ? current.arguments.slice(1)
              : []
            : current.arguments;
        for (const argument of callbackArguments) {
          const declaration = symbol(argument)?.valueDeclaration;
          const target =
            nodeUnits.get(argument) ||
            nodeUnits.get(declaration) ||
            nodeUnits.get(declaration?.initializer);
          if (target && target.role === 'product')
            entries.push({
              id: `entry-${target.id}`,
              unitId: target.id,
              file: target.file,
              kind: 'registration',
              name: current.expression.getText(),
            });
        }
      }
      ts.forEachChild(current, visit);
    }
    visit(node);
  }
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  for (const unit of units)
    for (const call of unit.calls) {
      const target = byId.get(call.target);
      if (!target) continue;
      for (const [index, argument] of (call.argumentIds || []).entries())
        addEdge(argument, target.parameters?.[index], 'argument');
      for (const returned of target.returns || [])
        addEdge(returned, call.resultId, 'call-return', target.returns.length === 1);
    }
  return {
    values,
    edges,
    entries: [...new Map(entries.map((entry) => [entry.id, entry])).values()],
  };
}
