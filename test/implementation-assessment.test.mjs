import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFeature } from '../lib/feature-operations.mjs';
import { readSnapshot, listFeatures, applyChanges } from '../lib/document-operations.mjs';
import { assessImplementation, assessmentTargets } from '../lib/implementation-assessment.mjs';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  recordAnalysis,
} from '../lib/analysis-session.mjs';
import { checkSourceStatus } from '../lib/source-status.mjs';
import { checkVerificationPlans } from '../lib/verification-plan.mjs';
import { saveVerificationPlan } from '../lib/verification-plan.mjs';

async function fixture(t, { audit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-implementation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'access.mjs'),
    "export function allowed(role) { return role === 'admin'; }\n",
  );
  const feature = createFeature('access', {
    title: '角色访问',
    description: '仅允许管理员访问。',
    rules: ['仅管理员允许访问。'],
    checks: ['管理员允许、普通成员拒绝。', ...(audit ? ['每次访问写入审计记录。'] : [])],
    flow: [['检查角色', '按角色返回是否允许']],
    stepDetails: [
      {
        actor: '权限模块',
        description: '',
        rules: [],
        dependencies: [],
        result: '',
        exception: '',
        acceptance: '',
        interactions: [],
      },
    ],
  });
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      product: { name: '角色服务', background: '按角色限制访问。' },
      features: { access: feature },
      dependencies: [],
      diagrams: {},
    }),
  );
  const { session } = await scanAnalysis(root);
  const unit = loadSession(session).state.units[0];
  const read = await readAnalysis(session, unit.id);
  await recordAnalysis(session, {
    records: [
      {
        unitId: unit.id,
        receiptIds: [read.receipt.id],
        responsibility: '角色为 admin 时允许，否则拒绝。',
        inputs: ['role 是待判断角色。'],
        outputs: ['返回角色与 admin 比较的布尔结果。'],
        conditions: [],
        calls: [],
        sideEffects: [],
        exceptions: [],
        unknowns: [],
        coverage: unit.reviewPoints.map((point) => ({
          pointId: point.id,
          detail:
            point.field === 'inputs' ? 'role 是访问判断的输入角色。' : '比较 admin，返回是否允许。',
        })),
      },
    ],
  });
  const input = () => ({
    expectedHash: readSnapshot(filename).documentHash,
    revision: readSnapshot(filename).document.features.access.revision,
    items: assessmentTargets(readSnapshot(filename).document.features.access).map((target) => ({
      target,
      state: 'implemented',
      detail: 'allowed 使用严格相等比较 admin 并返回布尔值，普通成员返回 false。',
      unitIds: [unit.id],
      basis: [
        {
          kind: 'code',
          unitId: unit.id,
          pointIds: unit.reviewPoints.filter((p) => p.field === 'outputs').map((p) => p.id),
          detail: '严格比较 admin 后返回允许标志，其他角色拒绝访问。',
        },
      ],
    })),
  });
  return { root, filename, session, unit, input };
}

test('实现完成独立于运行验收；旧文档无依据时待确认，不冒充未实现', async (t) => {
  const f = await fixture(t);
  assert.equal(listFeatures(readSnapshot(f.filename)).features[0].status, 'unknown');
  const before = fs.readFileSync(f.filename, 'utf8');
  const preview = await assessImplementation(f.filename, 'access', f.session, f.input(), {
    dryRun: true,
  });
  assert.equal(preview.status, 'complete');
  assert.equal(preview.documentSaved, false);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  const saved = await assessImplementation(f.filename, 'access', f.session, f.input());
  assert.equal(saved.status, 'complete');
  assert.equal(saved.htmlUpdated, true);
  const record = readSnapshot(f.filename).document.features.access;
  assert.equal(record.implementedRevision, null);
  assert.equal(record.implementation, undefined);
  assert.equal(listFeatures(readSnapshot(f.filename), { status: 'complete' }).features.length, 1);
  assert.equal(
    (await checkSourceStatus(readSnapshot(f.filename).document)).features.access.status,
    'current',
  );
  assert.ok(checkVerificationPlans(f.filename, f.session).gaps.some((g) => g.kind === 'plan'));
});

test('草稿必须有明确未实现项，待确认项和批注分别保留，不用测试缺口代替实现缺口', async (t) => {
  const f = await fixture(t, { audit: true });
  const document = readSnapshot(f.filename).document;
  document.features.access.annotations = [
    {
      id: 'later',
      text: '下一步再讨论审计格式。',
      definitionRevision: 1,
      createdAt: '2026-10-17T00:00:00Z',
    },
  ];
  fs.writeFileSync(f.filename, JSON.stringify(document));
  const input = f.input();
  Object.assign(
    input.items.find((i) => i.target === '/checks/1'),
    { state: 'missing', detail: 'allowed 只返回权限结果，尚未写入审计记录。' },
  );
  const result = await assessImplementation(f.filename, 'access', f.session, input, {
    render: false,
  });
  assert.equal(result.status, 'draft');
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].target, '/checks/1');
  assert.equal(
    listFeatures(readSnapshot(f.filename), { status: 'draft' }).features[0].missing[0].detail,
    result.missing[0].detail,
  );
  assert.deepEqual(
    readSnapshot(f.filename).document.features.access.annotations,
    document.features.access.annotations,
  );
  const unknown = f.input();
  unknown.items.forEach((i) => {
    i.state = 'unknown';
    i.detail = '尚不能确认运行宿主是否提供该行为。';
  });
  const next = await assessImplementation(f.filename, 'access', f.session, unknown, {
    render: false,
  });
  assert.equal(next.status, 'unknown');
  assert.equal(next.missing.length, 0);
  assert.equal(
    readSnapshot(f.filename).document.features.access.implementationAssessmentHistory.length,
    1,
  );
});

test('缺位置、重复位置、伪造依据和过时版本不能保存；核对不重写业务或清理批注', async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.filename, 'utf8');
  const bad = [f.input(), f.input(), f.input(), f.input()];
  bad[0].items.pop();
  bad[1].items.push(bad[1].items[0]);
  bad[2].items[0].unitIds = ['u-missing'];
  bad[3].revision = 0;
  for (const input of bad) {
    await assert.rejects(assessImplementation(f.filename, 'access', f.session, input));
    assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  }
  await assessImplementation(f.filename, 'access', f.session, f.input(), { render: false });
  const saved = readSnapshot(f.filename).document.features.access;
  assert.equal(saved.revision, 1);
  assert.equal(saved.description, JSON.parse(before).features.access.description);
  await assert.rejects(
    assessImplementation(f.filename, 'access', f.session, JSON.parse(JSON.stringify(bad[0]))),
    { code: 'CONFLICT' },
  );
});

test('重命名不失效、业务定义变化转待确认，源码变化使新核对拒绝保存', async (t) => {
  const f = await fixture(t);
  await assessImplementation(f.filename, 'access', f.session, f.input(), { render: false });
  const change = (changes) =>
    applyChanges(
      f.filename,
      {
        version: 1,
        expectedHash: readSnapshot(f.filename).documentHash,
        operations: [{ op: 'feature.update', id: 'access', changes }],
      },
      { render: false },
    );
  await change({ title: '管理员访问', groupPath: ['权限'] });
  assert.equal(listFeatures(readSnapshot(f.filename)).features[0].status, 'complete');
  await change({ rules: ['管理员与审计员均允许。'] });
  assert.equal(listFeatures(readSnapshot(f.filename)).features[0].status, 'unknown');
  fs.appendFileSync(path.join(f.root, 'access.mjs'), '\n// changed\n');
  assert.equal(
    (await checkSourceStatus(readSnapshot(f.filename).document)).features.access.status,
    'changed',
  );
  await assert.rejects(assessImplementation(f.filename, 'access', f.session, f.input()), {
    code: 'ANALYSIS_STALE',
  });
});

test('实际 CLI 支持实现核对与机器可读规范', async (t) => {
  const f = await fixture(t);
  const cli = path.resolve('bin/product-blueprint.mjs');
  const schema = spawnSync(process.execPath, [cli, 'schema', '--assessment'], { encoding: 'utf8' });
  assert.equal(schema.status, 0, schema.stderr);
  assert.ok(JSON.parse(schema.stdout).properties.items);
  const response = spawnSync(
    process.execPath,
    [
      cli,
      'feature',
      'assess',
      'access',
      f.filename,
      '--analysis-session',
      f.session,
      '--input',
      '-',
      '--json',
    ],
    { input: JSON.stringify(f.input()), encoding: 'utf8' },
  );
  assert.equal(response.status, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).status, 'complete');
});

test('纯需求项目可明确记录尚未实现，需求原文不能充当完成依据', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-request-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const feature = createFeature('export', {
    title: '导出记录',
    description: '将记录导出为 CSV。',
    checks: ['CSV 包含全部记录。'],
    flow: [['导出', '生成 CSV 文件']],
    stepDetails: [
      {
        actor: '用户',
        description: '',
        rules: [],
        dependencies: [],
        result: '',
        exception: '',
        acceptance: '',
        interactions: [],
      },
    ],
  });
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      product: { name: '新产品' },
      features: { export: feature },
      dependencies: [],
    }),
  );
  const { session } = await scanAnalysis(root);
  const input = {
    expectedHash: readSnapshot(filename).documentHash,
    revision: 1,
    items: assessmentTargets(feature).map((target) => ({
      target,
      state: 'missing',
      detail: '项目还没有产品源码，CSV 导出尚未实现。',
      requirement: { source: 'user', text: '需要把全部记录导出为 CSV 文件。' },
    })),
  };
  const result = await assessImplementation(filename, 'export', session, input, { render: false });
  assert.equal(result.status, 'draft');
  assert.equal(result.missing.length, input.items.length);
  await saveVerificationPlan(filename, session, {
    id: 'export-plan',
    expectedHash: readSnapshot(filename).documentHash,
    featureId: 'export',
    goal: '先确认尚未实现的导出需求。',
    steps: [{ step: 0, level: 'source', scenarioIds: [] }],
    scenarios: [],
  });
  assert.equal(checkVerificationPlans(filename, session).gaps.length, 0);
  input.expectedHash = readSnapshot(filename).documentHash;
  input.items.forEach((item) => {
    item.state = 'implemented';
  });
  await assert.rejects(assessImplementation(filename, 'export', session, input), {
    code: 'INVALID_ARGUMENT',
  });
});
