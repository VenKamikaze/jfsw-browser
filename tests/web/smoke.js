#!/usr/bin/env node
// Browser smoke test for the Emscripten build (brief 02, test 1).
//
//   node tests/web/smoke.js            # uses build-wasm/ and testdata/swshare.grp
//   WASM_DIR=build-wasm-debug node tests/web/smoke.js
//   SMOKE_SABOTAGE=blank node tests/web/smoke.js   # hides the canvas: the picture checks must FAIL
//   SMOKE_SABOTAGE=nokey node tests/web/smoke.js   # presses no key: the keyboard check must FAIL
//   SMOKE_SABOTAGE=noesc node tests/web/smoke.js   # the pointer is released like the game does it: the Escape check must FAIL
//   SMOKE_SABOTAGE=unlockedmouse node tests/web/smoke.js   # mouse motion reaches the game while unlocked: the view check must FAIL
//   SMOKE_SHOT=file.png                            # also save a screenshot of the page
//
// Loads the page with ?test=1, clicks "Click to start", gets to the main menu and checks that the
// canvas is not blank, that the keyboard drives the menu, and that nothing threw. The picture is
// read as the browser composites it (an element screenshot): a WebGL canvas read back directly is
// blank. The test proves its own blank check first, on pictures that are known to be blank.
'use strict';
const t = require('./lib.js');

const PORT = 48101;
const SABOTAGE = process.env.SMOKE_SABOTAGE === 'blank';
const SABOTAGE_NOESC = process.env.SMOKE_SABOTAGE === 'noesc';   // release the pointer the way the game does: no Escape reaches it, that check must FAIL
const SABOTAGE_NOKEY = process.env.SMOKE_SABOTAGE === 'nokey';   // do not press the key: the key check must FAIL
const SABOTAGE_UNLOCKEDMOUSE = process.env.SMOKE_SABOTAGE === 'unlockedmouse';   // let unlocked mouse motion reach the game: the view check must FAIL

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

    // Skip the intro screens and get to the main menu: any key skips one (and opens the menu at the title
    // screen). Not Space or Enter: in the menu they select, and a few too many started a level (New Game,
    // episode, skill), after which the menu checks below were looking at the 3D view. Shift does nothing there.
    const menuLog = () => page.evaluate(() => window.jfswOut.join('\n'));
    for (let i = 0; i < 12; i++) { await page.keyboard.press('ShiftLeft'); await page.waitForTimeout(700); }
    await page.waitForTimeout(1500);
    const menu1 = await t.canvasStats(page);
    t.check(t.notBlank(menu1), `the main menu is drawn (${menu1.colors} colours)`);
    // The menu cursor is a spinning coin left of the items (New Game, Load Game, Save Game, Options, How to Order,
    // Quit; 62 page pixels apart). Find the row it is on from one screenshot of the cursor column: the band with
    // the light pixels of the coin (none at all when the coin is edge-on: then the answer is 0, unknown).
    const COLUMN = { x: 95, y: 100, width: 80, height: 372 };
    const decoder = await context.newPage();
    const cursorRow = async () => {
      const png = await page.screenshot({ clip: COLUMN, type: 'png' });
      const counts = await decoder.evaluate(async (data) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        const n = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] + px[i + 1] + px[i + 2] > 520) { n[Math.min(5, Math.floor(Math.floor(i / 4 / c.width) * 372 / c.height / 62))]++; }
        }
        return n;
      }, png.toString('base64'));
      const best = counts.indexOf(Math.max(...counts));
      const others = counts.reduce((a, c, i) => (i === best ? a : a + c), 0);
      return { row: counts[best] >= 30 && counts[best] > 4 * others ? best + 1 : 0, counts: counts.join(',') };
    };
    const settledRow = async () => {     // a few looks, so that an edge-on coin does not count
      let r = { row: 0, counts: '' };
      for (let k = 0; k < 6 && !r.row; k++) { r = await cursorRow(); if (!r.row) { await page.waitForTimeout(60); } }
      return r;
    };
    const c0 = await settledRow();
    t.check(c0.row === 1, `the main menu is open with the cursor on New Game (row ${c0.row}; light pixels per row ${c0.counts})`);
    // The keyboard drives the menu: Down moves the cursor down, Up moves it up (the list wraps round). The menu
    // reads the arrows' state, not presses: it looks at them when 10 clock tics have passed since its last look
    // (REPEAT_DELAY and limitmove in src/menus.c, the original game's behaviour), about every 100 ms, or once per
    // pass of its loop when frames are slower than that. A 150 ms press therefore spans one or two of those looks
    // (if the game draws more than about 7 frames a second), so it moves the cursor one or two rows; never none,
    // never three. A fixed 200 ms press moved it two rows, sometimes three. (Watching the cursor and letting go
    // when it moves is no good: one look at the page takes about 450 ms here.)
    const press = async (key) => {
      await t.tap(page, key, 150);
      await page.waitForTimeout(500);
      return settledRow();
    };
    const steps = (from, to) => (to - from + 6) % 6;      // rows moved down, with the wrap
    const c1 = SABOTAGE_NOKEY ? await settledRow() : await press('ArrowDown');
    t.check(c0.row && c1.row && [1, 2].includes(steps(c0.row, c1.row)), `Down moves the menu cursor down (row ${c0.row} to ${c1.row}; light pixels per row ${c1.counts})`);
    const c2 = await press('ArrowUp');
    t.check(c1.row && c2.row && [1, 2].includes(steps(c2.row, c1.row)), `Up moves it up (row ${c1.row} to ${c2.row}; light pixels per row ${c2.counts})`);
    await decoder.close();
    t.check(t.notBlank(await t.canvasStats(page)), 'the menu is still drawn after the key presses');

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
    t.check((await page.evaluate(() => window.jfswState)) === 'running', 'the game is still running');
    t.check(errors.length === 0, 'no uncaught page error, dialog or alert', errors.join(' | '));
    t.check(consoleErrors.length === 0, 'no console.error', consoleErrors.slice(0, 3).join(' | '));
    const log = await menuLog();
    t.check(/GRP file: sw\.grp/.test(log) && /Shareware Version/.test(log), 'the game found the shareware GRP');
    t.check(!/out of sync|Error|ERROR/.test(log), 'no error text in the game output');
    if (process.env.SMOKE_SHOT) { await page.screenshot({ path: process.env.SMOKE_SHOT }); }
    await context.close();

    // --- 3. Escape. In a level (E1L3), when the browser takes the pointer (the user pressed Escape; the key itself never
    // reaches the page) the game must still get an Escape: its menu opens. A deliberate release by the game must not.
    {
      const e = await t.open(env, '?test=1&persist=0&args=' + encodeURIComponent('-level3 -s1'));   // a quiet level: little moves by itself
      await t.waitState(e.page, 'ready');
      await e.page.click('#start');
      await e.page.waitForTimeout(5000);
      const MENU = { x: 150, y: 110, width: 520, height: 380 };    // where the menu text appears
      const lock = async () => {
        for (let i = 0; i < 5 && !(await e.page.evaluate(() => !!document.pointerLockElement)); i++) { await e.page.mouse.click(500, 300); await e.page.waitForTimeout(500); }
        return e.page.evaluate(() => document.pointerLockElement === document.getElementById('canvas'));
      };
      t.check(await lock(), 'in a level, a click locks the pointer');
      await e.page.waitForTimeout(2000);    // the click also swung the fist
      const byItself = await t.changedPixels(e.page, MENU, null, 800);
      // (a) the game itself lets go of the pointer: no Escape is sent, nothing opens
      const ctrl = await t.changedPixels(e.page, MENU, () => e.page.evaluate(() => document.exitPointerLock()), 800);
      t.check(ctrl < 30000, `a release asked for by the game does not open the menu (${ctrl} pixels changed; ${byItself} by themselves)`);
      t.check(!(await e.page.evaluate(() => !!document.pointerLockElement)), 'the pointer was released');
      // (a2) with the pointer released, the mouse is not the game's: moving it over the picture must not turn the view.
      // (SDL keeps relative mode on and turns absolute positions into relative motion when the pointer is not locked.)
      const sweep = async () => { await e.page.mouse.move(200, 250, { steps: 4 }); await e.page.mouse.move(800, 350, { steps: 8 }); await e.page.mouse.move(500, 300, { steps: 4 }); };
      const VIEW = { x: 20, y: 10, width: 960, height: 540 };   // the 3D view above the status bar
      const swept = await t.changedPixels(e.page, VIEW, SABOTAGE_UNLOCKEDMOUSE ? () => e.page.evaluate(() => { window.jfswTest.passUnlockedMouse = true; }).then(sweep) : sweep, 800);
      t.check(swept < 2000, `moving the mouse while the pointer is released does not turn the view (${swept} pixels changed)`);
      t.check(await lock(), 'a click locks the pointer again');
      await e.page.waitForTimeout(2000);    // the click also swung the fist
      // (b) the browser takes the pointer (as for Escape): the page passes an Escape on and the menu opens
      const opened = await t.changedPixels(e.page, MENU, () => e.page.evaluate((real) => (real ? Document.prototype.exitPointerLock.call(document) : document.exitPointerLock()), !SABOTAGE_NOESC), 1200);
      t.check(opened > 45000, `when the browser takes the pointer (as Escape does) the game's menu opens (${opened} pixels changed)`);
      t.check(e.errors.length === 0, 'no page error in the level', e.errors.join(' | '));
      await e.context.close();
    }
  } finally {
    await t.stop(env);
  }
  return t.summary('smoke');
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
