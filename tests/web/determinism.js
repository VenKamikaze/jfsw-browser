#!/usr/bin/env node
// Native against WebAssembly determinism test (brief 02, tests 2 and 3).
//
//   node tests/web/determinism.js           # needs ./sw (make), build-wasm/ and testdata/swshare.grp
//   DET_WARP=4 node tests/web/determinism.js    # play the long demos 4x faster (CI shortcut; the default is 1)
//   DET_ONLY=random node tests/web/determinism.js    # only part 7, the random-number order (about 45 s)
//
// Parts 1 to 6 use the game's own checks and no hook (code-facts section 7); part 7 uses -testrandom and -testdump. A demo (-dp) plays
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
//      natively and in wasm with the same sync bytes;
//   7. (F5) the two functions whose random draws are made in a fixed order, DoRail() and SpawnGrenadeExp(), which the
//      shareware game never reaches, are run by -testrandom in a game of its own: the per-tic records (-testdump,
//      17 bytes a tic, the hash of the whole state) and the numbers the draws gave are the same natively (gcc) and in wasm.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const t = require('./lib.js');

const PORT = t.port(48102);
const WARP = +(process.env.DET_WARP || 1);
const DATA = path.join(t.root, 'tests', 'data');
const SW = path.join(t.root, 'sw');
const DEMO_SECONDS = 150;                   // what tests/tools/synth_input.c was asked to play
const NAME = 'jfsw1';                       // demo name; the game limits it to 11 characters

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jfsw-det-'));   // removed at the end
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
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

// 7. -testrandom100,20,15: at tic 100 and every 15 tics after, 20 times, every machine runs SpawnGrenadeExp() and DoRail(); the
// game quits at tic 500 (-testquit500). A game of its own in E1L1 (no demo): nobody presses a key.
const RANDOM_TICS = 500;
const RANDOM_ARGS = ['-level1', '-s1', '-testrandom100,20,15', '-testquit' + RANDOM_TICS, '-testdumpr.bin'];
const RANDOM_RUNS = 20;

// Native, a game of its own: the game says it quit at -testquit's tic, and then waits for a key at the shareware "Give up?" page,
// so the run is stopped (SIGTERM, which makes the game leave cleanly) once the dump holds every record.
function nativeGame(args, dumpName, records) {
  const dir = fs.mkdtempSync(path.join(tmp, 'g-'));
  const dump = path.join(dir, dumpName);
  return new Promise((resolve) => {
    const p = spawn(path.join(t.root, 'scripts', 'run-headless.sh'), ['--workdir', dir, '--timeout', '300', '--sw', SW].concat(args),
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    let stopped = false;
    const poll = setInterval(() => {
      let size = 0;
      try { size = fs.statSync(dump).size; } catch (e) { /* not there yet */ }
      if (!stopped && size >= 17 * records) {
        stopped = true;
        setTimeout(() => { try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { /* gone */ } }, 1500);
      }
    }, 200);
    p.on('close', () => {
      clearInterval(poll);
      resolve({ out, dump: fs.existsSync(dump) ? fs.readFileSync(dump) : null });
    });
  });
}
const randomLines = (out) => out.split('\n').filter((l) => l.startsWith('TEST: random:')).map((l) => l.replace(/\r$/, ''));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { if (a[i] !== b[i]) { return { byte: i, tic: Math.floor(i / 9), func: i % 9, a: a[i], b: b[i] }; } }
  return a.length === b.length ? null : { byte: n, tic: Math.floor(n / 9), length: [a.length, b.length] };
}


// 7. (F5) see the header: DoRail() and SpawnGrenadeExp() run by -testrandom, gcc native against wasm.
async function randomOrder(env) {
  // --- 7. the random-number order (F5) ---------------------------------------------------------------
  // DoRail() and SpawnGrenadeExp() draw pairs of numbers for a difference (bugs.md L35). Both are out of the shareware
  // game's reach, so -testrandom runs them (with GameVariant of the registered game for the two calls) 20 times in a game
  // of its own. Every machine must get the same records and the same numbers: gcc native against wasm, and native twice.
  {
    const n7 = await nativeGame(RANDOM_ARGS, 'r.bin', RANDOM_TICS);
    const n7b = await nativeGame(RANDOM_ARGS, 'r.bin', RANDOM_TICS);
    const ln = randomLines(n7.out);
    const explosions = ln.filter((l) => / an explosion for /.test(l)).length;
    const puffLines = ln.filter((l) => / rail puffs, /.test(l));
    const puffs = puffLines.reduce((a, l) => a + +l.match(/: (\d+) rail puffs/)[1], 0);
    t.check(!!n7.dump && n7.dump.length >= 17 * RANDOM_TICS, `random: native: ${n7.dump ? n7.dump.length / 17 : 0} records of the game's tics (at least ${RANDOM_TICS})`);
    t.check(explosions === RANDOM_RUNS, `random: native: SpawnGrenadeExp() ran ${explosions} times (expected ${RANDOM_RUNS})`);
    t.check(puffLines.length === RANDOM_RUNS && puffs >= RANDOM_RUNS * 5 && !/no rail gun rod/.test(n7.out),
      `random: native: DoRail() ran ${puffLines.length} times and left ${puffs} puffs (expected ${RANDOM_RUNS} runs)`);
    t.check(!!n7b.dump && !!n7.dump && Buffer.compare(n7.dump.subarray(0, 17 * RANDOM_TICS), n7b.dump.subarray(0, 17 * RANDOM_TICS)) === 0 &&
      randomLines(n7b.out).join('\n') === ln.join('\n'), 'random: native twice: the same records and the same numbers');
    const r7 = await t.runGame(env, {
      args: RANDOM_ARGS, warp: 1, read: ['r.bin'], timeoutMs: 120000,
      script: async (page) => {
        // the game says it quit at tic 500, then waits for a key at the "Give up?" page
        for (let i = 0; i < 400; i++) {
          if (await page.evaluate(() => window.jfswOut.some((l) => /TEST: quitting after/.test(l)))) { break; }
          await page.waitForTimeout(250);
        }
        for (let i = 0; i < 12; i++) {
          if (['ended', 'error'].includes(await page.evaluate(() => window.jfswState))) { break; }
          await t.tap(page, 'Space'); await page.waitForTimeout(700);
        }
      },
    });
    const wd7 = r7.files['r.bin'];
    const lw = randomLines(r7.out);
    t.check(r7.state === 'ended' && !!wd7 && wd7.length >= 17 * RANDOM_TICS, `random: wasm: played the game (${wd7 ? wd7.length / 17 : 0} records, ${r7.state})`);
    t.check(lw.length === ln.length && lw.join('\n') === ln.join('\n'), `random: wasm: the numbers the draws gave (positions, velocities, hashes: ${lw.length} lines) equal the native ones`,
      lw.length === ln.length ? (lw.find((l, i) => l !== ln[i]) || '') + ' | ' + (ln.find((l, i) => l !== lw[i]) || '') : `${lw.length} lines against ${ln.length}`);
    const a7 = n7.dump ? n7.dump.subarray(0, 17 * RANDOM_TICS) : Buffer.alloc(0), b7 = wd7 ? wd7.subarray(0, 17 * RANDOM_TICS) : Buffer.alloc(1);
    const d7 = firstDiff(a7, b7);
    t.check(a7.length > 0 && d7 === null, `random: wasm: the ${RANDOM_TICS} per-tic records (hash of the whole state) equal gcc native's, byte for byte`,
      d7 ? 'first difference at tic ' + (Math.floor(d7.byte / 17) + 1) + ' ' + JSON.stringify(d7) : '');
    // the comparison sees a difference: one flipped byte in the last tic, and the first record's tic number
    const f7 = Buffer.from(a7); f7[f7.length - 3] ^= 0x01;
    t.check(a7.length > 0 && firstDiff(a7, f7) && firstDiff(a7, f7).byte === f7.length - 3, 'negative: the record comparison finds one flipped byte');
  }
}

async function main() {
  if (!fs.existsSync(SW)) { throw new Error('./sw not found: run make (the native build) first'); }
  if (process.env.DET_ONLY === 'random') {      // only part 7 (about 40 s): for trying a build against it
    const env7 = await t.start(PORT, {});
    try { await randomOrder(env7); } finally { await t.stop(env7); }
    return t.summary('determinism (random order only)');
  }
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
      // after load: the level is loaded (textures cached from the GRP) during the first seconds; measure from 10 s after the first frame
      const from = f[0] + 10000;
      const used = f.filter((x) => x >= from);
      const span = (used[used.length - 1] - used[0]) / 1000;
      const iv = [];
      for (let i = 1; i < used.length; i++) { iv.push(used[i] - used[i - 1]); }
      const s = iv.slice().sort((a, b) => a - b);
      const stats = { frames: used.length, seconds: +span.toFixed(1), median: s[Math.floor(s.length / 2)], p95: t.pct(s, 0.95), p99: t.pct(s, 0.99), max: s[s.length - 1] };
      console.log('  frame intervals (ms): ' + JSON.stringify(stats) + ' load average ' + os.loadavg().map((x) => x.toFixed(1)).join(' ') + ' on ' + os.cpus().length + ' cores');
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

    await randomOrder(env);
  } finally {
    await t.stop(env);
  }
  return t.summary('determinism');
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
