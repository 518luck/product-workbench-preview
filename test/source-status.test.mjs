import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventory, PARSER_VERSION, INDEX_VERSION } from '../lib/analysis-index.mjs';
import {
  snapshotFromAnalysis,
  sourceSnapshotHash,
  validSourceSnapshot,
  checkSourceStatus,
} from '../lib/source-status.mjs';
import { createDocumentServer } from '../lib/document-server.mjs';
import { validateDocument } from '../lib/document.mjs';
import { applyChanges, readSnapshot } from '../lib/document-operations.mjs';

const id = 'stock-receipt';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-source-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'product.mjs'), 'export function total(n) { return n + 1; }\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"name":"source-check-fixture","type":"module"}',
  );
  const document = JSON.parse(
    fs.readFileSync(new URL('../examples/minimal-product.json', import.meta.url), 'utf8'),
  );
  const source = inventory(root),
    sourceSnapshot = snapshotFromAnalysis({
      ...source,
      snapshotHash: source.fingerprint,
      parserVersion: PARSER_VERSION,
      indexVersion: INDEX_VERSION,
    });
  document.features[id].implementedRevision = document.features[id].revision;
  document.features[id].implementation = {
    revision: 1,
    verifiedAt: '2026-10-14T00:00:00Z',
    checks: [{ name: '临时验收记录', result: 'passed' }],
    sourceSnapshot,
  };
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(filename, JSON.stringify(document));
  return { root, document, filename, sourceSnapshot };
}

test('源码内容指纹发现未提交修改、新增删除及配置变化，保持完成记录和文档原文', async (t) => {
  const { root, filename, document } = fixture(t);
  assert.equal(validateDocument(document).valid, true);
  assert.equal((await checkSourceStatus(document)).features[id].status, 'current');
  const before = fs.readFileSync(filename, 'utf8'),
    stat = fs.statSync(path.join(root, 'product.mjs'));
  fs.writeFileSync(path.join(root, 'product.mjs'), 'export function total(n) { return n + 2; }\n');
  fs.utimesSync(path.join(root, 'product.mjs'), stat.atime, stat.mtime);
  fs.writeFileSync(path.join(root, 'added.ts'), 'export const enabled = true;');
  fs.rmSync(path.join(root, 'package.json'));
  const changed = (await checkSourceStatus(document)).features[id];
  assert.equal(changed.status, 'changed');
  assert.deepEqual(
    changed.changes.map(({ file, change }) => [file, change]),
    [
      ['added.ts', 'added'],
      ['package.json', 'deleted'],
      ['product.mjs', 'modified'],
    ],
  );
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal(document.features[id].implementedRevision, 1);
  fs.writeFileSync(path.join(root, 'product.mjs'), 'export function total(n) { return n + 1; }\n');
  fs.rmSync(path.join(root, 'added.ts'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"name":"source-check-fixture","type":"module"}',
  );
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), '仅版本控制元数据变化');
  assert.equal((await checkSourceStatus(document)).features[id].status, 'current');
});

test('缺少基线、扫描根不存在或基线格式错误不会显示源码已核验', async (t) => {
  const { document, sourceSnapshot } = fixture(t);
  const previous = structuredClone(document);
  delete document.features[id].implementation.sourceSnapshot;
  assert.equal((await checkSourceStatus(document)).features[id].status, 'unverified');
  document.features[id].implementation.sourceSnapshot = structuredClone(sourceSnapshot);
  document.features[id].implementation.sourceSnapshot.root += '/missing';
  document.features[id].implementation.sourceSnapshot.snapshotHash = sourceSnapshotHash(
    document.features[id].implementation.sourceSnapshot,
  );
  assert.equal((await checkSourceStatus(document)).features[id].status, 'unavailable');
  document.features[id].implementation.sourceSnapshot = structuredClone(sourceSnapshot);
  document.features[id].implementation.sourceSnapshot.manifest[0].hash = 'bad';
  assert.equal(validateDocument(document).valid, false);
  assert.equal((await checkSourceStatus(document)).features[id].status, 'unavailable');
  assert.equal(validSourceSnapshot(null), false);
  await assert.rejects(
    applyChanges(
      path.join(sourceSnapshot.root, 'product-document.json'),
      {
        version: 1,
        expectedHash: readSnapshot(path.join(sourceSnapshot.root, 'product-document.json'))
          .documentHash,
        operations: [
          {
            op: 'feature.complete',
            id,
            revision: 1,
            implementation: previous.features[id].implementation,
          },
        ],
      },
      { render: false },
    ),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('只读 CLI 和本机端点比较当前源码，解析规则变化也提示核验且不执行源码', async (t) => {
  const { root, filename, document, sourceSnapshot } = fixture(t);
  const source = path.join(root, 'product.mjs');
  fs.writeFileSync(source, 'throw new Error("不得执行项目代码");');
  const cli = spawnSync(
    process.execPath,
    [
      new URL('../bin/product-blueprint.mjs', import.meta.url).pathname,
      'document',
      'status',
      filename,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).sourceStatus.features[id].status, 'changed');
  const server = createDocumentServer({ documentPath: filename });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/document/source-status`;
  assert.equal((await (await fetch(url)).json()).features[id].status, 'changed');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  const before = fs.readFileSync(filename, 'utf8');
  fs.writeFileSync(source, 'export function total(n) { return n + 1; }\n');
  document.features[id].implementation.sourceSnapshot = {
    ...sourceSnapshot,
    indexVersion: INDEX_VERSION + 1,
  };
  document.features[id].implementation.sourceSnapshot.snapshotHash = sourceSnapshotHash(
    document.features[id].implementation.sourceSnapshot,
  );
  const checked = (await checkSourceStatus(document)).features[id];
  assert.equal(checked.status, 'changed');
  assert.equal(checked.configurationChanged, true);
  assert.deepEqual(checked.changes, []);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});
