import fs from 'node:fs';
import path from 'node:path';
import { inventory } from './analysis-index.mjs';

// Compare with the scan's known files. Report; never delete or infer ownership.
export function checkArtifactLayout(filename, state) {
  const book = path.dirname(fs.realpathSync(filename));
  const deliveries = new Set(
    ['product-document.json', 'index.html', 'delivery-review.json'].map((name) =>
      path.join(book, name),
    ),
  );
  const original = new Set(state.manifest.map((item) => item.file));
  const gaps = [];
  const add = (file) =>
    gaps.push({
      kind: 'artifact',
      path: file,
      message:
        '发现扫描后新增且未归入产品书或工作目录的文件；请核对来源，将本任务中间文件放入 .blueprint-analysis/work/。',
    });
  for (const item of inventory(state.root, state.scope).manifest) {
    if (original.has(item.file) || deliveries.has(path.join(state.root, item.file))) continue;
    if (
      item.kind === 'excluded' &&
      ['生成目录', '分析输出自身', '生成的产品书', '版本控制', '依赖目录'].includes(item.reason)
    )
      continue;
    add(item.file);
  }
  if (book === path.join(state.root, '.blueprint')) {
    for (const entry of fs.readdirSync(book, { withFileTypes: true }))
      if (!entry.isFile() || !deliveries.has(path.join(book, entry.name)))
        add(`.blueprint/${entry.name}`);
  }
  return gaps;
}
