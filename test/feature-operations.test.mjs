import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFeature, finalizeFeature, savePageFeature } from '../lib/feature-operations.mjs';
import { BlueprintError } from '../lib/errors.mjs';

function feature() {
  return {
    ...createFeature('stock-receipt', { title: '入库登记', description: '登记数量。' }),
    revision: 3,
    editRevision: 4,
    flowRevision: 3,
    implementedRevision: 3,
    implementation: {
      revision: 3,
      verifiedAt: '2026-10-13T00:00:00Z',
      checks: [{ name: '登记数量验收', result: 'passed' }],
    },
    legacyDesign: { userNotes: '用户保留的历史说明。' },
  };
}

test('共享规则保存名称分组而不改变完成版本，并保留历史内容', () => {
  const previous = feature();
  const renamed = finalizeFeature(previous, { title: '物品入库', groupPath: ['库存', '登记'] });
  assert.equal(renamed.changed, true);
  assert.equal(renamed.feature.revision, 3);
  assert.equal(renamed.feature.editRevision, 5);
  assert.equal(renamed.feature.implementedRevision, 3);
  assert.deepEqual(renamed.feature.implementation, previous.implementation);
  assert.deepEqual(renamed.feature.legacyDesign, previous.legacyDesign);
  assert.equal(previous.title, '入库登记');
  assert.deepEqual(finalizeFeature(previous, { revision: 999, editRevision: 999 }), {
    changed: false,
    feature: previous,
  });
});

test('规则与流程的真实变化只递增一次定义版本，旧实现记录保留', () => {
  const previous = feature();
  const candidate = {
    rules: ['数量必须大于零。'],
    flow: [['填写数量', '填写本次入库数量。']],
    stepDetails: [
      {
        actor: '仓库管理员',
        description: '填写数量。',
        result: '等待保存。',
        exception: '无效数量不能保存。',
        acceptance: '数量大于零。',
        rules: ['数量必须大于零。'],
        dependencies: [],
        interactions: [],
      },
    ],
    flowRevision: 4,
    newEvidence: { source: '仓库分析。' },
  };
  const update = finalizeFeature(previous, candidate);
  assert.equal(update.feature.revision, 4);
  assert.equal(update.feature.editRevision, 5);
  assert.equal(update.feature.flowRevision, 4);
  assert.equal(update.feature.implementedRevision, 3);
  assert.deepEqual(update.feature.implementation, previous.implementation);
  assert.deepEqual(update.feature.newEvidence, candidate.newEvidence);
  assert.equal(finalizeFeature(update.feature, structuredClone(update.feature)).changed, false);
});

test('同步和完成记录仅递增保存版本，明确受影响功能可强制定版本递增', () => {
  const previous = feature();
  const update = finalizeFeature(previous, {
    flowRevision: 3,
    implementation: {
      ...previous.implementation,
      verifiedAt: '2026-10-13T01:00:00Z',
    },
  });
  assert.equal(update.feature.revision, 3);
  assert.equal(update.feature.editRevision, 5);
  const affected = finalizeFeature(previous, {}, { forceRevision: true });
  assert.equal(affected.feature.revision, 4);
  assert.equal(affected.feature.editRevision, 5);
  assert.equal(affected.feature.implementedRevision, 3);
  assert.throws(
    () => finalizeFeature(previous, { id: 'other-feature' }),
    (error) => error instanceof BlueprintError && error.code === 'INVALID_ARGUMENT',
  );
});

test('业务字段变化使已完成功能回到草稿，可选字段只在明确要求时移除', () => {
  const previous = feature();
  const fields = {
    description: '登记物品和数量。',
    overview: '记录库存入库。',
    notes: '保留批次信息。',
    actors: ['仓库管理员'],
    rules: ['数量大于零。'],
    checks: ['数量可以正确保存。'],
    impact: ['库存增加。'],
    flow: [['登记数量', '填写本次数量。']],
    stepDetails: [{ description: '数量大于零。' }],
    dependencies: ['stock-database'],
    sequence: { roles: ['用户', '系统'], base: [], normal: [] },
    dataflow: { title: '数量保存', nodes: [], edges: [] },
  };
  for (const [field, value] of Object.entries(fields)) {
    const update = finalizeFeature(previous, { [field]: value });
    assert.equal(update.feature.revision, 4, field);
    assert.equal(update.feature.editRevision, 5, field);
    assert.notEqual(update.feature.implementedRevision, update.feature.revision, field);
  }
  const withDiagram = { ...previous, sequence: fields.sequence };
  assert.deepEqual(
    finalizeFeature(withDiagram, { title: '新名称' }).feature.sequence,
    fields.sequence,
  );
  const removed = finalizeFeature(withDiagram, {}, { unset: ['sequence'] });
  assert.equal(Object.hasOwn(removed.feature, 'sequence'), false);
  assert.equal(removed.feature.revision, 4);
  assert.throws(() => finalizeFeature(previous, {}, { unset: ['id'] }), BlueprintError);
  assert.throws(() => finalizeFeature(previous, {}, { unset: ['legacyDesign'] }), BlueprintError);
});

test('版本上限拒绝需要递增的变更，无变化可以正常读取', () => {
  const previous = feature();
  previous.editRevision = Number.MAX_SAFE_INTEGER;
  assert.equal(finalizeFeature(previous, {}).changed, false);
  assert.throws(
    () => finalizeFeature(previous, { title: '新名称' }),
    (error) => error.code === 'CONFLICT' && error.status === 409,
  );
  previous.editRevision = 0;
  previous.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(finalizeFeature(previous, { title: '新名称' }).feature.revision, previous.revision);
  assert.throws(() => finalizeFeature(previous, { rules: ['新规则'] }), BlueprintError);
  assert.throws(() => finalizeFeature(previous, {}, { forceRevision: true }), BlueprintError);
});

test('初始草稿不能接收完成声明，页面创建不导入客户端图表', () => {
  const fields = {
    title: '出库登记',
    description: '登记出库数量。',
    groupPath: ['库存'],
    revision: 100,
    editRevision: 100,
    flowRevision: 100,
    implementedRevision: 100,
    implementation: { revision: 100 },
    flow: [['登记出库', '保存数量。']],
    rules: ['出库不能超过库存。'],
  };
  const draft = createFeature('stock-out', fields);
  assert.equal(draft.revision, 1);
  assert.equal(draft.editRevision, 1);
  assert.equal(draft.flowRevision, 0);
  assert.equal(draft.implementedRevision, null);
  assert.equal(draft.implementation, undefined);
  assert.deepEqual(draft.rules, fields.rules);
  const page = createFeature('stock-out', fields, { page: true });
  assert.equal(page.isNew, true);
  assert.deepEqual(page.flow, []);
  assert.deepEqual(page.rules, []);
  assert.deepEqual(page.stepDetails, []);
});

test('页面更新器支持旧保存版本，实际保存后拒绝旧调用并保留完成记录', () => {
  const document = JSON.parse(
    fs.readFileSync(new URL('../examples/minimal-product.json', import.meta.url), 'utf8'),
  );
  const previous = document.features['stock-receipt'];
  const input = {
    id: previous.id,
    expectedRevision: previous.revision,
    description: previous.description,
    title: '新的入库名称',
  };
  const update = savePageFeature(input)(document);
  assert.equal(update.changed, true);
  assert.equal(update.result.editRevision, 1);
  assert.equal(update.result.revision, previous.revision);
  assert.throws(
    () => savePageFeature(input)(document),
    (error) => error.code === 'CONFLICT' && error.status === 409,
  );
  const fresh = savePageFeature({ ...input, expectedEditRevision: 1 })(document);
  assert.equal(fresh.changed, false);
});
