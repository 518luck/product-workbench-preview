import fs from 'node:fs';
import path from 'node:path';
import {
  loadSession,
  assertFresh,
  updateSession,
  receiptCoverage,
  recordValid,
} from './analysis-session.mjs';
import { digest } from './analysis-facts.mjs';
import { readSnapshot } from './document-operations.mjs';
import { featureDefinitionHash } from './feature-operations.mjs';
import { BlueprintError } from './errors.mjs';
import { businessLinks } from './business-links.mjs';
import { businessFlowResolver } from './business-flow-evidence.mjs';
import { coverageProblems, requiresBusinessOwner } from './business-coverage.mjs';
import { reviewProblems } from './analysis-review.mjs';

const text = (v) => typeof v === 'string' && Boolean(v.trim());
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const invalid = (message, details) => {
  throw new BlueprintError('INVALID_ARGUMENT', message, { details });
};
// Business review rules are a separate stage. Updating them must not invalidate
// unchanged syntax indexes, file receipts, or every function's source analysis.
const businessRulesHash = digest(
  fs.readFileSync(new URL(import.meta.url)) +
    fs.readFileSync(new URL('./business-links.mjs', import.meta.url)) +
    fs.readFileSync(new URL('./business-flow-evidence.mjs', import.meta.url)) +
    fs.readFileSync(new URL('./business-coverage.mjs', import.meta.url)),
);
const fields = (v, names, label) => {
  if (!object(v) || Object.keys(v).some((k) => !names.includes(k)))
    invalid(`${label} 含无效字段。`);
};
const texts = (v) => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
const fingerprint = ({ recordHash, ...v }) => digest(JSON.stringify(v));

export function businessInventory(session, { offset = 0, limit = 50 } = {}) {
  const { state } = loadSession(session);
  assertFresh(state);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    invalid('业务清单 offset 应非负，limit 为 1–200。');
  const operations = state.facts.operations || [];
  const modules = new Map();
  for (const unit of state.units) {
    const directory = path.posix.dirname(unit.file);
    const item = modules.get(directory) || {
      directory,
      files: new Set(),
      units: 0,
      productUnits: 0,
    };
    item.files.add(unit.file);
    item.units++;
    if (unit.role === 'product') item.productUnits++;
    modules.set(directory, item);
  }
  return {
    version: 1,
    sessionId: state.sessionId,
    snapshotHash: state.snapshotHash,
    total: operations.length,
    offset,
    limit,
    nextOffset: offset + limit < operations.length ? offset + limit : null,
    operations: operations
      .slice(offset, offset + limit)
      .map((op) => ({ ...op, requiresBusinessOwner: requiresBusinessOwner(op) })),
    surfaces: Object.fromEntries(
      [...new Set(operations.map((o) => o.surface))].map((surface) => [
        surface,
        operations.filter((o) => o.surface === surface).length,
      ]),
    ),
    modules: [...modules.values()].map((m) => ({ ...m, files: m.files.size })),
    contexts: state.contexts
      .filter((c) => c.kind === 'context')
      .map(({ id, file }) => ({ id, file })),
    boundaries: [
      '这是静态候选操作清单，不是功能清单；候选接收者、配置和动态分发须核对。',
      '已识别入口覆盖不等于任意框架全部入口；库导出和内部支撑需逐项分类。',
    ],
  };
}

function evidenceProblems(state, evidence, { resultOnly = true } = {}) {
  const problems = [];
  if (!Array.isArray(evidence) || !evidence.length) return ['缺少业务结果依据。'];
  for (const e of evidence) {
    if (!object(e)) {
      problems.push('结果依据格式无效。');
      continue;
    }
    if (e.kind === 'code') {
      const unit = state.units.find((u) => u.id === e.unitId);
      const point = unit?.reviewPoints.find((p) => p.id === e.pointId);
      if (
        Object.keys(e).some(
          (k) => !['kind', 'unitId', 'pointId', 'detail', 'operationIds', 'via'].includes(k),
        ) ||
        (e.via !== undefined &&
          (!object(e.via) ||
            Object.keys(e.via).some((k) => !['flowId', 'scenarioId'].includes(k)) ||
            !text(e.via.flowId) ||
            !text(e.via.scenarioId))) ||
        (e.operationIds !== undefined && !texts(e.operationIds)) ||
        !unit ||
        unit.role !== 'product' ||
        (!resultOnly && !unit.reviewPoints?.length
          ? false
          : !point || (resultOnly && !['return', 'write', 'call', 'throw'].includes(point.kind))) ||
        !text(e.detail)
      )
        problems.push(
          `代码依据 ${e.unitId}:${e.pointId} 无效；${resultOnly ? '结果需关联真实返回、写入、调用或拒绝位置' : '审阅需关联真实产品源码位置'}及行为说明。`,
        );
    } else if (e.kind === 'context') {
      const context = state.contexts.find((c) => c.id === e.contextId);
      if (
        Object.keys(e).some((k) => !['kind', 'contextId', 'quote'].includes(k)) ||
        !context ||
        !text(e.quote) ||
        !fs
          .readFileSync(path.join(state.root, context.file), 'utf8')
          .slice(context.start, context.end)
          .includes(e.quote)
      )
        problems.push('上下文结果须引用当前已索引原文，不能自写工作流结果。');
    } else if (e.kind === 'requirement') {
      if (
        Object.keys(e).some((k) => !['kind', 'source', 'text', 'contextId'].includes(k)) ||
        !['user', 'document'].includes(e.source) ||
        !text(e.text)
      )
        problems.push('需求依据需要 user/document 来源与原文；工具不认证原文的对话来源。');
      if (e.source === 'document') {
        const context = state.contexts.find((c) => c.id === e.contextId);
        if (
          !context ||
          !text(e.text) ||
          !fs
            .readFileSync(path.join(state.root, context.file), 'utf8')
            .slice(context.start, context.end)
            .includes(e.text)
        )
          problems.push(
            '文档需求须关联已索引的 contextId 和原文；请将该文档纳入 contexts 后重新扫描。',
          );
      }
    } else problems.push('结果依据需要 code、context 或明确需求原文。');
  }
  return problems;
}

function modelProblems(state, model, connections) {
  const problems = [];
  const add = (where, message) => problems.push({ path: where, kind: 'business', message });
  if (
    !model ||
    model.snapshotHash !== state.snapshotHash ||
    model.recordHash !== fingerprint(model)
  ) {
    add('/business', '缺少当前快照的业务地图；先列操作，再建立使用者、目标和结果。');
    return problems;
  }
  if (model.rulesHash !== businessRulesHash) {
    add(
      '/business/rules',
      '业务审阅规则已变化，需重新核对地图；未变化的源码读取和函数记录不因此重做。',
    );
    return problems;
  }
  const operations = new Map((state.facts.operations || []).map((op) => [op.id, op]));
  const covered = new Set(),
    excluded = new Set();
  for (const c of model.capabilities) {
    for (const op of c.operationIds) {
      if (!operations.has(op)) add(`/business/${c.id}`, '操作身份不存在。');
      covered.add(op);
    }
    for (const message of evidenceProblems(state, c.results))
      add(`/business/${c.id}/results`, message);
    for (const evidence of c.results)
      if (evidence.operationIds?.some((id) => !c.operationIds.includes(id)))
        add(`/business/${c.id}/results`, '结果限定了此能力未声明的操作。');
    for (const problem of connections.find((item) => item.capabilityId === c.id).gaps)
      add(
        `/business/${c.id}/${problem.operationId || `results/${problem.result}`}`,
        problem.message,
      );
    if (c.classification !== 'requested' && c.results.some((e) => e.kind === 'requirement'))
      add(`/business/${c.id}/results`, '需求原文只能支持 requested，不能证明已实现。');
    const workflowContexts = c.operationIds
      .map((id) => operations.get(id))
      .filter((op) => op?.surface === 'workflow')
      .map((op) => op.contextId);
    if (
      workflowContexts.length &&
      !c.results.some((e) => e.kind === 'context' && workflowContexts.includes(e.contextId))
    )
      add(
        `/business/${c.id}/results`,
        '工作流能力必须核对其指令原文；状态/快照/校验 helper 不能代替工作流行为。',
      );
  }
  for (const d of model.dispositions) {
    if (!operations.has(d.operationId) || covered.has(d.operationId) || excluded.has(d.operationId))
      add('/business/dispositions', '不能排除不存在、重复或已归属业务的操作。');
    if (
      !text(d.reason) ||
      !text(d.source) ||
      d.source !== operations.get(d.operationId)?.registration.file
    )
      add('/business/dispositions', '非业务分类须说明该操作具体职责，并引用其实际注册文件。');
    excluded.add(d.operationId);
  }
  for (const op of operations.values())
    if (!covered.has(op.id) && !excluded.has(op.id))
      add(
        `/business/operations/${op.id}`,
        `操作尚未归类：${op.file} ${JSON.stringify(op.trigger)}`,
      );
  return problems;
}

export async function recordBusinessModel(session, input, filename) {
  fields(input, ['version', 'capabilities', 'dispositions', 'limitations'], '业务地图');
  if (
    input.version !== 1 ||
    !Array.isArray(input.capabilities) ||
    !Array.isArray(input.dispositions) ||
    !texts(input.limitations || [])
  )
    invalid('业务地图需要 version:1、capabilities、dispositions 和可选 limitations。');
  const ids = new Set();
  for (const c of input.capabilities) {
    fields(
      c,
      [
        'id',
        'title',
        'actor',
        'goal',
        'outcome',
        'classification',
        'operationIds',
        'results',
        'featureIds',
      ],
      '业务能力',
    );
    if (
      !text(c.id) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(c.id) ||
      ids.has(c.id) ||
      !['title', 'actor', 'goal', 'outcome'].every((k) => text(c[k])) ||
      !texts(c.operationIds) ||
      (!c.operationIds.length && c.classification !== 'requested') ||
      (c.classification !== undefined &&
        !['observed', 'requested', 'unknown'].includes(c.classification)) ||
      !texts(c.featureIds || [])
    )
      invalid('能力需要独立编号、使用者、目标、结果和不重复的操作编号；纯需求用 requested。');
    ids.add(c.id);
  }
  for (const d of input.dispositions) {
    fields(d, ['operationId', 'reason', 'source', 'kind', 'capabilityIds'], '非业务操作');
    if (!text(d.operationId) || !text(d.reason) || !text(d.source))
      invalid('非业务操作需要真实身份、职责理由和源码文件。');
    if (
      (d.kind !== undefined && !['internal', 'support', 'false-positive'].includes(d.kind)) ||
      (d.capabilityIds !== undefined && !texts(d.capabilityIds))
    )
      invalid(
        '操作分类使用 internal/support/false-positive；capabilityIds 是不重复的业务能力编号。',
      );
  }
  const snapshot = filename && readSnapshot(filename);
  return updateSession(session, (state) => {
    for (const c of input.capabilities) {
      const errors = evidenceProblems(state, c.results);
      if (errors.length) invalid(errors.join(' '));
      if (
        c.classification === 'requested' &&
        c.results.some((e) => !['context', 'requirement'].includes(e.kind))
      )
        invalid('尚未实现的需求须引用需求原文，不能用 helper 冒充实现。');
    }
    const model = {
      ...structuredClone(input),
      limitations: input.limitations || [],
      snapshotHash: state.snapshotHash,
      rulesHash: businessRulesHash,
      ...(filename
        ? {
            documentPath: fs.realpathSync(filename),
            featureBindings: Object.fromEntries(
              [...new Set(input.capabilities.flatMap((c) => c.featureIds || []))].map((id) => {
                const f = snapshot.document.features[id];
                if (!f) invalid(`业务能力引用未知功能：${id}`);
                return [id, { revision: f.revision, definitionHash: featureDefinitionHash(f) }];
              }),
            ),
          }
        : {}),
      submittedAt: new Date().toISOString(),
      provenance: 'agent-submitted',
    };
    model.recordHash = fingerprint(model);
    state.businessModels ||= {};
    state.businessModels.current = model;
    // A new map, including rebinding, invalidates earlier review decisions.
    state.businessModels.review = null;
    return { model, ...checkBusinessState(state, snapshot?.document, filename) };
  });
}

export function checkBusinessState(state, document, filename) {
  const model = state.businessModels?.current;
  const runtime = businessFlowResolver(state, document, filename);
  const connections = (model?.capabilities || []).map((capability) => ({
    capabilityId: capability.id,
    ...businessLinks(state, capability, runtime),
  }));
  const gaps = modelProblems(state, model, connections);
  if (model) gaps.push(...coverageProblems(state, model, runtime));
  const add = (where, message) => gaps.push({ path: where, kind: 'business', message });
  if (model && !gaps.length && document) {
    if (model.documentPath !== fs.realpathSync(filename))
      add('/business/document', '业务地图尚未显式关联当前产品书。');
    const featureIds = new Set();
    for (const c of model.capabilities) {
      if (!c.featureIds?.length) add(`/business/${c.id}`, '业务能力尚未落到产品书功能。');
      for (const id of c.featureIds || []) {
        featureIds.add(id);
        const f = document.features[id],
          binding = model.featureBindings?.[id];
        if (
          !f ||
          binding?.revision !== f.revision ||
          binding?.definitionHash !== featureDefinitionHash(f)
        )
          add(
            `/business/${c.id}/features/${id}`,
            '功能定义已变化或引用不存在；需重新核对业务地图。',
          );
      }
      for (const e of c.results) {
        const subject =
          e.kind === 'code'
            ? state.units.find((u) => u.id === e.unitId)
            : state.contexts.find((u) => u.id === e.contextId);
        const receipts =
          e.kind === 'code'
            ? state.records[e.unitId]?.receiptIds
            : Object.values(state.receipts)
                .filter((r) => r.file === subject?.file)
                .map((r) => r.id);
        if (subject && !receiptCoverage(state, subject, receipts || []))
          add(`/business/${c.id}/results`, '最终业务依据尚未完整读取，清单存在不等于理解。');
      }
    }
    for (const id of Object.keys(document.features))
      if (!featureIds.has(id)) add(`/features/${id}`, '产品书功能没有业务地图来源。');
  }
  const review = state.businessModels?.review;
  const reviewCurrent = Boolean(
    model &&
    review &&
    review.modelHash === model.recordHash &&
    review.recordHash === fingerprint(review),
  );
  const verdicts = new Map((reviewCurrent ? review.decisions : []).map((d) => [d.capabilityId, d]));
  const pending = (model?.capabilities || []).filter(
    (c) => verdicts.get(c.id)?.verdict !== 'supported',
  );
  const reviewedExclusions = new Map(
    (reviewCurrent ? review.exclusions || [] : []).map((d) => [d.operationId, d]),
  );
  const pendingExclusions = (model?.dispositions || []).filter(
    (d) => reviewedExclusions.get(d.operationId)?.verdict !== 'supported',
  );
  for (const d of model?.dispositions || []) {
    if (reviewedExclusions.get(d.operationId)?.verdict !== 'supported') continue;
    const op = state.facts.operations.find((o) => o.id === d.operationId),
      unit = state.units.find((u) => u.id === op?.unitId);
    if (
      unit &&
      (!state.records[unit.id] ||
        !recordValid(state, unit, state.records[unit.id]) ||
        reviewProblems(unit, state.records[unit.id]).length)
    )
      add(
        `/business/dispositions/${d.operationId}`,
        '排除操作尚无完整、合格的独立函数分析；审阅标签不能代替源码核对。',
      );
    if (op?.contextId) {
      const context = state.contexts.find((c) => c.id === op.contextId);
      if (
        context &&
        !receiptCoverage(
          state,
          context,
          Object.values(state.receipts)
            .filter((r) => r.file === context.file)
            .map((r) => r.id),
        )
      )
        add(`/business/dispositions/${d.operationId}`, '排除工作流尚未完整读取其原文。');
    }
  }
  const semanticStatus = !reviewCurrent
    ? 'unreviewed'
    : pending.length || pendingExclusions.length
      ? 'needs-attention'
      : 'reviewed';
  return {
    valid: gaps.length === 0 && semanticStatus === 'reviewed',
    coverageValid: gaps.length === 0,
    saved: Boolean(model),
    stage: gaps.length ? 'incomplete' : semanticStatus === 'reviewed' ? 'ready' : 'needs-review',
    semanticStatus,
    pendingReview: pending.map((c) => c.id),
    pendingExclusions: pendingExclusions.map((d) => d.operationId),
    capabilityCount: model?.capabilities.length || 0,
    operationCount: state.facts.operations?.length || 0,
    connections,
    gaps,
    modelHash: model?.recordHash,
    scope:
      'coverageValid 表示操作对账、来源及连接成立；valid 还要求能力和排除项审阅完成。保存地图不等于核验通过，审阅为代理提交，不宣称自然语言语义认证。',
  };
}

export function checkBusinessModel(session, filename) {
  const { state } = loadSession(session);
  assertFresh(state);
  return {
    ...checkBusinessState(state, filename && readSnapshot(filename).document, filename),
    model: state.businessModels?.current || null,
    review: state.businessModels?.review || null,
  };
}

export async function reviewBusinessModel(session, input) {
  fields(input, ['modelHash', 'reviewer', 'decisions', 'exclusions'], '业务语义审阅');
  if (!text(input.modelHash) || !text(input.reviewer) || !Array.isArray(input.decisions))
    invalid('审阅需要 modelHash、reviewer 和 decisions。');
  return updateSession(session, (state) => {
    const model = state.businessModels?.current;
    if (!model || model.recordHash !== input.modelHash) invalid('业务地图已变化；不能复用旧审阅。');
    const seen = new Set();
    for (const [index, d] of input.decisions.entries()) {
      fields(d, ['capabilityId', 'verdict', 'reason', 'evidence'], '审阅结论');
      if (
        !model.capabilities.some((c) => c.id === d.capabilityId) ||
        seen.has(d.capabilityId) ||
        !['supported', 'contradicted', 'unknown'].includes(d.verdict) ||
        !text(d.reason)
      )
        invalid('审阅须逐项引用真实能力和原始结果依据，结论为 supported/contradicted/unknown。');
      const problems = evidenceProblems(state, d.evidence, { resultOnly: false });
      if (problems.length)
        invalid(
          '业务审阅依据无效。',
          problems.map((message) => ({ path: `/decisions/${index}/evidence`, message })),
        );
      seen.add(d.capabilityId);
    }
    if (input.exclusions !== undefined && !Array.isArray(input.exclusions))
      invalid('exclusions 必须是逐操作审阅数组。');
    const operations = new Map((state.facts.operations || []).map((op) => [op.id, op]));
    const reviewed = new Set();
    for (const d of input.exclusions || []) {
      fields(d, ['operationId', 'verdict', 'reason', 'evidence'], '非业务分类审阅');
      const op = operations.get(d.operationId);
      if (
        !op ||
        !model.dispositions.some((item) => item.operationId === op.id) ||
        reviewed.has(op.id) ||
        !['supported', 'contradicted', 'unknown'].includes(d.verdict) ||
        !text(d.reason) ||
        evidenceProblems(state, d.evidence, { resultOnly: false }).length ||
        !d.evidence.some(
          (e) =>
            (e.kind === 'code' && e.unitId === op.unitId) ||
            (e.kind === 'context' && e.contextId === op.contextId),
        )
      )
        invalid('排除审阅须引用该真实操作的源码/上下文，不以批量理由隐藏用户能力。');
      reviewed.add(op.id);
    }
    const review = {
      ...structuredClone(input),
      submittedAt: new Date().toISOString(),
      provenance: 'agent-submitted',
    };
    review.recordHash = fingerprint(review);
    state.businessModels.review = review;
    return { review, ...checkBusinessState(state) };
  });
}
