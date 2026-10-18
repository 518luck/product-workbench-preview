import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  scanAnalysis,
  loadSession,
  readAnalysisPack,
  recordAnalysis,
  checkAnalysis,
} from '../lib/analysis-session.mjs';
import {
  businessInventory,
  recordBusinessModel,
  checkBusinessModel,
  reviewBusinessModel,
} from '../lib/business-model.mjs';
import { checkDelivery } from '../lib/delivery.mjs';
import { createFeature } from '../lib/feature-operations.mjs';
import { renderDocument } from '../lib/document.mjs';

async function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-business-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  const scan = await scanAnalysis(root);
  return { root, ...scan, state: loadSession(scan.session).state };
}

test('共享处理函数保留每个注册；HTTP 分发器路径和 CLI 子命令不会按函数吞并', async (t) => {
  const f = await fixture(t, {
    'main.mjs': `import http from 'node:http';
function shared(req,res){res.end('ok')}
app.post('/notes',shared); app.delete('/notes/:id',shared);
http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/book')return res.end('book'); if(req.url==='/health')return res.end('ok');});
const command=process.argv[2]; switch(command){case 'publish':shared();break;case 'withdraw':shared();break;}
const commands={audit:{usage:'audit [book]'},restore:{usage:'restore [book]'}};commands[command];
`,
  });
  const ops = f.state.facts.operations;
  for (const route of ['/notes', '/notes/:id', '/book', '/health'])
    assert.ok(
      ops.some((o) => o.trigger.path === route),
      route,
    );
  for (const command of ['publish', 'withdraw', 'audit', 'restore'])
    assert.ok(
      ops.some((o) => o.trigger.command === command),
      command,
    );
  const shared = ops.filter((o) => o.trigger.path?.startsWith('/notes'));
  assert.equal(shared.length, 2);
  assert.equal(shared[0].unitId, shared[1].unitId);
  assert.notEqual(shared[0].id, shared[1].id);
  assert.equal(
    f.state.facts.entries.filter((e) => e.kind === 'registration' && e.unitId === shared[0].unitId)
      .length,
    2,
  );
  assert.ok(
    shared.every((o) => o.certainty === 'candidate'),
    '未确认接收者不能宣称真实 HTTP 注册',
  );
});

test('真实 Express 导入有明确身份；普通 Map.get 不冒充路由；事件和 JSX 分别保留', async (t) => {
  const f = await fixture(t, {
    'app.tsx': `import express from 'express'; const app=express();
function handle(){return 'saved'} app.post('/save',handle);app.delete('/save/:id',handle);
const map=new Map();map.get('key');button.addEventListener('click',handle);
const view=<button onClick={handle}/>;`,
  });
  assert.equal(f.state.facts.operations.filter((o) => o.adapter === 'express').length, 2);
  assert.equal(
    f.state.facts.operations.filter((o) => o.surface === 'http' && o.trigger.path === 'key').length,
    0,
  );
  assert.ok(f.state.facts.operations.some((o) => o.surface === 'page-event'));
  assert.ok(
    f.state.facts.operations.some((o) => o.surface === 'event' && o.trigger.event === 'click'),
  );
});

const source =
  "export function reserve(seats){if(seats<=0)throw new Error('full');return seats-1;}";
function card(f, overrides = {}) {
  const unit = f.state.units.find((u) => u.name === 'reserve');
  const point = unit.reviewPoints.find((p) => p.kind === 'return');
  return {
    version: 1,
    capabilities: [
      {
        id: 'reservation',
        title: '预约名额',
        actor: '预约者',
        goal: '有名额时预约',
        outcome: '返回扣除本次预约后的剩余名额',
        operationIds: f.state.facts.operations.map((o) => o.id),
        results: [
          {
            kind: 'code',
            unitId: unit.id,
            pointId: point.id,
            detail: '返回 seats-1；无名额时拒绝。',
          },
        ],
        ...overrides,
      },
    ],
    dispositions: [],
  };
}
test('业务地图在详细阅读前即可形成；结构通过、语义审阅和版本绑定分别报告', async (t) => {
  const f = await fixture(t, { 'booking.mjs': source });
  assert.equal(businessInventory(f.session).total, 1);
  const input = card(f);
  const saved = await recordBusinessModel(f.session, input);
  assert.equal(saved.valid, true);
  assert.equal(saved.semanticStatus, 'unreviewed');
  assert.equal(checkAnalysis(f.session).reviewedCount, 0, '业务草图不冒充源码阅读完成');
  await reviewBusinessModel(f.session, {
    modelHash: saved.model.recordHash,
    reviewer: 'isolated-review',
    decisions: [
      {
        capabilityId: 'reservation',
        verdict: 'supported',
        reason: '入口接收名额，非正值拒绝，正常路径返回减一结果。',
        evidence: input.capabilities[0].results,
      },
    ],
  });
  assert.equal(checkBusinessModel(f.session).semanticStatus, 'reviewed');
  await recordBusinessModel(f.session, card(f, { outcome: '确认剩余名额' }));
  assert.equal(checkBusinessModel(f.session).semanticStatus, 'unreviewed');
  await assert.rejects(
    reviewBusinessModel(f.session, {
      modelHash: saved.model.recordHash,
      reviewer: 'old-review',
      decisions: [],
    }),
    /已变化/,
  );
  fs.appendFileSync(path.join(f.root, 'booking.mjs'), '\n// new source');
  assert.throws(() => checkBusinessModel(f.session), { code: 'ANALYSIS_STALE' });
});

test('操作遗漏、无结果位置、虚假引用和用 helper 替代 Skill 指令均不能静默通过', async (t) => {
  const f = await fixture(t, {
    'booking.mjs': source,
    'SKILL.md': '# 维护需求\n读取用户修改，整理定义并保存产品书。',
  });
  const input = card(f, {
    operationIds: f.state.facts.operations.filter((o) => o.surface === 'library').map((o) => o.id),
  });
  const saved = await recordBusinessModel(f.session, input);
  assert.equal(saved.valid, false);
  assert.ok(saved.gaps.some((g) => g.message.includes('尚未归类')));
  const replaced = await recordBusinessModel(f.session, card(f));
  assert.equal(replaced.valid, false);
  assert.ok(replaced.gaps.some((g) => g.message.includes('指令原文')));
  const bad = card(f);
  bad.capabilities[0].results[0].pointId = 'p-missing';
  await assert.rejects(recordBusinessModel(f.session, bad), /真实/);
  assert.equal(
    checkBusinessModel(f.session).modelHash,
    replaced.model.recordHash,
    '失败批次保留旧图',
  );
});

test('文件读包只发一次嵌套正文；语义断言可关联相关位置，不能漏项或重复；外部路径拒绝', async (t) => {
  const f = await fixture(t, {
    'nested.mjs':
      'export function normalize(value){function trim(input){return input.trim()}return trim(value)}',
  });
  const pack = await readAnalysisPack(f.session, 'nested.mjs', { length: 100000 });
  assert.equal(pack.units.length, 2);
  assert.ok(pack.units.every((u) => u.fullyIncluded));
  const records = f.state.units.map((u) => ({
    unitId: u.id,
    receiptIds: [pack.receipt.id],
    responsibility:
      u.name === 'trim' ? '移除输入文本首尾空白' : '将输入交给内部 trim 清除首尾空白后返回',
    inputs: ['待清理文本'],
    outputs: ['去掉首尾空白的文本'],
    conditions: [],
    calls: ['清理文本空白'],
    sideEffects: [],
    exceptions: [],
    unknowns: [],
    claims: [
      {
        pointIds: u.reviewPoints.map((p) => p.id),
        detail:
          u.name === 'trim'
            ? 'input 为待清理文本，调用其 trim 方法并返回去掉首尾空白的字符串。'
            : 'value 传给内部 trim 函数，将其清理后的字符串作为规范化结果返回。',
      },
    ],
  }));
  await recordAnalysis(f.session, { records });
  assert.equal(checkAnalysis(f.session).valid, true);
  assert.ok(
    records.reduce((n, r) => n + r.claims.length, 0) <
      f.state.units.reduce((n, u) => n + u.reviewPoints.length, 0),
  );
  const incomplete = structuredClone(records[0]);
  incomplete.claims[0].pointIds.pop();
  await assert.rejects(recordAnalysis(f.session, { records: [incomplete] }), {
    code: 'ANALYSIS_INCOMPLETE',
  });
  const duplicate = structuredClone(records[0]);
  duplicate.claims[0].pointIds.push(duplicate.claims[0].pointIds[0]);
  await assert.rejects(recordAnalysis(f.session, { records: [duplicate] }), {
    code: 'ANALYSIS_INCOMPLETE',
  });
  await assert.rejects(readAnalysisPack(f.session, '../outside.mjs'), { code: 'INVALID_ARGUMENT' });
  assert.equal(checkAnalysis(f.session).valid, true);
});

test('最终地图需绑定当前功能，v5 不能用旧审阅/未读来源充当业务完成', async (t) => {
  const f = await fixture(t, { 'booking.mjs': source });
  const document = {
    schemaVersion: 1,
    product: { name: '预约服务', background: '预约剩余名额' },
    features: {
      reservation: createFeature('reservation', {
        title: '预约名额',
        description: '正数名额返回减一，否则拒绝。',
      }),
    },
    dependencies: [],
    diagrams: {},
  };
  const file = path.join(f.root, 'product-document.json');
  fs.writeFileSync(file, JSON.stringify(document));
  fs.writeFileSync(path.join(f.root, 'index.html'), renderDocument(document));
  await recordBusinessModel(f.session, card(f));
  assert.equal(checkBusinessModel(f.session, file).valid, false);
  const input = card(f, { featureIds: ['reservation'] });
  await recordBusinessModel(f.session, input, file);
  assert.ok(
    checkBusinessModel(f.session, file).gaps.some((g) => g.message.includes('尚未完整读取')),
  );
  await readAnalysisPack(f.session, 'booking.mjs');
  // Reading alone cannot stand in for an independent function record.
  assert.equal(checkBusinessModel(f.session, file).valid, false);
  const delivery = await checkDelivery(file, f.session, {
    version: 5,
    documentHash: 'wrong',
    features: [],
    diagrams: {},
    journeys: [],
    flows: [],
    acknowledgedGaps: [],
  });
  assert.equal(delivery.valid, false);
  assert.ok(delivery.gaps.some((g) => g.kind === 'business'));
});

test('安装入口可发现业务协议，分页、标准输入和非零缺口返回正确', async (t) => {
  const f = await fixture(t, { 'booking.mjs': source });
  const cli = new URL('../bin/product-blueprint.mjs', import.meta.url).pathname;
  const run = (args, input) =>
    spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8', input });
  const inventory = run(['business', 'inventory', '--session', f.session, '--limit', '1']);
  assert.equal(inventory.status, 0, inventory.stdout);
  assert.equal(JSON.parse(inventory.stdout).operations.length, 1);
  assert.equal(run(['business', 'check', '--session', f.session]).status, 1);
  assert.equal(
    run(['business', 'record', '--session', f.session, '--input', '-'], JSON.stringify(card(f)))
      .status,
    0,
  );
  const schema = run(['schema', '--business']);
  assert.equal(JSON.parse(schema.stdout).oneOf.length, 2);
  const pack = run(['analysis', 'pack', 'booking.mjs', '--session', f.session]);
  assert.equal(pack.status, 0, pack.stdout);
  assert.ok(JSON.parse(pack.stdout).code.includes('reserve'));
  fs.appendFileSync(path.join(f.root, 'booking.mjs'), '\n// source changed');
  const stale = run(['business', 'check', '--session', f.session]);
  assert.equal(JSON.parse(stale.stdout).code, 'ANALYSIS_STALE', '源码过期不能误报成写锁冲突');
});

test('纯需求可以建业务草图，原文不能冒充代码已有实现', async (t) => {
  const f = await fixture(t, {});
  const input = {
    version: 1,
    capabilities: [
      {
        id: 'export',
        title: '导出报表',
        actor: '管理员',
        goal: '下载报表',
        outcome: '获得 CSV 文件',
        classification: 'requested',
        operationIds: [],
        results: [{ kind: 'requirement', source: 'user', text: '我想要导出 CSV 报表。' }],
      },
    ],
    dispositions: [],
  };
  assert.equal((await recordBusinessModel(f.session, input)).valid, true);
  input.capabilities[0].classification = 'observed';
  await assert.rejects(recordBusinessModel(f.session, input), /操作编号/);
});

test('可变 pathname、路径前缀及异步消息/任务不被当作没有入口', async (t) => {
  const f = await fixture(t, {
    'main.mjs': `import http from 'node:http';
function work(){return 'done'}
http.createServer((request,response)=>{let pathname;pathname=new URL(request.url,'http://localhost').pathname;
if(pathname.startsWith('/items/')){const methods=['PUT','DELETE'];if(!methods.includes(request.method))throw new Error('method');return response.end('ok');}});
queue.subscribe('orders',work);cron.schedule('0 * * * *',work);setInterval(work,1000);`,
  });
  const ops = f.state.facts.operations;
  assert.ok(ops.some((op) => op.trigger.pathPrefix === '/items/' && op.trigger.method === 'PUT'));
  assert.ok(
    ops.some((op) => op.trigger.pathPrefix === '/items/' && op.trigger.method === 'DELETE'),
  );
  assert.ok(ops.some((op) => op.surface === 'message'));
  assert.equal(ops.filter((op) => op.surface === 'scheduled-task').length, 2);
});

test('审阅可以核对守卫，非业务排除须单独审阅；错位置返回可定位缺口', async (t) => {
  const f = await fixture(t, { 'booking.mjs': source + '\nexport function version(){return 1;}' });
  const unit = f.state.units.find((u) => u.name === 'reserve');
  const helper = f.state.units.find((u) => u.name === 'version');
  const excluded = f.state.facts.operations.find((o) => o.unitId === helper.id);
  const input = card(f, {
    operationIds: f.state.facts.operations.filter((o) => o.unitId === unit.id).map((o) => o.id),
  });
  input.dispositions = [
    {
      operationId: excluded.id,
      reason: 'version 仅返回固定协议号，作为该示例库的支撑信息，不预订名额。',
      source: 'booking.mjs',
    },
  ];
  const saved = await recordBusinessModel(f.session, input);
  const guard = {
    kind: 'code',
    unitId: unit.id,
    pointId: unit.reviewPoints.find((p) => p.kind === 'condition').id,
    detail: '非正数名额在预订前被拒绝。',
  };
  const review = {
    modelHash: saved.model.recordHash,
    reviewer: 'raw-source-review',
    decisions: [
      {
        capabilityId: 'reservation',
        verdict: 'supported',
        reason: '先拒绝无名额，再返回扣减结果。',
        evidence: [guard, ...input.capabilities[0].results],
      },
    ],
  };
  const pending = await reviewBusinessModel(f.session, review);
  assert.equal(pending.semanticStatus, 'needs-attention');
  assert.deepEqual(pending.pendingExclusions, [excluded.id]);
  const broken = structuredClone(review);
  broken.decisions[0].evidence[0].pointId = 'p-missing';
  await assert.rejects(
    reviewBusinessModel(f.session, broken),
    (e) =>
      e.details[0].path === '/decisions/0/evidence' && e.details[0].message.includes('p-missing'),
  );
  review.exclusions = [
    {
      operationId: excluded.id,
      verdict: 'supported',
      reason: '源码只返回版本号，不改变名额或执行预订。',
      evidence: [
        {
          kind: 'code',
          unitId: helper.id,
          pointId: helper.reviewPoints[0].id,
          detail: '固定版本常量作为协议支撑信息返回。',
        },
      ],
    },
  ];
  assert.equal((await reviewBusinessModel(f.session, review)).semanticStatus, 'reviewed');
});
