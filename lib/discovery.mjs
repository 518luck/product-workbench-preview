import fs from 'node:fs';
import path from 'node:path';
import { loadSession, assertFresh, updateSession, receiptCoverage } from './analysis-session.mjs';
import { inspectBusinessInput } from './business-model.mjs';
import { scopeCoverage, scopeGaps } from './analysis-scope.mjs';
import { digest } from './analysis-facts.mjs';
import { hollowExplanation } from './evidence-quality.mjs';
import { BlueprintError } from './errors.mjs';
import { requireWorkflow, getWorkflowConfig } from './workflow-config.mjs';

const rulesHash = digest(fs.readFileSync(new URL(import.meta.url)));
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && Boolean(v.trim());
const hash = ({ recordHash, ...v }) => digest(JSON.stringify(v));
const invalid = (message) => {
  throw new BlueprintError('INVALID_ARGUMENT', message);
};
const modulesOf = (state) =>
  [
    ...new Set(
      state.units.filter((u) => u.role === 'product').map((u) => path.posix.dirname(u.file)),
    ),
  ].sort();

function validateInput(state, input) {
  if (
    !object(input) ||
    Object.keys(input).some((k) => !['version', 'model', 'modules'].includes(k)) ||
    input.version !== 1 ||
    !Array.isArray(input.modules)
  )
    invalid('发现结果需要 version:1、model 和 modules；格式见 schema --discovery。');
  const report = inspectBusinessInput(state, input.model),
    seen = new Set(),
    capabilities = new Map(input.model.capabilities.map((c) => [c.id, c])),
    directories = modulesOf(state);
  for (const m of input.modules) {
    if (
      !object(m) ||
      Object.keys(m).some((k) => !['directory', 'status', 'capabilityIds', 'reason'].includes(k)) ||
      !directories.includes(m.directory) ||
      seen.has(m.directory) ||
      !['mapped', 'internal', 'pending'].includes(m.status) ||
      !text(m.reason) ||
      !Array.isArray(m.capabilityIds) ||
      m.capabilityIds.some((id) => !capabilities.has(id)) ||
      new Set(m.capabilityIds).size !== m.capabilityIds.length ||
      (m.status === 'mapped' && !m.capabilityIds.length) ||
      (m.status !== 'mapped' && m.capabilityIds.length)
    )
      invalid(
        '模块须逐目录归类 mapped/internal/pending，mapped 关联真实能力，其余保留空 capabilityIds 并解释原因。',
      );
    seen.add(m.directory);
  }
  return report;
}

function inspect(state, record) {
  const config = getWorkflowConfig(state.root);
  const empty = {
    valid: false,
    stage: 'not-started',
    gaps: [{ kind: 'discovery', path: '/discovery', message: '尚未保存独立业务发现结果。' }],
  };
  if (!record) return { ...empty, initializationComplete: false, bookGenerated: false };
  const report = validateInput(state, record.input),
    gaps = [...report.gaps];
  gaps.push(...state.gaps.filter((g) => g.kind !== 'semantic'));
  const add = (where, kind, message) => gaps.push({ path: where, kind, message });
  if (
    record.recordHash !== hash(record) ||
    record.snapshotHash !== state.snapshotHash ||
    record.rulesHash !== rulesHash ||
    record.mapRulesHash !== report.model.rulesHash
  )
    add('/discovery', 'stale', '发现结果或检查规则已变化，不能复用旧结论。');
  if (record.configHash !== config.configHash)
    add('/discovery/config', 'stale', '任务配置已变化，重新核对本阶段；不会自动重跑全量分析。');
  const coverage = scopeCoverage(state);
  gaps.push(...scopeGaps(coverage));
  const units = new Map(state.units.map((u) => [u.id, u])),
    ops = new Map(state.facts.operations.map((o) => [o.id, o]));
  const byFile = new Map(),
    sources = new Map();
  for (const r of Object.values(state.receipts)) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r.id);
  }
  const read = (file, start, end) => {
    const item = state.manifest.find((m) => m.file === file);
    return (
      item &&
      receiptCoverage(state, { file, start, end, hash: item.hash }, byFile.get(file) || [], sources)
    );
  };
  // Only actual source fragments used by this candidate map must be read here.
  // Full independent function analysis belongs to the later expansion stage.
  for (const c of record.input.model.capabilities) {
    for (const id of c.operationIds) {
      const op = ops.get(id);
      if (!op) continue;
      const r = op.registration;
      if (!read(r.file, r.start, Math.min(r.end, r.start + 256)))
        add(
          `/capabilities/${c.id}/operations/${id}`,
          'reading',
          '此操作的注册/分发原文片段尚未读取。',
        );
    }
    for (const e of c.results) {
      if (e.kind === 'code') {
        const u = units.get(e.unitId),
          p = u?.reviewPoints.find((p) => p.id === e.pointId);
        if (p && !read(u.file, p.start, p.end))
          add(
            `/capabilities/${c.id}/results`,
            'reading',
            '结果位置原文尚未读取；索引存在不等于读过。',
          );
      } else if (e.kind === 'context' || (e.kind === 'requirement' && e.source === 'document')) {
        const ctx = state.contexts.find((c) => c.id === e.contextId),
          quote = e.quote || e.text;
        if (ctx && text(quote)) {
          const body = fs
              .readFileSync(path.join(state.root, ctx.file), 'utf8')
              .slice(ctx.start, ctx.end),
            at = body.indexOf(quote);
          if (at >= 0 && !read(ctx.file, ctx.start + at, ctx.start + at + quote.length))
            add(`/capabilities/${c.id}/results`, 'reading', '工作流/需求引用原文片段尚未读取。');
        }
      }
    }
  }
  const modules = new Map(record.input.modules.map((m) => [m.directory, m]));
  for (const directory of modulesOf(state)) {
    const m = modules.get(directory);
    if (!m || m.status === 'pending') {
      add(`/modules/${directory}`, 'module', '目录尚未完成业务归类，保留为待分析。');
      continue;
    }
    if (hollowExplanation(m.reason, { unit: { file: directory, name: directory } }))
      add(`/modules/${directory}`, 'module', '目录归类需要说明真实职责，不能用空泛理由。');
    if (
      m.status === 'mapped' &&
      !m.capabilityIds.some((id) => {
        const c = record.input.model.capabilities.find((c) => c.id === id);
        return (
          c.operationIds.some(
            (id) => path.posix.dirname(ops.get(id)?.registration.file || '') === directory,
          ) ||
          c.results.some(
            (e) =>
              e.kind === 'code' &&
              path.posix.dirname(units.get(e.unitId)?.file || '') === directory,
          )
        );
      })
    )
      add(`/modules/${directory}`, 'module', '目录没有连接到所声明能力的入口或结果。');
  }
  const valid = !gaps.length;
  return {
    valid,
    stage: valid ? 'ready' : gaps.some((g) => g.kind === 'stale') ? 'stale' : 'needs-attention',
    snapshotHash: state.snapshotHash,
    configHash: config.configHash,
    recordHash: record.recordHash,
    capabilityCount: record.input.model.capabilities.length,
    operationCount: ops.size,
    moduleCount: modulesOf(state).length,
    capabilities: record.input.model.capabilities,
    modules: record.input.modules,
    gaps,
    scopeCoverage: coverage,
    analysisBoundaries: state.gaps.filter((g) => g.kind === 'semantic'),
    initializationComplete: false,
    bookGenerated: false,
    runtimeVerified: false,
    completion: {
      claim: valid ? 'discovery-ready' : null,
      nextAction: valid ? 'select-feature-expansion' : 'resolve-discovery-gaps',
    },
    scope:
      '仅检查候选业务目录的操作/结果关联、来源片段和模块对账，不要求全仓函数记录，不证明自然语言语义正确，不表示产品书或运行验收完成。',
  };
}

export function checkDiscovery(session) {
  const { state } = loadSession(session);
  assertFresh(state);
  return inspect(state, state.businessModels?.discovery);
}

export async function recordDiscovery(session, input) {
  return updateSession(session, (state) => {
    const plan = requireWorkflow(state.root, { skill: 'init', stage: 'discover' });
    const report = validateInput(state, input);
    const record = {
      version: 1,
      input: structuredClone(input),
      snapshotHash: state.snapshotHash,
      configHash: plan.configHash,
      rulesHash,
      mapRulesHash: report.model.rulesHash,
      submittedAt: new Date().toISOString(),
      provenance: 'agent-submitted',
    };
    record.recordHash = hash(record);
    state.businessModels ||= {};
    state.businessModels.discovery = record;
    return { saved: true, ...inspect(state, record) };
  });
}
