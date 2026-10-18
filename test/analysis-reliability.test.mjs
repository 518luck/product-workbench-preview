import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  readAnalysisBatch,
  receiptCoverage,
  checkAnalysis,
} from '../lib/analysis-session.mjs';
import { readAnalysisState, mutableSnapshot, appendAnalysisState } from '../lib/analysis-store.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-reliability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('已读类型与嵌套函数不受后续空隙影响，真正的内部漏读仍被发现', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, 'main.ts'),
    'interface First {name:string}\n\nexport function outer(value:string) {const inner=(x:string)=>x;return inner(value);}\n\ninterface Last {id:number}\n\nexport function other(value:number){return value+1;}',
  );
  const { session } = await scanAnalysis(root),
    state = loadSession(session).state;
  const first = state.contexts.find((x) => x.name === 'First'),
    last = state.contexts.find((x) => x.name === 'Last');
  const outer = state.units.find((x) => x.name === 'outer'),
    other = state.units.find((x) => x.name === 'other');
  const batch = await readAnalysisBatch(session, {
    reads: [{ id: first.id }, { id: outer.id }, { id: other.id }],
  });
  const current = loadSession(session).state,
    ids = batch.items.map((x) => x.receipt.id);
  assert.equal(receiptCoverage(current, first, ids), true);
  assert.equal(receiptCoverage(current, last, ids), false);
  const inner = current.units.find((x) => x.name === 'inner');
  assert.equal(receiptCoverage(current, inner, ids), true);
  assert.ok(!checkAnalysis(session).gaps.some((x) => x.kind === 'context' && x.path === first.id));
  const partial = await readAnalysisBatch(session, {
    reads: [
      { id: last.id, length: 4 },
      { id: last.id, offset: 8 },
    ],
  });
  assert.equal(
    receiptCoverage(
      loadSession(session).state,
      last,
      partial.items.map((x) => x.receipt.id),
    ),
    false,
  );
});

test('批量读取原子保存到增量日志，支持损坏尾部恢复并拒绝已提交记录篡改', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, 'main.mjs'),
    'export function one(x){return x;}\nexport function two(x){return x+1;}',
  );
  const { session } = await scanAnalysis(root, {}, { storage: 'journal' }),
    filename = path.join(session, 'state.json'),
    base = fs.readFileSync(filename),
    state = loadSession(session).state;
  await assert.rejects(
    readAnalysisBatch(session, { reads: [{ id: state.units[0].id }, { id: 'missing' }] }),
  );
  assert.equal(Object.keys(loadSession(session).state.receipts).length, 0);
  const result = await readAnalysisBatch(session, {
    reads: state.units.map((x) => ({ id: x.id })),
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(fs.readFileSync(filename), base);
  assert.equal(loadSession(session).state.editRevision, 1);
  const journal = filename + '.events.jsonl',
    committed = fs.readFileSync(journal);
  fs.appendFileSync(journal, '{"interrupted":"😀');
  assert.equal(Object.keys(loadSession(session).state.receipts).length, 2);
  await readAnalysis(session, state.units[0].id);
  assert.equal(loadSession(session).state.editRevision, 2);
  assert.equal(fs.readFileSync(journal, 'utf8').includes('interrupted'), false);
  const corrupted = committed.toString().replace('contentHash', 'changedHash');
  fs.writeFileSync(journal, corrupted);
  assert.throws(() => loadSession(session), { code: 'ANALYSIS_STALE' });
});

test('大基础会话只追加本次增量，不重写整个 JSON', (t) => {
  const root = temporary(t),
    filename = path.join(root, 'state.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      version: 2,
      editRevision: 0,
      units: [{ code: 'x'.repeat(8 * 1024 * 1024) }],
      receipts: {},
      records: {},
      traces: {},
    }),
  );
  const before = fs.readFileSync(filename),
    { state, storage } = readAnalysisState(filename),
    snapshot = mutableSnapshot(state);
  state.receipts.read = { id: 'read' };
  state.editRevision++;
  appendAnalysisState(state, snapshot, storage);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.ok(fs.statSync(storage.journal).size < 1024);
  assert.equal(readAnalysisState(filename).state.receipts.read.id, 'read');
  const pending = readAnalysisState(filename),
    unchanged = fs.readFileSync(storage.journal);
  fs.appendFileSync(filename, '\n');
  pending.state.editRevision++;
  assert.throws(
    () => appendAnalysisState(pending.state, mutableSnapshot(pending.state), pending.storage),
    { code: 'ANALYSIS_STALE' },
  );
  assert.deepEqual(fs.readFileSync(storage.journal), unchanged);
});

test('已有记录的嵌套修改会落盘，只读取的记录不会重复追加', (t) => {
  const root = temporary(t),
    filename = path.join(root, 'state.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      version: 2,
      editRevision: 0,
      records: {
        changed: { coverage: [{ detail: '旧说明' }] },
        untouched: { coverage: [{ detail: '保留说明' }] },
      },
      receipts: {},
      traces: {},
    }),
  );
  const { state, storage } = readAnalysisState(filename),
    snapshot = mutableSnapshot(state);
  assert.equal(state.records.untouched.coverage[0].detail, '保留说明');
  state.records.changed.coverage[0].detail = '新的实际行为';
  state.editRevision++;
  appendAnalysisState(state, snapshot, storage);
  const changes = JSON.parse(fs.readFileSync(storage.journal, 'utf8')).changes;
  assert.deepEqual(Object.keys(changes.records), ['changed']);
  assert.equal(
    readAnalysisState(filename).state.records.changed.coverage[0].detail,
    '新的实际行为',
  );
});

test('进程被强杀后恢复死锁，多进程追加凭据不丢失；活锁和未知锁仍受保护', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export function one(x){return x;}');
  const { session } = await scanAnalysis(root),
    filename = path.join(session, 'state.json');
  const locks = new URL('../lib/file-lock.mjs', import.meta.url).href,
    api = new URL('../lib/analysis-session.mjs', import.meta.url).href;
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {withFileLock} from ${JSON.stringify(locks)};await withFileLock(${JSON.stringify(filename)},async()=>{setInterval(()=>{},10000);console.log('locked');await new Promise(()=>{});});`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (holder.exitCode === null) holder.kill('SIGKILL');
  });
  const ended = new Promise((resolve) => holder.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('lock timeout')), 5000);
    holder.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    holder.once('exit', () => {
      clearTimeout(timer);
      reject(Error('holder exited'));
    });
  });
  holder.kill('SIGKILL');
  await ended;
  assert.equal(holder.signalCode, 'SIGKILL');
  assert.ok(fs.existsSync(filename + '.write-lock'));
  const unit = loadSession(session).state.units[0];
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {readAnalysis} from ${JSON.stringify(api)};await readAnalysis(${JSON.stringify(session)},${JSON.stringify(unit.id)});`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let error = '';
      child.stderr.on('data', (x) => (error += x));
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve() : reject(Error(error))));
    });
  await Promise.all([run(), run(), run(), run()]);
  assert.equal(Object.keys(loadSession(session).state.receipts).length, 4);
  assert.equal(loadSession(session).state.editRevision, 4);
  assert.equal(fs.existsSync(filename + '.write-lock'), false);
  fs.writeFileSync(filename + '.write-lock', JSON.stringify({ pid: process.pid }));
  await assert.rejects(readAnalysis(session, unit.id), { code: 'CONFLICT' });
  fs.writeFileSync(filename + '.write-lock', 'unknown owner');
  await assert.rejects(readAnalysis(session, unit.id), { code: 'CONFLICT' });
});
