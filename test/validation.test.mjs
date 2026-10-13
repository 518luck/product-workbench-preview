import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocument, validateDocument } from '../lib/document.mjs';

const samplePath = new URL('../examples/minimal-product.json', import.meta.url);
const fixture = () => readDocument(samplePath);
const currentFeature = (document) => Object.values(document.features)[0];
const record = (revision) => ({
  revision,
  verifiedAt: '2026-10-13T00:00:00Z',
  checks: [{ name: '保存记录', result: 'passed' }],
});

function assertRejected(document, expectedPath) {
  let report;
  assert.doesNotThrow(() => {
    report = validateDocument(document);
  });
  assert.equal(report.valid, false);
  assert.ok(
    report.errors.some((item) => item.path === expectedPath),
    JSON.stringify(report),
  );
}

test('编号拒绝数组和对象，坏输入返回错误而不是在正则转换时崩溃', () => {
  for (const id of [null, false, 1, ['other'], {}, { toString: null }]) {
    const dependency = fixture();
    dependency.dependencies.push({ id, name: '新增依赖' });
    assertRejected(dependency, '/dependencies/1');
    const graph = fixture();
    graph.diagrams = { architecture: { title: '结构', nodes: [{ id, title: '节点' }], edges: [] } };
    assertRejected(graph, '/diagrams/architecture/nodes/0');
  }
});

test('关联功能只查询自身记录，同时支持真实名为 constructor 的稳定编号', () => {
  for (const id of ['constructor', 'toString', '__proto__']) {
    const document = fixture();
    document.dependencies[0].relations = [id];
    assertRejected(document, '/dependencies/0/relations');
  }
  const document = fixture(),
    feature = currentFeature(document);
  document.features = { constructor: { ...feature, id: 'constructor' } };
  document.dependencies[0].relations = ['constructor'];
  assert.equal(validateDocument(document).valid, true);
});

test('草稿的历史实现记录仍需符合数据规范，未知历史字段继续保留', () => {
  for (const [implementation, suffix] of [
    [null, ''],
    [17, ''],
    [[], ''],
    ['记录', ''],
    [{}, '/revision'],
    [{ ...record(0), commit: {} }, '/commit'],
    [{ ...record(0), checks: [null] }, '/checks'],
  ]) {
    const document = fixture(),
      feature = currentFeature(document);
    feature.implementedRevision = null;
    feature.implementation = implementation;
    assertRejected(document, `/features/${feature.id}/implementation${suffix}`);
  }
  const document = fixture(),
    feature = currentFeature(document);
  feature.implementedRevision = null;
  feature.implementation = record(0);
  feature.legacyDesign = { custom: ['原来的内容'] };
  const before = structuredClone(document);
  assert.equal(validateDocument(document).valid, true);
  assert.deepEqual(document, before);
});

test('验证时间必须包含时区，并拒绝被 Date.parse 自动修正的非法日期', () => {
  for (const verifiedAt of [
    '2026-10-13',
    '10/13/2026',
    '2026-10-13 00:00:00Z',
    '2026-10-13T00:00:00',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-10-13T24:00:00Z',
    '2026-10-13T00:00:00+24:00',
  ]) {
    const document = fixture(),
      feature = currentFeature(document);
    feature.implementation = { ...record(feature.revision), verifiedAt };
    assertRejected(document, `/features/${feature.id}/implementation/verifiedAt`);
  }
  for (const verifiedAt of [
    '2026-10-13T00:00:00Z',
    '2024-02-29T23:59:59.123+08:00',
    '2024-02-29t23:59:59z',
  ]) {
    const document = fixture(),
      feature = currentFeature(document);
    feature.implementation = { ...record(feature.revision), verifiedAt };
    assert.equal(validateDocument(document).valid, true);
  }
});

test('所有版本字段拒绝不再能安全递增的整数，Schema 使用相同上限', () => {
  for (const field of ['revision', 'editRevision', 'flowRevision', 'implementedRevision']) {
    const document = fixture(),
      feature = currentFeature(document);
    feature[field] = 100000000000000000000;
    assertRejected(document, `/features/${feature.id}/${field}`);
  }
  const document = fixture(),
    feature = currentFeature(document);
  feature.implementation = record(Number.MAX_SAFE_INTEGER + 1);
  assertRejected(document, `/features/${feature.id}/implementation/revision`);
  const schema = readDocument(new URL('../schema/product-document.schema.json', import.meta.url));
  assert.equal(schema.$defs.revision.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(schema.$defs.feature.properties.editRevision.$ref, '#/$defs/revision');
  assert.equal(
    schema.$defs.feature.properties.implementedRevision.maximum,
    Number.MAX_SAFE_INTEGER,
  );
  const valid = fixture(),
    validFeature = currentFeature(valid);
  validFeature.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(validateDocument(valid).valid, true);
});

test('常见损坏的嵌套 JSON 不会使文档校验崩溃', () => {
  const mutate = [
    (document, value) => {
      document.product = value;
    },
    (document, value) => {
      document.features = value;
    },
    (document, value) => {
      document.dependencies = value;
    },
    (document, value) => {
      currentFeature(document).flow = value;
    },
    (document, value) => {
      currentFeature(document).stepDetails = value;
    },
    (document, value) => {
      currentFeature(document).sequence = value;
    },
    (document, value) => {
      document.diagrams = { architecture: value };
    },
  ];
  for (const change of mutate)
    for (const value of [null, false, 1, '', [], {}, { toString: null }]) {
      const document = fixture();
      change(document, value);
      assert.doesNotThrow(() => validateDocument(document));
    }
});
