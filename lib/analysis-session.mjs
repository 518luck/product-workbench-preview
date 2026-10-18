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
import { DocumentConflictError } from './document-store.mjs';
import { withFileLock } from './file-lock.mjs';
import { readAnalysisState, mutableSnapshot, appendAnalysisState } from './analysis-store.mjs';
import { BlueprintError } from './errors.mjs';
import { reviewProblems } from './analysis-review.mjs';
import { batchReviewProblems } from './evidence-quality.mjs';
import { scopeCoverage } from './analysis-scope.mjs';
import { createIndexedState, indexedIntegrity } from './analysis-database.mjs';
import { invalidatedFiles } from './analysis-incremental.mjs';
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
  let state, storage;
  try {
    ({ state, storage } = readAnalysisState(filename));
  } catch (error) {
    if (error instanceof BlueprintError) throw error;
    throw new BlueprintError('VALIDATION_FAILED', `分析会话无法读取：${error.message}`);
  }
  if (
    ![1, 2].includes(state.version) ||
    !state.root ||
    !Array.isArray(state.units) ||
    !state.records ||
    !state.receipts ||
    !state.traces
  )
    throw new BlueprintError('VALIDATION_FAILED', '分析会话格式或解析器版本不匹配，请重新扫描。');
  return { filename, state, storage };
}
export function assertFresh(state) {
  if (state.version === 1)
    throw new BlueprintError(
      'ANALYSIS_STALE',
      '这是旧版分析记录，可查看历史；请重新扫描并按 v2 核验，不能直接复用旧结论。',
      { status: 409 },
    );
  if (
    state.version !== 2 ||
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
  if (!indexedIntegrity(state) && state.indexHash !== indexDigest(state))
    throw new BlueprintError(
      'ANALYSIS_STALE',
      '机器索引或适配器元数据指纹无效，请重新扫描；手工说明不能改写源码事实。',
      { status: 409 },
    );
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
function indexDigest(state) {
  return hash(
    JSON.stringify(
      [
        'snapshotHash',
        'analyzers',
        'scope',
        'units',
        'contexts',
        'types',
        'imports',
        'gaps',
        'facts',
        'incremental',
      ].map((key) => [key, state[key]]),
    ),
  );
}
export async function updateSession(session, updater) {
  try {
    const filename = sessionFile(session);
    return await withFileLock(
      filename,
      () => {
        const { state, storage } = loadSession(session),
          before = mutableSnapshot(state);
        assertFresh(state);
        const result = updater(state);
        if (result && typeof result.then === 'function')
          throw new TypeError('分析更新器必须同步执行。');
        state.editRevision += 1;
        appendAnalysisState(state, before, storage);
        return result;
      },
      { retryMs: 10000 },
    );
  } catch (error) {
    if (error instanceof DocumentConflictError)
      throw new BlueprintError('CONFLICT', '分析会话正在保存，请稍后重试。', { status: 409 });
    throw error;
  }
}
export async function scanAnalysis(root, scope = {}, { storage = 'sqlite' } = {}) {
  const current = inventory(root, scope);
  const analysisDirectory = path.join(current.root, '.blueprint-analysis');
  if (fs.existsSync(analysisDirectory) && fs.lstatSync(analysisDirectory).isSymbolicLink())
    invalid('.blueprint-analysis 不得是符号链接。');
  const previous = path.join(
    current.root,
    '.blueprint-analysis',
    `s-${current.fingerprint}`,
    'state.json',
  );
  // Exact resume never rebuilds parser/program/native facts.
  if (
    fs.existsSync(path.dirname(previous)) &&
    fs.lstatSync(path.dirname(previous)).isSymbolicLink()
  )
    invalid('会话目录不得是符号链接。');
  if (fs.existsSync(previous) && fs.lstatSync(previous).isSymbolicLink())
    invalid('state.json 不得是符号链接。');
  const rebuilding = !fs.existsSync(previous);
  const indexed = !rebuilding
    ? { ...current, ...loadSession(previous).state, fingerprint: current.fingerprint }
    : indexSnapshot(current);
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
      version: 2,
      parserVersion: PARSER_VERSION,
      indexVersion: INDEX_VERSION,
      analyzers: indexed.analyzers,
      facts: indexed.facts,
      flows: {},
      entryDispositions: {},
      businessModels: {},
      sessionId: path.basename(session),
      root: indexed.root,
      scope: indexed.scope,
      snapshotHash,
      gitCommit,
      createdAt: new Date().toISOString(),
      editRevision: 0,
      incremental: indexed.incremental,
      manifest,
      units,
      imports,
      types,
      gaps,
      contexts: [
        ...manifest
          .filter((item) => (item.kind === 'context' || item.context) && item.hash)
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
    state.indexHash = indexDigest(state);
    state.reuse = { records: 0, from: null, invalidatedFiles: [], reasons: [] };
    // Reuse only fully checked per-function analysis on unchanged source and
    // dependencies. Do not transfer business maps, flows, traces or executions.
    const candidates = fs
      .readdirSync(directory)
      .filter((name) => /^s-[a-f0-9]+$/.test(name) && name !== path.basename(session))
      .map((name) => path.join(directory, name, 'state.json'))
      .filter(
        (file) =>
          fs.existsSync(file) &&
          !fs.lstatSync(path.dirname(file)).isSymbolicLink() &&
          !fs.lstatSync(file).isSymbolicLink(),
      )
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const candidate of candidates) {
      let old;
      try {
        old = loadSession(candidate).state;
        if (!indexedIntegrity(old) && old.indexHash !== indexDigest(old)) continue;
      } catch {
        continue;
      }
      if (
        old.root !== state.root ||
        !old.incremental ||
        JSON.stringify(old.scope) !== JSON.stringify(state.scope)
      )
        continue;
      const affected = invalidatedFiles(old.incremental, state.incremental),
        invalidFiles = new Set(affected.files);
      state.reuse = {
        records: 0,
        from: old.sessionId,
        invalidatedFiles: affected.files,
        reasons: affected.reasons,
      };
      const oldUnits = new Map(old.units.map((unit) => [unit.id, unit]));
      const bad = batchReviewProblems(old.units, old.records);
      for (const unit of state.units) {
        const previous = oldUnits.get(unit.id),
          record = old.records[unit.id];
        if (
          invalidFiles.has(unit.file) ||
          !previous ||
          !record ||
          previous.contentHash !== unit.contentHash ||
          bad.has(unit.id) ||
          !recordValid(old, previous, record) ||
          reviewProblems(previous, record).length
        )
          continue;
        let valid = true;
        const receipts = [];
        for (const id of record.receiptIds) {
          const receipt = old.receipts[id];
          try {
            const subject = unitOrContext(state, receipt.unitId);
            if (
              subject.file !== receipt.file ||
              receipt.start < subject.start ||
              receipt.end > subject.end
            ) {
              valid = false;
              break;
            }
          } catch {
            valid = false;
            break;
          }
          const renewed = {
            ...receipt,
            id: `r-${randomUUID()}`,
            snapshotHash: state.snapshotHash,
            createdAt: new Date().toISOString(),
            provenance: {
              kind: 'unchanged-analysis-reuse',
              sessionId: old.sessionId,
              receiptId: id,
              snapshotHash: old.snapshotHash,
            },
          };
          state.receipts[renewed.id] = renewed;
          receipts.push(renewed.id);
        }
        if (!valid) continue;
        const renewed = {
          ...structuredClone(record),
          receiptIds: receipts,
          snapshotHash: state.snapshotHash,
          reusedFrom: {
            sessionId: old.sessionId,
            snapshotHash: old.snapshotHash,
            recordHash: record.recordHash,
          },
        };
        renewed.recordHash = recordDigest(renewed);
        state.records[unit.id] = renewed;
        state.reuse.records++;
      }
      break;
    }
    if (storage === 'sqlite') {
      await withFileLock(
        filename,
        () => {
          if (!fs.existsSync(filename)) createIndexedState(filename, state);
          else resumed = true;
        },
        { retryMs: 10000 },
      );
    } else {
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
  }
  const { state } = loadSession(session);
  assertFresh(state);
  return {
    session,
    sessionId: state.sessionId,
    snapshotHash,
    resumed,
    unitCount: state.units.length,
    recordedCount: state.units.filter((unit) => state.records[unit.id]).length,
    typeCount: state.types.length,
    contextCount: state.contexts.length,
    manifest: state.manifest,
    imports: state.imports,
    gaps: state.gaps,
    analyzers: state.analyzers,
    entryCount: state.facts?.entries?.length || 0,
    operationCount: state.facts?.operations?.length || 0,
    scopeCoverage: scopeCoverage(state),
    reuse: state.reuse,
    indexRebuilt: rebuilding,
  };
}
export function listAnalysis(
  session,
  { offset = 0, limit = 50, status = 'all', kind = 'units' } = {},
) {
  const { state } = loadSession(session);
  if (state.version !== 1) assertFresh(state);
  const batchProblems =
    kind === 'units' ? batchReviewProblems(state.units, state.records) : new Map();
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
    ![
      'units',
      'contexts',
      'files',
      'types',
      'traces',
      'entries',
      'operations',
      'values',
      'edges',
    ].includes(kind)
  )
    invalid('列表筛选无效。');
  let items =
    kind === 'units'
      ? state.units.map((unit) => ({
          ...unit,
          status:
            state.version === 2 &&
            state.records[unit.id] &&
            !batchProblems.has(unit.id) &&
            !reviewProblems(unit, state.records[unit.id]).length
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
            : ['entries', 'operations', 'values', 'edges'].includes(kind)
              ? state.facts?.[kind] || []
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
    legacy: state.version === 1,
  };
}
function unitOrContext(state, id) {
  if (typeof id === 'string' && id.startsWith('file:')) {
    const file = state.manifest.find(
      (item) =>
        item.file === id.slice(5) &&
        item.hash &&
        ['source', 'types', 'context'].includes(item.kind),
    );
    if (file) return { ...file, id, sourceHash: file.hash, start: 0, end: file.utf16Length };
  }
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
function readUnit(state, id, { offset = 0, length = 16000 } = {}, sources = new Map()) {
  const unit = unitOrContext(state, id),
    source = sources.get(unit.file) ?? readText(path.join(state.root, unit.file));
  sources.set(unit.file, source);
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
}
export async function readAnalysis(session, id, options = {}) {
  return updateSession(session, (state) => readUnit(state, id, options));
}
export async function readAnalysisPack(session, file, options = {}) {
  return updateSession(session, (state) => {
    const read = readUnit(state, `file:${file}`, options);
    return {
      ...read,
      file,
      units: state.units
        .filter((u) => u.file === file && u.end > read.start && u.start < read.end)
        .map(({ id, name, kind, start, end, role, reviewPoints }) => ({
          id,
          name,
          kind,
          start,
          end,
          role,
          reviewPoints,
          fullyIncluded: start >= read.start && end <= read.end,
        })),
      scope: '正文只输出一次；凭据可支持完整覆盖的嵌套单元，但每个函数仍需独立语义记录。',
    };
  });
}
export async function readAnalysisBatch(session, input) {
  if (
    !input ||
    Object.keys(input).some((key) => key !== 'reads') ||
    !Array.isArray(input.reads) ||
    !input.reads.length ||
    input.reads.length > 32
  )
    invalid('批量读取需要 reads 数组，每批 1–32 项。');
  return updateSession(session, (state) => {
    const sources = new Map(),
      items = [];
    let size = 0;
    for (const entry of input.reads) {
      if (!entry || Object.keys(entry).some((key) => !['id', 'offset', 'length'].includes(key)))
        invalid('读取项只接受 id、offset、length。');
      const { id, ...options } = entry,
        item = readUnit(state, id, options, sources);
      size += item.code.length;
      if (size > 262144) invalid('单批源码输出不得超过 262144 个 UTF-16 单位，请拆分读取。');
      items.push(item);
    }
    return { sessionId: state.sessionId, items };
  });
}

export function receiptCoverage(state, unit, ids, sources = new Map()) {
  const ranges = [];
  const source = sources.get(unit.file) ?? readText(path.join(state.root, unit.file));
  sources.set(unit.file, source);
  for (const id of ids || []) {
    const receipt = state.receipts[id];
    if (
      !receipt ||
      receipt.snapshotHash !== state.snapshotHash ||
      receipt.file !== unit.file ||
      receipt.sourceHash !== (unit.sourceHash || unit.hash)
    )
      return false;
    let subject;
    try {
      subject = unitOrContext(state, receipt.unitId);
    } catch {
      return false;
    }
    if (subject.file !== receipt.file || receipt.start < subject.start || receipt.end > subject.end)
      return false;
    if (
      receipt.start < 0 ||
      receipt.end > source.length ||
      receipt.start > receipt.end ||
      hash(source.slice(receipt.start, receipt.end)) !== receipt.contentHash
    )
      return false;
    if (receipt.end >= unit.start && receipt.start <= unit.end)
      ranges.push([Math.max(receipt.start, unit.start), Math.min(receipt.end, unit.end)]);
  }
  let covered = unit.start;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start > covered) return false;
    covered = Math.max(covered, end);
    if (covered >= unit.end) return true;
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
  if (record.claims !== undefined) {
    if (record.coverage !== undefined || !Array.isArray(record.claims))
      invalid('claims 与旧 coverage 二选一。');
    for (const claim of record.claims) {
      exactFields(claim, ['pointIds', 'detail'], '语义断言');
      if (
        !Array.isArray(claim.pointIds) ||
        !claim.pointIds.length ||
        claim.pointIds.some((id) => !nonempty(id)) ||
        !nonempty(claim.detail)
      )
        invalid('语义断言需要真实 pointIds 和具体行为说明。');
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
      exactFields(
        record,
        ['unitId', 'receiptIds', ...summaryFields, 'coverage', 'claims'],
        '分析记录',
      );
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
    const candidate = {
      ...state.records,
      ...Object.fromEntries(results.map((r) => [r.unitId, r])),
    };
    const batchProblems = batchReviewProblems(state.units, candidate);
    const repeated = results.filter((r) => batchProblems.has(r.unitId));
    if (repeated.length)
      throw new BlueprintError('ANALYSIS_INCOMPLETE', '批量分析复用了通用说明模板。', {
        details: repeated.map((r) => ({ path: r.unitId, ...batchProblems.get(r.unitId)[0] })),
      });
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
      ...(record.claims === undefined ? {} : { claims: record.claims }),
    }),
  );
}
export function recordValid(state, unit, record) {
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
    } else if (evidence.kind === 'context') {
      const context = state.contexts.find((c) => c.id === evidence.contextId);
      if (
        !context ||
        !state.facts.entries.some((e) => e.kind === 'workflow' && e.contextId === context.id) ||
        !receiptCoverage(state, context, Object.keys(state.receipts)) ||
        typeof evidence.quote !== 'string' ||
        evidence.quote.trim().length < 8 ||
        !readText(path.join(state.root, context.file))
          .slice(context.start, context.end)
          .includes(evidence.quote)
      )
        problems.push('工作流依据须引用已完整读取的实际工作流原文；普通说明或配置不能代替实现。');
    } else if (evidence.kind === 'requirement') {
      if (!['user', 'document'].includes(evidence.source) || !nonempty(evidence.text))
        problems.push('需求依据需要 source: user|document 及原文 text。');
    } else problems.push('不支持的依据类型。');
  }
  if (
    trace.classification === 'observed' &&
    !trace.evidence.some((item) => ['code', 'context'].includes(item.kind))
  )
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
          evidence?.kind === 'code'
            ? ['kind', 'unitId', 'recordHash']
            : evidence?.kind === 'context'
              ? ['kind', 'contextId', 'quote']
              : ['kind', 'source', 'text'],
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
  const batchProblems = batchReviewProblems(state.units, state.records);
  const sources = new Map(),
    byFile = new Map();
  for (const receipt of Object.values(state.receipts)) {
    if (!byFile.has(receipt.file)) byFile.set(receipt.file, []);
    byFile.get(receipt.file).push(receipt.id);
  }
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
      const problems = [...reviewProblems(unit, record), ...(batchProblems.get(unit.id) || [])];
      if (!problems.length) {
        reviewedCount += 1;
        reviewedPointCount += unit.reviewPoints.length;
      }
      for (const problem of problems)
        gaps.push({ path: unit.id, file: unit.file, kind: 'review', ...problem });
    }
  }
  for (const context of state.contexts) {
    const receipts = byFile.get(context.file) || [];
    if (!receiptCoverage(state, context, receipts, sources))
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
    fullyReadCount: state.units.filter((unit) =>
      receiptCoverage(state, unit, byFile.get(unit.file) || [], sources),
    ).length,
    contextCount: state.contexts.length,
    typeCount: state.types.length,
    projectRoot: state.root,
    scopeCoverage: scopeCoverage(state),
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
    return await withFileLock(
      sessionFile(session),
      async () => {
        const { state } = loadSession(session);
        assertFresh(state);
        return operation(state);
      },
      { retryMs: 10000 },
    );
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
            (evidence.kind === 'code' && state.records[evidence.unitId]?.role === 'product') ||
            (evidence.kind === 'context' &&
              state.facts.entries.some(
                (e) => e.kind === 'workflow' && e.contextId === evidence.contextId,
              )),
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
  // Completion is scoped to a saved feature and its actual executions. An unrelated
  // language capability gap must not turn independently verified features into drafts.
  // Missing reads, summaries, context, field evidence and relevant capability gaps still block.
  const explicitExecutions =
    completions.length &&
    completions.every(
      (operation) =>
        operation.implementation?.checks?.length &&
        operation.implementation.checks.every((check) => typeof check.executionId === 'string'),
    );
  if (
    !report.valid &&
    explicitExecutions &&
    bundle.operations.every((operation) =>
      ['feature.complete', 'feature.sync'].includes(operation.op),
    )
  ) {
    const ids = new Set();
    for (const operation of completions)
      for (const trace of Object.values(state.traces))
        if (
          trace.target.startsWith(`/features/${operation.id}/`) &&
          traceMatches(trace, plan.document) &&
          trace.classification === 'observed' &&
          !traceProblems(state, trace).length
        )
          for (const evidence of trace.evidence)
            if (evidence.kind === 'code') ids.add(evidence.unitId);
    for (const id of ids)
      for (const call of state.units.find((unit) => unit.id === id)?.calls || [])
        if (call.target) ids.add(call.target);
    const units = state.units.filter((unit) => ids.has(unit.id)),
      files = new Set(units.map((unit) => unit.file)),
      languages = new Set(units.map((unit) => unit.language || 'javascript'));
    const unrelated = report.gaps.filter(
      (gap) =>
        ['language', 'semantic', 'adapter'].includes(gap.kind) &&
        (gap.file || gap.language) &&
        !files.has(gap.file) &&
        (!gap.language || !languages.has(gap.language)),
    );
    if (units.length && unrelated.length === report.gaps.length)
      return {
        ...report,
        partial: true,
        independentCompletion: true,
        completionScope: {
          featureIds: completions.map((operation) => operation.id),
          files: [...files],
        },
        message: '本次功能的源码依据与真实验收独立成立；其他能力缺口保留，整体严格交付尚未通过。',
      };
  }
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
