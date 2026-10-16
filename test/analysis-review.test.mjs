import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanAnalysis,
  readAnalysis,
  recordAnalysis,
  checkAnalysis,
  listAnalysis,
  loadSession,
  traceAnalysis,
} from '../lib/analysis-session.mjs';
import { hash } from '../lib/analysis-index.mjs';
import { applyChanges, readSnapshot } from '../lib/document-operations.mjs';
import { checkDelivery } from '../lib/delivery.mjs';

const source = `function trim(value) { return value.trim(); }
export function save(input, store) {
  const normalized = trim(input);
  if (!normalized) throw new Error('empty');
  try {
    store.value = normalized;
    return store.persist(normalized);
  } catch (error) {
    store.failed = true;
    throw error;
  } finally {
    store.release();
  }
}
`;
const explanations = {
  value: 'value 是待去除首尾空白的输入文字。',
  'return value.trim();': '返回去除首尾空白后的文字；错误继续交给调用方。',
  'value.trim()': '调用输入值的 trim 方法，不改变原字符串。',
  input: 'input 是本次希望持久化的原始文字。',
  store: 'store 由调用方提供，承载保存状态和持久化、释放方法。',
  'trim(input)': '先去除输入首尾空白，所得 normalized 用于后续校验和保存。',
  '!normalized': '规范化后为空则在修改 store 之前拒绝，非空才进入保存。',
  "throw new Error('empty');": '空输入抛出 empty 错误，不进入 try，也不会调用 release。',
  "new Error('empty')": '创建带 empty 消息的错误对象供当前拒绝分支抛出。',
  'store.value = normalized': '在调用 persist 前将规范化内容写入调用方的 store.value。',
  'return store.persist(normalized);': '直接返回 persist 的同步返回值，不等待异步结果。',
  'store.persist(normalized)': '把规范化内容交给调用方的 persist；该方法的内部实现未知。',
  'store.failed = true': 'try 中发生同步异常时，在重新抛出前设置失败标记。',
  'throw error;': '重新抛出捕获到的原始异常。',
  'store.release()': 'finally 中调用释放方法；其同步异常会替代先前的返回值或异常。',
};
function knownRecord(unit, receiptIds) {
  return {
    unitId: unit.id,
    receiptIds,
    responsibility:
      unit.name === 'trim'
        ? '去除输入首尾空白。'
        : '校验非空文字并尝试保存，保留失败状态及释放行为。',
    inputs: unit.name === 'trim' ? ['待规范化的 value'] : ['原始 input', '调用方 store 对象'],
    outputs: unit.name === 'trim' ? ['去空白的文字'] : ['persist 返回值'],
    conditions: unit.name === 'trim' ? [] : ['normalized 为空时拒绝，否则进入保存'],
    calls:
      unit.name === 'trim'
        ? ['调用 value.trim']
        : ['trim 规范化', '创建 empty 错误', '调用 persist 和 release'],
    sideEffects:
      unit.name === 'trim' ? [] : ['更新 store.value；异常时标记 store.failed；调用释放方法'],
    exceptions: ['同步异常向调用方传播', 'finally 中异常可能覆盖原返回值或错误'],
    unknowns: ['调用方传入方法的内部行为不由此源码确定'],
    coverage: unit.reviewPoints.map((point) => {
      const detail =
        point.kind === 'catch'
          ? '只捕获 try 中同步异常，先标记失败再重抛；未等待的 Promise 拒绝不会进入这里。'
          : point.kind === 'finally'
            ? 'try 成功返回或同步抛错都会释放；空输入提前抛错不进入 finally。'
            : explanations[point.code];
      assert.ok(detail, `已知业务样例缺少独立说明：${point.code}`);
      return { pointId: point.id, detail };
    }),
  };
}
async function fixture(t, content = source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.ts'), content);
  const filename = path.join(root, 'product-document.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      product: { name: '审阅样例', background: '保存文字', actors: [] },
      features: {},
      dependencies: [],
      diagrams: {},
    }),
  );
  const scan = await scanAnalysis(root);
  return { root, filename, ...scan, state: loadSession(scan.session).state };
}

test('完整读取不能掩盖空白分析、通用套话或缺少逐位置说明，失败不保存', async (t) => {
  const { session, state } = await fixture(t),
    unit = state.units.find((unit) => unit.name === 'save'),
    read = await readAnalysis(session, unit.id),
    valid = knownRecord(unit, [read.receipt.id]);
  assert.equal(read.nextOffset, null);
  assert.ok(read.receipt.createdAt);
  assert.deepEqual(read.reviewPoints, unit.reviewPoints);
  for (const mutate of [
    (record) => {
      delete record.coverage;
    },
    (record) => {
      for (const field of [
        'inputs',
        'outputs',
        'conditions',
        'calls',
        'sideEffects',
        'exceptions',
        'unknowns',
      ])
        record[field] = [];
    },
    (record) => {
      record.inputs = ['调用方参数及模块闭包状态。'];
    },
    (record) => {
      record.coverage[0].detail = unit.reviewPoints[0].code;
    },
    (record) => {
      record.coverage.push(record.coverage[0]);
    },
    (record) => {
      record.coverage[0].pointId = 'p-not-from-this-unit';
    },
    (record) => {
      record.calls = [];
    },
  ]) {
    const record = structuredClone(valid);
    mutate(record);
    const before = fs.readFileSync(path.join(session, 'state.json'), 'utf8');
    await assert.rejects(recordAnalysis(session, { records: [record] }), {
      code: 'ANALYSIS_INCOMPLETE',
    });
    assert.equal(fs.readFileSync(path.join(session, 'state.json'), 'utf8'), before);
  }
});

test('漏掉一个 finally 调用仍被精确定位，补齐后完整分析才通过', async (t) => {
  const { session, state } = await fixture(t);
  for (const unit of state.units) {
    const read = await readAnalysis(session, unit.id),
      record = knownRecord(unit, [read.receipt.id]);
    if (unit.name === 'save') {
      const point = unit.reviewPoints.find((point) => point.code === 'store.release()');
      const incomplete = {
        ...record,
        coverage: record.coverage.filter((item) => item.pointId !== point.id),
      };
      await assert.rejects(recordAnalysis(session, { records: [incomplete] }), (error) => {
        assert.equal(error.code, 'ANALYSIS_INCOMPLETE');
        assert.ok(
          error.details.some(
            (item) =>
              item.pointId === point.id && item.position.line === 12 && item.field === 'calls',
          ),
        );
        return true;
      });
    }
    await recordAnalysis(session, { records: [record] });
  }
  const report = checkAnalysis(session);
  assert.equal(report.valid, true);
  assert.equal(report.reviewedCount, report.unitCount);
  assert.equal(
    report.reviewPointCount,
    state.units.reduce((count, unit) => count + unit.reviewPoints.length, 0),
  );
});

test('父函数读取可覆盖子函数，但不能复用父函数的位置说明冒充子函数分析', async (t) => {
  const { session, state } = await fixture(
    t,
    'function outer(input) { function child(value) { if (!value) throw new Error("empty"); return value; } return child(input); }',
  );
  const outer = state.units.find((unit) => unit.name === 'outer'),
    child = state.units.find((unit) => unit.name === 'child'),
    read = await readAnalysis(session, outer.id);
  assert.ok(!outer.reviewPoints.some((point) => point.kind === 'throw'));
  assert.ok(child.reviewPoints.some((point) => point.kind === 'throw'));
  const record = {
    unitId: child.id,
    receiptIds: [read.receipt.id],
    responsibility: '校验 value 非空。',
    inputs: ['value'],
    outputs: ['原始 value'],
    conditions: ['空值拒绝'],
    calls: ['创建错误'],
    sideEffects: [],
    exceptions: ['空值抛错'],
    unknowns: [],
    coverage: outer.reviewPoints.map((point) => ({
      pointId: point.id,
      detail: '读取外层 input 并调用 child 返回结果。',
    })),
  };
  await assert.rejects(recordAnalysis(session, { records: [record] }), (error) => {
    assert.ok(error.details.some((item) => item.message.includes('不存在')));
    assert.ok(error.details.some((item) => item.message.includes('throw')));
    return error.code === 'ANALYSIS_INCOMPLETE';
  });
});

test('旧的浅摘要进入待处理清单，不能绑定 observed、保存严格批次或通过交付', async (t) => {
  const { session, state, filename } = await fixture(t);
  for (const unit of state.units) {
    const read = await readAnalysis(session, unit.id);
    await recordAnalysis(session, { records: [knownRecord(unit, [read.receipt.id])] });
  }
  const current = loadSession(session).state,
    record = current.records[state.units.find((unit) => unit.name === 'save').id];
  delete record.coverage;
  // A structurally valid old-format digest must not be mistaken for behavioral review.
  record.recordHash = hash(
    JSON.stringify({
      unitId: record.unitId,
      snapshotHash: record.snapshotHash,
      contentHash: record.contentHash,
      ...Object.fromEntries(
        [
          'responsibility',
          'inputs',
          'outputs',
          'conditions',
          'calls',
          'sideEffects',
          'exceptions',
          'unknowns',
        ].map((field) => [field, record[field]]),
      ),
    }),
  );
  fs.writeFileSync(path.join(session, 'state.json'), JSON.stringify(current));
  // Construct a legacy JSON-only fixture, not a changed base with an old journal.
  fs.rmSync(path.join(session, 'state.json.events.jsonl'), { force: true });
  const report = checkAnalysis(session);
  assert.equal(report.recordedCount, report.unitCount);
  assert.equal(report.reviewedCount, report.unitCount - 1);
  assert.ok(report.gaps.some((gap) => gap.kind === 'review' && gap.path === record.unitId));
  assert.equal(listAnalysis(session, { status: 'pending' }).items[0].id, record.unitId);
  await assert.rejects(
    traceAnalysis(session, {
      traces: [
        {
          id: 'shallow',
          target: '/product/background',
          value: '保存文字',
          classification: 'observed',
          evidence: [{ kind: 'code', unitId: record.unitId, recordHash: record.recordHash }],
        },
      ],
    }),
    { code: 'VALIDATION_FAILED' },
  );
  await assert.rejects(
    applyChanges(
      filename,
      {
        version: 1,
        expectedHash: readSnapshot(filename).documentHash,
        operations: [{ op: 'product.update', changes: { background: '新的说明' } }],
      },
      { analysisSession: session, render: false },
    ),
    { code: 'ANALYSIS_INCOMPLETE' },
  );
  const delivery = await checkDelivery(filename, session, {});
  assert.equal(delivery.valid, false);
  assert.ok(delivery.gaps.some((gap) => gap.kind === 'review' && gap.path === record.unitId));
});

test('没有行为的空函数可使用空数组，不要求伪造输入、调用和异常', async (t) => {
  const { session, state } = await fixture(t, 'function noop() {}');
  const unit = state.units[0],
    read = await readAnalysis(session, unit.id);
  assert.deepEqual(unit.reviewPoints, []);
  await recordAnalysis(session, {
    records: [
      {
        unitId: unit.id,
        receiptIds: [read.receipt.id],
        responsibility: '空操作，不读取输入也不修改状态。',
        inputs: [],
        outputs: [],
        conditions: [],
        calls: [],
        sideEffects: [],
        exceptions: [],
        unknowns: [],
        coverage: [],
      },
    ],
  });
  assert.equal(checkAnalysis(session).valid, true);
});

test('分支、循环、短路、赋值与嵌套回调按各自位置登记，类型签名不冒充参数', async (t) => {
  const { state } = await fixture(
    t,
    `function run(input, callback: (hidden: string) => void) {
    let count = 0;
    while (count < 1) { count++; }
    do { count--; } while (count > 0);
    for (let n = 0; n < 1; n++) { callback(input); }
    for (const value of input) { callback(value); }
    switch (input.kind) { case 'a': callback(input); break; default: delete input.kind; }
    const selected = input && input.value || 'fallback';
    return selected ? selected : input;
  }
  const child = (value) => value + 1;`,
  );
  const run = state.units.find((unit) => unit.name === 'run');
  assert.deepEqual(
    run.reviewPoints.filter((point) => point.kind === 'parameter').map((point) => point.code),
    ['input', 'callback: (hidden: string) => void'],
  );
  for (const kind of [
    'condition',
    'iteration',
    'case',
    'default',
    'short-circuit',
    'write',
    'call',
    'return',
  ])
    assert.ok(
      run.reviewPoints.some((point) => point.kind === kind),
      kind,
    );
  const child = state.units.find((unit) => unit.name === 'child');
  assert.deepEqual(
    child.reviewPoints.map((point) => point.kind),
    ['parameter', 'return'],
  );
  assert.equal(new Set(run.reviewPoints.map((point) => point.id)).size, run.reviewPoints.length);
});
