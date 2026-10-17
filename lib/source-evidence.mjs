import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { hollowExplanation } from './evidence-quality.mjs';

export function behaviorUnit(state, unit) {
  if (!unit || unit.role !== 'product') return false;
  if (unit.kind !== 'top-level') return Boolean(unit.reviewPoints?.length);
  if (unit.reviewPoints.some((p) => ['conditions', 'sideEffects', 'exceptions'].includes(p.field)))
    return true;
  if (unit.language !== 'javascript') return false;
  const text = fs
    .readFileSync(path.join(state.root, unit.file), 'utf8')
    .slice(unit.start, unit.end);
  const source = ts.createSourceFile(unit.file, text, ts.ScriptTarget.Latest, true);
  return source.statements.some(
    (s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression),
  );
}

// Binding to a location is checkable; whether it supports a business claim still
// requires review. Constants and re-exports cannot by themselves prove behavior.
export function basisProblems(state, basis, claim, { requireBehavior = true } = {}) {
  if (!Array.isArray(basis) || !basis.length)
    return ['需要具体源码位置或上下文原文的 basis，而不是只有单元编号。'];
  const problems = [];
  for (const item of basis) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.detail !== 'string'
    ) {
      problems.push('依据需要具体关联说明。');
      continue;
    }
    if (item.kind === 'code') {
      const unit = state.units.find((u) => u.id === item.unitId);
      const points =
        unit?.reviewPoints.filter(
          (p) => Array.isArray(item.pointIds) && item.pointIds.includes(p.id),
        ) || [];
      if (
        Object.keys(item).some((k) => !['kind', 'unitId', 'pointIds', 'detail'].includes(k)) ||
        !unit ||
        unit.role !== 'product' ||
        !Array.isArray(item.pointIds) ||
        !item.pointIds.length ||
        new Set(item.pointIds).size !== item.pointIds.length ||
        points.length !== item.pointIds.length
      )
        problems.push('代码依据须引用本单元真实、不重复的 reviewPoint 编号。');
      else if (
        requireBehavior &&
        (!behaviorUnit(state, unit) || points.every((p) => p.field === 'inputs'))
      )
        problems.push(
          '常量、路径、重导出及单纯参数声明不是功能行为依据，请引用真正执行行为的源码位置。',
        );
      else if (
        hollowExplanation(item.detail, { unit, fragments: points.map((p) => p.code), claim })
      )
        problems.push('依据只复述源码或结论，需说明该位置如何支持当前业务判断。');
    } else if (item.kind === 'context') {
      const context = state.contexts.find((c) => c.id === item.contextId);
      const source =
        context &&
        fs
          .readFileSync(path.join(state.root, context.file), 'utf8')
          .slice(context.start, context.end);
      if (
        Object.keys(item).some((k) => !['kind', 'contextId', 'quote', 'detail'].includes(k)) ||
        !context ||
        typeof item.quote !== 'string' ||
        item.quote.trim().length < 8 ||
        !source.includes(item.quote)
      )
        problems.push('上下文依据须引用实际读取范围内的具体原文。');
      else if (hollowExplanation(item.detail, { fragments: [item.quote], claim }))
        problems.push('上下文依据需要解释原文与当前业务判断的关系。');
    } else problems.push('basis.kind 应为 code 或 context。');
  }
  return problems;
}
