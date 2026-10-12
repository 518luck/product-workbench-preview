import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const documentPath = path.join(path.dirname(root), 'product-document.json');
let writeQueue = Promise.resolve();
const json = (response, status, data) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
};
const readDocument = async () => JSON.parse(await fs.promises.readFile(documentPath, 'utf8'));
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/product-document.json' && request.method === 'GET') {
    try { json(response, 200, await readDocument()); }
    catch { json(response, 500, { error: '无法读取项目文档。' }); }
  } else if (pathname.startsWith('/document/features/') && request.method === 'PUT') {
    const expectedOrigin = `http://${request.headers.host}`;
    if (request.headers.origin !== expectedOrigin || !request.headers['content-type']?.startsWith('application/json')) {
      json(response, 403, { error: '请从当前文档页面保存。' });
      return;
    }
    const id = pathname.slice('/document/features/'.length);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) { json(response, 400, { error: '功能编号无效。' }); return; }
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) { json(response, 413, { error: '说明内容过长。' }); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { json(response, 400, { error: '保存内容无效。' }); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      json(response, 400, { error: '保存内容无效。' }); return;
    }
    if (typeof body.description !== 'string' || !body.description.trim() || body.description.length > 5000 || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      json(response, 400, { error: '请填写 1–5000 字的功能定义。' }); return;
    }
    if (body.create && (typeof body.context?.title !== 'string' || !body.context.title.trim() || body.context.title.trim().length > 80)) {
      json(response, 400, { error: '请填写 1–80 字的功能名称。' }); return;
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 80)) {
      json(response, 400, { error: '请填写 1–80 字的功能名称。' }); return;
    }
    if (body.groupPath !== undefined && (!Array.isArray(body.groupPath) || body.groupPath.length > 5 || body.groupPath.some(part => typeof part !== 'string' || !part.trim() || part.trim().length > 40 || /[\/／>]/.test(part)))) {
      json(response, 400, { error: '分组最多 5 层，每层名称为 1–40 字。' }); return;
    }
    const operation = writeQueue.then(async () => {
      const doc = await readDocument();
      const previous = doc.features[id];
      const revision = previous?.revision ?? 0;
      const title = body.title?.trim() ?? previous?.title ?? body.context?.title?.trim();
      const groupPath = body.groupPath?.map(part => part.trim()) ?? previous?.groupPath ?? [];
      if (body.create && previous) {
        if (previous.isNew && revision === 1 && previous.title === body.context.title.trim() && previous.description === body.description.trim() && JSON.stringify(previous.groupPath || []) === JSON.stringify(groupPath)) {
          json(response, 200, previous);
        } else {
          json(response, 409, { error: '这个功能已存在，请刷新查看。' });
        }
        return;
      }
      if (revision !== body.expectedRevision) { json(response, 409, { error: '文档已更新，请刷新后再保存。输入内容仍保留在页面。' }); return; }
      const description = body.description.trim();
      if (!previous && (!body.context || typeof body.context.title !== 'string')) {
        json(response, 400, { error: '缺少功能名称。' }); return;
      }
      const definitionChanged = previous?.description !== description;
      const groupChanged = JSON.stringify(previous?.groupPath || []) !== JSON.stringify(groupPath);
      const titleChanged = previous?.title !== title;
      if (definitionChanged || groupChanged || titleChanged) {
        doc.features[id] = {
          ...(previous || { ...body.context, id, flowRevision: body.context.description?.trim() === description ? revision + 1 : 0, implementedRevision: null }),
          title, description, groupPath, revision: revision + (definitionChanged ? 1 : 0), updatedAt: new Date().toISOString(),
          ...(!previous && body.create ? { title: body.context.title.trim(), isNew: true, flowRevision: 0 } : {}),
        };
        const tempPath = `${documentPath}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(doc, null, 2) + '\n');
        await fs.promises.rename(tempPath, documentPath);
      }
      json(response, 200, doc.features[id]);
    });
    writeQueue = operation.catch(() => {});
    try { await operation; }
    catch { if (!response.headersSent) json(response, 500, { error: '未能写入项目文档，请重试。' }); }
  } else if (pathname === '/' || pathname === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(path.join(root, 'index.html')).pipe(response);
  } else if (pathname === '/favicon.ico') {
    response.writeHead(204).end();
  } else {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});
server.listen(Number(process.env.PORT || 62039), '127.0.0.1', () => {
  console.log(`Local: http://127.0.0.1:${server.address().port}`);
});
