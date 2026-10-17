import fs from 'node:fs';
import path from 'node:path';
import {
  loadSession,
  assertFresh,
  updateSession,
  sessionFile,
  recordValid,
} from './analysis-session.mjs';
import { readSnapshot } from './document-operations.mjs';
import { businessFields } from './feature-operations.mjs';
import { digest } from './analysis-facts.mjs';
import { reviewProblems } from './analysis-review.mjs';
import { BlueprintError } from './errors.mjs';
import { runtimeFingerprint } from './flow-protocol.mjs';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const id = (value) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(value);
const invalid = (message) => {
  throw new BlueprintError('INVALID_ARGUMENT', message);
};
export const featureDefinitionHash = (feature) =>
  digest(JSON.stringify(businessFields.map((key) => [key, feature[key] ?? null])));
const withoutHash = ({ recordHash, ...value }) => value;
export const flowDigest = (flow) => digest(JSON.stringify(withoutHash(flow)));
function fields(value, names, label) {
  if (!object(value) || Object.keys(value).some((key) => !names.includes(key)))
    invalid(`${label} 包含无效字段。`);
}
function unique(items, label) {
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.some((item) => !object(item) || !id(item.id)) ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    invalid(`${label} 必须为带独立 id 的非空数组。`);
}
export function validateFlow(flow, state, document) {
  fields(flow, ['id', 'title', 'entryId', 'nodes', 'edges', 'scenarios'], '业务流程');
  if (!id(flow.id) || !text(flow.title) || !text(flow.entryId))
    invalid('业务流程需要 id、title 和当前清单中的 entryId。');
  if (!state.facts?.entries.some((entry) => entry.id === flow.entryId)) invalid('流程入口不存在。');
  unique(flow.nodes, 'nodes');
  unique(flow.scenarios, 'scenarios');
  if (!Array.isArray(flow.edges)) invalid('edges 必须为数组。');
  if (flow.edges.length) unique(flow.edges, 'edges');
  const unitMap = new Map(state.units.map((unit) => [unit.id, unit]));
  const valueMap = new Map((state.facts?.values || []).map((value) => [value.id, value]));
  const nodeMap = new Map(flow.nodes.map((node) => [node.id, node]));
  for (const node of flow.nodes) {
    fields(
      node,
      [
        'id',
        'featureId',
        'step',
        'unitId',
        'contextId',
        'relatedUnitIds',
        'pointIds',
        'inputs',
        'outputs',
      ],
      '流程步骤',
    );
    const feature = document.features[node.featureId];
    if (
      !feature ||
      !Number.isSafeInteger(node.step) ||
      node.step < 0 ||
      node.step >= feature.flow.length
    )
      invalid('流程步骤必须引用真实功能及业务步骤。');
    if (Boolean(node.unitId) === Boolean(node.contextId))
      invalid('步骤需要且只能有 unitId 或 contextId。');
    if (node.unitId && !unitMap.has(node.unitId)) invalid('步骤引用的源码单元不存在。');
    if (node.contextId && !state.contexts.some((context) => context.id === node.contextId))
      invalid('步骤引用的上下文不存在。');
    for (const key of ['relatedUnitIds', 'pointIds', 'inputs', 'outputs'])
      if (
        node[key] !== undefined &&
        (!Array.isArray(node[key]) ||
          node[key].some((value) => typeof value !== 'string') ||
          new Set(node[key]).size !== node[key].length)
      )
        invalid(`${key} 必须为不重复的编号数组。`);
    const owners = [node.unitId, ...(node.relatedUnitIds || [])].filter(Boolean);
    if (owners.some((owner) => !unitMap.has(owner))) invalid('relatedUnitIds 包含不存在的单元。');
    for (const pointId of node.pointIds || [])
      if (
        !owners.some((owner) =>
          unitMap.get(owner).reviewPoints.some((point) => point.id === pointId),
        )
      )
        invalid('审阅位置不属于该步骤声明的源码。');
    for (const valueId of [...(node.inputs || []), ...(node.outputs || [])])
      if (!valueMap.has(valueId) || !owners.includes(valueMap.get(valueId).unitId))
        invalid('输入输出必须引用该步骤真实的源码数据位置。');
  }
  for (const edge of flow.edges) {
    fields(edge, ['id', 'from', 'to', 'kind', 'callId', 'sourceId', 'targetId'], '流程连接');
    if (
      !nodeMap.has(edge.from) ||
      !nodeMap.has(edge.to) ||
      !['call', 'data', 'event', 'http', 'workflow'].includes(edge.kind)
    )
      invalid('连接需要有效端点和 kind。');
    if (edge.kind === 'data' && (!text(edge.sourceId) || !text(edge.targetId)))
      invalid('数据连接需要 sourceId、targetId。');
    if (edge.sourceId && !(nodeMap.get(edge.from).outputs || []).includes(edge.sourceId))
      invalid('连接源数据不在上一步 outputs 中。');
    if (edge.targetId && !(nodeMap.get(edge.to).inputs || []).includes(edge.targetId))
      invalid('连接目标数据不在下一步 inputs 中。');
    if (
      edge.callId &&
      !state.units.some((unit) => unit.calls.some((call) => call.id === edge.callId))
    )
      invalid('callId 不存在。');
  }
  for (const scenario of flow.scenarios) {
    fields(
      scenario,
      ['id', 'title', 'kind', 'entryNode', 'terminalNodes', 'edges', 'assertions'],
      '流程场景',
    );
    if (
      !text(scenario.title) ||
      !['normal', 'exception'].includes(scenario.kind) ||
      !nodeMap.has(scenario.entryNode) ||
      !Array.isArray(scenario.terminalNodes) ||
      !scenario.terminalNodes.length ||
      scenario.terminalNodes.some((node) => !nodeMap.has(node))
    )
      invalid('场景需要名称、normal/exception、入口和终点。');
    if (
      !Array.isArray(scenario.edges) ||
      scenario.edges.some((edgeId) => !flow.edges.some((edge) => edge.id === edgeId))
    )
      invalid('场景连接引用无效。');
    const entrance = state.facts.entries.find((entry) => entry.id === flow.entryId),
      entryNode = nodeMap.get(scenario.entryNode);
    if (
      (entrance.unitId && entryNode.unitId !== entrance.unitId) ||
      (entrance.contextId && entryNode.contextId !== entrance.contextId)
    )
      invalid('场景必须从流程声明的真实入口开始。');
    if (!Array.isArray(scenario.assertions) || !scenario.assertions.length)
      invalid('场景必须声明可执行结果断言，不能只检查命令退出码。');
    for (const assertion of scenario.assertions) {
      fields(assertion, ['nodeId', 'valueId', 'event', 'operator', 'expected'], '结果断言');
      if (
        !nodeMap.has(assertion.nodeId) ||
        !['return', 'throw', 'value', 'enter', 'branch', 'point'].includes(assertion.event) ||
        !['exists', 'equals', 'type'].includes(assertion.operator)
      )
        invalid('结果断言需要有效步骤、事件与比较操作。');
      if (
        assertion.valueId &&
        !valueMap.has(assertion.valueId) &&
        !state.units.some((unit) =>
          unit.reviewPoints.some((point) => point.id === assertion.valueId),
        )
      )
        invalid('结果断言的数据或分支位置不存在。');
      if (assertion.operator !== 'exists' && !Object.hasOwn(assertion, 'expected'))
        invalid('比较断言需要 expected。');
      if (
        assertion.operator === 'equals' &&
        assertion.expected !== null &&
        !['string', 'number', 'boolean'].includes(typeof assertion.expected)
      )
        invalid('equals 当前支持 JSON 标量；对象请引用可观测的字段，不能只比较对象序列化结果。');
      if (
        assertion.operator === 'equals' &&
        typeof assertion.expected === 'number' &&
        (!Number.isFinite(assertion.expected) ||
          (Number.isInteger(assertion.expected) && !Number.isSafeInteger(assertion.expected)))
      )
        invalid('数值断言需要有限 JSON 数字；整数须在安全整数范围内，避免跨语言精度丢失。');
    }
  }
}
export async function recordFlows(filename, session, input) {
  fields(input, ['expectedHash', 'flows', 'dispositions'], '流程记录输入');
  const snapshot = readSnapshot(filename);
  if (input.expectedHash !== snapshot.documentHash)
    throw new BlueprintError('CONFLICT', '产品文档已变化，请重新读取后绑定流程。', { status: 409 });
  if (!Array.isArray(input.flows) || (!input.flows.length && !input.dispositions?.length))
    invalid('需要 flows 或入口排除说明。');
  return updateSession(session, (state) => {
    if (readSnapshot(filename).documentHash !== snapshot.documentHash)
      throw new BlueprintError('CONFLICT', '文档在流程保存期间已变化。', { status: 409 });
    const seen = new Set(),
      stored = [];
    for (const flow of input.flows) {
      validateFlow(flow, state, snapshot.document);
      if (seen.has(flow.id)) invalid('同批流程编号重复。');
      seen.add(flow.id);
      const features = [...new Set(flow.nodes.map((node) => node.featureId))];
      const record = {
        ...structuredClone(flow),
        version: 1,
        verifierHash: runtimeFingerprint(),
        documentPath: fs.realpathSync(filename),
        snapshotHash: state.snapshotHash,
        featureBindings: Object.fromEntries(
          features.map((featureId) => [
            featureId,
            {
              revision: snapshot.document.features[featureId].revision,
              definitionHash: featureDefinitionHash(snapshot.document.features[featureId]),
            },
          ]),
        ),
        recordedAt: new Date().toISOString(),
      };
      record.recordHash = flowDigest(record);
      stored.push(record);
    }
    state.flows ||= {};
    state.entryDispositions ||= {};
    for (const disposition of input.dispositions || []) {
      fields(disposition, ['entryId', 'reason'], '入口排除说明');
      if (
        !state.facts.entries.some((entry) => entry.id === disposition.entryId) ||
        !text(disposition.reason)
      )
        invalid('入口排除说明需要真实 entryId 和具体 reason。');
      state.entryDispositions[disposition.entryId] = {
        reason: disposition.reason,
        snapshotHash: state.snapshotHash,
      };
    }
    for (const record of stored) {
      state.flows[record.id] = record;
      delete state.entryDispositions[record.entryId];
    }
    return {
      flows: stored.map((flow) => ({ id: flow.id, recordHash: flow.recordHash })),
      snapshotHash: state.snapshotHash,
    };
  });
}
function reachable(from, to, edges) {
  if (from === to) return true;
  const next = new Map();
  for (const edge of edges) {
    if (!next.has(edge.from)) next.set(edge.from, []);
    next.get(edge.from).push(edge.to);
  }
  const visited = new Set([from]),
    queue = [from];
  for (let index = 0; index < queue.length; index++)
    for (const child of next.get(queue[index]) || []) {
      if (child === to) return true;
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  return false;
}
export const primitiveFingerprint = (value) => {
  const type = value === null ? 'null' : typeof value;
  return digest(
    JSON.stringify({
      type,
      value: type === 'number' && !Number.isFinite(value) ? String(value) : value,
    }),
  );
};
function loadRuns(session, flow) {
  const directory = path.join(path.dirname(sessionFile(session)), 'verifications');
  if (!fs.existsSync(directory)) return [];
  const runs = [];
  for (const file of fs
    .readdirSync(directory)
    .filter((file) => /^v-[a-f0-9-]+\.json$/.test(file))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (
        record.version !== 2 ||
        record.flow?.id !== flow.id ||
        record.flow?.recordHash !== flow.recordHash
      )
        continue;
      const { hash, ...value } = record;
      if (digest(JSON.stringify(value)) !== hash || file !== `${record.id}.json`)
        throw Error('执行记录指纹无效。');
      for (const kind of ['stdout', 'stderr', 'events']) {
        const suffix = kind === 'events' ? 'events.json' : `${kind}.log`;
        if (
          digest(fs.readFileSync(path.join(directory, `${record.id}.${suffix}`))) !==
          record[`${kind}Hash`]
        )
          throw Error('执行或观测内容缺失、被修改。');
      }
      const events = JSON.parse(
        fs.readFileSync(path.join(directory, `${record.id}.events.json`), 'utf8'),
      );
      if (
        !Array.isArray(events) ||
        events.some((event) => event.runId !== record.id || !Number.isSafeInteger(event.seq))
      )
        throw Error('观测不属于本次运行。');
      runs.push({ record, events });
    } catch (error) {
      runs.push({ invalid: error.message, file });
    }
  }
  return runs;
}
function scenarioEvidence(flow, scenario, run, state) {
  const gaps = [],
    { record, events } = run;
  if (
    !record ||
    record.probeHash !== runtimeFingerprint() ||
    record.snapshotHash !== state.snapshotHash ||
    record.exitCode !== 0 ||
    record.signal ||
    record.timedOut ||
    record.outputExceeded ||
    record.integrity?.length ||
    !record.sourceStable ||
    !record.documentStable ||
    !record.copyVerified ||
    !record.copyStable
  )
    return [{ kind: 'execution', message: '执行失败、快照不一致或运行副本未经核对。' }];
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const entry = nodes.get(scenario.entryNode);
  const traces = [
    ...new Set(
      events
        .filter((event) => event.kind === 'enter' && event.unitId === entry.unitId)
        .map((event) => event.traceId),
    ),
  ];
  for (const traceId of traces) {
    const observed = events.filter((event) => event.traceId === traceId),
      problems = [];
    for (const edgeId of scenario.edges) {
      const edge = flow.edges.find((edge) => edge.id === edgeId),
        from = nodes.get(edge.from),
        to = nodes.get(edge.to);
      if (edge.kind === 'call') {
        if (
          !observed.some(
            (event) =>
              event.kind === 'enter' &&
              event.unitId === to.unitId &&
              event.parentUnitId === from.unitId &&
              (!edge.callId || event.callId === edge.callId),
          )
        )
          problems.push({ edgeId, kind: 'call', message: '本次场景没有观察到对应调用连接。' });
      } else if (edge.kind === 'data') {
        const staticEdges = (state.facts?.edges || []).filter(
          (item) => item.certain && !['argument', 'call-return'].includes(item.kind),
        );
        const runtimeEdges = observed.filter((event) => event.kind === 'binding');
        const spans = new Map(
          observed.filter((event) => event.kind === 'enter').map((event) => [event.spanId, event]),
        );
        const sameFrame =
          from.unitId === to.unitId &&
          reachable(edge.sourceId, edge.targetId, staticEdges) &&
          observed.some(
            (source) =>
              source.factId === edge.sourceId &&
              observed.some(
                (target) => target.factId === edge.targetId && target.spanId === source.spanId,
              ),
          );
        if (
          !sameFrame &&
          !runtimeEdges.some(
            (item) =>
              spans.get(item.sourceSpanId)?.unitId === from.unitId &&
              spans.get(item.targetSpanId)?.unitId === to.unitId &&
              (!edge.callId || edge.callId === item.callId) &&
              reachable(edge.sourceId, item.sourceId, staticEdges) &&
              reachable(item.targetId, edge.targetId, staticEdges),
          )
        )
          problems.push({
            edgeId,
            kind: 'data',
            message: '缺少同一次请求和调用中的真实数据传递，静态名称或值相等不能代替。',
          });
      } else if (
        !observed.some(
          (event) =>
            event.kind === 'boundary' &&
            event.edgeId === edge.id &&
            event.from === from.unitId &&
            event.to === to.unitId,
        )
      )
        problems.push({
          edgeId,
          kind: 'boundary',
          message: '事件、网络或工作流边界尚无对应的工具观测证据。',
        });
    }
    for (const terminalId of scenario.terminalNodes) {
      const terminal = nodes.get(terminalId);
      if (
        !observed.some(
          (event) =>
            event.unitId === terminal.unitId && ['return', 'throw', 'exit'].includes(event.kind),
        )
      )
        problems.push({ nodeId: terminalId, kind: 'terminal', message: '场景终点未被实际执行。' });
    }
    for (const assertion of scenario.assertions) {
      const node = nodes.get(assertion.nodeId);
      const candidates = observed.filter(
        (event) =>
          event.unitId === node.unitId &&
          event.kind === assertion.event &&
          (!assertion.valueId || [event.factId, event.pointId].includes(assertion.valueId)),
      );
      if (
        !candidates.some(
          (event) =>
            assertion.operator === 'exists' ||
            (assertion.operator === 'equals'
              ? event.valueHash === primitiveFingerprint(assertion.expected)
              : event.valueType === assertion.expected),
        )
      )
        problems.push({
          nodeId: node.id,
          kind: 'assertion',
          contradiction: candidates.length > 0,
          message: '实际观测不满足场景结果断言。',
        });
    }
    if (!problems.length) return [];
    if (!gaps.length || problems.length < gaps.length) gaps.splice(0, gaps.length, ...problems);
  }
  return gaps.length
    ? gaps
    : [{ kind: 'execution', message: '命令执行成功，但未观察到此业务入口。' }];
}
export function checkFlowRecord(flow, state, document, session) {
  const gaps = [],
    add = (kind, message, extra = {}) => gaps.push({ flowId: flow.id, kind, message, ...extra });
  if (
    flow.verifierHash !== runtimeFingerprint() ||
    flow.recordHash !== flowDigest(flow) ||
    flow.snapshotHash !== state.snapshotHash
  )
    return {
      id: flow.id,
      title: flow.title,
      featureIds: Object.keys(flow.featureBindings || {}),
      status: 'stale',
      valid: false,
      gaps: [
        { flowId: flow.id, kind: 'stale', message: '流程记录、核验器／探针或源码绑定已过期。' },
      ],
    };
  for (const [featureId, binding] of Object.entries(flow.featureBindings)) {
    const feature = document.features[featureId];
    if (
      !feature ||
      feature.revision !== binding.revision ||
      featureDefinitionHash(feature) !== binding.definitionHash
    )
      add('stale', '步骤定义或版本变化，需要重新绑定与核验。', { featureId });
  }
  const unitMap = new Map(state.units.map((unit) => [unit.id, unit]));
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const mapped = new Set(
    flow.nodes.flatMap((node) => [node.unitId, ...(node.relatedUnitIds || [])]).filter(Boolean),
  );
  for (const unitId of mapped) {
    const unit = unitMap.get(unitId),
      record = state.records[unitId];
    if (
      !unit ||
      !record ||
      !recordValid(state, unit, record) ||
      reviewProblems(unit, record).length
    )
      add('analysis', '此步骤源码尚未完成有效的独立读取与分析。', { unitId });
    for (const point of unit?.reviewPoints.filter((point) =>
      ['conditions', 'sideEffects', 'exceptions'].includes(point.field),
    ) || [])
      if (!flow.nodes.some((node) => node.pointIds?.includes(point.id)))
        add('coverage', '影响业务条件、写入或异常的实际位置尚未关联步骤。', {
          unitId,
          pointId: point.id,
        });
  }
  const start = state.facts.entries.find((entry) => entry.id === flow.entryId);
  if (
    !start ||
    !(
      mapped.has(start.unitId) ||
      (start.contextId && flow.nodes.some((node) => node.contextId === start.contextId))
    )
  )
    add('entry', '流程未关联所声明的实际入口。');
  const visited = new Set(),
    pending = start?.unitId ? [start.unitId] : [];
  for (let index = 0; index < pending.length; index++) {
    const unitId = pending[index];
    if (visited.has(unitId)) continue;
    visited.add(unitId);
    const unit = unitMap.get(unitId);
    if (!unit) continue;
    if (
      !mapped.has(unitId) &&
      unit.reviewPoints.some((point) =>
        ['conditions', 'sideEffects', 'exceptions'].includes(point.field),
      )
    )
      add('coverage', '入口可达的规则、写入或异常处理单元未关联业务步骤。', { unitId });
    for (const call of unit.calls)
      if (call.target && !visited.has(call.target)) pending.push(call.target);
  }
  for (const edge of flow.edges) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    if (edge.kind === 'call') {
      const candidates =
        unitMap
          .get(from.unitId)
          ?.calls.filter((call) =>
            edge.callId ? call.id === edge.callId : call.target === to.unitId,
          ) || [];
      if (!candidates.length)
        add('call', '步骤之间没有对应调用位置，不能仅凭名称连接。', { edgeId: edge.id });
      if (candidates.some((call) => call.target && call.target !== to.unitId))
        add('call', '已解析的实际调用目标与流程不一致。', { edgeId: edge.id, contradiction: true });
      for (const call of candidates)
        for (const [index, argument] of (call.argumentIds || []).entries()) {
          const parameter = unitMap.get(to.unitId)?.parameters[index];
          if (
            argument &&
            parameter &&
            !flow.edges.some(
              (item) =>
                item.kind === 'data' &&
                item.from === from.id &&
                item.to === to.id &&
                reachable(
                  item.sourceId,
                  argument,
                  state.facts.edges.filter(
                    (item) => !['argument', 'call-return'].includes(item.kind),
                  ),
                ) &&
                reachable(
                  parameter,
                  item.targetId,
                  state.facts.edges.filter(
                    (item) => !['argument', 'call-return'].includes(item.kind),
                  ),
                ),
            )
          )
            add('interface', '调用的输入参数没有关联步骤输入输出和数据连接。', {
              edgeId: edge.id,
              valueId: argument,
            });
        }
    }
    if (edge.kind === 'data' && !reachable(edge.sourceId, edge.targetId, state.facts.edges))
      add('data', '静态数据路径尚未确认，需要本次运行提供实际绑定。', {
        edgeId: edge.id,
        requiresRuntime: true,
      });
  }
  for (const node of flow.nodes) {
    const unit = unitMap.get(node.unitId);
    if (!unit) continue;
    for (const call of unit.calls) {
      const target = flow.nodes.find((item) => item.unitId === call.target && item.id !== node.id);
      if (
        target &&
        !flow.edges.some(
          (edge) =>
            edge.kind === 'call' &&
            edge.from === node.id &&
            edge.to === target.id &&
            (!edge.callId || edge.callId === call.id),
        )
      )
        add('coverage', '两个已映射业务步骤之间的实际调用被遗漏。', {
          nodeId: node.id,
          callId: call.id,
        });
    }
    if (
      flow.scenarios.some(
        (scenario) => scenario.kind === 'normal' && scenario.terminalNodes.includes(node.id),
      ) &&
      unit.returns.length &&
      !unit.returns.some((value) => (node.outputs || []).includes(value))
    )
      add('interface', '正常终点缺少真实返回位置的输出声明。', { nodeId: node.id });
    if (
      flow.nodes.length > 1 &&
      !flow.edges.some((edge) => edge.from === node.id || edge.to === node.id)
    )
      add('coverage', '业务步骤与其他步骤断开，没有连接依据。', { nodeId: node.id });
  }
  if (!flow.scenarios.some((scenario) => scenario.kind === 'normal'))
    add('scenario', '缺少正常场景。');
  if (
    [...mapped].some((unitId) =>
      unitMap.get(unitId)?.reviewPoints.some((point) => point.field === 'exceptions'),
    ) &&
    !flow.scenarios.some((scenario) => scenario.kind === 'exception')
  )
    add('scenario', '已发现异常处理，但没有异常场景。');
  const coveredEdges = new Set(flow.scenarios.flatMap((scenario) => scenario.edges));
  for (const edge of flow.edges)
    if (!coveredEdges.has(edge.id))
      add('scenario', '连接没有关联任何实际场景。', { edgeId: edge.id });
  const runs = loadRuns(session, flow),
    scenarios = [];
  let observedCount = 0,
    failed = false;
  for (const scenario of flow.scenarios) {
    const candidates = runs
      .filter((run) => run.record?.flow?.scenarioId === scenario.id)
      .sort((a, b) => b.record.finishedAt.localeCompare(a.record.finishedAt));
    const run = candidates[0];
    const problems = run
      ? scenarioEvidence(flow, scenario, run, state)
      : [{ kind: 'execution', message: '场景尚无绑定当前定义和源码的工具执行记录。' }];
    if (!problems.length) observedCount += 1;
    if (
      run &&
      problems.length &&
      (run.record.exitCode !== 0 || problems.some((problem) => problem.contradiction))
    )
      failed = true;
    for (const problem of problems)
      add(problem.kind, problem.message, { ...problem, scenarioId: scenario.id });
    scenarios.push({
      id: scenario.id,
      kind: scenario.kind,
      valid: !problems.length,
      executionId: run?.record.id,
      gaps: problems,
    });
  }
  for (const run of runs.filter((run) => run.invalid)) add('integrity', run.invalid);
  const latestEvents = scenarios
    .filter((scenario) => scenario.valid)
    .flatMap(
      (scenario) => runs.find((run) => run.record?.id === scenario.executionId)?.events || [],
    );
  for (const unitId of mapped)
    for (const point of unitMap
      .get(unitId)
      ?.reviewPoints.filter((point) =>
        ['conditions', 'sideEffects', 'exceptions'].includes(point.field),
      ) || []) {
      const observed = latestEvents.filter(
        (event) => event.unitId === unitId && event.pointId === point.id,
      );
      if (!observed.length)
        add('branch', '声明场景尚未实际观察到关键分支、写入或异常位置。', {
          unitId,
          pointId: point.id,
        });
      else if (
        point.field === 'conditions' &&
        ['condition', 'short-circuit'].includes(point.kind) &&
        ![true, false].every((decision) => observed.some((event) => event.decision === decision))
      )
        add('branch', '条件的两种结果尚未由实际场景覆盖。', { unitId, pointId: point.id });
    }
  // Runtime bindings may establish a conservative static unknown; actual contradictions remain failures.
  const finalGaps = gaps.filter(
    (gap) => !gap.requiresRuntime || scenarios.some((scenario) => !scenario.valid),
  );
  const status = finalGaps.some((gap) => gap.kind === 'stale')
    ? 'stale'
    : failed || finalGaps.some((gap) => gap.contradiction)
      ? 'failed'
      : !finalGaps.length
        ? 'passed'
        : observedCount
          ? 'partial'
          : 'unverified';
  return {
    id: flow.id,
    title: flow.title,
    featureIds: Object.keys(flow.featureBindings),
    businessSteps: flow.nodes.map(({ featureId, step }) => ({ featureId, step })),
    valid: status === 'passed',
    status,
    scenarios,
    gaps: finalGaps,
    scope: {
      entryId: flow.entryId,
      sourceUnits: mapped.size,
      scenarios: scenarios.length,
      observedScenarios: observedCount,
      edges: flow.edges.length,
    },
  };
}
export function checkFlows(filename, session, { id: flowId } = {}) {
  const { state } = loadSession(session),
    snapshot = readSnapshot(filename);
  let stale;
  try {
    assertFresh(state);
  } catch (error) {
    stale = error.message;
  }
  const allRecords = Object.values(state.flows || {}).filter(
    (flow) => flow.documentPath === fs.realpathSync(filename),
  );
  const records = allRecords.filter((flow) => !flowId || flow.id === flowId);
  if (flowId && !records.length) throw new BlueprintError('NOT_FOUND', '业务流程不存在。');
  const flows = records.map((flow) =>
    stale
      ? {
          id: flow.id,
          title: flow.title,
          status: 'stale',
          valid: false,
          featureIds: Object.keys(flow.featureBindings),
          gaps: [{ kind: 'stale', message: stale }],
        }
      : checkFlowRecord(flow, state, snapshot.document, session),
  );
  const assigned = new Set(allRecords.map((flow) => flow.entryId));
  const pendingEntries = (state.facts?.entries || []).filter(
    (entry) =>
      !assigned.has(entry.id) &&
      state.entryDispositions?.[entry.id]?.snapshotHash !== state.snapshotHash,
  );
  return {
    version: 1,
    valid:
      flows.length > 0 &&
      flows.every((flow) => flow.valid) &&
      (Boolean(flowId) || !pendingEntries.length),
    documentHash: snapshot.documentHash,
    snapshotHash: state.snapshotHash,
    flows,
    pendingEntries,
    gaps: [
      ...flows.flatMap((flow) => flow.gaps),
      ...(flowId
        ? []
        : pendingEntries.map((entry) => ({
            kind: 'entry',
            entryId: entry.id,
            file: entry.file,
            message: '候选入口尚未关联业务流程或给出非业务职责说明。',
          }))),
    ],
  };
}
