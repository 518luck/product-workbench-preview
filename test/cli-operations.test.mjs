import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/product-blueprint.mjs', import.meta.url));
const example = fileURLToPath(new URL('../examples/minimal-product.json', import.meta.url));
const record = (revision) => ({
  revision,
  verifiedAt: '2026-10-13T08:00:00Z',
  checks: [{ name: '对应需求的外部验收已通过', result: 'passed' }],
});

function temporary(t, { sample = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-cli-operations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (sample) fs.copyFileSync(example, path.join(directory, 'product-document.json'));
  return directory;
}
function run(args, { input, cwd } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    encoding: 'utf8',
    input: input === undefined || typeof input === 'string' ? input : JSON.stringify(input),
    cwd,
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, '', result.stderr);
  return { ...result, data: JSON.parse(result.stdout) };
}
function success(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, JSON.stringify(result.data));
  return result.data;
}
const snapshot = (filename) => success(['document', 'get', filename]);
function mutation(action, id, filename, expectedHash, input, flags = []) {
  return run(
    [
      'feature',
      action,
      id,
      filename,
      '--expected-hash',
      expectedHash,
      ...(input === undefined ? [] : ['--input', '-']),
      ...flags,
    ],
    { input },
  );
}

test('CLI 版本、逐命令帮助和两份 Schema 均可结构化读取', () => {
  assert.match(success(['--version']).version, /^\d+\.\d+\.\d+$/);
  for (const command of [
    ['init'],
    ['validate'],
    ['render'],
    ['serve'],
    ['schema'],
    ['document'],
    ['document', 'get'],
    ['document', 'status'],
    ['document', 'check'],
    ['verification', 'run'],
    ['feature'],
    ...['list', 'get', 'create', 'update', 'define', 'delete', 'sync', 'complete'].map((action) => [
      'feature',
      action,
    ]),
    ['apply'],
  ]) {
    const result = success([...command, '--help']);
    assert.match(result.help, /产品蓝图 CLI/);
    assert.ok(result.help.includes(command.join(' ')));
  }
  const schema = success(['schema']);
  assert.equal(schema.properties.schemaVersion.const, 1);
  const changes = success(['schema', '--changes']);
  assert.equal(changes.properties.version.const, 1);
  assert.ok(changes.required.includes('expectedHash'));
  assert.ok(success(['schema', '--delivery']).required.includes('documentHash'));
  assert.ok(success(['schema', '--verification']).required.includes('command'));
});

test('CLI 分区、功能筛选与关联依赖读取不改写文件', (t) => {
  const directory = temporary(t),
    filename = path.join(directory, 'product-document.json');
  const before = fs.readFileSync(filename, 'utf8');
  const whole = snapshot(filename);
  assert.match(whole.documentHash, /^[a-f0-9]{64}$/);
  for (const section of ['product', 'dependencies', 'diagrams']) {
    const result = success(['document', 'get', '--document', directory, '--section', section]);
    assert.equal(result.documentHash, whole.documentHash);
    assert.deepEqual(result.data, whole.data[section]);
  }
  const selected = success([
    '--document',
    directory,
    'feature',
    'list',
    '--group',
    '库存/入库',
    '--status',
    'unknown',
  ]);
  assert.equal(selected.features.length, 1);
  assert.equal(selected.features[0].id, 'stock-receipt');
  assert.equal(selected.features[0].status, 'unknown');
  assert.equal(success(['feature', 'list', directory, '--group', '库存/出库']).features.length, 0);
  assert.equal(success(['feature', 'list', directory, '--status', 'complete']).features.length, 0);
  const feature = success(['feature', 'get', 'stock-receipt', directory, '--related']);
  assert.equal(feature.feature.description, whole.data.features['stock-receipt'].description);
  assert.deepEqual(
    feature.relatedDependencies.map((item) => item.id),
    ['storage'],
  );
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});

test('CLI 从任意项目的当前目录读取默认文档，同时保持默认人类输出', (t) => {
  const directory = temporary(t);
  const result = success(['feature', 'list'], { cwd: directory });
  assert.equal(result.features.length, 1);
  const human = spawnSync(process.execPath, [cli, 'feature', 'get', 'stock-receipt'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /入库登记/);
  assert.match(human.stdout, /文档哈希：/);
  assert.equal(human.stderr, '');
});

test('CLI 拒绝未知、重复、多余、缺失或冲突的参数，JSON 错误稳定返回退出码 2', (t) => {
  const directory = temporary(t);
  for (const args of [
    ['render', directory, '--unknown'],
    ['feature', 'list', directory, '--status', 'ready'],
    ['document', 'get', directory, '--section', 'invalid'],
    ['feature', 'get'],
    ['feature', 'update', 'stock-receipt', directory, '--input', '-'],
    ['feature', 'list', directory, directory],
    ['feature', 'get', 'stock-receipt', directory, directory],
    ['feature', 'get', 'stock-receipt', directory, '--document', directory],
    ['feature', 'list', directory, '--status', 'draft', '--status', 'complete'],
    ['schema', '--changes', '--changes'],
    ['serve', directory, '--port'],
    ['serve', directory, '--port', '0.5'],
    ['serve', directory, '--port', '1e2'],
    ['apply', directory, '--no-render', '--output', path.join(directory, 'out.html')],
    ['feature', '--help', '--unknown'],
    ['feature', '--help', '--output', 'out.html'],
    ['document', 'get', directory, directory, '--help'],
  ]) {
    const result = run(args, { input: {} });
    assert.equal(result.status, 2, JSON.stringify({ args, data: result.data }));
    assert.equal(result.data.code, 'INVALID_ARGUMENT');
    assert.equal(result.data.valid, false);
  }
});

test('CLI 文件及标准输入新增功能，预览不落盘且不产生锁或 HTML', (t) => {
  const directory = temporary(t),
    filename = path.join(directory, 'product-document.json');
  const before = fs.readFileSync(filename, 'utf8'),
    initial = snapshot(filename);
  const input = {
    title: '出库登记',
    description: '仓库员记录出库数量。',
    groupPath: ['库存', '出库'],
  };
  const preview = mutation('create', 'stock-out', directory, initial.documentHash, input, [
    '--dry-run',
  ]);
  assert.equal(preview.status, 0, JSON.stringify(preview.data));
  assert.equal(preview.data.dryRun, true);
  assert.equal(preview.data.documentSaved, false);
  assert.equal(preview.data.htmlUpdated, false);
  assert.equal(preview.data.features[0].after.status, 'unknown');
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['product-document.json']);
  const inputFile = path.join(directory, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const saved = success([
    'feature',
    'create',
    'stock-out',
    directory,
    '--expected-hash',
    initial.documentHash,
    '--input',
    inputFile,
  ]);
  assert.equal(saved.documentSaved, true);
  assert.equal(saved.htmlUpdated, true);
  assert.equal(saved.changed, true);
  const created = success(['feature', 'get', 'stock-out', filename]);
  assert.equal(created.feature.revision, 1);
  assert.equal(created.feature.editRevision, 1);
  assert.equal(created.feature.flowRevision, 0);
  assert.equal(created.feature.implementedRevision, null);
  assert.equal(created.feature.description, input.description);
  assert.match(fs.readFileSync(saved.html, 'utf8'), /出库登记/);
});

test('CLI 普通编辑保护原文，明确改写定义保留历史记录并检测旧哈希', (t) => {
  const directory = temporary(t),
    filename = path.join(directory, 'product-document.json');
  const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
  document.features['stock-receipt'].privateHistory = { source: '用户保留的内容' };
  fs.writeFileSync(filename, JSON.stringify(document));
  const initial = snapshot(filename),
    original = fs.readFileSync(filename, 'utf8');
  const rejected = mutation('update', 'stock-receipt', directory, initial.documentHash, {
    description: '不能静默改写',
  });
  assert.equal(rejected.status, 2);
  assert.equal(rejected.data.code, 'INVALID_ARGUMENT');
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  const saved = mutation(
    'define',
    'stock-receipt',
    filename,
    initial.documentHash,
    { description: '仓库员登记数量与供应商。' },
    ['--no-render'],
  );
  assert.equal(saved.status, 0, JSON.stringify(saved.data));
  assert.equal(saved.data.htmlUpdated, false);
  const current = success(['feature', 'get', 'stock-receipt', directory]);
  assert.equal(current.feature.revision, 2);
  assert.equal(current.feature.flowRevision, 1);
  assert.deepEqual(
    current.feature.privateHistory,
    document.features['stock-receipt'].privateHistory,
  );
  const conflict = mutation(
    'update',
    'stock-receipt',
    directory,
    initial.documentHash,
    { title: '旧快照修改' },
    ['--no-render'],
  );
  assert.equal(conflict.status, 3);
  assert.equal(conflict.data.code, 'CONFLICT');
  assert.equal(conflict.data.actualHash, current.documentHash);
});

test('CLI 无效 JSON 或错误单功能输入不会被静默忽略', (t) => {
  const directory = temporary(t),
    initial = snapshot(directory);
  for (const [action, payload] of [
    ['define', '{not JSON'],
    ['define', []],
    ['define', { description: '文本', title: '不应该丢弃' }],
    ['complete', { revision: 1, implementation: record(1), extra: true }],
  ]) {
    const result = mutation(action, 'stock-receipt', directory, initial.documentHash, payload, [
      '--no-render',
    ]);
    assert.equal(result.status, 2, JSON.stringify(result.data));
    assert.equal(result.data.code, 'INVALID_ARGUMENT');
    assert.equal(snapshot(directory).documentHash, initial.documentHash);
  }
  const withoutInput = run(['apply', directory]);
  assert.equal(withoutInput.status, 2);
});

test('CLI 整批失败全部保留，允许在同批清理引用再明确删除', (t) => {
  const directory = temporary(t),
    filename = path.join(directory, 'product-document.json');
  const initial = snapshot(filename),
    before = fs.readFileSync(filename, 'utf8');
  const rejected = run(['apply', directory, '--input', '-', '--no-render'], {
    input: {
      version: 1,
      expectedHash: initial.documentHash,
      operations: [
        { op: 'product.update', changes: { background: '本次应全部回滚' } },
        { op: 'feature.delete', id: 'stock-receipt' },
      ],
    },
  });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.data.code, 'VALIDATION_FAILED');
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  const input = {
    version: 1,
    expectedHash: initial.documentHash,
    operations: [
      { op: 'product.update', changes: { background: '只保留产品背景' } },
      { op: 'feature.delete', id: 'stock-receipt' },
      { op: 'dependency.update', id: 'storage', changes: { relations: [] } },
    ],
  };
  const preview = success(['apply', directory, '--input', '-', '--dry-run'], { input });
  assert.equal(preview.deletions[0].references.length, 1);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  const inputFile = path.join(directory, 'batch.json');
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const saved = success(['apply', directory, '--input', inputFile, '--no-render']);
  assert.equal(saved.documentSaved, true);
  const current = snapshot(directory);
  assert.deepEqual(current.data.features, {});
  assert.equal(current.data.product.background, '只保留产品背景');
});

test('CLI 流程同步及外部验收登记完成，元数据不重置完成而规则修改会回草稿', (t) => {
  const directory = temporary(t);
  let current = success(['feature', 'get', 'stock-receipt', directory]);
  let result = mutation(
    'complete',
    'stock-receipt',
    directory,
    current.documentHash,
    { revision: 1, implementation: record(1) },
    ['--no-render'],
  );
  assert.equal(result.status, 0, JSON.stringify(result.data));
  current = success(['feature', 'get', 'stock-receipt', directory]);
  assert.equal(current.feature.implementedRevision, 1);
  result = mutation(
    'update',
    'stock-receipt',
    directory,
    current.documentHash,
    { title: '到货记录', groupPath: ['仓储', '入库'] },
    ['--no-render'],
  );
  assert.equal(result.status, 0, JSON.stringify(result.data));
  current = success(['feature', 'get', 'stock-receipt', directory]);
  assert.equal(current.feature.revision, 1);
  assert.equal(success(['feature', 'list', directory, '--status', 'complete']).features.length, 1);
  result = mutation(
    'update',
    'stock-receipt',
    directory,
    current.documentHash,
    { rules: ['增加外部业务验收要求。'] },
    ['--no-render'],
  );
  assert.equal(result.status, 0, JSON.stringify(result.data));
  current = success(['feature', 'get', 'stock-receipt', directory]);
  assert.equal(current.feature.revision, 2);
  assert.equal(current.feature.implementedRevision, 1);
  assert.equal(current.feature.implementation.revision, 1);
  const stale = mutation(
    'complete',
    'stock-receipt',
    directory,
    current.documentHash,
    { revision: 1, implementation: record(1) },
    ['--no-render'],
  );
  assert.notEqual(stale.status, 0);
  const unsynced = mutation(
    'complete',
    'stock-receipt',
    directory,
    current.documentHash,
    { revision: 2, implementation: record(2) },
    ['--no-render'],
  );
  assert.notEqual(unsynced.status, 0);
  result = mutation('sync', 'stock-receipt', directory, current.documentHash, undefined, [
    '--no-render',
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.data));
  current = success(['feature', 'get', 'stock-receipt', directory]);
  assert.equal(current.feature.flowRevision, 2);
  result = mutation(
    'complete',
    'stock-receipt',
    directory,
    current.documentHash,
    { revision: 2, implementation: record(2) },
    ['--no-render'],
  );
  assert.equal(result.status, 0, JSON.stringify(result.data));
  assert.equal(success(['feature', 'list', directory, '--status', 'complete']).features.length, 1);
  current = success(['feature', 'get', 'stock-receipt', directory]);
  assert.deepEqual(current.feature.implementationHistory, [record(1)]);
});

test('CLI 文档已保存但 HTML 更新失败退出 4，能从输出确定状态并单独恢复生成', (t) => {
  const directory = temporary(t),
    initial = snapshot(directory);
  const output = path.join(directory, 'blocked.html');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'keep'), '其他内容');
  const failed = mutation(
    'update',
    'stock-receipt',
    directory,
    initial.documentHash,
    { title: '已保存的名称' },
    ['--output', output],
  );
  assert.equal(failed.status, 4, JSON.stringify(failed.data));
  assert.equal(failed.data.code, 'RENDER_FAILED');
  assert.equal(failed.data.documentSaved, true);
  assert.equal(failed.data.htmlUpdated, false);
  assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), '其他内容');
  assert.equal(
    success(['feature', 'get', 'stock-receipt', directory]).feature.title,
    '已保存的名称',
  );
  const recovered = success(['render', directory]);
  const first = fs.readFileSync(recovered.html, 'utf8');
  success(['render', directory]);
  assert.equal(fs.readFileSync(recovered.html, 'utf8'), first);
});

function startServer(t, filename) {
  const child = spawn(process.execPath, [cli, 'serve', filename, '--port', '0', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(
    () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
      }),
  );
  return new Promise((resolve, reject) => {
    let output = '',
      errors = '';
    const timer = setTimeout(() => reject(new Error(`CLI 服务未启动：${errors}`)), 10000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI 服务提前退出 ${code}：${errors}${output}`));
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        return;
      }
      clearTimeout(timer);
      if (!result.url) return reject(new Error(`CLI 服务启动失败：${output}`));
      assert.equal(errors, '');
      resolve(result);
    });
  });
}

test('CLI serve JSON 输出可解析，页面及 CLI 交叉保存会拒绝对方旧版本', async (t) => {
  const directory = temporary(t),
    filename = path.join(directory, 'product-document.json');
  const initial = success(['feature', 'get', 'stock-receipt', directory]);
  const started = await startServer(t, filename);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(started.port > 0);
  const put = (body) =>
    fetch(`${started.url}/document/features/stock-receipt`, {
      method: 'PUT',
      headers: { Origin: started.url, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let response = await put({
    title: '页面先保存的名称',
    description: initial.feature.description,
    expectedRevision: initial.feature.revision,
    expectedEditRevision: initial.feature.editRevision ?? 0,
  });
  assert.equal(response.status, 200);
  const pageSaved = await response.json();
  const conflict = mutation(
    'update',
    'stock-receipt',
    directory,
    initial.documentHash,
    { title: '过时 CLI' },
    ['--no-render'],
  );
  assert.equal(conflict.status, 3);
  const latest = success(['feature', 'get', 'stock-receipt', directory]);
  const cliSaved = mutation(
    'define',
    'stock-receipt',
    directory,
    latest.documentHash,
    { description: 'CLI 保存的明确新定义。' },
    ['--no-render'],
  );
  assert.equal(cliSaved.status, 0, JSON.stringify(cliSaved.data));
  response = await put({
    description: '过时页面的定义',
    expectedRevision: pageSaved.revision,
    expectedEditRevision: pageSaved.editRevision,
  });
  assert.equal(response.status, 409);
  assert.equal(
    success(['feature', 'get', 'stock-receipt', directory]).feature.description,
    'CLI 保存的明确新定义。',
  );
});

test('CLI 完成输入支持按编号清理已验收批注，读取摘要可发现批注', (t) => {
  const directory = temporary(t);
  const filename = path.join(directory, 'product-document.json');
  const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
  document.features['stock-receipt'].annotations = [
    {
      id: 'annotation-cli',
      text: '核验数量与批次保存。',
      createdAt: '2026-10-14T00:00:00Z',
      definitionRevision: 1,
    },
  ];
  fs.writeFileSync(filename, JSON.stringify(document));
  assert.equal(success(['feature', 'list', filename]).features[0].annotationCount, 1);
  const result = mutation('complete', 'stock-receipt', filename, snapshot(filename).documentHash, {
    revision: 1,
    implementation: record(1),
    resolvedAnnotationIds: ['annotation-cli'],
  });
  assert.equal(result.status, 0, JSON.stringify(result.data));
  const current = success(['feature', 'get', 'stock-receipt', filename]).feature;
  assert.equal(current.implementedRevision, current.revision);
  assert.deepEqual(current.annotations, []);
  assert.equal(success(['feature', 'list', filename]).features[0].annotationCount, 0);
});
