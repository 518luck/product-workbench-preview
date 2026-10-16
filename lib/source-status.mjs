import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { adapterProfiles } from './analysis-adapters.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const kinds = new Set(['source', 'types', 'context', 'unsupported', 'unreadable']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim());

export function sourceSnapshotHash(snapshot) {
  return hash(
    JSON.stringify({
      root: snapshot.root,
      parser: snapshot.parserVersion,
      protocol: snapshot.version === 2 ? 2 : 1,
      indexVersion: snapshot.indexVersion,
      ...(snapshot.version === 2 ? { analyzers: snapshot.analyzers } : {}),
      scope: snapshot.scope,
      manifest: snapshot.manifest,
    }),
  );
}
export function validSourceSnapshot(snapshot) {
  if (
    !object(snapshot) ||
    ![1, 2].includes(snapshot.version) ||
    (snapshot.version === 2 && !object(snapshot.analyzers)) ||
    typeof snapshot.root !== 'string' ||
    !snapshot.root.trim() ||
    !digest(snapshot.snapshotHash) ||
    typeof snapshot.parserVersion !== 'string' ||
    !snapshot.parserVersion.trim() ||
    !Number.isSafeInteger(snapshot.indexVersion) ||
    snapshot.indexVersion < 1 ||
    !object(snapshot.scope) ||
    !strings(snapshot.scope.include) ||
    !snapshot.scope.include.length ||
    !strings(snapshot.scope.exclude) ||
    (snapshot.scope.contexts !== undefined && !strings(snapshot.scope.contexts)) ||
    !Array.isArray(snapshot.manifest)
  )
    return false;
  const files = new Set();
  for (const item of snapshot.manifest) {
    if (
      !object(item) ||
      typeof item.file !== 'string' ||
      !item.file ||
      item.file.startsWith('/') ||
      item.file.split('/').includes('..') ||
      files.has(item.file) ||
      !kinds.has(item.kind) ||
      (item.hash !== undefined && !digest(item.hash)) ||
      (item.hash === undefined && typeof item.reason !== 'string')
    )
      return false;
    files.add(item.file);
  }
  return sourceSnapshotHash(snapshot) === snapshot.snapshotHash;
}
export function snapshotFromAnalysis(state) {
  return structuredClone({
    version: 2,
    root: state.root,
    snapshotHash: state.snapshotHash,
    parserVersion: state.parserVersion,
    indexVersion: state.indexVersion,
    analyzers: state.analyzers || adapterProfiles(),
    scope: state.scope,
    manifest: state.manifest.filter((item) => kinds.has(item.kind)),
  });
}
export async function checkSourceStatus(document) {
  const features = {},
    inventories = new Map();
  const { inventory, PARSER_VERSION, INDEX_VERSION } = Object.values(document.features).some(
    (f) => f.implementation?.sourceSnapshot,
  )
    ? await import('./analysis-index.mjs')
    : {};
  for (const feature of Object.values(document.features)) {
    const baseline = feature.implementation?.sourceSnapshot;
    if (!baseline) {
      features[feature.id] = {
        status: 'unverified',
        message: '缺少源码核验基线，尚不能比较当前源码。',
        changes: [],
      };
      continue;
    }
    if (!validSourceSnapshot(baseline)) {
      features[feature.id] = {
        status: 'unavailable',
        message: '源码核验基线无效，请重新读取源码并核验。',
        changes: [],
      };
      continue;
    }
    const key = JSON.stringify([baseline.root, baseline.scope]);
    if (!inventories.has(key)) {
      try {
        inventories.set(key, { value: inventory(baseline.root, baseline.scope) });
      } catch {
        inventories.set(key, { error: true });
      }
    }
    const scanned = inventories.get(key);
    if (scanned.error) {
      features[feature.id] = {
        status: 'unavailable',
        message: '无法读取基线对应的项目目录，源码状态尚未核验。',
        changes: [],
      };
      continue;
    }
    const current = scanned.value;
    const before = new Map(baseline.manifest.map((item) => [item.file, item]));
    const after = new Map(
      current.manifest.filter((item) => kinds.has(item.kind)).map((item) => [item.file, item]),
    );
    const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((file) => {
      const previous = before.get(file),
        next = after.get(file);
      return isDeepStrictEqual(previous, next)
        ? []
        : [
            {
              file,
              change: !previous ? 'added' : !next ? 'deleted' : 'modified',
              beforeHash: previous?.hash ?? null,
              afterHash: next?.hash ?? null,
            },
          ];
    });
    const configurationChanged =
      baseline.version !== 2 ||
      baseline.parserVersion !== PARSER_VERSION ||
      baseline.indexVersion !== INDEX_VERSION ||
      !isDeepStrictEqual(baseline.analyzers, current.analyzers);
    const unreadable = current.gaps.some((gap) => ['read', 'scope'].includes(gap.kind));
    const status = unreadable
      ? 'unavailable'
      : current.fingerprint === baseline.snapshotHash
        ? 'current'
        : 'changed';
    features[feature.id] = {
      status,
      message:
        status === 'current'
          ? '扫描范围内的源码与上次验收快照一致。'
          : status === 'unavailable'
            ? '源码读取存在缺口，当前状态尚不能核验。'
            : '源码已变化，蓝图待核验；业务影响尚待 AI 判断。',
      baselineHash: baseline.snapshotHash,
      currentHash: current.fingerprint,
      root: baseline.root,
      scope: baseline.scope,
      configurationChanged,
      changes,
    };
  }
  return { checkedAt: new Date().toISOString(), features };
}
