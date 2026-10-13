import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChanges, readSnapshot, listFeatures } from '../lib/document-operations.mjs';
import { validateDocument } from '../lib/document.mjs';
const example = fileURLToPath(new URL('../examples/minimal-product.json', import.meta.url));
const id = 'stock-receipt';
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-completion-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'product-document.json');
  fs.copyFileSync(example, filename);
  return filename;
}
const record = (revision, extras = {}) => ({
  revision,
  verifiedAt: '2026-10-13T00:00:00Z',
  checks: [{ name: '验证保存的数量和批次', result: 'passed' }],
  ...extras,
});
const request = (filename, operations, extras = {}) => ({
  version: 1,
  expectedHash: readSnapshot(filename).documentHash,
  operations,
  ...extras,
});
const complete = (revision, implementation = record(revision)) => ({
  op: 'feature.complete',
  id,
  revision,
  implementation,
});
const apply = (filename, operations, extras) =>
  applyChanges(filename, request(filename, operations, extras), { render: false });

test('完成登记绑定当前版本，名称和分组变化不会失效，业务变化保留旧验收', async (t) => {
  const filename = temporary(t);
  await apply(filename, [complete(1)]);
  assert.equal(listFeatures(readSnapshot(filename), { status: 'complete' }).features.length, 1);
  await apply(filename, [
    { op: 'feature.update', id, changes: { title: '到货确认', groupPath: ['库存', '确认'] } },
  ]);
  assert.equal(readSnapshot(filename).document.features[id].revision, 1);
  await apply(filename, [
    { op: 'feature.update', id, changes: { checks: ['确认批次与数量持久化。'] } },
  ]);
  const current = readSnapshot(filename).document.features[id];
  assert.equal(current.revision, 2);
  assert.equal(current.implementedRevision, 1);
  assert.equal(current.implementation.revision, 1);
  assert.equal(current.flowRevision, 1);
  assert.equal(listFeatures(readSnapshot(filename), { status: 'draft' }).features.length, 1);
});

test('流程未同步和旧版本验收拒绝完成，同批同步后登记只增加一次保存版本', async (t) => {
  const filename = temporary(t);
  await apply(filename, [{ op: 'feature.define', id, description: '确认批次和数量后记录到货。' }]);
  const before = fs.readFileSync(filename, 'utf8');
  await assert.rejects(apply(filename, [complete(2)]), { code: 'VALIDATION_FAILED' });
  await assert.rejects(apply(filename, [complete(1)]), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  await apply(filename, [{ op: 'feature.sync', id }, complete(2)]);
  const current = readSnapshot(filename).document.features[id];
  assert.equal(current.revision, 2);
  assert.equal(current.editRevision, 2);
  assert.equal(current.flowRevision, 2);
  assert.equal(current.implementedRevision, 2);
});

test('新建或业务变化须先保存再实现验收，不能在同批直接宣布完成', async (t) => {
  const filename = temporary(t);
  await assert.rejects(
    apply(filename, [
      { op: 'feature.update', id, changes: { rules: ['新业务规则。'] } },
      { op: 'feature.sync', id },
      complete(2),
    ]),
    { code: 'VALIDATION_FAILED' },
  );
  await assert.rejects(
    apply(filename, [
      {
        op: 'feature.create',
        id: 'new-feature',
        data: {
          title: '新功能',
          description: '保存新记录。',
          flow: [['保存', '记录数据']],
          stepDetails: [
            {
              actor: '用户',
              description: '',
              rules: [],
              dependencies: [],
              result: '',
              exception: '',
              interactions: [],
              acceptance: '',
            },
          ],
        },
      },
      { op: 'feature.sync', id: 'new-feature' },
      { ...complete(1), id: 'new-feature' },
    ]),
    { code: 'VALIDATION_FAILED' },
  );
  await assert.rejects(apply(filename, [complete(1)], { affectedFeatureIds: [id] }), {
    code: 'VALIDATION_FAILED',
  });
});

test('空流程、坏时间、失败或空验收不能声明完成；不执行验收记录中的文字', async (t) => {
  const filename = temporary(t);
  for (const implementation of [
    record(1, { checks: [] }),
    record(1, { verifiedAt: '2026-02-30T00:00:00Z' }),
    record(1, { checks: [{ name: '保存', result: 'failed' }] }),
  ])
    await assert.rejects(apply(filename, [complete(1, implementation)]), {
      code: 'VALIDATION_FAILED',
    });
  await apply(filename, [
    { op: 'feature.create', id: 'empty', data: { title: '空草稿', description: '需求尚待梳理。' } },
  ]);
  await assert.rejects(apply(filename, [{ op: 'feature.sync', id: 'empty' }]), {
    code: 'VALIDATION_FAILED',
  });
  const marker = path.join(path.dirname(filename), 'must-not-execute');
  await apply(filename, [
    complete(1, record(1, { checks: [{ name: `touch ${marker}`, result: 'passed' }] })),
  ]);
  assert.equal(fs.existsSync(marker), false);
});

test('重复同一验收为无变化，新验收保留之前记录和用户历史字段', async (t) => {
  const filename = temporary(t);
  await apply(filename, [complete(1, record(1, { commit: 'first' }))]);
  const repeated = await apply(filename, [complete(1, record(1, { commit: 'first' }))]);
  assert.equal(repeated.changed, false);
  await apply(filename, [
    { op: 'feature.update', id, changes: { rules: ['数量及批次完整。'] } },
    { op: 'feature.sync', id },
  ]);
  await apply(filename, [complete(2, record(2, { commit: 'second' }))]);
  const current = readSnapshot(filename).document.features[id];
  assert.equal(current.implementation.commit, 'second');
  assert.equal(current.implementationHistory[0].commit, 'first');
  assert.equal(current.revision, 2);
  assert.equal(current.editRevision, 3);
});

test('直接JSON完成声明也须通过流程同步和验收历史的共同校验', (t) => {
  const filename = temporary(t);
  const document = readSnapshot(filename).document;
  const current = document.features[id];
  current.implementedRevision = 1;
  current.implementation = record(1);
  current.flowRevision = 0;
  assert.equal(validateDocument(document).valid, false);
  current.flowRevision = 1;
  current.implementationHistory = [record(1, { checks: [] })];
  assert.equal(validateDocument(document).valid, false);
  current.implementationHistory = [record(1)];
  assert.equal(validateDocument(document).valid, true);
});
