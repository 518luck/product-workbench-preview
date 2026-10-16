import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { renderDocument, validateDocument, writeHtml } from './document.mjs';
import { loadTemplate } from './template.mjs';
import { updateDocument } from './document-store.mjs';
import {
  savePageFeature,
  savePageAnnotation,
  changePageAnnotation,
} from './feature-operations.mjs';

class RequestError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const json = (response, status, data, method) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(method === 'HEAD' ? undefined : JSON.stringify(data));
};
const methodNotAllowed = (response, allowed) => {
  response.writeHead(405, {
    Allow: allowed.join(', '),
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end('Method not allowed');
};
const validGroup = (value) =>
  Array.isArray(value) &&
  value.length <= 5 &&
  value.every(
    (part) =>
      typeof part === 'string' && part.trim() && part.trim().length <= 40 && !/[\/／>]/.test(part),
  );
const validName = (value) => typeof value === 'string' && value.trim() && value.trim().length <= 80;

export function createDocumentServer({ documentPath, templatePath }) {
  const saveDocument = (updater) =>
    updateDocument(documentPath, updater, {
      afterCommit(document, result) {
        try {
          writeHtml(
            path.join(path.dirname(documentPath), 'index.html'),
            renderDocument(document, loadTemplate(templatePath)),
          );
        } catch (error) {
          const failure = new RequestError(
            500,
            `内容已保存，阅读快照更新失败：${error.message}。刷新服务页面可继续使用。`,
            { documentSaved: true, htmlUpdated: false },
          );
          failure.savedFeature = result;
          throw failure;
        }
      },
    });
  const readDocument = async () => {
    const document = JSON.parse(await fs.promises.readFile(documentPath, 'utf8'));
    const report = validateDocument(document);
    if (!report.valid)
      throw new RequestError(500, '项目文档校验失败，请先修正文档文件。', report.errors);
    return document;
  };
  const server = http.createServer(async (request, response) => {
    try {
      let pathname;
      try {
        if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error();
        pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      } catch {
        throw new RequestError(400, '请求地址无效。');
      }
      let host;
      try {
        host = new URL(`http://${request.headers.host}`);
      } catch {
        throw new RequestError(400, '请求主机无效。');
      }
      if (
        !['127.0.0.1', 'localhost'].includes(host.hostname) ||
        Number(host.port || 80) !== server.address()?.port ||
        host.username ||
        host.password
      )
        throw new RequestError(403, '仅允许从本机文档地址访问。');
      if (pathname === '/product-document.json') {
        if (!['GET', 'HEAD'].includes(request.method))
          return methodNotAllowed(response, ['GET', 'HEAD']);
        return json(response, 200, await readDocument(), request.method);
      }
      if (pathname === '/document/source-status') {
        if (!['GET', 'HEAD'].includes(request.method))
          return methodNotAllowed(response, ['GET', 'HEAD']);
        const { checkSourceStatus } = await import('./source-status.mjs');
        return json(response, 200, await checkSourceStatus(await readDocument()), request.method);
      }
      if (pathname === '/document/flow-status') {
        if (!['GET', 'HEAD'].includes(request.method))
          return methodNotAllowed(response, ['GET', 'HEAD']);
        const { readFlowStatus } = await import('./flow-status.mjs');
        return json(
          response,
          200,
          readFlowStatus(documentPath, await readDocument()),
          request.method,
        );
      }
      if (pathname === '/document/capabilities') {
        if (!['GET', 'HEAD'].includes(request.method))
          return methodNotAllowed(response, ['GET', 'HEAD']);
        return json(response, 200, { canSave: true, documentPath: documentPath }, request.method);
      }
      if (pathname.startsWith('/document/features/')) {
        const route = pathname.match(
          /^\/document\/features\/([^/]+)(?:\/(annotations)(?:\/([^/]+))?)?$/,
        );
        if (!route) throw new RequestError(400, '保存地址无效。');
        const annotationRoute = Boolean(route[2]),
          annotationId = route[3];
        const methods = annotationId ? ['PUT', 'DELETE'] : annotationRoute ? ['POST'] : ['PUT'];
        if (!methods.includes(request.method)) return methodNotAllowed(response, methods);
        const expectedOrigin = `http://${request.headers.host}`;
        if (
          request.headers.origin !== expectedOrigin ||
          !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')
        )
          throw new RequestError(403, '请从当前文档页面保存。');
        const id = route[1];
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new RequestError(400, '功能编号无效。');
        if (annotationId && !/^[a-z][a-z0-9-]{0,63}$/.test(annotationId))
          throw new RequestError(400, '批注编号无效。');
        let body;
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 65536) throw new RequestError(413, '说明内容过长。');
            chunks.push(chunk);
          }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          if (error instanceof RequestError) throw error;
          throw new RequestError(400, '保存内容无效。');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new RequestError(400, '保存内容无效。');
        if (annotationRoute)
          return json(
            response,
            200,
            await saveDocument(
              (annotationId
                ? (input) => changePageAnnotation(input, { remove: request.method === 'DELETE' })
                : savePageAnnotation)({
                id,
                annotationId: annotationId ?? body.annotationId,
                text: body.text,
                expectedRevision: body.expectedRevision,
                expectedEditRevision: body.expectedEditRevision,
              }),
            ),
            request.method,
          );
        if (
          typeof body.description !== 'string' ||
          !body.description.trim() ||
          body.description.length > 5000
        )
          throw new RequestError(400, '请填写 1–5000 字的功能定义。');
        if (
          !Number.isSafeInteger(body.expectedRevision) ||
          body.expectedRevision < 0 ||
          (body.expectedEditRevision !== undefined &&
            (!Number.isSafeInteger(body.expectedEditRevision) || body.expectedEditRevision < 0))
        )
          throw new RequestError(400, '保存版本无效，请刷新后重试。');
        if (body.create !== undefined && typeof body.create !== 'boolean')
          throw new RequestError(400, '新增功能标记无效。');
        if (body.create && !validName(body.context?.title))
          throw new RequestError(400, '请填写 1–80 字的功能名称。');
        if (body.title !== undefined && !validName(body.title))
          throw new RequestError(400, '请填写 1–80 字的功能名称。');
        if (body.groupPath !== undefined && !validGroup(body.groupPath))
          throw new RequestError(400, '分组最多 5 层，每层名称为 1–40 字。');
        return json(
          response,
          200,
          await saveDocument(savePageFeature({ ...body, id })),
          request.method,
        );
      }
      if (pathname === '/' || pathname === '/index.html') {
        if (!['GET', 'HEAD'].includes(request.method))
          return methodNotAllowed(response, ['GET', 'HEAD']);
        const html = renderDocument(await readDocument(), loadTemplate(templatePath));
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        return response.end(request.method === 'HEAD' ? undefined : html);
      }
      if (pathname === '/favicon.ico') {
        if (!['GET', 'HEAD'].includes(request.method))
          return methodNotAllowed(response, ['GET', 'HEAD']);
        return response.writeHead(204).end();
      }
      response
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end(request.method === 'HEAD' ? undefined : 'Not found');
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        json(
          response,
          error.status || 500,
          {
            error: error.status ? error.message : '未能处理项目文档，请检查文件后重试。',
            ...(error.savedFeature
              ? { documentSaved: true, htmlUpdated: false, feature: error.savedFeature }
              : {}),
            ...(error.details ? { details: error.details } : {}),
          },
          request.method,
        );
    }
  });
  return server;
}
