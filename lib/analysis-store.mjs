import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { BlueprintError } from './errors.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const collections = [
  'receipts',
  'records',
  'traces',
  'flows',
  'entryDispositions',
  'verificationPlans',
];
const observations = Symbol('observed-records');
const signature = (filename) => {
  const value = fs.statSync(filename, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
};
const fail = (message) => {
  throw new BlueprintError('ANALYSIS_STALE', message, { status: 409 });
};

export function readAnalysisState(filename) {
  const initialSignature = signature(filename);
  const content = fs.readFileSync(filename, 'utf8'),
    state = JSON.parse(content);
  let previousHash = hash(content),
    bytes = 0;
  const journal = filename + '.events.jsonl';
  if (fs.existsSync(journal)) {
    const buffer = fs.readFileSync(journal);
    const end = buffer.lastIndexOf(10) + 1; // A killed writer's incomplete tail is not a commit.
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        fail('分析增量日志损坏，请恢复备份或重新分析。');
      }
      const { checksum, ...payload } = frame;
      if (
        frame.version !== 1 ||
        frame.previousHash !== previousHash ||
        frame.revision !== state.editRevision + 1 ||
        checksum !== hash(JSON.stringify(payload))
      )
        fail('分析增量日志或基础文件已变化，不能复用未核对的记录。');
      for (const [collection, changes] of Object.entries(frame.changes || {})) {
        if (!collections.includes(collection)) fail('分析日志包含非记录字段。');
        state[collection] ||= {};
        for (const [id, value] of Object.entries(changes)) {
          if (value === null) delete state[collection][id];
          else
            Object.defineProperty(state[collection], id, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        }
      }
      state.editRevision = frame.revision;
      previousHash = checksum;
    }
    bytes = end;
  }
  if (signature(filename) !== initialSignature)
    fail('分析基础文件在读取期间发生变化，请重新读取。');
  return {
    state,
    storage: { filename, signature: initialSignature, journal, bytes, previousHash },
  };
}

export function mutableSnapshot(state) {
  const before = Object.fromEntries(collections.map((key) => [key, { ...(state[key] || {}) }]));
  const read = new Map();
  let active = true;
  // Capture only old rows actually read by the updater. A shallow identity diff
  // alone silently drops nested edits; cloning/stringifying the entire large
  // analysis session on every write would defeat incremental storage.
  for (const key of collections) {
    const target = state[key] || {};
    state[key] = new Proxy(target, {
      get(object, id, receiver) {
        const value = Reflect.get(object, id, receiver);
        if (
          active &&
          typeof id === 'string' &&
          Object.hasOwn(before[key], id) &&
          before[key][id] === value &&
          value &&
          typeof value === 'object'
        ) {
          if (!read.has(key)) read.set(key, new Map());
          if (!read.get(key).has(id)) read.get(key).set(id, JSON.stringify(value));
        }
        return value;
      },
    });
  }
  Object.defineProperty(before, observations, {
    value: {
      read,
      finish: () => {
        active = false;
      },
    },
  });
  return before;
}

export function appendAnalysisState(state, before, storage) {
  before[observations]?.finish();
  if (signature(storage.filename) !== storage.signature)
    fail('分析基础文件在保存期间被外部修改，请重新读取，未追加本次记录。');
  const changes = {};
  for (const key of collections) {
    const previous = before[key],
      current = state[key] || {},
      delta = {};
    for (const id of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (!Object.hasOwn(current, id))
        Object.defineProperty(delta, id, { value: null, enumerable: true });
      else if (
        previous[id] !== current[id] ||
        (before[observations]?.read.get(key)?.has(id) &&
          before[observations].read.get(key).get(id) !== JSON.stringify(current[id]))
      )
        Object.defineProperty(delta, id, { value: current[id], enumerable: true });
    }
    if (Object.keys(delta).length) changes[key] = delta;
  }
  const payload = {
    version: 1,
    previousHash: storage.previousHash,
    revision: state.editRevision,
    changes,
  };
  const line = JSON.stringify({ ...payload, checksum: hash(JSON.stringify(payload)) }) + '\n';
  const descriptor = fs.openSync(
    storage.journal,
    fs.existsSync(storage.journal) ? 'r+' : 'wx',
    0o600,
  );
  try {
    fs.ftruncateSync(descriptor, storage.bytes);
    const buffer = Buffer.from(line);
    let written = 0;
    while (written < buffer.length)
      written += fs.writeSync(
        descriptor,
        buffer,
        written,
        buffer.length - written,
        storage.bytes + written,
      );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
