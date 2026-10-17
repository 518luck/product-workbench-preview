import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  recordAnalysis,
  traceAnalysis,
} from '../lib/analysis-session.mjs';
import { createFeature } from '../lib/feature-operations.mjs';
import { readSnapshot, applyChanges } from '../lib/document-operations.mjs';
import { renderDocument } from '../lib/document.mjs';
import { runVerification } from '../lib/verification.mjs';
import { saveVerificationPlan, checkVerificationPlans } from '../lib/verification-plan.mjs';
import { summarizeFlows, syncFlowStatus } from '../lib/flow-status.mjs';
import { checkDelivery } from '../lib/delivery.mjs';
import { recordFlows, checkFlows } from '../lib/flow.mjs';

const skip = { decision: 'skipped', reason: '纯角色判断，无跨参与者交互及持久化关系。' };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-layered-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'access.mjs'),
    "export function allowed(role) { return role === 'admin'; }\n",
  );
  fs.writeFileSync(
    path.join(root, 'contract.md'),
    '# 外部角色服务契约\n输入 role 为字符串，返回 allowed 为布尔值。服务由外部团队管理，当前本机没有可访问的实例。\n',
  );
  const feature = createFeature('access', {
    title: '角色访问',
    description: '仅管理员允许访问。',
    checks: ['管理员允许，普通成员拒绝。'],
    rules: ['仅管理员允许访问。'],
    flow: [['检查角色', '返回是否允许访问']],
    stepDetails: [
      {
        actor: '权限模块',
        description: '按传入角色判断',
        rules: ['仅管理员允许访问。'],
        dependencies: [],
        result: '返回布尔值',
        exception: '普通成员拒绝',
        acceptance: '管理员允许，成员拒绝',
        interactions: [],
      },
    ],
  });
  feature.flowRevision = 1;
  const filename = path.join(root, 'product-document.json');
  const document = {
    schemaVersion: 1,
    product: { name: '角色产品', background: '按角色判断访问权限。' },
    features: { access: feature },
    dependencies: [],
    diagrams: {},
  };
  fs.writeFileSync(filename, JSON.stringify(document));
  fs.writeFileSync(path.join(root, 'index.html'), renderDocument(document));
  const { session } = await scanAnalysis(root, { contexts: ['contract.md'] });
  const state = loadSession(session).state,
    unit = state.units[0];
  for (const context of state.contexts) await readAnalysis(session, context.id);
  const receipt = await readAnalysis(session, unit.id);
  const saved = await recordAnalysis(session, {
    records: [
      {
        unitId: unit.id,
        receiptIds: [receipt.receipt.id],
        responsibility: '仅 admin 返回 true，其他角色返回 false。',
        inputs: ['role 是调用方传入角色。'],
        outputs: ['布尔值表示是否允许。'],
        conditions: [],
        calls: [],
        sideEffects: [],
        exceptions: [],
        unknowns: [],
        coverage: unit.reviewPoints.map((p) => ({
          pointId: p.id,
          detail:
            p.field === 'inputs'
              ? 'role 是本次权限判断的输入。'
              : '将角色与 admin 比较，返回比较结果。',
        })),
      },
    ],
  });
  const traces = [];
  function visit(value, target) {
    if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) visit(item, `${target}/${key}`);
    else if (value !== '')
      traces.push({
        id: 't-' + traces.length,
        target,
        value,
        classification: 'observed',
        evidence: [{ kind: 'code', unitId: unit.id, recordHash: saved.records[0].recordHash }],
      });
  }
  for (const field of ['description', 'rules', 'flow', 'stepDetails', 'checks', 'dependencies'])
    visit(feature[field], '/features/access/' + field);
  await traceAnalysis(session, { traces });
  return {
    root,
    filename,
    session,
    unit,
    context: state.contexts.find((c) => c.file === 'contract.md'),
  };
}
function plan(f, level = 'component') {
  return {
    expectedHash: readSnapshot(f.filename).documentHash,
    id: 'access-plan',
    featureId: 'access',
    goal: '管理员允许访问，普通成员明确拒绝。',
    steps: [
      {
        step: 0,
        unitIds: [f.unit.id],
        level,
        scenarioIds: level === 'source' ? [] : ['normal', 'exception'],
      },
    ],
    scenarios:
      level === 'source'
        ? []
        : ['normal', 'exception'].map((kind) => ({
            id: kind,
            kind,
            level,
            steps: [0],
            criteria: [0],
            assertion: kind === 'normal' ? 'admin 返回 true' : 'member 返回 false',
            ...(level === 'contract' ? { contractContextId: f.context.id } : {}),
          })),
  };
}
const command = {
  command: process.execPath,
  args: [
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict'; import { allowed } from './access.mjs'; assert.equal(allowed('admin'),true); assert.equal(allowed('member'),false);",
  ],
};
async function execute(f, side) {
  const runs = [];
  for (const scenarioId of ['normal', 'exception'])
    runs.push(
      await runVerification(f.filename, 'access', f.session, {
        ...command,
        scope: { planId: 'access-plan', scenarioId, ...(side ? { side } : {}) },
      }),
    );
  return runs;
}
async function complete(f, runs) {
  await applyChanges(
    f.filename,
    {
      version: 1,
      expectedHash: readSnapshot(f.filename).documentHash,
      operations: [
        {
          op: 'feature.complete',
          id: 'access',
          revision: 1,
          implementation: {
            revision: 1,
            verifiedAt: new Date().toISOString(),
            checks: runs.map((r) => ({
              name: '角色业务断言',
              result: 'passed',
              executionId: r.executionId,
            })),
          },
        },
      ],
    },
    { analysisSession: f.session, requireVerification: true },
  );
}
function review(f, runs = [], outcome = 'implemented') {
  return {
    version: 4,
    documentHash: readSnapshot(f.filename).documentHash,
    flows: [],
    acknowledgedGaps: [],
    journeys: [
      {
        title: '按角色访问',
        outcome: '返回允许或拒绝',
        evidence: 'access.mjs 中的角色判断',
        steps: [{ featureId: 'access', step: 0 }],
      },
    ],
    features: [
      {
        id: 'access',
        revision: 1,
        outcome,
        content: { rules: { decision: 'included' }, dependencies: skip },
        acceptance: runs.map((r, i) => ({
          criterion: 0,
          scenario: i === 0 ? 'normal' : 'exception',
          steps: [0],
          executionId: r.executionId,
          evidence: '命令真实调用 allowed，assert.equal 核对管理员与普通成员结果。',
        })),
        diagrams: { sequence: skip, dataflow: skip },
      },
    ],
    diagrams: { architecture: skip, entities: skip },
  };
}

test('组件验收可完成并按声明范围交付，不冒充整条链路已观测', async (t) => {
  const f = await fixture(t);
  await saveVerificationPlan(f.filename, f.session, plan(f));
  const runs = await execute(f);
  assert.ok(runs.every((r) => r.valid));
  await complete(f, runs);
  await syncFlowStatus(f.filename, f.session);
  const doc = readSnapshot(f.filename).document;
  assert.equal(doc.features.access.implementedRevision, 1);
  assert.equal(doc.flowVerification.features.access.status, 'partial');
  assert.equal(doc.flowVerification.features.access.coverage.observedSteps.length, 0);
  assert.equal(doc.flowVerification.features.access.verification.steps[0].valid, true);
  const report = await checkDelivery(f.filename, f.session, review(f, runs));
  assert.equal(report.stage, 'ready', JSON.stringify(report.gaps));
  assert.equal(report.valid, true);
  assert.match(report.scope, /验收方案/);
  const legacy = await checkDelivery(f.filename, f.session, { ...review(f, runs), version: 3 });
  assert.equal(legacy.valid, false, '旧严格链路模式没有被放宽');
});

test('方案必须覆盖真实业务步骤；旧执行、假编号、未执行及事后改范围不能通过', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    saveVerificationPlan(f.filename, f.session, { ...plan(f), steps: [] }),
    /全部业务步骤/,
  );
  const wrong = plan(f);
  wrong.steps[0].unitIds = ['unknown-unit'];
  await assert.rejects(saveVerificationPlan(f.filename, f.session, wrong), /尚未完整读取或分析/);
  await runVerification(f.filename, 'access', f.session, command);
  await saveVerificationPlan(f.filename, f.session, plan(f));
  assert.ok(
    checkVerificationPlans(f.filename, f.session).gaps.some((g) => g.kind === 'verification'),
  );
  const before = await checkDelivery(f.filename, f.session, review(f, [], 'unverified'));
  const waived = review(f, [], 'unverified');
  waived.acknowledgedGaps = before.gaps.map((g) => ({
    kind: g.kind,
    path: g.path || '/',
    reason: '暂时还没有做完。',
  }));
  assert.equal((await checkDelivery(f.filename, f.session, waived)).deliverable, false);
  const runs = await execute(f);
  assert.equal(checkVerificationPlans(f.filename, f.session).gaps.length, 0);
  const changed = plan(f);
  changed.goal += '并记录拒绝原因。';
  await saveVerificationPlan(f.filename, f.session, changed);
  assert.ok(
    checkVerificationPlans(f.filename, f.session).gaps.some((g) => g.kind === 'verification'),
  );
  await assert.rejects(complete(f, runs), /验收/);
  await assert.rejects(
    runVerification(f.filename, 'access', f.session, {
      ...command,
      scope: { planId: 'fake', scenarioId: 'normal' },
    }),
    { code: 'ANALYSIS_STALE' },
  );
});

test('契约必须绑定同一份已读取材料，并独立执行调用方和服务方', async (t) => {
  const f = await fixture(t);
  const bad = plan(f, 'contract');
  bad.scenarios[0].contractContextId = 'unknown';
  await assert.rejects(saveVerificationPlan(f.filename, f.session, bad), /契约上下文/);
  await saveVerificationPlan(f.filename, f.session, plan(f, 'contract'));
  await execute(f, 'consumer');
  assert.ok(
    checkVerificationPlans(f.filename, f.session).features.access.scenarios.every((s) => !s.valid),
  );
  await execute(f, 'provider');
  assert.ok(
    checkVerificationPlans(f.filename, f.session).features.access.scenarios.every((s) => s.valid),
  );
  const state = loadSession(f.session).state;
  assert.equal(Object.keys(state.verificationPlans).length, 1, '方案通过增量日志恢复');
  await assert.rejects(
    runVerification(f.filename, 'access', f.session, {
      ...command,
      scope: { planId: 'access-plan', scenarioId: 'normal' },
    }),
    /契约两端/,
  );
});

test('真实外部边界可部分交付，但不伪造任何验收记录，也不能用未完成理由代替证据', async (t) => {
  const f = await fixture(t);
  const reason = '角色服务由外部团队管理，当前没有可访问实例；仅核对源码和契约。';
  const doc = readSnapshot(f.filename).document;
  doc.features.access.notes = reason;
  fs.writeFileSync(f.filename, JSON.stringify(doc));
  fs.writeFileSync(path.join(f.root, 'index.html'), renderDocument(doc));
  const record = Object.values(loadSession(f.session).state.records)[0];
  await traceAnalysis(f.session, {
    traces: [
      {
        id: 'notes',
        target: '/features/access/notes',
        value: reason,
        classification: 'observed',
        evidence: [{ kind: 'code', unitId: f.unit.id, recordHash: record.recordHash }],
      },
    ],
  });
  const scoped = plan(f, 'source');
  scoped.steps[0].limitation = {
    kind: 'external',
    reason,
    evidence: { kind: 'context', id: f.context.id },
  };
  await saveVerificationPlan(f.filename, f.session, scoped);
  await syncFlowStatus(f.filename, f.session);
  const input = review(f, [], 'unverified');
  input.features[0].reason = reason;
  input.features[0].evidence = '已读取 contract.md 中明确的外部服务边界。';
  let report = await checkDelivery(f.filename, f.session, input);
  input.acknowledgedGaps = report.gaps.map((g) => ({
    kind: g.kind,
    path: g.path,
    reason: g.message,
  }));
  report = await checkDelivery(f.filename, f.session, input);
  assert.equal(report.valid, false);
  assert.equal(report.stage, 'partial', JSON.stringify(report.gaps));
  assert.equal(readSnapshot(f.filename).document.features.access.implementation, undefined);
  const fake = plan(f, 'source');
  fake.steps[0].limitation = {
    kind: 'environment',
    reason: '还没做',
    evidence: { kind: 'execution', id: 'v-00000000-0000-0000-0000-000000000000' },
  };
  await assert.rejects(saveVerificationPlan(f.filename, f.session, fake), /真实能力缺口/);
});

test('失败业务测试不能冒充环境限制；端到端不能用普通命令或局部流程替代', async (t) => {
  const f = await fixture(t),
    failed = await runVerification(f.filename, 'access', f.session, {
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    });
  const input = plan(f, 'source');
  input.steps[0].limitation = {
    kind: 'environment',
    reason: '业务测试失败',
    evidence: { kind: 'execution', id: failed.executionId },
  };
  await assert.rejects(saveVerificationPlan(f.filename, f.session, input), /真实能力缺口/);
  const diagnostic = await runVerification(f.filename, 'access', f.session, {
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    purpose: 'environment',
  });
  input.steps[0].limitation.evidence.id = diagnostic.executionId;
  await saveVerificationPlan(f.filename, f.session, input);
  assert.equal(checkVerificationPlans(f.filename, f.session).gaps[0].kind, 'limitation');
  await assert.rejects(
    saveVerificationPlan(f.filename, f.session, plan(f, 'end-to-end')),
    /端到端场景/,
  );
  await assert.rejects(complete(f, [diagnostic]), /验收/);
});

test('功能汇总不会把局部通过或多个断开的微型流程拼成整条已核验', () => {
  const document = {
    features: {
      f: {
        revision: 1,
        flow: [
          ['接收', '输入'],
          ['保存', '输出'],
        ],
      },
    },
  };
  const micro = (step) => ({
    id: 'flow-' + step,
    featureIds: ['f'],
    valid: true,
    status: 'passed',
    businessSteps: [{ featureId: 'f', step }],
    gaps: [],
  });
  let report = summarizeFlows(document, [{ flows: [micro(0)] }]);
  assert.equal(report.features.f.status, 'partial');
  assert.deepEqual(report.features.f.coverage.observedSteps, [0]);
  report = summarizeFlows(document, [{ flows: [micro(0), micro(1)] }]);
  assert.equal(report.features.f.status, 'partial');
  assert.ok(report.features.f.gaps.some((g) => g.message.includes('尚未在同一条')));
  report = summarizeFlows(document, [
    {
      flows: [
        {
          ...micro(0),
          businessSteps: [
            { featureId: 'f', step: 0 },
            { featureId: 'f', step: 1 },
          ],
        },
      ],
    },
  ]);
  assert.equal(report.features.f.status, 'passed');
});

test('端到端方案仍要求真实探针场景；源码变化使分层证据失效', async (t) => {
  const f = await fixture(t);
  await recordFlows(f.filename, f.session, {
    expectedHash: readSnapshot(f.filename).documentHash,
    flows: [
      {
        id: 'access-flow',
        title: '真实角色访问结果',
        entryId: `entry-${f.unit.id}`,
        nodes: [
          {
            id: 'check',
            featureId: 'access',
            step: 0,
            unitId: f.unit.id,
            inputs: f.unit.parameters,
            outputs: f.unit.returns,
          },
        ],
        edges: [],
        scenarios: ['normal', 'exception'].map((kind) => ({
          id: kind,
          title: kind === 'normal' ? '管理员允许' : '普通成员拒绝',
          kind,
          entryNode: 'check',
          terminalNodes: ['check'],
          edges: [],
          assertions: [
            { nodeId: 'check', event: 'return', operator: 'equals', expected: kind === 'normal' },
          ],
        })),
      },
    ],
  });
  const input = plan(f, 'end-to-end');
  input.scenarios.forEach((s) => {
    s.flowId = 'access-flow';
  });
  await saveVerificationPlan(f.filename, f.session, input);
  await assert.rejects(execute(f), /必须使用绑定的流程探针/);
  for (const scenarioId of ['normal', 'exception'])
    await runVerification(f.filename, 'access', f.session, {
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import {allowed} from './access.mjs';allowed('${scenarioId === 'normal' ? 'admin' : 'member'}');`,
      ],
      scope: { planId: 'access-plan', scenarioId },
      flow: { id: 'access-flow', scenarioId },
    });
  assert.equal(checkVerificationPlans(f.filename, f.session).gaps.length, 0);
  assert.equal(checkFlows(f.filename, f.session).valid, true);
  await syncFlowStatus(f.filename, f.session);
  assert.equal(readSnapshot(f.filename).document.flowVerification.features.access.status, 'passed');
  fs.appendFileSync(path.join(f.root, 'access.mjs'), '// changed');
  assert.ok(checkVerificationPlans(f.filename, f.session).gaps.some((g) => g.kind === 'stale'));
  await assert.rejects(execute(f), { code: 'ANALYSIS_STALE' });
});

test('验收方案 CLI 可保存、查询，Schema 可独立读取', async (t) => {
  const f = await fixture(t),
    cli = new URL('../bin/product-blueprint.mjs', import.meta.url).pathname;
  const args = [cli, 'verification', 'plan', f.filename, '--analysis-session', f.session, '--json'];
  const result = spawnSync(process.execPath, [...args, '--input', '-'], {
    input: JSON.stringify(plan(f)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).plan.featureId, 'access');
  const query = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(JSON.parse(query.stdout).plans.length, 1);
  const schema = spawnSync(process.execPath, [cli, 'schema', '--verification-plan'], {
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(schema.stdout).required.includes('steps'), true);
});
