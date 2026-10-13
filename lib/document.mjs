import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTemplate } from './template.mjs';
import { validateDocument } from './validation.mjs';
import { BlueprintError } from './errors.mjs';
export { templatePath } from './template.mjs';
export { validateDocument } from './validation.mjs';
export const schemaPath = fileURLToPath(
  new URL('../schema/product-document.schema.json', import.meta.url),
);

export function readDocument(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

export function renderDocument(document, template = loadTemplate()) {
  const report = validateDocument(document);
  if (!report.valid) {
    const error = new Error(
      report.errors.map((item) => `${item.path}：${item.message}`).join('\n'),
    );
    error.report = report;
    throw error;
  }
  if (template.split('{{PRODUCT_DOCUMENT}}').length !== 2)
    throw new Error('固定模板的数据位置不完整。');
  return template.replace('{{PRODUCT_DOCUMENT}}', () =>
    JSON.stringify(document).replace(/</g, '\\u003c'),
  );
}

export function writeHtml(filename, html) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (fs.existsSync(filename) && !fs.lstatSync(filename).isFile())
    throw new Error('输出位置必须是普通 HTML 文件。');
  const temporary = `${filename}.${process.pid}.tmp`;
  let created = false;
  try {
    fs.writeFileSync(temporary, html, { flag: 'wx' });
    created = true;
    fs.renameSync(temporary, filename);
  } finally {
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function assertHtmlOutput(documentPath, output) {
  const source = path.resolve(documentPath),
    target = path.resolve(output);
  if (!target.endsWith('.html') || target === source)
    throw new BlueprintError('INVALID_ARGUMENT', '输出必须是独立的 .html 文件。');
  const canonical = fs.realpathSync(source);
  if ((fs.existsSync(target) ? fs.realpathSync(target) : target) === canonical)
    throw new BlueprintError('INVALID_ARGUMENT', 'HTML 输出不能与真实文档路径相同。');
  return canonical;
}
