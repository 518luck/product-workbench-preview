import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDocumentServer } from '../lib/document-server.mjs';
import { updateDocument, DocumentConflictError } from '../lib/document-store.mjs';
import { templatePath, readDocument } from '../lib/document.mjs';

const example = fileURLToPath(new URL('../examples/minimal-product.json', import.meta.url));
const store = new URL('../lib/document-store.mjs', import.meta.url).href;
const id = 'stock-receipt';
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-server-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'product-document.json');
  fs.copyFileSync(example, filename);
  return { directory, filename };
}
async function start(t, filename) {
  const server = createDocumentServer({ documentPath: filename, templatePath });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const put = (featureId, body) =>
    fetch(`${origin}/document/features/${featureId}`, {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { server, origin, put };
}
const save = (feature, extras = {}) => ({
  description: feature.description,
  expectedRevision: feature.revision,
  expectedEditRevision: feature.editRevision ?? 0,
  ...extras,
});

test('批注独立保存，保留定义与完成状态，重试幂等并保护并发版本', async (t) => {
  const { filename } = temporary(t);
  const document = readDocument(filename),
    feature = document.features[id];
  feature.flowRevision = feature.revision;
  feature.implementedRevision = feature.revision;
  feature.implementation = {
    revision: feature.revision,
    verifiedAt: '2026-10-14T00:00:00Z',
    checks: [{ name: '临时验收样例', result: 'passed' }],
  };
  feature.notes = '保留原备注';
  feature.legacyContent = { author: '用户' };
  fs.writeFileSync(filename, JSON.stringify(document));
  const { origin } = await start(t, filename);
  const capability = await (await fetch(origin + '/document/capabilities')).json();
  assert.equal(capability.canSave, true);
  assert.equal(capability.documentPath, filename);
  const post = (body, requestOrigin = origin) =>
    fetch(`${origin}/document/features/${id}/annotations`, {
      method: 'POST',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const input = {
    annotationId: 'annotation-first',
    text: '增加多语言支持。',
    expectedRevision: feature.revision,
    expectedEditRevision: feature.editRevision ?? 0,
    implementedRevision: null,
  };
  assert.equal((await post(input)).status, 200);
  const saved = readDocument(filename).features[id];
  assert.equal(saved.annotations.length, 1);
  assert.equal(saved.annotations[0].text, input.text);
  assert.equal(saved.annotations[0].definitionRevision, feature.revision);
  assert.equal(saved.revision, feature.revision);
  assert.equal(saved.flowRevision, feature.flowRevision);
  assert.equal(saved.implementedRevision, feature.implementedRevision);
  assert.equal(saved.description, feature.description);
  assert.equal(saved.notes, feature.notes);
  assert.deepEqual(saved.implementation, feature.implementation);
  assert.deepEqual(saved.legacyContent, feature.legacyContent);
  assert.equal(saved.editRevision, (feature.editRevision ?? 0) + 1);
  const beforeRetry = fs.readFileSync(filename, 'utf8');
  assert.equal((await post(input)).status, 200);
  assert.equal(fs.readFileSync(filename, 'utf8'), beforeRetry);
  assert.equal((await post({ ...input, text: '冲突内容' })).status, 409);
  assert.equal((await post({ ...input, annotationId: 'annotation-second' })).status, 409);
  assert.equal(
    (
      await post({
        ...input,
        annotationId: 'annotation-second',
        expectedEditRevision: saved.editRevision,
      })
    ).status,
    200,
  );
  const stable = fs.readFileSync(filename, 'utf8');
  assert.equal((await post({ ...input, text: 'x'.repeat(5001) })).status, 400);
  assert.equal((await post(input, 'http://example.invalid')).status, 403);
  assert.equal(fs.readFileSync(filename, 'utf8'), stable);
  assert.equal(readDocument(filename).features[id].annotations.length, 2);
});
function requestRaw(origin, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin, { path: requestPath, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('页面编辑及删除批注保留编号和完成记录，冲突或无效输入不落盘', async (t) => {
  const { filename } = temporary(t);
  const document = readDocument(filename),
    original = document.features[id];
  original.implementedRevision = original.revision;
  original.implementation = {
    revision: original.revision,
    verifiedAt: '2026-10-14T00:00:00Z',
    checks: [{ name: '临时完成记录', result: 'passed' }],
  };
  original.annotations = ['first', 'second'].map((suffix) => ({
    id: `annotation-${suffix}`,
    text: `原批注 ${suffix}`,
    createdAt: '2026-10-14T00:00:00Z',
    definitionRevision: original.revision,
    custom: '保留批注附加内容',
  }));
  original.notes = '用户备注';
  fs.writeFileSync(filename, JSON.stringify(document));
  const { origin } = await start(t, filename);
  const request = (method, annotationId, body, requestOrigin = origin) =>
    fetch(`${origin}/document/features/${id}/annotations/${annotationId}`, {
      method,
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const edit = await request('PUT', 'annotation-first', {
    ...save(original),
    text: '新的批注内容',
  });
  assert.equal(edit.status, 200);
  const updated = await edit.json();
  assert.equal(updated.annotations.length, 2);
  assert.equal(updated.annotations[0].id, original.annotations[0].id);
  assert.equal(updated.annotations[0].createdAt, original.annotations[0].createdAt);
  assert.equal(updated.annotations[0].custom, original.annotations[0].custom);
  assert.equal(updated.annotations[0].text, '新的批注内容');
  assert.ok(updated.annotations[0].updatedAt);
  assert.equal(updated.revision, original.revision);
  assert.equal(updated.flowRevision, original.flowRevision);
  assert.equal(updated.implementedRevision, original.implementedRevision);
  assert.deepEqual(updated.implementation, original.implementation);
  assert.equal(updated.notes, original.notes);
  const stable = fs.readFileSync(filename, 'utf8');
  assert.equal(
    (await request('PUT', 'annotation-first', { ...save(updated), text: '新的批注内容' })).status,
    200,
  );
  assert.equal(
    (await request('PUT', 'annotation-first', { ...save(original), text: '过时内容' })).status,
    409,
  );
  assert.equal((await request('DELETE', 'annotation-first', save(original))).status, 409);
  assert.equal(
    (await request('DELETE', 'annotation-first', save(updated), 'http://example.invalid')).status,
    403,
  );
  assert.equal(
    (await request('PUT', 'annotation-first', { ...save(updated), text: '' })).status,
    400,
  );
  assert.equal(
    (await request('PUT', 'annotation-first', { ...save(updated), text: 'x'.repeat(5001) })).status,
    400,
  );
  assert.equal((await request('DELETE', 'annotation-missing', save(updated))).status, 404);
  assert.equal(fs.readFileSync(filename, 'utf8'), stable);
  assert.equal((await request('DELETE', 'annotation-first', save(updated))).status, 200);
  const removed = readDocument(filename).features[id];
  assert.deepEqual(removed.annotations, [original.annotations[1]]);
  assert.equal(removed.editRevision, (original.editRevision ?? 0) + 2);
  assert.equal(removed.revision, original.revision);
  assert.equal(removed.description, original.description);
  assert.equal(removed.implementedRevision, original.implementedRevision);
  assert.deepEqual(removed.implementation, original.implementation);
});

test('名称和分组独立保存版本拒绝旧页面覆盖，定义版本保持业务语义', async (t) => {
  const { filename } = temporary(t),
    { put } = await start(t, filename);
  const initial = readDocument(filename).features[id];
  const first = await put(id, save(initial, { title: '新名称', groupPath: ['库存', '登记'] }));
  assert.equal(first.status, 200);
  const updated = await first.json();
  assert.equal(updated.editRevision, 1);
  assert.equal(updated.revision, initial.revision);
  assert.equal((await put(id, save(initial, { title: '旧页面名称' }))).status, 409);
  assert.equal(
    (
      await put(id, {
        description: initial.description,
        title: '旧客户端',
        expectedRevision: initial.revision,
      })
    ).status,
    409,
  );
  const changed = await put(id, save(updated, { description: '登记物品和批次。' }));
  assert.equal(changed.status, 200);
  const result = await changed.json();
  assert.equal(result.revision, initial.revision + 1);
  assert.equal(result.editRevision, 2);
  assert.equal(result.title, '新名称');
  assert.deepEqual(result.groupPath, ['库存', '登记']);
  assert.equal((await put('removed-feature', save(initial, { context: initial }))).status, 404);
});

test('新增只生成空草稿，不信任客户端图表或完成声明，重试保持幂等', async (t) => {
  const { filename } = temporary(t),
    { put } = await start(t, filename);
  const body = {
    create: true,
    description: '记录出库。',
    expectedRevision: 0,
    expectedEditRevision: 0,
    groupPath: ['库存'],
    context: {
      title: '出库登记',
      implementedRevision: 1,
      flow: [['伪造流程', '不应导入']],
      stepDetails: [{}],
      dependencies: ['missing'],
      implementation: { revision: 1 },
    },
  };
  const first = await put('stock-out', body);
  assert.equal(first.status, 200);
  const record = await first.json();
  assert.equal(record.implementedRevision, null);
  assert.equal(record.flowRevision, 0);
  assert.equal(record.editRevision, 1);
  assert.deepEqual(record.flow, []);
  assert.deepEqual(record.stepDetails, []);
  assert.deepEqual(record.dependencies, []);
  assert.equal(record.implementation, undefined);
  assert.equal((await put('stock-out', body)).status, 200);
  assert.equal((await put('stock-out', { ...body, description: '不同定义' })).status, 409);
  assert.equal((await put('constructor', { ...body, context: { title: '构造记录' } })).status, 200);
  assert.ok(Object.hasOwn(readDocument(filename).features, 'constructor'));
});

test('同文档两个服务保存不同功能不丢失更新，已存在的文件锁保持原样', async (t) => {
  const { filename } = temporary(t);
  const document = readDocument(filename);
  document.features.second = {
    ...structuredClone(document.features[id]),
    id: 'second',
    title: '第二功能',
  };
  fs.writeFileSync(filename, JSON.stringify(document));
  const first = await start(t, filename),
    second = await start(t, filename);
  const responses = await Promise.all([
    first.put(id, save(document.features[id], { description: '甲的定义。' })),
    second.put('second', save(document.features.second, { description: '乙的定义。' })),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(readDocument(filename).features[id].description, '甲的定义。');
  assert.equal(readDocument(filename).features.second.description, '乙的定义。');
  const lock = `${filename}.write-lock`;
  fs.writeFileSync(lock, '其他进程的锁');
  const before = fs.readFileSync(filename, 'utf8');
  assert.equal(
    (await first.put(id, save(readDocument(filename).features[id], { title: '不能覆盖' }))).status,
    409,
  );
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal(fs.readFileSync(lock, 'utf8'), '其他进程的锁');
});

test(
  '跨进程文件锁拒绝交叉写入，提交前发现外部文件更新并保留外部内容',
  { timeout: 15000 },
  async (t) => {
    const { filename } = temporary(t);
    const source = `import fs from 'node:fs'; import { updateDocument } from ${JSON.stringify(store)}; const original = fs.promises.writeFile; fs.promises.writeFile = async (...args) => { const result = await original(...args); process.stdout.write('prepared\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); return result; }; await updateDocument(${JSON.stringify(filename)}, document => { document.product.background = '子进程更新。'; return { changed: true, result: true }; }); process.stdin.destroy();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`子进程退出 ${code}`)),
      );
    });
    finished.catch(() => {});
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('等待子进程文件锁超时。')), 5000);
      child.stdout.once('data', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('子进程在获得文件锁前退出。'));
      });
    });
    await assert.rejects(
      updateDocument(filename, (document) => {
        document.product.background = '不能覆盖';
        return { changed: true, result: true };
      }),
      DocumentConflictError,
    );
    child.stdin.write('continue\n');
    await finished;
    assert.equal(readDocument(filename).product.background, '子进程更新。');
    const originalWrite = fs.promises.writeFile;
    const external = readDocument(filename);
    external.product.background = '外部 AI 最新内容。';
    fs.promises.writeFile = async (...args) => {
      await originalWrite(...args);
      fs.writeFileSync(filename, JSON.stringify(external));
    };
    try {
      await assert.rejects(
        updateDocument(filename, (document) => {
          document.product.background = '旧页面覆盖';
          return { changed: true, result: true };
        }),
        DocumentConflictError,
      );
    } finally {
      fs.promises.writeFile = originalWrite;
    }
    assert.deepEqual(readDocument(filename), external);
    assert.equal(fs.existsSync(`${filename}.write-lock`), false);
    fs.chmodSync(filename, 0o600);
    await updateDocument(filename, (document) => {
      document.product.background = '保留私有文件权限。';
      return { changed: true, result: true };
    });
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  },
);

test('非法 URL 不终止服务，方法与 Host 边界明确，HEAD 无正文，坏文档不交给页面', async (t) => {
  const { filename } = temporary(t),
    { origin } = await start(t, filename);
  assert.equal((await requestRaw(origin, '//[')).status, 400);
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(origin, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${origin}/product-document.json`, { method: 'PUT' })).status, 405);
  assert.equal(
    (
      await fetch(`${origin}/document/features/${id}`, {
        method: 'PUT',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: ' '.repeat(70000),
      })
    ).status,
    413,
  );
  const head = await fetch(origin, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const headDocument = await fetch(`${origin}/product-document.json`, { method: 'HEAD' });
  assert.equal(headDocument.status, 200);
  assert.equal(await headDocument.text(), '');
  assert.equal(
    (
      await requestRaw(origin, '/product-document.json', {
        Host: `example.invalid:${new URL(origin).port}`,
      })
    ).status,
    403,
  );
  const document = readDocument(filename);
  document.features[id].dependencies.push('missing');
  fs.writeFileSync(filename, JSON.stringify(document));
  const invalid = await fetch(`${origin}/product-document.json`);
  assert.equal(invalid.status, 500);
  assert.ok((await invalid.json()).details.some((item) => item.path.endsWith('/dependencies')));
});
