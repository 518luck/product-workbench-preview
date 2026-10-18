import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanAnalysis, loadSession, readAnalysisPack } from '../lib/analysis-session.mjs';
import { getWorkflowConfig, setWorkflowConfig } from '../lib/workflow-config.mjs';
import { recordDiscovery, checkDiscovery } from '../lib/discovery.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-discovery-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'notes.mjs'),
    `import http from 'node:http';
export function create(text){return {text};}
export function remove(id){return id;}
http.createServer((req,res)=>{if(req.url==='/create')return res.end(JSON.stringify(create('note')));if(req.url==='/remove')return res.end(remove('id'));});`,
  );
  fs.writeFileSync(
    path.join(root, 'SKILL.md'),
    '# 通知准备\n整理通知内容后交给调用者，不发送通知。',
  );
  await setWorkflowConfig(
    root,
    {
      version: 1,
      skills: {
        init: { enabled: true, stages: ['discover'] },
        verify: { enabled: false },
        implement: { enabled: false },
      },
    },
    getWorkflowConfig(root).configHash,
  );
  const { session } = await scanAnalysis(root),
    { state } = loadSession(session),
    ops = state.facts.operations;
  const capabilities = ['create', 'remove'].map((name) => {
    const u = state.units.find((u) => u.name === name);
    return {
      id: name,
      title: name === 'create' ? '新增便笺' : '删除便笺',
      actor: '便笺用户',
      goal: name === 'create' ? '保存便笺文字' : '删除指定便笺',
      outcome: name === 'create' ? '获得新增内容' : '获得删除编号',
      operationIds: ops
        .filter(
          (o) =>
            (o.surface === 'library' && o.trigger.name === name) ||
            (o.surface === 'http' && o.trigger.path === '/' + name),
        )
        .map((o) => o.id),
      results: [
        {
          kind: 'code',
          unitId: u.id,
          pointId: u.reviewPoints.find((p) => p.kind === 'return').id,
          detail: name === 'create' ? '返回包含本次便笺文字的对象。' : '返回所选便笺的编号。',
        },
      ],
    };
  });
  const workflow = ops.find((o) => o.surface === 'workflow');
  capabilities.push({
    id: 'prepare-message',
    title: '准备通知',
    actor: '委托者',
    goal: '整理通知内容',
    outcome: '返回整理后的内容，保留未发送边界',
    operationIds: [workflow.id],
    results: [{ kind: 'context', contextId: workflow.contextId, quote: '不发送通知' }],
  });
  const covered = new Set(capabilities.flatMap((c) => c.operationIds));
  const input = {
    version: 1,
    model: {
      version: 1,
      capabilities,
      dispositions: ops
        .filter((o) => !covered.has(o.id))
        .map((o) => ({
          operationId: o.id,
          kind: 'internal',
          source: o.registration.file,
          reason: '启动 HTTP 容器并注册请求处理器，具体便笺路由分别归属新增与删除目标。',
        })),
    },
    modules: [
      {
        directory: '.',
        status: 'mapped',
        capabilityIds: ['create', 'remove'],
        reason: '便笺服务分别暴露新增内容和删除编号的操作。',
      },
    ],
  };
  return { root, session, state, input };
}

test('业务发现独立完成且不要求函数记录；保留工作流以外的目标，不创建或修改产品书', async (t) => {
  const f = await fixture(t);
  assert.equal(checkDiscovery(f.session).stage, 'not-started');
  const unread = await recordDiscovery(f.session, f.input);
  assert.equal(unread.valid, false);
  assert.ok(unread.gaps.some((g) => g.kind === 'reading'));
  for (const file of ['notes.mjs', 'SKILL.md']) await readAnalysisPack(f.session, file);
  const result = await recordDiscovery(f.session, f.input);
  assert.equal(result.valid, true, JSON.stringify(result.gaps));
  assert.equal(result.completion.claim, 'discovery-ready');
  assert.equal(result.initializationComplete, false);
  assert.equal(result.bookGenerated, false);
  assert.equal(result.runtimeVerified, false);
  assert.equal(Object.keys(loadSession(f.session).state.records).length, 0);
  assert.equal(loadSession(f.session).state.businessModels.current, undefined);
  assert.equal(fs.existsSync(path.join(f.root, '.blueprint')), false);
  assert.deepEqual(
    checkDiscovery(f.session).capabilities.map((c) => c.id),
    ['create', 'remove', 'prepare-message'],
  );
});

test('只保留工作流并排除页面/HTTP 等真实操作不能通过发现；未读和未归类模块可保存但不算完成', async (t) => {
  const f = await fixture(t);
  for (const file of ['notes.mjs', 'SKILL.md']) await readAnalysisPack(f.session, file);
  const input = structuredClone(f.input),
    workflow = input.model.capabilities.at(-1);
  input.model.capabilities = [workflow];
  input.model.dispositions = f.state.facts.operations
    .filter((o) => !workflow.operationIds.includes(o.id))
    .map((o, i) => ({
      operationId: o.id,
      source: o.registration.file,
      kind: o.surface === 'http' ? 'false-positive' : 'internal',
      reason: `内部工具${JSON.stringify(o.trigger)}辅助运行序号${i}`,
    }));
  input.modules = [
    {
      directory: '.',
      status: 'pending',
      capabilityIds: [],
      reason: '尚未核对便笺服务目标，保留后续处理。',
    },
  ];
  const result = await recordDiscovery(f.session, input);
  assert.equal(result.saved, true);
  assert.equal(result.valid, false);
  assert.equal(result.completion.claim, null);
  assert.ok(result.gaps.some((g) => g.kind === 'business'));
  assert.ok(result.gaps.some((g) => g.kind === 'module'));
});

test('发现状态绑定配置、源码和规则，恢复不相信旧成功；关闭阶段不保存新记录', async (t) => {
  const f = await fixture(t);
  for (const file of ['notes.mjs', 'SKILL.md']) await readAnalysisPack(f.session, file);
  await recordDiscovery(f.session, f.input);
  const settings = getWorkflowConfig(f.root),
    next = structuredClone(settings.config);
  next.skills.init.enabled = false;
  await setWorkflowConfig(f.root, next, settings.configHash);
  assert.equal(checkDiscovery(f.session).stage, 'stale');
  const before = loadSession(f.session).state.businessModels.discovery.recordHash;
  await assert.rejects(recordDiscovery(f.session, f.input), { code: 'WORKFLOW_BLOCKED' });
  assert.equal(loadSession(f.session).state.businessModels.discovery.recordHash, before);
  fs.appendFileSync(path.join(f.root, 'notes.mjs'), '\n// changed');
  assert.throws(() => checkDiscovery(f.session), { code: 'ANALYSIS_STALE' });
});

test('独立发现的实际 CLI 支持标准输入与非零缺口，恢复读取保存结果', async (t) => {
  const f = await fixture(t),
    cli = new URL('../bin/product-blueprint.mjs', import.meta.url).pathname;
  for (const file of ['notes.mjs', 'SKILL.md']) await readAnalysisPack(f.session, file);
  const run = (args, input) =>
    spawnSync(process.execPath, [cli, ...args, '--session', f.session, '--json'], {
      input: input && JSON.stringify(input),
      encoding: 'utf8',
    });
  assert.equal(run(['discovery', 'check']).status, 1);
  const saved = run(['discovery', 'record', '--input', '-'], f.input);
  assert.equal(saved.status, 0, saved.stdout + saved.stderr);
  assert.equal(JSON.parse(run(['discovery', 'check']).stdout).stage, 'ready');
});
