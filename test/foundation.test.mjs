import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventory, indexSnapshot } from '../lib/analysis-index.mjs';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  recordAnalysis,
} from '../lib/analysis-session.mjs';
import { createFeature } from '../lib/feature-operations.mjs';
import { readSnapshot } from '../lib/document-operations.mjs';
import { recordFlows, checkFlows } from '../lib/flow.mjs';
import { entryCoverage } from '../lib/entry-coverage.mjs';
import { saveVerificationPlan, limitationSupported } from '../lib/verification-plan.mjs';
import { runVerification, runEnvironmentDiagnostic } from '../lib/verification.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-foundation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('导出身份按真实符号识别，内部回调仍保留分析单元；别名、公开方法与事件入口不遗漏', (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, 'main.ts'),
    `
export function outer(values: string[]) { function inner(value: string) { return value; } return values.map(value => inner(value)); }
const alias = (value: string) => value; export {alias as publicAlias};
const implementation = (value: string) => value; export const aliasBinding = implementation;
const typeOnly = (value: string) => value; export type {typeOnly};
export class API { run(value: string) { const nested = () => value; return nested(); } private secret() {return 1;} #hidden(){return 2;} }
export namespace Public { export function publicWork() {return 1;} function privateWork(){return 2;} }
function listener() { return 1; } document.addEventListener('click', listener);
const map = new Map(); map.get(typeOnly);
`,
  );
  const indexed = indexSnapshot(inventory(root)),
    entries = indexed.facts.entries;
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('outer'));
  assert.ok(names.includes('alias'));
  assert.ok(names.includes('implementation'), '不可变变量别名导出仍保留真实函数入口');
  assert.ok(names.includes('run'));
  assert.ok(names.includes('publicWork'));
  assert.ok(
    entries.some(
      (entry) =>
        entry.kind === 'registration' &&
        entry.unitId === indexed.units.find((u) => u.name === 'listener').id,
    ),
  );
  for (const name of ['inner', 'nested', 'secret', '#hidden', 'privateWork', 'typeOnly']) {
    assert.ok(
      indexed.units.some((unit) => unit.name === name),
      `${name} 仍须逐函数分析`,
    );
    assert.ok(!names.includes(name), `${name} 不是独立导出或注册入口`);
  }
  const callback = indexed.units.find((u) => u.kind === 'arrow' && u.scope.includes('outer'));
  assert.ok(callback && !entries.some((entry) => entry.unitId === callback.id));
});

for (const [file, source] of [
  [
    'main.mjs',
    '// 中文 😀\nfunction make(v){return {run(){return v;}};} export function submit(v){return make(v).run();}',
  ],
  ['main.py', '# 中文 😀\ndef make(v): return v\ndef submit(v): return make(v).strip()\n'],
  [
    'main.go',
    '// 中文 😀\npackage sample\ntype Text string\nfunc (t Text) String() string{return string(t)}\nfunc make(v string) Text{return Text(v)}\nfunc submit(v string)string{return make(v).String()}\n',
  ],
  [
    'main.cpp',
    '// 中文 😀\nstruct Box{int run(){return 1;}}; Box make(int v){return {};} int submit(int v){return make(v).run();}\n',
  ],
])
  test(`${path.extname(file)} 同起点链式调用使用完整位置编号，结果绑定不会串到另一调用`, (t) => {
    const root = temporary(t);
    fs.writeFileSync(path.join(root, file), source);
    const indexed = indexSnapshot(inventory(root)),
      unit = indexed.units.find((u) => u.name === 'submit');
    const calls = unit.calls;
    assert.ok(
      calls.some((a) => calls.some((b) => a !== b && a.start === b.start && a.end !== b.end)),
      '样例确有同起点不同终点调用',
    );
    const all = indexed.units.flatMap((u) => u.calls);
    assert.equal(new Set(all.map((call) => call.id)).size, all.length);
    for (const call of calls) {
      assert.ok(call.end > call.start);
      const fact = indexed.facts.values.find((value) => value.id === call.resultId);
      assert.equal(fact.callId, call.id);
      assert.equal(fact.start, call.start);
      assert.equal(fact.end, call.end);
    }
  });

const roleSummary = (unit, receiptIds) => ({
  unitId: unit.id,
  receiptIds,
  responsibility: '角色严格等于 admin 时允许，其余角色拒绝。',
  inputs: unit.reviewPoints.some((p) => p.field === 'inputs') ? ['role 是访问判断的角色。'] : [],
  outputs: unit.reviewPoints.some((p) => p.field === 'outputs')
    ? ['返回是否等于 admin 的布尔结果。']
    : [],
  conditions: [],
  calls: [],
  sideEffects: [],
  exceptions: [],
  unknowns: [],
  coverage: unit.reviewPoints.map((point) => ({
    pointId: point.id,
    detail:
      point.field === 'inputs'
        ? 'role 是待与 admin 比较的访问角色。'
        : '比较角色与 admin，相等返回 true，不相等返回 false。',
  })),
});
async function fixture(t, extra = '') {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, 'access.mjs'),
    "export function allowed(role){return role==='admin';}\n" + extra,
  );
  fs.writeFileSync(
    path.join(root, 'contract.md'),
    '外部角色服务通过 role-service.sock 接入；这个边界不由本机权限函数实现。\n',
  );
  const feature = createFeature('access', {
    title: '角色访问',
    description: '仅允许管理员访问。',
    checks: ['管理员允许，成员拒绝。'],
    flow: [['判断角色', '按 admin 返回是否允许']],
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
      product: { name: '角色产品' },
      features: { access: feature, other: { ...feature, id: 'other', title: '另一功能' } },
      dependencies: [],
    }),
  );
  const { session } = await scanAnalysis(root, { contexts: ['contract.md'] }),
    state = loadSession(session).state;
  for (const unit of state.units) {
    const read = await readAnalysis(session, unit.id);
    await recordAnalysis(session, { records: [roleSummary(unit, [read.receipt.id])] });
  }
  await readAnalysis(session, state.contexts[0].id);
  return {
    root,
    filename,
    session,
    state,
    unit: state.units.find((u) => u.name === 'allowed'),
    context: state.contexts[0],
  };
}
const sourcePlan = (f, limitation) => ({
  id: 'role-plan',
  featureId: 'access',
  expectedHash: readSnapshot(f.filename).documentHash,
  goal: '按管理员角色限制访问。',
  steps: [
    {
      step: 0,
      level: 'source',
      unitIds: [f.unit.id],
      scenarioIds: [],
      ...(limitation ? { limitation } : {}),
    },
  ],
  scenarios: [],
});

test('带函数名或源码片段的机械摘要仍被拒绝，不以位置数量代替行为理解', async (t) => {
  const f = await fixture(t),
    read = await readAnalysis(f.session, f.unit.id);
  for (const change of [
    (r) => {
      r.responsibility = '核心实现模块 access.mjs：定义 allowed 的业务计算与状态流转。';
    },
    (r) => {
      r.coverage[0].detail = '输入参数 role 接收调用方传入的数据。';
    },
    (r) => {
      r.coverage[1].detail = `依据判断条件 role==='admin' 决定控制流走向。`;
    },
    (r) => {
      r.outputs = ["返回：return role==='admin';"];
    },
  ]) {
    const record = roleSummary(f.unit, [read.receipt.id]);
    change(record);
    await assert.rejects(recordAnalysis(f.session, { records: [record] }), {
      code: 'ANALYSIS_INCOMPLETE',
    });
  }
  await recordAnalysis(f.session, { records: [roleSummary(f.unit, [read.receipt.id])] });
});

test('入口归类关联当前业务步骤，旧理由不能豁免，库函数排除有源码依据且不跨产品书', async (t) => {
  const f = await fixture(t, "export function unused(role){return role==='admin';}\n");
  await saveVerificationPlan(f.filename, f.session, sourcePlan(f));
  let report = checkFlows(f.filename, f.session);
  assert.equal(report.pendingEntries.length, 1);
  const entry = report.pendingEntries[0];
  await recordFlows(f.filename, f.session, {
    expectedHash: readSnapshot(f.filename).documentHash,
    flows: [],
    dispositions: [{ entryId: entry.id, reason: '暂时不处理。' }],
  });
  assert.equal(checkFlows(f.filename, f.session).pendingEntries.length, 1);
  await assert.rejects(
    recordFlows(f.filename, f.session, {
      expectedHash: readSnapshot(f.filename).documentHash,
      flows: [],
      dispositions: [{ entryId: entry.id, kind: 'non-business', reason: '全部都是内部工具。' }],
    }),
    /具体函数或文件/,
  );
  await recordFlows(f.filename, f.session, {
    expectedHash: readSnapshot(f.filename).documentHash,
    flows: [],
    dispositions: [
      {
        entryId: entry.id,
        kind: 'non-business',
        reason: 'unused 是未被产品调用的权限样例辅助函数，不作为本书的用户旅程入口。',
      },
    ],
  });
  report = checkFlows(f.filename, f.session);
  assert.equal(report.pendingEntries.length, 0);
  assert.equal(report.entryCoverage.excluded.length, 1);
  const current = loadSession(f.session).state;
  assert.equal(
    entryCoverage(
      current,
      readSnapshot(f.filename).document,
      path.join(f.root, 'another-book.json'),
    ).pending.length,
    2,
  );
});

test('只有工具实际诊断且绑定当前功能的障碍能支持限制；文档、假日志和跨功能记录均不行', async (t) => {
  const f = await fixture(t);
  const gap = { kind: 'semantic', language: 'cpp', message: '缺少编译数据库' };
  const state = { ...f.state, gaps: [...f.state.gaps, gap] };
  assert.equal(
    limitationSupported(
      {
        kind: 'adapter',
        reason: '声称 C++ 缺口影响 JS 访问判断',
        evidence: { kind: 'analysis-gap', language: gap.language, message: gap.message },
      },
      state,
      f.session,
      { step: { unitIds: [f.unit.id] } },
    ),
    false,
  );
  const external = {
    kind: 'external',
    reason: '外部角色服务的本机连接入口不存在。',
    evidence: { kind: 'context', id: f.context.id },
  };
  await assert.rejects(
    saveVerificationPlan(f.filename, f.session, sourcePlan(f, external)),
    /真实能力缺口/,
  );
  const fake = await runVerification(f.filename, 'access', f.session, {
    command: process.execPath,
    args: ['-e', "console.log('not available');process.exit(1)"],
    purpose: 'environment',
  });
  external.evidence.executionId = fake.executionId;
  await assert.rejects(
    saveVerificationPlan(f.filename, f.session, sourcePlan(f, external)),
    /真实能力缺口/,
  );
  const other = await runEnvironmentDiagnostic(f.filename, 'other', f.session, {
    kind: 'file',
    target: 'role-service.sock',
  });
  external.evidence.executionId = other.executionId;
  await assert.rejects(
    saveVerificationPlan(f.filename, f.session, sourcePlan(f, external)),
    /真实能力缺口/,
  );
  const unrelated = await runEnvironmentDiagnostic(f.filename, 'access', f.session, {
    kind: 'file',
    target: 'unrelated.sock',
  });
  external.evidence.executionId = unrelated.executionId;
  await assert.rejects(
    saveVerificationPlan(f.filename, f.session, sourcePlan(f, external)),
    /真实能力缺口/,
  );
  const actual = await runEnvironmentDiagnostic(f.filename, 'access', f.session, {
    kind: 'file',
    target: 'role-service.sock',
  });
  assert.equal(actual.diagnostic.available, false);
  external.evidence.executionId = actual.executionId;
  await saveVerificationPlan(f.filename, f.session, sourcePlan(f, external));
  const present = await runEnvironmentDiagnostic(f.filename, 'access', f.session, {
    kind: 'file',
    target: 'access.mjs',
  });
  assert.equal(present.diagnostic.available, true);
  await assert.rejects(
    saveVerificationPlan(
      f.filename,
      f.session,
      sourcePlan(f, {
        kind: 'environment',
        reason: '声称文件缺失',
        evidence: { kind: 'execution', id: present.executionId },
      }),
    ),
    /真实能力缺口/,
  );
  const cli = spawnSync(
    process.execPath,
    [
      path.resolve('bin/product-blueprint.mjs'),
      'verification',
      'diagnose',
      'access',
      f.filename,
      '--analysis-session',
      f.session,
      '--input',
      '-',
      '--json',
    ],
    { input: JSON.stringify({ kind: 'command', target: process.execPath }), encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).diagnostic.available, true);
});
