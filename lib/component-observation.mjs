import fs from 'node:fs';
import { digest } from './analysis-facts.mjs';
import { primitiveFingerprint } from './flow.mjs';
import { runtimeFingerprint } from './flow-protocol.mjs';
import { behaviorUnit } from './source-evidence.mjs';
import { currentAssessment } from './feature-operations.mjs';
export const workflowHostObservation = false;

export function stepBasisProblems(feature, step, state) {
  const item = currentAssessment(feature)?.items.find((i) => i.target === `/flow/${step.step}`);
  if (!item || item.state !== 'implemented') return [];
  const code = item.basis?.filter((b) => b.kind === 'code').map((b) => b.unitId) || [];
  const context = item.basis?.filter((b) => b.kind === 'context').map((b) => b.contextId) || [];
  if (
    ['component', 'contract'].includes(step.level) &&
    context.some((id) =>
      state?.facts.entries.some((entry) => entry.kind === 'workflow' && entry.contextId === id),
    )
  )
    return [
      `步骤 ${step.step} 包含工作流宿主行为，不能以普通组件调用代替；请拆分可运行组件与宿主边界，保留真实未核验范围。`,
    ];
  return (code.length || context.length) &&
    code.every((id) => step.unitIds?.includes(id)) &&
    context.every((id) => step.contextIds?.includes(id))
    ? []
    : [`步骤 ${step.step} 的方案来源与该步骤的实现核对依据不一致；请对照实际行为统一映射。`];
}

export function observationProblems(plan, scenario, state) {
  const observations = scenario.observations;
  if (!Array.isArray(observations) || !observations.length)
    return ['组件／契约场景须声明由工具观测的具体结果，文字断言和退出码不能代替。'];
  const steps = plan.steps.filter((s) => scenario.steps.includes(s.step)),
    problems = [],
    bindings = new Map();
  const location = (item) => {
    const returns = state.facts.values.filter(
      (f) => f.unitId === item.unitId && f.kind === 'return',
    );
    return {
      unitId: item.unitId,
      event: item.event,
      step: item.step,
      locus:
        item.factId ||
        item.pointId ||
        (item.event === 'return' && returns.length === 1 ? returns[0].id : null),
    };
  };
  // Scope belongs to the whole plan, not just one scene. Splitting a fake
  // multi-step proof into several scenes must not widen its real coverage.
  const locations = (plan.scenarios || [])
    .filter((s) => s.id !== scenario.id && s.level !== 'end-to-end')
    .flatMap((s) =>
      (Array.isArray(s.observations) ? s.observations : [])
        .filter((o) => o && typeof o === 'object')
        .map(location),
    );
  for (const item of observations) {
    const unit = state.units.find((u) => u.id === item?.unitId);
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (k) =>
          ![
            'unitId',
            'event',
            'operator',
            'expected',
            'factId',
            'pointId',
            'step',
            'criterion',
            'path',
          ].includes(k),
      ) ||
      !unit ||
      !behaviorUnit(state, unit) ||
      !steps.some((s) => s.step === item.step && s.unitIds?.includes(unit.id)) ||
      !scenario.criteria.includes(item.criterion) ||
      !['return', 'throw', 'value', 'branch'].includes(item.event)
    ) {
      problems.push('观测须绑定当前场景步骤中真正执行业务的产品函数及结果位置。');
      continue;
    }
    const signature = JSON.stringify([
      item.unitId,
      item.event,
      item.operator,
      item.expected,
      item.factId,
      item.pointId,
      item.path,
    ]);
    const binding = `${item.step}:${item.criterion}`;
    if (bindings.has(signature) && bindings.get(signature) !== binding)
      problems.push('同一个观测不能重复充当不同业务步骤或验收条件的结果证明。');
    bindings.set(signature, binding);
    // Values/field names are not source locations. Distinct results from the
    // same return cannot be relabelled as several independent business stages.
    const { locus } = location(item);
    if (
      locations.some(
        (p) =>
          p.unitId === unit.id &&
          p.event === item.event &&
          p.step !== item.step &&
          (!p.locus || !locus || p.locus === locus),
      )
    )
      problems.push(
        '同一结果源码位置不能因预期值或字段不同而覆盖多个业务步骤；请绑定各步骤实际产生结果的位置。',
      );
    locations.push({ unitId: unit.id, event: item.event, step: item.step, locus });
    if (
      item.path !== undefined &&
      (unit.language !== 'javascript' ||
        !['return', 'value'].includes(item.event) ||
        typeof item.path !== 'string' ||
        !/^\/(?:[^~]|~[01])*$/.test(item.path) ||
        item.path.split('/').some((p) => ['__proto__', 'constructor', 'prototype'].includes(p)))
    )
      problems.push('结果 path 须为 JS/TS 返回值上的非空 JSON Pointer；其他语言字段观测暂未支持。');
    const fact = state.facts.values.find((f) => f.id === item.factId && f.unitId === unit.id);
    if (
      item.factId &&
      (!fact ||
        (item.event === 'return'
          ? fact.kind !== 'return'
          : ['parameter', 'constant', 'read'].includes(fact.kind)))
    )
      problems.push('结果观测不能只检查输入、常量或其他单元的数据位置。');
    if (item.event === 'value' && !item.factId) problems.push('value 观测需要真实结果 factId。');
    if (
      item.event === 'branch' &&
      !unit.reviewPoints.some((p) => p.id === item.pointId && p.field === 'conditions')
    )
      problems.push('分支观测需要本函数的实际条件 pointId。');
    if (item.event === 'throw') {
      if (
        !['error', 'error-name'].includes(item.operator) ||
        typeof item.expected !== 'string' ||
        !item.expected.trim()
      )
        problems.push('异常观测须核对具体错误消息或类型，不能仅要求发生任意错误。');
      if (
        item.operator === 'error-name' &&
        [
          'Error',
          'TypeError',
          'Exception',
          'RuntimeError',
          'ValueError',
          'error',
          'std::runtime_error',
        ].includes(item.expected)
      )
        problems.push('通用异常类型不能证明业务拒绝原因，请核对具体错误消息或业务异常类型。');
    } else if (item.operator === 'equals') {
      if (
        (!['string', 'boolean', 'number'].includes(typeof item.expected) &&
          item.expected !== null) ||
        (typeof item.expected === 'number' &&
          (!Number.isFinite(item.expected) ||
            (Number.isInteger(item.expected) && !Number.isSafeInteger(item.expected))))
      )
        problems.push('equals 需要可准确核对的 JSON 标量。');
    } else
      problems.push(
        '返回类型只属辅助信息；业务观测须核对 equals 的具体结果，不以类型或函数进入替代。',
      );
    if (
      item.event === 'branch' &&
      (item.operator !== 'equals' || typeof item.expected !== 'boolean')
    )
      problems.push('分支观测须核对真实的布尔决定。');
  }
  for (const step of steps)
    for (const unitId of step.unitIds || [])
      if (!observations.some((o) => o?.step === step.step && o.unitId === unitId))
        problems.push(
          `步骤 ${step.step} 的 ${unitId} 没有关联实际结果；不能添加未观测函数扩大范围。`,
        );
  for (const criterion of scenario.criteria)
    if (!observations.some((o) => o?.criterion === criterion))
      problems.push(`验收条件 ${criterion} 没有关联独立的具体结果观测。`);
  if (scenario.failure !== undefined) {
    const failure = scenario.failure,
      result = observations[failure?.observation],
      unit = state.units.find((u) => u.id === result?.unitId);
    if (
      !failure ||
      typeof failure !== 'object' ||
      Array.isArray(failure) ||
      Object.keys(failure).some((k) => !['observation', 'pointId', 'decision'].includes(k)) ||
      scenario.kind !== 'exception' ||
      !Number.isSafeInteger(failure.observation) ||
      failure.observation < 0 ||
      !result ||
      typeof failure.decision !== 'boolean' ||
      !unit?.reviewPoints.some(
        (p) => p.id === failure.pointId && p.field === 'conditions' && p.kind !== 'iteration',
      )
    )
      problems.push(
        'failure 须引用本异常场景的结果观测及同一函数内实际拒绝条件 pointId 与 decision。',
      );
  }
  if (
    scenario.kind === 'exception' &&
    !scenario.failure &&
    !observations.some(
      (o) =>
        o.event === 'throw' ||
        (['return', 'value'].includes(o.event) &&
          o.operator === 'equals' &&
          (o.expected === false || o.expected === null)),
    )
  )
    problems.push(
      '异常场景缺少实际拒绝或失败结果：需具体异常、拒绝布尔值／空结果，或 failure 绑定的实际拒绝分支；另一组正常返回值不算异常。',
    );
  return problems;
}

export function checkComponentObservation(record, plan, scenario, state, recordFile) {
  const problems = observationProblems(plan, scenario, state);
  if (
    record.version !== 2 ||
    record.observation?.planId !== plan.id ||
    record.observation.recordHash !== plan.recordHash ||
    record.observation.scenarioId !== scenario.id ||
    record.probeHash !== runtimeFingerprint() ||
    !record.copyVerified ||
    !record.copyStable ||
    record.integrity?.length
  )
    return [...problems, '缺少当前方案的工具运行观测，普通命令成功或手写日志不算业务通过。'];
  let events;
  try {
    const bytes = fs.readFileSync(recordFile.replace(/\.json$/, '.events.json'));
    if (digest(bytes) !== record.eventsHash) throw Error();
    events = JSON.parse(bytes);
    if (!Array.isArray(events) || events.some((e) => e.runId !== record.id)) throw Error();
  } catch {
    return [...problems, '工具观测内容缺失、被修改或串到其他执行。'];
  }
  for (const [index, observation] of (scenario.observations || []).entries()) {
    const matching = events.filter(
      (e) =>
        e.unitId === observation.unitId &&
        e.kind === observation.event &&
        (!observation.factId || e.factId === observation.factId) &&
        (!observation.pointId || e.pointId === observation.pointId) &&
        events.some(
          (entered) =>
            entered.kind === 'enter' && entered.unitId === e.unitId && entered.spanId === e.spanId,
        ),
    );
    const passed = matching.some((e) => {
      if (
        scenario.failure?.observation === index &&
        !events.some(
          (branch) =>
            branch.kind === 'branch' &&
            branch.unitId === e.unitId &&
            branch.spanId === e.spanId &&
            branch.pointId === scenario.failure.pointId &&
            branch.decision === scenario.failure.decision,
        )
      )
        return false;
      return observation.operator === 'error'
        ? e.errorMessage === observation.expected
        : observation.operator === 'error-name'
          ? e.errorName === observation.expected
          : observation.event === 'branch'
            ? e.decision === observation.expected
            : (observation.path ? e.fields?.[observation.path]?.valueHash : e.valueHash) ===
              primitiveFingerprint(observation.expected);
    });
    if (!passed)
      problems.push(`未观察到 ${observation.unitId} 的 ${observation.event} 满足所声明结果。`);
  }
  return [...new Set(problems)];
}
