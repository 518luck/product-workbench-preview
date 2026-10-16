import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  scanAnalysis,
  listAnalysis,
  readAnalysis,
  recordAnalysis,
  traceAnalysis,
  checkAnalysis,
  loadSession,
} from '../lib/analysis-session.mjs';
import { applyChanges, readSnapshot } from '../lib/document-operations.mjs';

const cli = fileURLToPath(new URL('../bin/product-blueprint.mjs', import.meta.url));
export function fixture(t, extras = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-analysis-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({
    'main.ts': 'export function allowed(role: string) { return role === "admin"; }',
    'package.json': '{"name":"permission-product"}',
    ...extras,
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      product: { name: '权限产品', background: '', actors: [] },
      features: {},
      dependencies: [],
      diagrams: {},
    }),
  );
  return { root, filename };
}
export function summary(unit, receiptIds, extra = {}) {
  return {
    unitId: typeof unit === 'string' ? unit : unit.id,
    receiptIds,
    responsibility: '检查管理员权限',
    inputs: ['角色'],
    outputs: ['是否允许'],
    conditions: ['仅 admin 允许'],
    calls: [],
    sideEffects: [],
    exceptions: [],
    unknowns: [],
    coverage: (unit.reviewPoints || []).map((point) => ({
      pointId: point.id,
      detail:
        point.kind === 'parameter'
          ? 'role 参数提供当前调用者角色。'
          : '将 role 与 admin 比较，管理员返回 true，其余角色返回 false。',
    })),
    ...extra,
  };
}
export async function analyzeAll(session) {
  let offset = 0;
  do {
    const page = listAnalysis(session, { offset, limit: 200 });
    for (const unit of page.items) {
      const receiptIds = [];
      let readOffset = 0;
      do {
        const read = await readAnalysis(session, unit.id, { offset: readOffset });
        receiptIds.push(read.receipt.id);
        readOffset = read.nextOffset;
      } while (readOffset !== null);
      await recordAnalysis(session, { records: [summary(unit, receiptIds)] });
    }
    offset = page.nextOffset;
  } while (offset !== null);
  for (const context of listAnalysis(session, { kind: 'contexts' }).items) {
    let offset = 0;
    do {
      const read = await readAnalysis(session, context.id, { offset });
      offset = read.nextOffset;
    } while (offset !== null);
  }
}
export async function traceValues(session, value, pointer, classification = 'observed') {
  const state = loadSession(session).state,
    record = Object.values(state.records).find((record) => record.role === 'product');
  const evidence =
    classification === 'observed'
      ? [{ kind: 'code', unitId: record.unitId, recordHash: record.recordHash }]
      : [{ kind: 'requirement', source: 'user', text: '用户确认的管理员访问需求' }];
  const traces = [];
  function visit(item, target) {
    if (item === undefined) return;
    if (item !== null && typeof item === 'object' && Object.keys(item).length)
      for (const [key, child] of Object.entries(item))
        visit(child, `${target}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    else
      traces.push({
        id: `evidence-${Object.keys(state.traces).length + traces.length}`,
        target,
        value: item,
        classification,
        evidence,
      });
  }
  visit(value, pointer);
  if (traces.length) await traceAnalysis(session, { traces });
}
const newFeature = {
  title: '管理员访问',
  description: '仅管理员可以进入管理页面。',
  groupPath: ['账户'],
  rules: ['仅管理员允许访问。'],
  flow: [['判断权限', '管理员进入管理页面']],
  stepDetails: [
    {
      title: '判断权限',
      actor: '权限服务',
      description: '检查当前角色。',
      rules: ['仅管理员允许访问。'],
      dependencies: [],
      result: '显示管理页面。',
      exception: '普通用户被拒绝。',
      acceptance: '普通用户不能进入。',
      interactions: [],
    },
  ],
  dependencies: [],
};
const create = (hash) => ({
  version: 1,
  expectedHash: hash,
  operations: [{ op: 'feature.create', id: 'access', data: newFeature }],
});

test('遗漏记录、读取缺口和伪造凭据不能通过；记录批次失败不留下部分数据', async (t) => {
  const { root } = fixture(t),
    scan = await scanAnalysis(root),
    unit = listAnalysis(scan.session).items[0];
  assert.equal(checkAnalysis(scan.session).valid, false);
  await assert.rejects(recordAnalysis(scan.session, { records: [summary(unit, ['r-fake'])] }), {
    code: 'ANALYSIS_INCOMPLETE',
  });
  const part = await readAnalysis(scan.session, unit.id, { length: 10 });
  await assert.rejects(
    recordAnalysis(scan.session, { records: [summary(unit, [part.receipt.id])] }),
    { code: 'ANALYSIS_INCOMPLETE' },
  );
  const whole = await readAnalysis(scan.session, unit.id);
  const before = fs.readFileSync(path.join(scan.session, 'state.json'), 'utf8');
  await assert.rejects(
    recordAnalysis(scan.session, {
      records: [summary(unit, [whole.receipt.id]), summary('unknown', [whole.receipt.id])],
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  assert.equal(fs.readFileSync(path.join(scan.session, 'state.json'), 'utf8'), before);
  await recordAnalysis(scan.session, { records: [summary(unit, [whole.receipt.id])] });
  assert.ok(checkAnalysis(scan.session).gaps.some((gap) => gap.kind === 'context'));
  await analyzeAll(scan.session);
  assert.equal(checkAnalysis(scan.session).valid, true);
});

test('内容或解析配置变化使会话失效，相同快照恢复记录，锁冲突保留他人锁', async (t) => {
  const { root } = fixture(t),
    scan = await scanAnalysis(root);
  await analyzeAll(scan.session);
  assert.equal((await scanAnalysis(root)).resumed, true);
  assert.equal(checkAnalysis(scan.session).valid, true);
  const lock = path.join(scan.session, 'state.json.write-lock');
  fs.writeFileSync(lock, 'another owner');
  await assert.rejects(readAnalysis(scan.session, listAnalysis(scan.session).items[0].id), {
    code: 'CONFLICT',
  });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another owner');
  fs.unlinkSync(lock);
  fs.appendFileSync(path.join(root, 'main.ts'), '\nfunction added() {}');
  assert.throws(() => checkAnalysis(scan.session), { code: 'ANALYSIS_STALE' });
  const next = await scanAnalysis(root);
  assert.notEqual(next.session, scan.session);
  assert.equal(next.resumed, false);
  assert.equal(Object.keys(loadSession(next.session).state.records).length, 0);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  assert.throws(() => checkAnalysis(next.session), { code: 'ANALYSIS_STALE' });
});

test('严格分析写入需要逐字段依据；预览不写文件，值变化使旧依据无效，手动命令仍可用', async (t) => {
  const { root, filename } = fixture(t),
    scan = await scanAnalysis(root),
    original = fs.readFileSync(filename, 'utf8'),
    bundle = create(readSnapshot(filename).documentHash);
  await assert.rejects(applyChanges(filename, bundle, { analysisSession: scan.session }), {
    code: 'ANALYSIS_INCOMPLETE',
  });
  await analyzeAll(scan.session);
  await assert.rejects(applyChanges(filename, bundle, { analysisSession: scan.session }), {
    code: 'ANALYSIS_INCOMPLETE',
  });
  await traceValues(scan.session, newFeature, '/features/access');
  const preview = await applyChanges(filename, bundle, {
    analysisSession: scan.session,
    dryRun: true,
  });
  assert.equal(preview.analysis.valid, true);
  assert.equal(preview.documentSaved, false);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, 'index.html')), false);
  const changed = structuredClone(bundle);
  changed.operations[0].data.rules = ['改后的未分析规则'];
  await assert.rejects(applyChanges(filename, changed, { analysisSession: scan.session }), {
    code: 'ANALYSIS_INCOMPLETE',
  });
  const saved = await applyChanges(filename, bundle, { analysisSession: scan.session });
  assert.equal(saved.documentSaved, true);
  assert.equal(saved.htmlUpdated, true);
  const manual = {
    version: 1,
    expectedHash: saved.documentHash,
    operations: [{ op: 'feature.update', id: 'access', changes: { title: '管理员权限' } }],
  };
  assert.equal((await applyChanges(filename, manual, { render: false })).changed, true);
});

test('显式部分分析交付报告及草稿，任何完成操作都被拒绝，源码过期不可豁免', async (t) => {
  const { root, filename } = fixture(t, { 'legacy.py': 'def legacy(): pass' }),
    scan = await scanAnalysis(root);
  const saved = await applyChanges(filename, create(readSnapshot(filename).documentHash), {
    analysisSession: scan.session,
    allowPartialAnalysis: true,
    render: false,
  });
  assert.equal(saved.analysis.partial, true);
  assert.ok(saved.analysis.gaps.some((gap) => gap.kind === 'language'));
  const feature = readSnapshot(filename).document.features.access;
  assert.equal(feature.implementedRevision, null);
  const complete = {
    version: 1,
    expectedHash: saved.documentHash,
    operations: [
      { op: 'feature.sync', id: 'access' },
      {
        op: 'feature.complete',
        id: 'access',
        revision: 1,
        implementation: {
          revision: 1,
          verifiedAt: new Date().toISOString(),
          checks: [{ name: '权限验收', result: 'passed' }],
        },
      },
    ],
  };
  await assert.rejects(
    applyChanges(filename, complete, { analysisSession: scan.session, allowPartialAnalysis: true }),
    { code: 'ANALYSIS_INCOMPLETE' },
  );
  fs.appendFileSync(path.join(root, 'main.ts'), '\n// change');
  await assert.rejects(
    applyChanges(
      filename,
      {
        version: 1,
        expectedHash: saved.documentHash,
        operations: [{ op: 'feature.update', id: 'access', changes: { title: '新名称' } }],
      },
      { analysisSession: scan.session, allowPartialAnalysis: true },
    ),
    { code: 'ANALYSIS_STALE' },
  );
});

test('分析记录更新使引用旧记录的依据失效；未知不得作为已确认业务事实', async (t) => {
  const { root } = fixture(t),
    scan = await scanAnalysis(root);
  await analyzeAll(scan.session);
  await traceValues(scan.session, '仅管理员可以访问。', '/features/access/description');
  const record = Object.values(loadSession(scan.session).state.records)[0];
  await recordAnalysis(scan.session, {
    records: [
      summary(
        loadSession(scan.session).state.units.find((unit) => unit.id === record.unitId),
        record.receiptIds,
        { responsibility: '新的分析内容' },
      ),
    ],
  });
  assert.ok(checkAnalysis(scan.session).gaps.some((gap) => gap.kind === 'trace'));
  await assert.rejects(
    traceAnalysis(scan.session, {
      traces: [
        {
          id: 'invalid-observed',
          target: '/features/access/rules/0',
          value: '猜测',
          classification: 'observed',
          evidence: [{ kind: 'requirement', source: 'user', text: '期望' }],
        },
      ],
    }),
    { code: 'VALIDATION_FAILED' },
  );
});

test('CLI 读写接口、标准输入、分页与检查退出码', (t) => {
  const { root } = fixture(t);
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
      cwd: root,
      encoding: 'utf8',
      input,
    });
    assert.ifError(result.error);
    return { ...result, data: JSON.parse(result.stdout) };
  };
  const scan = run(['analysis', 'scan']);
  assert.equal(scan.status, 0);
  const session = scan.data.session;
  const list = run([
    'analysis',
    'list',
    '--session',
    session,
    '--status',
    'pending',
    '--limit',
    '1',
  ]);
  assert.equal(list.data.items.length, 1);
  const unit = list.data.items[0];
  const read = run(['analysis', 'read', unit.id, '--session', session]);
  assert.equal(read.data.code.includes('allowed'), true);
  const record = run(
    ['analysis', 'record', '--session', session, '--input', '-'],
    JSON.stringify({ records: [summary(unit, [read.data.receipt.id])] }),
  );
  assert.equal(record.status, 0);
  assert.equal(run(['analysis', 'check', '--session', session]).status, 1);
  assert.equal(
    run(['analysis', 'list', '--session', session, '--limit', '0']).data.code,
    'INVALID_ARGUMENT',
  );
  assert.ok(run(['schema', '--analysis']).data.$defs.record);
});

test('提交前源码并发变化拒绝落盘，保留原文和原 HTML，释放本次锁及临时文件', async (t) => {
  const { root, filename } = fixture(t),
    scan = await scanAnalysis(root);
  await analyzeAll(scan.session);
  await traceValues(scan.session, newFeature, '/features/access');
  const original = fs.readFileSync(filename, 'utf8'),
    html = path.join(root, 'index.html');
  fs.writeFileSync(html, '原 HTML');
  const write = fs.promises.writeFile;
  let injected = false;
  fs.promises.writeFile = async (target, ...args) => {
    const result = await write(target, ...args);
    if (
      path.dirname(String(target)) === fs.realpathSync(root) &&
      path.basename(String(target)).startsWith('.product-document.json.')
    ) {
      injected = true;
      fs.appendFileSync(path.join(root, 'main.ts'), '\n// changed during commit');
    }
    return result;
  };
  try {
    await assert.rejects(
      applyChanges(filename, create(readSnapshot(filename).documentHash), {
        analysisSession: scan.session,
      }),
      { code: 'ANALYSIS_STALE' },
    );
  } finally {
    fs.promises.writeFile = write;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  assert.equal(fs.readFileSync(html, 'utf8'), '原 HTML');
  assert.ok(
    !fs.readdirSync(root).some((file) => file.endsWith('.tmp') || file.endsWith('.write-lock')),
  );
  assert.equal(fs.existsSync(path.join(scan.session, 'state.json.write-lock')), false);
});

test('未来需求不能冒充当前完成依据，过期字段依据不能绕过完成检查', async (t) => {
  const { root, filename } = fixture(t),
    scan = await scanAnalysis(root);
  await analyzeAll(scan.session);
  await traceValues(scan.session, newFeature, '/features/access', 'requested');
  const saved = await applyChanges(
    filename,
    {
      ...create(readSnapshot(filename).documentHash),
      operations: [...create('').operations, { op: 'feature.sync', id: 'access' }],
    },
    { analysisSession: scan.session },
  );
  await traceValues(scan.session, '旧的未应用规则', '/features/access/rules/1', 'observed');
  await assert.rejects(
    applyChanges(
      filename,
      {
        version: 1,
        expectedHash: saved.documentHash,
        operations: [
          {
            op: 'feature.complete',
            id: 'access',
            revision: 1,
            implementation: {
              revision: 1,
              verifiedAt: new Date().toISOString(),
              checks: [{ name: '声明通过', result: 'passed' }],
            },
          },
        ],
      },
      { analysisSession: scan.session },
    ),
    { code: 'ANALYSIS_INCOMPLETE' },
  );
  assert.equal(readSnapshot(filename).document.features.access.implementedRevision, null);
});
