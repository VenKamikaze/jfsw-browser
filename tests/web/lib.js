// Shared helpers for the browser tests (Playwright + Chromium; never run `playwright install`).
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve } = require('./server.js');

const root = path.resolve(__dirname, '..', '..');
const BUILD = process.env.WASM_DIR ? path.resolve(process.env.WASM_DIR) : path.join(root, 'build-wasm');
const GRP = path.join(root, 'testdata', 'swshare.grp');

let checks = 0, failures = 0;
function check(ok, what, detail) {
  checks++;
  if (ok) { console.log('  ok   ' + what); } else { failures++; console.log('  FAIL ' + what + (detail ? ' (' + detail + ')' : '')); }
  return !!ok;
}
function summary(name) {
  console.log(`${name}: ${checks - failures} passed, ${failures} failed`);
  return failures === 0 ? 0 : 1;
}

// Serves build-wasm and the test data. `files` maps URL paths to local files.
async function start(port, files) {
  if (!fs.existsSync(path.join(BUILD, 'sw.wasm'))) { throw new Error(`${BUILD}/sw.wasm not found: run scripts/build-wasm.sh`); }
  if (!fs.existsSync(GRP)) { throw new Error(`${GRP} not found: run scripts/fetch-test-data.sh`); }
  const mounts = files || {};
  mounts['/swshare.grp'] = GRP;
  const server = await serve(BUILD, mounts, port);
  const browser = await chromium.launch();
  return { server, browser, base: `http://127.0.0.1:${port}/index.html` };
}
async function stop(env) {
  try { await env.browser.close(); } catch (e) { /* already gone */ }
  await new Promise((r) => env.server.close(r));
}

// Opens the page; collects uncaught page errors and console errors. Returns { page, errors }.
async function open(env, query, opts) {
  const context = await env.browser.newContext(Object.assign({ viewport: { width: 1000, height: 800 } }, opts || {}));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  await page.goto(env.base + (query || ''));
  return { page, context, errors };
}

async function waitState(page, states, timeout) {
  const list = [].concat(states);
  await page.waitForFunction((l) => l.indexOf(window.jfswState) >= 0, list, { timeout: timeout || 60000, polling: 100 });
  return page.evaluate(() => window.jfswState);
}

// What the canvas shows, as the browser composites it (an element screenshot; reading a WebGL
// canvas directly would give a blank picture). Returns { colors, pixels, hash } where colors is
// the number of distinct RGB values.
async function canvasStats(page) {
  const png = await page.locator('#canvas').screenshot({ type: 'png' });
  return analysePng(page, png);
}
async function analysePng(page, png) {
  const b64 = png.toString('base64');
  // Decode in a page of its own so the game page is not disturbed.
  const side = await page.context().newPage();
  try {
    return await side.evaluate(async (data) => {
      const blob = await (await fetch('data:image/png;base64,' + data)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      let hash = 2166136261;
      for (let i = 0; i < px.length; i += 4) {
        seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
        hash = Math.imul(hash ^ (px[i] | px[i + 1] << 8 | px[i + 2] << 16), 16777619);
      }
      return { colors: seen.size, pixels: c.width * c.height, width: c.width, height: c.height, hash: hash >>> 0 };
    }, b64);
  } finally { await side.close(); }
}
// Number of light pixels (r+g+b > 520) in a region of the page: text drawn on a dark menu. Used to see
// that a menu shows something (a saved game's name) where an empty one shows nothing.
async function brightPixels(page, clip) {
  const png = await page.screenshot({ clip, type: 'png' });
  const side = await page.context().newPage();
  try {
    return await side.evaluate(async (data) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) { if (px[i] + px[i + 1] + px[i + 2] > 520) { n++; } }
      return n;
    }, png.toString('base64'));
  } finally { await side.close(); }
}
// Number of pixels (of the clip) that differ noticeably between two moments: `action` is awaited between the
// two screenshots (null = nothing, to measure how much the picture changes by itself).
async function changedPixels(page, clip, action, waitMs) {
  const a = await page.screenshot({ clip, type: 'png' });
  if (action) { await action(); }
  await page.waitForTimeout(waitMs || 800);
  const b = await page.screenshot({ clip, type: 'png' });
  return pixelDiff(page, a, b);
}
// The same count for two PNG screenshots taken already. The comparison runs in a page of its own, which in a full
// (not headless-shell) Chromium takes the focus from `page` while it is open (focus.js takes its screenshots first).
async function pixelDiff(page, a, b) {
  const side = await page.context().newPage();
  try {
    return await side.evaluate(async ({ da, db }) => {
      const load = async (d) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob());
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const pa = await load(da), pb = await load(db);
      let n = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 60) { n++; }
      }
      return n;
    }, { da: a.toString('base64'), db: b.toString('base64') });
  } finally { await side.close(); }
}

// The first save slot's name field in the load/save menus (viewport 1000x800, canvas at the top).
const SLOT1 = { x: 35, y: 98, width: 410, height: 37 };

// The picture is "not blank" if it has several distinct colours.
const MIN_COLORS = 8;
function notBlank(stats) { return stats.colors >= MIN_COLORS; }

// A key press the game's polling loops are sure to see (a plain press() can be down and up between two polls).
async function tap(page, key, ms) { await page.keyboard.down(key); await page.waitForTimeout(ms || 200); await page.keyboard.up(key); }

// Quits from inside a level the way a player does: F10, Y, then any key at the shareware "Give up?" screen.
async function quitGame(page) {
  await tap(page, 'F10'); await page.waitForTimeout(800);
  await tap(page, 'y'); await page.waitForTimeout(800);
  for (let i = 0; i < 10; i++) {
    if (['ended', 'error'].includes(await page.evaluate(() => window.jfswState))) { return; }
    await tap(page, 'Space'); await page.waitForTimeout(700);
  }
}

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

// Time dilation for the tests: makes performance.now() (which SDL's clock and so totalclock come
// from) run `k` times faster, so a long demo plays faster than real time. Only the test harness
// does this; the game is unchanged.
function warpScript(k) {
  return `(() => { const o = performance.now.bind(performance); const t0 = o(); performance.now = () => t0 + (o() - t0) * ${k}; })();`;
}

// Runs the game once in a fresh browser context until it ends: `args` are game arguments, `files` is
// a list of { name, file } put in the game's directory first (served by this run), `warp` the time
// factor. Returns { state, exit, out, err, errors, files (name -> Buffer, read after the end),
// frames (frame times, ms, relative to the click), seconds }.
async function runGame(env, opts) {
  const warp = opts.warp || 1;
  const names = opts.files || [];
  const query = '?test=1&persist=0' + (names.length ? '&files=' + names.map((f) => encodeURIComponent('/f/' + f.name)).join(',') : '') +
    (opts.args && opts.args.length ? '&args=' + encodeURIComponent(opts.args.join(' ')) : '');
  const { page, context, errors } = await open(env, query);
  if (warp !== 1) { await page.addInitScript(warpScript(warp)); await page.reload(); }
  await waitState(page, 'ready');
  const started = Date.now();
  const t0 = await page.evaluate(() => performance.now());
  await page.click('#start');
  if (opts.script) { await opts.script(page); }
  const timeout = opts.timeoutMs || 400000;
  let state;
  try { state = await waitState(page, ['ended', 'error'], timeout); } catch (e) { state = 'timeout'; }
  const seconds = (Date.now() - started) / 1000;
  const result = await page.evaluate(() => ({
    exit: window.jfswExit, out: window.jfswOut.join('\n'), err: window.jfswErr.join('\n'), frames: Module.jfswFrameLog.slice(),
    status: document.getElementById('status').textContent,
  }));
  const files = {};
  for (const n of (opts.read || [])) {
    const b64 = await page.evaluate((name) => { const b = window.jfswTest.readFile(name); return b ? btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')) : null; }, n);
    files[n] = b64 === null ? null : Buffer.from(b64, 'base64');
  }
  await context.close();
  return Object.assign(result, { state, errors, files, seconds, t0 });
}

module.exports = { changedPixels, pixelDiff, brightPixels, SLOT1, tap, quitGame, runGame, warpScript, root, BUILD, GRP, check, summary, start, stop, open, waitState, canvasStats, analysePng, notBlank, MIN_COLORS, pct };
