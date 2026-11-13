#!/usr/bin/env node
// Browser netplay tests (brief 04): browsers (Playwright + Chromium) and native games play bounded
// network games through a local vnet relay, and every machine's own record of every game tic is
// compared byte for byte.
//
//   node tests/web/netplay.js                      # every scenario but lag-matrix and old-new, one after the other (about 28 minutes)
//   node tests/web/netplay.js ws wt                # only these
//   node tests/web/netplay.js --list
//   WASM_DIR=build-wasm-x node tests/web/netplay.js ws    # another build of the page (mutation runs)
//
// Scenarios (see SCENARIOS below for what each checks):
//   (see --list)
//
// Needs: build-wasm/ (scripts/build-wasm.sh), the native ./sw (make), testdata/swshare.grp, Go (the
// relay is built from ext/vnet/relay as tests/net/lib.sh builds it), and Playwright with a Chromium.
// Never run `playwright install`. Ports: 127.0.0.1:48300 to 48399 (native network tests use 47000 to
// 47999). The tests are real time: run one at a time on a machine that is not busy.
//
// How a game is checked. Every machine runs   -autonet 2,0,2,1,0,0,0,0,0,0 -testsync -testquit<N>
// -testdump<file>   (co-op, E1L1; N game tics, then a clean exit). -testdump makes the game write
// 17 bytes for every game tic (tic number, the nine sync bytes, a 32 bit hash of the whole state):
// the game's own check compares on the master only, and only low bytes (code-facts section 8). The
// test reads each machine's file, requires at least N records, and compares all machines record by
// record. A machine counts as agreeing only if every record is identical.
'use strict';
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serve, configText } = require('./server.js');
const L = require('./lib.js');

const PORT_WEB = 48300, PORT_UDP = 48301, PORT_HTTP = 48302, PORT_WT = 48303;
const NOMINAL = 40;                       // game tics a second (120 Hz clock, 3 clock ticks a game tic)
const REC = 17;                           // bytes per tic in a -testdump file
const AUTONET = '-autonet 2,0,2,1,0,0,0,0,0,0';
const check = L.check;
// NETPLAY_STATE=1 adds -teststate to every machine: it also writes <dump>.state, the whole simulation state field by field when
// the level starts and at tics 1 to 3 (sync.c, brief 04b); NETPLAY_STATE=600,1200 adds those tics (up to 16). When two machines'
// dumps first differ at a tic that has a state dump, the failure names the objects and fields that differ. Off by default: the
// first state dump delays a browser's first frame, which changes how a game starts.
const STATE_ARGS = process.env.NETPLAY_STATE ? ['-teststate'].concat(process.env.NETPLAY_STATE.split(',').filter((x) => /^\d+$/.test(x) && +x > 3).map((x) => '-teststate' + x)) : [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ---- relay ------------------------------------------------------------------------------------------

function relayBinary() {
  const cache = process.env.JFSW_CACHE || path.join(os.homedir(), '.cache', 'jfsw-browser');
  let rev = 'unknown';
  try { rev = execSync('git -C ' + JSON.stringify(path.join(L.root, 'ext', 'vnet')) + ' rev-parse --short HEAD').toString().trim(); } catch (e) { /* no git */ }
  const bin = path.join(cache, 'vnet-relay-' + rev);
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(cache, { recursive: true });
    const env = Object.assign({}, process.env, { PATH: process.env.PATH + ':/usr/local/go/bin' });
    execSync('go build -o ' + JSON.stringify(bin + '.tmp') + ' ./cmd/vnet-relay', { cwd: path.join(L.root, 'ext', 'vnet', 'relay'), env, stdio: 'inherit' });
    fs.renameSync(bin + '.tmp', bin);
  }
  return bin;
}

// A relay on 127.0.0.1: UDP (native players), WebSocket on /vnet and WebTransport (a development certificate).
async function startRelay(extra) {
  const args = ['-udp', '127.0.0.1:' + PORT_UDP, '-http', '127.0.0.1:' + PORT_HTTP, '-wt', '127.0.0.1:' + PORT_WT, '-dev-cert',
    '-origins', '127.0.0.1:' + PORT_WEB, '-v'].concat(extra || [], (process.env.NETPLAY_RELAY_ARGS || '').split(/\s+/).filter(Boolean));     // (NETPLAY_RELAY_ARGS: extra relay flags, for negative controls)
  const child = spawn(relayBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let text = '';
  const relay = { child, log: () => text, cert: '', udp: '127.0.0.1:' + PORT_UDP, ws: 'ws://127.0.0.1:' + PORT_HTTP + '/vnet', wt: 'https://127.0.0.1:' + PORT_WT + '/vnet' };
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  const t0 = now();
  while (!/^LISTEN /m.test(text)) {
    if (child.exitCode !== null) { throw new Error('the relay exited: ' + text); }
    if (now() - t0 > 15000) { throw new Error('the relay did not start: ' + text); }
    await sleep(50);
  }
  relay.cert = (/wt_cert_sha256=(\S+)/.exec(text) || [])[1] || '';
  relay.stop = async () => { try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* gone */ } await sleep(200); try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } };
  return relay;
}

// ---- machines ---------------------------------------------------------------------------------------
// A machine is a browser page or a native game; both give: out() (what the game printed), dumpSize(), readDump(),
// waitEnd(ms), exitCode(), stop().

let browserEnv = null;      // { server, browser }
// Brief 05: the config.js the page is served with (server.js configText): the build's, with the relay field CONFIG_RELAY
// (null: the test relay's WebSocket URL; '': none, as a site without a relay) and testMode CONFIG_TEST (true: ?test=1
// pages have their test hooks; false: as a public site, where ?test=1 does nothing). Set them before the first machine of a
// scenario; closeEnv() resets them.
let CONFIG_RELAY = null, CONFIG_TEST = true;
async function env() {
  if (!browserEnv) {
    if (!fs.existsSync(path.join(L.BUILD, 'sw.wasm'))) { throw new Error(L.BUILD + '/sw.wasm not found: run scripts/build-wasm.sh'); }
    if (!fs.existsSync(L.GRP)) { throw new Error(L.GRP + ' not found: run scripts/fetch-test-data.sh'); }
    const mounts = { '/swshare.grp': L.GRP };
    {
      const out = path.join(tmp(), 'config-served.js');
      fs.writeFileSync(out, configText(L.BUILD, { testMode: CONFIG_TEST, relay: CONFIG_RELAY === null ? 'ws://127.0.0.1:' + PORT_HTTP + '/vnet' : CONFIG_RELAY }));
      mounts['/config.js'] = out;
    }
    // NETPLAY_OLD_WASM=<dir>: another build of the page, served under /old/ (the old-new scenario, brief 04c)
    if (process.env.NETPLAY_OLD_WASM) {
      const dir = path.resolve(process.env.NETPLAY_OLD_WASM);
      for (const f of fs.readdirSync(dir)) { mounts['/old/' + f] = path.join(dir, f); }
      mounts['/old/swshare.grp'] = L.GRP;
    }
    const server = await serve(L.BUILD, mounts, PORT_WEB);
    const browser = await chromium.launch();
    browserEnv = { server, browser, base: 'http://127.0.0.1:' + PORT_WEB + '/index.html', oldBase: 'http://127.0.0.1:' + PORT_WEB + '/old/index.html' };
  }
  return browserEnv;
}
async function closeEnv() {
  if (!browserEnv) { return; }
  try { await browserEnv.browser.close(); } catch (e) { /* gone */ }
  await new Promise((r) => browserEnv.server.close(r));
  browserEnv = null;
  CONFIG_RELAY = null;
  CONFIG_TEST = true;
}

const machines = [];
let tmpRoot = null;
function tmp() { if (!tmpRoot) { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jfsw-netplay-')); } return tmpRoot; }

function gameArgs(o) {
  // o: { net: [..args after -net..], tics, dump, nudge, extra }
  const a = ['-net'].concat(o.net, ['--']);
  if (o.autonet !== false) { a.push(...(o.autonet || AUTONET).split(' ')); }
  if (o.testsync !== false) { a.push('-testsync'); }
  if (o.tics) { a.push('-testquit' + o.tics); }
  if (o.dump) { a.push('-testdump' + o.dump); a.push(...(o.state ? ['-teststate'] : STATE_ARGS)); }
  if (o.lag) { a.push('-testlag' + o.lag); }
  if (o.nudge) { a.push('-testnudge' + o.nudge); }
  return a.concat(o.extra || []);
}

// A browser machine. o.relay is the URL given to -relay; o.query adds page parameters (knobs); o.hidden imitates a hidden tab;
// o.old: the build of the page that NETPLAY_OLD_WASM names.
async function browserMachine(name, args, o) {
  o = o || {};
  const e = await env();
  const context = await e.browser.newContext({ viewport: o.viewport || { width: 700, height: 560 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (er) => errors.push('pageerror: ' + er.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  // o.raw: the whole query string as given (brief 05: a page without ?test=1, or one started by ?host= / ?join=)
  const q = o.raw !== undefined ? o.raw : '?test=1&persist=0&args=' + encodeURIComponent(args.join(' ')) + (o.query || '');
  if (o.old && !process.env.NETPLAY_OLD_WASM) { throw new Error('an old build of the page needs NETPLAY_OLD_WASM'); }
  await page.goto((o.old ? e.oldBase : e.base) + q);
  await L.waitState(page, o.ready || 'ready', 60000);
  const m = {
    kind: 'browser', name, page, context, errors, started: 0,
    async start() { await page.click('#start'); m.started = now(); },
    lobby: () => page.evaluate(() => ({ info: window.jfswLobby, shown: !document.getElementById('lobby').hidden, code: document.getElementById('lobbycode').textContent,
      link: document.getElementById('lobbylink').value, players: document.getElementById('lobbyplayers').textContent, state: document.getElementById('lobbystate').textContent,
      startHidden: document.getElementById('lobbystart').hidden, startDisabled: document.getElementById('lobbystart').disabled, url: location.href })).catch(() => null),
    out: () => page.evaluate(() => window.jfswOut.join('\n')).catch(() => ''),
    async state() { return Promise.race([page.evaluate(() => window.jfswState).catch(() => 'gone'), sleep(900).then(() => 'running')]); },
    async dumpSize() {
      return page.evaluate((f) => { try { return window.jfswTest.FS.stat('/persist/' + f).size; } catch (er) { return 0; } }, o.dump || 'd.bin').catch(() => 0);
    },
    async readFile(name) {
      const b64 = await page.evaluate((f) => { const b = window.jfswTest.readFile(f); return b ? btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')) : null; }, name);
      return b64 === null ? null : Buffer.from(b64, 'base64');
    },
    async readDump() { return m.readFile(o.dump || 'd.bin'); },
    async exitCode() { return page.evaluate(() => (window.jfswExit ? window.jfswExit.code : null)).catch(() => null); },
    async status() { return page.evaluate(() => document.getElementById('status').textContent).catch(() => ''); },
    async waitEnd(ms) {
      const t0 = now();
      while (now() - t0 < ms) { const s = await m.state(); if (s === 'ended' || s === 'error') { return s; } await sleep(250); }
      return 'timeout';
    },
    async stop() { try { await context.close(); } catch (er) { /* gone */ } },
  };
  machines.push(m);
  return m;
}

// A native machine (scripts/run-headless.sh). o.relay is HOST:PORT; o.impair a VNET_IMPAIR spec; o.sw another binary than
// NETPLAY_SW or ./sw.
function nativeMachine(name, args, o) {
  o = o || {};
  const wd = path.join(tmp(), name);
  fs.mkdirSync(wd, { recursive: true });
  const outFile = path.join(wd, '..', name + '.out');
  const envv = Object.assign({}, process.env);
  if (o.impair) { envv.VNET_IMPAIR = o.impair; } else { delete envv.VNET_IMPAIR; }
  const m = {
    kind: 'native', name, wd, started: 0, errors: [],
    async start() {
      const out = fs.openSync(outFile, 'w');
      if (o.cfg) { fs.writeFileSync(path.join(wd, 'sw.cfg'), o.cfg); }      // brief 05: e.g. the relay setting
      m.child = spawn(path.join(L.root, 'scripts', 'run-headless.sh'), ['--workdir', wd, '--timeout', String(o.timeout || 400)].concat(o.sw || process.env.NETPLAY_SW ? ['--sw', o.sw || process.env.NETPLAY_SW] : [], ['--'], args),
        { env: envv, stdio: [o.stdin ? 'pipe' : 'ignore', out, out], detached: true });
      m.done = new Promise((r) => m.child.on('exit', (c, s) => { m.code = c; r(c); }));
      m.started = now();
    },
    out: async () => { try { return fs.readFileSync(outFile, 'utf8'); } catch (e) { return ''; } },
    type(line) { m.child.stdin.write(line + '\n'); },     // with o.stdin: a line on the game's standard input ("start")
    async state() { return m.code === undefined ? 'running' : (m.code === 0 ? 'ended' : 'error'); },
    async dumpSize() { try { return fs.statSync(path.join(wd, o.dump || 'd.bin')).size; } catch (e) { return 0; } },
    async readFile(name) { try { return fs.readFileSync(path.join(wd, name)); } catch (e) { return null; } },
    async readDump() { return m.readFile(o.dump || 'd.bin'); },
    async exitCode() { return m.code === undefined ? null : m.code; },
    async status() { return ''; },
    async waitEnd(ms) {
      const t0 = now();
      while (now() - t0 < ms) { if (m.code !== undefined) { return m.code === 0 ? 'ended' : 'error'; } await sleep(250); }
      return 'timeout';
    },
    async stop() {
      if (m.child && m.code === undefined) { try { process.kill(-m.child.pid, 'SIGTERM'); } catch (e) { /* gone */ } await Promise.race([m.done, sleep(6000)]); try { process.kill(-m.child.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    },
  };
  machines.push(m);
  return m;
}

async function waitRoomCode(m, ms) {
  const t0 = now();
  while (now() - t0 < (ms || 40000)) {
    const mm = /room code ([A-Z2-9]{6})/.exec(await m.out());
    if (mm) { return mm[1]; }
    if ((await m.state()) === 'error') { break; }
    await sleep(150);
  }
  throw new Error(m.name + ' never printed a room code');
}

// Stops everything a scenario started and checks that nothing of it is left (a native game, a relay).
async function cleanup(relay) {
  for (const m of machines.splice(0)) { await m.stop(); }
  if (relay) { await relay.stop(); }
  await closeEnv();
  let orphans = [];
  if (tmpRoot) {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) { continue; }
      let cwd = '';
      try { cwd = fs.readlinkSync('/proc/' + d + '/cwd'); } catch (e) { continue; }
      if (cwd.startsWith(tmpRoot)) {
        let cmd = ''; try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8').replace(/\0/g, ' ').slice(0, 80); } catch (e) { /* gone */ }
        orphans.push(d + ' ' + cmd);
        try { process.kill(+d, 'SIGKILL'); } catch (e) { /* gone */ }
      }
    }
    if (!process.env.JFSW_TEST_KEEP) { fs.rmSync(tmpRoot, { recursive: true, force: true }); } else { console.log('kept: ' + tmpRoot); }
    tmpRoot = null;
  }
  check(orphans.length === 0, 'no process this test started is left running', orphans.join('; '));
}

// ---- what a finished game must show ---------------------------------------------------------------

// All machines: exit 0, the TEST line, no desync, no version mismatch; then the dumps: at least `tics` records
// each, and identical record for record. Returns the dumps.
async function checkGame(ms, tics, opts) {
  opts = opts || {};
  const dumps = [];
  for (const m of ms) {
    const out = await m.out();
    const code = await m.exitCode();
    check(code === 0, m.name + ' ended with status 0', 'status ' + code + ': ' + (await m.status()) + ' ' + out.split('\n').slice(-4).join(' | '));
    const line = /TEST: quitting after (\d+) game tics: (\d+) sync checks, (\d+) mismatches, (\d+) sync bytes, player (\d+) of (\d+)/.exec(out);
    check(!!line && +line[1] >= tics, m.name + ' played ' + (line ? line[1] : '?') + ' game tics (need ' + tics + ')');
    if (!opts.desyncExpected) {
      check(!/OUT OF SYNC/.test(out), m.name + ' logged no desync');
    }
    check(!/CheckVersion\(\)/.test(out), m.name + ' saw no version mismatch');
    check(m.errors.length === 0, m.name + ' had no page errors', m.errors.join('; '));
    dumps.push(await m.readDump());
  }
  if (!opts.desyncExpected) { await compareDumps(ms, dumps, tics); }
  return dumps;
}

// <dump>.state (sync.c TestStateFull): lines "<when> <kind> <index> field=value ...". Returns Map "when kind index" -> Map field -> value.
function parseState(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    const w = line.split(' ');
    if (w.length < 2) { continue; }
    const kind = w[1], noIndex = ['global', 'freelist', 'hash'].includes(kind);
    const key = w[0] + ' ' + kind + (noIndex ? '' : ' ' + w[2]);
    const rest = w.slice(noIndex ? 2 : 3), f = new Map();
    if (['statlist', 'freelist', 'hash'].includes(kind)) { f.set('list', rest.join(' ')); } else { for (const t of rest) { const i = t.indexOf('='); if (i > 0) { f.set(t.slice(0, i), t.slice(i + 1)); } } }
    m.set(key, f);
  }
  return m;
}
// The fields two machines' state dumps disagree about at `when` (e.g. 't1'). Fields that are this machine's own and not simulation
// state are left out (myconnectindex, krandcount, numframes, the input queue's movefifoend, a player's FadeAmt, FadeTics and
// NightVision, and the fields a sprite line lists in drawscratch=: what the drawing code keeps there), and code and data addresses
// (values ending in '@') when the machines run different builds. FadeAmt and FadeTics (brief 04c) are the screen flash when a
// player is hurt or picks something up: PlayerUpdateHealth() (panel.c) and the other callers of SetFadeAmt() (menus.c) set them
// only for the player this machine looks through (screenpeek), so in the original game they differ between machines as soon as a
// player is hurt; nothing but the palette code reads them (DoPaletteFlash, SetFadeAmt). NightVision likewise: only
// DoPlayerNightVisionPalette() (inv.c) sets it, only for screenpeek, and only drawing (analyzesprites) and the F11 key read it.
// None of the three is in the state hash.
function stateDifferences(a, b, when, mixed) {
  const ignore = new Set(['global myconnectindex', 'global krandcount', 'global numframes', 'player movefifoend', 'player FadeAmt', 'player FadeTics', 'player NightVision']);
  const out = [];
  const keys = new Set([...a.keys(), ...b.keys()].filter((k) => k.startsWith(when + ' ')));
  for (const k of keys) {
    const fa = a.get(k), fb = b.get(k), kind = k.split(' ')[1];
    if (!fa || !fb) { out.push(k.slice(when.length + 1) + ' only on ' + (fa ? 'the first' : 'the second')); continue; }
    for (const f of new Set([...fa.keys(), ...fb.keys()])) {
      const va = fa.get(f), vb = fb.get(f);
      if (va === vb || ignore.has(kind + ' ' + f) || (fa.get('drawscratch') || '').split(',').includes(f)) { continue; }
      if (mixed && (/@$/.test(va || '') || /@$/.test(vb || ''))) { continue; }
      out.push(k.slice(when.length + 1) + ' ' + f + ': ' + va + ' against ' + vb);
    }
  }
  return out;
}

// First index (tic) where the dumps differ, or -1; describes what differs.
function firstDifference(dumps) {
  const n = Math.min(...dumps.map((d) => Math.floor(d.length / REC)));
  for (let i = 0; i < n; i++) {
    for (let k = 1; k < dumps.length; k++) {
      const a = dumps[0].subarray(i * REC, (i + 1) * REC), b = dumps[k].subarray(i * REC, (i + 1) * REC);
      if (!a.equals(b)) {
        const diff = [];
        const names = ['tic0', 'tic1', 'tic2', 'tic3', 'RandomSync', 'PlayerSync', 'PlayerSync2', 'SOSync', 'EnemySync', 'MissileSync', 'ShrapSync', 'MiscSync', 'MissileSkip4Sync', 'hash0', 'hash1', 'hash2', 'hash3'];
        for (let j = 0; j < REC; j++) { if (a[j] !== b[j]) { diff.push(names[j]); } }
        let count = 0;
        const n2 = Math.min(dumps[0].length, dumps[k].length) / REC;
        for (let q = i; q < n2; q++) { if (!dumps[0].subarray(q * REC, (q + 1) * REC).equals(dumps[k].subarray(q * REC, (q + 1) * REC))) { count++; } }
        return { index: i, tic: a.readUInt32LE(0), against: k, what: diff.join(',') + ' (' + count + ' of the ' + (n2 - i) + ' records from there on differ; first: ' + a.toString('hex') + ' against ' + b.toString('hex') + ')' };
      }
    }
  }
  return null;
}

async function compareDumps(ms, dumps, tics) {
  const ok = dumps.every((d) => d && d.length % REC === 0 && d.length / REC >= tics);
  check(ok, 'every machine wrote at least ' + tics + ' tics to its dump (' + dumps.map((d) => d ? d.length / REC : 'none').join(', ') + ')');
  if (!ok) { return; }
  const diff = firstDifference(dumps);
  let fields = '';
  if (diff) {
    // the state dumps of the two machines at that tic, if there is one (-teststate: tics 1 to 3, and those NETPLAY_STATE names)
    const sa = await ms[0].readFile('d.bin.state'), sb = await ms[diff.against].readFile('d.bin.state');
    const when = 't' + diff.tic;
    if (sa && sb) {
      const a = parseState(sa.toString()), b = parseState(sb.toString());
      if ([...a.keys()].some((k) => k.startsWith(when + ' '))) {
        const d = stateDifferences(a, b, when, ms[0].kind !== ms[diff.against].kind);
        fields = '; the state dumps at ' + when + ' differ in ' + d.length + ' fields: ' + d.slice(0, 20).join('; ') + (d.length > 20 ? '; ...' : '');
      } else { fields = '; no state dump at ' + when + ' (NETPLAY_STATE=' + diff.tic + ' makes one)'; }
    }
  }
  check(!diff, 'all ' + ms.length + ' machines agree on every tic (' + dumps.map((d) => d.length / REC).join(', ') + ' tics each; byte for byte)',
    diff ? 'first difference at tic ' + diff.tic + ' (record ' + diff.index + '): ' + ms[0].name + ' against ' + ms[diff.against].name + ' differ in ' + diff.what + fields : '');
}

// ---- imitating a hidden tab (Bit Riot brief 12, "What the tests did instead of really hiding a tab") ----
// Playwright cannot hide a tab. The page is made to say it is hidden (document.hidden, visibilityState, a
// visibilitychange event) and, as Chromium does to a background tab, gets no animation frames and has its
// timers held to one run a second; WebSocket, WebTransport and MessageChannel events are left alone.
async function hide(page, throttle) {
  await page.evaluate((thr) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    if (thr) {
      window.requestAnimationFrame = () => 0;
      const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
      window.setTimeout = (f, ms, ...a) => st(f, Math.max(+ms || 0, 1000), ...a);
      window.setInterval = (f, ms, ...a) => si(f, Math.max(+ms || 0, 1000), ...a);
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, !!throttle);
}

// Blocks a page's main thread for `ms` (a frozen tab, a sleeping laptop).
function freeze(page, ms) {
  return page.evaluate((n) => { const t = performance.now(); while (performance.now() - t < n) { /* frozen */ } }, ms).catch(() => {});
}

// ---- sampling the speed of a running game ----------------------------------------------------------
// Samples every machine's dump size once a second until all have written `until` tics or `limit` ms pass.
// Returns, per machine, the series [[ms since the sampling began, tics]].
async function sample(ms, until, limit, onTick) {
  const series = ms.map(() => []);
  const t0 = now();
  while (now() - t0 < limit) {
    // all machines at once, and a frozen page (its evaluate() waits for the freeze to end) keeps its last count
    const counts = await Promise.all(ms.map(async (m, i) => {
      const n = await Promise.race([m.dumpSize(), sleep(900).then(() => null)]);
      return n === null ? (series[i].length ? series[i][series[i].length - 1][1] : 0) : Math.floor(n / REC);
    }));
    let done = true;
    for (let i = 0; i < ms.length; i++) {
      series[i].push([now() - t0, counts[i]]);
      if (counts[i] < until && (await ms[i].state()) === 'running') { done = false; }
    }
    if (onTick) { await onTick(now() - t0, series); }
    if (done) { break; }
    await sleep(1000);
  }
  return series;
}
// Tics a second between the moment the machine reached tic `from` and tic `to`.
function rate(series, from, to) {
  let a = null, b = null;
  for (const [t, c] of series) { if (a === null && c >= from) { a = [t, c]; } if (c >= to) { b = [t, c]; break; } }
  if (a && !b) { b = series[series.length - 1]; }     // never got that far: the rate over what it did
  if (!a || !b || b[0] <= a[0]) { return 0; }
  return (b[1] - a[1]) / ((b[0] - a[0]) / 1000);
}

// ---- scenarios ---------------------------------------------------------------------------------------

const TICS = 1200;
const LOAD = () => 'load average ' + os.loadavg().map((x) => x.toFixed(1)).join(' ');

// Two or more machines in one room. `kinds` is a list of 'browser' | 'native' (the first hosts). Returns
// { ms, relay }. o: tics, query (page knobs, per machine index function), impair(i), hidden, nudge: {i: tic};
// onStart(i, m), called right after machine i is started; machine(i), more options for machine i's browserMachine() or
// nativeMachine() (old, sw).
async function room(relay, kinds, o) {
  o = o || {};
  const tics = o.tics || TICS;
  const ms = [];
  let code = '';
  for (let i = 0; i < kinds.length; i++) {
    const name = 'p' + i;
    const net = (kind) => (kind === 'browser'
      ? ['-relay', relay.ws].concat(i === 0 ? ['-host-room', String(kinds.length)] : ['-room', code])
      : ['-relay', relay.udp].concat(i === 0 ? ['-host-room', String(kinds.length)] : ['-room', code]));
    const args = gameArgs({ net: net(kinds[i]), tics, dump: 'd.bin', lag: o.lag ? 'l.bin' : '', nudge: o.nudge && o.nudge[i], autonet: o.autonet, state: o.state, extra: o.extra ? o.extra(i) : [] });
    const impair = o.impair ? o.impair(i) : null;
    let m;
    if (kinds[i] === 'browser') {
      const q = (o.query ? o.query(i, relay) : '') + (impair ? '&impair=' + encodeURIComponent(impair) : '');
      m = await browserMachine(name, args, Object.assign({ query: q, dump: 'd.bin' }, o.machine ? o.machine(i) : {}));
    } else {
      m = nativeMachine(name, args, Object.assign({ impair, dump: 'd.bin' }, o.machine ? o.machine(i) : {}));
    }
    ms.push(m);
    await m.start();
    if (o.onStart) { await o.onStart(i, m); }
    if (i === 0) { code = await waitRoomCode(m); console.log('  room ' + code + ' (' + kinds[0] + ' host)'); }
  }
  return ms;
}

// The transport each browser reports in its game log ("(relay-ws)" or "(relay-wt)").
async function transportOf(m) {
  const out = await m.out();
  const mm = /(relay-(?:ws|wt|udp))[;)]/.exec(out);
  return mm ? mm[1] : null;
}

async function bounded(name, kinds, o, expectTransport) {
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ' (' + LOAD() + ')');
    const ms = await room(relay, kinds, o);
    const limit = (o && o.tics ? o.tics : TICS) / NOMINAL * 1000 * 3 + 90000;
    for (const m of ms) { await m.waitEnd(limit - (now() - ms[0].started)); }
    console.log('  the game took ' + ((now() - ms[0].started) / 1000).toFixed(1) + ' s from the start of the host to the end of the last machine (' + ((o && o.tics) || TICS) + ' tics)');
    await checkGame(ms, (o && o.tics) || TICS);
    if (o && o.impair) {
      for (const m of ms) { if (m.kind === 'browser') { check(/test knobs in use:.*impair/.test(await m.out()), m.name + ' reports that the impairment knob is in use'); } }
    }
    if (expectTransport) {
      for (const m of ms) { if (m.kind === 'browser') { const t = await transportOf(m); check(t === expectTransport, m.name + ' used ' + expectTransport + ' (log says ' + t + ')'); } }
    }
    return ms;
  } finally { await cleanup(relay); }
}

const SCENARIOS = {};

SCENARIOS.ws = {
  what: 'two browsers over the WebSocket: 1200 tics, every machine agrees',
  run: () => bounded('ws', ['browser', 'browser'], {}, 'relay-ws'),
};
SCENARIOS.ws3 = {
  what: 'three browsers over the WebSocket: 1200 tics, every machine agrees',
  run: () => bounded('ws3', ['browser', 'browser', 'browser'], {}, 'relay-ws'),
};
SCENARIOS['browser-host'] = {
  what: 'a browser hosts, a native game joins (UDP to the relay): 1200 tics, dumps equal',
  run: () => bounded('browser-host', ['browser', 'native'], {}, 'relay-ws'),
};
SCENARIOS['native-host'] = {
  what: 'a native game hosts, a browser joins: 1200 tics, dumps equal',
  run: () => bounded('native-host', ['native', 'browser'], {}, 'relay-ws'),
};

const WT = (i, relay) => '&relay_wt=' + encodeURIComponent(relay.wt) + '&relay_cert=' + relay.cert;
SCENARIOS.wt = {
  what: 'two browsers over WebTransport (a -dev-cert relay, the certificate hash as a test knob), and a native player in the room',
  run: async () => {
    await bounded('wt', ['browser', 'browser'], { query: WT }, 'relay-wt');
    await bounded('wt-native', ['native', 'browser', 'browser'], { query: WT }, 'relay-wt');
  },
};

const IMPAIR = (i) => (process.env.NETPLAY_IMPAIR || 'lat=30,jit=10,loss=4,dup=2,reorder=3') + ',seed=' + (101 + i);     // (NETPLAY_IMPAIR: a harsher spec, as a control)
SCENARIOS.impaired = {
  what: 'loss, duplication, reordering and latency on every machine (a seed each): browser host and native slave over WebSocket, then three browsers',
  run: async () => {
    await bounded('impaired', ['browser', 'native'], { impair: IMPAIR }, 'relay-ws');
    await bounded('impaired3', ['browser', 'browser', 'browser'], { impair: IMPAIR }, 'relay-ws');
  },
};
SCENARIOS['impaired-wt'] = {
  what: 'the same over WebTransport: two browsers',
  run: () => bounded('impaired-wt', ['browser', 'browser'], { impair: IMPAIR, query: WT }, 'relay-wt'),
};

// ---- input-to-tic delay (brief 04b) ------------------------------------------------------------------
// Every machine also runs -testlag<file> (sync.c): 36 bytes a game tic, nine little endian 32 bit fields, one machine's own
// clock (microseconds): tic, made (this machine's own input for the tic), ready (every player's input is here), ran (the tic
// ran), sendwait (sendpacket() to the datagram leaving), fwdwait (master: ready to the combined packet being queued),
// otherminlag, bufferjitter, the sum of the totalclock corrections. The delay a player feels is ran - made.
const LREC = 36, LNONE = 0xFFFFFFFF;
function parseLag(buf) {
  const rows = [];
  for (let i = 0; i + LREC <= buf.length; i += LREC) {
    rows.push({ tic: buf.readUInt32LE(i), made: buf.readUInt32LE(i + 4), ready: buf.readUInt32LE(i + 8), ran: buf.readUInt32LE(i + 12),
      sendwait: buf.readUInt32LE(i + 16), fwdwait: buf.readUInt32LE(i + 20), minlag: buf.readInt32LE(i + 24), jitter: buf.readInt32LE(i + 28), corr: buf.readInt32LE(i + 32) });
  }
  return rows;
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function pct(a, p) {
  if (!a.length) { return NaN; }
  const b = a.slice().sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p / 100 * b.length))];
}
// median and 95th percentile (ms) of the delays, from tic `from` on
function lagStats(rows, from) {
  const r = rows.filter((x) => x.tic >= from);
  const ms = (f) => r.map(f).filter((v) => v >= 0 && v < 5e6).map((v) => v / 1000);
  const col = (name, f) => { const a = ms(f); return { name, n: a.length, med: pct(a, 50), p95: pct(a, 95), mean: mean(a) }; };
  const sw = r.filter((x) => x.sendwait !== LNONE).map((x) => x.sendwait / 1000);
  const fw = r.filter((x) => x.fwdwait !== LNONE).map((x) => x.fwdwait / 1000);
  const last = rows[rows.length - 1] || { corr: 0 };
  const lags = r.map((x) => x.minlag), jit = r.map((x) => x.jitter);
  return {
    total: col('input to tic', (x) => x.ran - x.made),
    toReady: col('input to complete', (x) => x.ready - x.made),
    wait: col('complete to tic', (x) => x.ran - x.ready),
    sendwait: { n: sw.length, med: pct(sw, 50), p95: pct(sw, 95), mean: mean(sw) },
    fwdwait: { n: fw.length, med: pct(fw, 50), p95: pct(fw, 95), mean: mean(fw) },
    minlag: { med: pct(lags, 50), min: Math.min(...lags), max: Math.max(...lags) },
    jitter: { med: pct(jit, 50), min: Math.min(...jit), max: Math.max(...jit) },
    corrections: rows.length ? last.corr : 0,
    // the clock corrections made after tic `from`, in clock ticks (a game tic is 3)
    corrLate: rows.length ? last.corr - (rows.find((x) => x.tic >= from) || last).corr : 0,
    // how many times the clock was corrected after tic `from`, and how often the direction reversed (an oscillation reverses every time)
    corrEvents: r.filter((x, i) => i > 0 && x.corr !== r[i - 1].corr).length,
    corrReversals: (() => { let n = 0, d = 0; for (let i = 1; i < r.length; i++) { const c = Math.sign(r[i].corr - r[i - 1].corr); if (c && d && c !== d) { n++; } if (c) { d = c; } } return n; })(),
  };
}
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
// "TEST: lag: 1234 datagrams (56789 bytes) to player 1 in 30000 ms" lines -> datagrams a second to each peer
function datagramRates(out) {
  const r = [];
  const re = /TEST: lag: (\d+) datagrams \((\d+) bytes\) to player (\d+) in (\d+) ms(?:: (\d+) with new data, (\d+) paced \(acks and resends only\), (\d+) of those)?/g;
  let m;
  while ((m = re.exec(out))) {
    r.push({ to: +m[3], n: +m[1], bytes: +m[2], perSec: +m[1] / Math.max(1, +m[4]) * 1000, bytesPerSec: +m[2] / Math.max(1, +m[4]) * 1000,
      newData: m[5] === undefined ? NaN : +m[5], paced: m[6] === undefined ? NaN : +m[6], redundant: m[7] === undefined ? NaN : +m[7] });
  }
  return r;
}

// One measured game: `kinds` as for room(); o.impair(i) as there. Returns { ms, stats: per machine, rates: per machine }.
async function lagGame(label, kinds, o) {
  o = o || {};
  const relay = await startRelay();
  try {
    console.log('  ' + label + ': ' + kinds.join(' + ') + (o.impair ? ', impaired' : '') + ' (' + LOAD() + ')');
    const tics = o.tics || TICS;
    const ms = await room(relay, kinds, Object.assign({}, o, { lag: true, tics }));
    const limit = tics / NOMINAL * 1000 * 3 + 90000;
    for (const m of ms) { await m.waitEnd(limit - (now() - ms[0].started)); }
    const load = LOAD();
    await checkGame(ms, tics);
    const stats = [], rates = [];
    for (let i = 0; i < ms.length; i++) {
      const buf = await ms[i].readFile('l.bin');
      check(!!buf && buf.length >= LREC * tics, ms[i].name + ' wrote its lag record (' + (buf ? buf.length / LREC : 0) + ' tics)');
      const st = lagStats(buf ? parseLag(buf) : [], 200);
      stats.push(st);
      rates.push(datagramRates(await ms[i].out()));
      const role = i === 0 ? 'master' : 'slave ' + i;
      console.log('    ' + ms[i].name + ' (' + ms[i].kind + ' ' + role + '): input to tic ' + f1(st.total.med) + ' ms median, ' + f1(st.total.p95) + ' p95, ' + f1(st.total.mean) + ' mean'
        + '; own input to tic complete ' + f1(st.toReady.med) + ' / ' + f1(st.toReady.p95) + '; complete to tic ' + f1(st.wait.med) + ' / ' + f1(st.wait.p95)
        + '; sendpacket to datagram ' + f1(st.sendwait.med) + ' / ' + f1(st.sendwait.p95) + (i === 0 ? '; last input to combined packet ' + f1(st.fwdwait.med) + ' / ' + f1(st.fwdwait.p95) + ' (mean ' + f1(st.fwdwait.mean) + ')' : '')
        + '; otherminlag ' + st.minlag.med + ' (' + st.minlag.min + '..' + st.minlag.max + '), bufferjitter ' + st.jitter.med + ' (' + st.jitter.min + '..' + st.jitter.max + ')'
        + '; clock corrections after tic 200: ' + st.corrLate + ' clock ticks (' + st.corrections + ' in all)');
      console.log('    ' + ms[i].name + ' datagrams: ' + rates[i].map((r) => r.perSec.toFixed(1) + '/s to player ' + r.to + ' (' + r.bytesPerSec.toFixed(0) + ' B/s'
        + (Number.isFinite(r.paced) ? '; of ' + r.n + ': ' + r.newData + ' with new data, ' + r.paced + ' acks/resends only, ' + r.redundant + ' of those just before one with new data' : '') + ')').join(', '));
    }
    console.log('    ' + load);
    return { ms, stats, rates, load };
  } finally { await cleanup(relay); }
}
const LAT30 = (i) => 'lat=30,seed=' + (201 + i);       // 30 ms on everything a machine sends: 30 ms each way

SCENARIOS['lag-matrix'] = {
  manual: true,         // a report (about 7 minutes); run it by name. The checked version is the 'lag' scenario.
  what: 'input-to-tic delay of master and slave: browsers, browser and native, native and native; unimpaired and with 30 ms each way (a report; agreement is checked; only by name)',
  run: async () => {
    // NETPLAY_LAG_ONLY=browsers,natives-30ms picks games; NETPLAY_LAG_REPS=3 repeats each (the numbers move with the machine's load)
    const only = (process.env.NETPLAY_LAG_ONLY || '').split(',').filter(Boolean), reps = +process.env.NETPLAY_LAG_REPS || 1;
    for (let r = 0; r < reps; r++) {
      for (const [name, kinds] of [['browsers', ['browser', 'browser']], ['browser-host', ['browser', 'native']], ['native-host', ['native', 'browser']], ['natives', ['native', 'native']]]) {
        for (const [label, o] of [[name, {}], [name + '-30ms', { impair: LAT30 }]]) {
          if (only.length && !only.includes(label)) { continue; }
          const g = await lagGame(label, kinds, o);
          g.stats.forEach((st, i) => console.log('LAGSUM ' + label + ' ' + (i === 0 ? 'master' : 'slave') + ' ' + f1(st.total.med) + ' ' + f1(st.total.p95) + ' ' + f1(st.sendwait.med) + ' ' + f1(st.fwdwait.med) + ' ' + f1(st.fwdwait.p95) + ' ' + g.rates[i].map((x) => x.perSec.toFixed(1)).join(',') + ' mean ' + f1(st.total.mean) + ' fwdmean ' + f1(st.fwdwait.mean) + ' ' + g.load));
        }
      }
    }
  },
};

// Tic 1 (brief 04b). The drawing code keeps scratch values in two fields of the ceiling/floor picture override markers
// (FAF_DrawRooms, draw.c: the sector's stat and picnum while it draws), which differ between a machine that has drawn one frame
// and one that has drawn more. Once in about 80 games a machine ran tic 1 after a single frame and the dumps differed in the
// state hash for the first few tics; the hash now leaves those two fields out (sync.c TestStateHash). Here every game has that
// uneven start for certain: the master gets -testslowstart (it waits before its first frame with its clock running; the slave's
// first input is already there, so that frame makes the master's due inputs, forwards tic 0, and the master runs tic 1 straight
// after it, while the slave draws frames waiting for it). A slow slave would not do: its tic 1 needs a round trip to the master
// after its first frame. Every game must agree record for record and field for field (-teststate dumps at the start and tics 1
// to 3), and in every game the master must have run tic 1 after exactly one frame and the slave after more.
const SLOW_START_MS = 3000;     // longer than a browser slave takes to write its first state dump (1 to 2 s here)
SCENARIOS.tic1 = {
  what: 'a master that drew one frame before tic 1 (-testslowstart) and a slave that drew many agree, record for record and field by field',
  run: async () => {
    const tics = 60;
    let uneven = 0, games = 0;
    const slow = 0;
    for (const kinds of [['browser', 'native'], ['browser', 'browser'], ['native', 'browser'], ['native', 'native']]) {
      for (let g = 0; g < 2; g++) {
        const relay = await startRelay();
        try {
          console.log('  ' + kinds.join(' + ') + ', game ' + (g + 1) + ': the master starts ' + SLOW_START_MS + ' ms late (' + LOAD() + ')');
          const ms = await room(relay, kinds, { tics, state: true, extra: (i) => (i === slow ? ['-testslowstart' + SLOW_START_MS] : []) });
          for (const m of ms) { await m.waitEnd(90000 - (now() - ms[0].started)); }
          await checkGame(ms, tics);
          const st = [];
          for (const m of ms) { const b = await m.readFile('d.bin.state'); st.push(b ? parseState(b.toString()) : null); }
          check(st.every(Boolean), 'every machine wrote its state dump');
          if (!st.every(Boolean)) { continue; }
          const frames = st.map((a) => { const f = (w) => +a.get(w + ' global').get('numframes'); return f('t1') - f('start'); });
          games++;
          const ok = frames[slow] === 1 && frames[1 - slow] > 1;
          if (ok) { uneven++; }
          check(ok, 'p' + slow + ' (slow start) ran tic 1 after one frame and p' + (1 - slow) + ' after more (frames drawn before tic 1: ' + frames.join(', ') + ')');
          for (let k = 1; k < ms.length; k++) {
            for (const when of ['start', 't1', 't2', 't3']) {
              const d = stateDifferences(st[0], st[k], when, ms[0].kind !== ms[k].kind);
              check(d.length === 0, ms[0].name + ' and ' + ms[k].name + ' agree field by field at ' + when, d.slice(0, 10).join('; '));
            }
          }
        } finally { await cleanup(relay); }
      }
    }
    check(games === 8 && uneven === games, 'every game had the uneven start (' + uneven + ' of ' + games + ')');
  },
};

// The checked measurement (brief 04b): three games, each with every machine's -testlag record. The bounds are on the mechanisms
// the brief changed, which do not move with the container's load: how long this machine's input (or the master's combined packet)
// waits in mmulti between sendpacket() and a datagram leaving (step 2: it was the 25 ms PAKRATE window, 15 to 28 ms at the median
// before), and how long the master holds a complete tic before it hands the combined packet to mmulti (step 3: it waited for the
// master's next own input, up to a tic; p95 19 to 23 ms before). The delay a player feels (input made to tic run) is checked only
// where it is steady: two native games with 30 ms each way (64 ms at the median after, 103 to 126 before); in browser games it
// moves too much with the load to be a fair bound and is reported. The datagram rate per peer must stay within twice the old
// ceiling (one datagram per peer per 25 ms, 40 a second).
const LAG = { sendwait: 5, fwdP95: 8, fwdMed: 2, nativeSlave30: 85, rate: 80 };
function lagChecks(label, g, o) {
  g.stats.forEach((st, i) => {
    const who = label + ' ' + g.ms[i].name + ' (' + g.ms[i].kind + (i === 0 ? ' master' : ' slave') + ')';
    check(st.sendwait.n > 100 && st.sendwait.med < LAG.sendwait, who + ': its packets wait under ' + LAG.sendwait + ' ms in mmulti at the median (' + f1(st.sendwait.med) + ' ms, p95 ' + f1(st.sendwait.p95) + ', ' + st.sendwait.n + ' tics)');
    if (i === 0) {
      check(st.fwdwait.n > 100 && st.fwdwait.p95 < LAG.fwdP95 && st.fwdwait.med < LAG.fwdMed, who + ': a complete tic is forwarded within ' + LAG.fwdMed + ' ms at the median and ' + LAG.fwdP95 + ' ms at p95 (' + f1(st.fwdwait.med) + ' / ' + f1(st.fwdwait.p95) + ' ms, mean ' + f1(st.fwdwait.mean) + ')');
    }
    for (const r of g.rates[i]) { check(r.perSec <= LAG.rate, who + ': at most ' + LAG.rate + ' datagrams a second to player ' + r.to + ' (' + r.perSec.toFixed(1) + ')'); }
    check(g.rates[i].length === (i === 0 ? g.ms.length - 1 : 1), who + ' reported its datagram count');
    check(st.corrEvents <= 10 && st.corrReversals <= 2, who + ': the lag correction does not oscillate (after tic 200: ' + st.corrEvents + ' clock corrections, at most 10, '
      + st.corrReversals + ' reversals, at most 2; ' + st.corrLate + ' clock ticks in all; otherminlag ' + st.minlag.med + ' (' + st.minlag.min + '..' + st.minlag.max + '), bufferjitter ' + st.jitter.med + ')');
  });
  if (o && o.slaveBound) {
    const st = g.stats[1];
    check(st.total.med < o.slaveBound, label + ' slave: input to tic under ' + o.slaveBound + ' ms at the median (' + f1(st.total.med) + ' ms, p95 ' + f1(st.total.p95) + ', ' + g.load + ')');
  }
}
SCENARIOS.lag = {
  what: 'input-to-tic delay (brief 04b): inputs leave when made, the master forwards a complete tic at once, datagram rate bounded, all agree',
  run: async () => {
    let g = await lagGame('browsers', ['browser', 'browser'], {});
    lagChecks('browsers', g);
    g = await lagGame('native-host', ['native', 'browser'], {});
    lagChecks('native-host', g);
    g = await lagGame('natives-30ms', ['native', 'native'], { impair: LAT30 });
    lagChecks('natives-30ms', g, { slaveBound: LAG.nativeSlave30 });
  },
};

// A hidden, throttled tab as slave or as host: the room must keep at least 90 % of the nominal tic rate, measured on
// the OTHER machine (the one that is visible), over at least 30 s; and everyone still agrees.
const HIDDEN_TICS = 1500, FROM = 250, TO = 1450;
async function hiddenRoom(kinds, hiddenIndex, opts) {
  opts = opts || {};
  const want = (opts.nominal || NOMINAL);
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ', ' + (hiddenIndex === 0 ? 'the host' : 'the slave') + ' hidden (' + LOAD() + ')');
    const ms = await room(relay, kinds, { tics: opts.tics || HIDDEN_TICS, query: opts.wakeEvery ? (i) => (i === hiddenIndex ? '&wake_every=' + opts.wakeEvery : '') : null });
    const h = ms[hiddenIndex];
    let hideTic = -1, tHide = 0, hidden = false, framesAtHide = 0, hiddenLogAtHide = 0, froze = false, fp = null;
    const series = await sample(ms, opts.tics || HIDDEN_TICS, HIDDEN_TICS / NOMINAL * 1000 * 2.5 + 40000, async (t, ser) => {
      const tics = ser[hiddenIndex][ser[hiddenIndex].length - 1][1];
      if (!hidden && tics >= 100 && h.kind === 'browser') {
        hidden = true;
        await hide(h.page, true);
        await sleep(300);
        framesAtHide = await h.page.evaluate(() => Module.jfswShowframes);
        hiddenLogAtHide = await h.page.evaluate(() => Module.jfswHiddenLog.length);
        hideTic = Math.floor((await h.dumpSize()) / REC);
        tHide = now();
        console.log('  ' + h.name + ' hidden at tic ' + hideTic);
      }
      if (opts.freeze && hidden && !froze && tics >= 300) {
        froze = true;
        console.log('  freezing the hidden ' + h.name + ' for ' + opts.freeze + ' ms at tic ' + tics);
        fp = freeze(h.page, opts.freeze);      // not awaited: the others are watched meanwhile
      }
    });
    if (fp) { await fp; }
    const tEnd = now();
    const logEnd = await h.page.evaluate(() => Module.jfswHiddenLog.length).catch(() => 0);
    for (const m of ms) { await m.waitEnd(30000); }
    const wakes = await h.page.evaluate(() => ({ wakes: Module.jfswWakes, log: Module.jfswHiddenLog.length, frames: Module.jfswShowframes, reasons: Module.jfswHiddenLog.reduce((a, r) => { a[r] = (a[r] || 0) + 1; return a; }, {}), owed: Module.jfswOwedLog.slice() })).catch(() => null);
    await checkGame(ms, opts.tics || HIDDEN_TICS);
    // The rate window starts a margin after the tab was hidden (and after the stall and the catching up, if there was one).
    const fromT = Math.max(opts.freeze ? 700 : FROM, hideTic + 100);
    check(hideTic >= 0 && hideTic + 100 <= fromT, h.name + ' was hidden at tic ' + hideTic + ', before the rate window (tic ' + fromT + ' to ' + TO + ') began');
    const rates = ms.map((m, i) => rate(series[i], fromT, TO));
    console.log('  tic rates between tic ' + fromT + ' and ' + TO + ': ' + ms.map((m, i) => m.name + (i === hiddenIndex ? '(hidden)' : '') + ' ' + rates[i].toFixed(1)).join(', ') + ' (nominal ' + want + '); ' + LOAD());
    for (let i = 0; i < ms.length; i++) {
      if (i === hiddenIndex) { continue; }
      check(rates[i] >= 0.9 * want, ms[i].name + ' (visible) ran at ' + rates[i].toFixed(1) + ' tics a second, at least 90% of ' + want, 'got ' + rates[i].toFixed(1));
    }
    check(rates[hiddenIndex] >= 0.9 * want, h.name + ' (hidden) ran at ' + rates[hiddenIndex].toFixed(1) + ' tics a second too', 'got ' + rates[hiddenIndex].toFixed(1));
    if (opts.freeze) {
      // The visible machines go on producing inputs (up to 100 ahead) while the hidden tab is stuck; when it runs again the
      // game's own lag correction (a slave moves its clock on by the lag it measures, net.c) lets it hand them in faster than
      // 40 a second, so the room is late by less than the whole stall.
      const v = series[ms.findIndex((m, i) => i !== hiddenIndex)];
      const t0 = (v.find((x) => x[1] >= 300) || [0])[0], t1 = (v.find((x) => x[1] >= 1400) || [0])[0];
      const late = (t1 - t0) / 1000 - (1400 - 300) / NOMINAL;
      console.log('  the visible machine took ' + ((t1 - t0) / 1000).toFixed(1) + ' s for tics 300 to 1400 (' + ((1400 - 300) / NOMINAL).toFixed(1) + ' s at the nominal rate): late by ' + late.toFixed(1) + ' s, after a ' + opts.freeze / 1000 + ' s stall');
      check(late < opts.freeze / 1000 - 1, 'the room made up most of the stall (late by ' + late.toFixed(1) + ' s, not the whole ' + opts.freeze / 1000 + ' s)', late.toFixed(1));
      check(late > 0.2, 'and the stall really delayed it (late by ' + late.toFixed(1) + ' s)');
    }
    if (wakes) {
      console.log('  hidden tab: ' + wakes.wakes + ' wake-ups, ' + wakes.log + ' hidden yields (resumed by: ' + JSON.stringify(wakes.reasons) + ': 1 network event, 0 timer), ' + wakes.frames + ' pictures asked for in all (' + framesAtHide + ' when it was hidden)');
      // 200 as before for a hidden tab that gets every wake-up; a thinned one (hidden-thin) gets only
      // every Nth, so about 190 passes in all at N = 6: it needs a lower bar of its own.
      const minPasses = opts.wakeEvery ? 150 : 200;
      check(wakes.log - hiddenLogAtHide > minPasses, h.name + ' was driven by hidden-tab passes (' + (wakes.log - hiddenLogAtHide) + ' after it was hidden, more than ' + minPasses + ')');
      check((wakes.reasons[1] || 0) > 0.8 * wakes.log, h.name + ' was resumed by network events, not the timer (' + (wakes.reasons[1] || 0) + ' of ' + wakes.log + ')');
      // S1: an input that is made but held back by mmulti's 25 ms send window must not wait for the next network event: the pass
      // flushes it. So (almost) no yield is entered with data still owed.
      const passesPerSec = (logEnd - hiddenLogAtHide) / ((tEnd - tHide) / 1000);
      console.log('  hidden passes (yields) a second while hidden: ' + passesPerSec.toFixed(0) + '; entered with data still held back: ' + wakes.owed.length + ' of ' + wakes.log);
      check(wakes.owed.length <= 0.01 * wakes.log + 5, h.name + ' entered ' + wakes.owed.length + ' of ' + wakes.log + ' yields with data still held back (at most 1% and 5: a few come at the hide and at the end)');
      // CPU: the tab must not spin. Every pass is a network event or the timer.
      check(passesPerSec < 150, h.name + ' ran ' + passesPerSec.toFixed(0) + ' hidden passes a second (under 150: it waits for network events)');
      check(wakes.frames - framesAtHide < 20, h.name + ' drew nothing while hidden (' + (wakes.frames - framesAtHide) + ' pictures asked for after hiding, in about 35 s)');
    }
  } finally { await cleanup(relay); }
}
SCENARIOS['hidden-slave'] = {
  what: 'a hidden, throttled browser slave: the room keeps at least 90% of 40 tics a second, all agree',
  run: () => hiddenRoom(['browser', 'browser'], 1),
};
SCENARIOS['hidden-frozen'] = {
  what: 'a hidden slave whose main thread is stuck for 3 s mid-game: the room waits, catches up most of the stall, and every machine agrees',
  run: () => hiddenRoom(['browser', 'browser'], 1, { freeze: 3000 }),
};
// The same with the hidden tab's network wake-ups thinned to every 6th (as if the peer were quiet, or the events bunched):
// the pass must make every input that is due, and keep asking for passes until what it made has been sent.
SCENARIOS['hidden-thin'] = {
  what: 'a hidden slave that gets only every 6th network wake-up: still 90% of 40 tics a second, held-back data is flushed at once',
  run: () => hiddenRoom(['browser', 'browser'], 1, { wakeEvery: +process.env.NETPLAY_WAKE_EVERY || 6 }),
};
SCENARIOS['hidden-host'] = {
  what: 'a hidden, throttled browser host with a native slave: the same',
  run: () => hiddenRoom(['browser', 'native'], 0),
};

// ---- a tab hidden before the level's first frame (brief 04c, bugs.md L19) ----------------------------
// Drawing leaves something behind for good: every frame clears the parallax bit of the ceiling/floor picture override sectors
// (FAF_DrawRooms, draw.c), and the game reads that bit every tic. In the original game every machine draws before tic 1. A
// hidden tab (brief 04's hidden pass) draws nothing, so it kept the map's bits and was out of sync from tic 1 on; since brief
// 04c every machine applies that effect when the level is set up (DrawSetupLevelStats, draw.c). Here the tab is made hidden
// as soon as its game is started, before the level loads: document.hidden at once, and the throttling of a background tab
// (no animation frames, timers once a second) as soon as its relay session is up, so that the start-up before it is not
// held to one timer run a second. It then never draws a frame of the level: its numframes (state dumps) must not move
// from the level's start to its last tic. Every record and every field must agree with the machines that did draw, at the
// level's start, at tics 1 to 3 and at the last tic, and the override sectors must have no parallax bit at tic 1.
const HF_TICS = 400;
async function hideFromStart(m) {
  await hide(m.page, false);
  m.throttled = (async () => {
    const t0 = now();
    while (now() - t0 < 90000) {
      if (/room code [A-Z2-9]{6}|joined room/.test(await m.out())) { await hide(m.page, true); return true; }
      if ((await m.state()) !== 'running') { return false; }
      await sleep(100);
    }
    return false;
  })();
}
// The sector stat bits of the planes the ceiling/floor picture override markers (the sprites with drawscratch=) change.
function overridePlanes(st, when) {
  const r = [];
  for (const [k, f] of st) {
    if (!k.startsWith(when + ' spr ') || !f.has('drawscratch')) { continue; }
    const sec = f.get('sectnum'), plane = f.get('clipdist') === '0' ? 'ceilingstat' : 'floorstat';
    const s = st.get(when + ' sec ' + sec);
    r.push({ sector: +sec, plane, plax: s ? (parseInt(s.get(plane), 16) & 1) : -1 });
  }
  return r;
}
// One game. kinds as for room(); hiddenIdx: the machine hidden from its start. o.levels: what each level played must show,
// [{ prefix: '' or 'L2.', last: its last tic with a state dump, sectors: its numsectors }]; o.extra(i): more arguments;
// o.log: { re, what }, a line every machine must have printed.
async function hiddenFirstGame(kinds, hiddenIdx, o) {
  o = o || {};
  const tics = o.tics || HF_TICS;
  const levels = o.levels || [{ prefix: '', last: tics }];
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ', ' + (hiddenIdx === 0 ? 'the host' : 'p' + hiddenIdx) + ' hidden from its start (' + LOAD() + ')');
    const ms = await room(relay, kinds, { tics, state: true, autonet: o.autonet,
      extra: (i) => levels.map((l) => '-teststate' + l.last).concat(o.extra ? o.extra(i) : []),
      onStart: async (i, m) => { if (i === hiddenIdx) { await hideFromStart(m); } } });
    const h = ms[hiddenIdx];
    const limit = (o.limitTics || tics) / NOMINAL * 1000 * 3 + 120000;
    for (const m of ms) { await m.waitEnd(limit - (now() - ms[0].started)); }
    check(await h.throttled, h.name + ' was throttled as a background tab once its relay session was up');
    const hl = await h.page.evaluate(() => ({ log: Module.jfswHiddenLog.length, frames: Module.jfswShowframes, net: Module.jfswHiddenLog.filter((r) => r === 1).length })).catch(() => null);
    console.log('  the game took ' + ((now() - ms[0].started) / 1000).toFixed(1) + ' s; ' + h.name + ': ' + (hl ? hl.log + ' hidden passes (' + hl.net + ' resumed by a network event), ' + hl.frames + ' pictures asked for in all' : 'no counters'));
    check(!!hl && hl.log > 100, h.name + ' was driven by hidden-tab passes (' + (hl ? hl.log : 0) + ')');
    await checkGame(ms, tics);
    if (o.log) {
      for (const m of ms) { check(o.log.re.test(await m.out()), m.name + ' ' + o.log.what); }
    }
    const st = [];
    for (const m of ms) { const b = await m.readFile('d.bin.state'); st.push(b ? parseState(b.toString()) : null); }
    check(st.every(Boolean), 'every machine wrote its state dump');
    if (!st.every(Boolean)) { return { ms, st }; }
    for (const l of levels) {
      const whens = ['start', 't1', 't2', 't3', 't' + l.last].map((w) => l.prefix + w);
      const missing = st.map((a, i) => whens.filter((w) => !a.has(w + ' global')).map((w) => ms[i].name + ' ' + w)).flat();
      check(missing.length === 0, 'every machine has the state dumps ' + whens.join(', '), missing.join(', '));
      if (missing.length) { continue; }
      if (l.sectors) {
        const ns = st.map((a) => +a.get(l.prefix + 'start global').get('numsectors'));
        check(ns.every((n) => n === l.sectors), 'the level ' + (l.prefix || 'first ') + 'played is the one asked for (' + ns.join(', ') + ' sectors, want ' + l.sectors + ')');
      }
      const frames = (a, w) => +a.get(l.prefix + w + ' global').get('numframes') - +a.get(l.prefix + 'start global').get('numframes');
      for (let i = 0; i < ms.length; i++) {
        const f1 = frames(st[i], 't1'), fl = frames(st[i], 't' + l.last);
        if (i === hiddenIdx) {
          check(f1 === 0 && fl === 0, ms[i].name + ' (hidden) drew no frame of the level ' + l.prefix + ' (frames from its start to tic 1: ' + f1 + ', to tic ' + l.last + ': ' + fl + ')');
        } else {
          check(f1 > 0, ms[i].name + ' (visible) drew before tic 1, as every machine does in the original game (' + f1 + ' frames)');
        }
      }
      for (let k = 1; k < ms.length; k++) {
        for (const w of whens) {
          const d = stateDifferences(st[0], st[k], w, ms[0].kind !== ms[k].kind);
          check(d.length === 0, ms[0].name + ' and ' + ms[k].name + ' agree field by field at ' + w, d.slice(0, 10).join('; '));
        }
      }
      for (let i = 0; i < ms.length; i++) {
        const planes = overridePlanes(st[i], l.prefix + 't1');
        check(planes.length > 0 && planes.every((p) => p.plax === 0), ms[i].name + ': at ' + l.prefix + 't1 the override sectors have no parallax bit, as the first frame leaves them ('
          + planes.map((p) => 'sector ' + p.sector + ' ' + p.plane + ' ' + p.plax).join(', ') + ')');
      }
    }
    return { ms, st };
  } finally { await cleanup(relay); }
}
SCENARIOS['hidden-first'] = {
  what: 'a tab hidden before the level\'s first frame (bugs.md L19): it draws nothing and agrees record for record and field by field (native host, two browsers, three machines, a hidden browser host)',
  run: async () => {
    await hiddenFirstGame(['native', 'browser'], 1);
    await hiddenFirstGame(['browser', 'browser'], 1);
    await hiddenFirstGame(['browser', 'browser', 'native'], 1);
    await hiddenFirstGame(['browser', 'native'], 0);
  },
};
// The same across a level change while hidden: every machine leaves E1L1 at tic HL_EXIT for E1L3 (-testexit, test-only: as a
// level exit switch, without the bonus screen, which waits for a key), which has six override sectors, and plays HF_TICS
// tics there; the hidden tab draws no frame of either level.
const HL_EXIT = 200, HL_LEVEL = 3, HL_SECTORS = 481;
const hiddenLevel = (kinds, hiddenIdx) => hiddenFirstGame(kinds, hiddenIdx, {
  extra: () => ['-testexit' + HL_EXIT + ',' + HL_LEVEL], limitTics: HL_EXIT + HF_TICS,
  log: { re: new RegExp('TEST: leaving the level at tic ' + HL_EXIT + ' for level ' + HL_LEVEL + '\\b'), what: 'left the first level at tic ' + HL_EXIT + ' for level ' + HL_LEVEL },
  levels: [{ prefix: '', last: HL_EXIT, sectors: 486 }, { prefix: 'L2.', last: HF_TICS, sectors: HL_SECTORS }] });
SCENARIOS['hidden-level'] = {
  what: 'the same across a level change while hidden: E1L1 to E1L3 at tic ' + HL_EXIT + ' (-testexit); native host and hidden browser, two browsers, a hidden browser host',
  run: async () => {
    await hiddenLevel(['native', 'browser'], 1);
    await hiddenLevel(['browser', 'browser'], 1);
    await hiddenLevel(['browser', 'native'], 0);
  },
};

// ---- the tics of a level that ends (F3, bugs.md L20) ---------------------------------------------------
// After the tic that ends a level, the original MoveLoop went on running every further tic whose inputs were already in, so a
// machine played 0, 1 or more extra tics of the old level, depending on timing, and in co-op it carried what they changed
// (health, ammo, weapons) into the next level. Since F3 every machine stops at the exit tic. Here the level ends at tic LE_EXIT
// through -testexit (as an exit switch: ExitLevel is set inside the tic; nothing else stops MoveLoop since F3), and the
// master is made to hold the inputs of many tics after it: every slave's datagrams are 200 ms late (latency impairment), so
// a slave has made its inputs up to about 8 tics ahead of the tics it runs, and the master stops for 1.5 s inside the exit
// tic (-teststall), during which they all arrive. Before the fix the master then ran those tics and the slaves did not (they
// get the master's complete tics only as it runs them, and leave at the exit tic). Every player throws shurikens from tic
// LE_FIRE on (-testfire), about one every 8 tics, so the master's extra tics cost it ammo the slaves still count: at the next
// level the master runs out of shurikens first and the game goes out of sync. Checked: every machine played exactly LE_EXIT
// tics of the first level, record for record the same; the second level agrees record for record and field by field at its
// start, at tics 1 to 3 and at its last tic; the master had the inputs of more tics than it ran (so the old code would have
// run them); the players threw shurikens (their count fell before the exit and again in the second level). There is no state
// dump at the exit tic: writing one takes a browser a second or two, which would stall it there too.
const LE_EXIT = 200, LE_FIRE = 150, LE_TICS = 300, LE_STALL = 1500, LE_LAT = 200;
// The records of a -testdump file, split into the levels played (the tic count starts again at 1 in each level).
function dumpLevels(buf) {
  const levels = [];
  let last = Infinity;
  for (let i = 0; buf && i + REC <= buf.length; i += REC) {
    const t = buf.readUInt32LE(i);
    if (t <= last) { levels.push([]); }
    levels[levels.length - 1].push(buf.subarray(i, i + REC));
    last = t;
  }
  return levels;
}
async function levelExitGame(kinds) {
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ': the level ends at tic ' + LE_EXIT + ', the master stops for ' + LE_STALL + ' ms in that tic, the slaves\' datagrams are ' + LE_LAT + ' ms late (' + LOAD() + ')');
    const ms = await room(relay, kinds, { tics: LE_TICS, state: true,
      extra: (i) => ['-testexit' + LE_EXIT, '-testfire' + LE_FIRE, '-teststate' + LE_TICS].concat(i === 0 ? ['-teststall' + LE_EXIT + ',' + LE_STALL] : []),
      impair: (i) => (i === 0 ? null : 'lat=' + LE_LAT + ',seed=' + (301 + i)) });
    const limit = (LE_EXIT + LE_TICS) / NOMINAL * 1000 * 3 + LE_STALL + 120000;
    for (const m of ms) { await m.waitEnd(limit - (now() - ms[0].started)); }
    console.log('  the game took ' + ((now() - ms[0].started) / 1000).toFixed(1) + ' s');
    const dumps = await checkGame(ms, LE_TICS);
    const outs = [];
    for (const m of ms) { outs.push(await m.out()); }
    ms.forEach((m, i) => check(new RegExp('TEST: leaving the level at tic ' + LE_EXIT + ' for level 2\\b').test(outs[i]), m.name + ' left the first level at tic ' + LE_EXIT + ' for level 2'));
    check(new RegExp('TEST: stalling for ' + LE_STALL + ' ms at tic ' + LE_EXIT + '\\b').test(outs[0]), ms[0].name + ' (master) stopped for ' + LE_STALL + ' ms in the exit tic');
    // how many tics each machine played of the first level, and how many more tics' inputs it had (TestLevelEnd, sync.c)
    const ends = outs.map((o) => /TEST: left the level after tic (\d+), with the inputs of (-?\d+) more tics here/.exec(o));
    console.log('  first level: ' + ms.map((m, i) => m.name + ' left after tic ' + (ends[i] ? ends[i][1] : '?') + ' with the inputs of ' + (ends[i] ? ends[i][2] : '?') + ' more tics').join(', '));
    // (before the fix the master ran them, after it they are still in its fifo: either way it had them)
    check(!!ends[0] && +ends[0][1] + +ends[0][2] >= LE_EXIT + 2, ms[0].name + ' (master) had every player\'s inputs up to tic ' + (ends[0] ? +ends[0][1] + +ends[0][2] : '?') + ' when it left the first level (at least ' + (LE_EXIT + 2) + ': the test makes the case the original game got wrong)');
    const lv = dumps.map(dumpLevels);
    check(lv.every((l) => l.length === 2), 'every machine\'s dump has two levels (' + lv.map((l) => l.length).join(', ') + ')');
    if (!lv.every((l) => l.length === 2)) { return; }
    check(lv.every((l) => l[0].length === LE_EXIT), 'every machine played exactly ' + LE_EXIT + ' tics of the first level (' + lv.map((l) => l[0].length).join(', ') + ')');
    for (const k of [0, 1]) {
      const n = Math.min(...lv.map((l) => l[k].length));
      let first = -1, against = 0;
      for (let r = 0; r < n && first < 0; r++) { for (let i = 1; i < lv.length; i++) { if (!lv[i][k][r].equals(lv[0][k][r])) { first = r; against = i; break; } } }
      check(first < 0, 'level ' + (k + 1) + ': every machine\'s records agree (' + n + ' compared)', first >= 0 ? 'first difference at its tic ' + lv[0][k][first].readUInt32LE(0) + ': ' + ms[0].name + ' against ' + ms[against].name : '');
    }
    const st = [];
    for (const m of ms) { const b = await m.readFile('d.bin.state'); st.push(b ? parseState(b.toString()) : null); }
    check(st.every(Boolean), 'every machine wrote its state dump');
    if (!st.every(Boolean)) { return; }
    const whens = ['L2.start', 'L2.t1', 'L2.t2', 'L2.t3', 'L2.t' + LE_TICS];
    for (let k = 1; k < ms.length; k++) {
      for (const w of whens) {
        if (!st[0].has(w + ' global') || !st[k].has(w + ' global')) { check(false, ms[0].name + ' and ' + ms[k].name + ' have the state dump ' + w); continue; }
        const d = stateDifferences(st[0], st[k], w, ms[0].kind !== ms[k].kind);
        check(d.length === 0, ms[0].name + ' and ' + ms[k].name + ' agree field by field at ' + w, d.slice(0, 10).join('; '));
      }
    }
    // the control: shurikens were thrown before the exit and after it, so the extra tics would have changed the carried ammo
    const ammo = (w, p) => { const f = st[0].get(w + ' player ' + p); return f ? +f.get('WpnAmmo1') : NaN; };
    for (let p = 0; p < ms.length; p++) {
      const a = [ammo('start', p), ammo('L2.start', p), ammo('L2.t' + LE_TICS, p)];
      check(a[0] === 30 && a[1] > 0 && a[1] < a[0] && a[2] < a[1], 'player ' + p + ' threw shurikens before the exit and after it (count at the start, at the next level\'s start, at its tic ' + LE_TICS + ': ' + a.join(', ') + ')');
    }
  } finally { await cleanup(relay); }
}
SCENARIOS['level-exit'] = {
  what: 'a level exit while the master holds the inputs of later tics (bugs.md L20): every machine plays exactly the exit tic\'s tics and carries the same ammo into the next level (native host and browser, two browsers, browser host and native)',
  run: async () => {
    await levelExitGame(['native', 'browser']);
    await levelExitGame(['browser', 'browser']);
    await levelExitGame(['browser', 'native']);
  },
};

// A visible game is unchanged by brief 04c (only by name: it needs the build from before it). NETPLAY_OLD_SW (a native
// binary) and NETPLAY_OLD_WASM (a build of the page) are the old build; a machine of the old build and one of the new play in
// one room, both visible. The old build's drawing clears the override sectors' parallax bit in its first frame, the new one
// when the level is set up: so the two must agree on every record and on every field at tics 1 to 3, and their state when
// the level starts (before any frame) must differ in exactly those bits.
SCENARIOS['old-new'] = {
  manual: true,
  what: 'a visible game is unchanged by the fix: old and new builds in one room agree on every record and on every field at tics 1 to 3 (NETPLAY_OLD_SW, NETPLAY_OLD_WASM; only by name)',
  run: async () => {
    if (!process.env.NETPLAY_OLD_SW || !process.env.NETPLAY_OLD_WASM) { check(false, 'old-new needs NETPLAY_OLD_SW and NETPLAY_OLD_WASM'); return; }
    const tics = 60;
    // E1L1, and E1L3 (six override sectors, and two FLOOR_SLOPE_DONT_DRAW sectors whose slope bit the map already has)
    const E1L3 = '-autonet 2,2,2,1,0,0,0,0,0,0';
    for (const [kinds, old, autonet] of [[['native', 'native'], 0], [['native', 'native'], 1], [['browser', 'browser'], 0], [['browser', 'browser'], 1],
      [['browser', 'native'], 0], [['browser', 'native'], 1], [['native', 'browser'], 0], [['native', 'browser'], 1],
      [['native', 'native'], 0, E1L3], [['browser', 'native'], 1, E1L3], [['native', 'browser'], 0, E1L3]]) {
      const relay = await startRelay();
      try {
        console.log('  ' + kinds.map((k, i) => k + (i === old ? ' (old)' : ' (new)')).join(' + ') + (autonet ? ', E1L3' : ', E1L1') + ' (' + LOAD() + ')');
        const ms = await room(relay, kinds, { tics, state: true, autonet,
          machine: (i) => (i === old ? (kinds[i] === 'browser' ? { old: true } : { sw: process.env.NETPLAY_OLD_SW }) : {}) });
        for (const m of ms) { await m.waitEnd(90000 - (now() - ms[0].started)); }
        await checkGame(ms, tics);
        const st = [];
        for (const m of ms) { const b = await m.readFile('d.bin.state'); st.push(b ? parseState(b.toString()) : null); }
        check(st.every(Boolean), 'every machine wrote its state dump');
        if (!st.every(Boolean)) { continue; }
        for (const w of ['t1', 't2', 't3']) {
          const d = stateDifferences(st[0], st[1], w, true);
          check(d.length === 0, 'old and new agree field by field at ' + w, d.slice(0, 10).join('; '));
        }
        const d = stateDifferences(st[0], st[1], 'start', true);
        const want = overridePlanes(st[old], 'start').map((p) => 'sec ' + p.sector + ' ' + p.plane).sort();
        const got = d.map((x) => x.split(':')[0]).filter((x) => x !== 'hash list').sort();     // (the state hash covers those bits)
        console.log('  at the start: ' + d.join('; '));
        check(want.length > 0 && JSON.stringify(got) === JSON.stringify(want), 'at the level\'s start (no frame yet) they differ in exactly the override sectors\' stat (' + got.join(', ') + ')');
      } finally { await cleanup(relay); }
    }
  },
};

SCENARIOS['hidden-local'] = {
  what: 'a single player game in a hidden tab still pauses (no hidden-tab passes, the picture is still drawn)',
  run: async () => {
    try {
      const m = await browserMachine('single', ['-level1', '-s1', '-testdumpd.bin'], { dump: 'd.bin' });
      await m.start();
      // let it run visible for a while: a control, so that the hidden numbers mean something
      await sleep(14000);
      const t0 = await m.dumpSize() / REC, f0 = await m.page.evaluate(() => Module.jfswFrameLog.length);
      await sleep(5000);
      const t1 = await m.dumpSize() / REC, f1 = await m.page.evaluate(() => Module.jfswFrameLog.length);
      const visibleRate = (t1 - t0) / 5;
      check(visibleRate > 30, 'control: the visible single player game runs at ' + visibleRate.toFixed(1) + ' tics a second', 'got ' + visibleRate.toFixed(1));
      check(f1 - f0 > 100, 'control: and draws pictures (' + (f1 - f0) + ' frame yields in 5 s)');
      await hide(m.page, true);
      await sleep(2000);
      const h0 = await m.dumpSize() / REC, hf0 = await m.page.evaluate(() => Module.jfswFrameLog.length), hl0 = await m.page.evaluate(() => Module.jfswHiddenLog.length);
      await sleep(12000);
      const h1 = await m.dumpSize() / REC, hf1 = await m.page.evaluate(() => Module.jfswFrameLog.length), hl1 = await m.page.evaluate(() => Module.jfswHiddenLog.length);
      const hiddenRate = (h1 - h0) / 12;
      console.log('  hidden single player: ' + hiddenRate.toFixed(1) + ' tics a second, ' + (hf1 - hf0) + ' frame yields, ' + (hl1 - hl0) + ' hidden-tab passes in 12 s');
      check(hl1 === hl0, 'no hidden-tab passes in a single player game (' + (hl1 - hl0) + ')');
      check(hf1 - hf0 >= 5, 'the game still draws and yields once a frame (' + (hf1 - hf0) + ' frame yields in 12 s)');
      check(hiddenRate < 0.5 * visibleRate, 'it runs far below normal speed (' + hiddenRate.toFixed(1) + ' against ' + visibleRate.toFixed(1) + ' tics a second): a pause, not a free run');
    } finally { await cleanup(null); }
  },
};

// A tab whose main thread is blocked for 5 s in the middle of a game: the room waits, goes on, all agree.
const FREEZE_MS = +process.env.NETPLAY_FREEZE_MS || 5000;      // (a longer freeze is the negative control: the relay drops a silent member after 15 s)
async function frozenRoom(kinds, frozenIndex) {
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ', ' + (frozenIndex === 0 ? 'the host' : 'the slave') + ' frozen for ' + FREEZE_MS / 1000 + ' s (' + LOAD() + ')');
    const ms = await room(relay, kinds, { tics: TICS });
    const f = ms[frozenIndex];
    let froze = false, before = [], fp = null, t0 = 0, t1 = 0, tf = 0;
    const series = await sample(ms, TICS, TICS / NOMINAL * 1000 * 2.5 + FREEZE_MS + 40000, async (t, ser) => {
      const tics = ser[frozenIndex][ser[frozenIndex].length - 1][1];
      if (!froze && tics >= 300) {
        froze = true;
        before = ms.map((m, i) => ser[i][ser[i].length - 1][1]);
        console.log('  freezing ' + f.name + ' at tic ' + tics);
        t0 = now(); tf = t;
        fp = freeze(f.page, FREEZE_MS).then(() => { t1 = now(); });     // not awaited: the other machines are watched meanwhile
      }
    });
    if (fp) { await fp; }
    for (const m of ms) { await m.waitEnd(30000); }
    await checkGame(ms, TICS);
    check(froze, 'the tab was frozen in the middle of the game (at tic ' + before[frozenIndex] + ')');
    console.log('  ' + f.name + ' was frozen for ' + ((t1 - t0) / 1000).toFixed(1) + ' s');
    // the others could not move on without the frozen player's input: they stood still (in the samples taken once the
    // game was well under way), and then played on
    const other = ms.findIndex((m, i) => i !== frozenIndex);
    const o = series[other].filter((x) => x[1] >= 300);
    let stalled = 0, run = 0;
    for (let k = 1; k < o.length; k++) { if (o[k][1] - o[k - 1][1] <= 3) { run++; stalled = Math.max(stalled, run); } else { run = 0; } }
    const at = (ser, ms_) => { let c = 0; for (const [tt, n] of ser) { if (tt <= ms_) { c = n; } } return c; };
    const adv = at(series[other], tf + (t1 - t0)) - at(series[other], tf);
    console.log('  ' + ms[other].name + ' moved ' + adv + ' tics in the ' + ((t1 - t0) / 1000).toFixed(1) + ' s the other tab was frozen (nominal ' + (NOMINAL * FREEZE_MS / 1000) + ')');
    check(adv < 0.5 * NOMINAL * FREEZE_MS / 1000, ms[other].name + ' (not frozen) could not move on without the frozen player: ' + adv + ' tics in ' + FREEZE_MS / 1000 + ' s, not ' + NOMINAL * FREEZE_MS / 1000);
    console.log('  ' + ms[other].name + ' stood still for ' + stalled + ' s in a row (sampled once a second)');
    check(series[other][series[other].length - 1][1] >= TICS, ms[other].name + ' then played on to tic ' + series[other][series[other].length - 1][1]);
  } finally { await cleanup(relay); }
}
SCENARIOS['frozen-slave'] = {
  what: 'a browser slave frozen for 5 s mid-game: the room waits and goes on, all agree, the game does not end early',
  run: () => frozenRoom(['browser', 'browser'], 1),
};
SCENARIOS['frozen-host'] = {
  what: 'a browser host frozen for 5 s mid-game (native slave): the same',
  run: () => frozenRoom(['browser', 'native'], 0),
};

// Desync detection works: -testnudge on one machine makes the master log GAME OUT OF SYNC, and the dumps differ from
// that tic on (the nudge moves that player 8 units at tic NUDGE; its record of tic NUDGE+1 is the first to differ).
const NUDGE = 300;
async function nudgeRoom(nudgedIndex) {
  const relay = await startRelay();
  try {
    console.log('  browser + browser, the ' + (nudgedIndex === 0 ? 'master' : 'slave') + ' nudged at tic ' + NUDGE + ' (' + LOAD() + ')');
    const tics = 700;
    const ms = await room(relay, ['browser', 'browser'], { tics, nudge: { [nudgedIndex]: String(NUDGE) } });
    for (const m of ms) { await m.waitEnd(120000); }
    const dumps = await checkGame(ms, tics, { desyncExpected: true });
    const master = await ms[0].out();
    const logged = (master.match(/GAME OUT OF SYNC/g) || []).length;
    check(logged > 0, 'the master logged GAME OUT OF SYNC (' + logged + ' lines)');
    const first = (master.match(/GAME OUT OF SYNC: tic (\d+)/) || [])[1];
    console.log('  master: ' + (master.match(/GAME OUT OF SYNC[^\n]*/) || ['(none)'])[0]);
    check(!/OUT OF SYNC/.test(await ms[1].out()), 'the slave logs nothing (only the master compares sync bytes: bugs.md L11)');
    const d = firstDifference(dumps);
    check(!!d && d.tic >= NUDGE + 1 && d.tic <= NUDGE + 3, 'the dumps first differ at tic ' + (d ? d.tic : 'never') + ' (the nudge was at ' + NUDGE + ')', d ? d.what : '');
    if (d) {
      const n = Math.min(dumps[0].length, dumps[1].length) / REC;
      let differ = 0;
      for (let i = d.index; i < n; i++) { if (!dumps[0].subarray(i * REC + 13, (i + 1) * REC).equals(dumps[1].subarray(i * REC + 13, (i + 1) * REC))) { differ++; } }
      check(differ >= 0.95 * (n - d.index), 'and they stay different from there on (' + differ + ' of ' + (n - d.index) + ' state hashes differ)');
    }
  } finally { await cleanup(relay); }
}
SCENARIOS['nudge-slave'] = {
  what: 'desync detection: -testnudge on the slave: the master logs GAME OUT OF SYNC and the dumps differ from that tic on',
  run: () => nudgeRoom(1),
};
SCENARIOS['nudge-master'] = {
  what: 'desync detection: -testnudge on the master',
  run: () => nudgeRoom(0),
};

// The page's overlay shows the game's message when a network game cannot start. `args` are the game's arguments.
async function failCase(label, args, re, opts) {
  opts = opts || {};
  const m = await browserMachine('f-' + label, args, { dump: 'd.bin' });
  const t0 = now();
  await m.start();
  const st = await m.waitEnd(opts.limit || 60000);
  const took = (now() - t0) / 1000;
  const text = await m.status();
  const code = await m.exitCode();
  const visible = await m.page.evaluate(() => !document.getElementById('overlay').hidden && !document.getElementById('reload').hidden);
  console.log('  ' + label + ': ' + took.toFixed(1) + ' s, status ' + code + ': ' + text);
  check(st === 'error' && code === 1, label + ': the game ended with status 1 (' + st + ', ' + code + ')');
  check(re.test(text), label + ': the page says why (' + re + ')', text);
  check(visible, label + ': on the page\'s end-of-game overlay with the reload button');
  check(m.errors.length === 0, label + ': no page errors', m.errors.join('; '));
  if (opts.under) { check(took < opts.under, label + ': within ' + opts.under + ' s (' + took.toFixed(1) + ')'); }
  await m.stop();
  machines.splice(machines.indexOf(m), 1);
  return took;
}

SCENARIOS.errors = {
  what: 'failures end on the page overlay with the game\'s message: relay unreachable, no such room, room full, host gone during the wait, plain -net, a UDP-style -relay',
  run: async () => {
    let relay = null;
    try {
      // no relay is running on 48302
      await failCase('relay-unreachable', gameArgs({ net: ['-relay', 'ws://127.0.0.1:48392/vnet', '-host-room', '2'] }), /Network game failed.*(could not be reached|did not answer)/i, { under: 30 });
      await failCase('plain-net', gameArgs({ net: ['-nm:2'] }), /needs a relay.*plain -net needs UDP/is, { under: 10 });
      await failCase('udp-relay-address', gameArgs({ net: ['-relay', '127.0.0.1:48301', '-host-room', '2'] }), /wants the relay's WebSocket URL/i, { under: 10 });
      await failCase('bad-code', gameArgs({ net: ['-relay', 'ws://127.0.0.1:48302/vnet', '-room', 'ABC'] }), /room code is 6 letters/i, { under: 10 });
      relay = await startRelay(['-max-members', '2']);
      await failCase('no-such-room', gameArgs({ net: ['-relay', relay.ws, '-room', 'ABCDEF'] }), /Network game failed.*no room with that code/i, { under: 20 });

      // room full: the relay takes 2 members; two players are in (idle in the menu: no -autonet), a third is refused
      const idle = (net) => gameArgs({ net, autonet: false, testsync: false });
      const host = await browserMachine('full-host', idle(['-relay', relay.ws, '-host-room', '2']), { dump: 'd.bin' });
      await host.start();
      const code = await waitRoomCode(host);
      const j1 = await browserMachine('full-p1', idle(['-relay', relay.ws, '-room', code]), { dump: 'd.bin' });
      await j1.start();
      const t0 = now();
      while (!/joined room/.test(await j1.out()) && now() - t0 < 20000) { await sleep(200); }
      await failCase('room-full', gameArgs({ net: ['-relay', relay.ws, '-room', code], autonet: false, testsync: false }), /Network game failed.*room is full/i, { under: 20 });
      for (const m of [host, j1]) { await m.stop(); machines.splice(machines.indexOf(m), 1); }

      // the host goes away while the game waits for a third player: the joiner gives up 10 s after the host's last answer
      // (this relay's rooms hold 2, so -host-room 3 would be clamped to 2 and the game would start: use one with room for 4)
      await relay.stop();
      relay = await startRelay(['-max-members', '4']);
      const h3 = await browserMachine('gone-host', idle(['-relay', relay.ws, '-host-room', '3']), { dump: 'd.bin' });
      await h3.start();
      const code3 = await waitRoomCode(h3);
      const g3 = await browserMachine('gone-joiner', idle(['-relay', relay.ws, '-room', code3]), { dump: 'd.bin' });
      await g3.start();
      const t1 = now();
      while (!/joined room/.test(await g3.out()) && now() - t1 < 20000) { await sleep(200); }
      await sleep(3000);       // it has been answered by now
      const tgone = now();
      await h3.stop();         // the host's tab closes
      const st = await g3.waitEnd(40000);
      const took = (now() - tgone) / 1000, text = await g3.status(), c3 = await g3.exitCode();
      console.log('  host-gone: the joiner gave up ' + took.toFixed(1) + ' s after the host left: ' + text);
      check(st === 'error' && c3 === 1, 'host-gone: the joiner ended with status 1 (' + st + ', ' + c3 + ')');
      check(/Network game failed.*host stopped answering/i.test(text), 'host-gone: the page says the host stopped answering', text);
      check(took >= 8 && took <= 25, 'host-gone: after about 10 s (' + took.toFixed(1) + ')');
    } finally { await cleanup(relay); }
  },
};

// The test-only relay knobs work only on a ?test=1 page.
SCENARIOS.knobs = {
  what: 'relay_wt, relay_cert and impair are read from the address only with ?test=1',
  run: async () => {
    let relay = null;
    try {
      const e = await env();
      const knobs = '&relay_wt=' + encodeURIComponent('https://127.0.0.1:1/vnet') + '&relay_cert=' + 'ab'.repeat(32) + '&impair=' + encodeURIComponent('loss=50,seed=3');
      const read = async (q) => {
        const ctx = await e.browser.newContext();
        const page = await ctx.newPage();
        await page.goto(e.base + q);
        await L.waitState(page, 'ready', 60000);
        const r = await page.evaluate(() => ({ knobs: window.jfswKnobs, module: Module.jfswKnobs, test: typeof window.jfswTest }));
        await ctx.close();
        return r;
      };
      const off = await read('?args=-level1' + knobs);
      check(Object.keys(off.knobs).length === 0 && Object.keys(off.module).length === 0, 'without ?test=1 the page hands the game no knobs (' + JSON.stringify(off.knobs) + ')');
      check(off.test === 'undefined', 'and has no test hooks');
      const on = await read('?test=1&persist=0' + knobs);
      check(on.knobs.relay_wt === 'https://127.0.0.1:1/vnet' && on.knobs.relay_cert === 'ab'.repeat(32) && on.knobs.impair === 'loss=50,seed=3', 'with ?test=1 all three reach the game (' + JSON.stringify(on.knobs) + ')');
      // a game started on a page without ?test=1 but with the knobs in its address uses none of them (it cannot be started into a
      // network game before brief 05, so this is what can be checked: it runs, and says nothing about knobs)
      {
        const ctx = await e.browser.newContext();
        const page = await ctx.newPage();
        await page.goto(e.base + '?args=-level1' + knobs);
        await L.waitState(page, 'ready', 60000);
        await page.click('#start');
        await sleep(4000);
        const r = await page.evaluate(() => ({ state: window.jfswState, out: (window.jfswOut || []).join('\n'), knobs: Module.jfswKnobs }));
        check(r.state === 'running' && !/test knobs/.test(r.out) && Object.keys(r.knobs).length === 0, 'a game started without ?test=1 but with the knobs in the address runs and has none (' + r.state + ')');
        await ctx.close();
      }
      // and the game acts on them: it says so, and a bad impairment spec is refused
      relay = await startRelay();
      const m = await browserMachine('knobs', gameArgs({ net: ['-relay', relay.ws, '-host-room', '2'], autonet: false, testsync: false }), { query: '&impair=' + encodeURIComponent('lat=5,seed=9') + '&relay_cert=' + relay.cert + '&relay_wt=' + encodeURIComponent(relay.wt), dump: 'd.bin' });
      await m.start();
      await waitRoomCode(m);
      const out = await m.out();
      check(/test knobs in use: relay_wt relay_cert impair/.test(out), 'the game reports the knobs it was given');
      check(/relay-wt/.test(out), 'the WebTransport knobs took effect (' + (await transportOf(m)) + ')');
      await m.stop(); machines.splice(machines.indexOf(m), 1);
      const bad = await browserMachine('badknob', gameArgs({ net: ['-relay', relay.ws, '-host-room', '2'], autonet: false, testsync: false }), { query: '&impair=' + encodeURIComponent('loss=banana'), dump: 'd.bin' });
      await bad.start();
      const st = await bad.waitEnd(20000);
      check(st === 'error' && /not a vnet impairment spec/.test(await bad.status()), 'a malformed impairment spec is refused with a message (' + (await bad.status()).slice(0, 120) + ')');
    } finally { await cleanup(relay); }
  },
};

// One longer game that avoids F1 (the co-op freeze at tic 1522 on E1L1, on hold): two players, co-op on E1L2 (the second
// level of the shareware episode), 5000 tics (about two minutes), a browser and a native player through the relay.
// (A deathmatch level was tried first: the game plays 5000 tics and agrees, but the machines do not leave it by themselves.)
SCENARIOS.long = {
  what: 'a longer game: two players, co-op on E1L2 (E1L1 freezes in co-op at tic 1522: F1), 5000 tics, browser host and native slave',
  run: async () => {
    const o = { tics: 5000, autonet: '-autonet 2,1,2,1,0,0,0,0,0,0' };
    const relay = await startRelay();
    try {
      console.log('  browser + native, co-op E1L2, ' + o.tics + ' tics (' + LOAD() + ')');
      const ms = await room(relay, ['browser', 'native'], o);
      const series = await sample(ms, o.tics, o.tics / NOMINAL * 1000 * 3 + 90000);
      for (const m of ms) { await m.waitEnd(60000); }
      console.log('  tic rates between tic 500 and 4500: ' + ms.map((m, i) => m.name + ' ' + rate(series[i], 500, 4500).toFixed(1)).join(', ') + ' (nominal ' + NOMINAL + '); ' + LOAD());
      await checkGame(ms, o.tics);
    } finally { await cleanup(relay); }
  },
};

// S4: the relay drops a member that was silent for longer than its session timeout (here 3 s; a frozen tab sends no
// keepalives). The game of that machine must end with the overlay message and status 1 instead of standing still.
SCENARIOS['relay-lost'] = {
  what: 'the relay drops a frozen tab (session timeout 3 s): that machine ends with status 1 and the relay message on the overlay',
  run: async () => {
    const relay = await startRelay(['-session-timeout', '3s', '-keepalive', '1s']);
    try {
      const ms = await room(relay, ['browser', 'browser'], { tics: TICS });
      const f = ms[1];
      let fp = null;
      await sample(ms, 300, 90000, async () => {});
      console.log('  freezing ' + f.name + ' for 6 s at tic ' + Math.floor((await f.dumpSize()) / REC));
      fp = freeze(f.page, 6000);
      await fp;
      const t0 = now();
      const st = await f.waitEnd(30000);
      const took = (now() - t0) / 1000, text = await f.status(), code = await f.exitCode();
      console.log('  ' + f.name + ' ended ' + took.toFixed(1) + ' s after it thawed: ' + text);
      check(st === 'error' && code === 1, f.name + ' ended with status 1 (' + st + ', ' + code + ')');
      check(/Network game failed.*relay ended the session/i.test(text), f.name + ': the overlay says why', text);
      check(took < 15, f.name + ' ended within 15 s of thawing (' + took.toFixed(1) + ')');
      check(f.errors.length === 0, f.name + ' had no page errors', f.errors.join('; '));
    } finally { await cleanup(relay); }
  },
};

// ---- brief 05: host and join from the game -------------------------------------------------------------
// A network game started the way a player starts one: the page's ?host=N / ?join=CODE (the relay from the served config.js,
// as on a site), the lobby overlay (room code, invite link, who is in, Start now, Cancel), the console's and the
// menus' host and join (which restart into the game: the page reloads, a native game re-launches itself), the native host's
// "start" on its standard input, and every way a network game fails or ends.

const WSRELAY = 'ws://127.0.0.1:' + PORT_HTTP + '/vnet';
const LOBBY_TICS = 400;

async function waitFor(fn, ms) {
  const t0 = now();
  while (now() - t0 < ms) { const v = await fn(); if (v) { return v; } await sleep(200); }
  return null;
}
async function lobbyWhen(m, pred, ms) { return waitFor(async () => { const l = await m.lobby(); return l && pred(l) ? l : null; }, ms || 30000); }
async function outHas(m, re, ms) { return waitFor(async () => re.test(await m.out()), ms || 30000); }
// The game's test arguments (as gameArgs() makes them) without -net ... --: the page or the host/join command adds those.
function testArgs(o) { const a = gameArgs(Object.assign({ net: [] }, o)); return a.slice(2); }
// A browser page that starts a network game from its address (q: '&host=3', '&join=ABC234'); args are the test arguments.
// The relay is the served config.js's (CONFIG_RELAY).
async function netPage(name, q, args, o) {
  return browserMachine(name, [], Object.assign({ raw: '?test=1&persist=0' + q + '&args=' + encodeURIComponent(args.join(' ')), dump: 'd.bin' }, o || {}));
}
// Presses a key the way a person does: down, held for a game tic or two, up (the menus look at the keys' state: bugs.md L14).
async function key(page, k, held) { await page.keyboard.down(k); await sleep(held || 150); await page.keyboard.up(k); await sleep(120); }
// The players a machine's game started with, from its log ("Lobby: the game starts with N players; you are player P.").
async function startedWith(m) { const mm = /Lobby: the game starts with (\d+) players; you are player (\d+)\./.exec(await m.out()); return mm ? { n: +mm[1], p: +mm[2] } : null; }

// One game through the lobby. kinds[0] hosts a game of o.slots places (default kinds.length): a browser by ?host=, a native game
// by -host-room. The others join by ?join= (browser; the code in lower case, as a person might type it) or -room. When fewer
// players than places are in, the host starts with Start now: the button (browser) or "start" on its standard input (native).
async function lobbyGame(relay, kinds, o) {
  o = o || {};
  const slots = o.slots || kinds.length, tics = o.tics || LOBBY_TICS;
  const targs = (i) => testArgs({ tics, dump: 'd.bin', autonet: o.autonet, state: o.state, extra: o.extra ? o.extra(i) : [] });
  const ms = [];
  let code = '';
  for (let i = 0; i < kinds.length; i++) {
    let m;
    if (kinds[i] === 'browser') {
      m = await netPage('p' + i, i === 0 ? '&host=' + slots : '&join=' + code.toLowerCase(), targs(i));
    } else {
      m = nativeMachine('p' + i, ['-net', '-relay', relay.udp].concat(i === 0 ? ['-host-room', String(slots)] : ['-room', code], ['--'], targs(i)), { dump: 'd.bin', stdin: i === 0 });
    }
    ms.push(m);
    await m.start();
    if (o.onStart) { await o.onStart(i, m); }
    if (i === 0) { code = await waitRoomCode(m); console.log('  room ' + code + ' (' + kinds[0] + ' host, ' + slots + ' places)'); }
    if (i === 0 && o.earlyStart && m.kind === 'native') {
      // (brief 05 review N1) "start" with only the host in is refused and not remembered
      m.type('start');
      check(!!(await outHas(m, /Lobby: starting needs at least 2 players/, 10000)), m.name + ': "start" alone in the room is refused (needs 2 players)');
    }
    // the next joiner waits until this one is in (the place a joiner gets is the order its first ping reaches the host)
    check(!!(await outHas(m, new RegExp('Lobby: ' + (i + 1) + ' of ' + slots + ' players are in'), 40000)), m.name + ' sees ' + (i + 1) + ' of ' + slots + ' players in the room');
  }
  if (o.earlyStart) {
    await sleep(3000);
    check(!(await startedWith(ms[0])), ms[0].name + ': the refused early "start" was not remembered: the game did not start when the second player came in');
  }
  if (kinds.length < slots) {
    const h = ms[0];
    if (h.kind === 'browser') {
      const l = await lobbyWhen(h, (x) => x.info && x.info.joined === kinds.length && !x.startDisabled, 30000);
      check(!!l, h.name + ': Start now is offered with ' + kinds.length + ' of ' + slots + ' in', JSON.stringify(await h.lobby()));
      await h.page.click('#lobbystart');
    } else {
      h.type('start');
    }
    console.log('  the host pressed Start now with ' + kinds.length + ' of ' + slots);
  }
  return { ms, code };
}

// Every machine of a lobby game: started with n players (the same count, its own number), then the finished game as checkGame().
async function checkLobbyGame(ms, n, tics) {
  for (let i = 0; i < ms.length; i++) {
    const s = await startedWith(ms[i]);
    check(!!s && s.n === n && s.p === i + 1, ms[i].name + ' started the game with ' + n + ' players as player ' + (i + 1) + ' (log: ' + JSON.stringify(s) + ')');
    const q = /TEST: quitting after \d+ game tics: .* player (\d+) of (\d+)/.exec(await ms[i].out());
    check(!!q && +q[2] === n, ms[i].name + ' played a ' + n + '-player game (' + (q ? q[2] : '?') + ')');
  }
  return checkGame(ms, tics);
}

async function lobbyRun(kinds, o) {
  const relay = await startRelay(o.relayArgs);
  try {
    console.log('  ' + kinds.join(' + ') + ' in a game of ' + (o.slots || kinds.length) + ' places (' + LOAD() + ')');
    const { ms, code } = await lobbyGame(relay, kinds, o);
    const tics = o.tics || LOBBY_TICS;
    const limit = tics / NOMINAL * 1000 * 3 + 90000;
    if (o.late) { await o.late(relay, code, ms); }
    for (const m of ms) { await m.waitEnd(limit - (now() - ms[0].started)); }
    console.log('  the game took ' + ((now() - ms[0].started) / 1000).toFixed(1) + ' s from the start of the host to the end of the last machine');
    await checkLobbyGame(ms, kinds.length, tics);
    return ms;
  } finally { await cleanup(relay); }
}

// A player who arrives after the start: refused with "the game has already started", within `under` seconds; the game goes on.
async function lateJoiner(relay, code, kind, under) {
  const t0 = now();
  let m, text;
  if (kind === 'browser') {
    m = await netPage('late', '&join=' + code, []);
    await m.start();
    await m.waitEnd(40000);
    text = await m.status();
    check(await m.page.evaluate(() => !document.getElementById('overlay').hidden && !document.getElementById('reload').hidden), 'late browser joiner: on the end overlay with the button back to the start page');
  } else {
    m = nativeMachine('late', ['-net', '-relay', relay.udp, '-room', code, '--', '-autonet', '2,0,2,1,0,0,0,0,0,0']);
    await m.start();
    await m.waitEnd(40000);
    text = await m.out();
  }
  const took = (now() - t0) / 1000;
  console.log('  late ' + kind + ' joiner: ' + took.toFixed(1) + ' s: ' + (text.match(/Network game failed: [^\n]*/) || [text.slice(-160)])[0]);
  check((await m.exitCode()) === 1, 'late ' + kind + ' joiner: its game ended with status 1');
  check(/Network game failed: the game has already started/.test(text), 'late ' + kind + ' joiner: told the game has already started', text.slice(-200));
  check(took < under, 'late ' + kind + ' joiner: within ' + under + ' s (' + took.toFixed(1) + ')');
  await m.stop();
  machines.splice(machines.indexOf(m), 1);
}

SCENARIOS['start-now'] = {
  what: 'Start now (Q3): 2 of 3 (two browsers), 2 of 4 (native host by "start" on its input, browser guest), 2 of 4 (browser host, native guest): every machine starts with 2 and agrees on every tic; late joiners are refused',
  run: async () => {
    await lobbyRun(['browser', 'browser'], { slots: 3 });
    await lobbyRun(['native', 'browser'], { slots: 4, earlyStart: true, late: (relay, code) => lateJoiner(relay, code, 'browser', 25) });
    await lobbyRun(['browser', 'native'], { slots: 4, late: (relay, code) => lateJoiner(relay, code, 'native', 25) });
  },
};

// The lobby overlay itself, on pages without ?test=1 and with the relay in config.js, as a visitor sees them.
SCENARIOS.lobby = {
  what: 'the lobby on ordinary pages (relay from config.js): ?host=3, the room code and invite link, the second browser joins from the link and the count updates, Start now by keyboard, the game starts on both; Cancel for a guest and for the host; phone width',
  run: async () => {
    let relay = null;
    try {
      relay = await startRelay();
      CONFIG_RELAY = relay.ws;
      const h = await browserMachine('host', [], { raw: '?host=3' });
      await h.start();
      const l1 = await lobbyWhen(h, (x) => x.shown && /^[A-HJ-NP-Z2-9]{6}$/.test(x.code), 30000);
      check(!!l1, 'host: the lobby shows a room code', JSON.stringify(await h.lobby()));
      if (!l1) { return; }
      const base = 'http://127.0.0.1:' + PORT_WEB + '/index.html';
      check(l1.link === base + '?join=' + l1.code, 'host: the invite link is this page with ?join=' + l1.code + ' (' + l1.link + ')');
      check(/1 of 3 players are in/.test(l1.players), 'host: 1 of 3 players are in (' + l1.players + ')');
      check(!l1.startHidden && l1.startDisabled, 'host: Start now is there but not yet usable');
      check(/room code/.test(await h.out()) && !(await h.page.evaluate(() => !!window.jfswTest)), 'host: an ordinary page (no test hooks), the game made the room');
      // the guest opens exactly the invite link, on a phone-sized window
      const g = await browserMachine('guest', [], { raw: l1.link.slice(base.length), viewport: { width: 360, height: 640 } });
      await g.start();
      const lg = await lobbyWhen(g, (x) => x.shown && x.info && x.info.joined === 2, 30000);
      check(!!lg, 'guest: the lobby shows 2 of 3 players', JSON.stringify(await g.lobby()));
      check(!!lg && lg.code === l1.code && lg.startHidden, 'guest: the same room code, and no Start now for a guest');
      const fits = await g.page.evaluate(() => { const b = document.querySelector('#lobby .box'); return { box: b.getBoundingClientRect().width, win: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }; });
      check(fits.box <= fits.win && fits.scroll <= fits.win, 'guest: the lobby fits a 360 px wide window (' + JSON.stringify(fits) + ')');
      const l2 = await lobbyWhen(h, (x) => x.info && x.info.joined === 2 && !x.startDisabled, 20000);
      check(!!l2 && /2 of 3 players are in/.test(l2.players), 'host: the count went up to 2 of 3 and Start now is usable (' + (l2 ? l2.players : '') + ')');
      // keyboard only: Tab to Start now, Enter
      let focused = '';
      for (let i = 0; i < 8 && focused !== 'lobbystart'; i++) { await h.page.keyboard.press('Tab'); focused = await h.page.evaluate(() => document.activeElement && document.activeElement.id); }
      check(focused === 'lobbystart', 'host: Start now can be reached with Tab (' + focused + ')');
      await h.page.keyboard.press('Enter');
      for (const m of [h, g]) {
        const ok = await waitFor(async () => { const l = await m.lobby(); return l && !l.shown && (await startedWith(m)); }, 30000);
        const s = await startedWith(m);
        check(!!ok && s.n === 2, m.name + ': the lobby went and the game started with 2 players (' + JSON.stringify(s) + ')');
      }
      // a third browser opens the link now: refused, the two in the game are not disturbed
      const late = await browserMachine('late', [], { raw: l1.link.slice(base.length) });
      const t0 = now();
      await late.start();
      await late.waitEnd(30000);
      const lt = await late.status();
      check(/game has already started/.test(lt) && (now() - t0) < 20000, 'a third browser from the link is told the game has already started (' + ((now() - t0) / 1000).toFixed(1) + ' s): ' + lt);
      check(await late.page.evaluate(() => document.getElementById('reload').textContent === 'Back to the start page'), 'and is offered the start page');
      await late.page.click('#reload');
      await L.waitState(late.page, 'ready', 30000);
      check(!/join=/.test(late.page.url()), 'which is this page without ?join= (' + late.page.url() + ')');
      await sleep(2000);
      for (const m of [h, g]) { check((await m.state()) === 'running', m.name + ' is still in the game'); }
      for (const m of [h, g, late]) { await m.stop(); machines.splice(machines.indexOf(m), 1); }

      // Cancel: a guest leaves the lobby (the host's count goes back down and the place is free again), then the host closes the room
      const h3 = await browserMachine('host3', [], { raw: '?host=3' });
      await h3.start();
      const c3 = (await lobbyWhen(h3, (x) => /^[A-Z2-9]{6}$/.test(x.code), 30000) || {}).code;
      const g3 = await browserMachine('guest3', [], { raw: '?join=' + c3 });
      await g3.start();
      check(!!(await lobbyWhen(h3, (x) => x.info && x.info.joined === 2, 30000)), 'host3: 2 of 3 in');
      let t1 = now();
      await g3.page.click('#lobbycancel');
      await L.waitState(g3.page, 'ready', 20000).catch(() => {});
      check(!/join=/.test(g3.page.url()) && (await g3.state()) === 'ready', 'guest Cancel: back on the start page, ready to play (' + g3.page.url() + ', ' + (await g3.state()) + ')');
      const back = await lobbyWhen(h3, (x) => x.info && x.info.joined === 1, 15000);
      check(!!back, 'host3: the count went back to 1 of 3 (' + ((now() - t1) / 1000).toFixed(1) + ' s)');
      const g4 = await browserMachine('guest4', [], { raw: '?join=' + c3 });
      await g4.start();
      check(!!(await lobbyWhen(h3, (x) => x.info && x.info.joined === 2, 30000)), 'host3: another guest takes the free place: 2 of 3');
      t1 = now();
      await h3.page.focus('#lobbycancel');
      await h3.page.keyboard.press('Enter');
      await L.waitState(h3.page, 'ready', 20000).catch(() => {});
      check(!/host=/.test(h3.page.url()) && (await h3.state()) === 'ready', 'host Cancel (keyboard): back on the start page (' + h3.page.url() + ')');
      await g4.waitEnd(20000);
      const gt = await g4.status();
      check(/host left the room before the game started/.test(gt) && (now() - t1) < 10000, 'the guest is told the host left the room, within 10 s (' + ((now() - t1) / 1000).toFixed(1) + ' s): ' + gt);
      for (const m of [g3, g4, h3]) { check(m.errors.length === 0, m.name + ' had no page errors', m.errors.join('; ')); }
    } finally { await cleanup(relay); }
  },
};

// The console's and the menus' host and join: they restart into the network game (D3). In the browser the page reloads with
// ?host=N or ?join=CODE; natively the game re-launches itself with -net -relay <its relay setting> ... (the relay setting is in
// sw.cfg; -testosd<T>,<command> types the command into a native game's console at tic T).
// (-autonet takes a single player game straight into E1L1, where the commands are typed; after the restart it starts the network game.)
SCENARIOS['host-join'] = {
  what: 'host and join from the console and the menus: browser console host + native guest; native console host (re-launch) + browser guest from the link; browser host + native console join (re-launch); browser menu host + browser menu join; every game agrees on every tic',
  run: async () => {
    const relay = await startRelay();
    const cfg = '[Comm Setup]\nRelay = "' + relay.udp + '"\n';
    const play = testArgs({ tics: LOBBY_TICS, dump: 'd.bin' });
    const finish = async (ms, label) => {
      for (const m of ms) { await m.waitEnd(LOBBY_TICS / NOMINAL * 1000 * 3 + 90000); }
      console.log('  ' + label + ': the game took ' + ((now() - ms[0].started) / 1000).toFixed(1) + ' s');
      await checkLobbyGame(ms, ms.length, LOBBY_TICS);
      for (const m of ms.splice(0)) { await m.stop(); machines.splice(machines.indexOf(m), 1); }
    };
    // the console of a browser page: Num Lock opens it (the game's default key for it); the command is typed and sent with Enter
    const consoleCmd = async (m, cmd) => {
      await key(m.page, 'NumLock');
      await sleep(400);
      await m.page.keyboard.type(cmd, { delay: 40 });
      await m.page.keyboard.press('Enter');
    };
    const reloaded = async (m, re) => {
      const ok = await waitFor(async () => re.test(m.page.url()) && (await m.state().catch(() => '')) === 'ready', 30000);
      check(!!ok, m.name + ' reloaded itself into ' + re + ' (' + m.page.url() + ')');
      await m.start();
    };
    try {
      // 1. browser: console "host 2" in a single player game; a native guest joins with -room
      {
        console.log('  browser console host + native guest (' + LOAD() + ')');
        const h = await netPage('p0', '', play);
        await h.start();
        check(!!(await waitFor(async () => (await h.dumpSize()) > 40 * REC, 60000)), h.name + ' is playing single player');
        await consoleCmd(h, 'host 2');
        await reloaded(h, /[?&]host=2(&|$)/);
        const code = await waitRoomCode(h);
        const g = nativeMachine('p1', ['-net', '-relay', relay.udp, '-room', code, '--'].concat(play), { dump: 'd.bin' });
        await g.start();
        await finish([h, g], 'browser console host');
      }
      // 2. native: console "host 2" (re-launch) in a single player game; a browser guest from the invite link's ?join=CODE
      {
        console.log('  native console host (re-launch) + browser guest from the link (' + LOAD() + ')');
        const h = nativeMachine('p0', play.concat(['-testosd60,host 2']), { dump: 'd.bin', cfg });
        await h.start();
        const code = await waitRoomCode(h, 60000);
        const out = await h.out();
        check(/Re-launching: \S+ -net -relay 127\.0\.0\.1:48301 -host-room 2 --/.test(out), h.name + ' re-launched itself with -net -relay <its setting> -host-room 2', (out.match(/Re-launching:[^\n]*/) || [''])[0]);
        const g = await netPage('p1', '&join=' + code, play);
        await g.start();
        await finish([h, g], 'native console host');
      }
      // 3. a browser hosts (?host=2); a native single player game types "join CODE" in its console (re-launch)
      {
        console.log('  browser host + native console join (re-launch) (' + LOAD() + ')');
        const h = await netPage('p0', '&host=2', play);
        await h.start();
        const code = await waitRoomCode(h);
        const g = nativeMachine('p1', play.concat(['-testosd60,join ' + code.toLowerCase()]), { dump: 'd.bin', cfg });
        await g.start();
        check(!!(await outHas(g, new RegExp('Re-launching: \\S+ -net -relay 127\\.0\\.0\\.1:48301 -room ' + code + ' --'), 60000)), g.name + ' re-launched itself with -room ' + code);
        await finish([h, g], 'native console join');
      }
      // 4. the menus: Escape, Host Online Game (G), 2 Players (2) on one page; Escape, Join Online Game (J), the code, Enter on another
      {
        console.log('  browser menu host + browser menu join (' + LOAD() + ')');
        const h = await netPage('p0', '', play);
        await h.start();
        check(!!(await waitFor(async () => (await h.dumpSize()) > 40 * REC, 60000)), h.name + ' is playing single player');
        // (a menu's hot key moves the cursor to its item; Enter takes it)
        await key(h.page, 'Escape'); await sleep(500);
        await key(h.page, 'g'); await sleep(300); await key(h.page, 'Enter'); await sleep(500);
        await key(h.page, '2'); await sleep(300); await key(h.page, 'Enter');
        await reloaded(h, /[?&]host=2(&|$)/);
        const code = await waitRoomCode(h);
        const g = await netPage('p1', '', play);
        await g.start();
        check(!!(await waitFor(async () => (await g.dumpSize()) > 40 * REC, 60000)), g.name + ' is playing single player');
        await key(g.page, 'Escape'); await sleep(500);
        await key(g.page, 'j'); await sleep(300); await key(g.page, 'Enter'); await sleep(500);
        for (const c of code.toLowerCase()) { await g.page.keyboard.press(c === c.toUpperCase() ? 'Digit' + c : 'Key' + c.toUpperCase()); await sleep(60); }
        await sleep(200);
        await key(g.page, 'Enter');
        await reloaded(g, new RegExp('[?&]join=' + code + '(&|$)'));
        await finish([h, g], 'menus');
      }
    } finally { await cleanup(relay); }
  },
};

// Every way a network game can fail or end (brief 05, section E) says why, and leaves the player somewhere sensible. Those of
// brief 04 (relay unreachable, no such room, relay room full, host gone in the wait, the relay session lost) are in `errors`
// and `relay-lost` through the game's arguments; here they come through the page's own ?host= / ?join= and the lobby.
async function pageRefusal(label, raw, re, o) {
  o = o || {};
  const m = await browserMachine('r-' + label, [], { raw, ready: o.ready || ['error', 'ready'] });
  if (o.start) { await L.waitState(m.page, 'ready', 60000); await m.start(); }
  const st = await m.waitEnd(o.start ? 40000 : 15000);
  const r = await m.page.evaluate(() => ({ state: window.jfswState, status: document.getElementById('status').textContent, start: !document.getElementById('start').hidden,
    button: document.getElementById('reload').hidden ? '' : document.getElementById('reload').textContent, ran: !!window.jfswExit || (window.jfswOut || []).some((l) => /mmulti/.test(l)) }));
  console.log('  ' + label + ': ' + r.status.replace(/\s+/g, ' '));
  check(re.test(r.status), label + ': the page says why (' + re + ')', r.status);
  check(!r.start && /start page/i.test(r.button), label + ': no game to start, a button back to the start page (' + r.button + ')');
  if (!o.start) { check(!r.ran && r.state === 'error', label + ': no game was started (' + r.state + ', ' + st + ')'); }
  check(m.errors.length === 0, label + ': no page errors', m.errors.join('; '));
  await m.stop(); machines.splice(machines.indexOf(m), 1);
}

// The end of a game in progress whose host (or a guest) has gone: `gone` is the index of the machine that vanishes at tic ~150
// (its tab closes or its process is killed, so it sends nothing more), `res` the messages the others must show.
async function goneGame(kinds, gone, res) {
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ': ' + (gone === 0 ? 'the host' : 'p' + gone) + ' vanishes during the game (' + LOAD() + ')');
    const { ms } = await lobbyGame(relay, kinds, { tics: 3000 });
    await waitFor(async () => (await ms[gone].dumpSize()) >= 150 * REC, 90000);
    const t0 = now();
    const g = ms[gone];
    if (g.kind === 'browser') { await g.stop(); } else { try { process.kill(-g.child.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    console.log('  ' + g.name + ' is gone (tic ' + Math.floor((await ms[(gone + 1) % ms.length].dumpSize()) / REC) + ' on ' + ms[(gone + 1) % ms.length].name + ')');
    for (let i = 0; i < ms.length; i++) {
      if (i === gone) { continue; }
      const m = ms[i];
      const st = await m.waitEnd(60000);
      const took = (now() - t0) / 1000;
      const text = m.kind === 'browser' ? await m.status() : await m.out();
      const line = (text.match(/Network game failed: [^\n]*/) || [text.slice(-200)])[0];
      console.log('  ' + m.name + ' ended ' + took.toFixed(1) + ' s later: ' + line);
      check(st === 'error' && (await m.exitCode()) === 1, m.name + ': the game ended with status 1 (' + st + ')');
      check(res[i].test(text), m.name + ': it says why (' + res[i] + ')', line);
      check(took < NET_GONE_S + 15, m.name + ': within ' + (NET_GONE_S + 15) + ' s (' + took.toFixed(1) + ')');
      if (m.kind === 'browser') {
        check(await m.page.evaluate(() => !document.getElementById('overlay').hidden && document.getElementById('reload').textContent === 'Back to the start page'), m.name + ': on the end overlay, with the button back to the start page');
      }
    }
  } finally { await cleanup(relay); }
}
const NET_GONE_S = 15;       // src/netlobby.h NET_GONE_MS

SCENARIOS['lobby-errors'] = {
  what: 'every way a network game fails or ends says why: no relay configured, bad player counts and room codes, relay unreachable, unknown room, relay room full, host gone in the game, a guest gone in the game (browser and native)',
  run: async () => {
    let relay = null;
    try {
      // the address: checked before anything is started. First a site with no relay in config.js.
      CONFIG_RELAY = '';
      await pageRefusal('no-relay-host', '?host=2', /no relay is set up/);
      await pageRefusal('no-relay-join', '?join=ABC234', /no relay is set up/);
      // there is no ?relay= any more (brief 05 review): a link cannot supply a relay, not even on a test page
      await pageRefusal('relay-param-ignored', '?test=1&persist=0&relay=' + encodeURIComponent('ws://127.0.0.1:' + PORT_HTTP + '/vnet') + '&host=2', /no relay is set up/);
      await closeEnv();
      relay = await startRelay(['-max-members', '2']);
      CONFIG_RELAY = relay.ws;        // from here on the page's config.js has the relay
      await pageRefusal('host-9', '?host=9', /"9" is not a number of players.*2 to 8/);
      await pageRefusal('host-1', '?host=1', /"1" is not a number of players/);
      await pageRefusal('host-x', '?host=two', /"two" is not a number of players/);
      await pageRefusal('host-5-shareware', '?host=5', /shareware version of the game allows at most 4 players/, { ready: ['error'] });
      await pageRefusal('join-short', '?join=ABC', /"ABC" is not a room code/);
      await pageRefusal('join-01', '?join=AB01CD', /"AB01CD" is not a room code/);
      await pageRefusal('host-and-join', '?host=2&join=ABC234', /to host and to join/);
      // the relay: unreachable, an unknown room, a full room (this relay takes 2 per room)
      await pageRefusal('unknown-room', '?test=1&persist=0&join=ZZZZZZ', /Network game failed.*no room with that code/, { start: true, ready: ['ready'] });
      {
        const h = await netPage('full-h', '&host=2', ['-autonet', '2,0,2,1,0,0,0,0,0,0']);
        await h.start();
        const code = await waitRoomCode(h);
        const j = await netPage('full-j', '&join=' + code, ['-autonet', '2,0,2,1,0,0,0,0,0,0']);
        await j.start();
        await outHas(j, /Lobby: the game starts/, 30000);
        await pageRefusal('relay-room-full', '?test=1&persist=0&join=' + code, /Network game failed.*room is full/, { start: true, ready: ['ready'] });
        for (const m of [h, j]) { await m.stop(); machines.splice(machines.indexOf(m), 1); }
      }
      await closeEnv();
      CONFIG_RELAY = 'ws://127.0.0.1:48392/vnet';     // nothing listens there
      await pageRefusal('relay-unreachable', '?test=1&persist=0&host=2', /Network game failed.*could not be reached/, { start: true, ready: ['ready'] });
      await closeEnv();
      // test mode needs testMode: true in config.js: on a site that leaves it false, ?test=1 in a link does nothing
      CONFIG_TEST = false;
      {
        const m = await browserMachine('no-testmode', [], { raw: '?test=1&persist=0&args=' + encodeURIComponent('-net -relay ws://127.0.0.1:1/vnet -host-room 2 --') });
        const r = await m.page.evaluate(() => ({ hooks: typeof window.jfswTest, info: document.getElementById('testinfo').hidden }));
        check(r.hooks === 'undefined' && r.info, 'with testMode false in config.js, ?test=1 gives no test hooks (' + JSON.stringify(r) + ')');
        await m.start();
        await sleep(3000);
        check(!/mmulti/.test(await m.out()) && (await m.state()) === 'running', 'and ?args= is not used: a single player game, no network game was tried');
        await m.stop(); machines.splice(machines.indexOf(m), 1);
      }
    } finally { await cleanup(relay); }
    // the game in progress: the host goes, a guest goes; browsers and native games
    await goneGame(['browser', 'browser'], 0, [null, /Network game failed: the host left the game/]);
    await goneGame(['browser', 'native'], 0, [null, /Network game failed: the host left the game/]);
    await goneGame(['browser', 'browser', 'browser'], 2, [/Network game failed: player 3 \(.*\) left the game/, /Network game failed: player 3 left the game/, null]);
    await goneGame(['native', 'browser', 'browser'], 1, [/Network game failed: player 2 \(.*\) left the game/, null, /Network game failed: player 2 left the game/]);
  },
};

// A hidden guest at the end of a level (found in 04c): every machine shows the co-op bonus screen and waits for its own
// player's key; a hidden tab has nobody to press one, and the others wait for it at the start of the next level. A hidden tab
// in a network game now leaves the screen at once. The level ends by its real exit switch (-testswitch: OperateSprite on it,
// which sets FinishedLevel, unlike -testexit), the visible browser's player presses Space on the bonus screen, and the next
// level (E1L2) must agree on every tic and field by field at its start, tics 1 to 3 and its last tic.
const LV_SWITCH = 200, LV_TICS = 300;
async function levelEndGame(kinds, hiddenIdx) {
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ', ' + (hiddenIdx === 0 ? 'the host' : 'p' + hiddenIdx) + ' hidden; the exit switch at tic ' + LV_SWITCH + ' (' + LOAD() + ')');
    const { ms } = await lobbyGame(relay, kinds, { tics: LV_TICS, state: true, extra: () => ['-testswitch' + LV_SWITCH, '-teststate' + LV_TICS],
      onStart: async (i, m) => { if (i === hiddenIdx) { await hideFromStart(m); } } });
    // the visible browsers' players press Space on their bonus screens, until their game is in the next level
    const presser = (async () => {
      const vis = ms.filter((m, i) => i !== hiddenIdx && m.kind === 'browser');
      const done = new Set();
      const t0 = now();
      while (now() - t0 < 180000 && done.size < vis.length) {
        for (const m of vis) {
          if (done.has(m)) { continue; }
          const d = await m.readDump().catch(() => null);
          if (d && dumpLevels(d).length >= 2) { done.add(m); continue; }
          if (/TEST: operating the exit switch/.test(await m.out())) { await key(m.page, 'Space', 120); }
        }
        await sleep(300);
      }
    })();
    const limit = (LV_SWITCH + LV_TICS) / NOMINAL * 1000 * 3 + 150000;
    for (const m of ms) { await m.waitEnd(limit - (now() - ms[0].started)); }
    await presser;
    console.log('  the game took ' + ((now() - ms[0].started) / 1000).toFixed(1) + ' s');
    const outs = [];
    for (const m of ms) { outs.push(await m.out()); }
    ms.forEach((m, i) => check(/TEST: operating the exit switch \(sprite \d+\) at tic 200\b/.test(outs[i]), m.name + ' operated the level\'s exit switch at tic ' + LV_SWITCH));
    check(/leaves the bonus screen by itself/.test(outs[hiddenIdx]), ms[hiddenIdx].name + ' (hidden) left the bonus screen by itself');
    ms.forEach((m, i) => { if (i !== hiddenIdx) { check(!/leaves the bonus screen by itself/.test(outs[i]), m.name + ' (visible) waited for its player\'s key on the bonus screen'); } });
    const dumps = await checkLobbyGame(ms, kinds.length, LV_TICS);
    const lv = dumps.map(dumpLevels);
    check(lv.every((l) => l.length === 2 && l[0].length === LV_SWITCH), 'every machine played ' + LV_SWITCH + ' tics of E1L1 and went on to the next level (' + lv.map((l) => l.map((x) => x.length).join('+')).join(', ') + ')');
    const st = [];
    for (const m of ms) { const b = await m.readFile('d.bin.state'); st.push(b ? parseState(b.toString()) : null); }
    if (!st.every(Boolean)) { check(false, 'every machine wrote its state dump'); return; }
    for (let k = 1; k < ms.length; k++) {
      for (const w of ['L2.start', 'L2.t1', 'L2.t2', 'L2.t3', 'L2.t' + LV_TICS]) {
        if (!st[0].has(w + ' global') || !st[k].has(w + ' global')) { check(false, ms[0].name + ' and ' + ms[k].name + ' have the state dump ' + w); continue; }
        const d = stateDifferences(st[0], st[k], w, ms[0].kind !== ms[k].kind);
        check(d.length === 0, ms[0].name + ' and ' + ms[k].name + ' agree field by field at ' + w, d.slice(0, 10).join('; '));
      }
    }
    const ns = st.map((a) => (a.get('L2.start global') ? +a.get('L2.start global').get('numsectors') : NaN));
    check(ns.every((n) => n === ns[0]) && ns[0] !== 486, 'the next level is another map than E1L1 (' + ns.join(', ') + ' sectors)');
  } finally { await cleanup(relay); }
}
SCENARIOS['level-end'] = {
  what: 'a hidden guest (and a hidden host) at the co-op bonus screen after the real exit switch: it continues by itself, the room goes on, and the next level agrees on every tic',
  run: async () => {
    await levelEndGame(['browser', 'browser'], 1);
    await levelEndGame(['browser', 'browser'], 0);
  },
};


// Brief 05 review (B1): the relay gives a departed member's address to the next joiner. A newcomer at the address of a player
// who is in the running game must be refused, and must not keep that player's place alive. `rejoin-vanish`: the guest's tab
// closes mid-game (the relay frees its address at once) and the invite link is opened again: the newcomer gets 10.0.0.2 and is
// told the game has already started; the host ends its game with "player 2 left" once the real guest has been silent 15 s.
// `rejoin-quit`: the guest quits properly (the console's quit), then a newcomer opens the link: refused at once, and the host
// plays on alone to its last tic.
async function newcomerRefused(code, label) {
  const t0 = now();
  const n = await netPage('newcomer', '&join=' + code, ['-autonet', '2,0,2,1,0,0,0,0,0,0', '-testdumpd.bin']);
  await n.start();
  const st = await n.waitEnd(30000);
  const took = (now() - t0) / 1000, out = await n.out(), text = await n.status();
  console.log('  ' + label + ': the newcomer ended after ' + took.toFixed(1) + ' s: ' + text);
  check(/joined room [A-Z2-9]{6} as 10\.0\.0\.2 /.test(out), label + ': the newcomer got the departed guest\'s address 10.0.0.2 (the case under test)', (out.match(/joined room[^\n]*/) || [''])[0]);
  check(st === 'error' && /Network game failed: the game has already started/.test(text), label + ': the newcomer is told the game has already started', text);
  check(took < 15, label + ': within 15 s (' + took.toFixed(1) + ')');
  check(!/Lobby: the game starts/.test(out) && !(await n.dumpSize()), label + ': the newcomer never entered the game');
  await n.stop(); machines.splice(machines.indexOf(n), 1);
}
SCENARIOS['rejoin-vanish'] = {
  what: 'a guest\'s tab closes mid-game and the invite link is opened again: the newcomer (at the guest\'s old relay address) is refused; the host ends with "player 2 left"',
  run: async () => {
    const relay = await startRelay();
    try {
      console.log('  browser host, browser guest (' + LOAD() + ')');
      const { ms, code } = await lobbyGame(relay, ['browser', 'browser'], { tics: 4000 });
      await waitFor(async () => (await ms[0].dumpSize()) >= 150 * REC, 90000);
      await ms[1].stop();
      const t0 = now();
      console.log('  the guest\'s tab closed at tic ' + Math.floor((await ms[0].dumpSize()) / REC) + ' of the host');
      await newcomerRefused(code, 'rejoin-vanish');
      const st = await ms[0].waitEnd(60000);
      const took = (now() - t0) / 1000, text = await ms[0].status();
      console.log('  the host ended ' + took.toFixed(1) + ' s after the tab closed: ' + text);
      check(st === 'error' && /Network game failed: player 2 \(.*\) left the game/.test(text), 'rejoin-vanish: the host ends with "player 2 left the game"', text);
      check(took >= NET_GONE_S - 1 && took < NET_GONE_S + 15, 'rejoin-vanish: after about ' + NET_GONE_S + ' s (' + took.toFixed(1) + '): the newcomer\'s pings did not count as the guest\'s');
    } finally { await cleanup(relay); }
  },
};
SCENARIOS['rejoin-quit'] = {
  what: 'a guest quits properly, then a newcomer opens the invite link: refused at once; the host plays on alone (native host, browser guest and newcomer)',
  run: async () => {
    const relay = await startRelay();
    try {
      console.log('  native host, browser guest that quits at tic 200 (' + LOAD() + ')');
      const { ms, code } = await lobbyGame(relay, ['native', 'browser'], { tics: 1200, extra: (i) => (i === 1 ? ['-testosd200,quit'] : []) });
      const g = ms[1];
      check(!!(await outHas(g, /console command at tic 200: quit/, 90000)), 'the guest quit at tic 200 (the console\'s quit)');
      await g.waitEnd(30000);
      await sleep(1000);
      await newcomerRefused(code, 'rejoin-quit');
      const st = await ms[0].waitEnd(90000);
      const out = await ms[0].out();
      check(st === 'ended' && /TEST: quitting after 1[0-9]{3} game tics/.test(out), 'rejoin-quit: the host played on alone to tic 1200 and ended with status 0 (' + st + ')');
    } finally { await cleanup(relay); }
  },
};

// Brief 05 review (S3): a game after the lobby renumbered its players. ?host=4 (the shareware limit); A and B join (players 2
// and 3); A presses Cancel, so B moves down to player 2; C joins as player 3; the host starts now with 3. B must be player 2
// and C player 3 on every machine, and every machine must agree on every tic.
SCENARIOS.compaction = {
  what: 'a game after a lobby renumbering: ?host=4, A and B join, A cancels (B moves down a place), C joins, Start now with 3: B is player 2, C player 3, every machine agrees on every tic',
  run: async () => {
    const relay = await startRelay();
    try {
      console.log('  browser host, browser A, native B, browser C (' + LOAD() + ')');
      const targs = testArgs({ tics: LOBBY_TICS, dump: 'd.bin' });
      const h = await netPage('host', '&host=4', targs);
      await h.start();
      const code = await waitRoomCode(h);
      const a = await netPage('A', '&join=' + code, targs);
      await a.start();
      check(!!(await lobbyWhen(h, (x) => x.info && x.info.joined === 2, 30000)), 'A is in: 2 of 4');
      const b = nativeMachine('B', ['-net', '-relay', relay.udp, '-room', code, '--'].concat(targs), { dump: 'd.bin' });
      await b.start();
      check(!!(await lobbyWhen(h, (x) => x.info && x.info.joined === 3, 30000)), 'B is in: 3 of 4');
      await a.page.click('#lobbycancel');
      check(!!(await lobbyWhen(h, (x) => x.info && x.info.joined === 2, 20000)), 'A cancelled: 2 of 4');
      check(!!(await outHas(h, /mmulti: a player left the room \(place 1\)/, 10000)), 'the host freed place 1 (A\'s), so B moves down from place 2');
      const c = await netPage('C', '&join=' + code, targs);
      await c.start();
      check(!!(await lobbyWhen(h, (x) => x.info && x.info.joined === 3 && !x.startDisabled, 30000)), 'C is in: 3 of 4, Start now offered');
      await h.page.click('#lobbystart');
      const ms = [h, b, c];
      for (const m of ms) { await m.waitEnd(LOBBY_TICS / NOMINAL * 1000 * 3 + 90000); }
      await checkLobbyGame(ms, 3, LOBBY_TICS);
      await a.stop(); machines.splice(machines.indexOf(a), 1);
    } finally { await cleanup(relay); }
  },
};


// The deathmatch table at a level end (StatScreen's "press space" table, brief 05 review N7): a hidden guest leaves it by itself
// too. Deathmatch test games do not end by -testquit (bugs.md L16), so this one is stopped once both machines have played 150
// tics of the next level, and the records are compared over what both played.
SCENARIOS['level-end-dm'] = {
  what: 'deathmatch: a hidden guest at the stats table after the real exit switch leaves it by itself; the next level agrees on every tic both machines played',
  run: async () => {
    const relay = await startRelay();
    try {
      console.log('  browser host, hidden browser guest, deathmatch; the exit switch at tic ' + LV_SWITCH + ' (' + LOAD() + ')');
      const { ms } = await lobbyGame(relay, ['browser', 'browser'], { tics: 100000, autonet: '-autonet 0,0,2,1,0,0,0,0,0,0', extra: () => ['-testswitch' + LV_SWITCH],
        onStart: async (i, m) => { if (i === 1) { await hideFromStart(m); } } });
      const h = ms[0], g = ms[1];
      const ok = await waitFor(async () => {
        if (/TEST: operating the exit switch/.test(await h.out())) { await key(h.page, 'Space', 120); }
        const d = await Promise.all(ms.map((m) => m.readDump().catch(() => null)));
        return d.every((x) => x && dumpLevels(x).length >= 2 && dumpLevels(x)[1].length >= 150) ? d : null;
      }, 180000);
      check(/TEST: operating the exit switch \(sprite \d+\) at tic 200\b/.test(await h.out()), 'the exit switch was operated at tic ' + LV_SWITCH);
      check(/leaves the stats screen by itself/.test(await g.out()), 'the hidden guest left the deathmatch stats table by itself');
      check(!!ok, 'both machines played 150 tics of the next level (the room did not stall)');
      if (ok) {
        const lv = ok.map(dumpLevels);
        for (const k of [0, 1]) {
          const n = Math.min(lv[0][k].length, lv[1][k].length);
          let first = -1;
          for (let r = 0; r < n && first < 0; r++) { if (!lv[0][k][r].equals(lv[1][k][r])) { first = r; } }
          check(first < 0, 'level ' + (k + 1) + ': both machines\' records agree (' + n + ' compared)', first >= 0 ? 'first difference at its tic ' + lv[0][k][first].readUInt32LE(0) : '');
        }
      }
      check(!/OUT OF SYNC/.test(await h.out()), 'the host logged no desync');
    } finally { await cleanup(relay); }
  },
};

// ---- main ---------------------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) { for (const k of Object.keys(SCENARIOS)) { console.log(k.padEnd(14) + SCENARIOS[k].what); } return 0; }
  const names = argv.length ? argv : Object.keys(SCENARIOS).filter((k) => !SCENARIOS[k].manual);
  for (const n of names) { if (!SCENARIOS[n]) { console.error('unknown scenario ' + n + ' (--list)'); return 2; } }
  for (const n of names) {
    console.log('\n== ' + n + ': ' + SCENARIOS[n].what);
    try { await SCENARIOS[n].run(); } catch (e) { check(false, n + ' ran to the end', e && e.stack || String(e)); try { await cleanup(null); } catch (e2) { /* best effort */ } }
  }
  return L.summary('netplay');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
