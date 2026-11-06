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
| jfsw-browser | `browser/02-emscripten-port` | see `git log` (last: `e2971ab`) |
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
- The brief asked for a demo "at least two minutes of movement and shooting". A recording ends when the player dies (`DemoTerm` closes the file and the recording code then crashes `sw` at the next full buffer: a native bug, section 12), and a scripted player with no eyes dies in about a minute on E1L1 at the default skill. `tests/data/jfsw1.dmo` is 150 s of E1L1 at skill 1 (`-s1`), pistol, turning and firing in place with a few steps; the player is alive at the end and killed enemies on the way (screenshots checked). Both demos and their sync files are gzip'd in `tests/data/` (about 8 KB and 25 KB for jfsw1): a `.dmo` holds inputs and a header, not game data, and `.dms` is nine sync bytes per tic.
- The emsdk in `~/.cache/jfsw-browser/emsdk` had no seeded SDL2 port in this container (Emscripten tried to download it and got 403) and I was not allowed to re-run `setup-emsdk.sh --with-ports` there, so I used a private cache (`EM_CACHE=...`, SDL2 unpacked from the `emscripten-ports` branch by hand; `scripts/build-wasm.sh` keeps `EM_CACHE` if set). A failed first run left an empty `ports/sdl2` directory in the shared cache; remove it if `--with-ports` says nothing to do.

**Concerns**

- *Determinism x86_64 against wasm32.* 5,999 tics of E1L1 (9 sync functions each) are byte-identical on both and in both directions. That covers the RNG, player, enemy, missile and sector-object states through fighting. It does not cover floating point (the game has none in the simulation that I found), the other levels, registered-only monsters, or multiplayer. Struct layout is safe because `LONG` is `int`. The one portability bug found was the signature mismatch above; calls through function pointers cast to other signatures would trap, not warn, and no run hit one.
- *Frame time.* Measured on a loaded 4-core machine (see numbers). The game spends about 1.5 ms of each frame; the rest is waiting for `requestAnimationFrame`. The stalls come from the machine being shared (load average 4 to 6 here) and from level loading in the first seconds (which reads the 26 MB GRP out of memory in 8-tile steps with a yield each).
- *Hidden tabs.* `requestAnimationFrame` stops in a background tab; the game then runs at 10 frames per second (100 ms fallback) and the clock cap makes it slow down rather than skip. In a lockstep network game (brief 04) a hidden peer will stall the others; that needs a policy there.
- *Merging with brief 01.* The `EMSCRIPTEN` block in `jfbuild/Makefile` swaps `mmulti.c` for `mmulti_null.c`. When brief 04 builds the vnet-backed `mmulti` for the browser it should replace that line, and brief 01's `-D_POSIX_C_SOURCE` for `ext/vnet` goes into the same `ifeq`. `Makefile.emscripten` has its own link flags; vnet's browser backend needs `-lwebsocket.js`. Brief 01's test hooks in `sync.c` / `game.c` are untouched here.
- `?data=` loading needs the GRP from the same origin or CORS headers (Q2).
- Pointer lock and Escape were checked with synthetic events (a headless browser cannot press the real Escape); the real behaviour is in the play-test.
- The "Click to start" click also counts as the first click on the picture, so the first click may also be a mouse click in the game's menu.

**Play-test steps (Arch Linux, pacman)**

```
sudo pacman -S --needed base-devel git unzip python nodejs npm go   # go is not needed here
git clone --recurse-submodules -b browser/02-emscripten-port https://github.com/VenKamikaze/jfsw-browser
cd jfsw-browser
scripts/setup-emsdk.sh                    # downloads Emscripten 6.0.13 (about 400 MB) into ~/.cache/jfsw-browser/emsdk
scripts/build-wasm.sh                     # about 3 minutes the first time (it builds Emscripten's libraries and SDL2)
scripts/fetch-test-data.sh                # the shareware data, testdata/swshare.grp (a 3D Realms download, verified)
cp testdata/swshare.grp build-wasm/       # the page fetches ./swshare.grp
cd build-wasm && python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/` in Chromium or Firefox. Click "Click to start". Keys as in the desktop game: arrows move and turn, Ctrl fires, Space uses, 1 to 9 pick weapons, Escape opens the menu, F6 quick saves, F10 quits (shareware then shows an advert page: press a key). Click the picture to capture the mouse; Escape releases it and opens the menu; click again to capture. Choose New Game, "Enter the Wang", a skill, and play Seppuku Station: check keyboard, mouse look, sound effects (there is no music yet) and that it feels smooth. Then save (F6), reload the page and load it (F3). Report anything that freezes (the page should always show a message when the game ends or crashes).

If the SDL2 download is blocked on your network, see `building.md` section 6.1.
