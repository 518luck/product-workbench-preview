import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanAnalysis,
  loadSession,
  listAnalysis,
  readAnalysis,
  checkAnalysis,
} from '../lib/analysis-session.mjs';
import { renderDocument } from '../lib/document.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-v2-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('UTF-16 位置覆盖中文、emoji、嵌套 Python 函数；文本上下文独立且变化使旧摘要失效', async (t) => {
  const root = temporary(t),
    source =
      '# 😀产品\ndef 计算(value):\n    def inner(x):\n        return x + 1\n    return inner(value)\n';
  fs.writeFileSync(path.join(root, 'main.py'), source);
  fs.writeFileSync(path.join(root, 'workflow.html'), '<h1>😀业务</h1>');
  const scan = await scanAnalysis(root, { contexts: ['workflow.html'] }),
    state = loadSession(scan.session).state;
  assert.equal(state.version, 2);
  assert.equal(state.units.filter((unit) => unit.kind === 'function').length, 2);
  for (const unit of state.units) {
    const read = await readAnalysis(scan.session, unit.id);
    assert.equal(read.code, source.slice(unit.start, unit.end));
    assert.ok(read.code.startsWith('def'));
  }
  assert.equal(state.contexts.length, 1);
  assert.equal(state.contexts[0].utf16Length, '<h1>😀业务</h1>'.length);
  assert.ok(checkAnalysis(scan.session).gaps.some((gap) => gap.kind === 'context'));
  await readAnalysis(scan.session, state.contexts[0].id);
  assert.ok(!checkAnalysis(scan.session).gaps.some((gap) => gap.kind === 'context'));
  fs.writeFileSync(path.join(root, 'workflow.html'), '<h1>已变化</h1>');
  assert.throws(() => checkAnalysis(scan.session), { code: 'ANALYSIS_STALE' });
  const next = await scanAnalysis(root, { contexts: ['workflow.html'] });
  assert.notEqual(next.snapshotHash, scan.snapshotHash);
  assert.equal(next.recordedCount, 0);
});
test('旧协议仍能列出历史；手改机器调用事实与分析配置不能复用原快照', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export function one(value){return value;}');
  const scan = await scanAnalysis(root),
    state = loadSession(scan.session).state,
    filename = path.join(scan.session, 'state.json');
  state.facts.edges.push({ from: 'fake', to: 'fake2', certain: true });
  fs.writeFileSync(filename, JSON.stringify(state));
  assert.throws(() => checkAnalysis(scan.session), { code: 'ANALYSIS_STALE' });
  state.version = 1;
  fs.writeFileSync(filename, JSON.stringify(state));
  const history = listAnalysis(scan.session);
  assert.equal(history.legacy, true);
  assert.equal(history.items.length, 1);
  assert.throws(() => checkAnalysis(scan.session), { code: 'ANALYSIS_STALE' });
});
test('C++ 缺少编译数据库只提供语法，Python 动态与 Go 缺类型上下文不能凭名称解析', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, 'main.cpp'),
    'int f(int x){return x;} int g(int x){return f(x);}',
  );
  fs.writeFileSync(
    path.join(root, 'dynamic.py'),
    'def target(x): return x\ndef use(target, x): return target(x)\n',
  );
  const scan = await scanAnalysis(root),
    state = loadSession(scan.session).state;
  assert.ok(state.gaps.some((gap) => gap.language === 'cpp' && gap.kind === 'semantic'));
  assert.ok(
    state.units
      .filter((unit) => unit.language === 'cpp')
      .every((unit) => unit.calls.every((call) => !call.target)),
  );
  assert.equal(state.units.find((unit) => unit.name === 'use').calls[0].status, 'unknown');
});

test('自定义目录的产品书不进入源码快照，已有项目 HTML 仍纳入显式上下文', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export function one(value){return value;}');
  const book = JSON.parse(
    fs.readFileSync(new URL('../examples/minimal-product.json', import.meta.url)),
  );
  fs.mkdirSync(path.join(root, 'generated-book'));
  fs.writeFileSync(path.join(root, 'generated-book/product-document.json'), JSON.stringify(book));
  fs.writeFileSync(path.join(root, 'generated-book/index.html'), renderDocument(book));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>实际项目入口</html>');
  const first = await scanAnalysis(root, { contexts: ['**/*.html'] }),
    state = loadSession(first.session).state;
  assert.deepEqual(
    state.contexts.map((context) => context.file),
    ['index.html'],
  );
  book.product.background = '生成内容变化';
  fs.writeFileSync(path.join(root, 'generated-book/product-document.json'), JSON.stringify(book));
  fs.writeFileSync(path.join(root, 'generated-book/index.html'), renderDocument(book));
  assert.equal(
    (await scanAnalysis(root, { contexts: ['**/*.html'] })).snapshotHash,
    first.snapshotHash,
  );
});

test('CLI 参数入口与具名 HTTP／页面回调进入候选清单，Skill 文本有独立入口', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, 'main.mjs'),
    "import http from 'node:http'; function handle(req,res){res.end('ok');} const server=http.createServer(handle); const argument=process.argv[2];function clicked(){return argument;} button.addEventListener('click',clicked);",
  );
  fs.writeFileSync(path.join(root, 'SKILL.md'), '# 独立工作流\n读取用户请求并处理。');
  const scan = await scanAnalysis(root),
    state = loadSession(scan.session).state;
  assert.ok(state.facts.entries.some((entry) => entry.kind === 'cli'));
  for (const name of ['handle', 'clicked'])
    assert.ok(
      state.facts.entries.some(
        (entry) =>
          entry.kind === 'registration' &&
          state.units.find((unit) => unit.id === entry.unitId)?.name === name,
      ),
    );
  assert.ok(
    state.facts.entries.some(
      (entry) =>
        entry.kind === 'workflow' &&
        state.contexts.some((context) => context.id === entry.contextId),
    ),
  );
});

test('宽上下文清单不能绕过函数分析；C++ 类字段与 Python 类型桩仍需完整读取', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export function one(value){return value;}');
  fs.writeFileSync(path.join(root, 'README.md'), '项目介绍');
  const broad = await scanAnalysis(root, { contexts: ['**/*'] }),
    broadState = loadSession(broad.session).state;
  assert.equal(broadState.units.length, 1);
  assert.ok(checkAnalysis(broad.session).gaps.some((gap) => gap.kind === 'record'));
  fs.writeFileSync(path.join(root, 'legacy.rb'), 'def unknown; true; end');
  const unsupported = await scanAnalysis(root, { contexts: ['**/*'] });
  assert.ok(
    loadSession(unsupported.session).state.gaps.some(
      (gap) => gap.file === 'legacy.rb' && gap.kind === 'language',
    ),
  );
  fs.writeFileSync(path.join(root, 'types.pyi'), 'def stub(value: int) -> int: ...\n');
  fs.writeFileSync(
    path.join(root, 'model.hpp'),
    'class Model { int base=1; public: int add(int value){return base+value;} };',
  );
  const scan = await scanAnalysis(root),
    state = loadSession(scan.session).state;
  assert.equal(state.units.filter((unit) => unit.file === 'types.pyi').length, 0);
  assert.ok(state.contexts.some((context) => context.file === 'types.pyi'));
  const klass = state.contexts.find(
    (context) => context.file === 'model.hpp' && context.kind === 'class_specifier',
  );
  assert.ok(klass);
  assert.ok((await readAnalysis(scan.session, klass.id)).code.includes('base=1'));
});
