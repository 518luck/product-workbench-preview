import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { inventory, hash } from '../lib/analysis-index.mjs';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  recordAnalysis,
  traceAnalysis,
  checkAnalysis,
} from '../lib/analysis-session.mjs';
import { applyChanges, readSnapshot } from '../lib/document-operations.mjs';

function workspace(t, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-cross-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return { directory, root };
}

test('独立执行样例证明回调与多态目标可变化，索引不能将类型签名当作确定目标', async (t) => {
  const source = `function first() { return 'first'; }
function second() { return 'second'; }
function invoke(fn: typeof first) { return fn(); }
function reassigned() { return 'before'; }
reassigned = second;
class Base { execute() { return 'base'; } }
class Child extends Base { execute() { return 'child'; } }
function operate(value: Base) { return value.execute(); }
export function run(flag: boolean) {
  let selected = first; if (flag) selected = second;
  return [selected(), invoke(second), reassigned(), operate(flag ? new Child() : new Base())];
}`;
  const { directory, root } = workspace(t, { 'dynamic.ts': source });
  const scan = await scanAnalysis(root),
    state = loadSession(scan.session).state;
  const runtime = path.join(directory, 'oracle.mjs');
  fs.writeFileSync(
    runtime,
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    }).outputText,
  );
  const actual = await import(pathToFileURL(runtime).href);
  assert.deepEqual(actual.run(false), ['first', 'second', 'second', 'base']);
  assert.deepEqual(actual.run(true), ['second', 'second', 'second', 'child']);
  const calls = state.units.flatMap((unit) => unit.calls);
  for (const expression of ['selected', 'fn', 'reassigned', 'value.execute', 'Child', 'Base']) {
    const call = calls.find((call) => call.expression === expression);
    assert.ok(call, expression);
    assert.equal(call.status, 'unknown', expression);
    assert.equal(call.target, null, expression);
  }
  for (const expression of ['invoke', 'operate'])
    assert.equal(
      calls.find((call) => call.expression === expression).status,
      'resolved',
      expression,
    );
});

test('真正的静态导入、不可变别名与显式构造器仍可解析；不会退化为全部未知', async (t) => {
  const { root } = workspace(t, {
    'worker.ts':
      'export function save(value: number) { return value; } export class Store { constructor(public value: number) {} }',
    'main.ts':
      "import * as actions from './worker'; import {save as persist, Store} from './worker'; const immutable = persist; actions.save(1); immutable(2); new Store(3);",
  });
  const state = loadSession((await scanAnalysis(root)).session).state;
  const calls = state.units.flatMap((unit) => unit.calls),
    save = state.units.find((unit) => unit.name === 'save'),
    constructor = state.units.find((unit) => unit.kind === 'constructor');
  for (const expression of ['actions.save', 'immutable'])
    assert.equal(calls.find((call) => call.expression === expression).target, save.id, expression);
  assert.equal(calls.find((call) => call.expression === 'Store').target, constructor.id);
});

test('损坏的 JSON、JSONC、JS 配置和其他语言，完整读取记录后仍明确报告缺口', async (t) => {
  const { root } = workspace(t, {
    'src/main.ts': 'export function run() { return 1; }',
    'package.json': '{ broken JSON',
    'sub/tsconfig.json': '{ "compilerOptions": ',
    'vite.config.js': 'export default { plugins: [',
    'setup.sh': '#!/bin/sh\necho setup',
  });
  const scan = await scanAnalysis(root),
    state = loadSession(scan.session).state;
  for (const file of ['package.json', 'sub/tsconfig.json', 'vite.config.js'])
    assert.ok(
      scan.gaps.some((gap) => gap.file === file && gap.kind === 'config'),
      file,
    );
  assert.ok(scan.gaps.some((gap) => gap.file === 'setup.sh' && gap.kind === 'language'));
  for (const unit of state.units) {
    const read = await readAnalysis(scan.session, unit.id);
    await recordAnalysis(scan.session, {
      records: [
        {
          unitId: unit.id,
          receiptIds: [read.receipt.id],
          responsibility: '返回常量 1',
          inputs: [],
          outputs: ['1'],
          conditions: [],
          calls: [],
          sideEffects: [],
          exceptions: [],
          unknowns: [],
        },
      ],
    });
  }
  for (const context of state.contexts) await readAnalysis(scan.session, context.id);
  const report = checkAnalysis(scan.session);
  assert.equal(report.valid, false);
  assert.ok(report.gaps.some((gap) => gap.kind === 'config'));
  assert.ok(report.gaps.some((gap) => gap.kind === 'language'));
});

test('索引算法升级后不能恢复旧符号关系和凭据，源码相同也要求重新扫描', async (t) => {
  const { root } = workspace(t, { 'main.js': 'function run() {return true} run();' });
  const current = inventory(root),
    oldHash = hash(
      JSON.stringify({
        root: current.root,
        parser: '6.0.2',
        protocol: 1,
        scope: current.scope,
        manifest: current.manifest.filter((item) =>
          ['source', 'types', 'context', 'unsupported', 'unreadable'].includes(item.kind),
        ),
      }),
    );
  const scan = await scanAnalysis(root),
    filename = path.join(scan.session, 'state.json'),
    state = loadSession(scan.session).state;
  state.snapshotHash = oldHash;
  delete state.indexVersion;
  fs.writeFileSync(filename, JSON.stringify(state));
  const oldSession = path.join(path.dirname(scan.session), `s-${oldHash}`);
  fs.renameSync(scan.session, oldSession);
  assert.throws(() => checkAnalysis(oldSession), { code: 'ANALYSIS_STALE' });
  assert.notEqual(scan.snapshotHash, oldHash);
  const rescanned = await scanAnalysis(root);
  assert.equal(rescanned.resumed, false);
  assert.equal(rescanned.snapshotHash, scan.snapshotHash);
});

test('输入遵循 Schema，未知写入必须在文档原文显式标注，部分分析不能豁免', async (t) => {
  const { root } = workspace(t, { 'main.js': 'function run() {return true}' });
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      product: { name: '交叉核验', background: '', actors: [] },
      features: {},
      dependencies: [],
      diagrams: {},
    }),
  );
  const scan = await scanAnalysis(root),
    unit = loadSession(scan.session).state.units[0],
    read = await readAnalysis(scan.session, unit.id);
  await recordAnalysis(scan.session, {
    records: [
      {
        unitId: unit.id,
        receiptIds: [read.receipt.id],
        responsibility: '返回 true',
        inputs: [],
        outputs: ['true'],
        conditions: [],
        calls: [],
        sideEffects: [],
        exceptions: [],
        unknowns: [],
      },
    ],
  });
  const requirement = [
    { kind: 'requirement', source: 'user', text: '记录功能需求及尚未核实的事项。' },
  ];
  await assert.rejects(
    traceAnalysis(scan.session, {
      traces: [
        {
          id: 'bad-note',
          target: '/features/run/description',
          value: '返回 true',
          classification: 'requested',
          evidence: requirement,
          note: 42,
        },
      ],
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  const description = '用户执行该功能，获得 true 结果。';
  await traceAnalysis(scan.session, {
    traces: [
      {
        id: 'definition',
        target: '/features/run/description',
        value: description,
        classification: 'requested',
        evidence: requirement,
      },
    ],
  });
  const request = (operations) => ({
    version: 1,
    expectedHash: readSnapshot(filename).documentHash,
    operations,
  });
  await applyChanges(
    filename,
    request([{ op: 'feature.create', id: 'run', data: { title: '执行功能', description } }]),
    { analysisSession: scan.session, render: false },
  );
  const uncertain = '异常分支尚未核实。';
  await traceAnalysis(scan.session, {
    traces: [
      {
        id: 'uncertain-note',
        target: '/features/run/notes',
        value: uncertain,
        classification: 'unknown',
        evidence: requirement,
        note: '没有完整业务证据。',
      },
    ],
  });
  await assert.rejects(
    applyChanges(
      filename,
      request([{ op: 'feature.update', id: 'run', changes: { notes: uncertain } }]),
      { analysisSession: scan.session, allowPartialAnalysis: true, render: false },
    ),
    { code: 'ANALYSIS_INCOMPLETE' },
  );
  const labelled = `[未知] ${uncertain}`;
  await traceAnalysis(scan.session, {
    traces: [
      {
        id: 'uncertain-note',
        target: '/features/run/notes',
        value: labelled,
        classification: 'unknown',
        evidence: requirement,
        note: '没有完整业务证据。',
      },
    ],
  });
  await applyChanges(
    filename,
    request([{ op: 'feature.update', id: 'run', changes: { notes: labelled } }]),
    { analysisSession: scan.session, render: false },
  );
  assert.equal(readSnapshot(filename).document.features.run.notes, labelled);
  assert.equal(readSnapshot(filename).document.features.run.implementedRevision, null);
});
