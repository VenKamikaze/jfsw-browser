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

_Not started._
