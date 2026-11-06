// Game data for the browser build (brief 03): download, check, cache, pick a local copy.
// No page code here: jfsw.js shows the progress and the messages and writes the file for the game.
//
//   JfswData.load(options) -> Promise of the data (see load() below); rejects with a DataError whose
//   `kind` is http, network, truncated, size, corrupt, unknown or unsupported.
//   JfswData.crc32(bytes), JfswData.identify(crc, size), JfswData.forgetAll().
//
// The cache is an IndexedDB database of its own, "jfsw-data" (not the game's /persist folder, which is
// IDBFS). Store "files": one record per source, key "url:<absolute url>" for the download and "local"
// for the file the person picked. Store "meta": { key: 'source', value: 'url' | 'local' }.
(function () {
  'use strict';

  var GRPS = window.JFSW_GRPS || [];
  var DB_NAME = 'jfsw-data';
  var SCHEMA = 1;
  var LOCAL_KEY = 'local';

  // ---- Errors ------------------------------------------------------------------------------------------

  function DataError(kind, message, extra) {
    var e = new Error(message);
    e.name = 'DataError';
    e.kind = kind;
    if (extra) { Object.keys(extra).forEach(function (k) { e[k] = extra[k]; }); }
    return e;
  }

  // ---- CRC-32 (the one grpscan.c computes: IEEE, reflected, 0xEDB88320) ----------------------------------

  var T = new Int32Array(1024);   // slice-by-4 tables
  (function () {
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) { c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1); }
      T[n] = c;
    }
    for (var m = 0; m < 256; m++) {
      var v = T[m];
      for (var s = 1; s < 4; s++) { v = T[v & 255] ^ (v >>> 8); T[s * 256 + m] = v; }
    }
  })();
  // `state` is the running value (start at -1); returns the new one. digest = (state ^ -1) >>> 0.
  function crcUpdate(state, b, from, to) {
    var c = state, i = from || 0, end = to === undefined ? b.length : to;
    for (; i + 4 <= end; i += 4) {
      c ^= b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
      c = T[768 + (c & 255)] ^ T[512 + ((c >>> 8) & 255)] ^ T[256 + ((c >>> 16) & 255)] ^ T[c >>> 24];
    }
    for (; i < end; i++) { c = T[(c ^ b[i]) & 255] ^ (c >>> 8); }
    return c;
  }
  function crc32(bytes) { return (crcUpdate(-1, bytes) ^ -1) >>> 0; }
  function hex(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  // ---- What the game knows -------------------------------------------------------------------------------

  function identify(crc, size) {
    for (var i = 0; i < GRPS.length; i++) {
      if (parseInt(GRPS[i].crc, 16) === (crc >>> 0) && GRPS[i].size === size) { return GRPS[i]; }
    }
    return null;
  }
  function playable(g) { return !!g && (g.game === 'REG' || g.game === 'SHARE') && !g.addon; }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  function startsLikeGrp(b) {
    var s = 'KenSilverman';
    if (b.length < s.length) { return false; }
    for (var i = 0; i < s.length; i++) { if (b[i] !== s.charCodeAt(i)) { return false; } }
    return true;
  }

  // Throws a DataError unless the bytes are a GRP the game can start with; returns its table entry.
  function verify(bytes, crc, what, declared) {
    var size = bytes.length;
    var found = ' (' + size.toLocaleString('en-US') + ' bytes, CRC32 ' + hex(crc) + ')';
    var g = identify(crc, size);
    if (declared && declared.crc32 && hex(crc) !== declared.crc32.toLowerCase()) {
      throw DataError('corrupt', what + ' is damaged or is not the file this page expects: its checksum is wrong' + found +
        ', the page expects CRC32 ' + declared.crc32.toLowerCase() + '.', { size: size, crc: crc });
    }
    if (g && !playable(g)) {
      throw DataError('unsupported', what + ' is "' + g.name + '", which cannot be started on its own yet. Use the shareware or the registered game data.' + found, { size: size, crc: crc });
    }
    if (g) { return g; }
    var sameSize = GRPS.filter(function (x) { return x.size === size && playable(x); })[0];
    if (sameSize) {
      throw DataError('corrupt', what + ' is the size of "' + sameSize.name + '" but its checksum is wrong' + found + ': the file is damaged.', { size: size, crc: crc });
    }
    var longer = GRPS.filter(function (x) { return x.size > size && playable(x); })[0];
    if (startsLikeGrp(bytes) && longer) {
      throw DataError('truncated', what + ' starts like a GRP but is too short' + found + ': it looks cut off.', { size: size, crc: crc });
    }
    throw DataError('unknown', what + ' is not a Shadow Warrior data file the game knows' + found + '.', { size: size, crc: crc });
  }

  // ---- IndexedDB cache -----------------------------------------------------------------------------------

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        if (!window.indexedDB) { throw new Error('IndexedDB is not available'); }
        req = window.indexedDB.open(DB_NAME, 1);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        db.createObjectStore('files', { keyPath: 'key' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('could not open the database')); };
      req.onblocked = function () { reject(new Error('the database is blocked by another tab')); };
    });
  }
  // Runs fn(objectStore) in a transaction; resolves with its request's result when the transaction has committed.
  function run(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx, req, result;
      try {
        tx = db.transaction(store, mode);
        req = fn(tx.objectStore(store));
        if (req) { req.onsuccess = function () { result = req.result; }; }
      } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error || (req && req.error) || new Error('database error')); };
      tx.onabort = function () { reject(tx.error || new Error('database transaction aborted')); };
    });
  }
  function Cache(db, hooks) { this.db = db; this.hooks = hooks || {}; }
  Cache.prototype.get = function (key) { return run(this.db, 'files', 'readonly', function (s) { return s.get(key); }); };
  Cache.prototype.keys = function () { return run(this.db, 'files', 'readonly', function (s) { return s.getAllKeys(); }); };
  Cache.prototype.del = function (key) { return run(this.db, 'files', 'readwrite', function (s) { return s.delete(key); }); };
  Cache.prototype.put = function (rec) {
    var hooks = this.hooks;
    return run(this.db, 'files', 'readwrite', function (s) {
      // Test hook (?test=1&idb=quota): fail the way a full disk does (put() throws or the transaction aborts
      // with a QuotaExceededError; both end in run()'s reject).
      if (hooks.quota) { throw new DOMException('simulated: the browser has no space left for this site', 'QuotaExceededError'); }
      return s.put(rec);
    });
  };
  Cache.prototype.getMeta = function (key) {
    return run(this.db, 'meta', 'readonly', function (s) { return s.get(key); }).then(function (r) { return r ? r.value : null; });
  };
  Cache.prototype.setMeta = function (key, value) { return run(this.db, 'meta', 'readwrite', function (s) { return s.put({ key: key, value: value }); }); };

  function forgetAll() {
    return new Promise(function (resolve) {
      try { var r = window.indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = function () { resolve(); }; } catch (e) { resolve(); }
    });
  }

  function storeProblem(e) {
    var quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    return quota ? 'The browser has no space left to keep the game data' : 'The browser would not keep the game data (' + ((e && e.message) || e) + ')';
  }

  // ---- Download ------------------------------------------------------------------------------------------

  // Fetches `url`. Returns { bytes, crc, etag, lastModified, notModified, crcMs }.
  // o: size (declared, or 0), headers, onProgress(got, total) with total 0 when unknown or not trustworthy.
  function download(url, o) {
    var absolute = new URL(url, location.href);
    var crossOrigin = absolute.origin !== location.origin;
    return fetch(absolute.href, { headers: o.headers || {}, cache: 'no-store' }).then(function (resp) {
      if (resp.status === 304 && o.headers) { return { notModified: true }; }
      if (!resp.ok) {
        throw DataError('http', 'The game data could not be downloaded: ' + absolute.href + ' answered ' + resp.status + (resp.statusText ? ' ' + resp.statusText : '') + '.', { status: resp.status });
      }
      var declared = o.size || 0;
      var length = +resp.headers.get('content-length') || 0;
      var encoded = !!resp.headers.get('content-encoding');
      // The bytes the page sees are decompressed; Content-Length is the compressed size. Trust it for the
      // progress bar only when the response is not encoded; otherwise the declared size, or no total.
      var total = declared || (encoded ? 0 : length);
      var expect = declared || (encoded ? 0 : length);
      var reader = resp.body && resp.body.getReader && resp.body.getReader();
      var meta = { etag: resp.headers.get('etag') || '', lastModified: resp.headers.get('last-modified') || '' };
      if (!reader) {
        return resp.arrayBuffer().then(function (ab) {
          var b = new Uint8Array(ab);
          return done(b, crc32(b), 0);
        });
      }
      var buf = declared ? new Uint8Array(declared) : null;
      var chunks = [];
      var got = 0, state = -1, crcMs = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { return; }
          var c = r.value;
          if (declared && got + c.length > declared) {
            reader.cancel().catch(function () {});
            throw DataError('size', 'The game data from ' + absolute.href + ' is larger than the ' + declared.toLocaleString('en-US') + ' bytes this page expects (at least ' + (got + c.length).toLocaleString('en-US') + ' bytes arrived). It is not the file the page is set up for.', { size: got + c.length });
          }
          var t0 = performance.now();
          state = crcUpdate(state, c);
          crcMs += performance.now() - t0;
          if (buf) { buf.set(c, got); } else { chunks.push(c); }
          got += c.length;
          if (o.onProgress) { o.onProgress(got, total && got <= total ? total : 0); }
          return pump();
        });
      }
      return pump().catch(function (e) {
        if (e && e.name === 'DataError') { throw e; }
        throw DataError('truncated', 'The download from ' + absolute.href + ' was cut off after ' + got.toLocaleString('en-US') + ' bytes' + (expect ? ' of ' + expect.toLocaleString('en-US') : '') + ' (' + ((e && e.message) || e) + ').', { received: got });
      }).then(function () {
        if (expect && got < expect) {
          throw DataError('truncated', 'The download from ' + absolute.href + ' is incomplete: ' + got.toLocaleString('en-US') + ' of ' + expect.toLocaleString('en-US') + ' bytes arrived.', { received: got });
        }
        if (declared && got > declared) { throw DataError('size', 'Too many bytes.'); }
        var bytes = buf;
        if (!bytes) {
          bytes = new Uint8Array(got);
          var at = 0;
          chunks.forEach(function (c) { bytes.set(c, at); at += c.length; });
        }
        return done(bytes, (state ^ -1) >>> 0, crcMs);
      });
      function done(bytes, crc, crcMs2) {
        return { bytes: bytes, crc: crc, etag: meta.etag, lastModified: meta.lastModified, crcMs: crcMs2 };
      }
    }, function (e) {
      var hint = crossOrigin
        ? ' The page is on ' + location.origin + ' and the data is on ' + absolute.origin + ': that server must send an Access-Control-Allow-Origin header (CORS), or the data must be served from the same origin as the page.'
        : '';
      throw DataError('network', 'The game data could not be downloaded from ' + absolute.href + '. The server may be down or unreachable' + (crossOrigin ? ', or it does not allow this page to read it (a browser reports a blocked cross-origin request the same way as a network failure).' : '.') + hint, { crossOrigin: crossOrigin });
    });
  }

  // ---- The whole job -------------------------------------------------------------------------------------

  function sig(o) { return [SCHEMA, o.size || 0, (o.crc32 || '').toLowerCase()].join('|'); }

  function usable(rec, o, key) {
    if (!rec || rec.schema !== SCHEMA || rec.key !== key || rec.config !== sig(o)) { return false; }
    if (!rec.bytes || rec.bytes.byteLength !== rec.size) { return false; }
    if (o.size && rec.size !== o.size) { return false; }
    var g = identify(rec.crc, rec.size);
    return playable(g);
  }

  function ask() {
    // Ask the browser not to evict the data under storage pressure. Chrome decides by itself (no prompt: granted
    // for installed or often visited sites); Firefox asks the person. The answer is informational.
    try {
      if (navigator.storage && navigator.storage.persist) {
        return navigator.storage.persisted().then(function (already) { return already || navigator.storage.persist(); }).then(function (granted) {
          window.jfswPersistent = granted;
          return granted;
        }).catch(function () { return false; });
      }
    } catch (e) { /* not available */ }
    return Promise.resolve(false);
  }

  // load(o):
  //   url, size, crc32     what to fetch and what is expected (size and crc32 may be 0 / '')
  //   revalidate           ask the server whether a cached download is still current
  //   force                ignore the cached download and fetch again
  //   file                 a File the person picked: use that instead of the url
  //   useDownload          switch back from the picked file to the download
  //   hooks                test hooks { quota: true }
  //   onProgress(got, total), onStatus(text)
  // Resolves { bytes, source: 'download'|'local', from: 'cache'|'network'|'revalidated', notes: [text], name, game, size,
  //            crc, storedAt, url, fileName, cached, crcMs, downloadMs, persistent }.
  function load(o) {
    var notes = [];
    var cache = null;
    var key = 'url:' + new URL(o.url, location.href).href;
    var absolute = new URL(o.url, location.href).href;
    var status = o.onStatus || function () {};

    function store(rec) {
      if (!cache) { return Promise.resolve(false); }
      return cache.put(rec).then(function () { return cache.setMeta('source', rec.key === LOCAL_KEY ? 'local' : 'url'); }).then(function () {
        ask().then(function () {});
        return true;
      }, function (e) {
        notes.push(storeProblem(e) + '. The game will start, but the data will be downloaded again next time.');
        return false;
      });
    }

    function newRecord(k, bytes, crc, extra) {
      return Object.assign({ key: k, schema: SCHEMA, config: sig(o), size: bytes.length, crc: crc, bytes: bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer, storedAt: Date.now() }, extra);
    }
    function result(rec, from, extra) {
      var g = identify(rec.crc, rec.size);
      return Object.assign({
        bytes: new Uint8Array(rec.bytes), source: rec.key === LOCAL_KEY ? 'local' : 'download', from: from, notes: notes, name: g.name, game: g.game,
        size: rec.size, crc: rec.crc, storedAt: rec.storedAt, url: rec.url || '', fileName: rec.fileName || '', cached: from !== 'network' && from !== 'picked'
      }, extra);
    }

    var opened = openDb().then(function (db) { cache = new Cache(db, o.hooks); }, function (e) {
      notes.push('This browser would not let the page keep the game data (' + ((e && e.message) || e) + '), so it is downloaded each time.');
    });

    return opened.then(function () {
      // Picked file.
      if (o.file) {
        status('Reading ' + o.file.name + '...');
        return o.file.arrayBuffer().then(function (ab) {
          var bytes = new Uint8Array(ab);
          var t0 = performance.now();
          var crc = crc32(bytes);
          var crcMs = performance.now() - t0;
          verify(bytes, crc, 'The file "' + o.file.name + '"');
          var rec = newRecord(LOCAL_KEY, bytes, crc, { fileName: o.file.name });
          return store(rec).then(function (stored) { return result(rec, 'picked', { cached: stored, crcMs: crcMs }); });
        });
      }
      // Remove copies of urls that are no longer configured; the picked file is kept.
      var purge = cache ? cache.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== key && k !== LOCAL_KEY; }).map(function (k) { return cache.del(k); }));
      }).catch(function () {}) : Promise.resolve();
      return purge.then(function () {
        if (!cache) { return null; }
        if (o.useDownload) { return cache.del(LOCAL_KEY).then(function () { return cache.setMeta('source', 'url'); }).then(function () { return null; }, function () { return null; }); }
        return cache.getMeta('source');
      }).then(function (source) {
        if (source === 'local' && !o.force) {
          return cache.get(LOCAL_KEY).then(function (rec) {
            if (rec && rec.bytes && rec.bytes.byteLength === rec.size && playable(identify(rec.crc, rec.size))) { return result(rec, 'cache'); }
            return null;
          }, function () { return null; });
        }
        return null;
      }).then(function (local) {
        if (local) { return local; }
        var cached = cache && !o.force ? cache.get(key).catch(function () { return null; }) : Promise.resolve(null);
        return cached.then(function (rec) {
          var good = usable(rec, o, key);
          var headers = null;
          if (good && o.revalidate && (rec.etag || rec.lastModified)) {
            headers = {};
            if (rec.etag) { headers['If-None-Match'] = rec.etag; }
            if (rec.lastModified) { headers['If-Modified-Since'] = rec.lastModified; }
          } else if (good) {
            return result(rec, 'cache');
          }
          status('Downloading the game data...');
          var t0 = performance.now();
          return download(o.url, { size: o.size, headers: headers, onProgress: o.onProgress }).then(function (d) {
            if (d.notModified) { return result(rec, 'revalidated'); }
            var crc = d.crc;
            verify(d.bytes, crc, 'The file from ' + absolute, { crc32: o.crc32 });
            var downloadMs = performance.now() - t0;
            var fresh = newRecord(key, d.bytes, crc, { url: absolute, etag: d.etag, lastModified: d.lastModified });
            return store(fresh).then(function (stored) {
              return result(fresh, 'network', { cached: stored, crcMs: d.crcMs, downloadMs: downloadMs });
            });
          }, function (e) {
            // Could not ask the server, but a copy that was good is in the browser: use it.
            if (headers && e && (e.kind === 'network')) { notes.push('The server could not be reached to check for a newer version; using the copy kept in this browser.'); return result(rec, 'cache'); }
            throw e;
          });
        });
      });
    });
  }

  window.JfswData = { load: load, crc32: crc32, identify: identify, forgetAll: forgetAll, hex: hex, mb: mb, DB_NAME: DB_NAME };
})();
