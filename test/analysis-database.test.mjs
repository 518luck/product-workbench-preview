import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIndexedState, indexedIntegrity } from '../lib/analysis-database.mjs';
import { readAnalysisState, mutableSnapshot, appendAnalysisState } from '../lib/analysis-store.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-row-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'state.json');
  const state = {
    version: 2,
    editRevision: 0,
    units: [
      {
        id: 'u-one',
        file: 'one.ts',
        name: 'one',
        calls: [],
        reviewPoints: [],
        code: 'x'.repeat(1024 * 1024),
      },
    ],
    facts: { values: [], edges: [] },
    records: Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        'r' + i,
        { detail: 'body' + i + '-'.repeat(2048), nested: { value: i } },
      ]),
    ),
    receipts: {},
    traces: {},
  };
  createIndexedState(filename, state);
  return { root, filename };
}
test('新会话按需读取索引/记录；更新一条记录不加载其他正文，嵌套修改和删除原子保存', (t) => {
  const { filename } = fixture(t);
  assert.ok(fs.statSync(filename).size < 512);
  const { state, storage } = readAnalysisState(filename);
  assert.deepEqual(storage.stats, { immutableRowsRead: 0, mutableRowsRead: 0 });
  assert.equal(state.units[0].name, 'one');
  assert.equal(storage.stats.immutableRowsRead, 0);
  const before = mutableSnapshot(state);
  state.records.r40.nested.value = 900;
  delete state.records.r41;
  state.editRevision++;
  appendAnalysisState(state, before, storage);
  assert.equal(storage.stats.immutableRowsRead, 0);
  assert.equal(storage.stats.mutableRowsRead, 1);
  const next = readAnalysisState(filename);
  assert.equal(next.state.records.r40.nested.value, 900);
  assert.equal(next.state.records.r41, undefined);
  assert.equal(Object.keys(next.state.records).length, 79);
  assert.equal(next.state.records.r39.nested.value, 39);
  assert.equal(next.state.units[0].code.length, 1024 * 1024);
  assert.equal(next.storage.stats.immutableRowsRead, 1);
});
test('索引头、正文篡改及会话内机器事实修改被拒绝；旧版本并发保存不能覆盖新数据', (t) => {
  const { filename, root } = fixture(t);
  const first = readAnalysisState(filename),
    second = readAnalysisState(filename);
  const before = mutableSnapshot(second.state);
  second.state.records.new = { value: 'new' };
  second.state.editRevision++;
  appendAnalysisState(second.state, before, second.storage);
  const old = mutableSnapshot(first.state);
  first.state.records.old = { value: 'old' };
  first.state.editRevision++;
  assert.throws(() => appendAnalysisState(first.state, old, first.storage), {
    code: 'ANALYSIS_STALE',
  });
  const current = readAnalysisState(filename);
  current.state.units.push({ id: 'fake' });
  assert.throws(() => indexedIntegrity(current.state), { code: 'ANALYSIS_STALE' });
  const db = new DatabaseSync(path.join(root, 'state.sqlite'));
  db.prepare("UPDATE immutable SET body=? WHERE collection='units'").run('{"id":"fake"}');
  const tampered = readAnalysisState(filename);
  assert.throws(() => tampered.state.units[0].code, { code: 'ANALYSIS_STALE' });
  db.prepare("UPDATE immutable SET summary=? WHERE collection='units'").run('{"id":"fake"}');
  db.close();
  assert.throws(() => readAnalysisState(filename), { code: 'ANALYSIS_STALE' });
});
