#!/usr/bin/env node
// Browser netplay tests (brief 04): browsers (Playwright + Chromium) and native games play bounded
// network games through a local vnet relay, and every machine's own record of every game tic is
// compared byte for byte.
//
//   node tests/web/netplay.js                      # every scenario, one after the other (about 30 minutes)
//   node tests/web/netplay.js ws wt                # only these
//   node tests/web/netplay.js --list
//   WASM_DIR=build-wasm-x node tests/web/netplay.js ws    # another build of the page (mutation runs)
//
// Scenarios (see SCENARIOS below for what each checks):
//   ws, ws3, browser-host, native-host, wt, impaired, impaired-wt, hidden-slave, hidden-host,
//   hidden-local, frozen-slave, frozen-host, errors, knobs, nudge-slave, nudge-master, long
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
const { serve } = require('./server.js');
const L = require('./lib.js');

const PORT_WEB = 48300, PORT_UDP = 48301, PORT_HTTP = 48302, PORT_WT = 48303;
const NOMINAL = 40;                       // game tics a second (120 Hz clock, 3 clock ticks a game tic)
const REC = 17;                           // bytes per tic in a -testdump file
const AUTONET = '-autonet 2,0,2,1,0,0,0,0,0,0';
const check = L.check;

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
    '-origins', '127.0.0.1:' + PORT_WEB, '-v'].concat(extra || []);
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
async function env() {
  if (!browserEnv) {
    if (!fs.existsSync(path.join(L.BUILD, 'sw.wasm'))) { throw new Error(L.BUILD + '/sw.wasm not found: run scripts/build-wasm.sh'); }
    if (!fs.existsSync(L.GRP)) { throw new Error(L.GRP + ' not found: run scripts/fetch-test-data.sh'); }
    const server = await serve(L.BUILD, { '/swshare.grp': L.GRP }, PORT_WEB);
    const browser = await chromium.launch();
    browserEnv = { server, browser, base: 'http://127.0.0.1:' + PORT_WEB + '/index.html' };
  }
  return browserEnv;
}
async function closeEnv() {
  if (!browserEnv) { return; }
  try { await browserEnv.browser.close(); } catch (e) { /* gone */ }
  await new Promise((r) => browserEnv.server.close(r));
  browserEnv = null;
}

const machines = [];
let tmpRoot = null;
function tmp() { if (!tmpRoot) { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jfsw-netplay-')); } return tmpRoot; }

function gameArgs(o) {
  // o: { net: [..args after -net..], tics, dump, nudge, extra }
  const a = ['-net'].concat(o.net, ['--']);
  if (o.autonet !== false) { a.push(...AUTONET.split(' ')); }
  if (o.testsync !== false) { a.push('-testsync'); }
  if (o.tics) { a.push('-testquit' + o.tics); }
  if (o.dump) { a.push('-testdump' + o.dump); }
  if (o.nudge) { a.push('-testnudge' + o.nudge); }
  return a.concat(o.extra || []);
}

// A browser machine. o.relay is the URL given to -relay; o.query adds page parameters (knobs); o.hidden imitates a hidden tab.
async function browserMachine(name, args, o) {
  o = o || {};
  const e = await env();
  const context = await e.browser.newContext({ viewport: { width: 700, height: 560 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (er) => errors.push('pageerror: ' + er.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  const q = '?test=1&persist=0&args=' + encodeURIComponent(args.join(' ')) + (o.query || '');
  await page.goto(e.base + q);
  await L.waitState(page, 'ready', 60000);
  const m = {
    kind: 'browser', name, page, context, errors, started: 0,
    async start() { await page.click('#start'); m.started = now(); },
    out: () => page.evaluate(() => window.jfswOut.join('\n')).catch(() => ''),
    async state() { return page.evaluate(() => window.jfswState).catch(() => 'gone'); },
    async dumpSize() {
      return page.evaluate((f) => { try { return window.jfswTest.FS.stat('/persist/' + f).size; } catch (er) { return 0; } }, o.dump || 'd.bin').catch(() => 0);
    },
    async readDump() {
      const b64 = await page.evaluate((f) => { const b = window.jfswTest.readFile(f); return b ? btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')) : null; }, o.dump || 'd.bin');
      return b64 === null ? null : Buffer.from(b64, 'base64');
    },
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

// A native machine (scripts/run-headless.sh). o.relay is HOST:PORT; o.impair a VNET_IMPAIR spec.
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
      m.child = spawn(path.join(L.root, 'scripts', 'run-headless.sh'), ['--workdir', wd, '--timeout', String(o.timeout || 240), '--'].concat(args),
        { env: envv, stdio: ['ignore', out, out], detached: true });
      m.done = new Promise((r) => m.child.on('exit', (c, s) => { m.code = c; r(c); }));
      m.started = now();
    },
    out: async () => { try { return fs.readFileSync(outFile, 'utf8'); } catch (e) { return ''; } },
    async state() { return m.code === undefined ? 'running' : (m.code === 0 ? 'ended' : 'error'); },
    async dumpSize() { try { return fs.statSync(path.join(wd, o.dump || 'd.bin')).size; } catch (e) { return 0; } },
    async readDump() { try { return fs.readFileSync(path.join(wd, o.dump || 'd.bin')); } catch (e) { return null; } },
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
  if (!opts.desyncExpected) { compareDumps(ms, dumps, tics); }
  return dumps;
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
        return { index: i, tic: a.readUInt32LE(0), against: k, what: diff.join(',') };
      }
    }
  }
  return null;
}

function compareDumps(ms, dumps, tics) {
  const ok = dumps.every((d) => d && d.length % REC === 0 && d.length / REC >= tics);
  check(ok, 'every machine wrote at least ' + tics + ' tics to its dump (' + dumps.map((d) => d ? d.length / REC : 'none').join(', ') + ')');
  if (!ok) { return; }
  const diff = firstDifference(dumps);
  check(!diff, 'all ' + ms.length + ' machines agree on every tic (' + dumps.map((d) => d.length / REC).join(', ') + ' tics each; byte for byte)',
    diff ? 'first difference at tic ' + diff.tic + ' (record ' + diff.index + '): ' + ms[0].name + ' against ' + ms[diff.against].name + ' differ in ' + diff.what : '');
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
    let done = true;
    for (let i = 0; i < ms.length; i++) {
      const tics = Math.floor((await ms[i].dumpSize()) / REC);
      series[i].push([now() - t0, tics]);
      if (tics < until && (await ms[i].state()) === 'running') { done = false; }
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
  if (!a || !b || b[0] <= a[0]) { return 0; }
  return (b[1] - a[1]) / ((b[0] - a[0]) / 1000);
}

// ---- scenarios ---------------------------------------------------------------------------------------

const TICS = 1200;
const LOAD = () => 'load average ' + os.loadavg().map((x) => x.toFixed(1)).join(' ');

// Two or more machines in one room. `kinds` is a list of 'browser' | 'native' (the first hosts). Returns
// { ms, relay }. o: tics, query (page knobs, per machine index function), impair(i), hidden, nudge: {i: tic}.
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
    const args = gameArgs({ net: net(kinds[i]), tics, dump: 'd.bin', nudge: o.nudge && o.nudge[i] });
    const impair = o.impair ? o.impair(i) : null;
    let m;
    if (kinds[i] === 'browser') {
      const q = (o.query ? o.query(i, relay) : '') + (impair ? '&impair=' + encodeURIComponent(impair) : '');
      m = await browserMachine(name, args, { query: q, dump: 'd.bin' });
    } else {
      m = nativeMachine(name, args, { impair, dump: 'd.bin' });
    }
    ms.push(m);
    await m.start();
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
    await checkGame(ms, (o && o.tics) || TICS);
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

const IMPAIR = (i) => 'lat=30,jit=10,loss=4,dup=2,reorder=3,seed=' + (101 + i);
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

// A hidden, throttled tab as slave or as host: the room must keep at least 90 % of the nominal tic rate, measured on
// the OTHER machine (the one that is visible), over at least 30 s; and everyone still agrees.
const HIDDEN_TICS = 1500, FROM = 250, TO = 1450;
async function hiddenRoom(kinds, hiddenIndex, label) {
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ', ' + (hiddenIndex === 0 ? 'the host' : 'the slave') + ' hidden (' + LOAD() + ')');
    const ms = await room(relay, kinds, { tics: HIDDEN_TICS });
    const h = ms[hiddenIndex];
    let hidden = false, framesAtHide = 0, hiddenLogAtHide = 0, framesEnd = 0, hiddenLogEnd = 0;
    const series = await sample(ms, HIDDEN_TICS, 200000, async (t, ser) => {
      const tics = ser[hiddenIndex][ser[hiddenIndex].length - 1][1];
      if (!hidden && tics >= 100 && h.kind === 'browser') {
        hidden = true;
        await hide(h.page, true);
        await sleep(300);
        framesAtHide = await h.page.evaluate(() => Module.jfswFrameLog.length);
        hiddenLogAtHide = await h.page.evaluate(() => Module.jfswHiddenLog.length);
        console.log('  ' + h.name + ' hidden at tic ' + tics);
      }
    });
    for (const m of ms) { await m.waitEnd(60000); }
    const wakes = await h.page.evaluate(() => ({ wakes: Module.jfswWakes, log: Module.jfswHiddenLog.length, frames: Module.jfswFrameLog.length, reasons: Module.jfswHiddenLog.reduce((a, r) => { a[r] = (a[r] || 0) + 1; return a; }, {}) })).catch(() => null);
    await checkGame(ms, HIDDEN_TICS);
    const rates = ms.map((m, i) => rate(series[i], FROM, TO));
    console.log('  tic rates between tic ' + FROM + ' and ' + TO + ': ' + ms.map((m, i) => m.name + (i === hiddenIndex ? '(hidden)' : '') + ' ' + rates[i].toFixed(1)).join(', ') + ' (nominal ' + NOMINAL + '); ' + LOAD());
    for (let i = 0; i < ms.length; i++) {
      if (i === hiddenIndex) { continue; }
      check(rates[i] >= 0.9 * NOMINAL, ms[i].name + ' (visible) ran at ' + rates[i].toFixed(1) + ' tics a second, at least 90% of ' + NOMINAL, 'got ' + rates[i].toFixed(1));
    }
    check(rates[hiddenIndex] >= 0.9 * NOMINAL, h.name + ' (hidden) ran at ' + rates[hiddenIndex].toFixed(1) + ' tics a second too', 'got ' + rates[hiddenIndex].toFixed(1));
    if (wakes) {
      console.log('  hidden tab: ' + wakes.wakes + ' wake-ups, ' + wakes.log + ' hidden yields (resumed by: ' + JSON.stringify(wakes.reasons) + '), ' + wakes.frames + ' frame yields (' + framesAtHide + ' when it was hidden)');
      check(wakes.log - hiddenLogAtHide > 200, h.name + ' was driven by hidden-tab passes (' + (wakes.log - hiddenLogAtHide) + ' after it was hidden)');
      check((wakes.reasons[1] || 0) > 0.8 * wakes.log, h.name + ' was resumed by network events, not the timer (' + (wakes.reasons[1] || 0) + ' of ' + wakes.log + ')');
      check(wakes.frames - framesAtHide < 40, h.name + ' drew no more pictures while hidden (' + (wakes.frames - framesAtHide) + ' frame yields after hiding)');
    }
  } finally { await cleanup(relay); }
}
SCENARIOS['hidden-slave'] = {
  what: 'a hidden, throttled browser slave: the room keeps at least 90% of 40 tics a second, all agree',
  run: () => hiddenRoom(['browser', 'browser'], 1),
};
SCENARIOS['hidden-host'] = {
  what: 'a hidden, throttled browser host with a native slave: the same',
  run: () => hiddenRoom(['browser', 'native'], 0),
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
async function frozenRoom(kinds, frozenIndex) {
  const relay = await startRelay();
  try {
    console.log('  ' + kinds.join(' + ') + ', ' + (frozenIndex === 0 ? 'the host' : 'the slave') + ' frozen for 5 s (' + LOAD() + ')');
    const ms = await room(relay, kinds, { tics: TICS });
    const f = ms[frozenIndex];
    let froze = false, before = 0, during = [];
    const series = await sample(ms, TICS, 200000, async (t, ser) => {
      const tics = ser[frozenIndex][ser[frozenIndex].length - 1][1];
      if (!froze && tics >= 300) {
        froze = true;
        before = ms.map((m, i) => ser[i][ser[i].length - 1][1]);
        console.log('  freezing ' + f.name + ' at tic ' + tics);
        const t0 = now();
        await freeze(f.page, 5000);
        console.log('  ' + f.name + ' was frozen for ' + ((now() - t0) / 1000).toFixed(1) + ' s');
      }
    });
    for (const m of ms) { await m.waitEnd(60000); }
    await checkGame(ms, TICS);
    check(froze, 'the tab was frozen in the middle of the game (at tic ' + before[frozenIndex] + ')');
    // the other machines did stop for the freeze (nobody can move without the frozen player's input)
    const other = ms.findIndex((m, i) => i !== frozenIndex);
    const gaps = []; for (let k = 1; k < series[other].length; k++) { gaps.push(series[other][k][0] - series[other][k - 1][0]); }
    const maxGap = Math.max(...gaps);
    check(maxGap >= 4000, 'the sampling loop itself stalled for the freeze (' + (maxGap / 1000).toFixed(1) + ' s between samples), so the room really waited');
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

// ---- main ---------------------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) { for (const k of Object.keys(SCENARIOS)) { console.log(k.padEnd(14) + SCENARIOS[k].what); } return 0; }
  const names = argv.length ? argv : Object.keys(SCENARIOS);
  for (const n of names) { if (!SCENARIOS[n]) { console.error('unknown scenario ' + n + ' (--list)'); return 2; } }
  for (const n of names) {
    console.log('\n== ' + n + ': ' + SCENARIOS[n].what);
    try { await SCENARIOS[n].run(); } catch (e) { check(false, n + ' ran to the end', e && e.stack || String(e)); try { await cleanup(null); } catch (e2) { /* best effort */ } }
  }
  return L.summary('netplay');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
