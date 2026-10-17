import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cases,
  prepareCase,
  gradeCase,
  runSuite,
  checkOriginalScope,
  checkArtifactLayout,
} from '../scripts/evaluate-init.mjs';

test('六类初始化评测各自隔离，保护源码与示例，已有进度保留待分析项', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-eval-fixtures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const item of cases) {
    const directory = path.join(root, item.id);
    const original = await prepareCase(directory, item);
    const grade = await gradeCase(directory, item, original);
    assert.equal(grade.valid, false);
    assert.ok(grade.errors.length);
    if (item.example) assert.ok(fs.existsSync(path.join(directory, 'product-document.json')));
    if (item.resume) assert.ok(fs.existsSync(path.join(directory, '.blueprint-analysis')));
  }
  const directory = path.join(root, 'tampered');
  const original = await prepareCase(directory, cases[0]);
  fs.writeFileSync(path.join(directory, 'access.mjs'), '修改输入');
  assert.ok(
    (await gradeCase(directory, cases[0], original)).errors.some((e) =>
      e.includes('输入文件被修改'),
    ),
  );
});
test('评测以产物评分，外部程序仅声称成功无法通过；重复执行各用新目录并写报告', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-eval-harness-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await runSuite({
    agent: { command: process.execPath, args: ['-e', "process.stdout.write('初始化已完成')"] },
    trials: 2,
    caseIds: ['implemented'],
    directory,
  });
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.exitCode === 0 && !r.valid));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json')));
  assert.equal(report.passed, 0);
  assert.equal(report.allTrialsPassed[0].passed, false);
  assert.ok(fs.existsSync(path.join(directory, 'implemented-1/transcript.log')) === false);
  assert.ok(fs.existsSync(path.join(directory, 'implemented-2/access.mjs')));
});
test('评分允许排除生成产物，但独立拒绝遗漏原始源码或项目配置', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-eval-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = await prepareCase(
    root,
    cases.find((item) => item.id === 'nested'),
  );
  assert.deepEqual(
    checkOriginalScope(root, original, {
      include: ['.'],
      exclude: ['.blueprint/**', '.blueprint-analysis/**'],
    }),
    [],
  );
  const errors = checkOriginalScope(root, original, {
    include: ['access.mjs'],
    exclude: ['package.json'],
  });
  assert.ok(errors.some((error) => error.includes('normalize.mjs')));
  assert.ok(errors.some((error) => error.includes('package.json')));
});

test('初始化产物统一存放，评分报告根目录、源码目录及产品书内的杂项文件', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-eval-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = await prepareCase(
    root,
    cases.find((item) => item.example),
  );
  for (const file of [
    '.blueprint/product-document.json',
    '.blueprint/index.html',
    '.blueprint/delivery-review.json',
    '.blueprint-analysis/work/task-a/batch.json',
    '.blueprint-analysis/s-example/verifications/run.json',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '{}');
  }
  assert.deepEqual(checkArtifactLayout(root, original), []);
  const misplaced = [
    'batch.json',
    'src/analyze.mjs',
    '.blueprint/traces.json',
    'another-book/index.html',
  ];
  for (const file of misplaced) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '{}');
  }
  const errors = checkArtifactLayout(root, original);
  assert.equal(errors.length, misplaced.length);
  for (const file of misplaced) assert.ok(errors.some((error) => error.endsWith(file)));
  assert.ok(
    (
      await gradeCase(
        root,
        cases.find((item) => item.example),
        original,
      )
    ).errors.some((error) => error.includes('生成产物不在约定位置：batch.json')),
  );
  for (const file of misplaced) fs.rmSync(path.join(root, file));
  fs.symlinkSync(path.join(root, '.blueprint-analysis'), path.join(root, '.blueprint', 'external'));
  assert.ok(
    checkArtifactLayout(root, original).some((error) => error.endsWith('.blueprint/external')),
  );
  fs.rmSync(path.join(root, '.blueprint-analysis'), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(root, '.blueprint-analysis'));
  assert.ok(
    checkArtifactLayout(root, original).some((error) => error.endsWith('.blueprint-analysis')),
  );
});
