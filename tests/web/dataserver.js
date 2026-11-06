// A test server for the data-download tests (brief 03): serves build-wasm/ plus routes whose behaviour the
// test controls (compression, ETag, CORS, errors, cut-off connections, a different body). Binds to
// 127.0.0.1 only. Every request is recorded in `server.requests` so a test can count what reached the server.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

// opts: body (Buffer), gzip ('stream': compressed on the fly, chunked; 'pre': compressed in advance with a
// Content-Length of the compressed size), etag, lastModified, cors (add Access-Control-Allow-Origin),
// status (answer with this status and no data), chunk (bytes per write), delayMs (pause between writes),
// cutAt (announce the whole length, send this many bytes, then drop the connection),
// cacheControl.
function route(opts) {
  let pre = null;
  return function (req, res, server) {
    const h = {};
    if (opts.cors) {
      h['Access-Control-Allow-Origin'] = '*';
      h['Access-Control-Allow-Headers'] = 'If-None-Match, If-Modified-Since';
      h['Access-Control-Expose-Headers'] = 'ETag, Last-Modified, Content-Length, Content-Encoding';
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, h); res.end(); return; }
    if (opts.status) { res.writeHead(opts.status, h); res.end(opts.statusText || 'error'); return; }
    const etag = typeof opts.etag === 'function' ? opts.etag() : opts.etag;
    if (etag) { h['ETag'] = etag; }
    if (opts.lastModified) { h['Last-Modified'] = opts.lastModified; }
    h['Content-Type'] = 'application/octet-stream';
    h['Cache-Control'] = opts.cacheControl || 'no-store';
    if (etag && req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); req.jfswStatus = 304; return; }
    let body = opts.body;
    if (opts.gzip === 'pre') { pre = pre || zlib.gzipSync(body, { level: 6 }); body = pre; h['Content-Encoding'] = 'gzip'; }
    if (opts.gzip === 'stream') { h['Content-Encoding'] = 'gzip'; }
    else { h['Content-Length'] = body.length; }
    res.writeHead(200, h);
    const chunk = opts.chunk || 1 << 20;
    if (opts.gzip === 'stream') {
      const gz = zlib.createGzip({ level: 1 });
      gz.pipe(res);
      let at = 0;
      const next = () => { if (at >= body.length) { gz.end(); return; } gz.write(body.subarray(at, at += chunk)); setTimeout(next, opts.delayMs || 0); };
      next();
      return;
    }
    const limit = opts.cutAt === undefined ? body.length : opts.cutAt;
    let at = 0;
    const next = () => {
      if (at >= limit) { if (opts.cutAt !== undefined) { setTimeout(() => res.destroy(), 20); } else { res.end(); } return; }
      res.write(body.subarray(at, Math.min(limit, at += chunk)));
      if (opts.delayMs) { setTimeout(next, opts.delayMs); } else { setImmediate(next); }
    };
    next();
  };
}

// root: directory served for paths with no route. routes: { '/path': handler(req, res, server) }.
function serve(root, routes, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const rec = { path: url, method: req.method, headers: req.headers, status: 0 };
    server.requests.push(rec);
    res.on('finish', () => { rec.status = rec.status || res.statusCode; });
    const handler = server.routes[url];
    if (handler) { handler(req, res, server); return; }
    const rel = path.normalize(url === '/' ? '/index.html' : url);
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  server.routes = routes || {};
  server.requests = [];
  server.hits = (p) => server.requests.filter((r) => r.path === p).length;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
module.exports = { serve, route };
