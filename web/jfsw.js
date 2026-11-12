// Page glue for the browser build of JFShadowWarrior (brief 02).
//
// Runs before sw.js: it defines Module (Emscripten's configuration object), then
// drives the start-up: mount the persistent folder, put the game data in place,
// wait for the "Click to start" click (browsers only allow sound after one), run
// main, and say so on the page if the game ends or crashes.
//
// Query string:
//   ?data=<url>   fetch the GRP from this URL instead of the one in config.js (size and CRC32 of config.js
//                 are then not checked; the file must still be a GRP the game knows).
//   ?test=1       test hooks (below). Nothing else here reads the other options.
//   ?args=...     game arguments, space separated (test only), e.g. "-level1 -dpdemo1".
//   ?files=a,b    URLs of files to put in the game's directory before main (test only).
//   ?persist=0    keep the game's directory in memory only (test only).
//   ?idb=off      every IndexedDB open fails, as in an old private window (test only).
//   ?idb=quota    storing the game data in the cache fails with a QuotaExceededError (test only).
//   ?stall=<ms>   how long without a byte before a download is called stalled (default 30000; test only).
//   ?revalidate=1|0  overrides config.js's `revalidate` (test only).
//   ?wake_every=N   only every Nth vnet wake-up reaches the game (brief 04; test only: imitates a quiet peer).
//   ?relay_wt=<url>, ?relay_cert=<hex>, ?impair=<spec>   relay test knobs for network games (brief 04; test only): an explicit
//                 WebTransport URL, the SHA-256 of a relay development certificate (-dev-cert), and a vnet impairment spec
//                 ("lat=40,jit=10,loss=5,dup=2,reorder=3,seed=7"; every machine its own seed). They go to the game in
//                 Module.jfswKnobs and are read from the address only on a ?test=1 page: a crafted link must not route a
//                 visitor through another relay or degrade their connection. window.jfswKnobs shows what was handed over.
//
// The game data (brief 03): data.js downloads and checks the GRP, keeps it in its own IndexedDB cache and
// hands the bytes here; this file writes them to /data/sw.grp with a stable modification time (so the game's
// own grpfiles.cache, kept in /persist, recognises the file and the game does not checksum it again) and
// shows the progress, the messages and the "use your own copy" picker.
//
// Test hooks, with ?test=1: window.jfswTest = { FS, readFile(name), writeFile(name, bytes),
// listFiles(), start(), passUnlockedMouse (set it true to let mouse motion reach the game while the pointer
// is not locked, as before the fix; for the smoke test's sabotage run) }; Module.jfswFrameLog (see sdlayer2.c) is an array of frame times;
// window.jfswOut holds every line the game printed; window.jfswExit is set when it ends.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TEST = params.get('test') === '1';
  var PERSIST = !(TEST && params.get('persist') === '0');
  if (TEST && params.get('idb') === 'off') {
    // Test hook: what an old Firefox private window did: opening a database fails (for the game's IDBFS and the data cache).
    var failing = function () {
      var req = {};
      setTimeout(function () {
        req.error = new DOMException('simulated: IndexedDB is not available', 'InvalidStateError');
        if (req.onerror) { req.onerror({ target: req, type: 'error', preventDefault: function () {}, stopPropagation: function () {} }); }
      }, 0);
      return req;
    };
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: failing, deleteDatabase: failing, cmp: function () { return 0; } } });
  }
  var storageNote = '';
  var CFG = (window.JFSW_CONFIG && window.JFSW_CONFIG.data) || {};
  var DATA_OVERRIDE = params.get('data');
  var DATA_DIR = '/data';        // on the game's search path (DATADIR in the Makefile); not persisted
  var HOME_DIR = '/persist';     // the game's current directory: sw.cfg, saves, sw.log; IndexedDB
  var GRP_NAME = 'sw.grp';
  var CLOSE_DELAY_MS = 10;       // after a file written by the game is closed, wait this long, then write to IndexedDB

  var canvas = document.getElementById('canvas');
  var overlay = document.getElementById('overlay');
  var statusEl = document.getElementById('status');
  var progressEl = document.getElementById('progress');
  var startBtn = document.getElementById('start');
  var reloadBtn = document.getElementById('reload');
  var retryBtn = document.getElementById('retry');
  var dataInfoEl = document.getElementById('datainfo');
  var dataCtl = document.getElementById('datactl');
  var pickInput = document.getElementById('pick');
  var redownloadBtn = document.getElementById('redownload');
  var useDownloadBtn = document.getElementById('usedownload');
  var helpEl = document.getElementById('help');
  var testInfoEl = document.getElementById('testinfo');

  var running = false;
  var ended = false;
  var FS = null;
  var lastMessage = '';

  window.jfswOut = [];
  window.jfswErr = [];
  window.jfswState = 'loading';   // loading, needdata (no usable game data: pick a file or retry), ready, running, ended, error
  window.jfswSyncs = 0;           // completed writes to IndexedDB

  function setState(s) { window.jfswState = s; }

  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
  }

  // Something went wrong or the game is over: say so on the page, over the last picture.
  function finish(message, isError) {
    if (ended) { return; }
    ended = true;
    running = false;
    setState(isError ? 'error' : 'ended');
    overlay.hidden = false;
    progressEl.hidden = true;
    startBtn.hidden = true;
    retryBtn.hidden = true;
    dataCtl.hidden = true;
    reloadBtn.hidden = false;
    showStatus(message, isError);
    reloadBtn.focus();
  }
  reloadBtn.addEventListener('click', function () { location.reload(); });

  function describe(e) {
    return (e && (e.message || e.reason && (e.reason.message || e.reason))) || String(e);
  }

  // An array that keeps at most `max` of the newest entries (the game pushes about 60 a second).
  function capped(arr, max) {
    arr.push = function (v) { Array.prototype.push.call(this, v); if (this.length > max) { this.splice(0, this.length - max / 2); } return this.length; };
    return arr;
  }

  var Module = {
    canvas: canvas,
    noInitialRun: true,
    print: function (text) {
      console.log(text);
      if (window.jfswOut.length < 20000) { window.jfswOut.push(text); }
    },
    printErr: function (text) {
      console.warn(text);
      if (window.jfswErr.length < 20000) { window.jfswErr.push(text); }
    },
    setStatus: function (text) {
      var m = /\((\d+)\/(\d+)\)/.exec(text || '');
      if (m && +m[2] > 0) { progressEl.hidden = false; progressEl.value = 100 * +m[1] / +m[2]; }
      if (text && !ended && window.jfswState === 'loading') { showStatus(text); }
    },
    // wm_msgbox() in jfbuild/src/sdlayer2.c: what the game would show in a dialog.
    jfswMessage: function (title, text) { lastMessage = (title ? title + ': ' : '') + text; },
    onRuntimeInitialized: function () { prepare().catch(function (e) { finish('Could not start: ' + describe(e), true); }); },
    // exit() was called somewhere in the game, or main returned.
    onExit: function (code) {
      window.jfswExit = { code: code };
      stopSyncing();
      var msg = code === 0 ? 'The game has ended.' : 'The game stopped with an error (exit status ' + code + ').';
      if (lastMessage) { msg += ' ' + lastMessage; }
      syncNow().then(function () { finish(msg + ' Reload the page to play again.', code !== 0); },
                     function () { finish(msg + ' (Saving to the browser failed.) Reload the page to play again.', code !== 0); });
    },
    onAbort: function (what) {
      finish('The game crashed: ' + what + '. Reload the page to try again.', true);
    }
  };
  window.Module = Module;

  // Relay test knobs (see the top): only with ?test=1. mmulti_vnet.c reads Module.jfswKnobs and nothing else.
  Module.jfswKnobs = {};
  if (TEST) {
    ['relay_wt', 'relay_cert', 'impair'].forEach(function (k) {
      if (params.get(k)) { Module.jfswKnobs[k] = params.get(k); }
    });
  }
  window.jfswKnobs = Module.jfswKnobs;

  // A trap in WebAssembly, or an error in the game's own scripts, would otherwise just freeze the picture.
  // Errors from elsewhere (a browser extension, say) are logged and the game goes on.
  function fromGame(err, file) {
    if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) { return true; }
    var where = (file || '') + ' ' + ((err && err.stack) || '');
    return /(^|\/)(sw|jfsw)\.(js|wasm)/.test(where) || /sw\.wasm/.test(where);
  }
  window.addEventListener('error', function (e) {
    if (running && fromGame(e.error, e.filename)) { finish('Something went wrong: ' + describe(e) + '. Reload the page to try again.', true); }
    else { console.warn('page error (not from the game):', describe(e)); }
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (running && fromGame(e.reason)) { finish('Something went wrong: ' + describe(e) + '. Reload the page to try again.', true); }
    else { console.warn('unhandled rejection (not from the game):', describe(e)); }
  });

  // ---- Files ------------------------------------------------------------------------------------------

  function exists(path) { try { FS.stat(path); return true; } catch (e) { return false; } }

  function syncfs(populate) {
    return new Promise(function (resolve, reject) {
      FS.syncfs(populate, function (err) { if (err) { reject(err); } else { resolve(); } });
    });
  }

  // Signature of the persisted folder; sw.log changes all the time and is not worth a write on its own.
  function persistSignature() {
    var parts = [];
    FS.readdir(HOME_DIR).sort().forEach(function (name) {
      if (name === '.' || name === '..' || name === 'sw.log') { return; }
      try {
        var st = FS.stat(HOME_DIR + '/' + name);
        parts.push(name + ':' + st.size + ':' + (+st.mtime));
      } catch (e) { /* gone again */ }
    });
    return parts.join('|');
  }

  var lastSignature = '';
  var writing = false;
  var current = Promise.resolve();
  var queued = null;
  var syncTimer = 0;
  var closeTimer = 0;

  function run() {
    writing = true;
    lastSignature = persistSignature();
    current = syncfs(false).then(function () { window.jfswSyncs++; writing = false; },
      function (e) { writing = false; console.warn('Saving to the browser failed:', e); throw e; });
    return current;
  }
  // Writes the persisted folder to IndexedDB. A request that arrives while a write is running is not
  // dropped: one more write follows it (several requests share that one), and the returned promise
  // settles when the write that covers this request has finished.
  function syncNow() {
    if (!PERSIST) { return Promise.resolve(); }
    if (!writing) { return run(); }
    if (!queued) {
      var go = function () { queued = null; return run(); };
      queued = current.then(go, go);
    }
    return queued;
  }
  function syncIfChanged() { if (persistSignature() !== lastSignature) { syncNow().catch(function () {}); } }

  function startSyncing() {
    if (!PERSIST) { return; }
    lastSignature = persistSignature();
    // The game writes its files with plain C file calls. Watch the closes of files opened for writing in
    // the persisted folder (a save game, sw.cfg) and write to IndexedDB a moment after the last one.
    var realClose = FS.close;
    FS.close = function (stream) {
      var path = stream && stream.path;
      var wrote = stream && (stream.flags & 3) !== 0;
      var r = realClose.apply(FS, arguments);
      if (wrote && path && path.indexOf(HOME_DIR + '/') === 0 && path !== HOME_DIR + '/sw.log' && path.indexOf('symbols missing') < 0) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(function () { syncNow().catch(function () {}); }, CLOSE_DELAY_MS);
      }
      return r;
    };
    // A safety net for anything that was changed without a close (and is not sw.log).
    syncTimer = setInterval(syncIfChanged, 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { syncIfChanged(); } });
    window.addEventListener('pagehide', syncIfChanged);
  }
  function stopSyncing() { clearInterval(syncTimer); }

  function fetchBytes(url, label) {
    return fetch(url).then(function (resp) {
      if (!resp.ok) { throw new Error(label + ': ' + url + ' answered ' + resp.status + ' ' + resp.statusText); }
      var total = +resp.headers.get('content-length') || 0;
      if (!resp.body || !resp.body.getReader) { return resp.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
      var reader = resp.body.getReader();
      var chunks = [];
      var got = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { return; }
          chunks.push(r.value);
          got += r.value.length;
          if (total) { progressEl.hidden = false; progressEl.value = 100 * got / total; }
          showStatus(label + ' ' + (got / 1048576).toFixed(1) + (total ? ' / ' + (total / 1048576).toFixed(1) : '') + ' MB');
          return pump();
        });
      }
      return pump().then(function () {
        var out = new Uint8Array(got);
        var at = 0;
        chunks.forEach(function (c) { out.set(c, at); at += c.length; });
        return out;
      });
    }, function (e) { throw new Error(label + ': could not fetch ' + url + ' (' + describe(e) + ')'); });
  }

  // ---- Game data --------------------------------------------------------------------------------------

  var prepared = false;       // the first game data is in place and the page is otherwise ready
  var gen = 0;                // each acquire() has a number; the answer of an older one (cancelled by a pick) is ignored
  var loadCtl = null;

  function dataOptions(extra) {
    return Object.assign({
      url: DATA_OVERRIDE || CFG.url || 'swshare.grp',
      size: DATA_OVERRIDE ? 0 : (CFG.size || 0),
      crc32: DATA_OVERRIDE ? '' : (CFG.crc32 || ''),
      revalidate: (TEST && params.has('revalidate')) ? params.get('revalidate') === '1' : !!CFG.revalidate,
      hooks: { quota: TEST && params.get('idb') === 'quota' },
      stallMs: TEST && params.has('stall') ? +params.get('stall') : 30000,
      keepUrls: DATA_OVERRIDE ? [CFG.url || 'swshare.grp'] : [],
      onProgress: onDataProgress,
      onStatus: function (t) { showStatus(t); }
    }, extra || {});
  }

  var lastDraw = 0;
  function onDataProgress(got, total) {
    if (TEST) { window.jfswDownloadLog.push({ got: got, total: total, t: Math.round(performance.now()) }); }
    var now = performance.now();
    if (now - lastDraw < 40 && (!total || got < total)) { return; }
    lastDraw = now;
    progressEl.hidden = false;
    if (total) {
      progressEl.max = 100;
      progressEl.value = 100 * got / total;
      showStatus('Downloading the game data: ' + JfswData.mb(got) + ' of ' + JfswData.mb(total) + ' (' + Math.floor(100 * got / total) + '%)');
    } else {
      progressEl.removeAttribute('value');      // indeterminate: the total is not known (or the response is compressed)
      showStatus('Downloading the game data: ' + JfswData.mb(got));
    }
  }

  function setControls(on, opts) {
    opts = opts || {};
    dataCtl.hidden = !on;
    pickInput.disabled = !on;
    redownloadBtn.hidden = !(on && opts.redownload);
    useDownloadBtn.hidden = !(on && opts.useDownload);
  }

  function writeGrp(res) {
    var path = DATA_DIR + '/' + GRP_NAME;
    FS.writeFile(path, res.bytes);
    // A modification time that only changes when the data does: the game keeps (name, size, mtime, CRC32)
    // in grpfiles.cache and only checksums the 26 MB again when one of them differs.
    var ms = Math.floor(res.storedAt / 1000) * 1000;
    FS.utime(path, ms, ms);
  }

  function describeData(res) {
    var size = JfswData.mb(res.size);
    if (res.source === 'local') { return 'Game data: ' + res.name + ', your own copy (' + (res.fileName || 'picked file') + ', ' + size + ').' + (res.cached ? ' It is kept in this browser.' : ''); }
    var where = res.url.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
    if (res.from === 'network') { return 'Game data: ' + res.name + ', downloaded just now from ' + where + ' (' + size + ').' + (res.cached ? ' It is kept in this browser.' : ''); }
    return 'Game data: ' + res.name + ', downloaded ' + new Date(res.storedAt).toLocaleString() + ' from ' + where + ' (' + size + '), kept in this browser' +
      (res.from === 'revalidated' ? ' (the server says it is still current).' : '.');
  }

  function dataReady(res) {
    writeGrp(res);
    window.jfswData = { source: res.source, from: res.from, name: res.name, size: res.size, crc: res.crc, cached: res.cached, notes: res.notes, crcMs: res.crcMs, downloadMs: res.downloadMs, storedAt: res.storedAt };
    dataInfoEl.hidden = false;
    dataInfoEl.textContent = describeData(res);
    progressEl.hidden = true;
    setControls(true, { redownload: res.source === 'download', useDownload: res.source === 'local' });
    var after = prepared ? Promise.resolve() : finishPrepare();
    return after.then(function () {
      prepared = true;
      var notes = res.notes.join(' ');
      showStatus('Ready.' + (storageNote ? storageNote : '') + (notes ? ' ' + notes : ''), !!(storageNote || notes));
      startBtn.hidden = false;
      startBtn.focus();
      setState('ready');
    });
  }

  function dataFailed(e) {
    window.jfswDataError = { kind: e && e.kind, message: describe(e), size: e && e.size, crc: e && e.crc };
    progressEl.hidden = true;
    startBtn.hidden = true;
    dataInfoEl.hidden = true;
    var text = (e && e.name === 'DataError') ? e.message : 'The game data could not be loaded: ' + describe(e);
    showStatus(text + '\nThe game has not been started. You can try again, or use your own copy of the game data (a .grp file).', true);
    retryBtn.hidden = false;
    setControls(true, {});
    setState('needdata');
  }

  // Gets the game data (downloading it, or from the cache, or from a picked file) and puts it where the game looks.
  // A new call cancels the one before (picking a file while a download runs).
  function acquire(extra) {
    if (loadCtl) { loadCtl.abort(); }
    var ctl = loadCtl = new AbortController();
    var mine = ++gen;
    setState('loading');
    startBtn.hidden = true;
    retryBtn.hidden = true;
    setControls(true, {});          // the picker stays usable: it cancels a download that is slow or stuck
    progressEl.hidden = true;
    dataInfoEl.hidden = true;
    showStatus('Loading game data...');
    return JfswData.load(dataOptions(Object.assign({ signal: ctl.signal }, extra))).then(function (res) {
      if (mine === gen) { return dataReady(res); }
    }, function (e) {
      if (mine === gen) { dataFailed(e); }
    }).then(function () { if (mine === gen) { loadCtl = null; } }, function (e) {
      if (mine === gen) { loadCtl = null; finish('Could not start: ' + describe(e), true); }
    });
  }

  retryBtn.addEventListener('click', function () { acquire(); });
  redownloadBtn.addEventListener('click', function () { if (window.jfswState === 'ready') { acquire({ force: true }); } });
  useDownloadBtn.addEventListener('click', function () { if (window.jfswState === 'ready') { acquire({ useDownload: true }); } });
  pickInput.addEventListener('change', function () {
    var file = pickInput.files && pickInput.files[0];
    pickInput.value = '';
    if (file && ['ready', 'needdata', 'loading'].indexOf(window.jfswState) >= 0 && FS) { acquire({ file: file }); }
  });

  function prepare() {
    FS = Module.FS;
    FS.mkdir(DATA_DIR);
    FS.mkdir(HOME_DIR);
    var ready = Promise.resolve();
    if (PERSIST) {
      FS.mount(Module.IDBFS, {}, HOME_DIR);
      showStatus('Loading saved settings...');
      // Private windows and blocked site data can make IndexedDB fail: play without keeping anything.
      ready = syncfs(true).catch(function (e) {
        PERSIST = false;
        storageNote = ' Saved games and settings will not be kept: this browser would not let the page use its storage (' + describe(e) + ').';
        console.warn('IndexedDB unavailable:', e);
      });
    }
    return ready.then(function () {
      // The game's own "portable" switch: with this file in the current directory, sw.cfg, saved games
      // and the log all go in the current directory (code-facts section 6).
      if (!exists(HOME_DIR + '/user_profiles_disabled')) { FS.writeFile(HOME_DIR + '/user_profiles_disabled', ''); }
      FS.chdir(HOME_DIR);
      return acquire();
    });
  }

  // After the first game data is in place: the test files, then the syncing of /persist.
  function finishPrepare() {
    var files = TEST ? (params.get('files') || '').split(',').filter(Boolean) : [];
    if (files.length && PERSIST) { return Promise.reject(new Error('?files= puts files in the game\'s folder, which is saved to IndexedDB: add persist=0')); }
    return files.reduce(function (p, url) {
      return p.then(function () {
        return fetchBytes(url, 'Test file').then(function (b) { FS.writeFile(HOME_DIR + '/' + url.split('/').pop().split('?')[0], b); });
      });
    }, Promise.resolve()).then(function () {
      startSyncing();
    });
  }

  // ---- Running ----------------------------------------------------------------------------------------

  function gameArgs() {
    if (!TEST) { return []; }
    return (params.get('args') || '').split(/\s+/).filter(Boolean);
  }

  function start() {
    if (running || ended || window.jfswState !== 'ready') { return; }
    startBtn.hidden = true;
    overlay.hidden = true;
    helpEl.hidden = false;
    running = true;
    setState('running');
    canvas.focus();
    fit();
    try {
      // The click is the user gesture that lets the game open its audio device.
      Module.callMain(gameArgs());
    } catch (e) {
      if (e === 'unwind') { return; }                       // ASYNCIFY suspended main, as it should
      if (e && e.name === 'ExitStatus') { return; }         // exit(), reported by onExit
      finish('The game could not start: ' + describe(e), true);
    }
  }
  startBtn.addEventListener('click', start);

  // ---- Canvas size ------------------------------------------------------------------------------------

  // The picture is the video mode the game chose (640x480 to begin with); scale it to the window, keeping
  // its shape. SDL reads and sets the canvas size itself, so do this from outside, now and then.
  function fit() {
    var w = canvas.width, h = canvas.height;
    if (!w || !h) { return; }
    var helpH = helpEl.hidden ? 0 : helpEl.offsetHeight + 10;
    var availW = document.documentElement.clientWidth - 16;
    var availH = window.innerHeight - helpH - 16;
    var scale = Math.max(0.25, Math.min(availW / w, availH / h));
    canvas.style.width = Math.floor(w * scale) + 'px';
    canvas.style.height = Math.floor(h * scale) + 'px';
  }
  window.addEventListener('resize', fit);
  setInterval(fit, 500);

  // ---- Escape and the mouse ---------------------------------------------------------------------------

  // The game wants the mouse captured all the time (relative mode) and uses Escape for its menu. A browser
  // takes Escape to leave pointer lock and then does not deliver it to the page, so when the lock is lost
  // and the game did not ask for that, give the game the Escape it would have had.
  var gameReleasedLock = false;
  var lastEscape = 0;
  if (document.exitPointerLock) {
    var realExit = document.exitPointerLock.bind(document);
    document.exitPointerLock = function () { gameReleasedLock = true; return realExit(); };
  }
  window.addEventListener('keydown', function (e) { if (e.code === 'Escape') { lastEscape = performance.now(); } }, true);
  document.addEventListener('pointerlockchange', function () {
    if (document.pointerLockElement) { gameReleasedLock = false; return; }
    if (gameReleasedLock) { gameReleasedLock = false; return; }
    if (!running || !document.hasFocus() || performance.now() - lastEscape < 300) { return; }
    var init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    // Held long enough for the game's next pass over its input.
    setTimeout(function () { window.dispatchEvent(new KeyboardEvent('keyup', init)); }, 100);
  });

  // The game keeps SDL in relative mouse mode. While SDL thinks the pointer is not locked, it turns every
  // mousemove, mouseenter and mouseleave on the canvas into an absolute position and reports the jump from the
  // last position it knew as relative motion, so a mouse moving over the picture, or the enter or leave the
  // browser sends as the lock starts or ends, turns the player's view. The game reads only relative motion, so
  // those events are the game's only while the pointer is locked. SDL learns of the lock from pointerlockchange,
  // which can come after document.pointerLockElement has changed and after an enter or leave for the same
  // change: hence our own copy of what SDL was last told.
  var sdlSeesLock = false;
  document.addEventListener('pointerlockchange', function () { sdlSeesLock = !!document.pointerLockElement; });
  ['mousemove', 'mouseenter', 'mouseleave'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (e.target !== canvas || (sdlSeesLock && document.pointerLockElement === canvas)) { return; }
      if (TEST && window.jfswTest && window.jfswTest.passUnlockedMouse) { return; }
      e.stopPropagation();
    }, true);
  });

  // ---- Test hooks -------------------------------------------------------------------------------------

  if (TEST) {
    window.jfswDownloadLog = [];
    Module.jfswFrameLog = capped([], 50000);
    Module.jfswYieldLog = capped([], 50000);
    Module.jfswShowframes = 0;              // pictures the game asked to present (showframe(); none while a hidden tab plays a network game)
    Module.jfswOwedLog = capped([], 50000);     // ms each hidden yield lasted that was entered with data held back by mmulti's send window
    if (params.get('wake_every')) { Module.jfswWakeEvery = +params.get('wake_every'); }   // only every Nth network wake-up gets through (test only)
    Module.jfswWakes = 0;                   // how often vnet's wake callback fired (sdlayer2.c)
    Module.jfswHiddenLog = capped([], 50000);   // why each hidden-tab yield ended: 1 a network event, 2 the page became visible, 0 the timer
    testInfoEl.hidden = false;
    testInfoEl.textContent = 'test mode: args=' + JSON.stringify(gameArgs()) + ' persist=' + PERSIST;
    window.jfswTest = {
      get FS() { return FS; },
      start: start,
      readFile: function (name) {
        try { return FS.readFile(name.charAt(0) === '/' ? name : HOME_DIR + '/' + name); } catch (e) { return null; }
      },
      writeFile: function (name, bytes) { FS.writeFile(name.charAt(0) === '/' ? name : HOME_DIR + '/' + name, bytes); },
      listFiles: function () { return FS.readdir(HOME_DIR).filter(function (n) { return n !== '.' && n !== '..'; }); },
      syncNow: syncNow
    };
  }
})();
