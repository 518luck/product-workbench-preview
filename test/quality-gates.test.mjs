import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  recordAnalysis,
  traceAnalysis,
  checkAnalysis,
} from '../lib/analysis-session.mjs';
import { createFeature } from '../lib/feature-operations.mjs';
import { readSnapshot } from '../lib/document-operations.mjs';
import { assessImplementation, assessmentTargets } from '../lib/implementation-assessment.mjs';
import { saveVerificationPlan, checkVerificationPlans } from '../lib/verification-plan.mjs';
import { runVerification } from '../lib/verification.mjs';
import { checkDelivery } from '../lib/delivery.mjs';
import { syncFlowStatus } from '../lib/flow-status.mjs';

// These are independently specified tiny businesses, not names required by the CLI.
const commerce = [
  {
    id: 'purchase-eligibility',
    fn: 'canBuy',
    arg: 'stock',
    expression: 'stock>0',
    title: '商品可购买性',
    meaning: '可售库存大于零时允许购买，库存为零时拒绝购买。',
    inputMeaning: 'stock 是当前商品可售库存。',
    detail: 'canBuy 将 stock 与零作大于比较，只返回购买资格布尔值，不扣减库存。',
    yes: 3,
    no: 0,
  },
];
const booking = [
  {
    id: 'reserve-capacity',
    fn: 'reserve',
    arg: 'seats',
    expression: 'seats>0',
    title: '预约名额判断',
    meaning: '剩余名额大于零时允许预约，没有名额时拒绝预约。',
    inputMeaning: 'seats 是本次预约检查时剩余名额。',
    detail: 'reserve 将 seats 与零作大于比较，返回是否有预约名额，不创建预约记录。',
    yes: 2,
    no: 0,
  },
  {
    id: 'cancel-reservation',
    fn: 'cancel',
    arg: 'state',
    expression: "state==='booked'",
    title: '取消资格判断',
    meaning: '只有 booked 状态允许取消，已经 cancelled 的预约拒绝再次取消。',
    inputMeaning: 'state 是预约当前状态。',
    detail: 'cancel 严格比较 state 与 booked，返回取消资格，不修改预约状态。',
    yes: 'booked',
    no: 'cancelled',
  },
];
async function fixture(t, specs = commerce, narrowed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-quality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'business.mjs'),
    specs.map((s) => `export function ${s.fn}(${s.arg}){return ${s.expression};}`).join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'metadata.mjs'),
    "const packagePath = new URL('./package.json', import.meta.url);\n",
  );
  const features = Object.fromEntries(
    specs.map((s) => {
      const f = createFeature(s.id, {
        title: s.title,
        description: s.meaning,
        rules: [s.meaning],
        checks: [s.meaning],
        flow: [[s.title, s.meaning]],
        stepDetails: [
          {
            actor: '业务调用方',
            description: s.meaning,
            result: '返回资格布尔值',
            exception: s.meaning,
            rules: [s.meaning],
            dependencies: [],
            acceptance: s.meaning,
            interactions: [],
          },
        ],
      });
      f.flowRevision = 1;
      return [s.id, f];
    }),
  );
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      product: {
        name: specs === commerce ? '电商资格服务' : '预约资格服务',
        background: '按实际业务资格判断是否允许操作。',
      },
      features,
      dependencies: [],
      diagrams: {},
    }),
  );
  const { session, scopeCoverage } = await scanAnalysis(
      root,
      narrowed ? { include: ['business.mjs'] } : {},
    ),
    state = loadSession(session).state;
  for (const unit of state.units) {
    const spec = specs.find((s) => s.fn === unit.name),
      read = await readAnalysis(session, unit.id),
      meaning = spec?.meaning || '将包清单相对路径与当前模块位置组合成绝对 URL，不读取包内容。';
    await recordAnalysis(session, {
      records: [
        {
          unitId: unit.id,
          receiptIds: [read.receipt.id],
          responsibility: meaning,
          inputs: spec ? [spec.inputMeaning] : [],
          outputs: spec ? [meaning] : [],
          conditions: [],
          calls: spec ? spec.calls || [] : [meaning],
          sideEffects: [],
          exceptions: [],
          unknowns: spec ? [] : ['URL 构造器由宿主运行时提供。'],
          coverage: unit.reviewPoints.map((p) => ({
            pointId: p.id,
            detail: spec && p.field === 'inputs' ? spec.inputMeaning : meaning,
          })),
        },
      ],
    });
  }
  const units = Object.fromEntries(
    specs.map((s) => [s.id, state.units.find((u) => u.name === s.fn)]),
  );
  const input = (spec) => ({
    expectedHash: readSnapshot(filename).documentHash,
    revision: 1,
    items: assessmentTargets(readSnapshot(filename).document.features[spec.id]).map((target) => ({
      target,
      state: 'implemented',
      detail: spec.detail,
      basis: [
        {
          kind: 'code',
          unitId: units[spec.id].id,
          pointIds: units[spec.id].reviewPoints
            .filter((p) => p.field === 'outputs')
            .map((p) => p.id),
          detail: spec.detail,
        },
      ],
    })),
  });
  return { root, filename, session, state, specs, units, input, scopeCoverage };
}
const plan = (f, spec) => ({
  expectedHash: readSnapshot(f.filename).documentHash,
  id: `plan-${spec.id}`,
  featureId: spec.id,
  goal: spec.meaning,
  steps: [
    {
      step: 0,
      level: 'component',
      unitIds: [f.units[spec.id].id],
      scenarioIds: ['normal', 'exception'],
    },
  ],
  scenarios: ['normal', 'exception'].map((kind) => ({
    id: kind,
    kind,
    level: 'component',
    steps: [0],
    criteria: [0],
    assertion: spec.meaning,
    observations: [
      {
        unitId: f.units[spec.id].id,
        event: 'return',
        step: 0,
        criterion: 0,
        operator: 'equals',
        expected: kind === 'normal',
      },
    ],
  })),
});
const command = (f, spec, kind, body) => ({
  command: process.execPath,
  args: [
    '--input-type=module',
    '-e',
    body ??
      `import {${spec.fn}} from './business.mjs';${spec.fn}(${JSON.stringify(kind === 'normal' ? spec.yes : spec.no)});`,
  ],
  scope: { planId: `plan-${spec.id}`, scenarioId: kind },
});
const skip = {
  decision: 'skipped',
  reason: '隔离样例只进行单个内存资格判断，输入输出已在该步骤中说明。',
};
async function deliver(f) {
  const runs = {};
  for (const spec of f.specs) {
    await assessImplementation(f.filename, spec.id, f.session, f.input(spec));
    await saveVerificationPlan(f.filename, f.session, plan(f, spec));
    runs[spec.id] = [];
    for (const kind of ['normal', 'exception']) {
      const r = await runVerification(f.filename, spec.id, f.session, command(f, spec, kind));
      assert.equal(r.valid, true, JSON.stringify(r));
      runs[spec.id].push(r);
    }
  }
  const traces = [];
  const state = loadSession(f.session).state;
  for (const spec of f.specs) {
    const feature = readSnapshot(f.filename).document.features[spec.id],
      unit = f.units[spec.id];
    const visit = (value, target) => {
      if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) visit(v, `${target}/${k}`);
      else if (value !== '')
        traces.push({
          id: `t-${traces.length}`,
          target,
          value,
          classification: 'observed',
          evidence: [
            { kind: 'code', unitId: unit.id, recordHash: state.records[unit.id].recordHash },
          ],
        });
    };
    for (const field of ['description', 'rules', 'checks', 'flow', 'stepDetails', 'dependencies'])
      visit(feature[field], `/features/${spec.id}/${field}`);
  }
  await traceAnalysis(f.session, { traces });
  await syncFlowStatus(f.filename, f.session);
  const review = {
    version: 4,
    documentHash: readSnapshot(f.filename).documentHash,
    flows: [],
    acknowledgedGaps: [],
    journeys: f.specs.map((s) => ({
      title: s.title,
      outcome: s.meaning,
      evidence: 'business.mjs 的资格判断',
      steps: [{ featureId: s.id, step: 0 }],
    })),
    features: f.specs.map((s) => ({
      id: s.id,
      revision: 1,
      outcome: 'implemented',
      content: { rules: { decision: 'included' }, dependencies: skip },
      diagrams: { sequence: skip, dataflow: skip },
      acceptance: runs[s.id].map((r, i) => ({
        criterion: 0,
        scenario: i ? 'exception' : 'normal',
        steps: [0],
        executionId: r.executionId,
        evidence: s.meaning,
      })),
    })),
    diagrams: { architecture: skip, entities: skip },
  };
  return { review, report: await checkDelivery(f.filename, f.session, review) };
}
for (const specs of [commerce, booking])
  test(`${specs === commerce ? '电商一项' : '预约两项'}实际业务可独立交付，功能名称和数量不绑定蓝图工具`, async (t) => {
    const f = await fixture(t, specs),
      { report } = await deliver(f);
    assert.equal(report.stage, 'ready', JSON.stringify(report.gaps));
    assert.equal(report.valid, true);
    assert.equal(Object.keys(readSnapshot(f.filename).document.features).length, specs.length);
  });

test('源码过滤必须显露完整根目录的遗漏，写一段理由不能冒充完整分析', async (t) => {
  const f = await fixture(t, commerce, true);
  assert.equal(f.scopeCoverage.full, false);
  assert.deepEqual(
    f.scopeCoverage.omitted.map((x) => x.file),
    ['metadata.mjs'],
  );
  assert.equal(checkAnalysis(f.session).valid, true, '声明范围的读取仍可合格，范围完整性另算');
  const { review, report } = await deliver(f);
  assert.equal(report.deliverable, false);
  assert.ok(report.gaps.some((g) => g.kind === 'scope'));
  review.acknowledgedGaps = report.gaps
    .filter((g) => g.kind === 'scope')
    .map((g) => ({
      kind: 'scope',
      path: g.path,
      reason: '只完成业务文件，不声称整个项目已分析。',
    }));
  assert.equal(
    (await checkDelivery(f.filename, f.session, review)).deliverable,
    false,
    'AI 自己写理由不能抹掉范围差异',
  );
  review.scope = {
    reason: '用户明确只要求业务文件。',
    authorization: { source: 'user', text: '请只分析 business.mjs。' },
  };
  const limited = await checkDelivery(f.filename, f.session, review);
  assert.equal(limited.stage, 'partial', JSON.stringify(limited.gaps));
  assert.equal(limited.valid, false);
});

test('新措辞包裹源码依然不能充当分析，坏批次保留原记录', async (t) => {
  const f = await fixture(t),
    unit = f.units[commerce[0].id],
    before = loadSession(f.session).state.records[unit.id],
    read = await readAnalysis(f.session, unit.id);
  const copy = () => ({
    ...Object.fromEntries(
      [
        'unitId',
        'responsibility',
        'inputs',
        'outputs',
        'conditions',
        'calls',
        'sideEffects',
        'exceptions',
        'unknowns',
        'coverage',
      ].map((k) => [k, structuredClone(before[k])]),
    ),
    receiptIds: [read.receipt.id],
  });
  for (const mutate of [
    (r) => (r.responsibility = `位于 ${unit.file} 的 ${unit.name}，负责 product 计算与状态处理。`),
    (r) => {
      r.coverage[0].detail = `接收参数声明 ${unit.reviewPoints[0].code} 作为函数处理的输入。`;
    },
    (r) => {
      r.coverage[1].detail = `向调用者返回表达式 ${unit.reviewPoints[1].code} 的求值结果。`;
    },
  ]) {
    const r = copy();
    for (const k of ['snapshotHash', 'contentHash', 'recordHash', 'recordedAt']) delete r[k];
    mutate(r);
    await assert.rejects(recordAnalysis(f.session, { records: [r] }), {
      code: 'ANALYSIS_INCOMPLETE',
    });
    assert.equal(loadSession(f.session).state.records[unit.id].recordHash, before.recordHash);
  }
});

test('完整读取的路径常量和参数声明不能证明功能实现；真实行为位置可以', async (t) => {
  const f = await fixture(t),
    spec = commerce[0],
    meta = f.state.units.find((u) => u.file === 'metadata.mjs');
  const bad = f.input(spec);
  const malformed = f.input(spec);
  malformed.items[0].basis[0].pointIds = { unexpected: true };
  await assert.rejects(assessImplementation(f.filename, spec.id, f.session, malformed), {
    code: 'INVALID_ARGUMENT',
  });
  bad.items[0].basis = [
    {
      kind: 'code',
      unitId: meta.id,
      pointIds: meta.reviewPoints.map((p) => p.id),
      detail: spec.meaning,
    },
  ];
  await assert.rejects(assessImplementation(f.filename, spec.id, f.session, bad), /常量|路径/);
  const parameter = f.input(spec);
  parameter.items[0].basis[0].pointIds = [
    f.units[spec.id].reviewPoints.find((p) => p.field === 'inputs').id,
  ];
  await assert.rejects(assessImplementation(f.filename, spec.id, f.session, parameter), /参数声明/);
  const generic = f.input(spec);
  generic.items[0].detail = `在源码中完整实现了 ${spec.meaning} 的核心能力与业务边界。`;
  await assert.rejects(assessImplementation(f.filename, spec.id, f.session, generic), /只重复/);
  assert.equal(
    (await assessImplementation(f.filename, spec.id, f.session, f.input(spec))).status,
    'complete',
  );
});

test('成功日志、自证完成和未执行目标都不能支持组件验收；实际结果错误即使退出零也不行', async (t) => {
  const f = await fixture(t),
    spec = commerce[0];
  await assessImplementation(f.filename, spec.id, f.session, f.input(spec));
  const noObservation = plan(f, spec);
  delete noObservation.scenarios[0].observations;
  await assert.rejects(saveVerificationPlan(f.filename, f.session, noObservation), /观测/);
  await saveVerificationPlan(f.filename, f.session, plan(f, spec));
  await assert.rejects(
    runVerification(f.filename, spec.id, f.session, {
      ...command(f, spec, 'normal'),
      purpose: 'pretend',
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  const cyclic = `import fs from 'node:fs';const d=JSON.parse(fs.readFileSync('product-document.json'));if(d.features[${JSON.stringify(spec.id)}].implementationAssessment.items[0].state!=='implemented')process.exit(2);`;
  for (const body of [
    "console.log('passed')",
    "console.log(JSON.stringify({kind:'return',value:true}))",
    cyclic,
    `import {canBuy} from './business.mjs';canBuy(0);`,
  ]) {
    const run = await runVerification(
      f.filename,
      spec.id,
      f.session,
      command(f, spec, 'normal', body),
    );
    assert.equal(run.exitCode, 0);
    assert.equal(run.valid, false, body);
    assert.equal(run.observation.valid, false);
  }
  const actual = await runVerification(f.filename, spec.id, f.session, command(f, spec, 'normal'));
  assert.equal(actual.valid, true);
  const events = actual.record.replace(/\.json$/, '.events.json');
  fs.writeFileSync(events, '[]');
  assert.ok(
    checkVerificationPlans(f.filename, f.session).gaps.some((g) => g.kind === 'verification'),
  );
});

test('工作流产品可引用已读指令原文，伪造引文与只有编号的依据不能通过', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-workflow-basis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const quote = '先核对预约剩余名额，再向申请人确认可预约时间；未确认的申请保持待处理。';
  fs.writeFileSync(
    path.join(root, 'SKILL.md'),
    '---\nname: reservation-review\ndescription: 指导预约申请审核。\n---\n\n' + quote + '\n',
  );
  const f = createFeature('review-reservation', {
    title: '预约申请审核',
    description: '指导工作人员核对名额并确认预约时间。',
    checks: ['核对名额后确认预约时间，确认前保持待处理。'],
    flow: [['确认预约', '核对名额后与申请人确认时间']],
    stepDetails: [
      {
        actor: '工作人员',
        description: '',
        rules: [],
        dependencies: [],
        result: '时间得到确认',
        exception: '',
        acceptance: '确认前保持待处理',
        interactions: [],
      },
    ],
  });
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      product: { name: '预约审核工作流', background: '以工作流指令帮助工作人员审核预约申请。' },
      features: { [f.id]: f },
      dependencies: [],
    }),
  );
  const { session } = await scanAnalysis(root),
    context = loadSession(session).state.contexts[0];
  const make = () => ({
    expectedHash: readSnapshot(filename).documentHash,
    revision: 1,
    items: assessmentTargets(f).map((target) => ({
      target,
      state: 'implemented',
      detail: '指令要求工作人员先核对名额，再向申请人确认时间；确认前申请保持待处理。',
      basis: [
        {
          kind: 'context',
          contextId: context.id,
          quote,
          detail: '原文明确先核对名额再确认时间，并要求未确认的申请继续等待。',
        },
      ],
    })),
  });
  await assert.rejects(assessImplementation(filename, f.id, session, make()), /尚未完整读取/);
  await readAnalysis(session, context.id);
  const fake = make();
  fake.items[0].basis[0].quote = '系统自动退款并发放优惠券，不需要工作人员确认。';
  await assert.rejects(assessImplementation(filename, f.id, session, fake), /原文/);
  const numbered = make();
  delete numbered.items[0].basis;
  numbered.items[0].contextIds = [context.id];
  await assert.rejects(assessImplementation(filename, f.id, session, numbered), /basis/);
  const good = await assessImplementation(filename, f.id, session, make());
  assert.equal(good.status, 'complete');
  assert.equal(readSnapshot(filename).document.features[f.id].implementation, undefined);
  const capability = {
    kind: 'adapter',
    reason: '工具尚不采集外部工作流宿主的执行事件。',
    evidence: { kind: 'capability', name: 'workflow-host-observation', id: context.id },
  };
  await saveVerificationPlan(filename, session, {
    id: 'workflow-plan',
    featureId: f.id,
    expectedHash: readSnapshot(filename).documentHash,
    goal: f.description,
    steps: [
      {
        step: 0,
        level: 'source',
        contextIds: [context.id],
        scenarioIds: [],
        limitation: capability,
      },
    ],
    scenarios: [],
  });
  const traces = [];
  const visit = (value, target) => {
    if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) visit(v, `${target}/${k}`);
    else if (value !== '')
      traces.push({
        id: `t-${traces.length}`,
        target,
        value,
        classification: 'observed',
        evidence: [{ kind: 'context', contextId: context.id, quote }],
      });
  };
  const current = readSnapshot(filename).document.features[f.id];
  for (const field of ['description', 'rules', 'checks', 'flow', 'stepDetails', 'dependencies'])
    visit(current[field], `/features/${f.id}/${field}`);
  await traceAnalysis(session, { traces });
  await syncFlowStatus(filename, session);
  const report = await checkDelivery(filename, session, {
    version: 4,
    documentHash: readSnapshot(filename).documentHash,
    journeys: [
      {
        title: f.title,
        outcome: '时间得到确认',
        evidence: 'SKILL.md 的审核指令',
        steps: [{ featureId: f.id, step: 0 }],
      },
    ],
    flows: [],
    acknowledgedGaps: [
      { kind: 'limitation', path: `/features/${f.id}/flow/0`, reason: capability.reason },
    ],
    features: [
      {
        id: f.id,
        revision: 1,
        outcome: 'implemented',
        content: { rules: skip, dependencies: skip },
        diagrams: { sequence: skip, dataflow: skip },
        acceptance: [],
      },
    ],
    diagrams: { architecture: skip, entities: skip },
  });
  assert.equal(report.stage, 'partial', JSON.stringify(report.gaps));
  assert.equal(report.valid, false);
});

test('实现说明与依据不能只套用函数位置和“维护一致性”，失败不改写当前文档', async (t) => {
  const f = await fixture(t),
    spec = f.specs[0],
    before = fs.readFileSync(f.filename, 'utf8');
  const generated = f.input(spec);
  for (const item of generated.items) {
    item.detail = '在 business.mjs 的 canBuy 中已实现对应逻辑与约束';
    item.basis[0].detail = '在该模块核心业务逻辑中调度底层接口以推进流程执行并维护状态一致性';
  }
  await assert.rejects(assessImplementation(f.filename, spec.id, f.session, generated));
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  const onlyLabel = f.input(spec);
  for (const item of onlyLabel.items)
    item.detail = '在 business.mjs 的 canBuy 中已实现对应逻辑与约束';
  await assert.rejects(assessImplementation(f.filename, spec.id, f.session, onlyLabel));
  assert.equal(
    (await assessImplementation(f.filename, spec.id, f.session, f.input(spec))).status,
    'complete',
  );
});

test('类型检查、泛化异常、重复结果及额外挂入函数不能覆盖业务步骤和条件', async (t) => {
  const f = await fixture(t),
    spec = f.specs[0];
  for (const change of [
    (o) => {
      o.operator = 'type';
      o.expected = 'object';
    },
    (o) => {
      o.event = 'throw';
      o.operator = 'error-name';
      o.expected = 'Error';
    },
    (o) => {
      delete o.step;
    },
    (o) => {
      delete o.criterion;
    },
  ]) {
    const input = plan(f, spec);
    change(input.scenarios[0].observations[0]);
    await assert.rejects(saveVerificationPlan(f.filename, f.session, input), {
      code: 'INVALID_ARGUMENT',
    });
  }
  const overclaim = plan(f, spec);
  overclaim.steps[0].unitIds.push(f.state.units.find((u) => u.file === 'metadata.mjs').id);
  await assert.rejects(saveVerificationPlan(f.filename, f.session, overclaim), {
    code: 'INVALID_ARGUMENT',
  });
  const doc = readSnapshot(f.filename).document,
    feature = doc.features[spec.id];
  feature.flow.push(['扣减库存', '扣减后保存剩余库存']);
  feature.stepDetails.push({ ...feature.stepDetails[0], description: '扣减后保存库存。' });
  feature.checks.push('扣减后保存库存。');
  fs.writeFileSync(f.filename, JSON.stringify(doc));
  const duplicated = plan(f, spec);
  duplicated.steps.push({ ...duplicated.steps[0], step: 1 });
  for (const scenario of duplicated.scenarios) {
    scenario.steps = [0, 1];
    scenario.criteria = [0, 1];
    scenario.observations.push({ ...scenario.observations[0], step: 1, criterion: 1 });
  }
  await assert.rejects(saveVerificationPlan(f.filename, f.session, duplicated), {
    code: 'INVALID_ARGUMENT',
  });
});

test('验收步骤与已保存实现依据需对应，不能拿资格函数验证另一项数据来源', async (t) => {
  const f = await fixture(t, booking),
    spec = f.specs[0];
  await assessImplementation(f.filename, spec.id, f.session, f.input(spec));
  const wrong = plan(f, spec),
    other = f.units[f.specs[1].id].id;
  wrong.steps[0].unitIds = [other];
  for (const scenario of wrong.scenarios) scenario.observations[0].unitId = other;
  await assert.rejects(saveVerificationPlan(f.filename, f.session, wrong), {
    code: 'INVALID_ARGUMENT',
  });
  await saveVerificationPlan(f.filename, f.session, plan(f, spec));
  const good = await runVerification(f.filename, spec.id, f.session, command(f, spec, 'normal'));
  assert.equal(good.valid, true);
  const changed = f.input(spec);
  const otherUnit = f.units[f.specs[1].id];
  const stepItem = changed.items.find((i) => i.target === '/flow/0');
  stepItem.detail = '严格比较预约状态与 booked，返回取消资格。';
  stepItem.basis = [
    {
      kind: 'code',
      unitId: otherUnit.id,
      pointIds: otherUnit.reviewPoints.filter((p) => p.field === 'outputs').map((p) => p.id),
      detail: '仅 booked 状态返回允许取消。',
    },
  ];
  await assessImplementation(f.filename, spec.id, f.session, changed);
  await assert.rejects(
    runVerification(f.filename, spec.id, f.session, command(f, spec, 'normal')),
    { code: 'ANALYSIS_STALE' },
  );
  const outdated = checkVerificationPlans(f.filename, f.session);
  assert.ok(outdated.gaps.some((g) => g.kind === 'stale'));
});

test('异步返回的具体数据字段由探针核对，错误值、缺失字段和 getter 都不能通过', async (t) => {
  const spec = {
    ...commerce[0],
    fn: 'receipt',
    arg: 'amount',
    expression: 'Promise.resolve({state:"saved",total:amount})',
    meaning: '生成回执，state 固定为 saved，total 保留传入金额；不执行持久化。',
    inputMeaning: 'amount 是回执金额。',
    calls: ['Promise.resolve 返回包含回执的已解决承诺。'],
  };
  const f = await fixture(t, [spec]);
  const input = plan(f, spec);
  for (const scenario of input.scenarios)
    scenario.observations = [
      {
        unitId: f.units[spec.id].id,
        step: 0,
        criterion: 0,
        event: 'return',
        operator: 'equals',
        path: '/total',
        expected: 3,
      },
      {
        unitId: f.units[spec.id].id,
        step: 0,
        criterion: 0,
        event: 'return',
        operator: 'equals',
        path: '/state',
        expected: 'saved',
      },
    ];
  await saveVerificationPlan(f.filename, f.session, input);
  const run = (body) =>
    runVerification(f.filename, spec.id, f.session, command(f, spec, 'normal', body));
  const good = await run("import {receipt} from './business.mjs';await receipt(3);");
  assert.equal(good.valid, true, JSON.stringify(good));
  const wrong = await run("import {receipt} from './business.mjs';await receipt(4);");
  assert.equal(wrong.exitCode, 0);
  assert.equal(wrong.valid, false);
  for (const scenario of input.scenarios) scenario.observations[0].path = '/missing';
  await saveVerificationPlan(f.filename, f.session, {
    ...input,
    expectedHash: readSnapshot(f.filename).documentHash,
  });
  assert.equal(
    (await run("import {receipt} from './business.mjs';await receipt(3);")).valid,
    false,
  );
  const echo = {
    ...spec,
    fn: 'inspectReceipt',
    expression: 'amount',
    calls: [],
    meaning: '直接返回传入的回执对象，不访问其字段。',
  };
  const g = await fixture(t, [echo]),
    getterPlan = plan(g, echo);
  for (const scenario of getterPlan.scenarios)
    scenario.observations = [
      {
        unitId: g.units[echo.id].id,
        step: 0,
        criterion: 0,
        event: 'return',
        operator: 'equals',
        path: '/total',
        expected: 3,
      },
    ];
  await saveVerificationPlan(g.filename, g.session, getterPlan);
  const getterRun = await runVerification(
    g.filename,
    echo.id,
    g.session,
    command(
      g,
      echo,
      'normal',
      "import {inspectReceipt} from './business.mjs';const value=Object.defineProperty({},'total',{get(){throw new Error('getter executed');}});inspectReceipt(value);",
    ),
  );
  assert.equal(getterRun.exitCode, 0, '探针不能调用 getter');
  assert.equal(getterRun.valid, false, '无自有数据值时不能当作已观察');
  const proxyRun = await runVerification(
    g.filename,
    echo.id,
    g.session,
    command(
      g,
      echo,
      'normal',
      "import {inspectReceipt} from './business.mjs';inspectReceipt(new Proxy({total:3},{getOwnPropertyDescriptor(){throw new Error('proxy trap executed');}}));",
    ),
  );
  assert.equal(proxyRun.exitCode, 0, 'Node 探针不触发 Proxy 属性陷阱');
  assert.equal(proxyRun.valid, false);
  // The hashing reader must not execute an object's user-defined getters.
  const { observationProblems } = await import('../lib/component-observation.mjs');
  const foreign = { ...f.state, units: f.state.units.map((u) => ({ ...u, language: 'python' })) };
  assert.ok(observationProblems(input, input.scenarios[0], foreign).length);
});

test('普通验收也在临时副本运行，新增杂项不落原项目，修改副本业务源码则失效', async (t) => {
  const f = await fixture(t),
    spec = f.specs[0];
  const original = fs.readFileSync(path.join(f.root, 'business.mjs'), 'utf8');
  const run = (body) =>
    runVerification(f.filename, spec.id, f.session, {
      command: process.execPath,
      args: ['-e', body],
    });
  const good = await run(
    "require('node:fs').writeFileSync('test-doc.json','{}');require('node:fs').mkdirSync('.test-s');",
  );
  assert.equal(good.valid, true);
  assert.equal(good.isolated, true);
  assert.equal(fs.existsSync(path.join(f.root, 'test-doc.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.test-s')), false);
  const record = JSON.parse(fs.readFileSync(good.record, 'utf8'));
  assert.equal(fs.existsSync(record.cwd), false, '临时副本在结束时清理');
  const changed = await run(
    "require('node:fs').writeFileSync('business.mjs','export function canBuy(){return true;}');",
  );
  assert.equal(changed.exitCode, 0);
  assert.equal(changed.copyStable, false);
  assert.equal(changed.valid, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'business.mjs'), 'utf8'), original);
});

test('真实交付门禁报告新散落文件，不能靠填写已知缺口变成部分交付', async (t) => {
  const f = await fixture(t),
    { review, report } = await deliver(f);
  assert.equal(report.valid, true, JSON.stringify(report.gaps));
  fs.writeFileSync(path.join(f.root, 'test-doc.json'), '{}');
  const bad = await checkDelivery(f.filename, f.session, review);
  assert.equal(bad.valid, false);
  assert.equal(bad.deliverable, false);
  assert.ok(bad.gaps.some((g) => g.kind === 'artifact' && g.path === 'test-doc.json'));
  fs.rmSync(path.join(f.root, 'test-doc.json'));
  const work = path.join(f.root, '.blueprint-analysis/work/task');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'batch.json'), '{}');
  assert.equal((await checkDelivery(f.filename, f.session, review)).valid, true);
});

test('跨记录识别仅替换函数名的未知模板，真实同义小包装函数可共享说明', async (t) => {
  const repeated = [0, 1, 2, 3].map((i) => ({
    ...commerce[0],
    id: `adjust-${i}`,
    fn: `adjust${i}`,
    arg: 'value',
    expression: `value+${i + 1}`,
    meaning: `此例程经由 adjust${i} 完成此处的处理事项。`,
    inputMeaning: 'value 是待调整的数量。',
  }));
  await assert.rejects(fixture(t, repeated), { code: 'ANALYSIS_INCOMPLETE' });
  const wrappers = repeated.map((s) => ({
    ...s,
    expression: 'value+1',
    meaning: '将传入的商品数量加一，返回递增后的数量。',
  }));
  const f = await fixture(t, wrappers);
  assert.equal(checkAnalysis(f.session).valid, true);
  const explanations = [
    'Add one unit to the incoming inventory count.',
    'Apply a two-unit correction to the count.',
    'Increase the shipment quantity by three.',
    'Return the input count with an extra four units.',
  ];
  const english = await fixture(
    t,
    repeated.map((s, i) => ({
      ...s,
      meaning: explanations[i],
      inputMeaning: 'value is the incoming item count.',
    })),
  );
  assert.equal(
    checkAnalysis(english.session).valid,
    true,
    '不同的英文业务解释不能被归为同一个空模板',
  );
});
