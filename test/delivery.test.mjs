import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  scanAnalysis,
  readAnalysis,
  recordAnalysis,
  traceAnalysis,
  loadSession,
} from '../lib/analysis-session.mjs';
import { createFeature } from '../lib/feature-operations.mjs';
import { readSnapshot, applyChanges } from '../lib/document-operations.mjs';
import { renderDocument } from '../lib/document.mjs';
import { runVerification } from '../lib/verification.mjs';
import { checkDelivery } from '../lib/delivery.mjs';
import { recordFlows } from '../lib/flow.mjs';
import { syncFlowStatus } from '../lib/flow-status.mjs';

const cli = new URL('../bin/product-blueprint.mjs', import.meta.url).pathname;
const skip = {
  decision: 'skipped',
  reason: '此权限判断只有一个输入输出，无跨参与者交互或存储关系。',
};
async function fixture(t, { analyzed = true, unrelatedLanguage = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'access.mjs'),
    "export function allowed(role) { return role === 'admin'; }\n",
  );
  if (unrelatedLanguage)
    fs.writeFileSync(path.join(root, 'legacy.rb'), 'def legacy; :unknown; end\n');
  const f = createFeature('access', {
    title: '管理员访问',
    description: '仅管理员允许访问。',
    rules: ['普通成员拒绝。'],
    checks: ['admin 允许，member 拒绝。'],
    flow: [['检查角色', '检查角色是否为管理员']],
    stepDetails: [
      {
        actor: '权限模块',
        description: '检查管理员角色',
        rules: ['普通成员拒绝。'],
        dependencies: [],
        result: '返回是否允许访问。',
        exception: '普通成员拒绝。',
        acceptance: 'admin 允许，member 拒绝。',
        interactions: [],
      },
    ],
  });
  f.flowRevision = 1;
  const filename = path.join(root, 'product-document.json');
  const document = {
    schemaVersion: 1,
    product: { name: '权限产品', background: '按角色控制访问。' },
    features: { access: f },
    dependencies: [],
    diagrams: {},
  };
  fs.writeFileSync(filename, JSON.stringify(document, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'index.html'), renderDocument(document));
  const scan = await scanAnalysis(root);
  if (analyzed) {
    const unit = loadSession(scan.session).state.units[0],
      read = await readAnalysis(scan.session, unit.id);
    const saved = await recordAnalysis(scan.session, {
      records: [
        {
          unitId: unit.id,
          receiptIds: [read.receipt.id],
          responsibility: '检查角色是否为 admin',
          inputs: ['角色'],
          outputs: ['是否允许访问'],
          conditions: ['admin 允许；其他角色拒绝'],
          calls: [],
          sideEffects: [],
          exceptions: [],
          unknowns: [],
          coverage: unit.reviewPoints.map((point) => ({
            pointId: point.id,
            detail:
              point.kind === 'parameter'
                ? 'role 是待检查的角色。'
                : '仅 admin 返回允许，其他角色返回拒绝。',
          })),
        },
      ],
    });
    const traces = [];
    function visit(value, target) {
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) visit(v, target + '/' + k);
      } else if (value !== '')
        traces.push({
          id: 'evidence-' + traces.length,
          target,
          value,
          classification: 'observed',
          evidence: [{ kind: 'code', unitId: unit.id, recordHash: saved.records[0].recordHash }],
        });
    }
    for (const field of ['description', 'rules', 'flow', 'stepDetails', 'checks', 'dependencies'])
      visit(f[field], '/features/access/' + field);
    await traceAnalysis(scan.session, { traces });
  }
  const unit = loadSession(scan.session).state.units[0];
  await recordFlows(filename, scan.session, {
    expectedHash: readSnapshot(filename).documentHash,
    flows: [
      {
        id: 'access-flow',
        title: '按角色检查权限',
        entryId: `entry-${unit.id}`,
        nodes: [
          {
            id: 'check',
            featureId: 'access',
            step: 0,
            unitId: unit.id,
            inputs: unit.parameters,
            outputs: unit.returns,
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
  return { root, filename, session: scan.session };
}
const command = {
  command: process.execPath,
  args: [
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict'; import {allowed} from './access.mjs'; assert.equal(allowed('admin'),true); assert.equal(allowed('member'),false);",
  ],
};
function review(filename, outcome = 'implemented') {
  const s = readSnapshot(filename);
  return structuredClone({
    version: 3,
    flows: ['access-flow'],
    acknowledgedGaps: [],
    documentHash: s.documentHash,
    journeys: [
      {
        title: '按角色访问',
        outcome: '获得允许或拒绝结果',
        evidence: 'access.mjs allowed',
        steps: [{ featureId: 'access', step: 0 }],
      },
    ],
    features: [
      {
        id: 'access',
        revision: s.document.features.access.revision,
        outcome,
        content: { rules: { decision: 'included' }, dependencies: skip },
        acceptance:
          outcome === 'implemented' && s.document.features.access.implementation
            ? ['normal', 'exception'].map((scenario) => ({
                criterion: 0,
                steps: [0],
                scenario,
                executionId: s.document.features.access.implementation.checks[0].executionId,
                evidence: '命令中 assert.equal 分别验证 admin 与 member。',
              }))
            : [],
        diagrams: { sequence: skip, dataflow: skip },
      },
    ],
    diagrams: { architecture: skip, entities: skip },
  });
}
async function complete(f, receipt, { strict = true } = {}) {
  const s = readSnapshot(f.filename);
  const result = await applyChanges(
    f.filename,
    {
      version: 1,
      expectedHash: s.documentHash,
      operations: [
        {
          op: 'feature.complete',
          id: 'access',
          revision: 1,
          implementation: {
            revision: 1,
            verifiedAt: new Date().toISOString(),
            checks: [
              {
                name: '管理员和普通成员真实执行验收',
                result: 'passed',
                ...(receipt ? { executionId: receipt.executionId } : {}),
              },
            ],
          },
        },
      ],
    },
    { analysisSession: f.session, requireVerification: strict },
  );
  {
    const stored = Object.values(loadSession(f.session).state.flows)[0];
    const { id, title, entryId, nodes, edges, scenarios } = stored;
    await recordFlows(f.filename, f.session, {
      expectedHash: readSnapshot(f.filename).documentHash,
      flows: [{ id, title, entryId, nodes, edges, scenarios }],
    });
  }
  for (const scenarioId of ['normal', 'exception'])
    await runVerification(f.filename, 'access', f.session, {
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import {allowed} from './access.mjs';allowed('${scenarioId === 'normal' ? 'admin' : 'member'}');`,
      ],
      flow: { id: 'access-flow', scenarioId },
    });
  return result;
}

test('独立功能验收可先完成，流程追踪未执行时保持未核验且严格交付仍失败', async (t) => {
  const f = await fixture(t),
    run = await runVerification(f.filename, 'access', f.session, command),
    s = readSnapshot(f.filename);
  await applyChanges(
    f.filename,
    {
      version: 1,
      expectedHash: s.documentHash,
      operations: [
        {
          op: 'feature.complete',
          id: 'access',
          revision: 1,
          implementation: {
            revision: 1,
            verifiedAt: new Date().toISOString(),
            checks: [
              {
                name: '管理员允许、成员拒绝的真实断言',
                result: 'passed',
                executionId: run.executionId,
              },
            ],
          },
        },
      ],
    },
    { analysisSession: f.session, requireVerification: true },
  );
  await syncFlowStatus(f.filename, f.session);
  const document = readSnapshot(f.filename).document;
  assert.equal(document.features.access.implementedRevision, 1);
  assert.equal(document.flowVerification.features.access.status, 'unverified');
  const delivery = await checkDelivery(f.filename, f.session, review(f.filename));
  assert.equal(delivery.valid, false);
  assert.ok(delivery.gaps.some((x) => x.kind === 'execution'));
  assert.equal(readSnapshot(f.filename).document.features.access.implementedRevision, 1);
});

test('交付检查拒绝只保存草稿及未完成分析；具体新需求可交付，旧哈希和无理由图表跳过拒绝', async (t) => {
  const f = await fixture(t, { analyzed: false });
  const r = await checkDelivery(f.filename, f.session, review(f.filename, 'unverified'));
  assert.equal(r.valid, false);
  assert.ok(r.gaps.some((g) => g.kind === 'record'));
  const other = await fixture(t);
  const current = review(other.filename, 'requested');
  current.features[0].reason = '未来需要增加编辑权限。';
  current.features[0].evidence = '用户原文：请允许编辑角色访问。';
  const partial = await checkDelivery(other.filename, other.session, current);
  assert.equal(partial.valid, false);
  current.acknowledgedGaps = partial.gaps.map((gap) => ({
    kind: gap.kind,
    path: gap.path || gap.flowId || gap.entryId || '/',
    reason: '未来需求尚未实现；保留具体业务连接和执行缺口。',
  }));
  assert.equal(
    (await checkDelivery(other.filename, other.session, current)).deliverable,
    false,
    '只在审阅 JSON 写缺口不等于产品书可见',
  );
  await syncFlowStatus(other.filename, other.session);
  current.documentHash = readSnapshot(other.filename).documentHash;
  assert.equal(
    (await checkDelivery(other.filename, other.session, current)).deliverable,
    false,
    '漏执行不能仅凭填写缺口说明进入部分交付；新需求可用 v4 源码范围交付',
  );
  current.documentHash = '0'.repeat(64);
  delete current.diagrams.entities.reason;
  const rejected = await checkDelivery(other.filename, other.session, current);
  assert.ok(rejected.gaps.some((g) => g.kind === 'stale'));
  assert.ok(rejected.gaps.some((g) => g.kind === 'diagram'));
});
test('真实命令生成验收记录，严格完成和最终交付通过；CLI检查只读且可结构化读取', async (t) => {
  const f = await fixture(t);
  const receipt = await runVerification(f.filename, 'access', f.session, command);
  assert.equal(receipt.valid, true);
  await complete(f, receipt);
  const input = review(f.filename),
    before = fs.readFileSync(f.filename, 'utf8');
  const report = await checkDelivery(f.filename, f.session, input);
  assert.equal(report.stage, 'ready', JSON.stringify(report.gaps));
  assert.ok(
    (await checkDelivery(f.filename, f.session, { ...input, version: 1 })).gaps.some(
      (gap) => gap.kind === 'review',
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'document',
      'check',
      f.filename,
      '--analysis-session',
      f.session,
      '--input',
      '-',
      '--json',
    ],
    { input: JSON.stringify(input), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).valid, true);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  fs.writeFileSync(path.join(f.root, 'index.html'), '旧快照');
  assert.ok(
    (await checkDelivery(f.filename, f.session, input)).gaps.some((g) => g.kind === 'html'),
  );
});
test('空 passed 声明在严格完成及交付时被拒绝；旧手动记录仍可读取', async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.filename, 'utf8');
  await assert.rejects(complete(f), { code: 'VERIFICATION_FAILED' });
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  await complete(f, undefined, { strict: false });
  assert.ok(
    (await checkDelivery(f.filename, f.session, review(f.filename))).gaps.some(
      (g) => g.kind === 'verification',
    ),
  );
});
test('失败、超时、超量输出和被篡改日志的验收不能登记完成', async (t) => {
  const f = await fixture(t);
  for (const input of [
    { command: process.execPath, args: ['-e', 'process.exit(1)'] },
    { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 },
    { command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(2*1024*1024))"] },
  ]) {
    const r = await runVerification(f.filename, 'access', f.session, input);
    assert.equal(r.valid, false);
    await assert.rejects(complete(f, r), { code: 'VERIFICATION_FAILED' });
  }
  const r = await runVerification(f.filename, 'access', f.session, command);
  fs.appendFileSync(r.record.replace('.json', '.stdout.log'), '篡改');
  await assert.rejects(complete(f, r), { code: 'VERIFICATION_FAILED' });
});
test('验收绑定文档与功能，执行期间定义或源码变化拒绝完成', async (t) => {
  const f = await fixture(t),
    other = await fixture(t);
  const r = await runVerification(f.filename, 'access', f.session, command);
  fs.cpSync(path.join(f.session, 'verifications'), path.join(other.session, 'verifications'), {
    recursive: true,
  });
  await assert.rejects(complete(other, r), { code: 'VERIFICATION_FAILED' });
  const mutate = {
    command: process.execPath,
    args: [
      '-e',
      "const fs=require('fs');const f='product-document.json';const d=JSON.parse(fs.readFileSync(f));d.features.access.description='已改变的定义';fs.writeFileSync(f,JSON.stringify(d));",
    ],
  };
  assert.equal(
    (await runVerification(f.filename, 'access', f.session, mutate)).documentStable,
    false,
  );
  assert.equal(
    (
      await runVerification(other.filename, 'access', other.session, {
        command: process.execPath,
        args: ['-e', "require('fs').appendFileSync('access.mjs','// changed')"],
      })
    ).sourceStable,
    false,
  );
});
test('verification run CLI执行验收，不将输入当作 shell，并拒绝缺失会话和未知输入字段', async (t) => {
  const f = await fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'verification',
      'run',
      'access',
      f.filename,
      '--analysis-session',
      f.session,
      '--input',
      '-',
      '--json',
    ],
    { input: JSON.stringify(command), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).valid, true);
  await assert.rejects(
    runVerification(f.filename, 'access', f.session, { ...command, shell: true }),
    { code: 'INVALID_ARGUMENT' },
  );
  const failed = spawnSync(
    process.execPath,
    [cli, 'verification', 'run', 'access', f.filename, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(failed.status, 2);
  const document = JSON.parse(fs.readFileSync(f.filename));
  document.features.access.description = '';
  fs.writeFileSync(f.filename, JSON.stringify(document));
  await assert.rejects(
    runVerification(f.filename, 'access', f.session, {
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync('must-not-run','executed')"],
    }),
    { code: 'VALIDATION_FAILED' },
  );
  assert.equal(fs.existsSync(path.join(f.root, 'must-not-run')), false);
});
test('影响业务的未知默认阻止完成；独立边界说明保留备注且不冒充完成依据', async (t) => {
  const f = await fixture(t);
  const document = JSON.parse(fs.readFileSync(f.filename));
  const value = '[未知] 调用方宿主的用户角色获取方式未核验；当前功能仅按传入值判断权限。';
  document.features.access.notes = value;
  fs.writeFileSync(f.filename, JSON.stringify(document));
  fs.writeFileSync(path.join(f.root, 'index.html'), renderDocument(document));
  const state = loadSession(f.session).state;
  const record = Object.values(state.records)[0];
  const trace = {
    id: 'host-boundary',
    target: '/features/access/notes',
    value,
    classification: 'unknown',
    note: '宿主取值方式不在此功能定义内；已实际验证当前输入值的允许和拒绝，不以宿主未知支持验收。',
    evidence: [{ kind: 'code', unitId: record.unitId, recordHash: record.recordHash }],
  };
  await traceAnalysis(f.session, { traces: [trace] });
  const receipt = await runVerification(f.filename, 'access', f.session, command);
  await assert.rejects(complete(f, receipt), { code: 'ANALYSIS_INCOMPLETE' });
  await assert.rejects(
    traceAnalysis(f.session, {
      traces: [
        {
          ...trace,
          id: 'invalid-impact',
          target: '/features/access/rules/0',
          completionImpact: 'informational',
        },
      ],
    }),
    { code: 'VALIDATION_FAILED' },
  );
  await traceAnalysis(f.session, { traces: [{ ...trace, completionImpact: 'informational' }] });
  await complete(f, receipt);
  const result = await checkDelivery(f.filename, f.session, review(f.filename));
  assert.equal(result.valid, true, JSON.stringify(result.gaps));
  assert.equal(readSnapshot(f.filename).document.features.access.notes, value);
});

test('无关语言能力缺口不把独立验收功能降成草稿；全书严格检查仍失败且缺口可见', async (t) => {
  const f = await fixture(t, { unrelatedLanguage: true });
  const run = await runVerification(f.filename, 'access', f.session, command);
  const result = await complete(f, run);
  assert.equal(result.analysis.independentCompletion, true);
  assert.ok(result.analysis.gaps.some((gap) => gap.kind === 'language'));
  const feature = readSnapshot(f.filename).document.features.access;
  assert.equal(feature.implementedRevision, feature.revision);
  await syncFlowStatus(f.filename, f.session);
  const input = review(f.filename),
    first = await checkDelivery(f.filename, f.session, input);
  assert.equal(first.valid, false);
  assert.ok(first.gaps.some((gap) => gap.kind === 'language'));
  input.acknowledgedGaps = first.gaps.map((gap) => ({
    kind: gap.kind,
    path: gap.path || gap.flowId || gap.entryId || '/',
    reason:
      'legacy.rb 尚无语言适配器；权限函数的当前正常与拒绝行为已有独立真实验收，保留其他范围缺口。',
  }));
  const final = await checkDelivery(f.filename, f.session, input);
  assert.equal(final.deliverable, true, JSON.stringify(final.gaps));
  assert.equal(final.stage, 'partial');
  assert.equal(
    readSnapshot(f.filename).document.features.access.implementedRevision,
    feature.revision,
  );
});
