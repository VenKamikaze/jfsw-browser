#!/usr/bin/env node
// Browser smoke test for the Emscripten build (brief 02, test 1).
//
//   node tests/web/smoke.js            # uses build-wasm/ and testdata/swshare.grp
//   WASM_DIR=build-wasm-debug node tests/web/smoke.js
//   SMOKE_SABOTAGE=blank node tests/web/smoke.js   # hides the canvas: the picture checks must FAIL
//
// Loads the page with ?test=1, clicks "Click to start", gets to the main menu and checks that the
// canvas is not blank, that the keyboard drives the menu, and that nothing threw. The picture is
// read as the browser composites it (an element screenshot): a WebGL canvas read back directly is
// blank. The test proves its own blank check first, on pictures that are known to be blank.
'use strict';
const t = require('./lib.js');

const PORT = 48101;
const SABOTAGE = process.env.SMOKE_SABOTAGE === 'blank';

async function main() {
  const env = await t.start(PORT);
  try {
    // --- 1. The blank check must be able to fail -------------------------------------------------------
    {
      const { page, context } = await t.open(env, '?test=1&persist=0');
      await t.waitState(page, 'ready');
      await page.evaluate(() => { document.getElementById('overlay').hidden = true; });   // the overlay is not the canvas
      const before = await t.canvasStats(page);
      await page.evaluate(() => { document.getElementById('overlay').hidden = false; });
      t.check(!t.notBlank(before), 'blank check: the canvas before the game starts counts as blank', JSON.stringify(before));
      // A canvas filled with one colour, and one with two, are blank too; a canvas with 12 colours is not.
      const mk = async (n) => {
        const side = await context.newPage();
        const png = await side.evaluate((colors) => {
          const c = document.createElement('canvas'); c.width = 640; c.height = 480;
          const g = c.getContext('2d');
          for (let i = 0; i < colors; i++) { g.fillStyle = `rgb(${i * 20},${255 - i * 20},${i * 7})`; g.fillRect(i * 50, 0, 50, 480); }
          return c.toDataURL('image/png').split(',')[1];
        }, n);
        await side.close();
        return t.analysePng(page, Buffer.from(png, 'base64'));
      };
      t.check(!t.notBlank(await mk(1)), 'blank check: a single-colour picture counts as blank');
      t.check(!t.notBlank(await mk(2)), 'blank check: a two-colour picture counts as blank');
      t.check(t.notBlank(await mk(12)), 'blank check: a 12-colour picture is not blank');
      await context.close();
    }

    // --- 2. The game ----------------------------------------------------------------------------------
    const { page, context, errors } = await t.open(env, '?test=1&persist=0');
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    t.check((await t.waitState(page, 'ready')) === 'ready', 'page loads the data and offers "Click to start"');
    t.check(await page.isVisible('#start'), 'the start button is visible');
    await page.click('#start');
    t.check((await page.evaluate(() => window.jfswState)) === 'running', 'the click starts the game');

    // Wait for a real picture (the intro screens come first).
    let stats = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      stats = await t.canvasStats(page);
      if (t.notBlank(stats)) { break; }
      await page.waitForTimeout(500);
    }
    if (SABOTAGE) { await page.evaluate(() => { document.getElementById('canvas').style.opacity = '0'; }); }
    stats = await t.canvasStats(page);
    t.check(t.notBlank(stats), `the canvas is not blank (${stats.colors} colours, ${stats.width}x${stats.height})`, JSON.stringify(stats));
    if (SABOTAGE) { await page.evaluate(() => { document.getElementById('canvas').style.opacity = ''; }); }

    // Skip the intro screens and get to the main menu: any key skips one.
    const menuLog = () => page.evaluate(() => window.jfswOut.join('\n'));
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(700); }
    await page.waitForTimeout(1500);
    const menu1 = await t.canvasStats(page);
    t.check(t.notBlank(menu1), `the main menu is drawn (${menu1.colors} colours)`);
    // The keyboard drives the menu: Down moves the highlight, Up moves it back.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(800);
    const menu2 = await t.canvasStats(page);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(800);
    const menu3 = await t.canvasStats(page);
    t.check(menu2.hash !== menu1.hash || menu2.hash !== menu3.hash, 'Down changes the picture (the keyboard reaches the game)');
    t.check(menu3.colors >= t.MIN_COLORS && t.notBlank(menu2), 'the menu is still drawn after the key presses');

    // The game goes on running: frames keep being presented.
    const frames = await page.evaluate(() => Module.jfswFrameLog.length);
    await page.waitForTimeout(1000);
    const frames2 = await page.evaluate(() => Module.jfswFrameLog.length);
    t.check(frames2 - frames > 20, `frames keep coming (${frames2 - frames} in a second)`);

    // Sound: the audio device was opened after the click, and its clock runs.
    const audio = async () => page.evaluate(() => { const c = Module.SDL2 && Module.SDL2.audioContext; return c ? { state: c.state, time: c.currentTime, open: !!Module.SDL2.audio } : null; });
    const a1 = await audio();
    await page.waitForTimeout(1000);
    const a2 = await audio();
    t.check(a1 && a1.open && a1.state === 'running', `the game opened its audio device and the AudioContext is running (${a1 && a1.state})`);
    t.check(a1 && a2 && a2.time > a1.time, 'the audio clock advances');
    // Mouse: a click on the picture captures the pointer (the game uses relative mouse mode).
    await page.mouse.click(500, 300);
    await page.waitForTimeout(500);
    t.check(await page.evaluate(() => document.pointerLockElement === document.getElementById('canvas')), 'a click on the picture locks the pointer');
    // Escape reaches the game even though the browser takes it to leave pointer lock: the page passes it on.
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForTimeout(500);
    t.check(!(await page.evaluate(() => document.pointerLockElement)), 'the pointer is released (the game asked for it)');
    // The browser leaving pointer lock by itself (the user pressed Escape; the key never arrives): the page gives the game an Escape.
    await page.mouse.click(500, 300);
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__esc = 0; window.addEventListener('keydown', (e) => { if (e.code === 'Escape') { window.__esc++; } }); });
    await page.evaluate(() => Document.prototype.exitPointerLock.call(document));
    await page.waitForTimeout(600);
    t.check((await page.evaluate(() => window.__esc)) === 1, 'when the browser takes the pointer (Escape), the game still gets an Escape');
    t.check((await page.evaluate(() => window.jfswState)) === 'running', 'the game is still running');
    t.check(errors.length === 0, 'no uncaught page error, dialog or alert', errors.join(' | '));
    t.check(consoleErrors.length === 0, 'no console.error', consoleErrors.slice(0, 3).join(' | '));
    const log = await menuLog();
    t.check(/GRP file: sw\.grp/.test(log) && /Shareware Version/.test(log), 'the game found the shareware GRP');
    t.check(!/out of sync|Error|ERROR/.test(log), 'no error text in the game output');
    await page.screenshot({ path: process.env.SMOKE_SHOT || '/tmp/jfsw-smoke.png' });
    await context.close();
  } finally {
    await t.stop(env);
  }
  return t.summary('smoke');
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
