// A tiny static file server for the browser tests. Serves build-wasm/ and maps
// /swshare.grp to testdata/swshare.grp; other files from extra mounts
// ({"/name": "/path/to/file"}). Binds to 127.0.0.1 only.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.grp': 'application/octet-stream', '.dmo': 'application/octet-stream', '.dms': 'application/octet-stream' };

function serve(root, mounts, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = mounts[url];
    if (!file) {
      const rel = path.normalize(url === '/' ? '/index.html' : url);
      file = path.join(root, rel);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
module.exports = { serve };
