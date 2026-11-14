#!/usr/bin/env node
// Saves and settings persist across a page reload (brief 02, test 4, and its fix round).
//
//   node tests/web/persist.js
//
// Starts E1L1, saves a game with the game's own quick-save keys (F6, a name, Enter), quits the game the
// way a closing window does (which makes it write sw.cfg), reloads the page and looks in the game's
// folder. The same steps with ?persist=0 (memory only) must lose the files: that run proves the check can fail.
'use strict';
const t = require('./lib.js');

const PORT = t.port(48103);
const RELOAD_AFTER_MS = +(process.env.RELOAD_AFTER_MS || 250); const SAVE_TRIES = 3;  // how soon after a save reached its full size the page is reloaded (without quitting)
const SETTLE_MS = 1500;        // how long after leaving the menus the page is reloaded in the settings test

async function session(env, context, query, quit) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(env.base + query);
  await t.waitState(page, 'ready');
  const before = await page.evaluate(() => window.jfswTest.listFiles());
  await page.click('#start');
  await page.waitForTimeout(5000);
  await t.tap(page, 'F6');
  await page.waitForTimeout(1500);
  await page.keyboard.type('persist test', { delay: 80 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(() => { const b = window.jfswTest.readFile('game0.sav'); return b ? b.length : 0; });
  if (quit) {
    await t.quitGame(page);
    await t.waitState(page, ['ended', 'error'], 20000);
  } else { await page.waitForTimeout(2500); }
  const syncs = await page.evaluate(() => window.jfswSyncs);
  return { page, before, saved, syncs, errors };
}

async function main() {
  const env = await t.start(PORT);
  try {
    const q = '?test=1&args=' + encodeURIComponent('-level1 -s1');
    // --- persistent ---
    {
      const context = await env.browser.newContext({ viewport: { width: 1000, height: 800 } });
      const s = await session(env, context, q, true);
      t.check(!s.before.includes('game0.sav') && !s.before.includes('sw.cfg'), 'fresh browser profile: no saved game or config yet');
      t.check(s.saved > 1000, `the game saved game0.sav (${s.saved} bytes)`);
      t.check(s.syncs >= 1, `the page wrote to IndexedDB (${s.syncs} syncs)`);
      await s.page.close();
      const p2 = await context.newPage();
      await p2.goto(env.base + q);
      await t.waitState(p2, 'ready');
      const files = await p2.evaluate(() => window.jfswTest.listFiles());
      const size = await p2.evaluate(() => { const b = window.jfswTest.readFile('game0.sav'); return b ? b.length : 0; });
      t.check(files.includes('game0.sav') && size === s.saved, `after a reload the saved game is still there (${size} bytes)`, files.join(','));
      t.check(files.includes('sw.cfg'), 'after a reload sw.cfg (written when the game quit) is still there', files.join(','));
      // And the game can use it: load it.
      await p2.click('#start');
      await p2.waitForTimeout(5000);
      await t.tap(p2, 'F3');                    // the load menu lists the restored save by name in slot 1
      await p2.waitForTimeout(1500);
      const text = await t.brightPixels(p2, t.SLOT1);
      t.check(text > 50, `the game sees the restored save: its name is drawn in slot 1 of the load menu (${text} light pixels)`);
      await t.tap(p2, 'Enter');                 // load it
      await p2.waitForTimeout(500);
      await t.tap(p2, 'y');
      await p2.waitForTimeout(3000);
      t.check((await p2.evaluate(() => window.jfswState)) === 'running', 'the game is still running after loading it');
      const log = await p2.evaluate(() => window.jfswOut.join('\n'));
      t.check(!/Error|ERROR/.test(log), 'no error in the game output');
      await context.close();
    }
    // --- settings survive a reload without quitting: F4 sound menu, switch the music off, Escape ---
    {
      const read = async (p) => p.evaluate(() => { const b = window.jfswTest.readFile('sw.cfg'); return b ? new TextDecoder().decode(b) : null; });
      const music = (cfg) => { const m = cfg && /MusicOn = (\d+)/.exec(cfg); return m ? +m[1] : null; };
      const context = await env.browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page = await context.newPage();
      await page.goto(env.base + q); await t.waitState(page, 'ready');
      await page.click('#start'); await page.waitForTimeout(9000);   // (the level takes a few seconds to load; keys before that are ignored)
      t.check((await read(page)) === null, 'settings: no sw.cfg before anything is changed');
      // Key presses into the menu can be lost on a busy machine: open the sound menu, switch the music off (the cursor
      // starts on "Music"; Enter), leave the way a player does, and try again (at most 6 times) until the game's own
      // sw.cfg says MusicOn = 0 (it is 1 by default).
      let changed = null;
      for (let attempt = 0; attempt < 6 && music(changed) !== 0; attempt++) {
        await t.tap(page, 'F4'); await page.waitForTimeout(1000);
        await t.tap(page, 'Enter', 300); await page.waitForTimeout(500);
        // Leave the menu; sw.cfg appears when the game has left it, so press Escape until it does (at most 6 times).
        for (let i = 0; i < 6; i++) {
          await t.tap(page, 'Escape');
          await page.waitForTimeout(1200);
          changed = await read(page);
          if (changed !== null) { break; }
        }
      }
      await page.waitForTimeout(SETTLE_MS);
      t.check(music(changed) === 0, `settings: leaving the menus wrote sw.cfg with the changed setting (music on: ${music(changed)}, default 1)`);
      await page.reload();                      // no quit: the game never reaches its exit
      await t.waitState(page, 'ready');
      const after = await read(page);
      t.check(after === changed, `settings: after a reload ${SETTLE_MS} ms later, without quitting, sw.cfg is the changed one (music on: ${music(after)})`);
      await context.close();
    }
    // --- a save made just before a reload: three tries, each in a fresh browser profile ---
    {
      let kept = 0;
      for (let i = 0; i < SAVE_TRIES; i++) {
        const context = await env.browser.newContext({ viewport: { width: 1000, height: 800 } });
        const page = await context.newPage();
        await page.goto(env.base + q); await t.waitState(page, 'ready');
        await page.click('#start'); await page.waitForTimeout(5000);
        await t.tap(page, 'F6'); await page.waitForTimeout(1500);
        await page.keyboard.type('quick', { delay: 80 });
        await page.keyboard.press('Enter');
        // The file is created when the save starts; wait until it has its full size (about 300 KB).
        await page.waitForFunction(() => { const b = window.jfswTest.readFile('game0.sav'); return b && b.length > 200000; }, null, { timeout: 8000, polling: 10 });
        await page.waitForTimeout(RELOAD_AFTER_MS);
        await page.reload();
        await t.waitState(page, 'ready');
        if ((await page.evaluate(() => window.jfswTest.listFiles())).includes('game0.sav')) { kept++; }
        await context.close();
      }
      t.check(kept === SAVE_TRIES, `save: reloaded ${RELOAD_AFTER_MS} ms after game0.sav reached its full size, the save was still there in ${kept} of ${SAVE_TRIES} tries`);
    }
    // --- memory only: the same steps lose everything ---
    {
      const context = await env.browser.newContext({ viewport: { width: 1000, height: 800 } });
      const s = await session(env, context, q + '&persist=0', true);
      t.check(s.saved > 1000, 'control run (persist=0): the game saved game0.sav');
      await s.page.close();
      const p2 = await context.newPage();
      await p2.goto(env.base + q + '&persist=0');
      await t.waitState(p2, 'ready');
      const files = await p2.evaluate(() => window.jfswTest.listFiles());
      t.check(!files.includes('game0.sav') && !files.includes('sw.cfg'), 'control run (persist=0): after a reload the files are gone, so the check can fail', files.join(','));
      await p2.click('#start'); await p2.waitForTimeout(5000);
      await t.tap(p2, 'F3'); await p2.waitForTimeout(1500);
      const empty = await t.brightPixels(p2, t.SLOT1);
      t.check(empty < 10, `control run: with no save the load menu's slot 1 is empty (${empty} light pixels), so the slot check can fail`);
      await context.close();
    }
  } finally { await t.stop(env); }
  return t.summary('persist');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
