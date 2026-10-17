import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readSnapshot, documentHash } from './document-operations.mjs';
import { updateDocument } from './document-store.mjs';
import { renderDocument, writeHtml } from './document.mjs';
import {
  withAnalysisSession,
  assertFresh,
  receiptCoverage,
  recordValid,
  snapshotFromAnalysis,
} from './analysis-session.mjs';
import { reviewProblems } from './analysis-review.mjs';
import {
  finalizeFeature,
  featureDefinitionHash,
  implementationStatus,
} from './feature-operations.mjs';
import { BlueprintError } from './errors.mjs';
import { basisProblems } from './source-evidence.mjs';
import { hollowExplanation } from './evidence-quality.mjs';

export const assessmentTargets = (feature) => [
  '/description',
  ...['rules', 'checks', 'flow'].flatMap((key) =>
    (feature[key] || []).map((_, i) => `/${key}/${i}`),
  ),
];
const invalid = (message) => {
  throw new BlueprintError('INVALID_ARGUMENT', message);
};
const fields = (value, allowed) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    invalid('实现核对包含无效字段。');
};

// An explicit source-based implementation review. It never creates execution evidence.
export async function assessImplementation(
  filename,
  id,
  session,
  input,
  { dryRun = false, render = true } = {},
) {
  fields(input, ['expectedHash', 'revision', 'items']);
  return withAnalysisSession(session, async (state) => {
    assertFresh(state);
    const snapshot = readSnapshot(filename);
    if (snapshot.documentHash !== input.expectedHash)
      throw new BlueprintError('CONFLICT', '产品书已变化，请重新读取。', { status: 409 });
    const feature = Object.hasOwn(snapshot.document.features, id)
      ? snapshot.document.features[id]
      : null;
    if (!feature) throw new BlueprintError('NOT_FOUND', '功能不存在。');
    if (input.revision !== feature.revision)
      throw new BlueprintError('CONFLICT', '实现核对不对应当前定义版本。', { status: 409 });
    const targets = new Set(assessmentTargets(feature)),
      seen = new Set();
    if (!Array.isArray(input.items) || !input.items.length)
      invalid('需要逐项核对功能定义、规则、验收条件及业务步骤。');
    const items = input.items.map((item) => {
      fields(item, ['target', 'state', 'detail', 'unitIds', 'contextIds', 'requirement', 'basis']);
      if (item.basis !== undefined && !Array.isArray(item.basis)) invalid('basis 应为依据数组。');
      const basis = item.basis || [];
      return {
        ...item,
        unitIds: item.unitIds ?? [
          ...new Set(basis.filter((b) => b?.kind === 'code').map((b) => b.unitId)),
        ],
        contextIds: item.contextIds ?? [
          ...new Set(basis.filter((b) => b?.kind === 'context').map((b) => b.contextId)),
        ],
      };
    });
    for (const item of items) {
      fields(item, ['target', 'state', 'detail', 'unitIds', 'contextIds', 'requirement', 'basis']);
      if (
        !targets.has(item.target) ||
        seen.has(item.target) ||
        !['implemented', 'missing', 'unknown'].includes(item.state) ||
        typeof item.detail !== 'string' ||
        !item.detail.trim()
      )
        invalid('核对项需要真实、不重复的位置、实现结论和具体说明。');
      seen.add(item.target);
      const units = item.unitIds || [],
        contexts = item.contextIds || [];
      const requirementOnly = item.requirement !== undefined;
      if (requirementOnly) {
        fields(item.requirement, ['source', 'text']);
        if (
          item.state !== 'missing' ||
          state.units.some((u) => u.role === 'product') ||
          !['user', 'document'].includes(item.requirement.source) ||
          typeof item.requirement.text !== 'string' ||
          !item.requirement.text.trim()
        )
          invalid('纯需求依据仅能在没有产品源码的项目中说明未实现，不能证明实现完成。');
      }
      if (
        ![units, contexts].every(Array.isArray) ||
        [...units, ...contexts].some((key) => typeof key !== 'string') ||
        new Set([...units, ...contexts]).size !== units.length + contexts.length ||
        (item.state !== 'unknown' && !requirementOnly && !units.length && !contexts.length)
      )
        invalid('已实现或未实现的判断需要实际读取的源码或上下文依据。');
      if (item.state !== 'unknown' && !requirementOnly) {
        const claim =
          item.target === '/description'
            ? feature.description
            : item.target
                .split('/')
                .slice(1)
                .reduce((v, key) => v?.[key], feature);
        if (
          hollowExplanation(item.detail, {
            claim: typeof claim === 'string' ? claim : JSON.stringify(claim),
          })
        )
          invalid('实现说明只重复业务结论，需说明具体实现或缺失行为。');
        const problems = basisProblems(
          state,
          item.basis,
          typeof claim === 'string' ? claim : JSON.stringify(claim),
        );
        if (problems.length) invalid(problems.join('；'));
        if (
          item.basis.some((b) =>
            b.kind === 'code' ? !units.includes(b.unitId) : !contexts.includes(b.contextId),
          )
        )
          invalid('basis 的全部来源必须包含在核对项的源码／上下文引用中。');
      }
      for (const key of units) {
        const unit = state.units.find((u) => u.id === key),
          record = state.records[key];
        if (
          !unit ||
          unit.role !== 'product' ||
          !recordValid(state, unit, record) ||
          reviewProblems(unit, record).length
        )
          invalid('实现核对引用的产品源码尚未完整读取和分析。');
      }
      for (const key of contexts) {
        const context = state.contexts.find((c) => c.id === key);
        if (!context || !receiptCoverage(state, context, Object.keys(state.receipts)))
          invalid('实现核对引用的上下文尚未完整读取。');
      }
    }
    if (seen.size !== targets.size) invalid('仍有功能定义、规则、验收条件或业务步骤未核对。');
    const previous = feature.implementationAssessment;
    const assessment = {
      revision: feature.revision,
      definitionHash: featureDefinitionHash(feature),
      assessedAt: new Date().toISOString(),
      items: structuredClone(items),
      sourceSnapshot: snapshotFromAnalysis(state),
    };
    const unchanged =
      previous &&
      previous.definitionHash === assessment.definitionHash &&
      isDeepStrictEqual(previous.items, assessment.items) &&
      previous.sourceSnapshot?.snapshotHash === state.snapshotHash;
    const next = unchanged
      ? feature
      : finalizeFeature(feature, {
          ...feature,
          implementationAssessment: assessment,
          ...(previous
            ? {
                implementationAssessmentHistory: [
                  ...(feature.implementationAssessmentHistory || []),
                  previous,
                ],
              }
            : {}),
        }).feature;
    const result = {
      id,
      status: implementationStatus(next),
      missing: next.implementationAssessment.items.filter((item) => item.state === 'missing'),
      uncertain: next.implementationAssessment.items.filter((item) => item.state === 'unknown'),
      documentSaved: false,
      htmlUpdated: false,
    };
    if (dryRun) return { ...result, dryRun: true };
    return updateDocument(
      filename,
      (document, { original }) => {
        if (documentHash(original) !== snapshot.documentHash)
          throw new BlueprintError('CONFLICT', '保存实现核对期间文档已变化。', { status: 409 });
        document.features[id] = next;
        return { changed: !unchanged, result };
      },
      {
        beforeCommit: () => assertFresh(state),
        afterCommit: (document, output) => {
          output.documentSaved = true;
          if (!render) return;
          try {
            writeHtml(
              path.join(path.dirname(fs.realpathSync(filename)), 'index.html'),
              renderDocument(document),
            );
            output.htmlUpdated = true;
          } catch (error) {
            throw new BlueprintError(
              'RENDER_FAILED',
              `实现核对已保存，页面生成失败：${error.message}`,
              {
                documentSaved: true,
                htmlUpdated: false,
                result: output,
              },
            );
          }
        },
      },
    );
  });
}
