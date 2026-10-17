import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

test('本机工具包只含白名单资源，解包后可在不同项目中独立运行', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-package-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packed = path.join(directory, 'packed');
  fs.mkdirSync(packed);
  command('pnpm', ['pack', '--pack-destination', packed], root);
  const archives = fs.readdirSync(packed).filter((filename) => filename.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  const archive = path.join(packed, archives[0]);
  const members = command('tar', ['-tzf', archive], directory).trim().split('\n').filter(Boolean);
  const paths = new Set(members.map((member) => member.replace(/^package\//, '')));
  for (const member of members) {
    assert.ok(member.startsWith('package/'), `包成员应位于 package/：${member}`);
    assert.ok(!member.split('/').includes('..'), `包成员不应跨目录：${member}`);
    assert.match(
      member,
      /^package\/(?:bin\/|lib\/|assets\/|schema\/|examples\/|skills\/|package\.json$|README\.md$|DOCUMENT\.md$|ANALYSIS\.md$|FLOW\.md$)/,
      `白名单之外的文件不得进入工具包：${member}`,
    );
  }
  for (const required of [
    'bin/product-blueprint.mjs',
    'lib/document.mjs',
    'lib/document-store.mjs',
    'lib/document-server.mjs',
    'lib/document-operations.mjs',
    'lib/feature-operations.mjs',
    'lib/errors.mjs',
    'lib/analysis-index.mjs',
    'lib/analysis-session.mjs',
    'lib/template.mjs',
    'lib/validation.mjs',
    'lib/source-status.mjs',
    'lib/verification.mjs',
    'lib/verification-plan.mjs',
    'lib/implementation-assessment.mjs',
    'lib/entry-coverage.mjs',
    'lib/environment-probe.mjs',
    'lib/analysis-scope.mjs',
    'lib/source-evidence.mjs',
    'lib/evidence-quality.mjs',
    'lib/component-observation.mjs',
    'lib/artifact-layout.mjs',
    'schema/implementation-assessment.schema.json',
    'lib/delivery.mjs',
    'assets/template.html',
    'assets/client.js',
    'assets/styles.css',
    'assets/theme.js',
    'assets/grammars/python.wasm',
    'assets/grammars/go.wasm',
    'assets/grammars/cpp.wasm',
    'assets/runtime/node-probe.mjs',
    'assets/runtime/python-probe.py',
    'assets/runtime/go-probe.go.txt',
    'assets/runtime/cpp-probe.hpp',
    'schema/flow.schema.json',
    'schema/product-document.schema.json',
    'schema/changes.schema.json',
    'schema/analysis.schema.json',
    'schema/verification.schema.json',
    'schema/verification-plan.schema.json',
    'schema/delivery.schema.json',
    'examples/minimal-product.json',
    'README.md',
    'DOCUMENT.md',
    'ANALYSIS.md',
    'package.json',
  ]) {
    assert.ok(paths.has(required), `缺少独立运行资源：${required}`);
  }
  assert.ok(!paths.has('product-document.json'));
  assert.ok(!paths.has('preview.mjs'));
  assert.ok(
    ![...paths].some((filename) =>
      /^(?:dist|test|node_modules|init-preview|\.blueprint-analysis)\//.test(filename),
    ),
  );
  for (const name of [
    'product-blueprint-init',
    'product-blueprint-maintain',
    'product-blueprint-implement',
  ])
    for (const file of ['SKILL.md', 'references/workflow.md', 'agents/openai.yaml'])
      assert.ok(paths.has(`skills/${name}/${file}`));

  const install = path.join(directory, 'independent-install');
  fs.mkdirSync(install);
  fs.writeFileSync(
    path.join(install, 'package.json'),
    JSON.stringify({ private: true, dependencies: { 'product-blueprint': `file:${archive}` } }),
  );
  command('pnpm', ['install', '--offline', '--ignore-scripts'], install);
  const packageRoot = fs.realpathSync(path.join(install, 'node_modules', 'product-blueprint'));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, '0.8.0');
  assert.equal(manifest.dependencies.typescript, '6.0.2');
  const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
  assert.equal(installedRequire('typescript/package.json').version, '6.0.2');
  assert.equal(manifest.bin['product-blueprint'], './bin/product-blueprint.mjs');
  const cli = path.join(packageRoot, manifest.bin['product-blueprint']);
  assert.match(command(process.execPath, [cli, '--help'], directory), /产品蓝图/);
  assert.ok(command(process.execPath, [cli, '--version'], directory).includes(manifest.version));
  const changesSchema = JSON.parse(
    command(process.execPath, [cli, 'schema', '--changes'], directory),
  );
  assert.ok(changesSchema.properties?.operations, '包内应包含整批变更规范');
  const verificationSchema = JSON.parse(
    command(process.execPath, [cli, 'schema', '--verification'], directory),
  );
  assert.ok(verificationSchema.$defs.environmentDiagnostic);
  assert.match(
    command(process.execPath, [cli, 'verification', 'diagnose', '--help'], directory),
    /TCP/,
  );

  for (const [name, label] of [
    ['first-project', '第一个产品'],
    ['second-project', '第二个产品'],
  ]) {
    const project = path.join(directory, name);
    const initialized = JSON.parse(
      command(process.execPath, [cli, 'init', project, '--name', label, '--json'], directory),
    );
    const documentPath = path.join(project, 'product-document.json');
    assert.equal(initialized.document, documentPath);
    assert.equal(JSON.parse(fs.readFileSync(documentPath, 'utf8')).product.name, label);
    fs.writeFileSync(
      path.join(project, 'example.ts'),
      'export function total(count: number) { return count * 2; }',
    );
    const scan = JSON.parse(
      command(process.execPath, [cli, 'analysis', 'scan', '--json'], project),
    );
    assert.equal(scan.unitCount, 1);
    const units = JSON.parse(
      command(
        process.execPath,
        [cli, 'analysis', 'list', '--session', scan.session, '--json'],
        project,
      ),
    );
    const sourceRead = JSON.parse(
      command(
        process.execPath,
        [cli, 'analysis', 'read', units.items[0].id, '--session', scan.session, '--json'],
        project,
      ),
    );
    assert.match(sourceRead.code, /count \* 2/);
    const recordInput = path.join(project, 'record-input.json');
    fs.writeFileSync(
      recordInput,
      JSON.stringify({
        records: [
          {
            unitId: units.items[0].id,
            receiptIds: [sourceRead.receipt.id],
            responsibility: '计算两倍数量',
            inputs: ['数量'],
            outputs: ['数量乘二'],
            conditions: [],
            calls: [],
            sideEffects: [],
            exceptions: [],
            unknowns: [],
            coverage: units.items[0].reviewPoints.map((point) => ({
              pointId: point.id,
              detail:
                point.kind === 'parameter' ? 'count 接收待计算的数量。' : '返回 count 的两倍。',
            })),
          },
        ],
      }),
    );
    command(
      process.execPath,
      [cli, 'analysis', 'record', '--session', scan.session, '--input', recordInput, '--json'],
      project,
    );
    assert.equal(
      JSON.parse(
        command(
          process.execPath,
          [cli, 'analysis', 'check', '--session', scan.session, '--json'],
          project,
        ),
      ).valid,
      true,
    );
    const validated = JSON.parse(command(process.execPath, [cli, 'validate', '--json'], project));
    assert.equal(validated.valid, true);
    const snapshot = path.join(project, 'snapshot.html');
    command(process.execPath, [cli, 'render', '--output', snapshot, '--json'], project);
    const html = fs.readFileSync(snapshot, 'utf8');
    assert.ok(html.includes(label));
    assert.ok(!html.includes('用户调查表'), '独立项目不能泄入当前用户文档');
    assert.equal(
      html,
      fs.readFileSync(path.join(project, 'index.html'), 'utf8'),
      '相同文档和模板应生成一致的 HTML',
    );
    const read = JSON.parse(command(process.execPath, [cli, 'document', 'get', '--json'], project));
    assert.match(read.documentHash, /^[a-f0-9]{64}$/);
    assert.equal(read.data.product.name, label);
    const input = path.join(project, 'feature-input.json');
    fs.writeFileSync(
      input,
      JSON.stringify({ title: `${label}功能`, description: '用户查看自己的记录。' }),
    );
    command(
      process.execPath,
      [
        cli,
        'feature',
        'create',
        'view-records',
        '--input',
        input,
        '--expected-hash',
        read.documentHash,
        '--no-render',
        '--json',
      ],
      project,
    );
    const feature = JSON.parse(
      command(process.execPath, [cli, 'feature', 'get', 'view-records', '--json'], project),
    );
    assert.equal(feature.feature.title, `${label}功能`);
    assert.equal(feature.feature.revision, 1);
    assert.equal(feature.feature.implementedRevision, null);
    command(process.execPath, [cli, 'render', '--output', snapshot, '--json'], project);
    assert.ok(fs.readFileSync(snapshot, 'utf8').includes(`${label}功能`));
  }
});
