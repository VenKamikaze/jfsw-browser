#!/usr/bin/env node
// The browser and desktop part of tests/deploy/check-deploy.sh (brief 06): plays through a deployment the script
// set up (Apache with TLS for game.example.org, the relay behind /vnet, UDP 7777 and WebTransport on UDP 443).
// Not meant to be run alone: the script passes
//   DEPLOY_BASE       https://game.example.org/games/sw/        the deployed site (testMode: false)
//   DEPLOY_TEST_BASE  https://game.example.org/games/sw-test/   the same files with testMode: true, for -testdump only
//   DEPLOY_SPKI       base64 SHA-256 of the certificate's public key: Chromium trusts it by that hash (and, for WebTransport,
//                     with --webtransport-developer-mode, below)
//   DEPLOY_RELAY_UDP  game.example.org:7777                      what a desktop player gives -relay
//   DEPLOY_STATS      http://127.0.0.1:8081/stats               the relay's counters
//   DEPLOY_WORK       a directory for the native games
// Checks:
//   1. the deployed page with ?test=1&args=...: no test hooks, no test line, and the game does not see ?args=;
//   2. a game through the deployed page's lobby: A hosts with ?host=3, B opens the invite link, a native ./sw joins by
//      code over UDP; all three start a 3-player game with their own numbers; both browsers use WebTransport;
//   3. a co-op game of the same three through the test-mode copy (?host=3 / ?join=CODE and -room CODE, -autonet,
//      -testquit, -testdump, -testlag on the host): every machine ends with status 0 and the three dumps agree record for
//      record; both browsers over WebTransport; the host's datagram rates are printed (brief 06, known 4).
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.resolve(__dirname, '..', '..');
const BASE = process.env.DEPLOY_BASE, TBASE = process.env.DEPLOY_TEST_BASE, SPKI = process.env.DEPLOY_SPKI;
const RELAY_UDP = process.env.DEPLOY_RELAY_UDP, STATS = process.env.DEPLOY_STATS, WORK = process.env.DEPLOY_WORK;
if (!BASE || !TBASE || !SPKI || !RELAY_UDP || !STATS || !WORK) { console.error('play.js: run tests/deploy/check-deploy.sh'); process.exit(125); }
const HOSTNAME = new URL(BASE).hostname;
const TICS = 1200, REC = 17;
const WANT = process.env.DEPLOY_TRANSPORT || 'relay-wt';     // relay-ws for the guide's "Without TLS" (--no-tls)
const AUTONET = ['-autonet', '2,0,2,1,0,0,0,0,0,0'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

let fails = 0;
function check(cond, what, detail) {
  if (cond) { console.log('ok:   ' + what); } else { fails++; console.log('FAIL: ' + what + (detail ? ' (' + detail + ')' : '')); }
  return !!cond;
}
async function waitFor(fn, ms) { const t0 = now(); while (now() - t0 < ms) { const v = await fn(); if (v) { return v; } await sleep(200); } return null; }
function stats() {
  return new Promise((resolve) => {
    http.get(STATS, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { resolve(null); } }); })
      .on('error', () => resolve(null));
  });
}

let browser = null;
const natives = [];

async function page(url, name) {
  const context = await browser.newContext({ viewport: { width: 700, height: 560 } });
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  await p.goto(url);
  await p.waitForFunction(() => ['ready', 'error', 'ended'].indexOf(window.jfswState) >= 0, null, { timeout: 120000, polling: 200 });
  const m = {
    name, page: p, context, errors,
    state: () => p.evaluate(() => window.jfswState).catch(() => 'gone'),
    out: () => p.evaluate(() => (window.jfswOut || []).join('\n')).catch(() => ''),
    status: () => p.evaluate(() => document.getElementById('status').textContent).catch(() => ''),
    lobby: () => p.evaluate(() => ({ shown: !document.getElementById('lobby').hidden, code: document.getElementById('lobbycode').textContent,
      link: document.getElementById('lobbylink').value, players: document.getElementById('lobbyplayers').textContent })).catch(() => null),
    exitCode: () => p.evaluate(() => (window.jfswExit ? window.jfswExit.code : null)).catch(() => null),
    async readFile(f) {
      const b64 = await p.evaluate((n) => { const b = window.jfswTest.readFile(n); return b ? btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')) : null; }, f).catch(() => null);
      return b64 === null ? null : Buffer.from(b64, 'base64');
    },
    async stop() { try { await context.close(); } catch (e) { /* gone */ } },
  };
  return m;
}

function native(name, args, timeout) {
  const wd = path.join(WORK, name);
  fs.mkdirSync(wd, { recursive: true });
  const outFile = path.join(WORK, name + '.out');
  const out = fs.openSync(outFile, 'w');
  const child = spawn(path.join(root, 'scripts', 'run-headless.sh'), ['--workdir', wd, '--timeout', String(timeout), '--'].concat(args),
    { stdio: ['ignore', out, out], detached: true });
  const m = { name, wd, child, code: undefined };
  m.done = new Promise((r) => child.on('exit', (c) => { m.code = c; r(c); }));
  m.out = () => { try { return fs.readFileSync(outFile, 'utf8'); } catch (e) { return ''; } };
  m.stop = async () => {
    if (m.code === undefined) { try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* gone */ } await Promise.race([m.done, sleep(6000)]); try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  };
  natives.push(m);
  return m;
}

function transport(out) { const mm = /(relay-(?:ws|wt|udp))[;)]/.exec(out); return mm ? mm[1] : null; }
function started(out) { const mm = /Lobby: the game starts with (\d+) players; you are player (\d+)\./.exec(out); return mm ? { n: +mm[1], p: +mm[2] } : null; }

async function lobbyCode(m) {
  const l = await waitFor(async () => { const x = await m.lobby(); return x && /^[A-Z2-9]{6}$/.test(x.code) ? x : null; }, 40000);
  return l;
}

// ---- 1. the deployed page ignores ?test=1 ----------------------------------------------------------------
async function testModeOff() {
  console.log('== the deployed page with ?test=1');
  const evil = '-net -relay wss://relay.example.org/vnet -host-room 2 --';
  const m = await page(BASE + '?test=1&persist=0&args=' + encodeURIComponent(evil), 'test1');
  const r = await m.page.evaluate(() => ({ hooks: typeof window.jfswTest, infoHidden: document.getElementById('testinfo').hidden, text: document.getElementById('testinfo').textContent }));
  check(r.hooks === 'undefined', 'the deployed page gives ?test=1 no test hooks (window.jfswTest is ' + r.hooks + ')');
  check(r.infoHidden && !/test mode/.test(r.text), 'and shows no "test mode: args=" line');
  await m.page.click('#start');
  await sleep(4000);
  const out = await m.out();
  check(!/mmulti|relay\.example\.org/.test(out) && (await m.state()) === 'running', 'and the game does not see ?args=: a single-player game starts, no network game is tried',
    'state ' + (await m.state()) + ': ' + out.split('\n').filter((l) => /mmulti|relay/.test(l)).slice(0, 3).join(' | '));
  await m.stop();
}

// ---- 2. a game through the deployed page's lobby ---------------------------------------------------------
async function deployedLobby() {
  console.log('== the deployed page: ?host=3, the invite link, a desktop player by code');
  const a = await page(BASE + '?host=3', 'A');
  check((await a.status()) !== '' && (await a.page.evaluate(() => document.getElementById('start').textContent)) === 'Click to host a game of 3', 'A: "Click to host a game of 3"');
  await a.page.click('#start');
  const l = await lobbyCode(a);
  if (!check(!!l, 'A: the lobby shows a room code', JSON.stringify(await a.lobby()) + ' ' + (await a.status()))) { await a.stop(); return; }
  check(l.link === BASE + '?join=' + l.code, 'A: the invite link is ' + l.link);
  check(/1 of 3/.test(l.players), 'A: "' + l.players + '"');
  const b = await page(l.link, 'B');
  check((await b.page.evaluate(() => document.getElementById('start').textContent)) === 'Click to join room ' + l.code, 'B (the invite link): "Click to join room ' + l.code + '"');
  await b.page.click('#start');
  check(!!(await waitFor(async () => { const x = await b.lobby(); return x && /2 of 3/.test(x.players); }, 30000)), 'B: the lobby says 2 of 3');
  const c = native('lobby-native', ['-net', '-relay', RELAY_UDP, '-room', l.code, '--'], 60);
  const ok = await waitFor(async () => started(await a.out()) && started(await b.out()) && started(c.out()), 40000);
  check(!!ok, 'all three start the game');
  const sa = started(await a.out()), sb = started(await b.out()), sc = started(c.out());
  check(sa && sb && sc && sa.n === 3 && sb.n === 3 && sc.n === 3 && sa.p === 1 && sb.p === 2 && sc.p === 3,
    'with 3 players: A is player 1, B 2, the desktop game 3 (' + JSON.stringify([sa, sb, sc]) + ')');
  check(/relay-udp/.test(c.out()) && new RegExp('joined room ' + l.code).test(c.out()), 'the desktop game joined over UDP (' + RELAY_UDP + ')');
  const ta = transport(await a.out()), tb = transport(await b.out());
  check(ta === WANT && tb === WANT, 'both browsers use ' + WANT + ' (A ' + ta + ', B ' + tb + ')');
  const st = await stats(), nwt = WANT === 'relay-wt' ? 2 : 0;
  check(st && st.webtransports === nwt && st.websockets === 2 - nwt && st.sessions === 3, 'the relay counts 3 sessions, ' + nwt + ' of them WebTransport (' + (st ? 'sessions ' + st.sessions + ', webtransports ' + st.webtransports + ', websockets ' + st.websockets : 'no stats') + ')');
  check(a.errors.length === 0 && b.errors.length === 0, 'no page errors', a.errors.concat(b.errors).join('; '));
  await a.stop(); await b.stop(); await c.stop();
}

// ---- 3. a co-op game with per-tic records (the test-mode copy) ----------------------------------------------
function rates(out) {
  const r = []; const re = /TEST: lag: (\d+) datagrams \((\d+) bytes\) to player (\d+) in (\d+) ms/g; let mm;
  while ((mm = re.exec(out))) { r.push({ to: +mm[3], n: +mm[1], bytes: +mm[2], ms: +mm[4] }); }
  return r;
}
async function dumpGame() {
  console.log('== a co-op game of 2 browsers and a desktop game, ' + TICS + ' tics, every tic recorded (the test-mode copy ' + TBASE + ')');
  const targs = (extra) => AUTONET.concat(['-testsync', '-testquit' + TICS, '-testdumpd.bin'], extra || []);
  const q = (net, extra) => '?test=1&persist=0&' + net + '&args=' + encodeURIComponent(targs(extra).join(' '));
  const a = await page(TBASE + q('host=3', ['-testlaglag.bin']), 'A');
  await a.page.click('#start');
  const l = await lobbyCode(a);
  if (!check(!!l, 'A hosts room ' + (l ? l.code : '?'))) { await a.stop(); return; }
  const b = await page(TBASE + q('join=' + l.code.toLowerCase()), 'B');
  await b.page.click('#start');
  await waitFor(async () => /Lobby: 2 of 3 players are in/.test(await a.out()), 30000);
  const c = native('dump-native', ['-net', '-relay', RELAY_UDP, '-room', l.code, '--'].concat(targs()), 200);
  const t0 = now();
  // datagrams each browser's WebTransport dropped because too many were still being handed to the browser (vnet relay_wt.c)
  const wtDrops = { A: 0, B: 0 };
  const sampleDrops = async () => {
    for (const m of [a, b]) {
      const d = await m.page.evaluate(() => { const T = window.Module && Module.vnetWT; return T ? Object.values(T.s).reduce((x, s) => x + (s.drops || 0), 0) : 0; }).catch(() => 0);
      wtDrops[m.name] = Math.max(wtDrops[m.name], d);
    }
  };
  const ended = await waitFor(async () => { await sampleDrops(); return (await a.state()) !== 'running' && (await b.state()) !== 'running' && c.code !== undefined; }, 180000);
  check(!!ended, 'the game ended on every machine (' + ((now() - t0) / 1000).toFixed(1) + ' s)');
  const ms = [a, b];
  const dumps = [];
  for (const m of ms) {
    const out = await m.out();
    check((await m.exitCode()) === 0, m.name + ' ended with status 0', (await m.status()));
    const line = /TEST: quitting after (\d+) game tics: (\d+) sync checks, (\d+) mismatches, (\d+) sync bytes, player (\d+) of (\d+)/.exec(out);
    check(!!line && +line[1] >= TICS && +line[6] === 3, m.name + ': ' + (line ? line[0] : 'no TEST line'));
    check(!/OUT OF SYNC|CheckVersion\(\)/.test(out), m.name + ' logged no desync and no version mismatch');
    check(transport(out) === WANT, m.name + ' played over ' + WANT + ' (' + transport(out) + ')');
    check(m.errors.length === 0, m.name + ': no page errors', m.errors.join('; '));
    dumps.push(await m.readFile('d.bin'));
  }
  {
    const out = c.out();
    check(c.code === 0, 'the desktop game ended with status 0 (' + c.code + ')');
    const line = /TEST: quitting after (\d+) game tics: .* player (\d+) of (\d+)/.exec(out);
    check(!!line && +line[1] >= TICS && +line[3] === 3, 'the desktop game: ' + (line ? line[0] : 'no TEST line'));
    check(!/OUT OF SYNC|CheckVersion\(\)/.test(out), 'the desktop game logged no desync and no version mismatch');
    let d = null; try { d = fs.readFileSync(path.join(c.wd, 'd.bin')); } catch (e) { /* none */ }
    dumps.push(d);
  }
  const lens = dumps.map((d) => (d ? d.length / REC : 0));
  if (check(dumps.every((d) => d && d.length % REC === 0 && d.length / REC >= TICS), 'every machine recorded at least ' + TICS + ' tics (' + lens.join(', ') + ')')) {
    const n = Math.min(...lens);
    let diff = -1;
    for (let i = 0; i < n && diff < 0; i++) {
      const r0 = dumps[0].subarray(i * REC, (i + 1) * REC);
      if (!dumps.every((d) => d.subarray(i * REC, (i + 1) * REC).equals(r0))) { diff = i; }
    }
    check(diff < 0, 'all three machines agree on every tic, record for record (' + n + ' tics)', 'first difference at record ' + diff);
  }
  {
    // how fast the game ran on the host: -testlag's records (36 bytes: tic, made, ready, ran, ...; microseconds)
    const lag = await a.readFile('lag.bin');
    if (lag && lag.length >= 36 * 400) {
      const n = Math.floor(lag.length / 36), ran = (i) => lag.readUInt32LE(i * 36 + 12);
      const t1 = ran(100), t2 = ran(n - 1);
      const tps = (n - 101) / ((t2 - t1) / 1e6);
      // Not a check: a browser host with two guests over WebTransport runs slow (bugs.md L25), which this brief records and
      // does not fix (vnet's send queue). Over WebSocket the same game runs at 40.
      console.log((tps < 36 ? 'WARNING: ' : 'note: ') + 'the host ran tics 100 to ' + (n - 1) + ' at ' + tps.toFixed(1) + ' tics a second (nominal 40)' +
        (tps < 36 ? ': slower than it should be (bugs.md L25: WebTransport, a browser host with two guests)' : ''));
    }
  }
  console.log('note: WebTransport datagrams dropped by the browsers\' send queues (vnet): A ' + wtDrops.A + ', B ' + wtDrops.B);
  const r = rates(await a.out());
  if (r.length) {
    const per = r.map((x) => (x.n / x.ms * 1000).toFixed(1)), tot = r.reduce((s, x) => s + x.n / x.ms * 1000, 0), bytes = r.reduce((s, x) => s + x.bytes / x.ms * 1000, 0);
    const frames = r.reduce((s, x) => s + x.n, 0), payload = r.reduce((s, x) => s + x.bytes, 0);
    console.log('note: the browser host sent ' + tot.toFixed(1) + ' datagrams a second (' + per.join(' and ') + ' to each), ' + bytes.toFixed(0) + ' bytes a second of payload, ' +
      (payload / frames).toFixed(1) + ' bytes a datagram (relay frames add 9 bytes over WebSocket and WebTransport, 25 over UDP)');
  }
  const st = await stats();
  check(st && st.rate_limited === 0, 'the relay dropped nothing for its rate limits (rate_limited ' + (st ? st.rate_limited : '?') + ')');
  await a.stop(); await b.stop(); await c.stop();
}

(async () => {
  let code = 0;
  try {
    // The self-signed certificate is trusted by its key hash (TLS: the page, wss://). WebTransport (QUIC) also needs
    // --webtransport-developer-mode: without it Chromium refuses a certificate that does not chain to a public root, even
    // one trusted by hash or in the NSS store (QUIC_TLS_CERTIFICATE_UNKNOWN). --origin-to-force-quic-on does not do: it
    // sends the page's own requests to the relay's HTTP/3 listener (404).
    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP ' + HOSTNAME + ' 127.0.0.1', '--ignore-certificate-errors-spki-list=' + SPKI,
      '--webtransport-developer-mode', '--no-proxy-server'] });
    await testModeOff();
    await deployedLobby();
    await dumpGame();
  } catch (e) {
    fails++; console.log('FAIL: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  } finally {
    for (const m of natives) { await m.stop(); }
    if (browser) { await browser.close().catch(() => {}); }
  }
  code = fails === 0 ? 0 : 1;
  console.log('play.js: ' + (fails === 0 ? 'all checks passed' : fails + ' check(s) failed'));
  process.exit(code);
})();
