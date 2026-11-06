#!/usr/bin/env node
// Quick test (no browser, no game data needed except for the timing line): the page's table of known GRPs
// (web/grptable.js) agrees with src/grpscan.c, config.js declares a file that table knows, and the page's
// CRC-32 gives the same answers as zlib's.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const t = require('./lib.js');

const root = t.root;

function parseC(src) {
  const rows = [];
  const re = /\{\s*"([^"]+)",\s*0x([0-9A-Fa-f]+),\s*(\d+),\s*GRPFILE_GAME_(\w+)(\s*\|\s*GRPFILE_ADDON)?\s*,\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) { rows.push({ name: m[1], crc: m[2].toLowerCase(), size: +m[3], game: m[4], addon: !!m[5], file: m[6] }); }
  return rows;
}
function load(file, extra) {
  const sandbox = Object.assign({ window: {}, performance, URL, location: { href: 'http://x/', origin: 'http://x' } }, extra);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'web', file), 'utf8'), sandbox, { filename: file });
  return sandbox.window;
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const c = parseC(fs.readFileSync(path.join(root, 'src', 'grpscan.c'), 'utf8'));
const js = load('grptable.js').JFSW_GRPS;
const key = (r) => ({ name: r.name, crc: r.crc, size: r.size, game: r.game, addon: r.addon, file: r.file });
t.check(c.length >= 6, `grpscan.c: found ${c.length} table rows`);
t.check(same(c.map(key), js.map(key)), 'web/grptable.js is the same table as grpscan.c (name, CRC32, size, kind, file name)');
// The comparison can fail: one digit of a CRC32, one size, one extra row.
const bad1 = js.map(key); bad1[1].crc = '08a7fa1e';
const bad2 = js.map(key); bad2[0].size += 1;
t.check(!same(c.map(key), bad1) && !same(c.map(key), bad2) && !same(c.map(key), js.slice(1).map(key)), 'the comparison notices a changed CRC32, a changed size and a missing row');

const win = load('config.js');
const cfg = win.JFSW_CONFIG.data;
const entry = js.find((g) => g.crc === cfg.crc32 && g.size === cfg.size);
t.check(entry && entry.game === 'SHARE', 'config.js declares a shareware GRP the table knows', JSON.stringify(cfg));

// data.js reads window.JFSW_GRPS when it loads, so both go in one context.
const sb = { window: {}, performance, URL, location: { href: 'http://x/', origin: 'http://x' } };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root, 'web', 'grptable.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'web', 'data.js'), 'utf8'), sb);
const D = sb.window.JfswData;
const check9 = D.crc32(new Uint8Array(Buffer.from('123456789')));
t.check(check9 === 0xCBF43926, 'page CRC-32 of "123456789" is the standard 0xCBF43926', check9.toString(16));
for (const n of [0, 1, 3, 4, 5, 7, 8, 1000, 65537]) {
  const b = require('crypto').randomBytes(n);
  if (D.crc32(new Uint8Array(b)) !== zlib.crc32(b)) { t.check(false, `page CRC-32 equals zlib's for ${n} random bytes`); }
}
t.check(true, "page CRC-32 equals zlib's for random inputs of 0 to 65537 bytes (all tail lengths)");
t.check(D.identify(0x08A7FA1F, 26056769).name === 'Shareware Version' && D.identify(0x08A7FA1F, 26056768) === null, 'identify() needs both CRC32 and size');
if (fs.existsSync(t.GRP)) {
  const g = new Uint8Array(fs.readFileSync(t.GRP));
  let best = 1e9;
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); const v = D.crc32(g); best = Math.min(best, performance.now() - t0); if (i === 0) { t.check(v === 0x08A7FA1F, 'page CRC-32 of testdata/swshare.grp is 0x08A7FA1F'); } }
  console.log(`  info: CRC-32 of ${g.length} bytes in node: best of 5 ${best.toFixed(0)} ms`);
}
process.exit(t.summary('grptable'));
