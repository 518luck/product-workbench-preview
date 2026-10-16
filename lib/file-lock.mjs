import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

export class DocumentConflictError extends Error {
  constructor(message = '文档正在被更新，请稍后重试。输入内容仍保留在页面。') {
    super(message);
    this.name = 'DocumentConflictError';
    this.status = 409;
  }
}

function deadOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      (owner.hostname && owner.hostname !== os.hostname())
    )
      return false;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return error.code === 'ESRCH';
    }
  } catch {
    /* Unknown/old malformed locks are never reclaimed by age alone. */
  }
  return false;
}

// SQLite's OS lock serializes reclaimers and is released on process death. The
// legacy lock file also excludes older CLI versions that do not use this gate.
export async function withFileLock(filename, operation, { retryMs = 0 } = {}) {
  const directory = path.join(
    os.tmpdir(),
    `product-blueprint-locks-${process.getuid?.() ?? 'user'}`,
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(filename).digest('hex');
  const deadline = Date.now() + retryMs;
  let database;
  for (;;) {
    try {
      database = new DatabaseSync(path.join(directory, key + '.sqlite'));
      database.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      database?.close();
      database = undefined;
      if (![5, 6].includes(error.errcode)) throw error;
      if (Date.now() >= deadline) throw new DocumentConflictError();
      await delay(15 + Math.floor(Math.random() * 25));
    }
  }
  const lockPath = filename + '.write-lock';
  const prepared = path.join(path.dirname(filename), '.lock-' + randomUUID() + '.tmp');
  let acquired = false,
    inode;
  try {
    if (fs.existsSync(lockPath) && deadOwner(lockPath)) fs.unlinkSync(lockPath);
    fs.writeFileSync(
      prepared,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    try {
      fs.linkSync(prepared, lockPath);
    } catch (error) {
      if (error.code === 'EEXIST') throw new DocumentConflictError();
      throw error;
    }
    acquired = true;
    inode = fs.statSync(lockPath).ino;
    return await operation();
  } finally {
    try {
      if (acquired && fs.existsSync(lockPath) && fs.statSync(lockPath).ino === inode)
        fs.unlinkSync(lockPath);
    } finally {
      try {
        fs.rmSync(prepared, { force: true });
      } finally {
        try {
          database.exec('ROLLBACK');
        } finally {
          database.close();
        }
      }
    }
  }
}
