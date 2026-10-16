import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './file-lock.mjs';
export { DocumentConflictError } from './file-lock.mjs';
import { DocumentConflictError } from './file-lock.mjs';

const queues = new Map();

async function withDocumentLock(filename, updater, { afterCommit, beforeCommit } = {}) {
  return withFileLock(filename, async () => {
    const temporary = path.join(
      path.dirname(filename),
      `.${path.basename(filename)}.${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;
    try {
      const mode = (await fs.promises.stat(filename)).mode & 0o777;
      const original = await fs.promises.readFile(filename, 'utf8');
      const document = JSON.parse(original);
      const update = updater(document, { original, filename });
      if (!update || typeof update.changed !== 'boolean' || typeof update.then === 'function')
        throw new TypeError('文档更新器必须同步返回 changed 和 result。');
      if (!update.changed) {
        if (beforeCommit) beforeCommit(document, update.result);
        if (afterCommit) await afterCommit(document, update.result, { filename, changed: false });
        return update.result;
      }
      await fs.promises.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', {
        flag: 'wx',
        mode,
      });
      temporaryCreated = true;
      if (beforeCommit) {
        const result = beforeCommit(document, update.result);
        if (result && typeof result.then === 'function')
          throw new TypeError('提交前检查必须同步执行。');
      }
      // 外部 AI 直接修改文件时不会获取本工具的锁；提交前再次核对原文。
      // 同步检查和替换避免本进程在两步之间继续处理其他保存请求。
      if (fs.readFileSync(filename, 'utf8') !== original)
        throw new DocumentConflictError(
          '项目文件已被外部更新，请刷新后再保存。输入内容仍保留在页面。',
        );
      fs.renameSync(temporary, filename);
      temporaryCreated = false;
      // 派生快照在同一写锁内更新，避免较旧的提交覆盖较新的 HTML。
      if (afterCommit) await afterCommit(document, update.result, { filename, changed: true });
      return update.result;
    } finally {
      if (temporaryCreated) await fs.promises.unlink(temporary).catch(() => {});
    }
  });
}

export async function updateDocument(documentPath, updater, options) {
  const filename = await fs.promises.realpath(path.resolve(documentPath));
  const previous = queues.get(filename) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => withDocumentLock(filename, updater, options));
  queues.set(filename, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(filename) === operation) queues.delete(filename);
  }
}
