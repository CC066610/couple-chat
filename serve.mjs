// serve.mjs — 只为本地开发/使用提供一个 http://127.0.0.1 源。
// 浏览器把 localhost 视为安全上下文，摄像头（扫码）和 WebCrypto 才可用。
// 生产用法：把这个目录丢到任意静态托管，或直接用 U 盘互传后各自起本服务。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 开发自测专用：把本端生成的配对码落到 app/dev/ 下，另一端从自己的服务读回去。
  // 只为了在没有文件对话框/剪贴板的长码环境里做端到端自测，正式发行版不会用到。
  if (urlPath === '/dev/publish' && req.method === 'POST') {
    const which = new URL(req.url, 'http://x').searchParams.get('k') || '';
    if (which !== 'offer' && which !== 'answer') {
      res.writeHead(400).end('k must be offer|answer');
      return;
    }
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      const dir = path.join(ROOT, 'dev');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, which + '.txt'), Buffer.concat(chunks));
      console.log('[dev] 收到并落地', which + '.txt');
      res.writeHead(204).end();
    });
    return;
  }

  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`couple-chat  →  http://${HOST}:${PORT}/`);
  console.log('（两个浏览器窗口/两台设备各开一个，扫码或用粘贴方式配对）');
});
