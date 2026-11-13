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
//   ?host=N       host a network game of N players (2 to 8; 4 with the shareware data) through the relay in
//                 config.js (brief 05): the page starts the game with -net -relay <relay> -host-room N and shows
//                 the lobby (room code, invite link, who is in, Start now, Cancel) while the game waits.
//   ?join=CODE    join the room CODE (6 letters and digits, any case) the same way. The invite link is ?join=CODE.
//                 The relay comes only from config.js (a crafted link must not route a visitor through another
//                 relay); a bad N or CODE, or no relay configured, is said on the page and starts no game.
//   ?test=1       test hooks (below), only when config.js has testMode: true (a link alone cannot turn them on).
//                 Nothing else here reads the other options.
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
// is not locked, as before the fix; for the smoke test's sabotage run), unhandledPointerLock (set it true to leave the
// promise of a pointer-lock request unhandled, as before brief 02c; for tests/web/focus.js's sabotage run) }; Module.jfswFrameLog (see sdlayer2.c) is an array of frame times;
// window.jfswOut holds every line the game printed; window.jfswExit is set when it ends.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  // Test mode needs both ?test=1 and testMode: true in config.js (brief 05 review): a link alone cannot turn it
  // on, so a crafted link cannot hand a visitor's game test arguments (?args=, which can name another relay).
  // The tests serve a config.js with testMode: true; a site leaves it false (data-hosting.md, brief 06).
  var TEST = params.get('test') === '1' && !!(window.JFSW_CONFIG && window.JFSW_CONFIG.testMode === true);
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

  // ---- A network game from the page address (brief 05) -------------------------------------------
  // The relay is config.js's, never the address's.
  var RELAY = (window.JFSW_CONFIG && window.JFSW_CONFIG.relay) || '';
  var ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;        // the relay's alphabet: A-Z without I and O, 2-9
  var NET = parseNet();                        // null, { host: N }, { join: CODE } or { error: text }
  function parseNet() {
    var h = params.get('host'), j = params.get('join');
    if (h === null && j === null) { return null; }
    if (h !== null && j !== null) { return { error: 'This address asks to host and to join a network game at once (?host= and ?join=). Use one of them.' }; }
    if (!RELAY) {
      return { error: 'This page cannot ' + (h !== null ? 'host' : 'join') + ' a network game: no relay is set up for it (the relay field of config.js is empty). Whoever runs this site can add one.' };
    }
    if (h !== null) {
      if (!/^\d+$/.test(h) || +h < 2 || +h > 8) { return { error: '"' + h + '" is not a number of players. ?host= takes 2 to 8 (4 with the shareware game data).' }; }
      return { host: +h };
    }
    var code = j.trim().toUpperCase();
    if (!ROOM_RE.test(code)) { return { error: '"' + j + '" is not a room code. A room code is 6 letters and digits, without 0, 1, I or O (for example ABC234): check the invite link.' }; }
    return { join: code };
  }
  // This page's address with ?host= / ?join= set as given (o: { host }, { join } or {} for neither); every other parameter is kept.
  function netUrl(o) {
    var p = new URLSearchParams(location.search);
    p.delete('host'); p.delete('join');
    if (o.host) { p.set('host', String(o.host)); }
    if (o.join) { p.set('join', o.join); }
    var q = p.toString();
    return location.origin + location.pathname + (q ? '?' + q : '');     // never a path the address could make protocol-relative
  }
  function goStartPage() { location.replace(netUrl({})); }
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

  // Something went wrong or the game is over: say so on the page, over the last picture. `replace`: an error that
  // replaces an "ended" message already shown (see gameError()).
  function finish(message, isError, replace) {
    if (ended && !(replace && window.jfswState === 'ended')) { return; }
    ended = true;
    running = false;
    hideLobby();
    if (NET) { reloadBtn.textContent = 'Back to the start page'; }
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
  // After a network game the reload button goes back to the page without ?host= or ?join= (a reload would
  // create another room, or try the same code again).
  reloadBtn.addEventListener('click', function () { if (NET) { goStartPage(); } else { location.reload(); } });

  function describe(e) {
    return (e && (e.message || e.reason && (e.reason.message || e.reason))) || String(e);
  }
  // A description as a sentence of its own: exactly one full stop at the end, whether or not the browser's
  // message has one ("The document is not focused." would otherwise become "focused.. Reload ...").
  function sentence(text) {
    text = String(text).trim();
    return /[.!?]$/.test(text) ? text : text + '.';
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
      exitedAt = performance.now();
      stopSyncing();
      if (lobbyCancel) {
        // Cancel in the lobby: the game has told the others and left the room; back to the normal page.
        syncNow().then(goStartPage, goStartPage);
        return;
      }
      var msg = code === 0 ? 'The game has ended.' : 'The game stopped with an error (exit status ' + code + ').';
      if (lastMessage) { msg += ' ' + sentence(lastMessage); }
      var again = NET ? '' : ' Reload the page to play again.';
      syncNow().then(function () { finish(msg + again, code !== 0); },
                     function () { finish(msg + ' (Saving to the browser failed.)' + again, code !== 0); });
    },
    onAbort: function (what) {
      finish('The game crashed: ' + sentence(what) + ' Reload the page to try again.', true);
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

  // ---- The lobby (brief 05, D9): an HTML overlay while the game waits for its players -------------
  // The game (src/netlobby.c) calls Module.jfswLobby({state, code, joined, slots, host, started}) when
  // something changes and every 100 ms while it waits; the return value is what the player asked for
  // since the last call (1 start now, 2 cancel). state: 1 connecting to the relay, 2 in the room. The
  // game starts the moment the wait is over (started), with the player count every machine agreed.
  var lobbyEl = document.getElementById('lobby');
  var lobbyStateEl = document.getElementById('lobbystate');
  var lobbyRoomEl = document.getElementById('lobbyroom');
  var lobbyCodeEl = document.getElementById('lobbycode');
  var lobbyLinkEl = document.getElementById('lobbylink');
  var lobbyCopyBtn = document.getElementById('lobbycopy');
  var lobbyPlayersEl = document.getElementById('lobbyplayers');
  var lobbyStartBtn = document.getElementById('lobbystart');
  var lobbyCancelBtn = document.getElementById('lobbycancel');
  var lobbyReq = 0;
  var lobbyCancel = false;
  var startAsked = false;     // Start now pressed, and the game has not had the request yet
  var lobbyShown = '';
  window.jfswLobby = null;        // the game's last report (also without ?test=1: the tests read it)

  // The invite link keeps ?data=: every player of a game must have the same game data, so a host who plays with
  // other data than config.js's sends the guests to it too (the game would refuse mismatched data anyway).
  function inviteLink(code) { return location.origin + location.pathname + '?join=' + code + (DATA_OVERRIDE ? '&data=' + encodeURIComponent(DATA_OVERRIDE) : ''); }
  function hideLobby() { lobbyEl.hidden = true; }
  function showLobby(info) {
    var key = [info.state, info.code, info.joined, info.slots, info.host, lobbyCancel, info.pending, startAsked].join(',');
    if (key === lobbyShown) { return; }
    var first = lobbyEl.hidden;
    lobbyShown = key;
    lobbyEl.hidden = false;
    document.getElementById('lobbytitle').textContent = info.host ? 'Hosting a network game' : 'Joining a network game';
    if (lobbyCancel) {
      lobbyStateEl.textContent = 'Leaving the room...';
    } else if (info.state !== 2) {
      lobbyStateEl.textContent = 'Connecting to the relay...';
    } else {
      lobbyStateEl.textContent = info.host ? 'The room is open. Send the other players the code or the invite link.' : 'You are in the room.';
      if (info.host && info.pending) { lobbyStateEl.textContent = 'Starting as soon as every player in the room has answered...'; }
    }
    lobbyRoomEl.hidden = info.state !== 2 || !info.code;
    if (info.code && lobbyCodeEl.textContent !== info.code) {
      lobbyCodeEl.textContent = info.code;
      lobbyLinkEl.value = inviteLink(info.code);
    }
    var more = info.slots - info.joined;
    if (info.joined > 0 && info.slots > 0) {
      lobbyPlayersEl.textContent = info.joined + ' of ' + info.slots + ' players are in.' +
        (more > 0 ? ' Waiting for ' + more + ' more' + (info.host ? '' : ', or for the host to start') + '...' : ' Starting...');
    } else {
      lobbyPlayersEl.textContent = info.state === 2 ? 'Waiting for the host to answer...' : '';
    }
    lobbyStartBtn.hidden = !info.host;
    // a request the game has taken shows as pending; one it could not take (fewer than 2 in, or they left) is dropped
    // by the game, and the button is offered again
    lobbyStartBtn.disabled = !(info.host && info.state === 2 && info.joined >= 2 && !lobbyCancel && !info.pending && !startAsked);
    lobbyStartBtn.textContent = (info.pending || startAsked) ? 'Starting...' : (info.joined >= 2 ? 'Start now with ' + info.joined + ' players' : 'Start now (needs 2 players)');
    // keyboard users start on the useful button: the host on Copy once there is a link, a guest on Cancel
    if (first && !info.host) { lobbyCancelBtn.focus(); }
    if (info.host && info.state === 2 && (first || document.activeElement === document.body || document.activeElement === canvas)) { lobbyCopyBtn.focus(); }
  }
  Module.jfswLobby = function (info) {
    window.jfswLobby = info;
    if (info.started) { hideLobby(); canvas.focus(); return 0; }
    showLobby(info);
    var r = lobbyReq;
    lobbyReq = 0;
    startAsked = false;       // the next report says whether the game kept the request (info.pending)
    return r;
  };
  lobbyStartBtn.addEventListener('click', function () { lobbyReq |= 1; startAsked = true; lobbyShown = ''; lobbyStartBtn.disabled = true; lobbyStartBtn.textContent = 'Starting...'; });
  lobbyCancelBtn.addEventListener('click', function () {
    if (lobbyCancel) { return; }
    lobbyCancel = true;
    lobbyReq |= 2;
    lobbyShown = '';
    lobbyStateEl.textContent = 'Leaving the room...';
    lobbyStartBtn.disabled = true;
    setTimeout(goStartPage, 3000);      // if the game does not get round to it
  });
  lobbyCopyBtn.addEventListener('click', function () {
    var done = function () { lobbyCopyBtn.textContent = 'Copied'; setTimeout(function () { lobbyCopyBtn.textContent = 'Copy'; }, 2000); };
    lobbyLinkEl.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lobbyLinkEl.value).then(done, function () { try { document.execCommand('copy'); done(); } catch (e) { /* the link stays selected */ } });
    } else {
      try { document.execCommand('copy'); done(); } catch (e) { /* the link stays selected */ }
    }
  });
  lobbyLinkEl.addEventListener('focus', function () { lobbyLinkEl.select(); });
  // The game's keyboard handler (SDL, on the window) would take the keys meant for the lobby's buttons.
  // While the lobby is up, keys stay with the page: Tab, Enter and Space work on the buttons as usual.
  ['keydown', 'keyup', 'keypress'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (!lobbyEl.hidden) { e.stopImmediatePropagation(); } }, true);
  });

  // The console's and the menus' host and join (src/netlobby.c): restart the page into the network game (D3).
  // Returns 0 when this page has no relay; the game says so.
  Module.jfswNetGame = function (code, players) {
    if (!RELAY) { return 0; }
    var url = netUrl(code ? { join: code } : { host: players });
    setTimeout(function () { var go = function () { location.assign(url); }; syncNow().then(go, go); }, 50);
    return 1;
  };

  // A trap in WebAssembly, or an error in the game's own scripts, would otherwise just freeze the picture.
  // Errors from elsewhere (a browser extension, say) are logged and the game goes on.
  function fromGame(err, file) {
    if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) { return true; }
    var where = (file || '') + ' ' + ((err && err.stack) || '');
    return /(^|\/)(sw|jfsw)\.(js|wasm)/.test(where) || /sw\.wasm/.test(where);
  }
  // A trap or an error inside the game's frame reaches Module.onExit first: Emscripten's callUserCallback() ends the
  // runtime (exit with the last status, usually 0) on its way out, and the error itself comes after, as an 'error'
  // event or an unhandled rejection (the order of the two is the browser's). So such an error shortly after an exit is
  // still the game's, and its message replaces "The game has ended." (brief 02c, bugs.md L33). The error comes within
  // a few ms; the window is 250 ms. Not a DOMException once the game has exited, whether or not the exit's save is still
  // running (`running` is true until then): that is a browser API refusing something, not the game failing; for
  // example, when the game closes its audio on the way out, Firefox rejects every AudioContext.resume() still pending
  // with "Closed before resume completed". Nor Emscripten's ExitStatus, which is how exit() unwinds.
  var exitedAt = 0;
  function gameError(err, file) {
    if (!fromGame(err, file)) { return false; }
    if (err && err.name === 'ExitStatus') { return false; }
    var refusal = typeof DOMException !== 'undefined' && err instanceof DOMException;
    if (exitedAt > 0 && refusal) { return false; }
    if (running) { return true; }
    return exitedAt > 0 && performance.now() - exitedAt < 250;
  }
  window.addEventListener('error', function (e) {
    if (gameError(e.error, e.filename)) { finish('Something went wrong: ' + sentence(describe(e)) + ' Reload the page to try again.', true, true); }
    else { console.warn('page error (not from the game):', describe(e)); }
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (gameError(e.reason)) { finish('Something went wrong: ' + sentence(describe(e)) + ' Reload the page to try again.', true, true); }
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
      if (NET && NET.host > 4 && res.game === 'SHARE') {
        netRefused('?host=' + NET.host + ': the shareware version of the game allows at most 4 players. Host a game of 2 to 4 (?host=4), or use the registered game data.');
        return;
      }
      if (NET) { startBtn.textContent = NET.host ? 'Click to host a game of ' + NET.host : 'Click to join room ' + NET.join; }
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
    if (NET && NET.error) {
      // checked before anything is loaded: no game starts from this address
      return ready.then(function () { netRefused(NET.error); });
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
    var a = [];
    if (NET && NET.host) { a = ['-net', '-relay', RELAY, '-host-room', String(NET.host), '--']; }
    if (NET && NET.join) { a = ['-net', '-relay', RELAY, '-room', NET.join, '--']; }
    if (!TEST) { return a; }
    return a.concat((params.get('args') || '').split(/\s+/).filter(Boolean));
  }

  // A ?host= or ?join= the page cannot use: say why, and offer the normal page instead of a game.
  function netRefused(text) {
    setState('error');
    progressEl.hidden = true;
    startBtn.hidden = true;
    dataCtl.hidden = true;
    showStatus(text, true);
    reloadBtn.textContent = 'Go to the start page';
    reloadBtn.hidden = false;
    reloadBtn.focus();
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
      finish('The game could not start: ' + sentence(describe(e)), true);
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

  // A refused pointer lock is normal, not a crash (bugs.md L24, brief 02c). The browser refuses a request while the
  // document does not have the focus, and SDL asks at such moments: when the game handles a focus event after the
  // window has lost the focus again (Alt+Tab can send blur, focus, blur within a few ms; jfbuild/src/sdlayer2.c, the
  // SDL_WINDOWEVENT branch) and at start-up (grabmouse(1)) when the page is not focused. Emscripten's helpers in sw.js
  // call canvas.requestPointerLock() and drop the promise it returns, so a refusal became an unhandled rejection;
  // Firefox gives the DOMException a stack through sw.js, and the 'unhandledrejection' handler above took it for the
  // game crashing. Nothing is lost by a refusal: SDL and this page both still see the pointer as free (no
  // pointerlockchange came), and SDL asks again on the next click on the canvas, or on the next focus.
  // The canvas is the only element Emscripten asks for the lock (SDL's "#canvas", and Module.canvas). Its fullscreen
  // calls drop their promises the same way, on the canvas and on the document; the game never asks for fullscreen
  // (sdlayer2.c keeps the canvas a window), but they are handled alike in case it ever does. So does SDL's audio with
  // AudioContext.resume() (it asks on every audio callback while the context is suspended): when the game closes its
  // audio device (on exit, or to reopen it after a sound setting changed) every pending resume() is rejected.
  // Dropped promises left alone: AudioContext.close() (rejects only for a context already closed), webkitAudioContext
  // (no browser this page supports lacks AudioContext), and Browser.requestFullscreen()'s new container element in
  // sw.js (nothing calls it).
  // A burst of refusals (Firefox rejects 130 to 195 pending resume() calls at once at the end of a game) is logged as
  // its first one and then one line with the count, a second after the burst.
  // Test hook: window.jfswTest.unhandledPointerLock = true leaves the lock's promise unhandled, as before the fix.
  var refusalBursts = {};
  function logRefusal(what, e) {
    var b = refusalBursts[what] || (refusalBursts[what] = { more: 0, timer: 0 });
    if (b.timer) { b.more++; clearTimeout(b.timer); } else { console.warn(what + ' refused:', describe(e)); }
    b.timer = setTimeout(function () {
      if (b.more) { console.warn(what + ' refused ' + b.more + ' more time' + (b.more === 1 ? '' : 's') + ' (the same way)'); }
      b.more = 0; b.timer = 0;
    }, 1000);
  }
  function quietRefusal(obj, name, what) {
    var real = obj[name];
    if (typeof real !== 'function') { return; }
    obj[name] = function () {
      var r;
      try { r = real.apply(this, arguments); } catch (e) {
        // what the browser would have done with a refusal: a rejected promise, here one that already has its handler
        var p = Promise.reject(e);
        p.then(null, function (x) { logRefusal(what, x); });
        return p;
      }
      if (TEST && name === 'requestPointerLock' && window.jfswTest && window.jfswTest.unhandledPointerLock) { return r; }
      if (r && typeof r.then === 'function') { r.then(null, function (e) { logRefusal(what, e); }); }
      return r;
    };
  }
  quietRefusal(canvas, 'requestPointerLock', 'pointer lock');
  quietRefusal(canvas, 'requestFullscreen', 'fullscreen');
  quietRefusal(document, 'exitFullscreen', 'leaving fullscreen');
  if (window.AudioContext) { quietRefusal(window.AudioContext.prototype, 'resume', 'audio resume'); }

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
