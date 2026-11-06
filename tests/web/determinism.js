#!/usr/bin/env node
// Native against WebAssembly determinism test (brief 02, tests 2 and 3).
//
//   node tests/web/determinism.js           # needs ./sw (make), build-wasm/ and testdata/swshare.grp
//   DET_WARP=4 node tests/web/determinism.js    # play the long demos 4x faster (CI shortcut; the default is 1)
//
// The game's own checks are used and no hook was added (code-facts section 7): a demo (-dp) plays
// back its recorded inputs, -demosyncrecord writes nine bytes per tic to <name>.dms and
// -demosynctest compares against them. A mismatch only prints "Demo out of sync" and still exits 0,
// so the output is checked, not the status.
//
// The demo tests/data/jfsw1.dmo.gz was recorded on x86_64 Linux (native, tests/tools/synth_input.c
// plays the keys); jfsw1.dms.gz is the sync file the native build makes from it. A .dmo holds the
// player's inputs and a header (map name, start position, a few settings), not game data.
//
//   1. native: playing the demo with -demosyncrecord gives the committed .dms (so the golden file is current);
//   2. wasm:   -demosynctest against the native .dms: no "out of sync", ends by itself;
//   3. wasm:   -demosyncrecord, compared byte for byte with the native .dms;
//   4. frame times while the demo plays (at 1x only);
//   5. the comparison fails when it should: a .dms of another demo, and one flipped byte;
//   6. the other direction: a demo recorded in the wasm build (the page types the keys) plays back
//      natively and in wasm with the same sync bytes.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const t = require('./lib.js');

const PORT = 48102;
const WARP = +(process.env.DET_WARP || 1);
const DATA = path.join(t.root, 'tests', 'data');
const SW = path.join(t.root, 'sw');
const DEMO_SECONDS = 150;                   // what tests/tools/synth_input.c was asked to play
const NAME = 'jfsw1';                       // demo name; the game limits it to 11 characters

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jfsw-det-'));
const gunzip = (f) => zlib.gunzipSync(fs.readFileSync(f));
function put(name, buf) { const f = path.join(tmp, name); fs.writeFileSync(f, buf); return f; }

// Native: play DMO (a Buffer) with the extra arguments in a clean directory; returns { status, out, files }.
function native(dmoName, dmo, extraArgs, dms) {
  const dir = fs.mkdtempSync(path.join(tmp, 'n-'));
  fs.writeFileSync(path.join(dir, dmoName + '.dmo'), dmo);
  if (dms) { fs.writeFileSync(path.join(dir, dmoName + '.dms'), dms); }
  const r = spawnSync(path.join(t.root, 'scripts', 'run-headless.sh'),
    ['--workdir', dir, '--timeout', '400', '--sw', SW, '-level' + level(), '-dp' + dmoName].concat(extraArgs),
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  const files = {};
  for (const f of fs.readdirSync(dir)) { if (/\.(dms|dmo)$/.test(f)) { files[f] = fs.readFileSync(path.join(dir, f)); } }
  return { status: r.status, out: r.stdout + r.stderr, files };
}
function level() { return 1; }   // both demos are of E1L1

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { if (a[i] !== b[i]) { return { byte: i, tic: Math.floor(i / 9), func: i % 9, a: a[i], b: b[i] }; } }
  return a.length === b.length ? null : { byte: n, tic: Math.floor(n / 9), length: [a.length, b.length] };
}

async function main() {
  if (!fs.existsSync(SW)) { throw new Error('./sw not found: run make (the native build) first'); }
  const dmo = gunzip(path.join(DATA, NAME + '.dmo.gz'));
  const golden = gunzip(path.join(DATA, NAME + '.dms.gz'));
  const other = gunzip(path.join(DATA, 'jfsw2.dms.gz'));     // sync bytes of a different demo (another level)
  const dmoFile = put(NAME + '.dmo', dmo);
  const goldenFile = put(NAME + '.dms', golden);
  const otherFile = put('other.dms', other);
  console.log(`demo ${NAME}.dmo: ${dmo.length} bytes, level ${level()}; sync file ${golden.length} bytes = ${golden.length / 9} tics`);

  // --- 1. native, now ------------------------------------------------------------------------------
  const n1 = native(NAME, dmo, ['-demosyncrecord']);
  t.check(n1.status === 0, 'native: the demo plays to its end by itself (exit 0)', `status ${n1.status}`);
  const nd = n1.files[NAME + '.dms'];
  t.check(nd && nd.length === golden.length && Buffer.compare(nd, golden) === 0,
    'native: the sync bytes equal the committed jfsw1.dms', nd ? JSON.stringify(firstDiff(nd, golden)) : 'no .dms');

  const FLIP_AT = 9 * 2500 + 4;
  const flipped = Buffer.from(golden); flipped[FLIP_AT] ^= 0x55;
  const mounts = {
    ['/f/ok/' + NAME + '.dmo']: dmoFile, ['/f/ok/' + NAME + '.dms']: goldenFile,
    ['/f/other/' + NAME + '.dms']: otherFile, ['/f/flip/' + NAME + '.dms']: put('flip.dms', flipped),
  };
  const env = await t.start(PORT, mounts);
  try {
    const dpArgs = ['-level' + level(), '-dp' + NAME];

    // --- 2. wasm plays the native sync file at 1x; frame times come from this run -------------------
    const r2 = await t.runGame(env, { args: dpArgs.concat(['-demosynctest']), files: [{ name: 'ok/' + NAME + '.dmo' }, { name: 'ok/' + NAME + '.dms' }], warp: 1 });
    t.check(r2.state === 'ended' && r2.exit && r2.exit.code === 0, 'wasm: the demo plays to its end by itself (exit 0)', `${r2.state} ${JSON.stringify(r2.exit)} ${r2.status}`);
    t.check(!/out of sync/i.test(r2.out), 'wasm: -demosynctest against the native .dms: no "Demo out of sync"', (r2.out.match(/Demo out of sync[^\n]*/) || [''])[0]);
    t.check(r2.errors.length === 0, 'wasm: no page error', r2.errors.join(' | '));
    t.check(r2.seconds > DEMO_SECONDS * 0.8, `wasm: the whole demo was played, in real time (${r2.seconds.toFixed(0)} s; the demo is about ${DEMO_SECONDS} s)`);

    // --- 4. frame times (the same run) ----------------------------------------------------------------
    {
      const f = r2.frames.map((x) => x - r2.t0);
      // after load: skip the first 3 seconds after the first presented frame
      const from = f[0] + 3000;
      const used = f.filter((x) => x >= from);
      const span = (used[used.length - 1] - used[0]) / 1000;
      const iv = [];
      for (let i = 1; i < used.length; i++) { iv.push(used[i] - used[i - 1]); }
      const s = iv.slice().sort((a, b) => a - b);
      const stats = { frames: used.length, seconds: +span.toFixed(1), median: s[Math.floor(s.length / 2)], p95: t.pct(s, 0.95), p99: t.pct(s, 0.99), max: s[s.length - 1] };
      console.log('  frame intervals (ms): ' + JSON.stringify(stats));
      fs.writeFileSync(path.join(tmp, 'frametimes.json'), JSON.stringify(stats));
      if (process.env.DET_FRAMES_OUT) { fs.writeFileSync(process.env.DET_FRAMES_OUT, JSON.stringify(stats)); }
      t.check(span >= 30, `frame times: at least 30 s of demo measured (${span.toFixed(0)} s, ${used.length} frames)`);
      t.check(stats.median < 18, `frame times: median ${stats.median.toFixed(1)} ms (target about 16.7)`);
      t.check(stats.max < 100, `frame times: no stall over 100 ms (max ${stats.max.toFixed(0)} ms, p99 ${stats.p99.toFixed(1)} ms)`);
    }

    // --- 3. wasm records its own sync file ------------------------------------------------------------
    const r3 = await t.runGame(env, { args: dpArgs.concat(['-demosyncrecord']), files: [{ name: 'ok/' + NAME + '.dmo' }], warp: WARP, read: [NAME + '.dms'] });
    const wd = r3.files[NAME + '.dms'];
    t.check(r3.state === 'ended' && r3.exit && r3.exit.code === 0, 'wasm: recording the sync file ends by itself (exit 0)', `${r3.state} ${JSON.stringify(r3.exit)}`);
    t.check(!!wd && wd.length === golden.length, `wasm: the sync file has as many bytes as the native one (${wd ? wd.length : 'none'} against ${golden.length})`);
    const d3 = wd ? firstDiff(wd, golden) : { missing: true };
    t.check(wd && d3 === null, 'wasm: the sync bytes equal the native ones, byte for byte', JSON.stringify(d3));
    if (d3 && !d3.missing) { console.log('  FIRST DIFFERENCE: tic ' + d3.tic + ', sync function ' + d3.func + ': ' + JSON.stringify(d3)); }

    // --- 5. the comparison fails when it should --------------------------------------------------------
    // (a) the sync bytes of another demo; (b) the right bytes with one flipped; at 4x (it ends at the first mismatch).
    const r5a = await t.runGame(env, { args: dpArgs.concat(['-demosynctest']), files: [{ name: 'ok/' + NAME + '.dmo' }, { name: 'other/' + NAME + '.dms' }], warp: 4 });
    t.check(/Demo out of sync - Sync Byte Number \d+ - Iteration \d+/.test(r5a.out), 'negative: another demo\'s .dms is reported "out of sync"', (r5a.out.match(/Demo out of sync[^\n]*/) || ['no message'])[0]);
    const r5b = await t.runGame(env, { args: dpArgs.concat(['-demosynctest']), files: [{ name: 'ok/' + NAME + '.dmo' }, { name: 'flip/' + NAME + '.dms' }], warp: 4 });
    const m = r5b.out.match(/Demo out of sync - Sync Byte Number (\d+) - Iteration (\d+)/);
    t.check(!!m, 'negative: one flipped byte is reported "out of sync"', (r5b.out.match(/Demo out of sync[^\n]*/) || ['no message'])[0]);
    t.check(m && +m[1] === FLIP_AT % 9, `negative: ... at the flipped sync function (${m ? m[1] : '?'}, expected ${FLIP_AT % 9})`);
    t.check(m && Math.abs(+m[2] - Math.floor(FLIP_AT / 9)) <= 1, `negative: ... at the flipped tic (iteration ${m ? m[2] : '?'}, expected about ${Math.floor(FLIP_AT / 9)})`);
    // (c) the byte comparison itself: golden against another demo's, and with a flipped byte.
    t.check(firstDiff(golden, other) !== null, 'negative: the byte comparison tells the two demos\' .dms files apart');
    t.check(firstDiff(golden, flipped) && firstDiff(golden, flipped).byte === FLIP_AT, 'negative: the byte comparison finds the one flipped byte');

    // --- 6. the other direction: recorded in the wasm build ----------------------------------------------
    const keys = async (page) => {
      // 40 s of play typed by the test: pistol, then turn left and fire, now and then step forward.
      await page.waitForTimeout(3000);
      await t.tap(page, '2');
      const t0 = Date.now();
      let i = 0;
      while (Date.now() - t0 < 40000) {
        const fwd = i % 4 === 3;
        await page.keyboard.down('ArrowLeft'); await page.keyboard.down('Control');
        if (fwd) { await page.keyboard.down('ArrowUp'); }
        await page.waitForTimeout(900);
        if (fwd) { await page.keyboard.up('ArrowUp'); }
        await page.keyboard.up('Control'); await page.keyboard.up('ArrowLeft');
        await page.waitForTimeout(100);
        i++;
      }
      await t.quitGame(page);
    };
    const r6 = await t.runGame(env, { args: ['-level1', '-s1', '-drwasm1'], script: keys, warp: 1, read: ['wasm1.dmo'], timeoutMs: 60000 });
    const wdmo = r6.files['wasm1.dmo'];
    t.check(!!wdmo && wdmo.length > 1000, `wasm: recorded a demo of its own (${wdmo ? wdmo.length : 0} bytes, game ${r6.state}/${JSON.stringify(r6.exit)})`);
    if (wdmo) {
      mounts['/f/w/wasm1.dmo'] = put('wasm1.dmo', wdmo);
      const n6 = native('wasm1', wdmo, ['-demosyncrecord']);
      const nd6 = n6.files['wasm1.dms'];
      t.check(n6.status === 0 && !!nd6 && nd6.length > 0, `native: plays the wasm-recorded demo to its end (${nd6 ? nd6.length / 9 : 0} tics)`, `status ${n6.status}`);
      const r6b = await t.runGame(env, { args: ['-level1', '-dpwasm1', '-demosyncrecord'], files: [{ name: 'w/wasm1.dmo' }], warp: 1, read: ['wasm1.dms'] });
      const wd6 = r6b.files['wasm1.dms'];
      const d6 = nd6 && wd6 ? firstDiff(nd6, wd6) : { missing: true };
      t.check(r6b.state === 'ended' && wd6 && d6 === null, 'wasm-recorded demo: native and wasm sync bytes are identical', JSON.stringify(d6));
    }
  } finally {
    await t.stop(env);
  }
  return t.summary('determinism');
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
