import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplate } from '../lib/template.mjs';
import { readDocument, renderDocument } from '../lib/document.mjs';

test('拆分源码后仍生成不需要外部脚本、样式或模块的独立 HTML', () => {
  const document = readDocument(new URL('../examples/minimal-product.json', import.meta.url));
  document.product.background = '{{BLUEPRINT_CLIENT}} 和 {{PRODUCT_DOCUMENT}} 是普通文字。';
  const html = renderDocument(document);
  const embedded = JSON.parse(
    html.match(/<script id="product-data" type="application\/json">([\s\S]*?)<\/script>/)[1],
  );
  assert.equal(embedded.product.background, document.product.background);
  assert.ok(!/<script\b[^>]*\bsrc\s*=/.test(html));
  assert.ok(!/<link\b[^>]*\brel=["']stylesheet/.test(html));
  assert.ok(!/<script\b[^>]*\btype=["']module/.test(html));
  assert.equal(renderDocument(document), html);
});

test('模板资源只替换一次，缺失或重复位置会阻止生成', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-template-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'template.html');
  fs.writeFileSync(
    filename,
    '{{BLUEPRINT_THEME}}{{BLUEPRINT_STYLES}}{{BLUEPRINT_CLIENT}}{{PRODUCT_DOCUMENT}}',
  );
  fs.writeFileSync(
    path.join(directory, 'theme.js'),
    '// {{BLUEPRINT_CLIENT}} stays in this comment\n',
  );
  fs.writeFileSync(path.join(directory, 'styles.css'), 'body { color: black; }');
  fs.writeFileSync(path.join(directory, 'client.js'), 'console.log("ready");');
  const template = loadTemplate(filename);
  assert.ok(template.includes('// {{BLUEPRINT_CLIENT}} stays in this comment'));
  assert.equal(template.split('console.log("ready");').length, 2);
  fs.writeFileSync(filename, '{{BLUEPRINT_THEME}}{{BLUEPRINT_STYLES}}');
  assert.throws(() => loadTemplate(filename), /BLUEPRINT_CLIENT/);
  fs.writeFileSync(
    filename,
    '{{BLUEPRINT_THEME}}{{BLUEPRINT_THEME}}{{BLUEPRINT_STYLES}}{{BLUEPRINT_CLIENT}}',
  );
  assert.throws(() => loadTemplate(filename), /BLUEPRINT_THEME/);
});
