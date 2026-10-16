import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hash,
  inventory,
  indexSnapshot,
  readText,
  textPosition,
  PARSER_VERSION,
  INDEX_VERSION,
} from './analysis-index.mjs';
import { updateDocument, DocumentConflictError } from './document-store.mjs';
import { BlueprintError } from './errors.mjs';
import { reviewProblems } from './analysis-review.mjs';
export { snapshotFromAnalysis } from './source-status.mjs';

function invalid(message, details) {
  throw new BlueprintError('INVALID_ARGUMENT', message, { details });
}
export function sessionFile(session) {
  if (typeof session !== 'string' || !session.trim())
    invalid('需要 --session 会话目录或 state.json。');
  const absolute = fs.realpathSync(path.resolve(session));
  return fs.statSync(absolute).isDirectory() ? path.join(absolute, 'state.json') : absolute;
}
export function loadSession(session) {
  const filename = sessionFile(session);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new BlueprintError('VALIDATION_FAILED', `分析会话无法读取：${error.message}`);
  }
  if (
    state.version !== 1 ||
    state.parserVersion !== PARSER_VERSION ||
    !state.root ||
    !Array.isArray(state.units) ||
    !state.records ||
    !state.receipts ||
    !state.traces
  )
    throw new BlueprintError('VALIDATION_FAILED', '分析会话格式或解析器版本不匹配，请重新扫描。');
  return { filename, state };
}
export function assertFresh(state) {
  if (
    state.version !== 1 ||
    state.parserVersion !== PARSER_VERSION ||
    !Array.isArray(state.units) ||
    !Array.isArray(state.contexts) ||
    !Array.isArray(state.gaps) ||
    !Array.isArray(state.types) ||
    !Array.isArray(state.manifest) ||
    !Number.isSafeInteger(state.editRevision) ||
    state.editRevision < 0 ||
    !state.records ||
    !state.receipts ||
    !state.traces ||
    [state.records, state.receipts, state.traces].some(
      (value) => typeof value !== 'object' || Array.isArray(value),
    )
  )
    throw new BlueprintError('VALIDATION_FAILED', '分析会话结构／版本无效，请重新扫描。');
  const current = inventory(state.root, state.scope);
  if (current.fingerprint !== state.snapshotHash)
    throw new BlueprintError(
      'ANALYSIS_STALE',
      '源码、清单或解析配置已变化，请重新 analysis scan；旧读取凭据失效。',
      {
        status: 409,
        details: [{ path: 'snapshotHash', message: '当前源码快照与会话不一致。' }],
        expectedHash: state.snapshotHash,
        actualHash: current.fingerprint,
      },
    );
  return current;
}
async function updateSession(session, updater) {
  try {
    return await updateDocument(sessionFile(session), (state) => {
      assertFresh(state);
      const result = updater(state);
      state.editRevision += 1;
      return { changed: true, result };
    });
  } catch (error) {
    if (error instanceof DocumentConflictError)
      throw new BlueprintError('CONFLICT', '分析会话正在保存，请稍后重试。', { status: 409 });
    throw error;
  }
}
export async function scanAnalysis(root, scope = {}) {
  const indexed = indexSnapshot(inventory(root, scope));
  const { fingerprint: snapshotHash, units, manifest, gaps, imports, types, gitCommit } = indexed;
  const directory = path.join(indexed.root, '.blueprint-analysis');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
    invalid('.blueprint-analysis 不得是符号链接。');
  fs.mkdirSync(directory, { recursive: true });
  const session = path.join(directory, `s-${snapshotHash}`);
  fs.mkdirSync(session, { recursive: true });
  if (fs.lstatSync(session).isSymbolicLink()) invalid('会话目录不得是符号链接。');
  const filename = path.join(session, 'state.json');
  let resumed = fs.existsSync(filename);
  if (!resumed) {
    const state = {
      version: 1,
      parserVersion: PARSER_VERSION,
      indexVersion: INDEX_VERSION,
      sessionId: path.basename(session),
      root: indexed.root,
      scope: indexed.scope,
      snapshotHash,
      gitCommit,
      createdAt: new Date().toISOString(),
      editRevision: 0,
      manifest,
      units,
      imports,
      types,
      gaps,
      contexts: [
        ...manifest
          .filter((item) => item.kind === 'context' && item.hash)
          .map((item) => ({
            id: `c-${hash(item.file).slice(0, 24)}`,
            ...item,
            start: 0,
            end: item.utf16Length,
          })),
        ...types,
      ],
      receipts: {},
      records: {},
      traces: {},
    };
    const temporary = path.join(session, `.state-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      // Link rather than overwrite: a concurrent scanner either publishes a complete state or resumes it.
      try {
        fs.linkSync(temporary, filename);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        resumed = true;
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  const { state } = loadSession(session);
  assertFresh(state);
  return {
    session,
    sessionId: state.sessionId,
    snapshotHash,
    resumed,
    unitCount: state.units.length,
    typeCount: state.types.length,
    contextCount: state.contexts.length,
    manifest: state.manifest,
    imports: state.imports,
    gaps: state.gaps,
  };
}
export function listAnalysis(
  session,
  { offset = 0, limit = 50, status = 'all', kind = 'units' } = {},
) {
  const { state } = loadSession(session);
  assertFresh(state);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    invalid('分页 offset 应为非负整数，limit 为 1–200。');
  if (
    !['all', 'pending', 'recorded'].includes(status) ||
    !['units', 'contexts', 'files', 'types', 'traces'].includes(kind)
  )
    invalid('列表筛选无效。');
  let items =
    kind === 'units'
      ? state.units.map((unit) => ({
          ...unit,
          status:
            state.records[unit.id] && !reviewProblems(unit, state.records[unit.id]).length
              ? 'recorded'
              : 'pending',
          record: state.records[unit.id] || null,
        }))
      : kind === 'contexts'
        ? state.contexts
        : kind === 'files'
          ? state.manifest
          : kind === 'types'
            ? state.types
            : Object.values(state.traces);
  if (kind === 'units' && status !== 'all') items = items.filter((item) => item.status === status);
  return {
    sessionId: state.sessionId,
    snapshotHash: state.snapshotHash,
    kind,
    total: items.length,
    offset,
    limit,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit),
  };
}
function unitOrContext(state, id) {
  const unit = [...state.units, ...state.contexts].find((unit) => unit.id === id);
  if (!unit) invalid(`不存在分析单元或上下文：${id}`);
  return unit;
}
function surrogateBoundary(text, offset) {
  return (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  );
}
export async function readAnalysis(session, id, { offset = 0, length = 16000 } = {}) {
  return updateSession(session, (state) => {
    const unit = unitOrContext(state, id),
      source = readText(path.join(state.root, unit.file));
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (offset >= unit.end - unit.start && !(offset === 0 && unit.end === unit.start)) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 100000
    )
      invalid('读取 offset 超出单元范围，或 length 不在 1–100000。');
    const start = unit.start + offset;
    let end = Math.min(start + length, unit.end);
    if (surrogateBoundary(source, start)) invalid('offset 不得位于 Unicode 代理对中间。');
    if (surrogateBoundary(source, end)) end -= 1;
    if (end === start && end < unit.end) end = Math.min(start + 2, unit.end);
    const code = source.slice(start, end),
      receiptId = `r-${randomUUID()}`;
    const receipt = {
      id: receiptId,
      unitId: unit.id,
      snapshotHash: state.snapshotHash,
      file: unit.file,
      start,
      end,
      sourceHash: hash(source),
      contentHash: hash(code),
      createdAt: new Date().toISOString(),
    };
    state.receipts[receiptId] = receipt;
    return {
      sessionId: state.sessionId,
      unitId: unit.id,
      offsetUnit: 'UTF-16',
      start,
      end,
      startPosition: textPosition(source, start),
      endPosition: textPosition(source, end),
      nextOffset: end < unit.end ? end - unit.start : null,
      code,
      reviewPoints: unit.reviewPoints || [],
      receipt,
    };
  });
}

export function receiptCoverage(state, unit, ids) {
  const ranges = [];
  for (const id of ids || []) {
    const receipt = state.receipts[id];
    if (
      !receipt ||
      receipt.snapshotHash !== state.snapshotHash ||
      receipt.file !== unit.file ||
      receipt.sourceHash !== (unit.sourceHash || unit.hash)
    )
      return false;
    const source = readText(path.join(state.root, unit.file));
    if (
      receipt.start < 0 ||
      receipt.end > source.length ||
      receipt.start > receipt.end ||
      hash(source.slice(receipt.start, receipt.end)) !== receipt.contentHash
    )
      return false;
    ranges.push([receipt.start, receipt.end]);
  }
  let covered = unit.start;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start > covered) return false;
    covered = Math.max(covered, end);
  }
  return ranges.length > 0 && covered >= unit.end;
}

const summaryFields = [
  'responsibility',
  'inputs',
  'outputs',
  'conditions',
  'calls',
  'sideEffects',
  'exceptions',
  'unknowns',
];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
function exactFields(value, fields, label) {
  if (!object(value) || Object.keys(value).some((key) => !fields.includes(key)))
    invalid(`${label} 包含无效字段。`);
}
function validateSummary(record) {
  if (!nonempty(record.responsibility)) invalid('职责 responsibility 必须是非空文字。');
  for (const field of summaryFields.slice(1))
    if (!Array.isArray(record[field]) || record[field].some((item) => !nonempty(item)))
      invalid(`${field} 必须是文字数组；确实没有时明确提交 []。`);
  if (record.coverage !== undefined) {
    if (!Array.isArray(record.coverage)) invalid('coverage 必须是审阅位置数组。');
    for (const entry of record.coverage) {
      exactFields(entry, ['pointId', 'detail'], '审阅位置说明');
      if (!nonempty(entry.pointId) || !nonempty(entry.detail))
        invalid('审阅位置需要 pointId 及具体行为 detail。');
    }
  }
}
export async function recordAnalysis(session, input) {
  exactFields(input, ['records'], '记录输入');
  if (!Array.isArray(input.records) || !input.records.length) invalid('需要非空 records 数组。');
  return updateSession(session, (state) => {
    const ids = new Set(),
      results = [];
    for (const record of input.records) {
      exactFields(record, ['unitId', 'receiptIds', ...summaryFields, 'coverage'], '分析记录');
      if (ids.has(record.unitId)) invalid('同批记录不能重复单元编号。');
      ids.add(record.unitId);
      const unit = state.units.find((unit) => unit.id === record.unitId);
      if (!unit) invalid(`不存在可执行分析单元：${record.unitId}`);
      if (
        !Array.isArray(record.receiptIds) ||
        !record.receiptIds.length ||
        record.receiptIds.some((id) => typeof id !== 'string')
      )
        invalid('receiptIds 应是工具生成的凭据编号数组。');
      if (!receiptCoverage(state, unit, record.receiptIds))
        throw new BlueprintError(
          'ANALYSIS_INCOMPLETE',
          `单元 ${unit.id} 未完整读取，或读取凭据无效。`,
          {
            details: [{ path: unit.id, message: '需覆盖整个源码范围，包括分段或父函数完整读取。' }],
          },
        );
      validateSummary(record);
      const problems = reviewProblems(unit, record);
      if (problems.length)
        throw new BlueprintError('ANALYSIS_INCOMPLETE', `单元 ${unit.id} 的行为分析不完整。`, {
          details: problems.map((problem) => ({ path: unit.id, file: unit.file, ...problem })),
        });
      const stored = {
        ...structuredClone(record),
        snapshotHash: state.snapshotHash,
        contentHash: unit.contentHash,
        role: unit.role,
        unresolvedCalls: unit.calls.filter((call) => call.status === 'unknown'),
        recordedAt: new Date().toISOString(),
      };
      stored.recordHash = recordDigest(stored);
      results.push(stored);
    }
    for (const record of results) state.records[record.unitId] = record;
    return { sessionId: state.sessionId, snapshotHash: state.snapshotHash, records: results };
  });
}
function recordDigest(record) {
  return hash(
    JSON.stringify({
      unitId: record.unitId,
      snapshotHash: record.snapshotHash,
      contentHash: record.contentHash,
      ...Object.fromEntries(summaryFields.map((field) => [field, record[field]])),
      ...(record.coverage === undefined ? {} : { coverage: record.coverage }),
    }),
  );
}
function recordValid(state, unit, record) {
  try {
    validateSummary(record);
  } catch {
    return false;
  }
  return (
    record?.unitId === unit.id &&
    record.snapshotHash === state.snapshotHash &&
    record.contentHash === unit.contentHash &&
    recordDigest(record) === record.recordHash &&
    receiptCoverage(state, unit, record.receiptIds)
  );
}
function traceProblems(state, trace) {
  const problems = [];
  if (
    trace.snapshotHash !== state.snapshotHash ||
    !/^\/(?:features|product|dependencies|diagrams)(?:\/|$)/.test(trace.target || '') ||
    trace.valueHash !== hash(JSON.stringify(trace.value))
  )
    problems.push('依据目标／内容指纹无效。');
  if (
    !['observed', 'requested', 'inferred', 'unknown'].includes(trace.classification) ||
    !Array.isArray(trace.evidence) ||
    !trace.evidence.length
  )
    return [...problems, '依据分类或来源缺失。'];
  for (const evidence of trace.evidence) {
    if (evidence.kind === 'code') {
      const unit = state.units.find((unit) => unit.id === evidence.unitId),
        record = state.records[evidence.unitId];
      if (
        !unit ||
        !record ||
        record.recordHash !== evidence.recordHash ||
        !recordValid(state, unit, record) ||
        reviewProblems(unit, record).length
      )
        problems.push(`源码分析依据无效：${evidence.unitId}`);
    } else if (evidence.kind === 'requirement') {
      if (!['user', 'document'].includes(evidence.source) || !nonempty(evidence.text))
        problems.push('需求依据需要 source: user|document 及原文 text。');
    } else problems.push('不支持的依据类型。');
  }
  if (trace.classification === 'observed' && !trace.evidence.some((item) => item.kind === 'code'))
    problems.push('代码已有行为必须绑定源码分析记录。');
  if (
    trace.classification === 'requested' &&
    !trace.evidence.some((item) => item.kind === 'requirement')
  )
    problems.push('用户期望行为必须附需求原文。');
  if (['inferred', 'unknown'].includes(trace.classification) && !nonempty(trace.note))
    problems.push('推断／未知必须说明理由。');
  if (
    trace.completionImpact !== undefined &&
    (!['blocking', 'informational'].includes(trace.completionImpact) ||
      !['inferred', 'unknown'].includes(trace.classification) ||
      !/^\/features\/[^/]+\/notes$/.test(trace.target))
  )
    problems.push(
      'completionImpact 仅用于推断／未知 notes，取 blocking 或 informational；informational 的 note 须说明为何不影响当前业务验收。',
    );
  return problems;
}
export async function traceAnalysis(session, input) {
  exactFields(input, ['traces'], '依据输入');
  if (!Array.isArray(input.traces) || !input.traces.length) invalid('需要非空 traces 数组。');
  return updateSession(session, (state) => {
    const ids = new Set(),
      results = [];
    for (const trace of input.traces) {
      exactFields(
        trace,
        ['id', 'target', 'value', 'classification', 'evidence', 'note', 'completionImpact'],
        '流程依据',
      );
      if (!nonempty(trace.id) || !/^[a-zA-Z0-9_-]{1,100}$/.test(trace.id) || ids.has(trace.id))
        invalid('依据 id 应为不重复的 1–100 位字母、数字、连字符或下划线。');
      if (!Object.hasOwn(trace, 'value')) invalid('依据必须包含最终 value；删除目标使用 null。');
      if (trace.note !== undefined && !nonempty(trace.note))
        invalid('note 若提供，必须为非空文字。');
      ids.add(trace.id);
      if (!Array.isArray(trace.evidence) || !trace.evidence.length)
        invalid('evidence 必须是非空数组。');
      for (const evidence of trace.evidence)
        exactFields(
          evidence,
          evidence?.kind === 'code' ? ['kind', 'unitId', 'recordHash'] : ['kind', 'source', 'text'],
          '依据来源',
        );
      const stored = {
        ...structuredClone(trace),
        snapshotHash: state.snapshotHash,
        valueHash: hash(JSON.stringify(trace.value)),
      };
      const problems = traceProblems(state, stored);
      if (problems.length)
        throw new BlueprintError('VALIDATION_FAILED', '流程依据校验失败。', {
          details: problems.map((message) => ({ path: trace.id, message })),
        });
      results.push(stored);
    }
    for (const trace of results)
      Object.defineProperty(state.traces, trace.id, {
        value: trace,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return { sessionId: state.sessionId, traces: results };
  });
}

export function checkState(state) {
  assertFresh(state);
  const gaps = [...state.gaps];
  let reviewedCount = 0,
    reviewedPointCount = 0;
  for (const unit of state.units) {
    const record = state.records[unit.id];
    if (!record)
      gaps.push({ path: unit.id, file: unit.file, kind: 'record', message: '缺少独立分析结果。' });
    else if (!recordValid(state, unit, record))
      gaps.push({
        path: unit.id,
        file: unit.file,
        kind: 'receipt',
        message: '读取覆盖、内容指纹或分析字段无效。',
      });
    else {
      const problems = reviewProblems(unit, record);
      if (!problems.length) {
        reviewedCount += 1;
        reviewedPointCount += unit.reviewPoints.length;
      }
      for (const problem of problems)
        gaps.push({ path: unit.id, file: unit.file, kind: 'review', ...problem });
    }
  }
  for (const context of state.contexts) {
    const receipts = Object.values(state.receipts)
      .filter((receipt) => receipt.file === context.file)
      .map((receipt) => receipt.id);
    if (!receiptCoverage(state, context, receipts))
      gaps.push({
        path: context.id,
        file: context.file,
        kind: 'context',
        message: '尚未完整读取上下文配置（不计入函数分析）。',
      });
  }
  for (const trace of Object.values(state.traces))
    for (const message of traceProblems(state, trace))
      gaps.push({ path: trace.id, kind: 'trace', message });
  return {
    valid: gaps.length === 0,
    sessionId: state.sessionId,
    snapshotHash: state.snapshotHash,
    scope: state.scope,
    unitCount: state.units.length,
    recordedCount: state.units.filter((unit) => state.records[unit.id]).length,
    reviewedCount,
    reviewPointCount: state.units.reduce(
      (count, unit) => count + (unit.reviewPoints?.length || 0),
      0,
    ),
    reviewedPointCount,
    contextCount: state.contexts.length,
    typeCount: state.types.length,
    projectRoot: state.root,
    unknowns: state.units
      .filter(
        (unit) =>
          unit.calls.some((call) => call.status === 'unknown') ||
          state.records[unit.id]?.unknowns?.length,
      )
      .map((unit) => ({
        unitId: unit.id,
        file: unit.file,
        items: state.records[unit.id]?.unknowns || [],
        unresolvedCalls: unit.calls.filter((call) => call.status === 'unknown'),
      })),
    gaps,
    ...(gaps.length ? { code: 'ANALYSIS_INCOMPLETE' } : {}),
  };
}
export function checkAnalysis(session) {
  return checkState(loadSession(session).state);
}

// Hold the analysis lock through document commit so records/traces cannot change mid-write.
// Source files themselves are external inputs: recheck them inside the document updater as well.
export async function withAnalysisSession(session, operation) {
  try {
    let state, result;
    await updateDocument(
      sessionFile(session),
      (value) => {
        assertFresh(value);
        state = value;
        return { changed: false, result: null };
      },
      {
        afterCommit: async () => {
          result = await operation(state);
        },
      },
    );
    return result;
  } catch (error) {
    if (error instanceof DocumentConflictError)
      throw new BlueprintError('CONFLICT', '分析会话正在保存，请稍后重试。', { status: 409 });
    throw error;
  }
}

const business = new Set([
  'description',
  'overview',
  'notes',
  'actors',
  'rules',
  'checks',
  'impact',
  'flow',
  'stepDetails',
  'dependencies',
  'sequence',
  'dataflow',
]);
const pointerEscape = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
function pointerValue(document, pointer) {
  let value = document;
  for (const key of pointer
    .split('/')
    .slice(1)
    .map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
const traceMatches = (trace, document) => {
  const value = pointerValue(document, trace.target);
  return value !== undefined && hash(JSON.stringify(value)) === trace.valueHash;
};
function leaves(value, pointer) {
  if (value === undefined) return [];
  if (
    (Array.isArray(value) && !value.length) ||
    (object(value) && !Object.keys(value).length) ||
    value === ''
  )
    return [];
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) =>
      leaves(item, `${pointer}/${pointerEscape(key)}`),
    );
  return [{ target: pointer, value: value ?? null }];
}
export function guardAnalysis(state, plan, bundle, { allowPartialAnalysis = false } = {}) {
  const report = checkState(state),
    targets = [],
    completions = bundle.operations.filter((op) => op.op === 'feature.complete');
  for (const change of plan.changes) {
    const parts = change.path
      .split('/')
      .slice(1)
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts[0] === 'features') {
      if (parts.length === 2) {
        if (change.after === null) targets.push({ target: change.path, value: null });
        else
          for (const [field, value] of Object.entries(change.after))
            if (business.has(field)) targets.push(...leaves(value, `${change.path}/${field}`));
      } else if (business.has(parts[2])) {
        if (change.action === 'remove') targets.push({ target: change.path, value: null });
        else if ((Array.isArray(change.after) && !change.after.length) || change.after === '')
          targets.push({ target: change.path, value: change.after });
        else targets.push(...leaves(change.after, change.path));
      }
    } else
      targets.push(
        ...(change.action === 'remove'
          ? [{ target: change.path, value: null }]
          : leaves(change.after, change.path)),
      );
  }
  for (const op of bundle.operations.filter((op) =>
    ['feature.sync', 'feature.complete'].includes(op.op),
  )) {
    const feature = plan.document.features[op.id];
    for (const field of ['description', 'flow', 'stepDetails', 'rules', 'checks', 'dependencies'])
      targets.push(...leaves(feature[field], `/features/${op.id}/${field}`));
  }
  for (const target of targets) {
    const completing = completions.some((op) => target.target.startsWith(`/features/${op.id}/`));
    const trace = Object.values(state.traces).find(
      (trace) =>
        trace.target === target.target &&
        trace.valueHash === hash(JSON.stringify(target.value)) &&
        (!completing || trace.classification === 'observed') &&
        !traceProblems(state, trace).length,
    );
    if (!trace)
      report.gaps.push({
        path: target.target,
        kind: 'trace',
        message: '缺少绑定最终字段内容的有效源码／需求依据。',
      });
    else if (
      ['inferred', 'unknown'].includes(trace.classification) &&
      (!/^\/features\/[^/]+\/notes$/.test(trace.target) ||
        typeof trace.value !== 'string' ||
        !(
          trace.classification === 'inferred'
            ? /^\s*\[(?:推断|inferred)\]/i
            : /^\s*\[(?:未知|待确认|unknown)\]/i
        ).test(trace.value))
    )
      report.gaps.push({
        path: target.target,
        kind: 'classification',
        message:
          '推断／未知只能写入 notes，原文以 [推断]／[未知]（或英文标签）明确标注，不能当作已确认事实。',
      });
  }
  for (const op of completions) {
    const sourceEvidence = Object.values(state.traces).some(
      (trace) =>
        trace.target.startsWith(`/features/${op.id}/`) &&
        traceMatches(trace, plan.document) &&
        trace.classification === 'observed' &&
        trace.evidence.some(
          (evidence) =>
            evidence.kind === 'code' && state.records[evidence.unitId]?.role === 'product',
        ) &&
        !traceProblems(state, trace).length,
    );
    if (!sourceEvidence)
      report.gaps.push({
        path: `/features/${op.id}`,
        kind: 'completion',
        message: '完成登记需要此功能的代码已有行为依据；纯需求草稿不能登记完成。',
      });
    for (const trace of Object.values(state.traces))
      if (
        trace.target.startsWith(`/features/${op.id}/`) &&
        traceMatches(trace, plan.document) &&
        ['inferred', 'unknown'].includes(trace.classification) &&
        trace.completionImpact !== 'informational'
      )
        report.gaps.push({
          path: trace.target,
          kind: 'completion',
          message: '此功能仍有推断／未知依据，不能登记完成。',
        });
  }
  report.valid = report.gaps.length === 0;
  if (!report.valid) report.code = 'ANALYSIS_INCOMPLETE';
  if (allowPartialAnalysis && completions.length)
    throw new BlueprintError('ANALYSIS_INCOMPLETE', '显式部分分析模式不允许任何完成登记。', {
      details: report.gaps,
    });
  if (
    !report.valid &&
    (!allowPartialAnalysis ||
      report.gaps.some((gap) => ['classification', 'completion'].includes(gap.kind)) ||
      plan.features.some((feature) => feature.after?.status === 'complete'))
  )
    throw new BlueprintError(
      'ANALYSIS_INCOMPLETE',
      '分析检查未通过；重新读取／补齐依据，或显式允许部分分析保存草稿。',
      { details: report.gaps },
    );
  return { ...report, partial: !report.valid };
}
