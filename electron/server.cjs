/*
  Server statico locale per l'app impacchettata in Electron. Servire la build
  via http://127.0.0.1 (invece di file://) mantiene il `base` "/" identico a
  web/Android e fa funzionare `fetch()` degli asset (dizionari, WASM) senza le
  restrizioni del protocollo file://. Il file letto passa da `fs`, che Electron
  sa leggere anche dentro l'archivio asar.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.words': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

/**
 * Avvia un server statico su una porta libera di loopback.
 * @param {string} rootDir cartella da servire (la dist buildata)
 * @returns {Promise<{url:string, port:number, close:()=>void}>}
 */
function startServer(rootDir) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    // Normalizza e blocca il path traversal fuori da rootDir.
    const filePath = path.normalize(path.join(rootDir, urlPath));
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        // Fallback SPA: qualunque percorso ignoto torna index.html.
        return fs.readFile(path.join(rootDir, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404);
            return res.end('not found');
          }
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(html);
        });
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      });
      res.end(data);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, port, close: () => server.close() });
    });
  });
}

module.exports = { startServer };
