import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyChanges,
  readSnapshot,
  queryDocument,
  listFeatures,
  getFeature,
} from '../lib/document-operations.mjs';

const example = fileURLToPath(new URL('../examples/minimal-product.json', import.meta.url));
const id = 'stock-receipt';
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-operations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'product-document.json');
  fs.copyFileSync(example, filename);
  return { filename, directory };
}
const bundle = (filename, operations, extras = {}) => ({
  version: 1,
  expectedHash: readSnapshot(filename).documentHash,
  operations,
  ...extras,
});
const raw = (filename) => fs.readFileSync(filename, 'utf8');

test('按分区、模块、状态读取，详情附带真实依赖并返回整份文档哈希', (t) => {
  const { filename } = temporary(t);
  const snapshot = readSnapshot(filename);
  assert.equal(queryDocument(snapshot, { section: 'product' }).data.name, '库存管理');
  const list = listFeatures(snapshot, { group: '库存', status: 'draft' });
  assert.equal(list.features.length, 1);
  assert.equal(list.documentHash, snapshot.documentHash);
  assert.equal(listFeatures(snapshot, { group: '不存在' }).features.length, 0);
  assert.equal(listFeatures(snapshot, { status: 'complete' }).features.length, 0);
  assert.equal(getFeature(snapshot, id, { related: true }).relatedDependencies[0].id, 'storage');
  assert.throws(() => getFeature(snapshot, 'missing'), { code: 'NOT_FOUND' });
});

test('预览给出字段版本与状态变化，但不写文档、HTML 或锁文件', async (t) => {
  const { filename, directory } = temporary(t);
  const before = raw(filename);
  const preview = await applyChanges(
    filename,
    bundle(filename, [{ op: 'feature.update', id, changes: { rules: ['保存数量与批次。'] } }]),
    { dryRun: true },
  );
  assert.equal(preview.documentSaved, false);
  assert.equal(preview.htmlUpdated, false);
  assert.equal(preview.features[0].after.revision, 2);
  assert.ok(preview.changes.some((change) => change.path.endsWith('/rules')));
  assert.equal(raw(filename), before);
  assert.deepEqual(fs.readdirSync(directory), ['product-document.json']);
});

test('多次功能修改只递增一次，原文与未指定的用户历史字段完整保留', async (t) => {
  const { filename } = temporary(t);
  const source = readSnapshot(filename).document;
  source.features[id].legacyDesign = { note: '用户历史' };
  source.features[id].dataflow.nodes[0].legacyCoordinates = [2, 3];
  fs.writeFileSync(filename, JSON.stringify(source));
  const result = await applyChanges(
    filename,
    bundle(filename, [
      { op: 'feature.update', id, changes: { rules: ['新规则。'] } },
      {
        op: 'feature.update',
        id,
        changes: {
          title: '到货登记',
          checks: ['数量正确。'],
          dataflow: {
            nodes: [
              { id: 'input', title: '到货数据' },
              ...source.features[id].dataflow.nodes.slice(1),
            ],
          },
        },
      },
    ]),
    { render: false },
  );
  const feature = readSnapshot(filename).document.features[id];
  assert.equal(feature.revision, 2);
  assert.equal(feature.editRevision, 1);
  assert.equal(feature.description, source.features[id].description);
  assert.deepEqual(feature.legacyDesign, { note: '用户历史' });
  assert.deepEqual(feature.dataflow.nodes[0].legacyCoordinates, [2, 3]);
  assert.equal(result.documentHash, readSnapshot(filename).documentHash);
});

test('普通更新拒绝改写原文或工具版本，明确定义操作允许修改', async (t) => {
  const { filename } = temporary(t);
  for (const changes of [
    { description: '越权改写。' },
    { revision: 90 },
    { implementedRevision: 1 },
  ]) {
    const before = raw(filename);
    await assert.rejects(
      applyChanges(filename, bundle(filename, [{ op: 'feature.update', id, changes }]), {
        render: false,
      }),
      { code: 'INVALID_ARGUMENT' },
    );
    assert.equal(raw(filename), before);
  }
  await applyChanges(
    filename,
    bundle(filename, [{ op: 'feature.define', id, description: '确认到货信息后保存。' }]),
    { render: false },
  );
  assert.equal(readSnapshot(filename).document.features[id].description, '确认到货信息后保存。');
});

test('创建项目内容可一次引用同批新增依赖，任一无效操作则整批不落盘', async (t) => {
  const { filename } = temporary(t);
  const operations = [
    { op: 'product.update', changes: { background: '管理仓库。' } },
    {
      op: 'feature.create',
      id: 'stock-out',
      data: { title: '出库登记', description: '确认数量后出库。', dependencies: ['audit'] },
    },
    { op: 'dependency.create', data: { id: 'audit', name: '审计存储', relations: ['stock-out'] } },
    {
      op: 'diagram.set',
      kind: 'architecture',
      data: {
        title: '库存架构',
        nodes: [{ id: 'audit', title: '审计存储', dependency: 'audit' }],
        edges: [],
      },
    },
  ];
  const before = raw(filename);
  await assert.rejects(
    applyChanges(
      filename,
      bundle(filename, [
        ...operations,
        { op: 'feature.update', id, changes: { dependencies: ['missing'] } },
      ]),
      { render: false },
    ),
    { code: 'VALIDATION_FAILED' },
  );
  assert.equal(raw(filename), before);
  await applyChanges(filename, bundle(filename, operations), { render: false });
  const doc = readSnapshot(filename).document;
  assert.equal(doc.features['stock-out'].revision, 1);
  assert.equal(doc.features['stock-out'].flowRevision, 0);
  assert.equal(doc.features['stock-out'].implementedRevision, null);
  assert.equal(doc.diagrams.architecture.nodes[0].dependency, 'audit');
});

test('删除报告关联，必须在同一批次清理引用，不按操作先后要求中间状态有效', async (t) => {
  const { filename } = temporary(t);
  const before = raw(filename);
  await assert.rejects(
    applyChanges(filename, bundle(filename, [{ op: 'feature.delete', id }]), { render: false }),
    { code: 'VALIDATION_FAILED' },
  );
  assert.equal(raw(filename), before);
  const preview = await applyChanges(
    filename,
    bundle(filename, [
      { op: 'feature.delete', id },
      { op: 'dependency.update', id: 'storage', changes: { relations: [] } },
    ]),
    { dryRun: true },
  );
  assert.equal(preview.deletions[0].references[0].id, 'storage');
  await applyChanges(
    filename,
    bundle(filename, [
      { op: 'feature.delete', id },
      { op: 'dependency.delete', id: 'storage' },
    ]),
    { render: false },
  );
  assert.deepEqual(readSnapshot(filename).document.features, {});
});

test('依赖删除检查步骤与图表中的引用，可明确删除可选图表', async (t) => {
  const { filename } = temporary(t);
  await assert.rejects(
    applyChanges(filename, bundle(filename, [{ op: 'dependency.delete', id: 'storage' }]), {
      render: false,
    }),
    { code: 'VALIDATION_FAILED' },
  );
  const feature = readSnapshot(filename).document.features[id];
  const result = await applyChanges(
    filename,
    bundle(filename, [
      { op: 'dependency.delete', id: 'storage' },
      {
        op: 'feature.update',
        id,
        changes: {
          dependencies: [],
          stepDetails: feature.stepDetails.map((detail) => ({ ...detail, dependencies: [] })),
        },
        unset: ['dataflow'],
      },
    ]),
    { render: false },
  );
  assert.ok(result.deletions[0].references.some((entry) => entry.path.includes('/dataflow/')));
  assert.equal(Object.hasOwn(readSnapshot(filename).document.features[id], 'dataflow'), false);
});

test('整份文档哈希保护其他功能和产品修改，并发旧批次只有一个保存成功', async (t) => {
  const { filename } = temporary(t);
  const request = bundle(filename, [{ op: 'product.update', changes: { background: '已更新。' } }]);
  const results = await Promise.allSettled([
    applyChanges(filename, request, { render: false }),
    applyChanges(filename, request, { render: false }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal(readSnapshot(filename).document.product.background, '已更新。');
});

test('不变更新不增加版本，跨功能影响列表可以明确使规范失效', async (t) => {
  const { filename } = temporary(t);
  const before = raw(filename);
  const unchanged = await applyChanges(
    filename,
    bundle(filename, [{ op: 'feature.update', id, changes: { title: '入库登记' } }]),
    { render: false },
  );
  assert.equal(unchanged.changed, false);
  assert.equal(raw(filename), before);
  await applyChanges(
    filename,
    bundle(
      filename,
      [
        {
          op: 'dependency.update',
          id: 'storage',
          changes: { responsibility: '保存新的业务字段。' },
        },
      ],
      { affectedFeatureIds: [id] },
    ),
    { render: false },
  );
  const current = readSnapshot(filename).document.features[id];
  assert.equal(current.revision, 2);
  assert.equal(current.flowRevision, 1);
});

test('名为 constructor 的功能保持稳定身份，更新不访问原型记录', async (t) => {
  const { filename } = temporary(t);
  await applyChanges(
    filename,
    bundle(filename, [
      {
        op: 'feature.create',
        id: 'constructor',
        data: { title: '构造测试', description: '保存测试记录。' },
      },
    ]),
    { render: false },
  );
  const result = getFeature(readSnapshot(filename), 'constructor');
  assert.equal(result.feature.id, 'constructor');
  assert.equal(result.feature.revision, 1);
});

test('非法操作类型返回结构化错误，矛盾删除与修改不静默忽略', async (t) => {
  const { filename } = temporary(t);
  for (const operation of [
    { op: ['feature.update'], id, changes: { title: '不应修改' } },
    { op: { toString: null } },
    { op: 'product.update', changes: { background: '说明' }, unset: ['background'] },
    { op: 'dependency.update', id: 'storage', changes: { purpose: '保存' }, unset: ['purpose'] },
  ]) {
    const before = raw(filename);
    await assert.rejects(applyChanges(filename, bundle(filename, [operation]), { render: false }), {
      code: 'INVALID_ARGUMENT',
    });
    assert.equal(raw(filename), before);
  }
});

test('流程重排和简化元组更新保留对应步骤的历史附加字段', async (t) => {
  const { filename } = temporary(t);
  const source = readSnapshot(filename).document;
  const first = source.features[id];
  first.flow[0].push('old-icon', ['storage'], { note: '第一步历史' });
  first.stepDetails[0].legacy = '第一步备注';
  fs.writeFileSync(filename, JSON.stringify(source));
  await applyChanges(
    filename,
    bundle(filename, [
      {
        op: 'feature.update',
        id,
        changes: {
          flow: [...first.flow].reverse().map((step) => step.slice(0, 2)),
          stepDetails: [...first.stepDetails].reverse().map(({ legacy, ...detail }) => detail),
        },
      },
    ]),
    { render: false },
  );
  const current = readSnapshot(filename).document.features[id];
  assert.deepEqual(current.flow[1].slice(2), ['old-icon', ['storage'], { note: '第一步历史' }]);
  assert.equal(current.stepDetails[1].legacy, '第一步备注');
});
