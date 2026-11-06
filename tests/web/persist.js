#!/usr/bin/env node
// Saves and settings persist across a page reload (brief 02, test 4).
//
//   node tests/web/persist.js
//
// Starts E1L1, saves a game with the game's own quick-save keys (F6, a name, Enter), quits the game the
// way a closing window does (which makes it write sw.cfg), reloads the page and looks in the game's
// folder. The same steps with ?persist=0 (memory only) must lose the files: that run proves the check can fail.
'use strict';
const t = require('./lib.js');

const PORT = 48103;

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
      await t.tap(p2, 'F3');
      await p2.waitForTimeout(1500);
      const stats = await t.canvasStats(p2);
      t.check(t.notBlank(stats), 'the game runs on the restored files (load menu drawn)');
      const log = await p2.evaluate(() => window.jfswOut.join('\n'));
      t.check(!/Error|ERROR/.test(log), 'no error in the game output');
      await context.close();
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
      await context.close();
    }
  } finally { await t.stop(env); }
  return t.summary('persist');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
