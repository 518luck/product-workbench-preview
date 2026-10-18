import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAnalysis, loadSession } from '../lib/analysis-session.mjs';
import {
  recordBusinessModel,
  reviewBusinessModel,
  checkBusinessModel,
} from '../lib/business-model.mjs';

test('真实源码点不能证明无关入口；同一分派器的其他命令和 else 分支不能串用', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-business-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'cli.mjs'),
    `export function enable(){return 'enabled'}export function disable(){return 'disabled'}export function snapshot(){return 'status'}const command=process.argv[2];if(command==='enable'){enable()}else{disable()}`,
  );
  const { session } = await scanAnalysis(root),
    state = loadSession(session).state;
  const operation = state.facts.operations.find((o) => o.trigger.command === 'enable');
  const evidence = (name) => {
    const unit = state.units.find((u) => u.name === name);
    return {
      kind: 'code',
      unitId: unit.id,
      pointId: unit.reviewPoints.find((p) => p.kind === 'return').id,
      detail: '核对这一具体结果，不能用同文件的其他业务替代。',
    };
  };
  const input = {
    version: 1,
    capabilities: [
      {
        id: 'enable',
        title: '开启',
        actor: '用户',
        goal: '开启功能',
        outcome: '开启成功',
        operationIds: [operation.id],
        results: [evidence('enable')],
      },
    ],
    dispositions: state.facts.operations
      .filter((o) => o.id !== operation.id)
      .map((o) => ({
        operationId: o.id,
        source: o.registration.file,
        reason: '本测试只核对 enable 分支；其他独立操作作为限定样例的非业务支撑保留。',
      })),
  };
  assert.equal((await recordBusinessModel(session, input)).valid, true);
  for (const wrong of ['disable', 'snapshot']) {
    input.capabilities[0].results = [evidence(wrong)];
    const saved = await recordBusinessModel(session, input);
    assert.equal(saved.valid, false, wrong);
    assert.ok(saved.connections[0].gaps.length);
    await reviewBusinessModel(session, {
      modelHash: saved.model.recordHash,
      reviewer: 'same-agent',
      decisions: [
        {
          capabilityId: 'enable',
          verdict: 'supported',
          reason: '即使文字声称支持，也不能消除机器发现的断链。',
          evidence: input.capabilities[0].results,
        },
      ],
    });
    assert.equal(checkBusinessModel(session).valid, false);
  }
});

test('注册回调不等于调用；确有已解析跨文件调用时能关联结果，错误的同名变量不能连接', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-business-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'store.mjs'), `export function persist(){return 'saved'}`);
  fs.writeFileSync(
    path.join(root, 'main.mjs'),
    `import {persist} from './store.mjs';export function save(){return persist()}export function subscribe(){queue.on('save',persist)}export function wrong(persist){return persist()}`,
  );
  const { session } = await scanAnalysis(root),
    state = loadSession(session).state;
  const unit = state.units.find((u) => u.name === 'persist'),
    result = {
      kind: 'code',
      unitId: unit.id,
      pointId: unit.reviewPoints.find((p) => p.kind === 'return').id,
      detail: '持久化函数返回 saved；注册和遮蔽变量不证明执行它。',
    };
  for (const name of ['save', 'subscribe', 'wrong']) {
    const op = state.facts.operations.find(
      (o) => o.surface === 'library' && o.trigger.name === name,
    );
    const input = {
      version: 1,
      capabilities: [
        {
          id: 'save',
          title: '保存',
          actor: '用户',
          goal: '保存内容',
          outcome: '获得保存结果',
          operationIds: [op.id],
          results: [result],
        },
      ],
      dispositions: state.facts.operations
        .filter((o) => o.id !== op.id)
        .map((o) => ({
          operationId: o.id,
          source: o.registration.file,
          reason: '限定样例的独立操作，不用它扩大该入口的证明范围。',
        })),
    };
    assert.equal((await recordBusinessModel(session, input)).valid, name === 'save', name);
  }
});
