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

// A shared helper may support several stages, but every distinct stage needs
// its own behavioral anchor (e.g. the actual call site). Rewording a claim does
// not make one source location demonstrate several independent operations.
export function assessmentScopeProblems(feature, items) {
  const steps = (items || []).filter(
    (item) => item.state === 'implemented' && /^\/flow\/\d+$/.test(item.target),
  );
  const anchors = (item) =>
    new Set(
      (item.basis || []).flatMap((b) =>
        b.kind === 'code'
          ? (b.pointIds || []).map((id) => `${b.unitId}:${id}`)
          : b.kind === 'context'
            ? [`${b.contextId}:${b.quote}`]
            : [],
      ),
    );
  const groups = new Map();
  for (const item of steps) {
    const claim = JSON.stringify(feature.flow[Number(item.target.split('/')[2])]);
    if (!groups.has(claim)) groups.set(claim, { items: [], anchors: new Set() });
    const group = groups.get(claim);
    group.items.push(item);
    for (const key of anchors(item)) group.anchors.add(key);
  }
  const problems = [];
  for (const group of groups.values()) {
    const others = new Set(
      [...groups.values()].filter((g) => g !== group).flatMap((g) => [...g.anchors]),
    );
    if (groups.size > 1 && ![...group.anchors].some((key) => !others.has(key)))
      for (const item of group.items)
        problems.push({
          target: item.target,
          message:
            '不同业务步骤只复用相同源码位置或原文，缺少本步骤独立的行为依据；请补充实际调用点、处理位置或具体工作流原文。',
        });
  }
  return problems;
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
