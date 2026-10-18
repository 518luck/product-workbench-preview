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
} from '../lib/analysis-session.mjs';
import {
  recordBusinessModel,
  reviewBusinessModel,
  checkBusinessModel,
} from '../lib/business-model.mjs';

async function fixture(t, code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'product.mjs'), code);
  const { session } = await scanAnalysis(root);
  return { root, session, state: loadSession(session).state };
}
const result = (state, name) => {
  const u = state.units.find((u) => u.name === name);
  return {
    kind: 'code',
    unitId: u.id,
    pointId: u.reviewPoints.find((p) => p.kind === 'return').id,
    detail: '核对该独立操作自身返回的业务结果。',
  };
};
const capability = (op, e) => ({
  id: 'read',
  title: '读取记录',
  actor: '调用者',
  goal: '获取当前记录',
  outcome: '返回所选记录',
  operationIds: [op.id],
  results: [e],
});

test('公开页面/API/命令不能批量降为内部支撑；模板说明不能消除不同业务操作', async (t) => {
  const f = await fixture(
    t,
    `export function read(){return 'record'}export function save(){return 'saved'}export function remove(){return 'removed'}export function publish(){return 'published'}export function close(){return 'closed'}
button.addEventListener('click',save);router.post('/publish',publish);const cmd=process.argv[2];if(cmd==='close'){close()}`,
  );
  const op = f.state.facts.operations.find(
    (o) => o.surface === 'library' && o.trigger.name === 'read',
  );
  const input = {
    version: 1,
    capabilities: [capability(op, result(f.state, 'read'))],
    dispositions: f.state.facts.operations
      .filter((o) => o.id !== op.id)
      .map((o) => ({
        operationId: o.id,
        source: o.registration.file,
        reason: '内部支持或工具操作函数，支撑上层业务执行',
      })),
  };
  const saved = await recordBusinessModel(f.session, input);
  assert.equal(saved.coverageValid, false);
  assert.equal(saved.valid, false);
  assert.ok(saved.gaps.some((g) => g.message.includes('对外操作')));
  assert.ok(saved.gaps.some((g) => g.message.includes('模板')));
  assert.equal(checkBusinessModel(f.session).stage, 'incomplete');
});

test('support 必须连接所属真实业务结果；工作流文档或无关快照不能吞并页面动作', async (t) => {
  const f = await fixture(
    t,
    `export function read(){return 'record'}export function save(){return 'saved'}button.addEventListener('click',save)`,
  );
  const read = f.state.facts.operations.find(
    (o) => o.surface === 'library' && o.trigger.name === 'read',
  );
  const event = f.state.facts.operations.find((o) => o.surface === 'event');
  const input = {
    version: 1,
    capabilities: [capability(read, result(f.state, 'read'))],
    dispositions: f.state.facts.operations
      .filter((o) => o.id !== read.id)
      .map((o) => ({
        operationId: o.id,
        source: o.registration.file,
        kind: o.id === event.id ? 'support' : 'internal',
        capabilityIds: o.id === event.id ? ['read'] : undefined,
        reason:
          o.id === event.id
            ? '点击保存按钮调用保存函数，不能作为读取记录的支撑。'
            : '保存函数将待保存内容交给调用者，不读取已有记录。',
      })),
  };
  const wrong = await recordBusinessModel(f.session, input);
  assert.ok(wrong.gaps.some((g) => g.message.includes('没有连接')));
  const save = f.state.facts.operations.find(
    (o) => o.surface === 'library' && o.trigger.name === 'save',
  );
  input.capabilities = [capability(save, result(f.state, 'save'))];
  input.dispositions = input.dispositions.filter((d) => d.operationId !== save.id);
  input.dispositions.push({
    operationId: read.id,
    source: 'product.mjs',
    reason: '读取接口只返回记录，在此保存动作样例中单独保留。',
  });
  assert.equal((await recordBusinessModel(f.session, input)).coverageValid, true);
});

test('地图保存与审阅通过分别报告；业务 check 对待审阅返回非零', async (t) => {
  const f = await fixture(t, `export function read(){return 'record'}`);
  const c = capability(f.state.facts.operations[0], result(f.state, 'read'));
  const saved = await recordBusinessModel(f.session, {
    version: 1,
    capabilities: [c],
    dispositions: [],
  });
  assert.equal(saved.saved, true);
  assert.equal(saved.coverageValid, true);
  assert.equal(saved.valid, false);
  const cli = new URL('../bin/product-blueprint.mjs', import.meta.url).pathname;
  const pending = spawnSync(
    process.execPath,
    [cli, 'business', 'check', '--session', f.session, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(pending.status, 1);
  assert.equal(JSON.parse(pending.stdout).stage, 'needs-review');
  await reviewBusinessModel(f.session, {
    modelHash: saved.model.recordHash,
    reviewer: 'source-review',
    decisions: [
      {
        capabilityId: 'read',
        verdict: 'supported',
        reason: '入口只返回记录字面值，没有保存或发布行为。',
        evidence: c.results,
      },
    ],
  });
  assert.equal(checkBusinessModel(f.session).valid, true);
});

test('支持标签不能将未读、未分析的排除项判作完成；完整独立分析后才能通过', async (t) => {
  const f = await fixture(
    t,
    `export function read(){return 'record'}export function version(){return 1}`,
  );
  const op = f.state.facts.operations.find((o) => o.trigger.name === 'read'),
    helper = f.state.units.find((u) => u.name === 'version'),
    excluded = f.state.facts.operations.find((o) => o.unitId === helper.id);
  const c = capability(op, result(f.state, 'read'));
  const saved = await recordBusinessModel(f.session, {
    version: 1,
    capabilities: [c],
    dispositions: [
      {
        operationId: excluded.id,
        source: 'product.mjs',
        reason: '仅返回固定协议版本号，不读取用户记录。',
      },
    ],
  });
  const review = {
    modelHash: saved.model.recordHash,
    reviewer: 'source-review',
    decisions: [
      {
        capabilityId: 'read',
        verdict: 'supported',
        reason: '读取接口返回记录。',
        evidence: c.results,
      },
    ],
    exclusions: [
      {
        operationId: excluded.id,
        verdict: 'supported',
        reason: '协议版本是辅助元数据，未操作用户记录。',
        evidence: [result(f.state, 'version')],
      },
    ],
  };
  assert.equal((await reviewBusinessModel(f.session, review)).valid, false);
  const pack = await readAnalysisPack(f.session, 'product.mjs');
  await recordAnalysis(f.session, {
    records: [
      {
        unitId: helper.id,
        receiptIds: [pack.receipt.id],
        responsibility: '提供兼容性协商所需的固定协议版本号。',
        inputs: [],
        outputs: ['协议版本数字一'],
        conditions: [],
        calls: [],
        sideEffects: [],
        exceptions: [],
        unknowns: [],
        claims: [
          {
            pointIds: helper.reviewPoints.map((p) => p.id),
            detail: '固定返回协议版本一；不访问用户记录或修改存储。',
          },
        ],
      },
    ],
  });
  assert.equal(checkBusinessModel(f.session).valid, true);
});
