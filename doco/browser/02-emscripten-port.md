# 02: Emscripten port

## Goal

Single-player Shadow Warrior runs in a browser: an Emscripten/WASM build with the software renderer, keyboard and mouse, sound effects, saved config and games, and a shell page. It plays a natively recorded demo with the same per-tic sync values as the native build.

## Read first

- [`README.md`](README.md): D6, D7, D8, D12, Q4, Q5 and "Working across repos".
- [`code-facts.md`](code-facts.md): the event and frame pump (`handleevents`, `nextpage`), the blocking loops, the SDL layer's platform code, GRP detection and the search path, where config and saves are written, `sync.c`, demos, and the audio drivers.
- The Outcome of [00](00-setup.md): the emsdk set-up, the `emscripten-ports` branch, test data and the headless run.
- Bit Riot's `doco/netplay/09-wasm-port.md` and its Outcome (Bit Riot's `claude` branch): Emscripten flags, the shell page, audio unlock, IDBFS, and what its review found.

## In scope

### 1. Build target

- An Emscripten build: the existing Makefiles with a platform switch, or a small separate makefile or CMake file, your choice. Document it in `doco/browser/building.md`. The native build is unchanged.
- Emscripten 6.0.13 from `scripts/setup-emsdk.sh`; SDL2 from the Emscripten port (`-sUSE_SDL=2`), seeded with `--with-ports`. No Vorbis and no MIDI driver (music is later, Q4; shareware music is MIDI anyway, code-facts §9). Under `emcc` the Makefiles detect `PLATFORM=UNKNOWN` (code-facts §9): decide whether to add an `EMSCRIPTEN` platform to `Makefile.shared` or override from outside.
- `USE_POLYMOST=0 USE_OPENGL=0` (D6). No startup window (`HAVE_STARTWIN` off).
- Output in a git-ignored build directory: the page, `.js` and `.wasm`.
- `-sASYNCIFY` (D7), with an `ASYNCIFY_ADD`/`ASYNCIFY_IMPORTS` list or the defaults, as needed. Measure the size and speed cost and record them in the Outcome.

### 2. Yields (D7)

- The blocking loops stay. Yield to the browser (`emscripten_sleep(0)` or similar) in the event pump and/or the frame present, so that:
  - every loop that waits for input or time gives the browser a chance to run; there must be no loop that spins without yielding (check every loop in code-facts' list);
  - the game presents at most one frame per yield, paced to the display (`requestAnimationFrame`) where possible.
- Engine timing is already thread-free: `totalclock` is polled from `sampletimer()` (code-facts §5). Check it behaves under Emscripten (`SDL_GetPerformanceCounter` resolution, and what happens to the busy-wait loops when the tab is throttled).
- **Exits.** Many paths call `exit()` from the middle of a loop (code-facts §2). In the browser each must end with a clear "the game has ended" state on the page (with a reload button), not a frozen canvas.

### 3. Platform

- Video: SDL2's canvas; the 8-bit palette path through SDL2 (`sdlayer2.c`). The canvas scales to the window with the right aspect ratio.
- Input: keyboard, and mouse with pointer lock on click. Escape must still reach the game (the browser takes it to leave pointer lock: find a sensible way).
- Audio: sound effects through jfaudiolib's SDL driver. Audio starts only after a user gesture: the page shows a "Click to start" overlay and starts `main` (or the audio) on that click.
- Files: config and save games on IndexedDB (IDBFS), mounted where the game writes them, synced after the game writes and on page hide. The GRP is not on IDBFS (brief 03 caches it). code-facts §6 describes the search path; one way that needs no engine change is a persisted current directory holding `user_profiles_disabled` (the game's own "portable" switch: config and saves go to the cwd) plus a separate, non-persisted data directory on the search path for the GRP (e.g. via `DATADIR`). There is no `HOME` or `/proc` in the browser.
- Anything that can't work in a browser (`fork`/`exec`, the startup window, threads) is compiled out under `__EMSCRIPTEN__`.

### 4. Shell page

- A plain HTML page: the canvas, the click-to-start overlay, a status line, errors shown on the page.
- Dev knobs and test hooks only with `?test=1` (e.g. passing extra game arguments, the sync dump below).
- **Dev data loader, this brief only:** `?data=<url>` fetches the GRP into a folder on the game's search path before `main`, with no cache. The default is a same-origin `swshare.grp` next to the page. Brief 03 replaces this.

### 5. Determinism tooling (no new game hooks)

- The game already has what's needed (code-facts §7): `-level1 -dp<name> -demosyncrecord` writes nine sync bytes per tic to `<name>.dms` while playing a demo, `-demosynctest` compares against them, and `-dp` exits by itself at the end of the demo. **A mismatch prints `Demo out of sync - …` to stdout and still exits 0**, so tests must check the output (and the page's console in the browser), not the status.
- With `?test=1`, the page must be able to: pass game arguments; put test files (`.dmo`, `.dms`) into the game's directory before `main`; and hand files the game wrote (a `.dms`) back to the test (e.g. through a test-only JS function that reads them from the virtual file system).
- Don't add sync or quit hooks to the game: brief 01 adds test-only network hooks in `sync.c`/`game.c` at the same time, and two briefs editing the same lines will conflict.

## Out of scope

- Networking (04), the proper data download (03), music (Q4), WebGL (D6), touch controls, the add-ons.
- Any change to the simulation, except to fix a native-against-wasm difference the determinism test finds. If you find one, **stop and report it** with the first differing tick and what differs, before fixing it.

## Tests

1. **Playwright smoke test** (Chromium and Playwright are preinstalled; **never** run `playwright install`). Serve the build and `testdata/swshare.grp` locally; load the page with `?test=1`; click to start; reach the main menu; check the canvas is not blank (e.g. sample pixels from the canvas and require several distinct colours, read back in a way that works with SDL's canvas). Also check no uncaught page errors.
   - **Prove the blank check works:** run it against a blank or single-colour canvas and show it fails. Bit Riot's first smoke test could not see a blank canvas.
2. **Determinism.** Record a demo natively (`-dr`, on the shareware GRP, a level with monsters, at least two minutes of movement and shooting; a `.dmo` holds inputs and a header, not game data, so it can be committed if small: say which). Natively, play it with `-demosyncrecord` to make the `.dms`. Then in wasm: play it with `-demosynctest` against the native `.dms` (no "out of sync" line, and the demo reached its end), **and** record a wasm `.dms` and compare it byte for byte with the native one. Script it (`tests/` + Playwright).
   - The demo header is `fwrite`n C structs (code-facts §7): check that a demo recorded on 64-bit x86 even loads on wasm32, and in the other direction.
   - Show the comparison fails when it should (a `.dms` from another demo, and one flipped byte).
3. **Frame time.** Measure frame intervals in Chromium during demo playback over at least 30 seconds and report the median, 95th and 99th percentile. The target is a median at 60 Hz (about 16.7 ms) with no stalls over 100 ms after load. If the container's headless Chromium can't show that, say what it shows and why.
4. **Saves persist:** change a setting (or save a game), reload, and check it's still there (Playwright).
5. The native build and 00's headless run still pass.

## Acceptance criteria

1. The browser build compiles from a fresh recursive clone with the documented commands, on a clean Emscripten cache.
2. Tests 1 to 5 pass; report counts and the frame-time numbers.
3. A person can play the first shareware level in Chromium and Firefox with keyboard, mouse and sound (the coordinator gives the user play-test steps).
4. The native build is unchanged in behaviour, and the engine changes are upstream-friendly (Q5).

## Dependencies

00, Q2 (answered: `scripts/fetch-test-data.sh`).

## Notes

- **Git:** this brief probably changes jfbuild (the SDL layer, the timer, the Makefile) and maybe jfaudiolib. Work on `browser/02-emscripten-port` in jfsw-browser and in each fork you change, from their `claude` branches, per "Working across repos". Push after each commit. **If jfmact needs a change, stop and ask** (it has no `claude` branch yet; see the README).
- Brief 01 runs at the same time in another worktree, and also changes jfbuild (`mmulti.c` and the Makefile). Keep your jfbuild changes away from the network files.
- Share the emsdk install with brief 01: use the default `EMSDK_DIR` from 00.
- Chrome's autoplay rules: audio needs the click; don't create the audio device before it.

## Outcome

Status: **review** (branch `browser/02-emscripten-port` in jfsw-browser, jfbuild and jfaudiolib; the coordinator marks it done after review and merge). Single-player Shadow Warrior runs in Chromium from `scripts/build-wasm.sh`; the native build is unchanged. Not tested: Firefox (not installed in the container), a real GPU, a real sound card, a person playing.

**What landed**

- **Build.** `jfbuild/Makefile.shared` and `jfaudiolib/Makefile.shared` recognise `emcc` (`wasm32-unknown-emscripten`) as `PLATFORM=EMSCRIPTEN`: SDL2 from the Emscripten port, no GTK/ALSA/Vorbis, host tools built with the host compiler, and objects/libraries named `*.wasm.o` / `lib*.wasm.a` so a native and a browser build share one tree. `Makefile` includes the new `Makefile.emscripten` (link flags, `build-wasm/`, rules that always ask the library sub-makes) under emcc. `scripts/build-wasm.sh` wraps it: `scripts/build-wasm.sh` builds `build-wasm/{index.html,jfsw.js,jfsw.css,sw.js,sw.wasm}` (git-ignored). `mmulti_null.c` replaces `mmulti.c` there (no sockets; single player until brief 04).
- **Yields (D7).** `-sASYNCIFY`. `jfbuild/src/sdlayer2.c` yields in two places: `showframe()` once per presented frame (a `requestAnimationFrame` wait, 100 ms fallback in a hidden tab) and `handleevents()` after 8 ms without a yield, for loops that wait without drawing. Every loop in code-facts section 5 reaches one of them; no loop spins. `sampletimer()` caps one clock step at a quarter second (a stalled tab is a pause). Also: the SDL renderer (WebGL texture) is used for the 8-bit picture, `setvideomode()` always makes a window, `wm_msgbox()` shows its text on the page, jfaudiolib's SDL driver opens the Web Audio device so SDL converts the format (otherwise "FX driver is No Sound"). `exit()` from anywhere ends in the page's "The game has ended / stopped with an error ... Reload the page" overlay with a reload button (`-sEXIT_RUNTIME`, `Module.onExit`, `onAbort`, error handlers).
- **Page (`web/`).** Click to start (audio opens inside the click), status line, progress, errors on the page; the canvas is scaled to the window keeping its shape; pointer lock by clicking the picture (SDL re-grabs it); when the browser takes the pointer for Escape (the key never arrives) the page gives the game an Escape. The game's folder `/persist` is IndexedDB (IDBFS) and holds `user_profiles_disabled`, so `sw.cfg`, saves and the log go there (the engine's own "portable" switch; no engine change); the page checks it once a second, on `visibilitychange` and on `pagehide`, and syncs when something changed. The GRP goes to `/data` (not persisted), which is `DATADIR` (`-DDATADIR=\"/data\"`) so GRP detection is the game's own. Dev data loader: `?data=<url>`, default `swshare.grp` next to the page, no cache. Test hooks only with `?test=1`: `?args=`, `?files=` (put files in the game's directory before `main`), `?persist=0`, `window.jfswTest` (`readFile`, `writeFile`, `listFiles`), `Module.jfswFrameLog`/`jfswYieldLog`, `window.jfswOut` (everything the game printed), `window.jfswExit`. No game hooks were added.
- **A bug in the game that x86 hid.** `SpawnBreakFlames` is defined with two parameters but was declared and called with one in `break.c`; `wasm-ld` warned and the call would trap when a burning breakable is destroyed. Fixed by passing the (unused) second argument. The only game-source change; nothing in the simulation changed.

**Commits**

| Repo | Branch | Commit |
|---|---|---|
| jfsw-browser | `browser/02-emscripten-port` | branch tip (see `git log`) |
| jfbuild | `browser/02-emscripten-port` | `4b339db` (from `claude` `40a98be`) |
| jfaudiolib | `browser/02-emscripten-port` | `e087b6d` (from `claude` `68be97f`) |

jfmact needed no change. Merge order is in the README ("Working across repos"): merge the two fork branches into their `claude` first. The jfbuild changes are in `Makefile`, `Makefile.shared`, `include/compat.h` and `src/sdlayer2.c`; brief 01 also edits `jfbuild/Makefile` (`mmulti`). The only shared surface is the `ENGINEOBJS` area there: this branch adds an `ifeq ($(PLATFORM),EMSCRIPTEN)` block after the `DARWIN` one and does not edit existing lines.

**Build commands** (clean clone, clean Emscripten cache: built in about a minute with `-j2` after SDL2 was in the cache)

```
scripts/setup-emsdk.sh [--with-ports]; scripts/build-wasm.sh
scripts/fetch-test-data.sh; make -j4        # the tests also need the native ./sw
```

**Tests** (all with Chromium through Playwright; Firefox is not available in the container)

- `node tests/web/smoke.js`: **22 passed, 0 failed.** Page loads the data and offers the button; the click starts the game; the canvas is not blank (255 colours); the main menu is drawn after skipping the intro; Down changes the picture (the keyboard reaches the game); about 55 frames a second; the audio device is open, the `AudioContext` is running and its clock advances; a click locks the pointer; leaving the lock without the game asking gives the game an Escape; no page error, dialog or `console.error`; the GRP was recognised; no error text. **Proof the blank check can fail:** it first runs on known-blank pictures (the canvas before the game starts, a one-colour and a two-colour picture count as blank; a 12-colour one does not), and `SMOKE_SABOTAGE=blank node tests/web/smoke.js` hides the canvas after the game has drawn: `FAIL the canvas is not blank (1 colours ...)` (21 passed, 1 failed). The picture is read as an element screenshot of the canvas, which works with the WebGL canvas SDL uses.

- `node tests/web/determinism.js`: **20 passed, 1 failed** (the failure is the 100 ms stall limit under machine load, below). Passing: native replay of `jfsw1.dmo` (5,999 tics, 150 s of E1L1, recorded natively on x86_64 with `tests/tools/synth_input.c`) makes the committed `jfsw1.dms` byte for byte; **wasm plays the demo with `-demosynctest` against the native `.dms`: no "Demo out of sync", ends by itself with exit 0 after 160 s; wasm `-demosyncrecord` writes a `.dms` of 53,991 bytes identical to the native one, byte for byte** (so the demo, written as `fwrite`n structs on x86_64, loads on wasm32 and the simulation agrees on every tic); the other direction: a demo recorded in the wasm build (typed by the test, 1,791 tics) plays natively to its end and the native and wasm `.dms` files are identical. **The comparison fails when it should:** wasm `-demosynctest` against the `.dms` of another demo prints `Demo out of sync - Sync Byte Number N - Iteration M`; against the right `.dms` with one byte flipped (tic 2500, function 4) it prints `Sync Byte Number 4 - Iteration 2501` and exits 0 (as code-facts says: the test looks at the output, not the status); and the byte comparison itself finds the flipped byte and tells the two demos apart. No difference between native and wasm was found, so there is no "first differing tic" to report.
- Frame time (same run, Chromium headless, 4 cores shared with other work, load average about 5): over 152 s of demo playback after the first 10 s (level loading): **median 17.1 ms (a 60 Hz display), p95 72.9 ms, p99 255 ms, max 1,426 ms** (5,341 frames); an earlier run gave median 16.9, p95 52, p99 176, max 1,047. The median meets the target; the "no stall over 100 ms" check **fails under this load** and I left it failing rather than loosening it. The game itself uses about 1.5 ms of each 16.7 ms frame (see ASYNCIFY below), so the stalls are the browser process being starved on a machine with load above its core count; a 50 s run at load 3.6 had 22 gaps over 60 ms and a maximum of 111 ms. The check needs a quiet machine to be a fair test of the port.

- `node tests/web/persist.js`: **9 passed, 0 failed.** Starts E1L1, quick-saves with F6 (a 300,459-byte `game0.sav`), quits with F10/Y (which writes `sw.cfg`), reloads the page: the save and `sw.cfg` are still there, the game runs on them (load menu drawn), no error. The control run with `?persist=0` loses both files on reload, so the check can fail.

- Native: `make -j4` green; `tests/run-headless.sh` 17 passed, 0 failed; the native demo replay is itself deterministic (test 1 of `determinism.js`). The software-only native build was not changed.

**ASYNCIFY cost**

- Size (`-O2`): `sw.wasm` 1,802,165 bytes without ASYNCIFY (a build with the yields compiled out, `-DJFBUILD_NO_ASYNCIFY`) against 2,515,133 with it: **+40 % raw, +29 % gzipped (599 KB to 774 KB)**; `sw.js` +8 KB (43 KB gzipped either way). Whole download, `sw.wasm` + `sw.js` gzipped: about 820 KB, plus the 26 MB GRP.
- Speed: over 2,700 yields in a 50 s demo run, the time from the browser waking the game to the game running again (stack rewind) was 0.0 ms median and 0.1 ms at the 99th percentile; the game's own work between yields (simulation, drawing, the palette copy) was a median 1.2 ms, 95th percentile 2.2 ms, mean 1.5 ms. I could not time a build without ASYNCIFY doing the same work, because it cannot yield and a page that never returns to the browser piles up WebGL commands and gets killed; the instrumentation overhead on the hot paths is therefore not separated from the engine's own cost, but the whole frame is under a tenth of the frame budget.
- Default settings are kept (every function that can reach a yield through an indirect call is instrumented). `-sASYNCIFY_IGNORE_INDIRECT=1` would save 366 KB raw (84 KB gzipped) but then every function reached through a pointer that can yield (the menus' custom handlers) would need listing in `ASYNCIFY_ADD`; not worth the risk for now. `ASYNCIFY_STACK_SIZE` is 262,144 bytes (the default 4,096 is too small).

**Findings and corrections**

- code-facts.md section 9 said the Makefiles would see `UNKNOWN` under `emcc` and that the `pkg-config` probes would find nothing: the real problems were the host's `sdl2-config` and GTK being picked up. Section 12 (new) lists what was found; the brief itself was right about the code.
- The brief asked for a demo "at least two minutes of movement and shooting". A recording ends when the player dies (`DemoTerm` closes the file and the recording code then crashes `sw` at the next full buffer: a native bug, code-facts section 13), and a scripted player with no eyes dies in about a minute on E1L1 at the default skill. `tests/data/jfsw1.dmo` is 150 s of E1L1 at skill 1 (`-s1`), pistol, turning and firing in place with a few steps; the player is alive at the end and killed enemies on the way (screenshots checked). Both demos and their sync files are gzip'd in `tests/data/` (about 8 KB and 25 KB for jfsw1): a `.dmo` holds inputs and a header, not game data, and `.dms` is nine sync bytes per tic.
- The emsdk in `~/.cache/jfsw-browser/emsdk` had no seeded SDL2 port in this container (Emscripten tried to download it and got 403) and I was not allowed to re-run `setup-emsdk.sh --with-ports` there, so I used a private cache (`EM_CACHE=...`, SDL2 unpacked from the `emscripten-ports` branch by hand; `scripts/build-wasm.sh` keeps `EM_CACHE` if set). A failed first run left an empty `ports/sdl2` directory in the shared cache; remove it if `--with-ports` says nothing to do.

**Fix round**

Fixes after review (all in jfsw-browser; jfbuild and jfaudiolib did not change):

1. *Settings were lost unless the player quit.* `ExitMenus()` in `src/menus.c` now calls `CONFIG_WriteSetup()` under `__EMSCRIPTEN__` (four lines), so `sw.cfg` is written whenever the player leaves the menus; it runs inside the game's own loop, never from JS. The page then syncs it (item 2). Remaining window: a setting changed and the tab closed while the menu is still open.
2. *A save made just before a reload was lost.* `web/jfsw.js`: (a) a request for an IndexedDB write while one is running is queued, not dropped (one follow-up write covers any number of requests; `onExit` waits for it); (b) the page wraps `FS.close` and writes 10 ms after the game closes a file it opened for writing in `/persist` (a save, `sw.cfg`), instead of waiting for the one-second poll (still there as a net); (c) `savegame symbols missing.txt`, a debug file the game rewrites many times per save, and `sw.log` do not trigger writes. Measured here (loaded machine): the IndexedDB write finishes about 150 ms after the file is closed, so the **remaining window is about 150 to 200 ms** (reload 50 ms after a save lost it 1 time in 2, 100 ms 0 of 2, 150 ms 1 of 3, 200 and 250 ms 0 of 4); on the old code a reload 100 ms after a save lost it 2 of 2, 150 ms 3 of 3. A browser can also kill a page's open IndexedDB transaction on a crash or power loss, which no page code can prevent.
3. *Vacuous smoke checks.* The Down check now counts pixels that change in the menu cursor's column (15,951 changed with Down, 0 without: the column does not animate); `SMOKE_SABOTAGE=nokey` presses no key and the check FAILS. The Escape check now starts E1L3, locks the pointer, and requires the game's menu to open (80,000 pixels changed) when the browser takes the pointer, and not to open (0) when the game releases it itself; `SMOKE_SABOTAGE=noesc` releases the pointer the way the game does and the check FAILS (2,218 pixels).
4. *EM_CACHE.* `setup-emsdk.sh` and `build-wasm.sh` now both put a caller's `EM_CACHE` back after `emsdk_env.sh` clears it, so `EM_CACHE=X setup-emsdk.sh --with-ports && EM_CACHE=X build-wasm.sh` seeds and uses the same cache (checked by evaluating the same expression with and without `EM_CACHE`; the shared emsdk was not re-run). `building.md` section 6.1 documents it. I rebuilt against the shared, now seeded, emsdk cache.
- Nits: the hidden-tab text above is corrected; `jfswFrameLog`/`jfswYieldLog` keep the newest 50,000 entries; `determinism.js` removes its `/tmp/jfsw-det-*` directory on exit and `smoke.js` writes a screenshot only if `SMOKE_SHOT` is set; `persist.js` now checks the restored save is loaded by the game (its name is drawn in slot 1 of the load menu: 613 light pixels there against 0 with no save); the page's error handlers end the page only for WebAssembly traps and errors from `sw.js`/`jfsw.js` (others are logged); `?files=` without `persist=0` is refused with a message; when IndexedDB is unavailable (a private window) the page now starts anyway and says that saves and settings will not be kept; code-facts section 13 notes the GRP checksum item for brief 03.

*Tests after the fix round.* `smoke.js`: 26 passed, 0 failed (the sabotage runs: `blank` 2 fail, `nokey` 2 fail, `noesc` 1 fail). `persist.js`: 15 passed, 0 failed (new: a setting changed in the sound menu survives a reload without quitting, 1.5 s after leaving the menu; a save survives a reload 250 ms after it reached its full size, 3 tries). **Against the pre-fix build** (`39a907b`, built in a separate worktree): `persist.js` gives 13 passed, 2 failed: `settings: leaving the menus wrote sw.cfg ... (null)` and `save: reloaded 250 ms after ... the save was still there in 2 of 3 tries` (that one is probabilistic on the old code: a reload that comes just after its one-second poll keeps the save; the old code lost 5 of 6 tries at 100 to 150 ms in a separate probe). `determinism.js`: 20 passed, 1 failed, as before: native and wasm `.dms` still identical (byte for byte, both directions, negatives fail as they should); the only failure is the unchanged 100 ms stall check under load (this run: median ~17 ms, p99 77.5 ms, max 392 ms; load still above the core count).

*Second fix round.* The settings check in `persist.js` was flaky: key presses into the F4 sound menu were lost, and the volume sliders turned out not to respond to key presses reliably at all. It now waits 9 s for the level to load (keys sent earlier are ignored), opens the sound menu, presses Enter on "Music" (the cursor starts there; it switches the music off), then presses Escape until the game has left the menu (it has when `sw.cfg` appears), and repeats the whole thing, at most 6 times, until the game's own `sw.cfg` says `MusicOn = 0` (the default is 1). The assertions are unchanged in strength: `sw.cfg` must show the changed setting, and after a reload without quitting it must be the same file. Result: **`persist.js` 15 passed, 0 failed in 6 runs out of 6** (earlier versions of the check failed 2 of 6, then 6 of 6 once the baseline step I tried broke the menu). Against the pre-fix build `39a907b` (rebuilt in a worktree) it gives **13 passed, 2 failed**: `settings: ... (music on: null, default 1)` and `save: ... still there in 2 of 3 tries`.

*Frame time on a quiet machine.* The coordinator measured the demo run with nothing else running (load 3.2 to 3.8, which is the test's own headless Chromium rendering the canvas in software): median 16.8 ms, p95 37.3, p99 85.9, max 303 ms over 140 s. The median is on target; **the "no stall over 100 ms" target is unverified in this container** (a software-rendered headless Chromium on 4 shared cores cannot show it) and needs a run on real hardware: `node tests/web/determinism.js` after `scripts/build-wasm.sh && make -j4` (see the play-test steps; the frame-time lines are `frame intervals` and the last three `frame times:` checks).

**Concerns**

- *Determinism x86_64 against wasm32.* 5,999 tics of E1L1 (9 sync functions each) are byte-identical on both and in both directions. That covers the RNG, player, enemy, missile and sector-object states through fighting. It does not cover floating point (the game has none in the simulation that I found), the other levels, registered-only monsters, or multiplayer. Struct layout is safe because `LONG` is `int`. The one portability bug found was the signature mismatch above; calls through function pointers cast to other signatures would trap, not warn, and no run hit one.
- *Frame time.* Measured on a loaded 4-core machine (see numbers). The game spends about 1.5 ms of each frame; the rest is waiting for `requestAnimationFrame`. The stalls come from the machine being shared (load average 4 to 6 here) and from level loading in the first seconds (which reads the 26 MB GRP out of memory in 8-tile steps with a yield each).
- *Hidden tabs.* Chrome stops `requestAnimationFrame` in a background tab and clamps timers there to at least one second (about once a minute after five minutes hidden). The yields fall back to a timer, so the game then gets a turn about once a second; with the clock capped at a quarter second per step, single player crawls at 25% of normal speed or less (it does not run at 10 frames per second). Nothing is lost: it is a pause. Brief 04 will face the real problem: in a lockstep game a hidden peer delivers its inputs about once a second, so everyone else waits for it. Options for 04: a lobby state that tells the others a peer is away, a Web Worker or an audio-clock driven loop (neither is throttled as hard), or dropping the peer.
- *Merging with brief 01.* The `EMSCRIPTEN` block in `jfbuild/Makefile` swaps `mmulti.c` for `mmulti_null.c`. When brief 04 builds the vnet-backed `mmulti` for the browser it should replace that line, and brief 01's `-D_POSIX_C_SOURCE` for `ext/vnet` goes into the same `ifeq`. `Makefile.emscripten` has its own link flags; vnet's browser backend needs `-lwebsocket.js`. Brief 01's test hooks in `sync.c` / `game.c` are untouched here.
- `?data=` loading needs the GRP from the same origin or CORS headers (Q2).
- Pointer lock and Escape were checked with synthetic events (a headless browser cannot press the real Escape); the real behaviour is in the play-test.
- The "Click to start" click also counts as the first click on the picture, so the first click may also be a mouse click in the game's menu.

**Play-test steps (Arch Linux, pacman)**

```
sudo pacman -S --needed base-devel git unzip python nodejs npm go   # go is not needed here
git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser
cd jfsw-browser
scripts/setup-emsdk.sh                    # downloads Emscripten 6.0.13 (about 400 MB) into ~/.cache/jfsw-browser/emsdk
scripts/build-wasm.sh                     # about 3 minutes the first time (it builds Emscripten's libraries and SDL2)
scripts/fetch-test-data.sh                # the shareware data, testdata/swshare.grp (a 3D Realms download, verified)
cp testdata/swshare.grp build-wasm/       # the page fetches ./swshare.grp
cd build-wasm && python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/` in Chromium or Firefox. Click "Click to start". Keys as in the desktop game: arrows move and turn, Ctrl fires, Space uses, 1 to 9 pick weapons, Escape opens the menu, F6 quick saves, F10 quits (shareware then shows an advert page: press a key). Click the picture to capture the mouse; Escape releases it and opens the menu; click again to capture. Choose New Game, "Enter the Wang", a skill, and play Seppuku Station: check keyboard, mouse look, sound effects (there is no music yet) and that it feels smooth. Then save (F6), reload the page and load it (F3). To measure frame times on your hardware (the tests need Node.js and Playwright with a Chromium: `npm i playwright && npx playwright install chromium` on your own machine): `scripts/build-wasm.sh && make -j4 && node tests/web/determinism.js` (takes about 12 minutes; prints `frame intervals (ms)` with median, p95, p99 and max, and passes the stall check if the maximum is under 100 ms). Report anything that freezes (the page should always show a message when the game ends or crashes).

Things only a person can check (a headless browser cannot):

- **Real Escape**, in Chrome and Firefox, while the mouse is captured: it should release the mouse and open the menu once (not twice: watch for the menu opening and closing at once if a browser also delivers the key after `pointerlockchange`); then a click should capture the mouse again, and that click should not also select a menu item.
- **Firefox keyboard**: arrows, Ctrl, Shift, Space, number keys and F-keys all do what they do in Chrome (SDL reads `code` and `keyCode`; Firefox differs on some keys).
- **Pointer lock**: does the first click after Escape grab the pointer and reach the game as a mouse button too?
- **Audio latency**: the game asks for 4096-sample buffers and SDL resamples to the browser's rate, so about 90 ms: does shooting feel late?
- **A private window**: IndexedDB can be unavailable there. The page now starts and says saves and settings will not be kept; check the message shows and the game plays.
- **Menu sliders**: in Options, Sound (F4), do Left and Right move the volume sliders? While fixing the settings test, the arrow keys never moved the volume slider in headless Chromium (Enter on a toggle did work), so this may be a real input problem in the browser build.
- **Ctrl+W**: Ctrl is the fire key, so Ctrl+W (or Ctrl+Tab) closes the tab. There is no way to stop that from a page; just see whether it bites.

If the SDL2 download is blocked on your network, see `building.md` section 6.1.

### Coordinator verification and merge

- Read the fix-round diffs. The only game-source change is `ExitMenus()` calling `CONFIG_WriteSetup()` under `__EMSCRIPTEN__`, which reads settings and writes `sw.cfg` and touches no game state. Also read the page's sync queue and `FS.close` hook in `web/jfsw.js`: a request during a write is queued, several share one follow-up write, and a failed write doesn't block the queue.
- On a clean wasm and native build with nothing else running: `tests/run-headless.sh` 17/0, `smoke.js` 26/0, `persist.js` 15/0. The settings check was flaky (failed 2 of 4 runs: the volume key presses were lost); after the second small fix it passed 6 of 6 for the implementer and 2 of 2 for the coordinator. `determinism.js` 20/1: native and wasm `.dms` identical in both directions; the only failure is the stall check (median 16.8 ms, p95 37.3, p99 85.9 to 87.2, max 303 to 337 ms, load 2.7 to 3.5 from the test's own software-rendering Chromium). It is left failing and unverified here; it needs a run on real hardware (play-test above).
- **Merged with brief 01** (`claude` merged into this branch, `8d43fa8` and `8a3c9c8`): the forks' `claude` branches got this brief's jfbuild (`27edad9`, a clean merge on top of 01's) and jfaudiolib (`a9d4ecb`) branches, and the submodules point there. `code-facts.md`: brief 01's section stays §12, this brief's is §13. On the combined tree: the wasm build, smoke 26/0, persist 15/0 and determinism 20/1 (as above), `run-headless` 17/0, `fetch-test-data` 28/0, and the native `make test` (see below).
- **Two things the merge showed:**
  - The stale-library trap (`bugs.md` L9) bit: after the submodule pointer moved, `make` linked the old `jfbuild/libengine.a` (`undefined reference to mmulti_vnet_errormsg`). `make veryclean && make -j4` fixed it.
  - Brief 01's UDP comparison test chose its baseline as the merge-base with `claude`, which broke once 01 was on `claude`. It was fixed on `browser/01b-test-baseline`, merged into `claude` first (see 01's Outcome).
- Reviewed by an independent read-only reviewer (verdict: merge after fixes; no blocking issues; all four should-fix items and the nits addressed). Merged into `claude` with `--no-ff`. Status: **done (play-test pending)**.
