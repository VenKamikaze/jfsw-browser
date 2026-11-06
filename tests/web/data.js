#!/usr/bin/env node
// Browser tests for the game-data download (brief 03): download with progress, the IndexedDB cache, errors,
// the file picker, quota and no-IndexedDB, config changes, compression, revalidation.
//
//   node tests/web/data.js
//   DATA_SABOTAGE=nocache|nocrc|nosize|nocheck|nopickcache|nomtime|trusthit|nostall node tests/web/data.js
//       serves a damaged copy of the page's own code so that the matching tests must FAIL (they are listed in the Outcome
//       of doco/browser/03-data-download.md). Nothing in the repository is changed.
//
// Game data is never committed: the damaged files are made here from testdata/swshare.grp, in memory.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');
const t = require('./lib.js');
const { serve, route } = require('./dataserver.js');

const PORT = 48201, PORT2 = 48202;
const SABOTAGE = process.env.DATA_SABOTAGE || '';
const SIZE = 26056769;
const GOOD = fs.readFileSync(t.GRP);
const KEY = (port, p) => `url:http://127.0.0.1:${port}${p}`;

// ---- sabotage: patched copies of the page's code -------------------------------------------------------------
const PATCHES = {
  nocache: ['data.js', [['var cached = cache && !o.force ?', 'var cached = false && !o.force ?']]],
  nocrc: ['data.js', [['function verify(bytes, crc, what, declared) {', 'function verify(bytes, crc, what, declared) { return GRPS[1];'], ['function identify(crc, size) {', 'function identify(crc, size) { return GRPS[1];']]],
  nosize: ['data.js', [['if (expect && got < expect) {', 'if (false) {'], ['if (declared && got + c.length > declared) {', 'if (false) {']]],
  nocheck: ['data.js', [['function verify(bytes, crc, what, declared) {', 'function verify(bytes, crc, what, declared) { return GRPS[1];'], ['function identify(crc, size) {', 'function identify(crc, size) { return GRPS[1];'], ['if (expect && got < expect) {', 'if (false) {'], ['if (declared && got + c.length > declared) {', 'if (false) {']]],
  nopickcache: ['data.js', [["return store(rec).then(function (stored) { return result(rec, 'picked'", "return Promise.resolve(false).then(function (stored) { return result(rec, 'picked'"]]],
  trusthit: ['data.js', [['function intact(rec) {', 'function intact(rec) { return true;']]],
  nostall: ['data.js', [['function arm() {', 'function arm() { return;']]],
  nomtime: ['jfsw.js', [['FS.utime(path, ms, ms);', '']]],
};
function patched() {
  if (!SABOTAGE) { return {}; }
  const p = PATCHES[SABOTAGE];
  if (!p) { throw new Error('unknown DATA_SABOTAGE ' + SABOTAGE); }
  let src = fs.readFileSync(path.join(t.BUILD, p[0]), 'utf8');
  for (const [from, to] of p[1]) {
    if (src.indexOf(from) < 0) { throw new Error('sabotage patch does not apply: ' + from); }
    src = src.split(from).join(to);
  }
  return { ['/' + p[0]]: (req, res) => { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(src); } };
}

// ---- helpers ------------------------------------------------------------------------------------------------
const st = (page) => page.evaluate(() => window.jfswState);
const outHas = (page, re) => page.evaluate((s) => window.jfswOut.some((l) => new RegExp(s).test(l)), re.source);
const statusText = (page) => page.evaluate(() => document.getElementById('status').textContent);
const infoText = (page) => page.evaluate(() => document.getElementById('datainfo').textContent);
const visible = (page, sel) => page.isVisible(sel);
const gameOutput = (page) => page.evaluate(() => window.jfswOut.length);
const grpOnDisk = (page) => page.evaluate(() => { try { window.jfswTest.FS.stat('/data/sw.grp'); return true; } catch (e) { return false; } });
// What the data cache holds, read straight from IndexedDB (not through the page's own code).
async function cacheRecords(page) {
  return page.evaluate(() => new Promise((resolve) => {
    if (!indexedDB.databases) { resolve(null); return; }
    indexedDB.databases().then((dbs) => {
      if (!dbs.some((d) => d.name === 'jfsw-data')) { resolve({}); return; }
      const open = indexedDB.open('jfsw-data');
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        const out = {};
        const tx = db.transaction(['files', 'meta'], 'readonly');
        const c = tx.objectStore('files').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (cur) { const v = cur.value; out[v.key] = { size: v.size, crc: v.crc, etag: v.etag, bytes: v.bytes && v.bytes.byteLength, storedAt: v.storedAt }; cur.continue(); }
        };
        tx.oncomplete = () => { db.close(); resolve(out); };
      };
    });
  }));
}
// Click start; wait for a real picture; skip the intro; the main menu is drawn.
async function reachMenu(page, label) {
  if (!(await visible(page, '#start'))) { t.check(false, `${label}: the page offers "Click to start"`, await statusText(page)); return; }
  await page.click('#start');
  let stats = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    stats = await t.canvasStats(page);
    if (t.notBlank(stats)) { break; }
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(700); }
  await page.waitForTimeout(1500);
  const menu = await t.canvasStats(page);
  t.check(t.notBlank(menu) && (await st(page)) === 'running', `${label}: the game runs and the main menu is drawn (${menu.colors} colours)`);
}
async function waitLoaded(page, states) { return t.waitState(page, states || ['ready', 'needdata', 'error'], 120000); }
function notStarted(page, label) {
  return (async () => {
    t.check((await st(page)) === 'needdata', `${label}: the page waits for a good file (state needdata)`, await st(page));
    t.check(!(await visible(page, '#start')), `${label}: there is no "Click to start"`);
    t.check((await gameOutput(page)) === 0, `${label}: the game printed nothing, so it was not started`);
    t.check(!(await grpOnDisk(page)), `${label}: no sw.grp was handed to the game`);
    t.check(!(await outHas(page, /PALETTE/)), `${label}: not the engine's "Failed to load PALETTE.DAT!"`);
  })();
}

async function main() {
  const routes = Object.assign({
    '/swshare.grp': route({ body: GOOD }),
  }, patched());
  const server = await serve(t.BUILD, routes, PORT);
  const server2 = await serve(t.BUILD, { '/swshare.grp': route({ body: GOOD }) }, PORT2);   // no CORS headers
  const browser = await chromium.launch();
  const env = { browser, base: `http://127.0.0.1:${PORT}/index.html` };
  const swap = (p, opts) => { server.routes[p] = route(opts); };
  const fresh = () => { server.requests.length = 0; };
  const good = () => swap('/swshare.grp', { body: GOOD });
  if (SABOTAGE) { console.log(`*** DATA_SABOTAGE=${SABOTAGE}: the page's code is damaged on purpose; failing checks are expected`); }
  try {
    // ---- 1. First load -----------------------------------------------------------------------------------
    console.log('1. first load');
    let ctx;
    {
      const r = await t.open(env, '?test=1'); ctx = r;
      const { page, errors } = r;
      await waitLoaded(page);
      t.check((await st(page)) === 'ready', 'first load: the page is ready (the data came from the server)', (await st(page)) + ' ' + (await statusText(page)));
      const log = await page.evaluate(() => window.jfswDownloadLog);
      let increasing = log.length > 1;
      for (let i = 1; i < log.length; i++) { if (!(log[i].got > log[i - 1].got)) { increasing = false; } }
      t.check(log.length > 1 && increasing, `first load: progress was reported ${log.length} times, each further than the last`);
      t.check(log.length > 0 && log[log.length - 1].got === SIZE && log[log.length - 1].total === SIZE, 'first load: the last progress report is the whole file (' + SIZE + ' bytes)');
      t.check(server.hits('/swshare.grp') === 1, 'first load: one request for the GRP reached the server', String(server.hits('/swshare.grp')));
      const recs = await cacheRecords(page);
      const rec = recs && recs[KEY(PORT, '/swshare.grp')];
      t.check(rec && rec.size === SIZE && rec.bytes === SIZE && rec.crc === 0x08A7FA1F, 'first load: the file is in the IndexedDB cache with its size and CRC32', JSON.stringify(recs));
      t.check(/Shareware/.test(await infoText(page)) && /downloaded just now/.test(await infoText(page)), 'first load: the page says which data it uses', await infoText(page));
      const d = await page.evaluate(() => window.jfswData);
      console.log(`  info: CRC32 of ${SIZE} bytes took ${d.crcMs.toFixed(0)} ms (while downloading); whole download+check ${d.downloadMs.toFixed(0)} ms; persistent storage granted: ${await page.evaluate(() => window.jfswPersistent)}`);
      await reachMenu(page, 'first load');
      t.check(await outHas(page, /Checksumming/), 'first load: the game checksummed the GRP once (nothing to trust yet)');
      await page.waitForFunction(() => window.jfswSyncs >= 1, null, { timeout: 20000 });
      t.check(errors.length === 0, 'first load: no page error', errors.join('; '));
    }

    // ---- 2. Cached second load ----------------------------------------------------------------------------
    console.log('2. cached second load');
    {
      const { page, errors } = ctx;
      fresh();
      await page.reload();
      await waitLoaded(page);
      t.check((await st(page)) === 'ready', 'second load: ready', (await st(page)) + ' ' + (await statusText(page)));
      t.check(server.hits('/swshare.grp') === 0, 'second load: NO request for the GRP reached the server', JSON.stringify(server.requests.map((r) => r.path)));
      t.check(/kept in this browser/.test(await infoText(page)) && !/just now/.test(await infoText(page)), 'second load: the page says the data comes from the browser', await infoText(page));
      await reachMenu(page, 'second load');
      t.check(!(await outHas(page, /Checksumming/)), 'second load: the game did NOT checksum the GRP again', (await page.evaluate(() => window.jfswOut.filter((l) => /GRP|Scanning|Checksum/.test(l)).join(' | '))));
      t.check(errors.length === 0, 'second load: no page error', errors.join('; '));
      await ctx.context.close();
    }

    // ---- 3. Corrupt and truncated files -------------------------------------------------------------------
    console.log('3. corrupt and truncated files');
    {
      const corrupt = Buffer.from(GOOD); corrupt[1000000] ^= 0x01;
      swap('/swshare.grp', { body: corrupt });
      let r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      let s = await statusText(r.page);
      t.check(/checksum is wrong/.test(s) && /\/swshare\.grp/.test(s) && /CRC32/.test(s), 'corrupt: a clear message naming the URL and the checksum', s);
      await notStarted(r.page, 'corrupt');
      t.check(Object.keys((await cacheRecords(r.page)) || {}).length === 0, 'corrupt: nothing was cached');
      // The right file afterwards.
      good();
      if (await visible(r.page, '#retry')) { await r.page.click('#retry'); } else { await r.page.evaluate(() => { try { indexedDB.deleteDatabase('jfsw-data'); } catch (e) { /* none */ } }); await r.page.reload(); }   // (the else branch is only for sabotaged runs, where the bad file was accepted)
      await waitLoaded(r.page);
      t.check((await st(r.page)) === 'ready', 'corrupt, then the right file: loads normally after "Try again"', await statusText(r.page));
      t.check(!!(await cacheRecords(r.page))[KEY(PORT, '/swshare.grp')], 'corrupt, then the right file: now cached');
      await reachMenu(r.page, 'after a corrupt file');
      await r.context.close();

      // Truncated: the file on the server is shorter (a correct, smaller Content-Length).
      swap('/swshare.grp', { body: GOOD.subarray(0, 10000000) });
      r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/incomplete/.test(s) && /10,000,000 of 26,056,769/.test(s), 'truncated (short file): a clear message with both sizes', s);
      await notStarted(r.page, 'truncated');
      t.check(Object.keys((await cacheRecords(r.page)) || {}).length === 0, 'truncated: nothing was cached');
      await r.context.close();

      // Truncated: the connection drops half way through (Content-Length announces the whole file).
      swap('/swshare.grp', { body: GOOD, cutAt: 12000000 });
      r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/cut off|incomplete/.test(s) && /\/swshare\.grp/.test(s), 'truncated (connection dropped): a clear message', s);
      await notStarted(r.page, 'dropped');
      t.check(Object.keys((await cacheRecords(r.page)) || {}).length === 0, 'dropped: nothing was cached');
      await r.context.close();

      // A truncated file with no declared size to catch it: the table check does (?data= ignores config.js's size).
      swap('/short.grp', { body: GOOD.subarray(0, 10000000) });
      r = await t.open(env, '?test=1&persist=0&data=/short.grp');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/too short|cut off/.test(s) && /10,000,000 bytes/.test(s), 'truncated, nothing declared: the table check says it looks cut off', s);
      await notStarted(r.page, 'truncated, nothing declared');
      await r.context.close();
      good();
    }

    // ---- 4. Unknown files ---------------------------------------------------------------------------------
    console.log('4. unknown files');
    {
      const random = Buffer.alloc(SIZE);
      for (let i = 0; i < SIZE; i += 65536) { require('crypto').randomFillSync(random, i, Math.min(65536, SIZE - i)); }
      const wantCrc = (b) => ('00000000' + zlib.crc32(b).toString(16)).slice(-8);
      swap('/swshare.grp', { body: random });
      let r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      let s = await statusText(r.page);
      t.check(/CRC32/.test(s) && /checksum is wrong/.test(s) && s.indexOf(wantCrc(random)) >= 0, 'random bytes of the right size (default config): a clear message with the CRC32 found', s);
      await notStarted(r.page, 'random bytes');
      t.check(Object.keys((await cacheRecords(r.page)) || {}).length === 0, 'random bytes: nothing was cached');
      await r.context.close();
      good();

      swap('/random.grp', { body: random });
      r = await t.open(env, '?test=1&persist=0&data=/random.grp');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/checksum is wrong/.test(s) && /26,056,769 bytes/.test(s) && s.indexOf('CRC32 ' + wantCrc(random)) >= 0, 'random bytes, GRP-sized (?data=): "damaged" with the size and CRC32', s);
      await notStarted(r.page, 'random bytes (?data=)');
      await r.context.close();

      const odd = random.subarray(0, 5000000);
      swap('/odd.grp', { body: odd });
      r = await t.open(env, '?test=1&persist=0&data=/odd.grp');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/not a Shadow Warrior data file/.test(s) && /5,000,000 bytes/.test(s) && s.indexOf('CRC32 ' + wantCrc(odd)) >= 0, 'random bytes, other size (?data=): "not a data file the game knows" with the size and CRC32', s);
      await notStarted(r.page, 'random bytes, other size');
      await r.context.close();

      const text = Buffer.from('This is not a GRP file. It is a short text.\n');
      swap('/text.grp', { body: text });
      r = await t.open(env, '?test=1&persist=0&data=/text.grp');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/not a Shadow Warrior data file/.test(s) && s.indexOf(text.length + ' bytes') >= 0 && s.indexOf('CRC32 ' + wantCrc(text)) >= 0, 'text file: "not a data file the game knows" with the size and CRC32', s);
      await notStarted(r.page, 'text file');
      t.check(Object.keys((await cacheRecords(r.page)) || {}).length === 0, 'text file: nothing was cached');
      await r.context.close();

      // With the default config the size is declared, so the text file is refused for its size.
      swap('/swshare.grp', { body: text });
      r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/incomplete/.test(s) && /\/swshare\.grp/.test(s), 'text file (default config): refused for its size, naming the URL', s);
      await notStarted(r.page, 'text file (default config)');
      await r.context.close();
      good();
    }

    // ---- 5. HTTP error, and a server without CORS ---------------------------------------------------------
    console.log('5. HTTP 404 and cross-origin without CORS');
    {
      let r = await t.open(env, '?test=1&persist=0&data=/missing.grp');
      await waitLoaded(r.page);
      let s = await statusText(r.page);
      t.check(/answered 404/.test(s) && /\/missing\.grp/.test(s), 'HTTP 404: a clear message naming the status and the URL', s);
      t.check(!/Access-Control/.test(s), 'HTTP 404: no CORS hint (same origin)');
      await notStarted(r.page, '404');
      t.check(await visible(r.page, '#picklabel') && await visible(r.page, '#retry'), '404: the file picker and "Try again" are offered');
      await r.context.close();

      swap('/err.grp', { status: 500 });
      r = await t.open(env, '?test=1&persist=0&data=/err.grp');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/answered 500/.test(s), 'HTTP 500: a clear message', s);
      await r.context.close();

      const other = `http://127.0.0.1:${PORT2}/swshare.grp`;
      r = await t.open(env, '?test=1&persist=0&data=' + encodeURIComponent(other));
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(server2.hits('/swshare.grp') >= 1, 'cross-origin: the request did reach the other server (the browser blocked reading it)');
      t.check(/Access-Control-Allow-Origin/.test(s) && /127\.0\.0\.1:48202/.test(s) && /network failure|down or unreachable/.test(s), 'cross-origin without CORS: a message with the CORS hint, naming both origins and the network cause', s);
      await notStarted(r.page, 'cross-origin');
      t.check(await visible(r.page, '#picklabel') && await visible(r.page, '#retry'), 'cross-origin: the file picker and "Try again" are offered');
      await r.context.close();

      server2.routes['/swshare.grp'] = route({ body: GOOD, cors: true });
      r = await t.open(env, '?test=1&persist=0&data=' + encodeURIComponent(other));
      await waitLoaded(r.page);
      t.check((await st(r.page)) === 'ready', 'cross-origin WITH CORS headers: the same file loads (control)', await statusText(r.page));
      await r.context.close();
      server2.routes['/swshare.grp'] = route({ body: GOOD });

      // Unreachable host: nothing listens there.
      r = await t.open(env, '?test=1&persist=0&data=' + encodeURIComponent('http://127.0.0.1:48299/swshare.grp'));
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check(/could not be downloaded/.test(s) && /48299/.test(s), 'nothing listening: a clear message naming the URL', s);
      await r.context.close();
    }

    // ---- 6. Compressed responses --------------------------------------------------------------------------
    console.log('6. compressed responses');
    {
      const poll = async (page) => {
        const seen = [];
        for (let i = 0; i < 4000; i++) {
          const s = await st(page);
          if (s !== 'loading') { break; }
          seen.push(await page.evaluate(() => { const p = document.getElementById('progress'); return { hidden: p.hidden, value: p.hasAttribute('value') ? +p.getAttribute('value') : null, text: document.getElementById('status').textContent }; }));
          await page.waitForTimeout(25);
        }
        return seen;
      };
      for (const mode of ['stream', 'pre']) {
        swap('/swshare.grp', { body: GOOD, gzip: mode, chunk: 262144, delayMs: 2 });
        const r = await t.open(env, '?test=1&persist=0');
        const seen = await poll(r.page);
        await waitLoaded(r.page);
        t.check((await st(r.page)) === 'ready', `gzip (${mode}), declared size: downloads and is ready`, await statusText(r.page));
        const log = await r.page.evaluate(() => window.jfswDownloadLog);
        const totals = new Set(log.map((e) => e.total));
        let mono = log.length > 1;
        for (let i = 1; i < log.length; i++) { if (log[i].got < log[i - 1].got) { mono = false; } }
        t.check(totals.size === 1 && totals.has(SIZE), `gzip (${mode}), declared size: the percentage is of the declared size, not of Content-Length`, JSON.stringify([...totals]));
        t.check(mono && log[log.length - 1].got === SIZE && log.every((e) => e.got <= e.total), `gzip (${mode}), declared size: progress goes up to exactly 100%, never past it (${log.length} reports)`);
        const vals = seen.filter((x) => x.value !== null).map((x) => x.value);
        t.check(vals.length > 3 && vals.every((v, i) => i === 0 || v >= vals[i - 1]) && vals[vals.length - 1] <= 100, `gzip (${mode}), declared size: the progress bar moves forward and stays within 100 (${vals.length} samples)`);
        t.check(seen.some((x) => /%\)/.test(x.text)), `gzip (${mode}), declared size: the text shows megabytes and a percentage`, (seen[seen.length - 1] || {}).text);
        await r.context.close();
      }
      for (const mode of ['stream', 'pre']) {
        swap('/gz.grp', { body: GOOD, gzip: mode, chunk: 262144, delayMs: 2 });
        const r = await t.open(env, '?test=1&persist=0&data=/gz.grp');
        const seen = await poll(r.page);
        await waitLoaded(r.page);
        t.check((await st(r.page)) === 'ready', `gzip (${mode}), nothing declared: downloads and is ready`, await statusText(r.page));
        const log = await r.page.evaluate(() => window.jfswDownloadLog);
        t.check(log.length > 1 && log.every((e) => e.total === 0), `gzip (${mode}), nothing declared: no total is claimed (Content-Length is the compressed size)`, JSON.stringify(log.slice(-1)));
        const ind = seen.filter((x) => !x.hidden);
        t.check(ind.length > 3 && ind.every((x) => x.value === null), `gzip (${mode}), nothing declared: the progress bar is indeterminate (${ind.length} samples)`);
        t.check(seen.some((x) => /MB$/.test(x.text) && !/%/.test(x.text)), `gzip (${mode}), nothing declared: the text shows megabytes so far, no percentage`, (seen[seen.length - 1] || {}).text);
        await r.context.close();
      }
      good();
    }

    // ---- 7. File picker -----------------------------------------------------------------------------------
    console.log('7. file picker');
    {
      swap('/swshare.grp', { status: 404 });
      fresh();
      const r = await t.open(env, '?test=1');
      const { page } = r;
      await waitLoaded(page);
      t.check((await st(page)) === 'needdata' && /answered 404/.test(await statusText(page)), 'picker: with the data URL unreachable the page asks for a file', await statusText(page));
      // A bad file first.
      await page.setInputFiles('#pick', { name: 'notes.grp', mimeType: 'application/octet-stream', buffer: Buffer.from('not a grp at all') });
      await waitLoaded(page);
      let s = await statusText(page);
      t.check((await st(page)) === 'needdata' && /not a Shadow Warrior data file/.test(s) && /notes\.grp/.test(s) && /16 bytes/.test(s), 'picker: a bad file is refused with its name, size and CRC32', s);
      t.check(Object.keys((await cacheRecords(page)) || {}).length === 0, 'picker: the bad file was not cached');
      await page.setInputFiles('#pick', t.GRP);
      await waitLoaded(page);
      t.check((await st(page)) === 'ready', 'picker: swshare.grp is accepted and the page is ready', await statusText(page));
      t.check(/your own copy/.test(await infoText(page)) && /Shareware/.test(await infoText(page)), 'picker: the page says it uses the local copy', await infoText(page));
      t.check(await visible(page, '#usedownload'), 'picker: a way back to the download is offered');
      const recs = await cacheRecords(page);
      t.check(recs && recs.local && recs.local.size === SIZE && recs.local.crc === 0x08A7FA1F, 'picker: the picked file is cached under its own key', JSON.stringify(recs));
      await reachMenu(page, 'picked file');
      await page.waitForFunction(() => window.jfswSyncs >= 1, null, { timeout: 20000 });
      // Reload: the picked file again, with no picking and no request for any data URL.
      fresh();
      await page.reload();
      await waitLoaded(page);
      t.check((await st(page)) === 'ready' && /your own copy/.test(await infoText(page)), 'picker, reload: starts from the cached local copy without picking again', (await st(page)) + ' ' + (await infoText(page)));
      t.check(server.hits('/swshare.grp') === 0, 'picker, reload: no request for the GRP reached the server', String(server.hits('/swshare.grp')));
      await reachMenu(page, 'picked file, reloaded');
      t.check(!(await outHas(page, /Checksumming/)), 'picker, reload: the game did not checksum it again');
      // Back to the download.
      good();
      await page.reload();
      await waitLoaded(page);
      await page.click('#usedownload');
      await page.waitForFunction(() => window.jfswState === 'ready' && /downloaded/.test(document.getElementById('datainfo').textContent), null, { timeout: 60000 });
      t.check(/downloaded just now/.test(await infoText(page)) && server.hits('/swshare.grp') === 1, 'picker, switch back: "Use the download instead" downloads and says so', await infoText(page));
      const recs2 = await cacheRecords(page);
      t.check(recs2 && !recs2.local && !!recs2[KEY(PORT, '/swshare.grp')], 'picker, switch back: the local copy is forgotten, the download is cached', JSON.stringify(Object.keys(recs2 || {})));
      await r.context.close();
    }

    // ---- 8. Quota and no IndexedDB ------------------------------------------------------------------------
    console.log('8. quota and no IndexedDB');
    {
      good();
      let r = await t.open(env, '?test=1&persist=0&idb=quota');
      await waitLoaded(r.page);
      let s = await statusText(r.page);
      t.check((await st(r.page)) === 'ready' && /no space left/.test(s) && /downloaded again next time/.test(s), 'quota (hook): the page is ready from the downloaded copy, with a notice that it will be downloaded again', s);
      t.check(Object.keys((await cacheRecords(r.page)) || {}).length === 0, 'quota (hook): nothing was stored');
      await reachMenu(r.page, 'quota (hook)');
      await r.context.close();

      // The real thing: Chromium's own quota for this origin set to 1 MB through the DevTools protocol.
      r = await t.open(env, '?test=1&persist=0&data=/swshare.grp');
      await r.context.close();
      const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page2 = await ctx2.newPage();
      const cdp = await ctx2.newCDPSession(page2);
      let overridden = true;
      try { await cdp.send('Storage.overrideQuotaForOrigin', { origin: `http://127.0.0.1:${PORT}`, quotaSize: 1048576 }); } catch (e) { overridden = false; console.log('  (CDP quota override refused: ' + e.message + ')'); }
      await page2.goto(env.base + '?test=1&persist=0');
      await waitLoaded(page2);
      s = await statusText(page2);
      const real = (await st(page2)) === 'ready' && /no space left|would not keep/.test(s);
      t.check(overridden ? real : true, 'quota (real, Chromium quota set to 1 MB): ready from the downloaded copy, with the notice', s);
      console.log('  info: the real-quota run ' + (overridden ? (real ? 'produced the notice' : 'DID NOT produce the notice') : 'could not be run'));
      await ctx2.close();

      r = await t.open(env, '?test=1&idb=off');
      await waitLoaded(r.page);
      s = await statusText(r.page);
      t.check((await st(r.page)) === 'ready' && /downloaded each time/.test(s) && /will not be kept/.test(s), 'no IndexedDB (hook): the page is ready, with notices for the cache and for saved games', s);
      await reachMenu(r.page, 'no IndexedDB (hook)');
      await r.context.close();
    }

    // ---- 9. Config change ---------------------------------------------------------------------------------
    console.log('9. configuration changes');
    {
      swap('/swshare2.grp', { body: GOOD });
      const r = await t.open(env, '?test=1&persist=0');
      const { page } = r;
      await waitLoaded(page);
      t.check(!!(await cacheRecords(page))[KEY(PORT, '/swshare.grp')], 'config change: cached under the first URL');
      fresh();
      server.routes['/config.js'] = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(`window.JFSW_CONFIG={data:{url:'swshare2.grp',size:${SIZE},crc32:'08a7fa1f'}};`); };
      await page.goto(env.base + '?test=1&persist=0');
      await waitLoaded(page);
      delete server.routes['/config.js'];
      const recs = await cacheRecords(page);
      t.check(server.hits('/swshare2.grp') === 1, 'config change (new URL): the next load downloads again', String(server.hits('/swshare2.grp')));
      t.check(Object.keys(recs).join() === KEY(PORT, '/swshare2.grp'), 'config change (new URL): the entry for the old URL was removed', Object.keys(recs).join());

      // A changed declared size: served as a config.js of its own.
      const cfg = (size) => (req, res) => { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(`window.JFSW_CONFIG={data:{url:'swshare.grp',size:${size},crc32:'08a7fa1f'}};`); };
      server.routes['/config.js'] = cfg(SIZE);
      await page.goto(env.base + '?test=1&persist=0');
      await waitLoaded(page);
      t.check((await st(page)) === 'ready' && server.hits('/swshare.grp') === 1, 'config change: back to the first URL downloads it');
      fresh();
      await page.reload();
      await waitLoaded(page);
      t.check(server.hits('/swshare.grp') === 0, 'config change: unchanged config, cached: no request');
      server.routes['/config.js'] = cfg(SIZE + 1);
      fresh();
      await page.reload();
      await waitLoaded(page);
      t.check(server.hits('/swshare.grp') === 1, 'config change (declared size): the next load downloads again', String(server.hits('/swshare.grp')));
      t.check((await st(page)) === 'needdata' && /larger than the 26,056,770 bytes|incomplete/.test(await statusText(page)), 'config change (declared size): the file no longer matches what the page declares, so it is refused', await statusText(page));
      delete server.routes['/config.js'];
      await r.context.close();
    }

    // ---- 10. Download again, and the opt-in revalidation ---------------------------------------------------
    console.log('10. "Download again" and revalidation');
    {
      let etag = '"v1"';
      swap('/swshare.grp', { body: GOOD, etag: () => etag, lastModified: 'Wed, 04 Nov 2026 10:00:00 GMT' });
      const r = await t.open(env, '?test=1&persist=0');
      const { page } = r;
      await waitLoaded(page);
      const recs = await cacheRecords(page);
      t.check(recs[KEY(PORT, '/swshare.grp')].etag === '"v1"', 'ETag is kept in the cache record');
      fresh();
      await page.reload();
      await waitLoaded(page);
      t.check(server.hits('/swshare.grp') === 0, 'default config, server sends an ETag: still no request on reload (revalidation is opt-in)');
      await page.click('#redownload');
      await page.waitForFunction(() => window.jfswState === 'ready' && /just now/.test(document.getElementById('datainfo').textContent), null, { timeout: 60000 });
      t.check(server.hits('/swshare.grp') === 1, '"Download again" fetches the file again', String(server.hits('/swshare.grp')));
      fresh();
      await page.goto(env.base + '?test=1&persist=0&revalidate=1');
      await waitLoaded(page);
      let q = server.requests.filter((x) => x.path === '/swshare.grp');
      t.check(q.length === 1 && q[0].headers['if-none-match'] === '"v1"' && q[0].status === 304 && (await st(page)) === 'ready', 'revalidate=1: one conditional request (If-None-Match), answered 304, the cached copy is used', JSON.stringify(q.map((x) => [x.headers['if-none-match'], x.status])));
      t.check(/still current/.test(await infoText(page)), 'revalidate=1: the page says the server confirmed the copy', await infoText(page));
      etag = '"v2"';
      fresh();
      await page.reload();
      await waitLoaded(page);
      q = server.requests.filter((x) => x.path === '/swshare.grp');
      t.check(q.length === 1 && q[0].status === 200 && /just now/.test(await infoText(page)), 'revalidate=1: a changed ETag downloads the new file', JSON.stringify(q.map((x) => x.status)) + ' ' + (await infoText(page)));
      t.check((await cacheRecords(page))[KEY(PORT, '/swshare.grp')].etag === '"v2"', 'revalidate=1: the cache record has the new ETag');
      good();
      await r.context.close();
    }

    // ---- 12. A stored copy is checksummed again; a stalled download ends in an error -------------------------
    console.log('12. damaged stored copy, stalled download');
    {
      good();
      // Damage 4 KB inside the stored bytes, keeping the stored crc, as a disk or browser fault could.
      const damage = (page, key) => page.evaluate((k) => new Promise((resolve, reject) => {
        const open = indexedDB.open('jfsw-data');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('files', 'readwrite');
          const g = tx.objectStore('files').get(k);
          g.onsuccess = () => { const rec = g.result; const u = new Uint8Array(rec.bytes); for (let i = 0; i < 4096; i++) { u[5000000 + i] ^= 0xff; } tx.objectStore('files').put(rec); };
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }), key);
      const diskCrc = (page) => page.evaluate(() => { const b = window.jfswTest.readFile('/data/sw.grp'); return b ? JfswData.crc32(b) : null; });
      let r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      await damage(r.page, KEY(PORT, '/swshare.grp'));
      fresh();
      await r.page.reload();
      await waitLoaded(r.page);
      t.check((await st(r.page)) === 'ready' && /damaged/.test(await statusText(r.page)), 'damaged stored download: the page says the kept copy was damaged', await statusText(r.page));
      t.check(server.hits('/swshare.grp') === 1, 'damaged stored download: it was downloaded again', String(server.hits('/swshare.grp')));
      t.check((await diskCrc(r.page)) === 0x08A7FA1F, 'damaged stored download: the file handed to the game is the good one');
      const rec = (await cacheRecords(r.page))[KEY(PORT, '/swshare.grp')];
      t.check(rec && rec.crc === 0x08A7FA1F, 'damaged stored download: the cache holds a fresh record');
      await r.context.close();

      // A damaged picked file: with the data URL unreachable, nothing may reach the game.
      swap('/swshare.grp', { status: 404 });
      r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      await r.page.setInputFiles('#pick', t.GRP);
      await waitLoaded(r.page);
      t.check((await st(r.page)) === 'ready', 'damaged picked copy: (set-up) the picked file is accepted');
      await damage(r.page, 'local');
      await r.page.reload();
      await waitLoaded(r.page);
      t.check((await st(r.page)) === 'needdata' && /answered 404/.test(await statusText(r.page)), 'damaged picked copy: the damaged copy is not used (the page falls back to the download, which fails here)', (await st(r.page)) + ' ' + await statusText(r.page));
      t.check(!(await grpOnDisk(r.page)), 'damaged picked copy: nothing was handed to the game');
      t.check(!(await cacheRecords(r.page)).local, 'damaged picked copy: the record was deleted');
      await r.context.close();
      good();

      // Stalled download: 1 MB, then silence. The page gives up after ?stall= ms.
      swap('/swshare.grp', { body: GOOD, stallAt: 1 << 20 });
      r = await t.open(env, '?test=1&persist=0&stall=2000');
      const state = await t.waitState(r.page, ['needdata', 'ready', 'error'], 20000).catch(() => 'timeout');
      const s = await statusText(r.page);
      t.check(state === 'needdata' && /stalled/.test(s) && /\/swshare\.grp/.test(s), 'stalled download: ends in a clear error within the limit', state + ' ' + s);
      t.check(await visible(r.page, '#retry') && await r.page.isEnabled('#pick'), 'stalled download: "Try again" is offered and the picker is usable');
      if (state === 'needdata') {
        await notStarted(r.page, 'stalled');
        good();
        await r.page.click('#retry');
        await waitLoaded(r.page);
        t.check((await st(r.page)) === 'ready', 'stalled, then a working server: "Try again" loads normally', await statusText(r.page));
      }
      await r.context.close();

      // Picking a file while a download is stuck cancels it.
      swap('/swshare.grp', { body: GOOD, stallAt: 1 << 20 });
      r = await t.open(env, '?test=1&persist=0&stall=60000');
      await r.page.waitForFunction(() => window.jfswDownloadLog && window.jfswDownloadLog.length > 0, null, { timeout: 20000 }).catch(() => {});
      t.check((await st(r.page)) === 'loading' && await r.page.isEnabled('#pick'), 'download in progress: the picker is usable');
      await r.page.setInputFiles('#pick', t.GRP);
      const st2 = await t.waitState(r.page, ['ready', 'needdata', 'error'], 20000).catch(() => 'timeout');
      t.check(st2 === 'ready' && /your own copy/.test(await infoText(r.page)), 'download in progress: picking a file cancels it and uses the file', st2 + ' ' + await infoText(r.page));
      await r.context.close();
      good();

      // ?data= must not throw away the cached configured file.
      r = await t.open(env, '?test=1&persist=0');
      await waitLoaded(r.page);
      swap('/other.grp', { body: GOOD });
      await r.page.goto(env.base + '?test=1&persist=0&data=/other.grp');
      await waitLoaded(r.page);
      const keys = Object.keys(await cacheRecords(r.page));
      t.check(keys.indexOf(KEY(PORT, '/swshare.grp')) >= 0 && keys.indexOf(KEY(PORT, '/other.grp')) >= 0, 'a ?data= visit keeps the configured file\'s record', keys.join());
      await r.context.close();
    }

    // ---- 11. Page code and game still work from a clean profile ------------------------------------------------
    console.log('11. without ?test=1');
    {
      const r = await t.open(env, '');
      await waitLoaded(r.page);
      t.check((await st(r.page)) === 'ready', 'plain page (no ?test=1): ready', await statusText(r.page));
      t.check((await r.page.evaluate(() => typeof window.jfswTest + typeof window.jfswDownloadLog)) === 'undefinedundefined', 'plain page: no test hooks');
      await r.context.close();
      // The knobs do nothing without ?test=1.
      fresh();
      const q = await t.open(env, '?idb=off&idb=quota&revalidate=1&stall=1&persist=0&args=-nosound&files=/x');
      await waitLoaded(q.page);
      const s0 = await statusText(q.page);
      t.check((await st(q.page)) === 'ready' && s0 === 'Ready.', 'plain page with ?idb=off&revalidate=1&stall=1&persist=0: the knobs are ignored (ready, no notices)', s0);
      t.check(!!(await cacheRecords(q.page))[KEY(PORT, '/swshare.grp')], 'plain page: IndexedDB was used, the hook did not break it');
      await q.page.goto(env.base + '?idb=quota&revalidate=1');
      await waitLoaded(q.page);
      t.check(server.hits('/swshare.grp') === 1, 'plain page: ?revalidate=1 is ignored (the cached copy made no request)', String(server.hits('/swshare.grp')));
      await q.context.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await new Promise((r) => server2.close(r));
  }
  return t.summary('data');
}
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
