import fs from 'node:fs';
import path from 'node:path';
import {
  loadSession,
  updateSession,
  assertFresh,
  receiptCoverage,
  recordValid,
  sessionFile,
} from './analysis-session.mjs';
import { readSnapshot } from './document-operations.mjs';
import { digest } from './analysis-facts.mjs';
import { featureDefinitionHash, checkFlowRecord } from './flow.mjs';
import { BlueprintError } from './errors.mjs';

const text = (v) => typeof v === 'string' && Boolean(v.trim());
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const levels = ['source', 'component', 'contract', 'end-to-end'];
const invalid = (message) => {
  throw new BlueprintError('INVALID_ARGUMENT', message);
};
const fingerprint = ({ recordHash, ...value }) => digest(JSON.stringify(value));
const verifierFingerprint = () =>
  digest(
    ['./verification-plan.mjs', './verification.mjs', '../schema/verification-plan.schema.json']
      .map((file) => fs.readFileSync(new URL(file, import.meta.url)))
      .join(''),
  );
const fields = (value, keys) => {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
    invalid('验收方案包含无效字段。');
};
function indices(value, count, label) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    new Set(value).size !== value.length ||
    value.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= count)
  )
    invalid(`${label} 必须引用不重复的真实业务位置。`);
}
function readRun(session, id) {
  if (!/^v-[a-f0-9-]{36}$/.test(id ?? '')) throw Error('缺少真实执行编号。');
  const directory = path.join(path.dirname(sessionFile(session)), 'verifications');
  const run = JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8'));
  const { hash, ...value } = run;
  if (run.id !== id || ![1, 2].includes(run.version) || hash !== digest(JSON.stringify(value)))
    throw Error('执行记录指纹无效。');
  for (const stream of ['stdout', 'stderr'])
    if (
      digest(fs.readFileSync(path.join(directory, `${id}.${stream}.log`))) !== run[`${stream}Hash`]
    )
      throw Error('执行内容缺失或被修改。');
  return run;
}
function contextReadable(state, id) {
  const c = state.contexts.find((c) => c.id === id);
  return (
    c &&
    receiptCoverage(
      state,
      c,
      Object.values(state.receipts)
        .filter((r) => r.file === c.file)
        .map((r) => r.id),
    )
  );
}
export function limitationSupported(limitation, state, session) {
  if (
    !object(limitation) ||
    !['adapter', 'environment', 'external'].includes(limitation.kind) ||
    !text(limitation.reason)
  )
    return false;
  const evidence = limitation.evidence;
  if (!object(evidence)) return false;
  if (evidence.kind === 'analysis-gap')
    return state.gaps.some(
      (g) =>
        ['semantic', 'language', 'adapter'].includes(g.kind) &&
        g.language === evidence.language &&
        g.message === evidence.message,
    );
  if (evidence.kind === 'context')
    return limitation.kind === 'external' && Boolean(contextReadable(state, evidence.id));
  if (evidence.kind === 'execution' && limitation.kind === 'environment') {
    try {
      const run = readRun(session, evidence.id);
      return (
        run.snapshotHash === state.snapshotHash &&
        run.purpose === 'environment' &&
        run.sourceStable &&
        run.documentStable &&
        (run.exitCode !== 0 || run.signal || run.timedOut)
      );
    } catch {
      return false;
    }
  }
  return false;
}
export function assertPlanCurrent(plan, state, filename, feature) {
  if (
    !plan ||
    plan.recordHash !== fingerprint(plan) ||
    plan.verifierHash !== verifierFingerprint() ||
    plan.documentPath !== fs.realpathSync(filename) ||
    plan.snapshotHash !== state.snapshotHash ||
    plan.featureId !== feature.id ||
    plan.revision !== feature.revision ||
    plan.definitionHash !== featureDefinitionHash(feature)
  )
    throw new BlueprintError(
      'ANALYSIS_STALE',
      '验收方案缺失或定义、源码、方案内容已变化，请先保存当前方案。',
      { status: 409 },
    );
}
export async function saveVerificationPlan(filename, session, input) {
  fields(input, ['expectedHash', 'id', 'featureId', 'goal', 'steps', 'scenarios']);
  const snapshot = readSnapshot(filename);
  if (snapshot.documentHash !== input.expectedHash)
    throw new BlueprintError('CONFLICT', '产品文档已变化，请重新读取。', { status: 409 });
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.id ?? '') || !text(input.goal))
    invalid('验收方案需要稳定 id 和具体业务目标 goal。');
  const feature = snapshot.document.features[input.featureId];
  if (!feature || !Array.isArray(input.steps) || !Array.isArray(input.scenarios))
    invalid('验收方案需要真实功能、steps 和 scenarios。');
  return updateSession(session, (state) => {
    if (readSnapshot(filename).documentHash !== snapshot.documentHash)
      throw new BlueprintError('CONFLICT', '保存验收方案期间文档已变化。', { status: 409 });
    const scenarios = new Map();
    for (const scenario of input.scenarios) {
      fields(scenario, [
        'id',
        'kind',
        'level',
        'steps',
        'criteria',
        'assertion',
        'flowId',
        'contractContextId',
      ]);
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(scenario.id ?? '') ||
        scenarios.has(scenario.id) ||
        !['normal', 'exception'].includes(scenario.kind) ||
        !levels.slice(1).includes(scenario.level) ||
        !text(scenario.assertion)
      )
        invalid('场景需要独立 id、验证层级、正常／异常类型及具体业务断言。');
      indices(scenario.steps, feature.flow.length, '场景步骤');
      indices(scenario.criteria, feature.checks?.length ?? 0, '验收条件');
      if (scenario.level === 'contract' && !contextReadable(state, scenario.contractContextId))
        invalid('契约验收需要已完整读取的当前契约上下文。');
      if (scenario.level === 'end-to-end') {
        const flow = state.flows?.[scenario.flowId];
        if (
          !flow ||
          flow.documentPath !== fs.realpathSync(filename) ||
          !flow.scenarios.some((s) => s.id === scenario.id && s.kind === scenario.kind) ||
          scenario.steps.some(
            (step) => !flow.nodes.some((n) => n.featureId === feature.id && n.step === step),
          )
        )
          invalid('端到端场景必须绑定覆盖所声明业务步骤的真实流程与同名场景。');
      }
      scenarios.set(scenario.id, scenario);
    }
    const seen = new Set();
    for (const step of input.steps) {
      fields(step, ['step', 'unitIds', 'contextIds', 'level', 'scenarioIds', 'limitation']);
      indices([step.step], feature.flow.length, '业务步骤');
      if (seen.has(step.step) || !levels.includes(step.level))
        invalid('每个业务步骤只能声明一次验证方式。');
      seen.add(step.step);
      const units = step.unitIds ?? [],
        contexts = step.contextIds ?? [];
      if (
        ![units, contexts, step.scenarioIds].every(Array.isArray) ||
        (!units.length && !contexts.length) ||
        [...units, ...contexts].some((id) => !text(id)) ||
        new Set([...units, ...contexts]).size !== units.length + contexts.length
      )
        invalid('每个业务步骤需要源码或上下文依据及 scenarioIds。');
      if (
        units.some((id) => {
          const u = state.units.find((u) => u.id === id);
          return !u || u.role !== 'product' || !recordValid(state, u, state.records[id]);
        }) ||
        contexts.some((id) => !contextReadable(state, id))
      )
        invalid('步骤依据尚未完整读取或分析，请继续补齐。');
      if (
        new Set(step.scenarioIds).size !== step.scenarioIds.length ||
        step.scenarioIds.some(
          (id) =>
            !scenarios.has(id) ||
            !scenarios.get(id).steps.includes(step.step) ||
            scenarios.get(id).level !== step.level,
        )
      )
        invalid('步骤必须关联验证方式一致且覆盖该步骤的场景。');
      if (
        (step.level === 'source' && step.scenarioIds.length) ||
        (step.level !== 'source' && !step.scenarioIds.length)
      )
        invalid('源码核对不冒充运行验证；运行验证必须声明场景。');
      if (
        step.limitation !== undefined &&
        (step.level !== 'source' || !limitationSupported(step.limitation, state, session))
      )
        invalid('限制需要真实能力缺口、失败执行或外部边界材料；一句未完成说明不能豁免。');
    }
    if (seen.size !== feature.flow.length || !seen.size)
      invalid('验收方案必须逐项覆盖当前功能的全部业务步骤。');
    for (const scenario of scenarios.values())
      if (
        scenario.steps.some(
          (i) => !input.steps.some((s) => s.step === i && s.scenarioIds.includes(scenario.id)),
        )
      )
        invalid('场景与步骤的范围必须双向一致。');
    const record = {
      id: input.id,
      featureId: feature.id,
      goal: input.goal,
      steps: structuredClone(input.steps),
      scenarios: structuredClone(input.scenarios),
      version: 1,
      verifierHash: verifierFingerprint(),
      documentPath: fs.realpathSync(filename),
      revision: feature.revision,
      definitionHash: featureDefinitionHash(feature),
      snapshotHash: state.snapshotHash,
      recordedAt: new Date().toISOString(),
      sequence: state.editRevision + 1,
    };
    record.recordHash = fingerprint(record);
    state.verificationPlans ||= {};
    const existing = state.verificationPlans[record.id];
    if (
      existing &&
      (existing.documentPath !== record.documentPath || existing.featureId !== record.featureId)
    )
      invalid('方案编号已属于其他文档或功能，不能覆盖。');
    state.verificationPlans[record.id] = record;
    return { plan: record };
  });
}
export function bindVerificationScope(filename, featureId, session, scope, flow) {
  fields(scope, ['planId', 'scenarioId', 'side']);
  const { state } = loadSession(session);
  assertFresh(state);
  const feature = readSnapshot(filename).document.features[featureId],
    plan = state.verificationPlans?.[scope.planId];
  if (!feature) invalid('功能不存在。');
  assertPlanCurrent(plan, state, filename, feature);
  const scenario = plan.scenarios.find((s) => s.id === scope.scenarioId);
  if (
    !scenario ||
    (scenario.level === 'contract'
      ? !['consumer', 'provider'].includes(scope.side)
      : scope.side !== undefined)
  )
    invalid('验收场景不存在或契约两端 side 不正确。');
  if (
    (scenario.level === 'end-to-end' &&
      (flow?.id !== scenario.flowId || flow.scenarioId !== scenario.id)) ||
    (scenario.level !== 'end-to-end' && flow)
  )
    invalid('端到端验收必须使用绑定的流程探针；组件／契约执行不冒充整条链路。');
  return {
    planId: plan.id,
    recordHash: plan.recordHash,
    scenarioId: scenario.id,
    ...(scope.side ? { side: scope.side } : {}),
  };
}
export function checkBoundScope(record, state, filename, feature) {
  const plan = state.verificationPlans?.[record.scope?.planId];
  assertPlanCurrent(plan, state, filename, feature);
  if (
    record.scope.recordHash !== plan.recordHash ||
    Date.parse(record.startedAt) < Date.parse(plan.recordedAt) ||
    !plan.scenarios.some((s) => s.id === record.scope.scenarioId)
  )
    throw Error('执行未绑定运行前保存的当前验收方案。');
}
export function checkVerificationPlans(filename, session, state = loadSession(session).state) {
  const { document } = readSnapshot(filename),
    features = {},
    gaps = [];
  try {
    assertFresh(state);
  } catch (error) {
    return { features, gaps: [{ kind: 'stale', path: '/', message: error.message }] };
  }
  const directory = path.join(path.dirname(sessionFile(session)), 'verifications');
  const runs = [];
  if (fs.existsSync(directory))
    for (const file of fs.readdirSync(directory).filter((f) => /^v-[a-f0-9-]{36}\.json$/.test(f))) {
      try {
        runs.push(readRun(session, file.slice(0, -5)));
      } catch {
        /* Missing/tampered runs cannot support any scenario. */
      }
    }
  for (const [id, feature] of Object.entries(document.features)) {
    const add = (kind, message, extra = {}) =>
      gaps.push({ path: `/features/${id}`, kind, message, ...extra });
    const plans = Object.values(state.verificationPlans || {})
      .filter((p) => p.documentPath === fs.realpathSync(filename) && p.featureId === id)
      .sort(
        (a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || b.recordedAt.localeCompare(a.recordedAt),
      );
    const plan = plans[0];
    if (!plan) {
      add('plan', '尚未保存此功能的分层验收方案。');
      continue;
    }
    try {
      assertPlanCurrent(plan, state, filename, feature);
    } catch (error) {
      add('stale', error.message);
      continue;
    }
    const scenarios = plan.scenarios.map((scenario) => {
      const matching = runs.filter((r) => {
        try {
          checkBoundScope(r, state, filename, feature);
        } catch {
          return false;
        }
        return (
          r.scope.planId === plan.id &&
          r.scope.scenarioId === scenario.id &&
          r.documentPath === plan.documentPath &&
          r.featureId === id &&
          r.definitionHash === plan.definitionHash &&
          r.revision === feature.revision &&
          r.snapshotHash === state.snapshotHash &&
          r.exitCode === 0 &&
          r.purpose !== 'environment' &&
          !r.signal &&
          !r.timedOut &&
          !r.outputExceeded &&
          r.sourceStable &&
          r.documentStable
        );
      });
      let valid = matching.length > 0;
      if (scenario.level === 'contract')
        valid = ['consumer', 'provider'].every((side) =>
          matching.some((r) => r.scope.side === side),
        );
      if (scenario.level === 'end-to-end') {
        const flow = state.flows?.[scenario.flowId];
        valid =
          valid &&
          Boolean(flow) &&
          checkFlowRecord(flow, state, document, session).valid &&
          matching.some(
            (r) =>
              r.version === 2 && r.flow?.id === flow.id && r.flow.recordHash === flow.recordHash,
          );
      }
      if (!valid)
        add(
          'verification',
          `场景「${scenario.assertion}」尚缺当前方案的${scenario.level === 'contract' ? '调用方与服务方独立' : ''}有效执行证据。`,
          { scenarioId: scenario.id },
        );
      return { ...scenario, valid, executionIds: matching.map((r) => r.id) };
    });
    const steps = plan.steps.map((step) => {
      const valid =
        step.level === 'source' ||
        step.scenarioIds.every((id) => scenarios.find((s) => s.id === id)?.valid);
      if (step.limitation) {
        if (limitationSupported(step.limitation, state, session))
          add('limitation', step.limitation.reason, {
            path: `/features/${id}/flow/${step.step}`,
            limitation: step.limitation,
          });
        else
          add('verification', '限制证据已失效，需要重新核对。', {
            path: `/features/${id}/flow/${step.step}`,
          });
      }
      if (
        step.level === 'source' &&
        !step.limitation &&
        feature.implementedRevision === feature.revision
      )
        add('plan', '完成功能的步骤只有源码核对，需补运行验收或具体限制。', {
          path: `/features/${id}/flow/${step.step}`,
        });
      return {
        step: step.step,
        level: step.level,
        valid,
        ...(step.limitation ? { limitation: step.limitation } : {}),
      };
    });
    features[id] = {
      planId: plan.id,
      goal: plan.goal,
      revision: feature.revision,
      definitionHash: plan.definitionHash,
      steps,
      scenarios,
      scope: '组件与契约执行只支持声明的业务断言；断言的业务充分性须审阅，不代表整条链路已观测。',
    };
  }
  return { features, gaps };
}
