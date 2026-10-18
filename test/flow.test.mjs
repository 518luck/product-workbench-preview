import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  recordAnalysis,
  updateSession,
} from '../lib/analysis-session.mjs';
import { recordFlows, checkFlows } from '../lib/flow.mjs';
import { readSnapshot } from '../lib/document-operations.mjs';
import { runVerification } from '../lib/verification.mjs';
import { syncFlowStatus, readFlowStatus } from '../lib/flow-status.mjs';
import { updateDocument } from '../lib/document-store.mjs';
import { recordBusinessModel, checkBusinessModel } from '../lib/business-model.mjs';

// Independently specified meanings for these deliberately small flow fixtures.
const pointMeanings = {
  value: 'value 是当前调用传入的文本；后续是否仍使用它需检查实际绑定。',
  'returnvalue.trim()': '返回去除首尾空格后的文本，原字符串不变。',
  'value.trim()': '调用字符串 trim，产生去除首尾空格后的新文本。',
  'returnnormalize(value)': '将当前 value 交给 normalize，并把其返回值作为提交结果。',
  'normalize(value)': '当前 value 作为规范化步骤的实参，不是另造一个同值常量。',
  'returnnormalize(value).trim()': '先规范化当前 value，再去除结果首尾空格并返回。',
  'normalize(value).trim()': 'trim 接收规范化调用的返回文本；内外调用共享起点但属于两个位置。',
  'returnnormalize("hello")': '忽略原输入，返回常量 hello 经规范化后的结果。',
  'normalize("hello")': '固定传入 hello 常量，不是来自提交参数的数据。',
  'value==="no-call"': 'no-call 输入直接返回常量，其他输入继续执行规范化调用。',
  'return"hello"': '返回固定 hello，返回数据不来源于本次输入。',
  'returnnormalize(object.other)':
    '返回 object.other 的规范化结果，不能据此认定使用了 original 字段。',
  'normalize(object.other)': '只取 object.other 字段作为实参，不传递 original 字段。',
  'returnnormalize(items[1])': '返回第二个数组元素的规范化结果，未使用保存原输入的第一个元素。',
  'normalize(items[1])': '固定读取下标 1，数据来源必须与原始参数区分。',
  'returnclean(value)': 'clean 是导入 normalize 的别名；把当前 value 传入并返回其结果。',
  'clean(value)': '通过真实导入别名调用规范化函数，传入当前 value。',
  '!value': '空值在 trim 之前抛出 empty 错误，非空才继续规范化。',
  'thrownewError("empty")': '空输入直接抛出 empty，中断当前规范化并传播到提交调用方。',
  'newError("empty")': '创建消息为 empty 的错误对象，供当前拒绝分支抛出。',
  returnvalue: '返回当前变量 value；是否仍为原输入取决于此前是否重赋值。',
  'value="hello"': '将 value 重赋值为 hello，原参数到返回值的不可变绑定不再成立。',
};
function explainPoint(point) {
  const key = point.code.replace(/\s+/g, '').replace(/;$/, '').replaceAll("'", '"');
  assert.ok(pointMeanings[key], `测试样例需要补充明确说明：${point.code}`);
  return pointMeanings[key];
}

async function fixture(
  t,
  source = 'export function normalize(value) { return value.trim(); }\nexport function submit(value) { return normalize(value); }',
  files = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-flow-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.mjs'), source);
  for (const [file, content] of Object.entries(files))
    fs.writeFileSync(path.join(root, file), content);
  const filename = path.join(root, 'product-document.json');
  const document = JSON.parse(
    fs.readFileSync(new URL('../examples/minimal-product.json', import.meta.url)),
  );
  fs.writeFileSync(filename, JSON.stringify(document));
  const scan = await scanAnalysis(root),
    session = scan.session;
  const state = loadSession(session).state;
  for (const unit of state.units) {
    const receipt = await readAnalysis(session, unit.id);
    await recordAnalysis(session, {
      records: [
        {
          unitId: unit.id,
          receiptIds: [receipt.receipt.id],
          responsibility:
            unit.kind === 'top-level'
              ? '声明文本提交和规范化函数，导入别名保留真实函数身份。'
              : unit.reviewPoints
                  .filter((p) => p.field === 'outputs')
                  .map(explainPoint)
                  .join('；'),
          ...Object.fromEntries(
            ['inputs', 'outputs', 'conditions', 'calls', 'sideEffects', 'exceptions'].map(
              (field) => [
                field,
                unit.reviewPoints.filter((p) => p.field === field).map(explainPoint),
              ],
            ),
          ),
          unknowns: unit.calls
            .filter((call) => !call.target)
            .map((call) => `${call.expression} 的实际目标需由运行观测确认。`),
          coverage: unit.reviewPoints.map((point) => ({
            pointId: point.id,
            detail: explainPoint(point),
          })),
        },
      ],
    });
  }
  const from = state.units.find((unit) => unit.name === 'submit'),
    to = state.units.find((unit) => unit.name === 'normalize');
  const call = from.calls.find((call) => ['normalize', 'clean'].includes(call.expression));
  const flow = {
    id: 'submit-text',
    title: '提交规范化文本',
    entryId: `entry-${from.id}`,
    nodes: [
      {
        id: 'submit',
        featureId: 'stock-receipt',
        step: 0,
        unitId: from.id,
        pointIds: from.reviewPoints
          .filter((point) => ['conditions', 'sideEffects', 'exceptions'].includes(point.field))
          .map((point) => point.id),
        inputs: [from.parameters[0], call.resultId],
        outputs: [call.argumentIds[0], ...from.returns],
      },
      {
        id: 'normalize',
        featureId: 'stock-receipt',
        step: 1,
        unitId: to.id,
        pointIds: to.reviewPoints
          .filter((point) => ['conditions', 'sideEffects', 'exceptions'].includes(point.field))
          .map((point) => point.id),
        inputs: [to.parameters[0]],
        outputs: [...to.returns],
      },
    ],
    edges: [
      { id: 'invoke', from: 'submit', to: 'normalize', kind: 'call', callId: call.id },
      {
        id: 'argument',
        from: 'submit',
        to: 'normalize',
        kind: 'data',
        callId: call.id,
        sourceId: call.argumentIds[0],
        targetId: to.parameters[0],
      },
      {
        id: 'result',
        from: 'normalize',
        to: 'submit',
        kind: 'data',
        callId: call.id,
        sourceId: to.returns[0],
        targetId: call.resultId,
      },
    ],
    scenarios: [
      {
        id: 'normal',
        title: '去除两侧空格',
        kind: 'normal',
        entryNode: 'submit',
        terminalNodes: ['submit'],
        edges: ['invoke', 'argument', 'result'],
        assertions: [{ nodeId: 'submit', event: 'return', operator: 'equals', expected: 'hello' }],
      },
    ],
  };
  await recordFlows(filename, session, {
    expectedHash: readSnapshot(filename).documentHash,
    flows: [flow],
    dispositions: state.facts.entries
      .filter((entry) => entry.id !== flow.entryId)
      .map((entry) => ({
        entryId: entry.id,
        reason: '此导出函数为提交业务的内部处理步骤，已在同一流程关联。',
      })),
  });
  return { root, filename, session, flow };
}
const command = (body) => ({
  command: process.execPath,
  args: ['--input-type=module', '-e', body],
  flow: { id: 'submit-text', scenarioId: 'normal' },
});
test('业务结果引用真实流程场景：未执行、错误场景和源码变更不能通过，实际精确结果可通过', async (t) => {
  const f = await fixture(t),
    state = loadSession(f.session).state,
    unit = state.units.find((u) => u.name === 'submit');
  f.flow.scenarios[0].assertions[0].valueId = unit.returns[0];
  await recordFlows(f.filename, f.session, {
    expectedHash: readSnapshot(f.filename).documentHash,
    flows: [f.flow],
  });
  const operation = state.facts.operations.find((o) => o.entryId === f.flow.entryId);
  const input = {
    version: 1,
    capabilities: [
      {
        id: 'submit',
        title: '提交文本',
        actor: '用户',
        goal: '获得规范化文本',
        outcome: '返回去除两侧空白的文本',
        featureIds: ['stock-receipt'],
        operationIds: [operation.id],
        results: [
          {
            kind: 'code',
            unitId: unit.id,
            pointId: unit.reviewPoints.find((p) => p.kind === 'return').id,
            detail: '必须对应此场景内此返回位置的真实结果。',
            via: { flowId: f.flow.id, scenarioId: 'normal' },
          },
        ],
      },
    ],
    dispositions: state.facts.operations
      .filter((o) => o.id !== operation.id)
      .map((o) => ({
        operationId: o.id,
        source: o.registration.file,
        reason: '规范化函数是提交旅程的共享处理步骤，此处限定核对提交公开入口。',
      })),
  };
  assert.equal((await recordBusinessModel(f.session, input, f.filename)).coverageValid, false);
  await runVerification(
    f.filename,
    'stock-receipt',
    f.session,
    command(
      "import {submit} from './main.mjs';if(submit(' hello ')!=='hello')throw Error('wrong');",
    ),
  );
  const checked = checkBusinessModel(f.session, f.filename);
  assert.equal(checked.coverageValid, true, JSON.stringify(checked.gaps));
  assert.equal(checked.valid, false, '真实连接成立仍需独立业务审阅');
  assert.ok(checked.connections[0].links.some((l) => l.basis === 'observed-flow'));
  input.capabilities[0].results[0].via.scenarioId = 'missing';
  assert.equal((await recordBusinessModel(f.session, input, f.filename)).coverageValid, false);
  fs.appendFileSync(path.join(f.root, 'main.mjs'), '\n// changed');
  assert.throws(() => checkBusinessModel(f.session, f.filename), { code: 'ANALYSIS_STALE' });
});
test('真实探针按完整位置绑定链式调用，内层函数不会误用外层调用编号', async (t) => {
  const f = await fixture(
    t,
    'export function normalize(value){return value.trim();} export function submit(value){return normalize(value).trim();}',
  );
  const state = loadSession(f.session).state,
    submit = state.units.find((u) => u.name === 'submit'),
    normalize = state.units.find((u) => u.name === 'normalize');
  const inner = submit.calls.find((c) => c.target === normalize.id),
    outer = submit.calls.find((c) => c.id !== inner.id);
  assert.equal(inner.start, outer.start);
  assert.notEqual(inner.id, outer.id);
  const run = await runVerification(
    f.filename,
    'stock-receipt',
    f.session,
    command("import {submit} from './main.mjs';if(submit(' hello ')!=='hello')process.exit(2);"),
  );
  assert.equal(run.valid, true, JSON.stringify(run));
  const events = JSON.parse(fs.readFileSync(run.record.replace(/\.json$/, '.events.json'), 'utf8'));
  const entered = events.find((e) => e.kind === 'enter' && e.unitId === normalize.id);
  assert.ok(entered, '确实观察到规范化函数进入');
  assert.equal(entered.callId, inner.id);
  assert.ok(
    events.some(
      (e) =>
        e.kind === 'binding' && e.callId === inner.id && e.targetId === normalize.parameters[0],
    ),
  );
});
test('实际调用、参数与返回在同一次运行成立，副本运行保持原源码及文档不变', async (t) => {
  const { root, filename, session } = await fixture(t),
    before = fs.readFileSync(path.join(root, 'main.mjs')),
    beforeDocument = fs.readFileSync(filename);
  assert.equal(checkFlows(filename, session).valid, false);
  const run = await runVerification(
    filename,
    'stock-receipt',
    session,
    command("import {submit} from './main.mjs'; if(submit(' hello ')!=='hello')process.exit(2);"),
  );
  assert.equal(run.valid, true, JSON.stringify(run));
  const check = checkFlows(filename, session);
  assert.equal(check.valid, true, JSON.stringify(check));
  assert.equal(check.flows[0].status, 'passed');
  assert.deepEqual(fs.readFileSync(path.join(root, 'main.mjs')), before);
  assert.deepEqual(fs.readFileSync(filename), beforeDocument);
});
test('退出成功、伪造普通日志与没有入口执行不能支持流程通过，真实错误结果是失败', async (t) => {
  const { filename, session } = await fixture(t);
  await runVerification(
    filename,
    'stock-receipt',
    session,
    command("console.log(JSON.stringify({kind:'enter',unitId:'fake',value:'hello'}))"),
  );
  assert.equal(checkFlows(filename, session).flows[0].status, 'unverified');
  await runVerification(
    filename,
    'stock-receipt',
    session,
    command("import {submit} from './main.mjs'; submit('wrong');"),
  );
  assert.equal(checkFlows(filename, session).flows[0].status, 'failed');
});
test('夹具不可覆盖原源码、旧定义不能重用、超时不能当通过', async (t) => {
  const { filename, session } = await fixture(t);
  await assert.rejects(
    runVerification(filename, 'stock-receipt', session, {
      ...command(''),
      fixtures: [{ file: 'main.mjs', content: '' }],
    }),
    /覆盖/,
  );
  const run = await runVerification(filename, 'stock-receipt', session, {
    ...command('setInterval(()=>{},1000)'),
    timeoutMs: 30,
  });
  assert.equal(run.valid, false);
  assert.notEqual(checkFlows(filename, session).flows[0].status, 'passed');
});
test('相同常量不证明来自原输入；不同请求的调用与结果不能拼接', async (t) => {
  const constant = await fixture(
    t,
    'export function normalize(value){return value.trim();} export function submit(value){return normalize("hello");}',
  );
  const state = loadSession(constant.session).state,
    from = state.units.find((unit) => unit.name === 'submit');
  constant.flow.nodes[0].outputs.push(from.parameters[0]);
  constant.flow.edges.find((edge) => edge.id === 'argument').sourceId = from.parameters[0];
  await recordFlows(constant.filename, constant.session, {
    expectedHash: readSnapshot(constant.filename).documentHash,
    flows: [constant.flow],
  });
  await runVerification(
    constant.filename,
    'stock-receipt',
    constant.session,
    command("import {submit} from './main.mjs';submit('hello');"),
  );
  assert.notEqual(checkFlows(constant.filename, constant.session).flows[0].status, 'passed');
  const concurrent = await fixture(
    t,
    'export function normalize(value){return value.trim();} export function submit(value){if(value==="no-call")return "hello"; return normalize(value);}',
  );
  await runVerification(
    concurrent.filename,
    'stock-receipt',
    concurrent.session,
    command(
      "import {submit} from './main.mjs'; await Promise.all([Promise.resolve().then(()=>submit('wrong')),Promise.resolve().then(()=>submit('no-call'))]);",
    ),
  );
  assert.notEqual(checkFlows(concurrent.filename, concurrent.session).flows[0].status, 'passed');
});

test('对象的其他字段或数组元素不能冒充原输入，值相同仍缺少字段来源证据', async (t) => {
  for (const body of [
    'const object={original:value,other:"hello"};return normalize(object.other);',
    'const items=[value,"hello"];return normalize(items[1]);',
  ]) {
    const f = await fixture(
        t,
        `export function normalize(value){return value.trim();} export function submit(value){${body}}`,
      ),
      state = loadSession(f.session).state,
      from = state.units.find((unit) => unit.name === 'submit');
    f.flow.nodes[0].outputs.push(from.parameters[0]);
    f.flow.edges.find((edge) => edge.id === 'argument').sourceId = from.parameters[0];
    await recordFlows(f.filename, f.session, {
      expectedHash: readSnapshot(f.filename).documentHash,
      flows: [f.flow],
    });
    await runVerification(
      f.filename,
      'stock-receipt',
      f.session,
      command("import {submit} from './main.mjs';submit('hello');"),
    );
    const report = checkFlows(f.filename, f.session);
    assert.equal(report.valid, false);
    assert.ok(report.gaps.some((gap) => gap.kind === 'data'));
  }
});
test('跨文件导入别名使用真实函数身份；遗漏调用或异常分支不能通过', async (t) => {
  const f = await fixture(
    t,
    "import {normalize as clean} from './normalize.mjs'; export function submit(value){return clean(value);}",
    { 'normalize.mjs': 'export function normalize(value){return value.trim();}' },
  );
  await runVerification(
    f.filename,
    'stock-receipt',
    f.session,
    command("import {submit} from './main.mjs';submit(' hello ');"),
  );
  assert.equal(checkFlows(f.filename, f.session).flows[0].status, 'passed');
  f.flow.edges = f.flow.edges.filter((edge) => edge.kind !== 'call');
  f.flow.scenarios[0].edges = ['argument', 'result'];
  await recordFlows(f.filename, f.session, {
    expectedHash: readSnapshot(f.filename).documentHash,
    flows: [f.flow],
  });
  assert.ok(checkFlows(f.filename, f.session).gaps.some((gap) => gap.kind === 'coverage'));
  const branch = await fixture(
    t,
    'export function normalize(value){if(!value)throw new Error("empty");return value.trim();} export function submit(value){return normalize(value);}',
  );
  await runVerification(
    branch.filename,
    'stock-receipt',
    branch.session,
    command("import {submit} from './main.mjs';submit(' hello ');"),
  );
  const report = checkFlows(branch.filename, branch.session);
  assert.notEqual(report.flows[0].status, 'passed');
  assert.ok(report.gaps.some((gap) => ['branch', 'scenario'].includes(gap.kind)));
});

test('同一函数内的步骤依靠实际调用帧和定义使用关系；重赋值不能沿用原参数', async (t) => {
  for (const [body, passed] of [
    ['return value;', true],
    ['return "hello";', false],
    ['value="hello";return value;', false],
  ]) {
    const f = await fixture(
        t,
        `export function normalize(value){${body}} export function submit(value){return normalize(value);}`,
      ),
      state = loadSession(f.session).state,
      unit = state.units.find((unit) => unit.name === 'normalize');
    const flow = {
      id: 'one-function',
      title: '输入与返回',
      entryId: `entry-${unit.id}`,
      nodes: [
        {
          id: 'input',
          featureId: 'stock-receipt',
          step: 0,
          unitId: unit.id,
          pointIds: unit.reviewPoints
            .filter((point) => point.field === 'sideEffects')
            .map((point) => point.id),
          inputs: unit.parameters,
          outputs: unit.parameters,
        },
        {
          id: 'result',
          featureId: 'stock-receipt',
          step: 1,
          unitId: unit.id,
          inputs: unit.returns,
          outputs: unit.returns,
        },
      ],
      edges: [
        {
          id: 'value',
          from: 'input',
          to: 'result',
          kind: 'data',
          sourceId: unit.parameters[0],
          targetId: unit.returns[0],
        },
      ],
      scenarios: [
        {
          id: 'normal',
          title: '返回原输入',
          kind: 'normal',
          entryNode: 'input',
          terminalNodes: ['result'],
          edges: ['value'],
          assertions: [
            { nodeId: 'result', event: 'return', operator: 'equals', expected: 'hello' },
          ],
        },
      ],
    };
    await recordFlows(f.filename, f.session, {
      expectedHash: readSnapshot(f.filename).documentHash,
      flows: [flow],
    });
    await runVerification(f.filename, 'stock-receipt', f.session, {
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        "import {normalize} from './main.mjs';normalize('hello');",
      ],
      flow: { id: flow.id, scenarioId: 'normal' },
    });
    assert.equal(
      checkFlows(f.filename, f.session, { id: flow.id }).valid,
      passed,
      JSON.stringify(checkFlows(f.filename, f.session, { id: flow.id })),
    );
  }
});

test('流程同步保留业务内容，等待保存期间的外部修改使同步冲突而不覆盖新定义', async (t) => {
  const f = await fixture(t);
  await runVerification(
    f.filename,
    'stock-receipt',
    f.session,
    command("import {submit} from './main.mjs';submit(' hello ');"),
  );
  const original = readSnapshot(f.filename).document.features;
  await syncFlowStatus(f.filename, f.session);
  assert.deepEqual(readSnapshot(f.filename).document.features, original);
  assert.equal(
    readSnapshot(f.filename).document.flowVerification.features['stock-receipt'].status,
    'passed',
  );
  let entered, release;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    waiting = new Promise((resolve) => {
      release = resolve;
    });
  const held = updateDocument(f.filename, () => ({ changed: false, result: null }), {
    afterCommit: async () => {
      entered();
      await waiting;
    },
  });
  await ready;
  const synchronizing = syncFlowStatus(f.filename, f.session);
  const document = readSnapshot(f.filename).document;
  document.features['stock-receipt'].description = '外部用户的新定义';
  document.features['stock-receipt'].revision++;
  const content = JSON.stringify(document);
  fs.writeFileSync(f.filename, content);
  release();
  await held;
  await assert.rejects(synchronizing, { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(f.filename, 'utf8'), content);
  assert.equal(fs.existsSync(f.filename + '.write-lock'), false);
});

test('重新扫描并映射后，历史会话的入口缺口不遮盖当前范围结论', async (t) => {
  const f = await fixture(t);
  await updateSession(f.session, (state) => {
    // A corrupt old mapping must neither classify entries nor shadow its replacement.
    state.flows[f.flow.id].recordHash = 'invalid-old-mapping';
  });
  assert.ok(readFlowStatus(f.filename).globalGaps.some((gap) => gap.kind === 'entry'));
  fs.appendFileSync(path.join(f.root, 'main.mjs'), '\n// 新源码快照\n');
  const next = await scanAnalysis(f.root),
    state = loadSession(next.session).state;
  await recordFlows(f.filename, next.session, {
    expectedHash: readSnapshot(f.filename).documentHash,
    flows: [f.flow],
    dispositions: state.facts.entries
      .filter((entry) => entry.id !== f.flow.entryId)
      .map((entry) => ({ entryId: entry.id, reason: '当前旅程内部处理步骤，已关联到提交流程。' })),
  });
  const status = readFlowStatus(f.filename);
  assert.equal(status.globalGaps.length, 0, JSON.stringify(status));
  assert.notEqual(status.features['stock-receipt'].status, 'stale');
  assert.ok(status.features['stock-receipt'].gaps.some((gap) => gap.kind === 'analysis'));
  fs.appendFileSync(path.join(f.root, 'main.mjs'), '\n// 范围调整后的新快照\n');
  const scoped = await scanAnalysis(f.root, { include: ['main.mjs'] });
  await recordFlows(f.filename, scoped.session, {
    expectedHash: readSnapshot(f.filename).documentHash,
    flows: [f.flow],
    dispositions: loadSession(scoped.session)
      .state.facts.entries.filter((entry) => entry.id !== f.flow.entryId)
      .map((entry) => ({ entryId: entry.id, reason: '内部步骤仍由当前提交旅程处理。' })),
  });
  assert.equal(
    readFlowStatus(f.filename).globalGaps.length,
    0,
    '已由新映射替代的旧范围流程过期信息不能变成全局缺口',
  );
});
