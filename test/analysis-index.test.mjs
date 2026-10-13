import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanAnalysis,
  listAnalysis,
  readAnalysis,
  loadSession,
  receiptCoverage,
} from '../lib/analysis-session.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-analysis-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test('全部可执行函数形态、独立嵌套作用域、顶层逻辑与类型声明分开索引', async (t) => {
  const root = fixture(t, {
    'all.ts': `interface Input { value: number; method(): void }
type Result = number;
declare function signature(a: Input): Result;
export function outer(a: number) { function inner() { return a; } return inner(); }
const arrow = (v: number) => v * 2;
const expression = function same() { return 1; };
const object = { method() { return 2; }, get value() { return 3; }, set value(v) {} };
class Service { constructor() {} method() { return arrow(2); } get v() { return 1; } set v(a) {} }
const values = [1,2].map(v => v + 1);
outer(1);`,
    'view.tsx': 'export const View = () => <button onClick={() => 1}>ok</button>;',
    'plain.jsx': 'export default function View() { return <div/>; }',
    'api.d.ts': 'declare class Contract { method(): void; }',
    'tests/logic.test.ts': 'function verification() { return true; } verification();',
  });
  const scan = await scanAnalysis(root),
    { state } = loadSession(scan.session);
  assert.deepEqual(scan.gaps, []);
  const kinds = new Set(state.units.map((unit) => unit.kind));
  for (const kind of [
    'function',
    'function-expression',
    'method',
    'getter',
    'setter',
    'constructor',
    'arrow',
    'top-level',
  ])
    assert.ok(kinds.has(kind), kind);
  assert.ok(state.units.find((unit) => unit.name === 'inner').scope.includes('outer'));
  assert.equal(
    state.units.filter((unit) => unit.name === 'method' && unit.file === 'all.ts').length,
    2,
  );
  assert.equal(new Set(state.units.map((unit) => unit.id)).size, state.units.length);
  assert.ok(state.units.some((unit) => unit.name.startsWith('<anonymous@')));
  assert.ok(state.types.some((type) => type.name === 'signature'));
  assert.ok(!state.units.some((unit) => unit.file === 'api.d.ts'));
  assert.ok(
    state.units
      .filter((unit) => unit.file.startsWith('tests/'))
      .every((unit) => unit.role === 'verification'),
  );
  const second = await scanAnalysis(root);
  assert.equal(second.resumed, true);
  assert.equal(second.snapshotHash, scan.snapshotHash);
  assert.equal(listAnalysis(scan.session, { limit: 2 }).items.length, 2);
  assert.equal(listAnalysis(scan.session, { limit: 2 }).nextOffset, 2);
});

test('跨文件导入、导出重命名和 tsconfig 路径别名解析为实际符号，动态调用保持未知', async (t) => {
  const root = fixture(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
    }),
    'src/worker.ts': 'export function save(value: number) { return value; }',
    'src/barrel.ts': "export { save as persist } from './worker';",
    'src/main.ts':
      "import { persist as write } from '@app/barrel'; export function run(key: string) { write(1); const handlers: any = {}; handlers[key](); fetch('/api'); }",
  });
  const scan = await scanAnalysis(root),
    { state } = loadSession(scan.session);
  assert.deepEqual(scan.gaps, []);
  const save = state.units.find((unit) => unit.name === 'save'),
    run = state.units.find((unit) => unit.name === 'run');
  assert.equal(run.calls.find((call) => call.expression === 'write').target, save.id);
  assert.equal(run.calls.find((call) => call.expression === 'handlers[key]').status, 'unknown');
  assert.equal(run.calls.find((call) => call.expression === 'fetch').status, 'unknown');
  assert.equal(
    state.imports.find((entry) => entry.module === '@app/barrel').target,
    'src/barrel.ts',
  );
  assert.equal(scan.contextCount, 1);
});

test('读取使用 UTF-16 偏移、分段并集和父函数凭据；嵌套分析仍有独立编号', async (t) => {
  const root = fixture(t, {
    'unicode.ts': `const 前缀 = '😀';\nfunction outer() { const text = '${'😀'.repeat(18000)}'; function child() { return text; } return child(); }`,
  });
  const scan = await scanAnalysis(root),
    { state } = loadSession(scan.session);
  const outer = state.units.find((unit) => unit.name === 'outer'),
    child = state.units.find((unit) => unit.name === 'child');
  assert.equal(outer.startPosition.line, 2);
  assert.equal(outer.startPosition.column, 1);
  const receipts = [];
  let offset = 0;
  do {
    const read = await readAnalysis(scan.session, outer.id, { offset, length: 999 });
    assert.ok(!/[\uD800-\uDBFF]$/.test(read.code));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(read.code));
    receipts.push(read.receipt.id);
    offset = read.nextOffset;
  } while (offset !== null);
  const current = loadSession(scan.session).state;
  assert.equal(receiptCoverage(current, outer, receipts), true);
  assert.equal(receiptCoverage(current, child, receipts), true);
  assert.equal(receiptCoverage(current, outer, receipts.slice(1)), false);
  const text = fs.readFileSync(path.join(root, 'unicode.ts'), 'utf8');
  const emojiOffset = text.indexOf('😀', outer.start) - outer.start + 1;
  await assert.rejects(readAnalysis(scan.session, outer.id, { offset: emojiOffset }), /Unicode/);
});

test('清单记录排除原因、解析失败、非支持语言与显式范围，项目代码不执行', async (t) => {
  const root = fixture(t, {
    'src/good.js': "throw new Error('must not execute'); function good() {}",
    'src/bad.ts': 'function broken( {',
    'src/service.py': 'def work(): pass',
    'src/generated.js': 'function generated() {}',
    'other.js': 'function other() {}',
    'node_modules/pkg/index.js': 'function library() {}',
    'dist/main.js': 'function built() {}',
    '.git/config': 'repository',
    'package.json': '{"name":"sample"}',
  });
  const scan = await scanAnalysis(root, { include: ['src'], exclude: ['src/generated.js'] });
  assert.ok(scan.gaps.some((gap) => gap.file === 'src/bad.ts' && gap.kind === 'parse'));
  assert.ok(scan.gaps.some((gap) => gap.file === 'src/service.py' && gap.kind === 'language'));
  for (const [file, reason] of [
    ['node_modules', '依赖库'],
    ['dist', '生成目录'],
    ['.git', '版本控制'],
    ['other.js', '扫描范围外'],
    ['src/generated.js', '用户排除'],
  ])
    assert.equal(scan.manifest.find((entry) => entry.file === file).reason, reason);
  assert.equal(listAnalysis(scan.session).items.filter((unit) => unit.name === 'good').length, 1);
});

test('声明类型可作上下文读取，重载调用解析到实现；缺失 include 和非 UTF-8 单独报告', async (t) => {
  const root = fixture(t, {
    'model.ts': 'export interface Person { name: string }',
    'main.ts':
      'function convert(value: number): number; function convert(value: number) { return value + 1; } convert(2);',
    'crlf.js': 'const emoji = "😀";\r\nfunction run() { return emoji; }',
  });
  const scan = await scanAnalysis(root),
    state = loadSession(scan.session).state;
  const implementation = state.units.find((unit) => unit.name === 'convert');
  assert.equal(
    state.units
      .find((unit) => unit.calls.some((call) => call.expression === 'convert'))
      .calls.find((call) => call.expression === 'convert').target,
    implementation.id,
  );
  const type = state.types.find((type) => type.name === 'Person');
  const read = await readAnalysis(scan.session, type.id);
  assert.match(read.code, /interface Person/);
  const run = state.units.find((unit) => unit.name === 'run');
  assert.deepEqual((await readAnalysis(scan.session, run.id)).startPosition, run.startPosition);
  const missing = await scanAnalysis(root, { include: ['missing-folder'] });
  assert.ok(missing.gaps.some((gap) => gap.kind === 'scope'));
  fs.writeFileSync(path.join(root, 'invalid.ts'), Buffer.from([0xff, 0xfe, 0x00]));
  const invalid = await scanAnalysis(root);
  assert.ok(invalid.gaps.some((gap) => gap.file === 'invalid.ts' && gap.kind === 'read'));
});
