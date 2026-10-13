import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChanges, readSnapshot, renderSnapshot } from '../lib/document-operations.mjs';
import { renderDocument, writeHtml } from '../lib/document.mjs';
import { updateDocument } from '../lib/document-store.mjs';

const example = fileURLToPath(new URL('../examples/minimal-product.json', import.meta.url));
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-render-commit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'product-document.json');
  fs.copyFileSync(example, filename);
  return { filename, directory };
}
const request = (filename, background) => ({
  version: 1,
  expectedHash: readSnapshot(filename).documentHash,
  operations: [{ op: 'product.update', changes: { background } }],
});

test('默认保存自动生成最新HTML，与同份数据重复渲染一致', async (t) => {
  const { filename, directory } = temporary(t);
  const result = await applyChanges(filename, request(filename, '仓库登记与审阅。'));
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  assert.equal(result.documentSaved, true);
  assert.equal(result.htmlUpdated, true);
  assert.equal(result.documentHash, readSnapshot(filename).documentHash);
  assert.equal(html, renderDocument(readSnapshot(filename).document));
  const embedded = JSON.parse(
    html.match(/<script id="product-data" type="application\/json">([\s\S]*?)<\/script>/)[1],
  );
  assert.equal(embedded.product.background, '仓库登记与审阅。');
});

test('保存后HTML失败明确返回部分成功，保留输出并可单独重新生成', async (t) => {
  const { filename, directory } = temporary(t);
  const output = path.join(directory, 'blocked.html');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'old'), '旧内容');
  await assert.rejects(
    applyChanges(filename, request(filename, '文档已经保存。'), { output }),
    (error) => {
      assert.equal(error.code, 'RENDER_FAILED');
      assert.equal(error.documentSaved, true);
      assert.equal(error.htmlUpdated, false);
      assert.equal(error.result.documentHash, readSnapshot(filename).documentHash);
      return true;
    },
  );
  assert.equal(readSnapshot(filename).document.product.background, '文档已经保存。');
  assert.equal(fs.readFileSync(path.join(output, 'old'), 'utf8'), '旧内容');
  assert.equal(fs.existsSync(`${filename}.write-lock`), false);
  const html = path.join(directory, 'index.html');
  writeHtml(html, renderDocument(readSnapshot(filename).document));
  assert.ok(fs.readFileSync(html, 'utf8').includes('文档已经保存。'));
});

test('通过文档符号链接指向输出时拒绝覆盖权威JSON', async (t) => {
  const { filename, directory } = temporary(t);
  const actual = path.join(directory, 'index.html');
  fs.renameSync(filename, actual);
  fs.symlinkSync(actual, filename);
  const before = fs.readFileSync(actual, 'utf8');
  await assert.rejects(applyChanges(filename, request(filename, '不应保存。')), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(renderSnapshot(filename), { code: 'INVALID_ARGUMENT' });
  assert.equal(fs.readFileSync(actual, 'utf8'), before);
  assert.equal(fs.existsSync(`${actual}.write-lock`), false);
  assert.equal(readSnapshot(filename).document.product.name, '库存管理');
});

test('单独渲染读取锁内最新内容，失败保留旧HTML并释放锁', async (t) => {
  const { filename, directory } = temporary(t);
  const html = path.join(directory, 'index.html');
  await renderSnapshot(filename);
  const before = fs.readFileSync(html, 'utf8');
  const source = readSnapshot(filename).document;
  source.features['stock-receipt'].dependencies = ['missing'];
  fs.writeFileSync(filename, JSON.stringify(source));
  await assert.rejects(renderSnapshot(filename), { code: 'VALIDATION_FAILED' });
  assert.equal(fs.readFileSync(html, 'utf8'), before);
  assert.equal(fs.existsSync(`${filename}.write-lock`), false);
});

test('派生HTML操作完成前保留写锁和同进程队列，后续变更读取最新文档', async (t) => {
  const { filename } = temporary(t);
  let entered, release;
  const pending = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const order = [];
  const first = updateDocument(
    filename,
    (document, context) => {
      assert.equal(JSON.parse(context.original).product.name, '库存管理');
      document.product.background = '第一份';
      return { changed: true, result: 'first' };
    },
    {
      async afterCommit() {
        order.push('snapshot-start');
        entered();
        await gate;
        order.push('snapshot-end');
      },
    },
  );
  await pending;
  assert.equal(fs.existsSync(`${filename}.write-lock`), true);
  const second = updateDocument(filename, (document) => {
    order.push('second');
    assert.equal(document.product.background, '第一份');
    document.product.background = '第二份';
    return { changed: true, result: 'second' };
  });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['snapshot-start', 'snapshot-end', 'second']);
});
