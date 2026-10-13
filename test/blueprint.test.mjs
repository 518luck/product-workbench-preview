import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import {
  readDocument,
  renderDocument,
  schemaPath,
  templatePath,
  validateDocument,
} from '../lib/document.mjs';
import { createDocumentServer } from '../lib/document-server.mjs';

const cli = fileURLToPath(new URL('../bin/product-blueprint.mjs', import.meta.url));
const currentDocument = fileURLToPath(new URL('../product-document.json', import.meta.url));
function fixture() {
  return {
    schemaVersion: 1,
    product: { name: '库存管理', background: '管理物品入库。', actors: ['仓库员'] },
    features: {
      stock: {
        id: 'stock',
        title: '入库登记',
        description: '登记到货数量。',
        rules: ['数量必须大于零。'],
        flow: [['登记到货', '填写数量']],
        stepDetails: [
          {
            actor: '仓库员',
            description: '填写数量。',
            rules: ['数量必须大于零。'],
            dependencies: ['storage'],
            result: '保存记录。',
            exception: '失败保留输入。',
            interactions: [],
            acceptance: '数量正确保存。',
          },
        ],
        dependencies: ['storage'],
        groupPath: ['库存'],
        revision: 1,
        flowRevision: 1,
        implementedRevision: 1,
        implementation: {
          revision: 1,
          verifiedAt: '2026-10-13T00:00:00Z',
          checks: [{ name: '保存记录', result: 'passed' }],
        },
      },
    },
    dependencies: [
      {
        id: 'storage',
        name: '库存数据库',
        category: '数据存储',
        purpose: '保存库存',
        description: '保存入库记录。',
        responsibility: '保存记录',
        failure: '失败保留输入。',
        relations: ['stock'],
      },
    ],
    diagrams: {},
  };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('当前文档通过校验，两个不同项目共用模板且重复生成一致', () => {
  const current = readDocument(currentDocument);
  assert.equal(validateDocument(current).valid, true);
  const document = fixture();
  const before = structuredClone(document);
  const first = renderDocument(document),
    second = renderDocument(document);
  assert.equal(first, second);
  assert.deepEqual(document, before);
  assert.ok(first.includes('库存管理'));
  assert.ok(!first.includes('用户调查表'));
  assert.ok(!first.includes('survey-app'));
  assert.ok(!first.includes('{{PRODUCT_DOCUMENT}}'));
  for (const block of first.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!block[1].includes('application/json')) assert.doesNotThrow(() => new Script(block[2]));
  }
  document.product.background = '</script><script>unexpected()</script>';
  const safe = renderDocument(document);
  assert.ok(!safe.includes('</script><script>unexpected()'));
  const embedded = JSON.parse(
    safe.match(/<script id="product-data" type="application\/json">([\s\S]*?)<\/script>/)[1],
  );
  assert.equal(embedded.product.background, document.product.background);
});

test('拒绝缺失引用、版本越界和没有验证记录的完成声明', () => {
  for (const mutate of [
    (d) => d.features.stock.dependencies.push('missing'),
    (d) => d.dependencies.push({ ...d.dependencies[0] }),
    (d) => (d.features.stock.flowRevision = 2),
    (d) => delete d.features.stock.implementation,
    (d) => (d.features.stock.implementation.checks[0].result = 'failed'),
    (d) =>
      (d.features.stock.sequence = {
        roles: ['仓库员'],
        base: [[0, 2, '错误交互', 0]],
        normal: [],
      }),
    (d) =>
      (d.diagrams.entities = {
        title: '关系',
        nodes: [{ id: 'item', title: '物品' }],
        edges: [{ from: 'item', to: 'missing' }],
      }),
    (d) => (d.product.background = {}),
    (d) => (d.dependencies[0].openQuestions = '不是数组'),
    (d) => (d.features.stock.overview = ['不是文字']),
    (d) => (d.features.stock.stepDetails[0].dependenciesPending = 'false'),
    (d) =>
      (d.features.stock.sequence = {
        roles: ['仓库员'],
        base: [],
        normal: [[0, 0, '错误标记', 0, 'response']],
      }),
    (d) =>
      (d.diagrams.entities = {
        title: '关系',
        nodes: [{ id: 'item', title: '物品', fields: '不是数组' }],
        edges: [],
      }),
    (d) =>
      (d.diagrams.entities = {
        title: '关系',
        nodes: [{ id: 'item', title: '物品' }],
        edges: [{ from: 'item', to: 'item', dashed: 'false' }],
      }),
  ]) {
    const document = fixture();
    mutate(document);
    assert.equal(validateDocument(document).valid, false);
    assert.throws(() => renderDocument(document));
  }
});

test('CLI 输出完整的数据规范，通用最小示例可直接校验和渲染', () => {
  const schema = JSON.parse(execFileSync(process.execPath, [cli, 'schema'], { encoding: 'utf8' }));
  assert.deepEqual(schema, readDocument(schemaPath));
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.ok(schema.$defs.feature.required.includes('stepDetails'));
  assert.ok(schema.$defs.feature.required.includes('implementedRevision'));
  const sample = readDocument(
    fileURLToPath(new URL('../examples/minimal-product.json', import.meta.url)),
  );
  assert.equal(validateDocument(sample).valid, true);
  const output = renderDocument(sample);
  assert.ok(output.includes('库存管理'));
  assert.ok(!output.includes('用户调查表'));
});

test('CLI 初始化不覆盖已有文件，失败生成保留旧 HTML', (t) => {
  const dir = temporary(t);
  const output = JSON.parse(
    execFileSync(process.execPath, [cli, 'init', dir, '--name', '空项目', '--json'], {
      encoding: 'utf8',
    }),
  );
  assert.ok(fs.existsSync(output.html));
  const initial = fs.readFileSync(output.document, 'utf8');
  const retry = spawnSync(process.execPath, [cli, 'init', dir, '--name', '不能覆盖', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(retry.status, 1);
  assert.equal(fs.readFileSync(output.document, 'utf8'), initial);
  const invalid = fixture();
  invalid.features.stock.dependencies = ['missing'];
  fs.writeFileSync(output.document, JSON.stringify(invalid));
  const before = fs.readFileSync(output.html, 'utf8');
  const rendered = spawnSync(
    process.execPath,
    [cli, 'render', output.document, '--output', output.html, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(rendered.status, 1);
  assert.equal(fs.readFileSync(output.html, 'utf8'), before);
  assert.equal(JSON.parse(rendered.stdout).valid, false);
  const typo = spawnSync(
    process.execPath,
    [cli, 'render', output.document, '--json', '--unknown'],
    { encoding: 'utf8' },
  );
  assert.equal(typo.status, 2);
});

test('共享服务保留元数据、定义版本、冲突保护和新增草稿规则', async (t) => {
  const dir = temporary(t),
    filename = path.join(dir, 'product-document.json');
  fs.writeFileSync(filename, JSON.stringify(fixture()));
  const server = createDocumentServer({ documentPath: filename, templatePath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const put = (id, body, allowedOrigin = origin) =>
    fetch(`${origin}/document/features/${id}`, {
      method: 'PUT',
      headers: { Origin: allowedOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let response = await put('stock', {
    title: '到货登记',
    description: '登记到货数量。',
    expectedRevision: 1,
    expectedEditRevision: 0,
    groupPath: ['库存', '入库'],
  });
  assert.equal(response.status, 200);
  let updated = await response.json();
  assert.equal(updated.revision, 1);
  assert.equal(updated.implementedRevision, 1);
  response = await put('stock', {
    description: '登记数量和批次。',
    expectedRevision: 1,
    expectedEditRevision: 1,
  });
  assert.equal(response.status, 200);
  updated = await response.json();
  assert.equal(updated.revision, 2);
  assert.equal(updated.flowRevision, 1);
  assert.equal(updated.implementedRevision, 1);
  assert.equal((await put('stock', { description: '旧版本', expectedRevision: 1 })).status, 409);
  assert.equal(
    (await put('stock', { description: '其他来源', expectedRevision: 2 }, 'http://other.invalid'))
      .status,
    403,
  );
  const context = {
    title: '出库登记',
    rules: [],
    flow: [],
    stepDetails: [],
    dependencies: [],
    actors: [],
    checks: [],
    impact: [],
    overview: '记录出库。',
    description: '',
    exception: '',
    isNew: true,
  };
  const create = {
    create: true,
    description: '记录出库数量。',
    expectedRevision: 0,
    groupPath: ['库存', '出库'],
    context,
  };
  assert.equal((await put('new-check', create)).status, 200);
  assert.equal((await put('new-check', create)).status, 200);
  const document = readDocument(filename);
  assert.equal(Object.keys(document.features).length, 2);
  assert.equal(document.features['new-check'].implementedRevision, null);
  assert.equal(document.features['new-check'].flowRevision, 0);
  assert.equal(validateDocument(document).valid, true);
  const html = await (await fetch(origin)).text();
  assert.deepEqual(
    JSON.parse(
      html.match(/<script id="product-data" type="application\/json">([\s\S]*?)<\/script>/)[1],
    ),
    document,
  );
});
