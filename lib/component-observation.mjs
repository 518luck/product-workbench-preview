import fs from 'node:fs';
import { digest } from './analysis-facts.mjs';
import { primitiveFingerprint } from './flow.mjs';
import { runtimeFingerprint } from './flow-protocol.mjs';
import { behaviorUnit } from './source-evidence.mjs';
export const workflowHostObservation = false;

export function observationProblems(plan, scenario, state) {
  const observations = scenario.observations;
  if (!Array.isArray(observations) || !observations.length)
    return ['组件／契约场景须声明由工具观测的具体结果，文字断言和退出码不能代替。'];
  const steps = plan.steps.filter((s) => scenario.steps.includes(s.step)),
    problems = [];
  for (const item of observations) {
    const unit = state.units.find((u) => u.id === item?.unitId);
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (k) => !['unitId', 'event', 'operator', 'expected', 'factId', 'pointId'].includes(k),
      ) ||
      !unit ||
      !behaviorUnit(state, unit) ||
      !steps.some((s) => s.unitIds?.includes(unit.id)) ||
      !['return', 'throw', 'value', 'branch'].includes(item.event)
    ) {
      problems.push('观测须绑定当前场景步骤中真正执行业务的产品函数及结果位置。');
      continue;
    }
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
    } else if (item.operator === 'equals') {
      if (
        (!['string', 'boolean', 'number'].includes(typeof item.expected) &&
          item.expected !== null) ||
        (typeof item.expected === 'number' &&
          (!Number.isFinite(item.expected) ||
            (Number.isInteger(item.expected) && !Number.isSafeInteger(item.expected))))
      )
        problems.push('equals 需要可准确核对的 JSON 标量。');
    } else if (item.operator === 'type') {
      if (
        ![
          'undefined',
          'object',
          'string',
          'boolean',
          'number',
          'bigint',
          'function',
          'null',
        ].includes(item.expected)
      )
        problems.push('type 需要具体结果类型。');
    } else problems.push('结果观测须使用 equals 或 type，不以函数进入替代结果。');
  }
  for (const step of steps)
    if (!observations.some((o) => step.unitIds?.includes(o?.unitId)))
      problems.push(`步骤 ${step.step} 没有关联具体结果观测；文档上下文不能冒充运行。`);
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
  for (const observation of scenario.observations || []) {
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
    const passed = matching.some((e) =>
      observation.operator === 'error'
        ? e.errorMessage === observation.expected
        : observation.operator === 'error-name'
          ? e.errorName === observation.expected
          : observation.operator === 'type'
            ? e.valueType === observation.expected
            : observation.event === 'branch'
              ? e.decision === observation.expected
              : e.valueHash === primitiveFingerprint(observation.expected),
    );
    if (!passed)
      problems.push(`未观察到 ${observation.unitId} 的 ${observation.event} 满足所声明结果。`);
  }
  return [...new Set(problems)];
}
