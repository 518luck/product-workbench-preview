import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/product-blueprint.mjs', import.meta.url));
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-cli-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('初始化检查之后出现的 HTML 仍不被覆盖，不留下半份文档', (t) => {
  const directory = temporary(t),
    target = path.join(directory, 'project'),
    preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs'); const original = fs.mkdirSync; fs.mkdirSync = function (directory, options) { const result = original(directory, options); if (directory === ${JSON.stringify(target)}) fs.writeFileSync(${JSON.stringify(path.join(target, 'index.html'))}, '其他进程的 HTML'); return result; };`,
  );
  const result = spawnSync(
    process.execPath,
    ['--require', preload, cli, 'init', target, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '其他进程的 HTML');
  assert.equal(fs.existsSync(path.join(target, 'product-document.json')), false);
});

test('初始化第二个文件写入失败，回滚本次创建的两个文件', (t) => {
  const directory = temporary(t),
    target = path.join(directory, 'project'),
    preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs'); const open = fs.openSync; const write = fs.writeFileSync; let fail; fs.openSync = function (filename, ...args) { const descriptor = open(filename, ...args); if (filename === ${JSON.stringify(path.join(target, 'product-document.json'))}) fail = descriptor; return descriptor; }; fs.writeFileSync = function (filename, ...args) { if (filename === fail) throw Object.assign(new Error('模拟写入失败'), { code: 'EACCES' }); return write(filename, ...args); };`,
  );
  const result = spawnSync(
    process.execPath,
    ['--require', preload, cli, 'init', target, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(path.join(target, 'index.html')), false);
  assert.equal(fs.existsSync(path.join(target, 'product-document.json')), false);
});
