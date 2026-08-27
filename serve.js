// Zero-dependency static file server with optional live-reload.
//
//   node serve.js            -> http://localhost:5173
//   node serve.js 8080       -> custom port
//   LIVE=0 node serve.js     -> disable live-reload injection
//
// Live-reload works by watching the source tree and pushing a Server-Sent
// Event to the page, which then reloads. No websockets, no dependencies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 5173;
const LIVE = process.env.LIVE !== '0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

const clients = new Set();
const LIVE_SNIPPET = `
<script>
(() => {
  const es = new EventSource('/__livereload');
  es.onmessage = () => location.reload();
  es.onerror = () => {};
})();
</script>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/__livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let filePath = path.join(ROOT, url === '/' ? '/index.html' : url);
  // Prevent path traversal outside the project root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    let body = data;
    if (LIVE && ext === '.html') {
      body = Buffer.from(data.toString('utf8').replace('</body>', LIVE_SNIPPET + '\n</body>'));
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  });
});

if (LIVE) {
  let timer = null;
  fs.watch(path.join(ROOT, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write('data: reload\n\n');
    }, 80);
  });
  // index.html lives at the root, watch it too.
  fs.watchFile(path.join(ROOT, 'index.html'), { interval: 300 }, () => {
    for (const c of clients) c.write('data: reload\n\n');
  });
}

server.listen(PORT, () => {
  console.log(`\n  Rangeform  ->  http://localhost:${PORT}`);
  console.log(`  live-reload: ${LIVE ? 'on' : 'off'}   (LIVE=0 to disable)\n`);
});
