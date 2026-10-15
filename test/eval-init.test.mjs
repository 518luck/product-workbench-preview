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
