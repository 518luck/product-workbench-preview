import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getWorkflowConfig,
  setWorkflowConfig,
  workflowPlan,
  requireWorkflow,
  workflowConfigName,
} from '../lib/workflow-config.mjs';

const config = {
  version: 1,
  skills: {
    init: { enabled: true, stages: ['discover'] },
    verify: { enabled: false },
    implement: { enabled: false },
  },
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-workflow-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('无配置兼容完整工作流；阶段开关不会运行模型、创建书或自动开启其他 Skill', async (t) => {
  const root = fixture(t),
    before = getWorkflowConfig(root);
  assert.equal(before.configured, false);
  assert.equal(workflowPlan(root).executionMode, 'legacy-full');
  assert.deepEqual(fs.readdirSync(root), []);
  await setWorkflowConfig(root, config, before.configHash);
  const plan = workflowPlan(root);
  assert.equal(plan.valid, true);
  assert.equal(plan.executionMode, 'discovery-only');
  assert.equal(plan.initializationComplete, false);
  assert.deepEqual(
    plan.stages.filter((s) => s.selected).map((s) => s.name),
    ['discover'],
  );
  assert.equal(workflowPlan(root, { skill: 'verify' }).valid, false);
  assert.throws(() => requireWorkflow(root, { skill: 'implement' }), { code: 'WORKFLOW_BLOCKED' });
  assert.deepEqual(fs.readdirSync(root), [workflowConfigName]);
});

test('配置冲突、拼错、无效 JSON 和符号链接不回退默认全量任务', async (t) => {
  const root = fixture(t),
    before = getWorkflowConfig(root);
  await setWorkflowConfig(root, config, before.configHash);
  await assert.rejects(setWorkflowConfig(root, { ...config, version: 2 }, before.configHash), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(setWorkflowConfig(root, config, before.configHash), { code: 'CONFLICT' });
  const bad = structuredClone(config);
  bad.skills.init.stages = ['disocver'];
  await assert.rejects(setWorkflowConfig(root, bad, getWorkflowConfig(root).configHash), {
    code: 'INVALID_ARGUMENT',
  });
  fs.writeFileSync(path.join(root, workflowConfigName), '{broken');
  assert.throws(() => workflowPlan(root), { code: 'INVALID_ARGUMENT' });
  fs.unlinkSync(path.join(root, workflowConfigName));
  fs.writeFileSync(path.join(root, 'other.json'), JSON.stringify(config));
  fs.symlinkSync('other.json', path.join(root, workflowConfigName));
  assert.throws(() => getWorkflowConfig(root), { code: 'INVALID_ARGUMENT' });
});

test('未启用或未提供的独立阶段被明确阻止；实现依赖的核验关闭时不开始实现', async (t) => {
  const root = fixture(t);
  await setWorkflowConfig(root, config, getWorkflowConfig(root).configHash);
  assert.equal(workflowPlan(root, { stage: 'compose' }).valid, false);
  const changed = structuredClone(config);
  changed.skills.init.stages = ['analyze'];
  changed.skills.implement.enabled = true;
  await setWorkflowConfig(root, changed, getWorkflowConfig(root).configHash);
  assert.ok(workflowPlan(root).gaps.some((g) => g.kind === 'unavailable'));
  assert.ok(workflowPlan(root, { skill: 'implement' }).gaps.some((g) => g.kind === 'dependency'));
});

test('实际 CLI 读取/保存/计划及 schema；被关闭任务返回非零，不创建任务产物', (t) => {
  const root = fixture(t),
    cli = new URL('../bin/product-blueprint.mjs', import.meta.url).pathname;
  const run = (args, input) =>
    spawnSync(process.execPath, [cli, ...args, '--json'], {
      cwd: root,
      input: input && JSON.stringify(input),
      encoding: 'utf8',
    });
  const current = run(['workflow', 'get', root]);
  assert.equal(current.status, 0);
  assert.equal(
    run(
      [
        'workflow',
        'set',
        root,
        '--input',
        '-',
        '--expected-hash',
        JSON.parse(current.stdout).configHash,
      ],
      config,
    ).status,
    0,
  );
  assert.equal(run(['workflow', 'plan', root, '--skill', 'init']).status, 0);
  const disabled = run(['workflow', 'plan', root, '--skill', 'verify']);
  assert.equal(disabled.status, 1);
  assert.equal(JSON.parse(disabled.stdout).valid, false);
  assert.equal(run(['schema', '--workflow']).status, 0);
  assert.equal(run(['schema', '--workflow', '--discovery']).status, 2);
  assert.deepEqual(fs.readdirSync(root), [workflowConfigName]);
});
