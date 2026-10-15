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
} from '../lib/analysis-session.mjs';
import { applyChanges, readSnapshot } from '../lib/document-operations.mjs';
import { updateDocument } from '../lib/document-store.mjs';
import { savePageAnnotation } from '../lib/feature-operations.mjs';
import { checkSourceStatus } from '../lib/source-status.mjs';

const cli = fileURLToPath(new URL('../bin/product-blueprint.mjs', import.meta.url));
const skills = fileURLToPath(new URL('../skills/', import.meta.url));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-skill-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
async function analyze(session) {
  const records = [];
  // This small known-answer fixture can use a page at a time. Real skills keep requesting pending offset 0.
  for (const unit of listAnalysis(session, { limit: 200 }).items) {
    const read = await readAnalysis(session, unit.id);
    assert.equal(read.nextOffset, null);
    const role = unit.role === 'verification';
    const isTitle = unit.name === 'validateTitle',
      isPublish = unit.name === 'publish';
    const record = {
      unitId: unit.id,
      receiptIds: [read.receipt.id],
      responsibility: role
        ? '验收发布权限、空标题、重复发布和持久化结果'
        : isTitle
          ? '去除标题空白并拒绝空标题'
          : isPublish
            ? '核验权限和文档状态，保存发布标题及状态'
            : '定义可发布的角色集合',
      inputs: role ? [] : isTitle ? ['标题文字'] : isPublish ? ['角色', '文档对象'] : [],
      outputs: role
        ? ['断言通过或失败']
        : isTitle
          ? ['非空的去空白标题']
          : isPublish
            ? ['published 文档对象']
            : ['允许角色数组'],
      conditions: role
        ? ['管理员成功', '普通成员拒绝', '重复发布拒绝', '空标题拒绝']
        : isTitle
          ? ['trim 后不可为空']
          : isPublish
            ? ['角色在允许集合中', '状态为 draft']
            : [],
      calls: unit.calls.map((call) => `${call.expression}: ${call.status}`),
      sideEffects: isPublish ? ['修改文档的 title 和 status'] : [],
      exceptions: isTitle ? ['空标题抛错'] : isPublish ? ['无权限或重复发布抛错'] : [],
      unknowns: unit.calls
        .filter((call) => call.status === 'unknown')
        .map((call) => `${call.expression} 是外部／动态调用`),
    };
    if (isTitle) assert.match(read.code, /trim/);
    if (isPublish) assert.match(read.code, /validateTitle/);
    const saved = await recordAnalysis(session, { records: [record] });
    records.push(saved.records[0]);
  }
  for (const context of listAnalysis(session, { kind: 'contexts' }).items)
    await readAnalysis(session, context.id);
  assert.equal(checkAnalysis(session).valid, true);
  return records;
}
async function traces(session, values, evidence, classification = 'observed') {
  const result = [];
  function visit(value, pointer) {
    if (value !== null && typeof value === 'object' && Object.keys(value).length)
      for (const [key, child] of Object.entries(value)) visit(child, `${pointer}/${key}`);
    else
      result.push({
        id: `trace-${result.length}`,
        target: pointer,
        value,
        classification,
        evidence,
      });
  }
  for (const [pointer, value] of Object.entries(values)) visit(value, pointer);
  await traceAnalysis(session, { traces: result });
}
const program = (
  editors = false,
) => `export const roles = ${editors ? "['admin','editor']" : "['admin']"};
export function validateTitle(title) { if (!title.trim()) throw new Error('空标题'); return title.trim(); }
export function publish(role, doc) { if (!roles.includes(role)) throw new Error('无权限'); if (doc.status !== 'draft') throw new Error('已发布'); doc.title = validateTitle(doc.title); doc.status = 'published'; return doc; }
`;
const detail = (rules) => ({
  actor: '发布服务',
  description: '核验成员权限及文档状态，校验标题后保存发布状态。',
  rules,
  dependencies: [],
  result: '保存 published 状态和去空白标题。',
  exception: '无权限、空标题或重复发布均拒绝，文档保持原状态。',
  acceptance: '正常发布成功，三个拒绝路径保留原状态。',
  interactions: [],
});

test('三个 Skill 独立引用有效；初始化、需求维护、实际实现验收的已知业务样例', async (t) => {
  for (const name of [
    'product-blueprint-init',
    'product-blueprint-maintain',
    'product-blueprint-implement',
  ]) {
    const folder = path.join(skills, name),
      text = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    assert.ok(text.includes(`name: ${name}`));
    for (const [, reference] of text.matchAll(/\]\((references\/[^)]+)\)/g))
      assert.ok(fs.existsSync(path.join(folder, reference)), reference);
    assert.ok(
      fs.readFileSync(path.join(folder, 'agents/openai.yaml'), 'utf8').includes(`$${name}`),
    );
  }
  const root = temporary(t),
    filename = path.join(root, 'product-document.json');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"content-studio","type":"module"}');
  fs.writeFileSync(path.join(root, 'publish.mjs'), program());
  run(['init', root, '--name', '内容发布'], root);
  const first = await scanAnalysis(root),
    records = await analyze(first.session);
  const publishRecord = records.find((record) => record.responsibility.includes('核验权限'));
  const code = [
    { kind: 'code', unitId: publishRecord.unitId, recordHash: publishRecord.recordHash },
  ];
  const feature = {
    title: '发布文档',
    description: '有权限的成员发布草稿文档，保存非空标题与发布状态；不允许重复发布。',
    groupPath: ['内容', '发布'],
    rules: ['只有管理员可以发布。', '只有 draft 可以发布。', '标题不能为空。'],
    flow: [['发布文档', '检查权限、状态及标题，保存结果']],
    stepDetails: [detail(['只有管理员可以发布。'])],
    dependencies: [],
  };
  await traces(
    first.session,
    { '/product/background': '让内容成员按权限发布文档。', '/features/publish': feature },
    code,
  );
  const batch = {
    version: 1,
    expectedHash: readSnapshot(filename).documentHash,
    operations: [
      { op: 'product.update', changes: { background: '让内容成员按权限发布文档。' } },
      { op: 'feature.create', id: 'publish', data: feature },
      { op: 'feature.sync', id: 'publish' },
    ],
  };
  assert.equal(
    (await applyChanges(filename, batch, { analysisSession: first.session, dryRun: true }))
      .documentSaved,
    false,
  );
  await applyChanges(filename, batch, { analysisSession: first.session });
  let current = readSnapshot(filename).document.features.publish;
  assert.deepEqual(current.groupPath, ['内容', '发布']);
  assert.match(current.stepDetails[0].exception, /重复发布/);
  assert.equal(current.implementedRevision, null);

  await updateDocument(
    filename,
    savePageAnnotation({
      id: 'publish',
      annotationId: 'annotation-editor',
      text: '让编辑也可以发布，普通成员仍不可发布。',
      expectedRevision: current.revision,
      expectedEditRevision: current.editRevision,
    }),
  );
  const annotation = readSnapshot(filename).document.features.publish.annotations[0];

  // Maintenance: this is a desired future rule, not evidence that the old code already implements it.
  const changes = {
    rules: ['管理员或编辑可以发布。', '只有 draft 可以发布。', '标题不能为空。'],
    stepDetails: [detail(['管理员或编辑可以发布。'])],
  };
  const requested = [{ kind: 'requirement', source: 'user', text: annotation.text }];
  await traces(
    first.session,
    {
      '/features/publish/rules': changes.rules,
      '/features/publish/stepDetails': changes.stepDetails,
    },
    requested,
    'requested',
  );
  const maintenance = {
    version: 1,
    expectedHash: readSnapshot(filename).documentHash,
    operations: [{ op: 'feature.update', id: 'publish', changes }],
    affectedFeatureIds: ['publish'],
  };
  await applyChanges(filename, maintenance, { analysisSession: first.session, dryRun: true });
  await applyChanges(filename, maintenance, { analysisSession: first.session });
  current = readSnapshot(filename).document.features.publish;
  assert.equal(current.description, feature.description);
  assert.equal(current.id, 'publish');
  assert.equal(current.revision, 2);
  assert.equal(current.flowRevision, 1);

  // Implementation: modify the isolated sample, then actually execute meaningful acceptance checks externally.
  fs.writeFileSync(path.join(root, 'publish.mjs'), program(true));
  fs.writeFileSync(
    path.join(root, 'publish.test.mjs'),
    `import assert from 'node:assert/strict'; import {publish} from './publish.mjs';
for (const role of ['admin','editor']) { const doc={title:' name ',status:'draft'}; assert.equal(publish(role,doc).status,'published'); assert.equal(doc.title,'name'); }
for (const [role,doc] of [['member',{title:'x',status:'draft'}],['admin',{title:' ',status:'draft'}],['admin',{title:'x',status:'published'}]]) { const before={...doc}; assert.throws(() => publish(role,doc)); assert.deepEqual(doc,before); }
`,
  );
  const acceptance = spawnSync(process.execPath, ['--test', 'publish.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(acceptance.status, 0, acceptance.stdout + acceptance.stderr);
  assert.throws(() => checkAnalysis(first.session), { code: 'ANALYSIS_STALE' });
  const implemented = await scanAnalysis(root),
    currentRecords = await analyze(implemented.session);
  const productRecord = currentRecords.find((record) => record.responsibility.includes('核验权限'));
  const testRecord = currentRecords.find((record) => record.role === 'verification');
  assert.ok(testRecord);
  const evidence = [
    { kind: 'code', unitId: productRecord.unitId, recordHash: productRecord.recordHash },
    { kind: 'code', unitId: testRecord.unitId, recordHash: testRecord.recordHash },
  ];
  await traces(
    implemented.session,
    {
      '/features/publish/description': feature.description,
      '/features/publish/flow': current.flow,
      '/features/publish/stepDetails': current.stepDetails,
      '/features/publish/rules': current.rules,
    },
    evidence,
  );
  const verification = {
    revision: 2,
    verifiedAt: new Date().toISOString(),
    checks: [
      {
        name: 'node --test publish.test.mjs：管理员及编辑发布成功，普通成员、空标题及重复发布拒绝且保留原状态',
        result: 'passed',
      },
    ],
  };
  const completion = {
    version: 1,
    expectedHash: readSnapshot(filename).documentHash,
    operations: [
      { op: 'feature.sync', id: 'publish' },
      {
        op: 'feature.complete',
        id: 'publish',
        revision: 2,
        implementation: verification,
        resolvedAnnotationIds: [annotation.id],
      },
    ],
  };
  await applyChanges(filename, completion, { analysisSession: implemented.session, dryRun: true });
  await applyChanges(filename, completion, { analysisSession: implemented.session });
  current = readSnapshot(filename).document.features.publish;
  assert.equal(current.revision, 2);
  assert.equal(current.implementedRevision, 2);
  assert.deepEqual(current.annotations, []);
  assert.equal(current.implementation.sourceSnapshot.snapshotHash, implemented.snapshotHash);
  assert.equal(
    (await checkSourceStatus(readSnapshot(filename).document)).features.publish.status,
    'current',
  );
  const repeated = await applyChanges(
    filename,
    {
      ...completion,
      expectedHash: readSnapshot(filename).documentHash,
      operations: [
        { op: 'feature.complete', id: 'publish', revision: 2, implementation: verification },
      ],
    },
    { analysisSession: implemented.session },
  );
  assert.equal(repeated.changed, false);
  assert.equal(current.flowRevision, 2);
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /管理员或编辑/);
  const beforeExternalChange = fs.readFileSync(filename, 'utf8');
  fs.writeFileSync(path.join(root, 'publish.mjs'), program(false));
  const stale = (await checkSourceStatus(readSnapshot(filename).document)).features.publish;
  assert.equal(stale.status, 'changed');
  assert.ok(stale.changes.some((change) => change.file === 'publish.mjs'));
  assert.equal(current.revision, current.implementedRevision);
  await assert.rejects(
    applyChanges(
      filename,
      {
        ...completion,
        expectedHash: readSnapshot(filename).documentHash,
        operations: [
          { op: 'feature.complete', id: 'publish', revision: 2, implementation: verification },
        ],
      },
      { analysisSession: implemented.session },
    ),
    { code: 'ANALYSIS_STALE' },
  );
  assert.equal(fs.readFileSync(filename, 'utf8'), beforeExternalChange);
});

test('无源码项目根据需求创建草稿，不产生伪造源码引用，不能登记完成', async (t) => {
  const root = temporary(t);
  run(['init', root, '--name', '新产品'], root);
  const filename = path.join(root, 'product-document.json'),
    scan = await scanAnalysis(root);
  assert.equal(scan.unitCount, 0);
  assert.equal(checkAnalysis(scan.session).valid, true);
  const feature = {
    title: '导出记录',
    description: '用户导出自己的记录。',
    flow: [['导出', '下载记录']],
    stepDetails: [
      {
        ...detail([]),
        actor: '用户',
        description: '下载自己的记录。',
        result: '下载文件。',
        exception: '失败时允许重试。',
        acceptance: '导出的内容属于当前用户。',
      },
    ],
  };
  await traces(
    scan.session,
    { '/features/export': feature },
    [{ kind: 'requirement', source: 'user', text: feature.description }],
    'requested',
  );
  await applyChanges(
    filename,
    {
      version: 1,
      expectedHash: readSnapshot(filename).documentHash,
      operations: [
        { op: 'feature.create', id: 'export', data: feature },
        { op: 'feature.sync', id: 'export' },
      ],
    },
    { analysisSession: scan.session },
  );
  await assert.rejects(
    applyChanges(
      filename,
      {
        version: 1,
        expectedHash: readSnapshot(filename).documentHash,
        operations: [
          {
            op: 'feature.complete',
            id: 'export',
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
  assert.equal(readSnapshot(filename).document.features.export.implementedRevision, null);
});
