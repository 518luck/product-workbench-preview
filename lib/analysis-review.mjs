import { createHash } from 'node:crypto';
import ts from 'typescript';

// These are observable syntax locations, not a claim that static analysis understands behavior.
export function collectReviewPoints(node, source, unitId) {
  const points = [];
  function add(target, kind, field) {
    const start = target.getStart(source),
      end = target.end,
      position = source.getLineAndCharacterOfPosition(start);
    points.push({
      id: `p-${createHash('sha256').update(`${unitId}:${kind}:${start}:${end}`).digest('hex').slice(0, 24)}`,
      kind,
      field,
      start,
      end,
      position: { line: position.line + 1, column: position.character + 1 },
      code: target.getText(source).replace(/\s+/g, ' ').slice(0, 240),
    });
  }
  function visit(current) {
    // A nested function has its own record; do not charge its body to its parent.
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isParameter(current)) add(current, 'parameter', 'inputs');
    if (ts.isReturnStatement(current)) add(current, 'return', 'outputs');
    if (ts.isArrowFunction(current) && !ts.isBlock(current.body))
      add(current.body, 'return', 'outputs');
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isSwitchStatement(current)
    )
      add(current.expression ?? current.condition, 'condition', 'conditions');
    if (ts.isForStatement(current) && current.condition)
      add(current.condition, 'condition', 'conditions');
    if (ts.isForOfStatement(current) || ts.isForInStatement(current))
      add(current.expression, 'iteration', 'conditions');
    if (ts.isCaseClause(current)) add(current.expression, 'case', 'conditions');
    if (ts.isDefaultClause(current)) add(current, 'default', 'conditions');
    if (
      ts.isBinaryExpression(current) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    )
      add(current.left, 'short-circuit', 'conditions');
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) add(current, 'call', 'calls');
    if (
      (ts.isBinaryExpression(current) &&
        current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        current.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(current.operator)) ||
      ts.isDeleteExpression(current)
    )
      add(current, 'write', 'sideEffects');
    if (ts.isThrowStatement(current)) add(current, 'throw', 'exceptions');
    if (ts.isCatchClause(current)) add(current, 'catch', 'exceptions');
    if (ts.isTryStatement(current) && current.finallyBlock)
      add(current.finallyBlock, 'finally', 'exceptions');
    ts.forEachChild(current, visit);
  }
  visit(node);
  return points.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const generic =
  /^(?:调用方参数及模块闭包状态[。.]?|该代码路径的返回值或对文档、服务响应的处理结果[。.]?|测试夹具、回调参数及闭包状态[。.]?|测试断言对返回值、文档状态或外部副作用的结论[。.]?)$/;

export function reviewProblems(unit, record) {
  const problems = [];
  const points = unit.reviewPoints;
  if (!Array.isArray(points)) return [{ message: '缺少源码审阅位置，请重新扫描。' }];
  if (!Array.isArray(record.coverage))
    return [{ message: '缺少逐位置 coverage；旧记录需对照源码补做分析，不能直接复用。' }];
  const expected = new Map(points.map((point) => [point.id, point])),
    seen = new Set();
  for (const entry of record.coverage) {
    const point = expected.get(entry?.pointId);
    if (!point || seen.has(entry.pointId)) {
      problems.push({ pointId: entry?.pointId, message: '审阅位置不存在或重复。' });
      continue;
    }
    seen.add(entry.pointId);
    if (
      !nonempty(entry.detail) ||
      generic.test(entry.detail.trim()) ||
      entry.detail.trim() === point.code.trim()
    )
      problems.push({
        pointId: point.id,
        field: point.field,
        position: point.position,
        message: '需要说明此位置的实际行为，不能只复制源码或使用通用套话。',
      });
    if (!Array.isArray(record[point.field]) || !record[point.field].length)
      problems.push({
        pointId: point.id,
        field: point.field,
        position: point.position,
        message: `源码存在 ${point.kind}，${point.field} 不能留空。`,
      });
  }
  for (const point of points)
    if (!seen.has(point.id))
      problems.push({
        pointId: point.id,
        field: point.field,
        position: point.position,
        message: `尚未分析 ${point.kind}：${point.code}`,
      });
  for (const field of [
    'inputs',
    'outputs',
    'conditions',
    'calls',
    'sideEffects',
    'exceptions',
    'unknowns',
  ])
    if (
      Array.isArray(record[field]) &&
      record[field].some((item) => nonempty(item) && generic.test(item.trim()))
    )
      problems.push({ field, message: `${field} 使用了通用套话，需说明本单元的具体行为。` });
  return problems;
}
