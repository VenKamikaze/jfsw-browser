#!/usr/bin/env node
// The page in a stock Firefox (brief 02c, bugs.md L24): a refused pointer lock does not end the game.
//
//   scripts/setup-firefox.sh                 # once: a pinned Firefox and puppeteer-core, in ~/.cache/jfsw-browser
//   node tests/web/firefox.js                # uses build-wasm/ and testdata/swshare.grp
//   FIREFOX=/usr/bin/firefox node tests/web/firefox.js           # another Firefox (Arch: the packaged one)
//   FIREFOX_SABOTAGE=unhandled node tests/web/firefox.js         # the lock's promise left unhandled, as before the fix: must FAIL
//   WASM_DIR=other node tests/web/firefox.js                     # another build (one from before the fix must FAIL)
//
// Not part of the default runs: it needs a Firefox that the other tests do not. Without one it prints "NOT RUN" and
// exits with status 3; that is not a pass.
//
// Headless Firefox never gives the page the focus (document.hasFocus() is false), so it refuses every pointer-lock
// request: "The document is not focused.", as a desktop Firefox does after Alt+Tab. Its DOMException has a stack
// through sw.js, which before the fix made the page show "Something went wrong" (the user's report). The game asks
// for the lock at start-up (grabmouse(1) in jfbuild/src/sdlayer2.c) and on every click on the canvas.
// 1. A single player game: the refusal at start-up and after a click are logged, the game keeps running, no overlay.
// 2. A wasm trap in the game's frame is still fatal in Firefox, with ?persist=0 and with persistence on.
// 3. A network game through a local relay: Chromium (Playwright) hosts by ?host=2, Firefox joins by ?join=CODE with
//    persistence on; 400 tics; both end by themselves and agree on every tic (-testdump), Firefox showed no overlay on
//    the way, and its end says "The game has ended." (not a refusal at the exit taken for an error).
// Ports: 48400 (page), 48401 (relay UDP), 48402 (relay WebSocket).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const t = require('./lib.js');
const { serve, configText } = require('./server.js');

const FIREFOX_VERSION = '160.0', PUPPETEER_VERSION = '25.17.0';   // as scripts/setup-firefox.sh installs them
const CACHE = process.env.FIREFOX_CACHE || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'jfsw-browser');
const FIREFOX = process.env.FIREFOX || path.join(CACHE, 'firefox-' + FIREFOX_VERSION, 'firefox', 'firefox');
const PUPPETEER = process.env.PUPPETEER_CORE || path.join(CACHE, 'puppeteer-core-' + PUPPETEER_VERSION, 'node_modules', 'puppeteer-core');
const PORT_WEB = t.port(48400), PORT_UDP = t.port(48401), PORT_HTTP = t.port(48402);   // (JFSW_WEB_PORT_OFFSET, lib.js)
const SABOTAGE = process.env.FIREFOX_SABOTAGE === 'unhandled';
const MSG = 'The document is not focused.';
const TICS = 400;
// Single player games start in a level: in headless Firefox, which plays no sound, the title sequence stops drawing
// after a few seconds (it waits for its sound), so frames would stop coming there for a reason of its own.
const LEVEL = '?test=1&persist=0&args=' + encodeURIComponent('-level3 -s1');
const LEVEL_PERSIST = '?test=1&args=' + encodeURIComponent('-level3 -s1');      // the game's folder kept in IndexedDB, as on a real page
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notRun(why) {
  console.log('firefox: NOT RUN: ' + why);
  console.log('  (scripts/setup-firefox.sh installs a pinned Firefox and puppeteer-core; FIREFOX=/path/to/firefox uses another Firefox)');
  process.exit(3);
}
// The cache holds other versions than the ones this test pins (scripts/setup-firefox.sh was changed, or not run since).
function versionMismatch(what, want, dirPrefix) {
  let have = [];
  try { have = fs.readdirSync(CACHE).filter((d) => d.startsWith(dirPrefix)).map((d) => d.slice(dirPrefix.length)); } catch (e) { /* no cache */ }
  if (!have.length) { return; }
  console.log(`firefox: VERSION MISMATCH: this test wants ${what} ${want}, the cache (${CACHE}) has ${have.join(', ')}`);
  console.log('  (run scripts/setup-firefox.sh; or FIREFOX=/path/to/firefox, PUPPETEER_CORE=/path/to/puppeteer-core to use others)');
  process.exit(3);
}

// Before the page's scripts: count what the browser does with pointer-lock requests, and unhandled rejections.
function watchLocks() {
  window.__ff = { lockErrors: 0, lockChanges: 0, unhandled: 0 };
  document.addEventListener('pointerlockerror', () => { window.__ff.lockErrors++; });
  document.addEventListener('pointerlockchange', () => { window.__ff.lockChanges++; });
  window.addEventListener('unhandledrejection', () => { window.__ff.unhandled++; }, true);
}

async function launchFirefox(puppeteer) {
  return puppeteer.launch({
    browser: 'firefox', executablePath: FIREFOX, headless: true, defaultViewport: null, args: ['--width=1000', '--height=800'],
    // the persistent-storage prompt (data.js asks for persistent storage) answered without a doorhanger
    extraPrefsFirefox: { 'dom.storageManager.prompt.testing': true, 'dom.storageManager.prompt.testing.allow': true },
  });
}
// The browser's first tab (each part has a Firefox of its own).
async function firefoxPage(browser, url) {
  const page = (await browser.pages())[0] || await browser.newPage();
  const warnings = [], errors = [];
  page.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'warning') { warnings.push(m.text()); } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + ((e && e.message) || e)));
  await page.evaluateOnNewDocument(watchLocks);
  await page.goto(url);
  await page.waitForFunction(() => window.jfswState === 'ready' || window.jfswState === 'error', { timeout: 120000, polling: 200 });
  if (SABOTAGE) { await page.evaluate(() => { window.jfswTest.unhandledPointerLock = true; }); }
  return { page, warnings, errors };
}
const pageState = (page) => page.evaluate(() => ({
  state: window.jfswState, overlay: !document.getElementById('overlay').hidden, status: document.getElementById('status').textContent,
  frames: Module.jfswFrameLog.length, focus: document.hasFocus(), ff: window.__ff,
}));

async function single(puppeteer, base) {
  const browser = await launchFirefox(puppeteer);
  try { await singleIn(browser, base); } finally { await browser.close().catch(() => {}); }
}
async function singleIn(browser, base) {
  console.log('1. single player' + (SABOTAGE ? ' (SABOTAGE: the promise is left unhandled, as before the fix)' : ''));
  const { page, warnings, errors } = await firefoxPage(browser, base + LEVEL);
  await page.click('#start');
  await sleep(6000);
  let s = await pageState(page);
  t.check(!s.focus, 'headless Firefox: the page does not have the focus (so every pointer-lock request is refused)');
  t.check(s.ff.lockErrors >= 1 && s.ff.lockChanges === 0, `the game asked for the lock at start-up and Firefox refused (${s.ff.lockErrors} refusals)`);
  t.check(s.state === 'running' && !s.overlay, `the game is still running, no overlay (state ${s.state})`, s.status);
  t.check(warnings.some((w) => w.indexOf('pointer lock refused: ' + MSG) >= 0), 'the refusal is logged ("pointer lock refused: ' + MSG + '")', warnings.slice(0, 3).join(' | '));
  const f0 = s.frames;
  await sleep(2000);
  s = await pageState(page);
  t.check(s.frames - f0 > 10, `frames keep coming (${s.frames - f0} in 2 s)`);
  const refusals = s.ff.lockErrors;
  const box = await (await page.$('#canvas')).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(1500);
  s = await pageState(page);
  t.check(s.ff.lockErrors > refusals, `a click on the canvas asks again, and is refused again (${refusals} to ${s.ff.lockErrors} refusals)`);
  t.check(s.state === 'running' && !s.overlay, `still running, no overlay (state ${s.state})`, s.status);
  t.check(s.ff.unhandled === 0 && errors.length === 0, `no unhandled rejection or page error (${s.ff.unhandled})`, errors.join(' | '));
  if (s.overlay) { console.log('  (the page said: ' + s.status + ')'); }
}

async function trap(puppeteer, base, persist) {
  const browser = await launchFirefox(puppeteer);
  try { await trapIn(browser, base, persist); } finally { await browser.close().catch(() => {}); }
}
// persist: the game's folder kept in IndexedDB (every real page; the exit's save delays "The game has ended.") or not
async function trapIn(browser, base, persist) {
  console.log('2. a wasm trap is still fatal' + (persist ? ' (persistence on)' : ' (?persist=0)'));
  const { page } = await firefoxPage(browser, base + (persist ? LEVEL_PERSIST : LEVEL));
  await page.click('#start');
  await sleep(5000);
  const before = await pageState(page);
  await page.evaluate(() => {      // as focus.js: free() of an address beyond memory, inside the game's frame (sdlayer2.c's EM_JS in sw.js)
    let n = Module.jfswShowframes, armed = true;
    Object.defineProperty(Module, 'jfswShowframes', { configurable: true, get() { if (armed) { armed = false; Module._free(HEAPU8.length + 4096); } return n; }, set(v) { n = v; } });
  });
  await sleep(2000);
  const s = await pageState(page);
  t.check(before.state === 'running' && s.state === 'error' && s.overlay && /^(Something went wrong|The game crashed): .*\. Reload the page to try again\.$/.test(s.status) && !/\.\./.test(s.status),
    `a trap in the game's frame shows the overlay ("${s.status}")`);
}

// The relay, built as tests/web/netplay.js builds it.
function relayBinary() {
  let rev = 'unknown';
  try { rev = execSync('git -C ' + JSON.stringify(path.join(t.root, 'ext', 'vnet')) + ' rev-parse --short HEAD').toString().trim(); } catch (e) { /* no git */ }
  const bin = path.join(CACHE, 'vnet-relay-' + rev);
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const env = Object.assign({}, process.env, { PATH: process.env.PATH + ':/usr/local/go/bin' });
    execSync('go build -o ' + JSON.stringify(bin + '.tmp') + ' ./cmd/vnet-relay', { cwd: path.join(t.root, 'ext', 'vnet', 'relay'), env, stdio: 'inherit' });
    fs.renameSync(bin + '.tmp', bin);
  }
  return bin;
}
async function startRelay() {
  const child = spawn(relayBinary(), ['-udp', '127.0.0.1:' + PORT_UDP, '-http', '127.0.0.1:' + PORT_HTTP, '-origins', '127.0.0.1:' + PORT_WEB, '-v'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let text = '';
  child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; });
  const t0 = Date.now();
  while (!/^LISTEN /m.test(text)) {
    if (child.exitCode !== null) { throw new Error('the relay exited: ' + text); }
    if (Date.now() - t0 > 15000) { throw new Error('the relay did not start: ' + text); }
    await sleep(100);
  }
  return { child, stop: async () => { try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* gone */ } await sleep(200); try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } } };
}

async function network(puppeteer, base) {
  console.log('3. a network game: Chromium hosts, Firefox joins (Firefox with persistence on)');
  const { chromium } = require('playwright');
  const relay = await startRelay();
  const chrome = await chromium.launch();
  const browser = await launchFirefox(puppeteer);
  try {
    const args = encodeURIComponent(['-autonet', '2,0,2,1,0,0,0,0,0,0', '-testsync', '-testquit' + TICS, '-testdumpd.bin'].join(' '));
    const host = await (await chrome.newContext({ viewport: { width: 700, height: 560 } })).newPage();
    await host.goto(base + '?test=1&persist=0&host=2&args=' + args);
    await host.waitForFunction(() => window.jfswState === 'ready', null, { timeout: 120000 });
    await host.click('#start');
    await host.waitForFunction(() => window.jfswLobby && window.jfswLobby.code, null, { timeout: 40000 });
    const code = await host.evaluate(() => window.jfswLobby.code);
    // Firefox with persistence on, as on a real page (the end of its game is then reported after the exit's save)
    const g = await firefoxPage(browser, base + '?test=1&join=' + code + '&args=' + args);
    await g.page.click('#start');
    // until both have ended; Firefox's overlay is watched on the way (it would show over a running game)
    let overlaySeen = '';
    const t0 = Date.now();
    let hs, gs;
    while (Date.now() - t0 < 120000) {
      gs = await pageState(g.page);
      hs = await host.evaluate(() => ({ state: window.jfswState, status: document.getElementById('status').textContent }));
      if (gs.overlay && gs.state !== 'ended' && !overlaySeen) { overlaySeen = gs.status; }
      if (['ended', 'error'].includes(gs.state) && ['ended', 'error'].includes(hs.state)) { break; }
      await sleep(500);
    }
    const exitG = await g.page.evaluate(() => window.jfswExit && window.jfswExit.code);
    const exitH = await host.evaluate(() => window.jfswExit && window.jfswExit.code);
    t.check(gs.ff.lockErrors >= 1, `Firefox refused the game's pointer-lock request (${gs.ff.lockErrors} refusals)`);
    t.check(!overlaySeen && gs.state === 'ended' && exitG === 0 && /^The game has ended\./.test(gs.status), `Firefox: no overlay while the game ran, and it ended by itself with "The game has ended." (state ${gs.state}, exit ${exitG})`, overlaySeen || gs.status);
    await sleep(1500);      // the summary of a burst of refusals comes a second after its last one
    const audio = g.warnings.filter((w) => /^audio resume refused/.test(w));
    t.check(audio.length <= 2, `Firefox: the audio refusals at the end are at most two lines, the first and a count (${audio.length}: ${audio.slice(0, 2).join(' | ')})`);
    t.check(hs.state === 'ended' && exitH === 0, `Chromium: the game ended by itself (state ${hs.state}, exit ${exitH})`, hs.status);
    const read = async (p) => { const b64 = await p.evaluate(() => { const b = window.jfswTest.readFile('d.bin'); return b ? btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')) : null; }); return b64 === null ? null : Buffer.from(b64, 'base64'); };
    const dg = await read(g.page), dh = await read(host);
    // as netplay.js: each machine wrote at least TICS records (17 bytes a tic), and they agree on every tic both wrote
    const tics = (d) => (d ? d.length / 17 : 0);
    const n = Math.min(tics(dg), tics(dh));
    t.check(dg && dh && n >= TICS && dg.subarray(0, n * 17).equals(dh.subarray(0, n * 17)), `both played at least ${TICS} tics and agree on every one (Firefox ${tics(dg)}, Chromium ${tics(dh)})`);
    t.check(gs.ff.unhandled === 0 && g.errors.length === 0, `Firefox: no unhandled rejection or page error (${gs.ff.unhandled})`, g.errors.join(' | '));
  } finally {
    await browser.close().catch(() => {});
    await chrome.close().catch(() => {});
    await relay.stop();
  }
}

async function main() {
  if (!fs.existsSync(FIREFOX)) {
    if (!process.env.FIREFOX) { versionMismatch('Firefox', FIREFOX_VERSION, 'firefox-'); }
    notRun('no Firefox at ' + FIREFOX);
  }
  let puppeteer;
  try { puppeteer = require(PUPPETEER); } catch (e) {
    if (!process.env.PUPPETEER_CORE) { versionMismatch('puppeteer-core', PUPPETEER_VERSION, 'puppeteer-core-'); }
    notRun('no puppeteer-core at ' + PUPPETEER);
  }
  const version = execSync(JSON.stringify(FIREFOX) + ' --version').toString().trim();
  if (version.indexOf(' ' + FIREFOX_VERSION) < 0) {
    if (!process.env.FIREFOX) {
      console.log(`firefox: VERSION MISMATCH: ${FIREFOX} says "${version}", this test wants ${FIREFOX_VERSION} (run scripts/setup-firefox.sh)`);
      process.exit(3);
    }
    console.log(`(FIREFOX: "${version}", not the pinned ${FIREFOX_VERSION}; the results are for that version)`);
  }
  if (!fs.existsSync(path.join(t.BUILD, 'sw.wasm'))) { throw new Error(`${t.BUILD}/sw.wasm not found: run scripts/build-wasm.sh`); }
  if (!fs.existsSync(t.GRP)) { throw new Error(`${t.GRP} not found: run scripts/fetch-test-data.sh`); }
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jfsw-firefox-')), 'config.js');
  fs.writeFileSync(cfg, configText(t.BUILD, { relay: 'ws://127.0.0.1:' + PORT_HTTP + '/vnet' }));
  const server = await serve(t.BUILD, { '/swshare.grp': t.GRP, '/config.js': cfg }, PORT_WEB);
  const base = 'http://127.0.0.1:' + PORT_WEB + '/index.html';
  try {
    console.log('Firefox: ' + version + ' (' + FIREFOX + ')');
    await single(puppeteer, base);
    await trap(puppeteer, base, false);
    await trap(puppeteer, base, true);
    await network(puppeteer, base);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(path.dirname(cfg), { recursive: true, force: true });
  }
  return t.summary('firefox');
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
