import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanAnalysis,
  loadSession,
  readAnalysisPack,
  recordAnalysis,
  checkAnalysis,
} from '../lib/analysis-session.mjs';

const explain = {
  twice: 'The supplied quantity is doubled to calculate a pair count.',
  consume: 'The caller delegates pair counting to twice and forwards its result.',
  half: 'The supplied quantity is divided into two equal shares.',
};
async function record(session, file) {
  const pack = await readAnalysisPack(session, file);
  const state = loadSession(session).state;
  await recordAnalysis(session, {
    records: state.units
      .filter((u) => u.file === file)
      .map((u) => ({
        unitId: u.id,
        receiptIds: [pack.receipt.id],
        responsibility:
          explain[u.name] ||
          'The import binds the independently analyzed pair counter into this module.',
        inputs: ['A numeric quantity is supplied by the caller.'],
        outputs: [explain[u.name] || 'The imported counter is available for delegation.'],
        conditions: [],
        calls: u.calls.length ? ['Delegates to the imported pair counter.'] : [],
        sideEffects: [],
        exceptions: [],
        unknowns: [],
        claims: u.reviewPoints.length
          ? [{ pointIds: u.reviewPoints.map((p) => p.id), detail: explain[u.name] }]
          : [],
      })),
  });
}

test('相同快照恢复不重建索引；改动按依赖反向失效，仅完整且未受影响的分析可携带出处复用', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-incremental-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'math.mjs': `export function twice(value){return value*2}`,
    'use.mjs': `import {twice} from './math.mjs';export function consume(value){return twice(value)}`,
    'independent.mjs': `export function half(value){return value/2}`,
  };
  for (const [file, code] of Object.entries(files)) fs.writeFileSync(path.join(root, file), code);
  const first = await scanAnalysis(root);
  assert.equal(first.indexRebuilt, true);
  for (const file of Object.keys(files)) await record(first.session, file);
  assert.equal(checkAnalysis(first.session).valid, true);
  const warm = await scanAnalysis(root);
  assert.equal(warm.session, first.session);
  assert.equal(warm.indexRebuilt, false);
  assert.equal(warm.recordedCount, 3);
  fs.appendFileSync(path.join(root, 'math.mjs'), '\n// change dependency');
  const changed = await scanAnalysis(root),
    state = loadSession(changed.session).state;
  assert.equal(changed.reuse.records, 1);
  assert.equal(changed.recordedCount, 1);
  assert.deepEqual(changed.reuse.invalidatedFiles, ['math.mjs', 'use.mjs']);
  const stable = state.units.find((u) => u.name === 'half'),
    recorded = state.records[stable.id];
  assert.equal(recorded.reusedFrom.snapshotHash, first.snapshotHash);
  assert.equal(state.receipts[recorded.receiptIds[0]].provenance.kind, 'unchanged-analysis-reuse');
  assert.equal(state.businessModels.current, undefined);
  assert.equal(Object.keys(state.traces).length, 0);
  assert.ok(checkAnalysis(changed.session).gaps.length, '受影响的两个函数仍待处理，不能继承完成');
});

test('上下文或规则改变、全局源码不能被缓存静默复用', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-incremental-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'math.mjs'), `export function twice(value){return value*2}`);
  fs.writeFileSync(path.join(root, 'README.md'), 'Pair counter');
  const first = await scanAnalysis(root, { contexts: ['README.md'] });
  await record(first.session, 'math.mjs');
  fs.appendFileSync(path.join(root, 'README.md'), ' changed requirement');
  const changed = await scanAnalysis(root, { contexts: ['README.md'] });
  assert.equal(changed.recordedCount, 0);
  fs.writeFileSync(path.join(root, 'global.js'), 'const shared=1');
  const global = await scanAnalysis(root, { contexts: ['README.md'] });
  await record(global.session, 'math.mjs');
  fs.appendFileSync(path.join(root, 'global.js'), '\nshared');
  assert.equal((await scanAnalysis(root, { contexts: ['README.md'] })).recordedCount, 0);
});

test('Python 静态导入反向失效并复用独立文件；不完整旧记录不能换成新凭据', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-python-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'arithmetic.py': 'def twice(value):\n    return value*2\n',
    'use.py': 'from arithmetic import twice\ndef consume(value):\n    return twice(value)\n',
    'isolated.py': 'def half(value):\n    return value/2\n',
  };
  for (const [file, source] of Object.entries(files))
    fs.writeFileSync(path.join(root, file), source);
  const first = await scanAnalysis(root);
  for (const file of Object.keys(files)) await record(first.session, file);
  fs.appendFileSync(path.join(root, 'arithmetic.py'), '\n# edited dependency');
  const changed = await scanAnalysis(root);
  assert.equal(changed.reuse.records, 1);
  assert.deepEqual(changed.reuse.invalidatedFiles, ['arithmetic.py', 'use.py']);
  const current = loadSession(changed.session).state,
    u = current.units.find((u) => u.name === 'half');
  delete current.records[u.id].claims;
  fs.writeFileSync(path.join(changed.session, 'state.json'), JSON.stringify(current));
  fs.appendFileSync(path.join(root, 'use.py'), '\n# another edit');
  assert.equal(
    (await scanAnalysis(root)).recordedCount,
    0,
    '旧浅摘要不能凭已有记录数量迁移成合格分析',
  );
});

test('Python 动态导入换别名或相对依赖未解析时，不能静默复用同语言的旧分析', async (t) => {
  for (const code of [
    'import importlib as loader\ndef load(name):\n    return loader.import_module(name)\n',
    'from builtins import __import__ as resolve\ndef load(name):\n    return resolve(name)\n',
    'from .missing import value\ndef load(name):\n    return value(name)\n',
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-python-dynamic-reuse-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'loader.py'), code);
    fs.writeFileSync(path.join(root, 'target.py'), 'def twice(value):\n    return value*2\n');
    fs.writeFileSync(path.join(root, 'isolated.py'), 'def half(value):\n    return value/2\n');
    const first = await scanAnalysis(root);
    assert.equal(
      loadSession(first.session).state.incremental.files['loader.py'].conservative,
      true,
    );
    await record(first.session, 'isolated.py');
    fs.appendFileSync(path.join(root, 'target.py'), '\n# changed possible dynamic target');
    const changed = await scanAnalysis(root);
    assert.equal(changed.reuse.records, 0);
    assert.deepEqual(changed.reuse.invalidatedFiles, ['isolated.py', 'loader.py', 'target.py']);
  }
});
