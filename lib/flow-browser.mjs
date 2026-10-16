import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A local reverse proxy injects only the owned probe. Browser actions are executed by the host.
export async function executeBrowser(input, cwd, config, env) {
  const token = randomUUID(),
    events = [],
    stdout = [],
    stderr = [];
  let child,
    proxy,
    finished = false,
    timedOut = false,
    outputExceeded = false,
    size = 0;
  const timeoutMs = input.timeoutMs ?? 60000;
  const program = fs
    .readFileSync(
      fileURLToPath(new URL('../assets/runtime/browser-probe.js', import.meta.url)),
      'utf8',
    )
    .replace(
      '__PRODUCT_BLUEPRINT_CONFIG__',
      JSON.stringify({ ...config, token }).replace(/</g, '\\u003c'),
    );
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    if (finished) return;
    finished = true;
    finish();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  try {
    let ready;
    const startup = new Promise((resolve) => {
      ready = resolve;
    });
    let buffer = '';
    child = spawn(input.command, input.args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const data = JSON.parse(line);
          if (typeof data.url === 'string') ready(data.url);
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1048576) {
          outputExceeded = true;
          stop();
        }
      });
    // Server-side Node observations use the same pipe; sequence spaces remain separate.
    const nodeChunks = [];
    child.stdio[3].on('data', (chunk) => nodeChunks.push(chunk));
    child.on('error', (error) => {
      stderr.push(Buffer.from(error.message));
      stop();
    });
    child.on('exit', () => stop());
    const target = await Promise.race([startup, done.then(() => null)]);
    if (target) {
      const url = new URL(target);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
        throw Error('浏览器场景的上游必须是本机 HTTP 服务。');
      proxy = http.createServer(async (request, response) => {
        try {
          if (request.headers.host !== `127.0.0.1:${proxy.address().port}`) {
            response.writeHead(403).end();
            return;
          }
          if (request.url === '/__blueprint/runtime.js') {
            response
              .writeHead(200, {
                'content-type': 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
              })
              .end(program);
            return;
          }
          if (request.url.startsWith('/__blueprint/')) {
            if (request.method !== 'POST' || request.headers['x-blueprint-run'] !== token) {
              response.writeHead(403).end();
              return;
            }
            if (request.url === '/__blueprint/finish') {
              response.writeHead(200).end('{}');
              stop();
              return;
            }
            if (request.url === '/__blueprint/events') {
              const chunks = [];
              let count = 0;
              for await (const chunk of request) {
                count += chunk.length;
                if (count > 1048576) throw Error('观测批次过大。');
                chunks.push(chunk);
              }
              const batch = JSON.parse(Buffer.concat(chunks));
              if (!Array.isArray(batch) || events.length + batch.length > 100000)
                throw Error('观测超过限制。');
              events.push(...batch);
              response.writeHead(200).end('{}');
              return;
            }
            response.writeHead(404).end();
            return;
          }
          const headers = { ...request.headers, host: url.host };
          if (headers.origin) headers.origin = url.origin;
          delete headers['accept-encoding'];
          const upstream = http.request(
            new URL(request.url, url.origin),
            { method: request.method, headers },
            (incoming) => {
              const chunks = [];
              let bytes = 0;
              incoming.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > 16 * 1048576) incoming.destroy();
                else chunks.push(chunk);
              });
              incoming.on('end', () => {
                const headers = { ...incoming.headers };
                delete headers['content-length'];
                delete headers['content-encoding'];
                delete headers['content-security-policy'];
                let body = Buffer.concat(chunks);
                if (/text\/html/.test(headers['content-type'] || ''))
                  body = Buffer.from(
                    '<script charset="utf-8" src="/__blueprint/runtime.js"></script>' +
                      body.toString('utf8'),
                  );
                response.writeHead(incoming.statusCode, headers).end(body);
              });
            },
          );
          upstream.on('error', () => response.writeHead(502).end());
          request.pipe(upstream);
        } catch (error) {
          if (!response.headersSent) response.writeHead(400).end(error.message);
        }
      });
      await new Promise((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(0, '127.0.0.1', resolve);
      });
      process.stdout.write(
        JSON.stringify({
          browserReady: true,
          url: `http://127.0.0.1:${proxy.address().port}/`,
          runId: config.runId,
          message:
            '使用宿主浏览器执行声明场景，结束时调用页面 Symbol.for("product-blueprint.browser-finish") 对应函数。',
        }) + '\n',
      );
      await done;
    }
    const observed = events.sort((a, b) => a.seq - b.seq);
    // Cross-process/browser joins are intentionally unproven until an explicit transport adapter exists.
    return {
      exitCode: timedOut || outputExceeded ? null : target ? 0 : 1,
      signal: null,
      timedOut,
      outputExceeded,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      events: Buffer.from(observed.map((event) => JSON.stringify(event)).join('\n')),
      browser: true,
    };
  } finally {
    clearTimeout(timer);
    if (proxy) {
      proxy.closeAllConnections();
      proxy.close();
    }
    if (child?.pid)
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
  }
}
