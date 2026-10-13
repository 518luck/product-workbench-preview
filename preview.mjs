import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocumentServer } from './lib/document-server.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 62039);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('预览端口应为 0–65535 的整数。');
  process.exit(1);
}
const server = createDocumentServer({
  documentPath: path.join(directory, 'product-document.json'),
  templatePath: path.join(directory, 'assets/template.html'),
});
server.on('error', (error) => {
  console.error(`无法启动预览：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Local: http://127.0.0.1:${server.address().port}`);
});
