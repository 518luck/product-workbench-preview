import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const fn = (node) => ts.isFunctionLike(node) && Boolean(node.body);
export function instrumentJavaScript(root, state, selected) {
  const files = new Map(),
    unsupported = [];
  for (const unit of state.units.filter(
    (unit) => unit.language === 'javascript' && selected.has(unit.id) && unit.kind !== 'top-level',
  )) {
    if (!files.has(unit.file)) files.set(unit.file, []);
    files.get(unit.file).push(unit);
  }
  for (const [file, units] of files) {
    const filename = path.join(root, file),
      source = ts.createSourceFile(
        file,
        fs.readFileSync(filename, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
    const unitMap = new Map(units.map((unit) => [`${unit.start}:${unit.end}`, unit]));
    const values = new Map(
      (state.facts.values || [])
        .filter((value) => value.file === file)
        .map((value) => [`${value.unitId}:${value.kind}:${value.start}:${value.end}`, value]),
    );
    const factories = ts.factory;
    const str = (value) => factories.createStringLiteral(value);
    const probe = () =>
      factories.createElementAccessExpression(
        factories.createIdentifier('globalThis'),
        factories.createCallExpression(
          factories.createPropertyAccessExpression(factories.createIdentifier('Symbol'), 'for'),
          undefined,
          [str('product-blueprint.runtime')],
        ),
      );
    const invoke = (name, args) =>
      factories.createCallExpression(
        factories.createPropertyAccessExpression(probe(), name),
        undefined,
        args,
      );
    const property = (key, value) => factories.createPropertyAssignment(key, value);
    const object = (fields) => factories.createObjectLiteralExpression(fields, false);
    function safeToMove(node) {
      let valid = true;
      function inspect(current) {
        if (fn(current)) return;
        if (
          ts.isAwaitExpression(current) ||
          ts.isYieldExpression(current) ||
          current.kind === ts.SyntaxKind.SuperKeyword ||
          (ts.isCallExpression(current) && current.expression.getText(source) === 'eval')
        )
          valid = false;
        ts.forEachChild(current, inspect);
      }
      inspect(node);
      return valid;
    }
    const transformed = ts.transform(source, [
      (context) => {
        function visit(node, owner, frame) {
          if (fn(node)) {
            const unit = unitMap.get(`${node.getStart(source)}:${node.end}`);
            if (!unit)
              return ts.visitEachChild(
                node,
                (child) => visit(child, undefined, undefined),
                context,
              );
            const params = node.parameters.map((parameter) => parameter.name);
            const parameterNames = new Set(
              params.filter(ts.isIdentifier).map((parameter) => parameter.text),
            );
            let unsafe =
              node.asteriskToken ||
              ts.isConstructorDeclaration(node) ||
              params.some((parameter) => !ts.isIdentifier(parameter));
            function inspect(current) {
              if (current !== node && fn(current)) return;
              if (
                ts.isVariableDeclaration(current) &&
                ts.isIdentifier(current.name) &&
                parameterNames.has(current.name.text)
              )
                unsafe = true;
              if (
                ts.isCallExpression(current) &&
                ['eval', 'Function'].includes(current.expression.getText(source))
              )
                unsafe = true;
              ts.forEachChild(current, inspect);
            }
            inspect(node);
            if (
              unsafe ||
              ts.isMethodDeclaration(node) ||
              ts.isGetAccessorDeclaration(node) ||
              ts.isSetAccessorDeclaration(node)
            ) {
              unsupported.push({
                unitId: unit.id,
                message: '此函数的生成器、构造器、方法或作用域行为暂不支持无歧义探针。',
              });
              return node;
            }
            let frameName = `__product_blueprint_frame_${unit.id.slice(-10)}`;
            while (source.text.includes(frameName)) frameName += '_';
            const local = factories.createIdentifier(frameName);
            let body = ts.isBlock(node.body)
              ? node.body
              : factories.createBlock([factories.createReturnStatement(node.body)], true);
            const declarations = [];
            for (const statement of body.statements)
              if (ts.isFunctionDeclaration(statement) && statement.name) {
                const child = unitMap.get(`${statement.getStart(source)}:${statement.end}`);
                if (child && !statement.asteriskToken)
                  declarations.push(
                    factories.createExpressionStatement(
                      invoke('register', [str(child.id), statement.name, str(child.name)]),
                    ),
                  );
              }
            const originalBody = ts.isBlock(node.body)
              ? body.statements.map((statement) => visit(statement, unit, local))
              : [
                  factories.createReturnStatement(
                    invoke('returned', [
                      local,
                      str(unit.returns[0]),
                      visit(node.body, unit, local),
                    ]),
                  ),
                ];
            const directives = [];
            while (
              originalBody.length &&
              ts.isExpressionStatement(originalBody[0]) &&
              ts.isStringLiteral(originalBody[0].expression)
            )
              directives.push(originalBody.shift());
            const frameDeclaration = factories.createVariableStatement(
              undefined,
              factories.createVariableDeclarationList(
                [
                  factories.createVariableDeclaration(
                    local,
                    undefined,
                    undefined,
                    invoke('frame', [
                      str(unit.id),
                      factories.createArrayLiteralExpression(
                        params.map((parameter, index) =>
                          object([
                            property('id', str(unit.parameters[index])),
                            property('value', parameter),
                          ]),
                        ),
                      ),
                    ]),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            );
            const callback = factories.createArrowFunction(
              node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
                ? [factories.createModifier(ts.SyntaxKind.AsyncKeyword)]
                : undefined,
              undefined,
              [],
              undefined,
              factories.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              factories.createBlock([...declarations, ...originalBody], true),
            );
            const newBody = factories.createBlock(
              [
                ...directives,
                frameDeclaration,
                factories.createReturnStatement(invoke('run', [local, callback])),
              ],
              true,
            );
            const updated = node;
            let result;
            if (ts.isFunctionDeclaration(node))
              result = factories.updateFunctionDeclaration(
                updated,
                node.modifiers,
                node.asteriskToken,
                node.name,
                node.typeParameters,
                node.parameters,
                node.type,
                newBody,
              );
            else if (ts.isFunctionExpression(node))
              result = factories.updateFunctionExpression(
                updated,
                node.modifiers,
                node.asteriskToken,
                node.name,
                node.typeParameters,
                node.parameters,
                node.type,
                newBody,
              );
            else
              result = factories.updateArrowFunction(
                updated,
                node.modifiers,
                node.typeParameters,
                node.parameters,
                node.type,
                node.equalsGreaterThanToken,
                newBody,
              );
            if (ts.isFunctionDeclaration(node)) return result;
            return invoke('register', [str(unit.id), result, str(unit.name)]);
          }
          if (owner && frame && ts.isReturnStatement(node)) {
            const value = values.get(`${owner.id}:return:${node.getStart(source)}:${node.end}`);
            return factories.updateReturnStatement(
              node,
              invoke('returned', [
                frame,
                str(value?.id || owner.returns[0]),
                node.expression ? visit(node.expression, owner, frame) : factories.createVoidZero(),
              ]),
            );
          }
          if (owner && frame && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
            const call = owner.calls.find((call) => call.start === node.getStart(source));
            const expression = node.expression;
            if (
              call &&
              safeToMove(node) &&
              !node.questionDotToken &&
              !(node.flags & ts.NodeFlags.OptionalChain) &&
              !(node.arguments || []).some(ts.isSpreadElement) &&
              expression.getText(source) !== 'eval'
            ) {
              const receiver = factories.createIdentifier(
                `__pb_receiver_${node.pos}`.replace(/-/g, '_'),
              );
              const callable = factories.createIdentifier(
                `__pb_callable_${node.pos}`.replace(/-/g, '_'),
              );
              const statements = [];
              let target = expression,
                thisValue = factories.createVoidZero();
              if (
                ts.isPropertyAccessExpression(expression) ||
                ts.isElementAccessExpression(expression)
              ) {
                statements.push(
                  factories.createVariableStatement(
                    undefined,
                    factories.createVariableDeclarationList(
                      [
                        factories.createVariableDeclaration(
                          receiver,
                          undefined,
                          undefined,
                          visit(expression.expression, owner, frame),
                        ),
                      ],
                      ts.NodeFlags.Const,
                    ),
                  ),
                );
                target = ts.isPropertyAccessExpression(expression)
                  ? factories.createPropertyAccessExpression(receiver, expression.name)
                  : factories.createElementAccessExpression(
                      receiver,
                      visit(expression.argumentExpression, owner, frame),
                    );
                thisValue = receiver;
              }
              // Resolve the callable before evaluating arguments, preserving receiver/getter order.
              statements.push(
                factories.createVariableStatement(
                  undefined,
                  factories.createVariableDeclarationList(
                    [factories.createVariableDeclaration(callable, undefined, undefined, target)],
                    ts.NodeFlags.Const,
                  ),
                ),
              );
              const args = factories.createArrayLiteralExpression(
                (node.arguments || []).map((argument, index) =>
                  object([
                    property('id', str(call.argumentIds[index] || '')),
                    property('value', visit(argument, owner, frame)),
                  ]),
                ),
              );
              statements.push(
                factories.createReturnStatement(
                  invoke('invoke', [
                    frame,
                    str(call.id),
                    callable,
                    thisValue,
                    args,
                    ts.isNewExpression(node) ? factories.createTrue() : factories.createFalse(),
                  ]),
                ),
              );
              return factories.createCallExpression(
                factories.createParenthesizedExpression(
                  factories.createArrowFunction(
                    undefined,
                    undefined,
                    [],
                    undefined,
                    factories.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                    factories.createBlock(statements, true),
                  ),
                ),
                undefined,
                [],
              );
            }
          }
          if (owner && frame && ts.isThrowStatement(node)) {
            const point = owner.reviewPoints.find(
              (point) => point.kind === 'throw' && point.start === node.getStart(source),
            );
            return factories.updateThrowStatement(
              node,
              point
                ? invoke('point', [frame, str(point.id), visit(node.expression, owner, frame)])
                : visit(node.expression, owner, frame),
            );
          }
          let result = ts.visitEachChild(node, (child) => visit(child, owner, frame), context);
          if (owner && frame) {
            const point = owner.reviewPoints.find(
              (point) =>
                point.start === node.getStart(source) &&
                point.end === node.end &&
                ['conditions', 'sideEffects', 'exceptions'].includes(point.field),
            );
            if (
              point &&
              ts.isExpression(node) &&
              !['iteration', 'case', 'default'].includes(point.kind)
            )
              result = invoke(point.field === 'conditions' ? 'branch' : 'point', [
                frame,
                str(point.id),
                result,
              ]);
            if (ts.isBlock(node)) {
              const blockPoint = owner.reviewPoints.find(
                (point) => point.kind === 'finally' && point.start === node.getStart(source),
              );
              const catchPoint = ts.isCatchClause(node.parent)
                ? owner.reviewPoints.find(
                    (point) =>
                      point.kind === 'catch' && point.start === node.parent.getStart(source),
                  )
                : null;
              const active = blockPoint || catchPoint;
              if (active)
                result = factories.updateBlock(result, [
                  factories.createExpressionStatement(
                    invoke('point', [frame, str(active.id), factories.createVoidZero()]),
                  ),
                  ...result.statements,
                ]);
            }
          }
          return result;
        }
        return (rootNode) => {
          const registrations = [];
          for (const statement of rootNode.statements)
            if (ts.isFunctionDeclaration(statement) && statement.name) {
              const unit = unitMap.get(`${statement.getStart(source)}:${statement.end}`);
              if (unit && !statement.asteriskToken)
                registrations.push(
                  factories.createExpressionStatement(
                    invoke('register', [str(unit.id), statement.name, str(unit.name)]),
                  ),
                );
            }
          const statements = rootNode.statements.map((statement) =>
            visit(statement, undefined, undefined),
          );
          const directives = [];
          while (
            statements.length &&
            ts.isExpressionStatement(statements[0]) &&
            ts.isStringLiteral(statements[0].expression)
          )
            directives.push(statements.shift());
          return factories.updateSourceFile(rootNode, [
            ...directives,
            ...registrations,
            ...statements,
          ]);
        };
      },
    ]);
    fs.writeFileSync(filename, ts.createPrinter().printFile(transformed.transformed[0]));
    transformed.dispose();
  }
  return unsupported;
}
