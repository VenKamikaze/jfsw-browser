#!/usr/bin/env node
// Losing the focus, and a refused pointer lock, do not end the game on the page (brief 02c, bugs.md L24). Chromium.
//
//   node tests/web/focus.js                                # uses build-wasm/ and testdata/swshare.grp
//   FOCUS_SABOTAGE=unhandled node tests/web/focus.js       # leaves the lock's promise unhandled, as before the fix: part 1 must FAIL
//   WASM_DIR=other node tests/web/focus.js                 # another build (e.g. one from before the fix: part 1 must FAIL)
//
// 1. A refused lock. The browser refuses every pointer-lock request the way Firefox does when the document is not
//    focused: the promise requestPointerLock() returns is rejected with a DOMException (WrongDocumentError, "The
//    document is not focused."), and pointerlockerror is fired. Firefox gives a DOMException the stack where it was
//    made, which runs through Emscripten's helper in sw.js; Chromium gives it none. The stub gives it the stack of an
//    Error made at the same place, which is what Firefox's is, and the test checks that the stack names sw.js.
//    The game asks at start-up (grabmouse(1)) and is refused; the game must keep running with no overlay, the refusal
//    is logged, a click on the canvas asks again, and mouse motion does not reach the game while the pointer is free.
//    Then the browser stops refusing: a click locks the pointer, and moving the mouse turns the view (SDL and the
//    page agree that the pointer is locked: the page passes mouse events on only then).
//    And a real focus loss: another page comes to the front and goes; no overlay, and a click locks the pointer again.
// 2. A real failure is still fatal: a wasm trap (an out-of-bounds access in free()) and an error thrown by the
//    game's own scripts, both inside the game's frame (from Module.jfswShowframes, which sdlayer2.c updates for every
//    picture, in sw.js), show the overlay with the message as one sentence.
// Port 48104. The full Chromium build in headless mode, not the headless shell (see startEnv()).
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const t = require('./lib.js');
const { serve } = require('./server.js');

const PORT = 48104;
const SABOTAGE = process.env.FOCUS_SABOTAGE === 'unhandled';
const VIEW = { x: 20, y: 10, width: 960, height: 540 };   // the 3D view above the status bar (viewport 1000x800, as smoke.js)
const MSG = 'The document is not focused.';

// Before the page's scripts: every pointer-lock request is refused as Firefox refuses it while the document is not focused
// (window.__lock.refuse = false lets them through to the browser's own requestPointerLock).
function refuseLocks() {
  const lock = window.__lock = { asked: 0, refuse: true, unhandled: 0, stack: '', real: Element.prototype.requestPointerLock };
  window.addEventListener('unhandledrejection', () => { lock.unhandled++; }, true);
  Element.prototype.requestPointerLock = function () {
    lock.asked++;
    if (!lock.refuse) { return lock.real.apply(this, arguments); }
    const e = new DOMException('The document is not focused.', 'WrongDocumentError');
    // Firefox: the stack where the exception was made (the caller's). Chromium has none; an Error made here has that stack.
    Object.defineProperty(e, 'stack', { value: new Error().stack, configurable: true });
    lock.stack = e.stack;
    setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
    return Promise.reject(e);
  };
}

async function openPage(env, query, init) {
  const context = await env.browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();
  const errors = [], warnings = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  page.on('console', (m) => { if (m.type() === 'warning') { warnings.push(m.text()); } });
  if (init) { await page.addInitScript(init); }
  await page.goto(env.base + query);
  return { page, context, errors, warnings };
}
const pageState = (page) => page.evaluate(() => ({
  state: window.jfswState, overlay: !document.getElementById('overlay').hidden, status: document.getElementById('status').textContent,
  frames: Module.jfswFrameLog.length, locked: document.pointerLockElement === document.getElementById('canvas'),
}));
async function lockByClicking(page) {
  for (let i = 0; i < 5 && !(await page.evaluate(() => !!document.pointerLockElement)); i++) { await page.mouse.click(500, 300); await page.waitForTimeout(500); }
  return pageState(page);
}
async function framesIn(page, ms) {
  const a = await page.evaluate(() => Module.jfswFrameLog.length);
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => Module.jfswFrameLog.length)) - a;
}

async function refused(env) {
  console.log('1. refused pointer-lock requests' + (SABOTAGE ? ' (SABOTAGE: the promise is left unhandled, as before the fix)' : ''));
  const r = await openPage(env, '?test=1&persist=0&args=' + encodeURIComponent('-level3 -s1'), refuseLocks);   // a quiet level
  const { page } = r;
  t.check((await t.waitState(page, 'ready')) === 'ready', 'the page is ready');
  if (SABOTAGE) { await page.evaluate(() => { window.jfswTest.unhandledPointerLock = true; }); }
  await page.click('#start');
  await page.waitForTimeout(5000);
  let lock = await page.evaluate(() => ({ asked: window.__lock.asked, unhandled: window.__lock.unhandled, stack: window.__lock.stack }));
  t.check(lock.asked >= 1, `the game asked for the pointer lock at start-up and was refused (${lock.asked} requests)`);
  t.check(/sw\.js/.test(lock.stack), 'the refusal has a stack through sw.js, as in Firefox', lock.stack.split('\n').slice(0, 4).join(' | '));
  let s = await pageState(page);
  t.check(s.state === 'running', `the game is still running (state ${s.state})`, s.status);
  t.check(!s.overlay, 'no overlay', s.status);
  t.check(!/\.\. /.test(s.status), 'no doubled full stop in the page\'s message', s.status);
  const n1 = await framesIn(page, 1000);
  t.check(n1 > 20, `frames keep coming (${n1} in a second)`);
  t.check(r.warnings.some((w) => w === 'pointer lock refused: ' + MSG), 'the refusal is logged ("pointer lock refused: ' + MSG + '")', r.warnings.slice(0, 3).join(' | '));
  t.check(lock.unhandled === 0, `no unhandled rejection (${lock.unhandled})`);
  // a click on the canvas asks again (SDL's mousedown handler: relative mode on and no lock); refused again
  await page.mouse.click(500, 300);
  await page.waitForTimeout(1500);
  const asked2 = await page.evaluate(() => window.__lock.asked);
  t.check(asked2 > lock.asked, `a click on the canvas asks for the lock again (${lock.asked} to ${asked2} requests)`);
  s = await pageState(page);
  t.check(s.state === 'running' && !s.overlay && !s.locked, `still running, no overlay, the pointer not locked (state ${s.state})`, s.status);
  await page.waitForTimeout(1500);       // the click also swung the fist
  // while the pointer is free, the mouse is not the game's (02's filter): the refusal left SDL and the page agreeing on that
  const sweep = async () => { await page.mouse.move(200, 250, { steps: 4 }); await page.mouse.move(800, 350, { steps: 8 }); await page.mouse.move(500, 300, { steps: 4 }); };
  const swept = await t.changedPixels(page, VIEW, sweep, 800);
  t.check(swept < 2000, `after a refusal, moving the mouse over the picture does not turn the view (${swept} pixels changed)`);
  // the browser stops refusing: the next click locks the pointer, and the mouse turns the view. The screenshots are taken
  // first and compared afterwards: the comparison opens a page of its own, which takes the focus (and so the lock) away.
  await page.evaluate(() => { window.__lock.refuse = false; });
  await page.bringToFront();
  s = await lockByClicking(page);
  t.check(s.locked, 'once the browser allows it, a click on the canvas locks the pointer');
  await page.waitForTimeout(2000);       // the click also swung the fist
  const shot = () => page.screenshot({ clip: VIEW, type: 'png' });
  const still0 = await shot(); await page.waitForTimeout(800); const still1 = await shot();
  for (let i = 0; i < 10; i++) { await page.mouse.move(500 + 30 * (i + 1), 300, { steps: 2 }); }
  await page.waitForTimeout(800);
  const look1 = await shot();
  const lockedDuringLook = await page.evaluate(() => document.pointerLockElement === document.getElementById('canvas'));
  const still = await t.pixelDiff(page, still0, still1), look = await t.pixelDiff(page, still1, look1);
  t.check(lockedDuringLook && look > 20000, `with the pointer locked, moving the mouse turns the view (${look} pixels changed; ${still} by themselves)`);
  // 3. a real focus loss in Chromium: another page comes to the front, then this one again
  const other = await r.context.newPage();
  await other.bringToFront();
  await page.waitForTimeout(1500);
  s = await pageState(page);
  const focused = await page.evaluate(() => document.hasFocus());
  // (Playwright emulates focus, so document.hasFocus() stays true here; the browser still takes the lock away)
  t.check(!s.locked && s.state === 'running' && !s.overlay, `another page in front: this one lost the lock, and the game goes on with no overlay (state ${s.state}, hasFocus ${focused})`, s.status);
  await other.close();
  await page.bringToFront();
  await page.waitForTimeout(1000);
  s = await lockByClicking(page);
  const n2 = await framesIn(page, 1000);
  t.check(s.locked && s.state === 'running' && !s.overlay && n2 > 20, `back in front, a click locks the pointer again and frames keep coming (${n2} in a second)`, s.status);
  s = await pageState(page);
  t.check(s.state === 'running' && !s.overlay, `the game is still running at the end (state ${s.state})`, s.status);
  lock = await page.evaluate(() => ({ unhandled: window.__lock.unhandled }));
  t.check(lock.unhandled === 0 && r.errors.length === 0, `no unhandled rejection or page error (${lock.unhandled})`, r.errors.join(' | '));
  if (s.overlay || s.state !== 'running') { console.log('  (the page said: ' + s.status + ')'); }
  await r.context.close();
}

// A failure inside the game's frame: sdlayer2.c reads and increments Module.jfswShowframes for every picture it presents
// (an EM_JS function in sw.js). `how` is 'trap' (wasm: free() of an address beyond memory) or 'throw' (an Error from the script).
async function fatal(env, how) {
  const r = await openPage(env, '?test=1&persist=0');
  const { page } = r;
  await t.waitState(page, 'ready');
  await page.click('#start');
  await page.waitForTimeout(4000);
  const before = await pageState(page);
  await page.evaluate((how) => {
    let n = Module.jfswShowframes, armed = true;
    Object.defineProperty(Module, 'jfswShowframes', {
      configurable: true,
      get() {
        if (armed) {
          armed = false;
          if (how === 'trap') { Module._free(HEAPU8.length + 4096); } else { throw new Error('test: an error in the game\'s script'); }
        }
        return n;
      },
      set(v) { n = v; },
    });
  }, how);
  await page.waitForTimeout(1500);
  const s = await pageState(page);
  const what = how === 'trap' ? 'a wasm trap in the game\'s frame' : 'an error thrown by the game\'s script';
  t.check(before.state === 'running' && s.state === 'error' && s.overlay, `${what} shows the overlay (state ${before.state} to ${s.state})`, s.status);
  const re = how === 'trap' ? /^(Something went wrong|The game crashed): .*out of bounds[^.]*\. Reload the page to try again\.$/ : /^Something went wrong: .*test: an error in the game's script\. Reload the page to try again\.$/;
  t.check(re.test(s.status) && !/\.\./.test(s.status), `its message is one sentence and says what happened ("${s.status}")`);
  await r.context.close();
}

// Playwright's default headless Chromium (the headless shell) cannot run this test: under pointer lock its mouse
// events carry no movement (movementX is always 0), and a wasm trap crashes its renderer ("Target crashed") instead
// of throwing a RuntimeError. The full Chromium build in headless mode (channel 'chromium', the same preinstalled
// browser) does both as a desktop browser does.
async function startEnv() {
  if (!fs.existsSync(path.join(t.BUILD, 'sw.wasm'))) { throw new Error(`${t.BUILD}/sw.wasm not found: run scripts/build-wasm.sh`); }
  if (!fs.existsSync(t.GRP)) { throw new Error(`${t.GRP} not found: run scripts/fetch-test-data.sh`); }
  const server = await serve(t.BUILD, { '/swshare.grp': t.GRP }, PORT);
  const browser = await chromium.launch({ channel: 'chromium' });
  return { server, browser, base: `http://127.0.0.1:${PORT}/index.html` };
}

async function main() {
  const env = await startEnv();
  try {
    await refused(env);
    console.log('2. a real failure is still fatal');
    await fatal(env, 'trap');
    await fatal(env, 'throw');
  } finally {
    await t.stop(env);
  }
  return t.summary('focus');
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
