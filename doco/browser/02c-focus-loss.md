# 02c: A refused pointer lock shows the fatal overlay (L24)

## Goal

Losing focus never ends the game on the page, in any browser. A pointer-lock request that the browser refuses is logged, not shown as a crash. The lock comes back the way it normally does: on Alt+Tab back, or on the next click on the canvas. A real failure in the game (a wasm trap, an error in the game's own scripts) still shows the overlay.

The user found this on 13 Nov 2026, in a Firefox play-test of a network game (Edge hosting, Firefox joining). Alt+Tab in Firefox showed "Something went wrong: The document is not focused.. Reload the page to try again." The game and the network game kept running under the overlay.

## Dependencies

Brief 02 (the page, `web/jfsw.js`, `smoke.js`) and 02's smoke fixes (the `exitPointerLock` wrapper and the mouse-event filter, in 02's Outcome, last section).

## Read first

- [`README.md`](README.md); [`code-facts.md`](code-facts.md) (the page and SDL input); 02's Outcome (the unlocked-mouse fix); [`building.md`](building.md) (running the browser tests).
- `web/jfsw.js`:
  - `fromGame()` and the `error`/`unhandledrejection` handlers (about lines 318-331);
  - `finish()` and `describe()`;
  - the pointer-lock code (about lines 665-695).
- `jfbuild/src/sdlayer2.c`: the `SDL_WINDOWEVENT` focus branch (about line 1510) and `grabmouse()` (about line 660).
- `tests/web/smoke.js`.
- The coordinator's investigation, in the scratchpad (not in the repo):
  - its scripts and logs are in `ff-investigate/`;
  - its prototype fix is `ff-investigate/ff-fix/jfsw.js`, after the `exitPointerLock` wrapper;
  - its findings are summarised below.

## What is known (from the investigation; check it)

1. **The error.** It is an `unhandledrejection`: a `DOMException` with name `WrongDocumentError` and message "The document is not focused." It comes from the promise `canvas.requestPointerLock()` returns. Emscripten's `requestPointerLock` helper in `sw.js` drops that promise.
2. **Firefox stack.** In Firefox (160) the DOMException's stack runs through `sw.js`, so `fromGame()` takes it for the game's own error and `finish()` shows the fatal overlay. Afterwards `running` is false, so later rejections are logged as "not from the game".
3. **Who asks while unfocused.** It is `sdlayer2.c:1515`, in the focus branch.
   - Under some window managers, Firefox's Alt+Tab away sends blur, focus, blur within about 2 ms.
   - The game handles the queued FOCUS_GAINED after the document has lost focus again, and calls `SDL_SetRelativeMouseMode(SDL_TRUE)`.
   - Emscripten asks at once rather than deferring, because `navigator.userActivation.isActive` is true after a recent click.
   - The same request comes at start-up (`setvideomode` → `grabmouse(1)`) when the document is unfocused: always in headless Firefox, and possibly after `data.js`'s persistent-storage prompt takes focus.
4. **The game is not dead.** Under the overlay the wasm keeps stepping, the network game's `-testdump` tics stay in step, and the lock even comes back on refocus.
5. **Chromium (Edge).** Chromium also rejects an unfocused request, but its DOMException has no stack, so the page only logs it. Some of Chromium's synchronous refusals do carry a stack, for example "Too many pointer lock requests in a short window of time", so the same overlay is possible there in principle.
6. **The prototype fix works.**
   - It wraps `canvas.requestPointerLock` so the returned promise always gets a rejection handler that logs "pointer lock refused: …". Emscripten looks the method up on the canvas each time it asks, so wrapping the canvas is enough.
   - Firefox, real Alt+Tab under Xvfb with openbox, in single player and in a network game: no overlay, the game keeps running, and the tics stay in step.
   - A click locks the pointer again.
   - A real trap (`Module._free(0xFFFFFFF0)`) is still fatal in both browsers.

## In scope

1. **Handle the refusal where it is made:** wrap `requestPointerLock`, next to the `exitPointerLock` wrapper. Keep `fromGame()` as strict as it is. Say in a comment why a refused lock is normal.
   - Check whether anything else in the page or in `sw.js` drops a pointer-lock or fullscreen promise the same way, for example `requestFullscreen` or `exitPointerLock`'s promise. Handle those the same way if they exist.
   - Check whether the canvas is the only element Emscripten asks for the lock on.
2. **The message's doubled full stop** ("focused.. Reload"), from `describe()` plus `'. Reload…'`. Fix it for every message built that way.
3. **The lock coming back:**
   - Check, and test where you can, that after a refused request the next click on the canvas asks again and gets the lock.
   - Check that the game's mouse look then works. 02's filter passes mouse events to SDL only while SDL knows the lock is held, so check that SDL's idea of the lock and the page's stay in step after a refusal.
4. **Start-up.** A refused first request (the document unfocused when Start is clicked, or after the storage prompt) must not stop the game either. Check that the first click on the canvas then locks.

## Out of scope

- Changing SDL, Emscripten's library code or `sdlayer2.c`. The page-side fix covers every caller.
- Other focus behaviour, such as pausing the game when unfocused. The original game doesn't pause, and in a network game it must not.

## Acceptance criteria

1. In Firefox, losing focus or a refused lock never shows the overlay. The game keeps running, and a network game keeps every machine in step.
2. In Chromium, the same holds.
3. The pointer lock comes back on the next click on the canvas, and mouse look works.
4. A real trap or an error in the game's scripts is still fatal, with the overlay in both browsers.
5. No regression: `smoke.js`, `persist.js`, `data.js`, `grptable.js`, `determinism.js` and `netplay.js` (full) pass. The known 100 ms stall check is excepted, and so is persist's known "reload 250 ms after a save" window under load. If either of those fails, rerun it and report both runs.

## Tests

1. **Chromium, in `smoke.js` or a new `tests/web/focus.js`; deterministic, required.**
   - Before the page loads, replace `Element.prototype.requestPointerLock` with a counter that returns `Promise.reject(e)`, where `e` is a `DOMException('The document is not focused.', 'WrongDocumentError')`.
   - Give `e` a Firefox-like stack through `sw.js`, and say how; the investigation's `ff-investigate/scripts/pwsim.js` is a sketch.
   - Start the game and click the canvas.
   - Check that:
     - the game stays running;
     - frames keep coming;
     - no overlay appears;
     - a "pointer lock refused" warning is logged;
     - the click asks again.
   - Also check the real path: when a request later succeeds, the lock is held and SDL sees mouse motion.
   - **Mutation:** without the wrapper the test fails with the user's message.
2. **A real trap is still fatal.** Cover it if no test does already: a test-only way to make the wasm trap after start, then check the overlay appears.
3. **Firefox, optional but wanted (the user plays in Firefox):**
   - Add a script that fetches a stock Firefox into a cache outside the repo (as `setup-emsdk.sh` does for emsdk).
   - Add `tests/web/firefox.js`, using `puppeteer-core` over WebDriver BiDi. Headless Firefox never has a focused document, so its start-up request is always refused. The test: start the game, check there is no overlay and that frames keep coming. Add a network game through a local relay if it is cheap.
   - It is not part of the default runs. It says clearly that it was not run when no Firefox is present; that is not a pass.
   - Document it in `building.md`.
   - **Mutation:** without the fix it fails.
   - Pin the Firefox version you used, if you can.
   - Add `puppeteer-core` to the test dependencies the same way the repo already handles Node test packages. If it has none, say how you installed it.
4. **Real Alt+Tab** (Xvfb, openbox, xdotool) is too timing-dependent for a test. Record in the Outcome how it was checked by hand.

## Notes

- **Repos touched:** jfsw-browser only.
- **Branch:** `browser/02c-focus-loss` from `claude`. **Work in your own git worktree** (`git worktree add`): `/home/user/jfsw-browser` is checked out on brief 06's branch, and another agent is working there. Build wasm in your worktree. The emsdk is shared, in `~/.cache/jfsw-browser/emsdk`.
- **Ports:** avoid the ones brief 06's agent is using (48301 to 48303 were in use); say which ones you use.
- **Records to update:**
  - `bugs.md`: a new L24, our port's bug, not the original game's;
  - 02's Outcome or this brief's Outcome;
  - `code-facts.md` (the pointer-lock note);
  - `building.md` (any new test or script).
- **Play-test steps for the user** in the Outcome, on Arch, with Firefox from `pacman`:
  - host in Edge or Chromium, join in Firefox;
  - Alt+Tab away and back several times, in the lobby, in the menus and in play;
  - click to get the mouse back;
  - then the other way round, with Firefox hosting.
- **Placeholder host names only.**

## Outcome

Implemented on `browser/02c-focus-loss` (jfsw-browser only; no change to the game, SDL, Emscripten's library code or `sdlayer2.c`). Status: review.

**What landed** (`web/jfsw.js` unless said otherwise)

- *The fix, at the source.* `quietRefusal()`, next to the `exitPointerLock` wrapper, replaces `canvas.requestPointerLock` with a function that calls the browser's and gives the returned promise a rejection handler that logs `pointer lock refused: <message>` (a synchronous throw is logged the same way). The comment says why a refusal is normal: nothing is lost, SDL and the page both still see the pointer as free (no `pointerlockchange` came), and SDL asks again on the next click on the canvas or the next focus. `fromGame()` is unchanged.
- *The other dropped promises* (checked in `sw.js`): the canvas is the only element Emscripten asks for the lock (SDL's `#canvas`; `Browser`'s `Module.canvas`, used only with `Module.elementPointerLock`, unset, or after `Browser.requestFullscreen`, never called). Fullscreen: `JSEvents_requestFullscreen` (on the canvas) and `emscripten_exit_fullscreen` (on the document) drop their promises the same way; the game never asks for fullscreen (`sdlayer2.c` keeps the canvas a window), but both are handled alike. `exitPointerLock` returns nothing. **`AudioContext.prototype.resume`** is handled too: SDL's audio calls it on every callback while the context is suspended and drops the promise; when the game closes its audio device (at the end of a game, or to reopen it after a sound setting changed) every pending one is rejected with "Closed before resume completed". The Firefox network game showed 130 to 195 of them at the end of every game, each an uncaught page error.
- *The doubled full stop.* `sentence()` ends a description with exactly one full stop; the three messages built as description plus ". Reload ..." use it ("Something went wrong: ..." twice, "The game crashed: ...").
- *A trap or a script error in the game's frame said "The game has ended."* (found by the new test, not by the investigation). Emscripten's `callUserCallback()` (the ASYNCIFY rewind) catches the error, exits in its `finally` with the last status (0), and only then lets the error reach the page. The exit's message came first whenever saving took no time (`?persist=0`, as in every test), and the error was then logged as "not from the game". Now an error from the game within 250 ms of an exit replaces "The game has ended." (`gameError()`, `finish(..., replace)`; bugs.md L32). A `DOMException` is excluded once the game has exited, also while the exit's save runs and `running` is still true, and so is Emscripten's `ExitStatus`: it is a browser API refusing something, not the game failing (without that, the audio refusals above turned the clean end of a Firefox network game into "Something went wrong: Closed before resume completed.", which the mutation below shows). With persistence on (every real page) the save at the exit had delayed the message enough already, so players saw the right message before too.
- *Test hook:* `window.jfswTest.unhandledPointerLock = true` (test mode only) leaves the lock's promise unhandled, as before the fix, for the sabotage runs.
- *Tests:* `tests/web/focus.js` (new, Chromium, required), `tests/web/firefox.js` and `scripts/setup-firefox.sh` (new, optional). `tests/web/lib.js`: `pixelDiff()` split out of `changedPixels()`. `tests/web/netplay.js`: `NETPLAY_PORT_BASE` moves its four ports (this run used 48500 to 48503, away from brief 06's). No check was changed.
- *Docs:* `bugs.md` L24 (fixed), `code-facts.md` §20 (and §9's mouse line), `building.md` §6.4 (the two tests, the script) and §6.5 (the port knob), the README status row.

**Checked against the brief's "What is known"**: all six points held. Two additions: the second rejection in the user's console was "not from the game" because `finish()` had set `running` false, not because its stack lacked `sw.js`; and Chromium's own refusal of an unfocused request has no stack, while its synchronous ones do (a "Too many pointer lock requests" refusal had one in a test page; not reproduced in the game).

**Tests**

1. `tests/web/focus.js` (Chromium, port 48104, about 1 minute). Before the page loads, `Element.prototype.requestPointerLock` is replaced by a counter that returns `Promise.reject(e)`, `e` a `DOMException('The document is not focused.', 'WrongDocumentError')`, and fires `pointerlockerror`. **The Firefox-like stack:** `Object.defineProperty(e, 'stack', { value: new Error().stack })`; that Error is made inside the stub, which Emscripten's helper in `sw.js` calls, so its stack is the caller's as Firefox's is; the test checks that it names `sw.js`. In a quiet level (`-level3 -s1`) it checks: the start-up request was refused; the game is running, no overlay, no doubled full stop; frames keep coming; "pointer lock refused: The document is not focused." is logged; no unhandled rejection; a click on the canvas asks again; still no overlay and no lock; moving the mouse over the picture does not turn the view (SDL and the page agree that the pointer is free). Then the stub lets requests through: a click locks the pointer and moving the mouse turns the view (226,167 pixels changed, 0 by themselves: SDL sees the lock and the motion). Then a real focus loss: another page comes to the front (the lock is lost, no overlay) and goes; a click locks again and frames keep coming. Part 2: a wasm trap (`Module._free(HEAPU8.length + 4096)`, an out-of-bounds access) and an `Error` thrown from the game's script, both inside the game's frame (a getter on `Module.jfswShowframes`, which `sdlayer2.c`'s EM_JS in `sw.js` reads for every picture), each show the overlay with "Something went wrong: ... Reload the page to try again." and one full stop. It uses the full Chromium build headless (`channel: 'chromium'`): Playwright's headless shell reports no movement under pointer lock and crashes its renderer on a wasm trap (`code-facts.md` §20).
2. `tests/web/firefox.js` (stock Firefox 160.0 from `scripts/setup-firefox.sh`, puppeteer-core 25.17.0 over WebDriver BiDi, headless; ports 48400 to 48402; about 2.5 minutes; not in the default runs; "NOT RUN", status 3, without a Firefox). Headless Firefox never gives the page the focus, so every request is refused for real. Single player (in a level): refused at start-up, logged, running, no overlay, frames keep coming, a click asks again and is refused, no unhandled rejection or page error. A trap in the game's frame: overlay. A network game (Chromium hosts by `?host=2`, Firefox joins by `?join=CODE`, local relay, 400 tics with `-testdump`): Firefox refused the request, showed no overlay, both games ended by themselves (exit 0) and agree on every tic.
3. A real Alt+Tab: by hand only (below).

**Results** RESULTS_PLACEHOLDER

**Mutations** (each run against a build that differs only in `jfsw.js`)

| Mutation | Run | What failed |
|---|---|---|
| the page before the fix (this branch's base, `fdf3800`) | `focus.js` | 17 of 22: "Something went wrong: The document is not focused.. Reload the page to try again." (the user's message, doubled full stop and all) from the start-up refusal; the trap and the script error said "The game has ended." |
| the same | `firefox.js` | 8 of 14: the overlay with the user's message in the single player game and in the network game; uncaught "Closed before resume completed" page errors |
| `FOCUS_SABOTAGE=unhandled` (the lock's promise left unhandled) | `focus.js` | 12 of 22, with "Something went wrong: The document is not focused. Reload the page to try again." |
| `FIREFOX_SABOTAGE=unhandled` | `firefox.js` | 8 of 14, the same message |
| no handler on `AudioContext.prototype.resume` | `firefox.js` | 1 of 14: 147 uncaught "Closed before resume completed" page errors at the end of the network game |
| that, and a `DOMException` allowed to replace "The game has ended." | `firefox.js` | 2 of 14: the network game's clean end shown as "Something went wrong: Closed before resume completed." |

**By hand: a real Alt+Tab** MANUAL_PLACEHOLDER

**Play-test for the user (Arch, Firefox from `pacman`)**

1. `sudo pacman -S --needed firefox` (and Chromium or Edge for the other player). Serve the build as in `building.md` §6.3, with a relay in `config.js` (§6.6), or use the deployed site.
2. **Edge or Chromium hosts, Firefox joins.** Host with `?host=2` in Edge, open the invite link in Firefox (a private window, as in the report, and once in a normal one), click to join.
3. In the lobby, then in the menus (Escape), then in play: **Alt+Tab away and back** several times each; once while firing (click, then Alt+Tab at once), once while holding a movement key. Expected every time: no "Something went wrong" overlay; the game goes on in both browsers (the host still sees the Firefox player move and the game does not stall); on return the mouse is either captured again by itself or after **one click on the picture**, and mouse look works.
4. Also: Alt+Tab away for 30 seconds or more, then back; and click Start and Alt+Tab away straight away, before the game has drawn.
5. **The other way round:** Firefox hosts (`?host=2`), Edge or Chromium joins; repeat 3 and 4 on both.
6. Firefox's console (Ctrl+Shift+K) may show "Request for pointer lock was denied because the document is not focused" and "pointer lock refused: The document is not focused." as warnings. Any "Something went wrong" overlay, or "unhandled rejection" line, is a failure: note what was done just before.
7. At the end of a game (quit, or the host ends it) the page should say "The game has ended." (or why it ended), not "Something went wrong".

**Concerns**

CONCERNS_PLACEHOLDER

### State (in progress)

Written when the session ran low; the Outcome above has placeholders (RESULTS_PLACEHOLDER, MANUAL_PLACEHOLDER, CONCERNS_PLACEHOLDER) still to fill.

- **Done and pushed:** `fa2ed49` (the fix in `web/jfsw.js`, `tests/web/focus.js`, `lib.js` `pixelDiff()`), `d8e530e` (`tests/web/firefox.js`, `scripts/setup-firefox.sh`, `AudioContext.prototype.resume` handler, DOMException excluded from the post-exit replacement, `NETPLAY_PORT_BASE`, `bugs.md` L24, `code-facts.md` §20, `building.md`). This commit adds this Outcome draft and the README status `review`.
- **Uncommitted:** nothing (this commit has everything).
- **Results so far** (final code; the container was shared with two other agents' network tests, load 2.6 to 16): `focus.js` 22/0 (8 runs: 7 clean, 1 unexplained single failure early on, not seen again); `firefox.js` (Firefox 160.0) 14/0; `data.js` 172/0; `grptable.js` 8/0; `smoke.js` 29/0 at load 2.7 (earlier at load 8 to 16: one screenshot timeout, one "Up moves it up" 28/1, one 29/0, one screenshot timeout); `persist.js` 15/0 at load 3.7 (14/1 at load 9: the known 250 ms reload window); `determinism.js` 19/2 at load 9 to 11 (the 100 ms stall check and the median frame time; rerun at low load not done); `netplay.js` full (`NETPLAY_PORT_BASE=48500`, 35 minutes, load 5 to 12): 1277 passed, 8 failed, all "the host left the game" in two heavy games (`impaired` three browsers, 83 s instead of about 30; `level-exit` browser+native); `netplay.js impaired` rerun alone: **39/0**.
- **Mutations done** (table above): old page, `FOCUS_SABOTAGE`/`FIREFOX_SABOTAGE`, no audio handler, audio + DOMException: all fail as listed.
- **Left:** rerun `NETPLAY_PORT_BASE=48500 node tests/web/netplay.js level-exit` and `node tests/web/determinism.js` at low load (the old build is in the scratch directory `ff-investigate/build-wasm-before` for a comparison if they fail again); the manual real Alt+Tab check of the final build (scripts in the scratch directory `ff-investigate/scripts/probe.js` and `net.js`, `xvfb-run` + `runx.sh` with openbox; the prototype was checked, the final build not yet); fill the three placeholders; report.
- **Running processes:** none (the rerun script and its `level-exit` run were stopped).
