// Page glue for the browser build of JFShadowWarrior (brief 02).
//
// Runs before sw.js: it defines Module (Emscripten's configuration object), then
// drives the start-up: mount the persistent folder, put the game data in place,
// wait for the "Click to start" click (browsers only allow sound after one), run
// main, and say so on the page if the game ends or crashes.
//
// Query string:
//   ?data=<url>   fetch the GRP from this URL (default: swshare.grp next to this page).
//                 Dev loader, no cache; brief 03 replaces it.
//   ?test=1       test hooks (below). Nothing else here reads the other options.
//   ?args=...     game arguments, space separated (test only), e.g. "-level1 -dpdemo1".
//   ?files=a,b    URLs of files to put in the game's directory before main (test only).
//   ?persist=0    keep the game's directory in memory only (test only).
//
// Test hooks, with ?test=1: window.jfswTest = { FS, readFile(name), writeFile(name, bytes),
// listFiles(), start() }; Module.jfswFrameLog (see sdlayer2.c) is an array of frame times;
// window.jfswOut holds every line the game printed; window.jfswExit is set when it ends.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TEST = params.get('test') === '1';
  var PERSIST = !(TEST && params.get('persist') === '0');
  var DATA_URL = params.get('data') || 'swshare.grp';
  var DATA_DIR = '/data';        // on the game's search path (DATADIR in the Makefile); not persisted
  var HOME_DIR = '/persist';     // the game's current directory: sw.cfg, saves, sw.log; IndexedDB
  var GRP_NAME = 'sw.grp';

  var canvas = document.getElementById('canvas');
  var overlay = document.getElementById('overlay');
  var statusEl = document.getElementById('status');
  var progressEl = document.getElementById('progress');
  var startBtn = document.getElementById('start');
  var reloadBtn = document.getElementById('reload');
  var helpEl = document.getElementById('help');
  var testInfoEl = document.getElementById('testinfo');

  var running = false;
  var ended = false;
  var FS = null;
  var lastMessage = '';

  window.jfswOut = [];
  window.jfswErr = [];
  window.jfswState = 'loading';   // loading, ready, running, ended, error
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
    reloadBtn.hidden = false;
    showStatus(message, isError);
    reloadBtn.focus();
  }
  reloadBtn.addEventListener('click', function () { location.reload(); });

  function describe(e) {
    return (e && (e.message || e.reason && (e.reason.message || e.reason))) || String(e);
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

  // A trap in WebAssembly, or an error in the page's own code, would otherwise just freeze the picture.
  window.addEventListener('error', function (e) { if (running) { finish('Something went wrong: ' + describe(e) + '. Reload the page to try again.', true); } });
  window.addEventListener('unhandledrejection', function (e) {
    if (running) { finish('Something went wrong: ' + describe(e) + '. Reload the page to try again.', true); }
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
  var syncing = false;
  var syncTimer = 0;

  function syncNow() {
    if (!PERSIST || syncing) { return Promise.resolve(); }
    syncing = true;
    lastSignature = persistSignature();
    return syncfs(false).then(function () { window.jfswSyncs++; }).then(function () { syncing = false; },
      function (e) { syncing = false; console.warn('Saving to the browser failed:', e); throw e; });
  }

  function startSyncing() {
    if (!PERSIST) { return; }
    lastSignature = persistSignature();
    // Config and saves are written by the game with plain file calls and there is no hook for that,
    // so look for changes once a second and when the tab is hidden.
    syncTimer = setInterval(function () {
      if (!syncing && persistSignature() !== lastSignature) { syncNow().catch(function () {}); }
    }, 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && !syncing && persistSignature() !== lastSignature) { syncNow().catch(function () {}); }
    });
    window.addEventListener('pagehide', function () { if (!syncing && persistSignature() !== lastSignature) { syncNow().catch(function () {}); } });
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

  function prepare() {
    FS = Module.FS;
    FS.mkdir(DATA_DIR);
    FS.mkdir(HOME_DIR);
    var ready = Promise.resolve();
    if (PERSIST) {
      FS.mount(Module.IDBFS, {}, HOME_DIR);
      showStatus('Loading saved settings...');
      ready = syncfs(true);
    }
    return ready.then(function () {
      // The game's own "portable" switch: with this file in the current directory, sw.cfg, saved games
      // and the log all go in the current directory (code-facts section 6).
      if (!exists(HOME_DIR + '/user_profiles_disabled')) { FS.writeFile(HOME_DIR + '/user_profiles_disabled', ''); }
      FS.chdir(HOME_DIR);
      showStatus('Loading game data...');
      return fetchBytes(DATA_URL, 'Game data');
    }).then(function (bytes) {
      FS.writeFile(DATA_DIR + '/' + GRP_NAME, bytes);
      if (!TEST) { return; }
      var files = (params.get('files') || '').split(',').filter(Boolean);
      return files.reduce(function (p, url) {
        return p.then(function () {
          return fetchBytes(url, 'Test file').then(function (b) { FS.writeFile(HOME_DIR + '/' + url.split('/').pop().split('?')[0], b); });
        });
      }, Promise.resolve());
    }).then(function () {
      startSyncing();
      progressEl.hidden = true;
      showStatus('Ready.');
      startBtn.hidden = false;
      startBtn.focus();
      setState('ready');
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

  // ---- Test hooks -------------------------------------------------------------------------------------

  if (TEST) {
    Module.jfswFrameLog = [];
    Module.jfswYieldLog = [];
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
