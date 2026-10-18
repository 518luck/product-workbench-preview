import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BlueprintError } from './errors.mjs';

const digest = (v) => createHash('sha256').update(v).digest('hex');
const json = (v) => JSON.stringify(v);
const collections = [
  'receipts',
  'records',
  'traces',
  'flows',
  'entryDispositions',
  'verificationPlans',
  'businessModels',
];
const stores = new WeakMap(),
  pools = new Map();
const fail = (message) => {
  throw new BlueprintError('ANALYSIS_STALE', message, { status: 409 });
};
const signature = (file) => {
  const s = fs.statSync(file, { bigint: true });
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
};
function database(file) {
  if (fs.lstatSync(file).isSymbolicLink()) fail('分析数据库不得是符号链接。');
  if (!pools.has(file)) {
    if (pools.size >= 8) {
      const [key, db] = pools.entries().next().value;
      db.close();
      pools.delete(key);
    }
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout=5000');
    pools.set(file, db);
  }
  return pools.get(file);
}
const headerHash = (meta, headers) =>
  digest(
    json([
      meta,
      headers.map(({ collection, position, id, summary, fields, hash }) => [
        collection,
        position,
        id,
        summary,
        fields,
        hash,
      ]),
    ]),
  );

// New sessions use row-addressed storage. The small descriptor seals immutable
// index headers; payloads are verified when read. Mutable rows are transactional.
// Legacy state.json + journal remains readable through analysis-store.mjs.
export function createIndexedState(filename, state) {
  const dbfile = path.join(path.dirname(filename), 'state.sqlite');
  const temporary = dbfile + '.' + randomUUID() + '.tmp';
  const db = new DatabaseSync(temporary),
    headers = [];
  fs.chmodSync(temporary, 0o600);
  const meta = { ...state, facts: { ...state.facts } },
    arrays = {};
  for (const key of ['units', 'contexts', 'types', 'manifest', 'imports', 'gaps']) {
    arrays[key] = state[key] || [];
    delete meta[key];
  }
  for (const [key, value] of Object.entries(state.facts || {}))
    if (Array.isArray(value)) {
      arrays['facts.' + key] = value;
      delete meta.facts[key];
    }
  for (const key of collections) delete meta[key];
  try {
    db.exec(
      'CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE immutable(collection TEXT,position INTEGER,id TEXT,summary TEXT,fields TEXT,body TEXT,hash TEXT,PRIMARY KEY(collection,position));CREATE TABLE mutable(collection TEXT,id TEXT,body TEXT,hash TEXT,PRIMARY KEY(collection,id));BEGIN IMMEDIATE',
    );
    const insert = db.prepare('INSERT INTO immutable VALUES(?,?,?,?,?,?,?)');
    for (const [collection, items] of Object.entries(arrays))
      for (const [position, item] of items.entries()) {
        const summary = Object.fromEntries(
          Object.entries(item).filter(
            ([key, value]) =>
              !['reviewPoints', 'calls', 'label', 'code', 'contentHash'].includes(key) &&
              (value === null || !['object'].includes(typeof value)),
          ),
        );
        const body = json(item),
          row = {
            collection,
            position,
            id: item.id || '',
            summary: json(summary),
            fields: json(Object.keys(item)),
            hash: digest(body),
          };
        insert.run(collection, position, row.id, row.summary, row.fields, body, row.hash);
        headers.push(row);
      }
    // Match the query order, independent of JavaScript property insertion order.
    headers.sort((a, b) =>
      a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : a.position - b.position,
    );
    const payload = json({
      state: meta,
      arrays: Object.fromEntries(Object.entries(arrays).map(([k, v]) => [k, v.length])),
    });
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('base', payload);
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('revision', String(state.editRevision));
    const mutable = db.prepare('INSERT INTO mutable VALUES(?,?,?,?)');
    for (const key of collections)
      for (const [id, value] of Object.entries(state[key] || {})) {
        const body = json(value);
        mutable.run(key, id, body, digest(body));
      }
    db.exec('COMMIT');
    db.close();
    pools.get(dbfile)?.close();
    pools.delete(dbfile);
    fs.renameSync(temporary, dbfile);
    const descriptorFile = filename + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(
        descriptorFile,
        json({
          storageVersion: 1,
          database: 'state.sqlite',
          indexRoot: headerHash(payload, headers),
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      fs.linkSync(descriptorFile, filename);
    } finally {
      fs.rmSync(descriptorFile, { force: true });
    }
  } catch (error) {
    try {
      db.close();
    } catch {}
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function readIndexedState(filename, descriptor) {
  if (descriptor.database !== 'state.sqlite' || typeof descriptor.indexRoot !== 'string')
    fail('分析数据库描述无效。');
  const dbfile = path.join(path.dirname(filename), descriptor.database),
    db = database(dbfile);
  db.exec('BEGIN');
  let payload, headers, revision, keys;
  try {
    payload = db.prepare("SELECT value FROM metadata WHERE key='base'").get()?.value;
    headers = db
      .prepare(
        'SELECT collection,position,id,summary,fields,hash FROM immutable ORDER BY collection,position',
      )
      .all();
    revision = Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value);
    keys = db.prepare('SELECT collection,id FROM mutable ORDER BY collection,id').all();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
  if (
    headerHash(payload, headers) !== descriptor.indexRoot ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    fail('分析索引头或版本无效，不能复用缓存结论。');
  const base = JSON.parse(payload),
    state = base.state,
    immutable = [],
    cache = new Map(),
    dirty = new Map();
  const store = {
    filename,
    dbfile,
    descriptor,
    signature: signature(filename),
    payload,
    revision,
    immutable,
    cache,
    dirty,
    active: false,
    stats: { immutableRowsRead: 0, mutableRowsRead: 0 },
  };
  const consistent = (operation, mutable = true) => {
    const db = database(dbfile);
    db.exec('BEGIN');
    try {
      if (
        mutable &&
        Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value) !==
          revision
      )
        fail('分析会话已由其他进程更新，请重新读取。');
      const result = operation(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  };
  const grouped = new Map();
  for (const row of headers) {
    if (!grouped.has(row.collection)) grouped.set(row.collection, []);
    grouped.get(row.collection).push(row);
  }
  for (const [collection, count] of Object.entries(base.arrays)) {
    const rows = grouped.get(collection) || [];
    if (rows.length !== count) fail('索引行数不匹配。');
    const items = rows.map((row) => {
      const summary = JSON.parse(row.summary),
        fields = JSON.parse(row.fields),
        value = {};
      let body;
      const load = () => {
        if (body) return body;
        const result = consistent(
          (db) =>
            db
              .prepare('SELECT body FROM immutable WHERE collection=? AND position=?')
              .get(collection, row.position),
          false,
        );
        if (!result || digest(result.body) !== row.hash) fail('分析索引内容已被修改。');
        store.stats.immutableRowsRead++;
        body = JSON.parse(result.body);
        return body;
      };
      for (const key of fields)
        if (Object.hasOwn(summary, key)) value[key] = summary[key];
        else
          Object.defineProperty(value, key, {
            enumerable: true,
            configurable: true,
            get: () => load()[key],
            set: (v) => {
              load()[key] = v;
            },
          });
      immutable.push(() => {
        if (
          json(Object.keys(value).sort()) !== json([...fields].sort()) ||
          Object.keys(summary).some((k) => json(value[k]) !== json(summary[k])) ||
          (body &&
            digest(json(Object.fromEntries(fields.map((key) => [key, value[key]])))) !== row.hash)
        )
          fail('机器索引在会话内被修改，不能继续使用。');
      });
      return value;
    });
    // Summary keys are created first; canonical key order need not match source.
    // Integrity uses the original field order when comparing a materialized row.
    const [parent, key] = collection.startsWith('facts.')
      ? [state.facts, collection.slice(6)]
      : [state, collection];
    parent[key] = items;
    const expected = [...items];
    immutable.push(() => {
      if (
        parent[key] !== items ||
        items.length !== count ||
        items.some((value, index) => value !== expected[index])
      )
        fail('机器索引集合在会话内被修改。');
    });
  }
  for (const key of collections) {
    const ids = new Set(keys.filter((r) => r.collection === key).map((r) => r.id));
    const get = (id) => {
      const token = key + '\0' + id;
      if (dirty.has(token)) return dirty.get(token)?.value;
      if (!cache.has(token) && ids.has(id)) {
        const row = consistent((db) =>
          db.prepare('SELECT body,hash FROM mutable WHERE collection=? AND id=?').get(key, id),
        );
        if (!row || digest(row.body) !== row.hash) fail('分析记录内容缺失或被修改。');
        store.stats.mutableRowsRead++;
        cache.set(token, { value: JSON.parse(row.body), before: row.body });
      }
      return cache.get(token)?.value;
    };
    state[key] = new Proxy(
      {},
      {
        ownKeys: () =>
          [
            ...new Set([
              ...ids,
              ...[...dirty.values()].filter((v) => v.collection === key).map((v) => v.id),
            ]),
          ].filter(
            (id) => !dirty.has(key + '\0' + id) || dirty.get(key + '\0' + id).value !== undefined,
          ),
        get: (_, id) => (typeof id === 'string' ? get(id) : undefined),
        has: (_, id) => get(id) !== undefined,
        getOwnPropertyDescriptor: (_, id) =>
          (ids.has(id) || dirty.has(key + '\0' + id)) &&
          (!dirty.has(key + '\0' + id) || dirty.get(key + '\0' + id).value !== undefined)
            ? { enumerable: true, configurable: true }
            : undefined,
        set: (_, id, value) => {
          dirty.set(key + '\0' + id, { collection: key, id, value });
          return true;
        },
        defineProperty: (_, id, descriptor) => {
          dirty.set(key + '\0' + id, { collection: key, id, value: descriptor.value });
          return true;
        },
        deleteProperty: (_, id) => {
          dirty.set(key + '\0' + id, { collection: key, id, value: undefined });
          return true;
        },
      },
    );
  }
  state.editRevision = revision;
  stores.set(state, store);
  return { state, storage: store };
}

export function indexedIntegrity(state) {
  const store = stores.get(state);
  if (!store) return false;
  if (signature(store.filename) !== store.signature) fail('分析描述已变化，请重新读取。');
  for (const check of store.immutable) check();
  const meta = { ...state, facts: { ...state.facts } };
  const original = JSON.parse(store.payload);
  for (const key of Object.keys(original.arrays))
    if (key.startsWith('facts.')) delete meta.facts[key.slice(6)];
    else delete meta[key];
  for (const key of collections) delete meta[key];
  meta.editRevision = original.state.editRevision;
  if (json(meta) !== json(original.state)) fail('机器索引元数据在会话内被修改。');
  return true;
}
export function indexedSnapshot(state) {
  const store = stores.get(state);
  if (!store) return null;
  store.active = true;
  return { indexed: true };
}
export function appendIndexedState(state, storage) {
  if (!stores.has(state)) return false;
  indexedIntegrity(state);
  if (state.editRevision !== storage.revision + 1) fail('分析版本不连续。');
  for (const [token, row] of storage.cache)
    if (!storage.dirty.has(token) && json(row.value) !== row.before) {
      const [collection, id] = token.split('\0');
      storage.dirty.set(token, { collection, id, value: row.value });
    }
  const db = database(storage.dbfile);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (
      Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value) !==
      storage.revision
    )
      fail('分析会话已更新，本次保存未覆盖其他修改。');
    const save = db.prepare(
      'INSERT INTO mutable VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body,hash=excluded.hash',
    );
    const remove = db.prepare('DELETE FROM mutable WHERE collection=? AND id=?');
    for (const { collection, id, value } of storage.dirty.values())
      if (value === undefined) remove.run(collection, id);
      else {
        const body = json(value);
        save.run(collection, id, body, digest(body));
      }
    db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(state.editRevision));
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
