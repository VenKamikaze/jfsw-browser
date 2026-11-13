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
- *A trap or a script error in the game's frame said "The game has ended."* (found by the new test, not by the investigation). Emscripten's `callUserCallback()` (the ASYNCIFY rewind) catches the error, exits in its `finally` with the last status (0), and only then lets the error reach the page. The exit's message came first whenever saving took no time (`?persist=0`, as in every test), and the error was then logged as "not from the game". Now an error from the game within 250 ms of an exit replaces "The game has ended." (`gameError()`, `finish(..., replace)`; bugs.md L33). A `DOMException` is excluded once the game has exited, also while the exit's save runs and `running` is still true, and so is Emscripten's `ExitStatus`: it is a browser API refusing something, not the game failing (without that, the audio refusals above turned the clean end of a Firefox network game into "Something went wrong: Closed before resume completed.", which the mutation below shows). With persistence on (every real page) the save at the exit had delayed the message enough already, so players saw the right message before too.
- *Test hook:* `window.jfswTest.unhandledPointerLock = true` (test mode only) leaves the lock's promise unhandled, as before the fix, for the sabotage runs.
- *Tests:* `tests/web/focus.js` (new, Chromium, required), `tests/web/firefox.js` and `scripts/setup-firefox.sh` (new, optional). `tests/web/lib.js`: `pixelDiff()` split out of `changedPixels()`. `tests/web/netplay.js`: `NETPLAY_PORT_BASE` moves its four ports (this run used 48500 to 48503, away from brief 06's). No check was changed.
- *Docs:* `bugs.md` L24 (fixed) and L33 (new, fixed), `code-facts.md` §20 (and §9's mouse line), `building.md` §6.4 (the two tests, the script) and §6.5 (the port knob), the README status row.

**Checked against the brief's "What is known"**: all six points held. Two additions: the second rejection in the user's console was "not from the game" because `finish()` had set `running` false, not because its stack lacked `sw.js`; and Chromium's own refusal of an unfocused request has no stack, while its synchronous ones do (a "Too many pointer lock requests" refusal had one in a test page; not reproduced in the game).

**Tests**

1. `tests/web/focus.js` (Chromium, port 48104, about 1 minute). Before the page loads, `Element.prototype.requestPointerLock` is replaced by a counter that returns `Promise.reject(e)`, `e` a `DOMException('The document is not focused.', 'WrongDocumentError')`, and fires `pointerlockerror`. **The Firefox-like stack:** `Object.defineProperty(e, 'stack', { value: new Error().stack })`; that Error is made inside the stub, which Emscripten's helper in `sw.js` calls, so its stack is the caller's as Firefox's is; the test checks that it names `sw.js`. In a quiet level (`-level3 -s1`) it checks: the start-up request was refused; the game is running, no overlay, no doubled full stop; frames keep coming; "pointer lock refused: The document is not focused." is logged; no unhandled rejection; a click on the canvas asks again; still no overlay and no lock; moving the mouse over the picture does not turn the view (SDL and the page agree that the pointer is free). Then the stub lets requests through: a click locks the pointer and moving the mouse turns the view (226,167 pixels changed against 4,278 to 4,303 by themselves over the same time: SDL sees the lock and the motion; the screenshots are compared only at the end, because the comparison's own page takes the focus and the lock). Then a real focus loss, starting with the lock held: another page comes to the front (the lock is lost, no overlay) and goes; a click locks again and frames keep coming. Every pixel check has a still baseline measured just before it, and frames are counted over 3 s (more than 20 a second). Part 2: a wasm trap (`Module._free(HEAPU8.length + 4096)`, an out-of-bounds access) and an `Error` thrown from the game's script, both inside the game's frame (a getter on `Module.jfswShowframes`, which `sdlayer2.c`'s EM_JS in `sw.js` reads for every picture), each show the overlay with "Something went wrong: ... Reload the page to try again." and one full stop; the trap also with persistence on. It uses the full Chromium build headless (`channel: 'chromium'`): Playwright's headless shell reports no movement under pointer lock and crashes its renderer on a wasm trap (`code-facts.md` §20).
2. `tests/web/firefox.js` (stock Firefox 160.0 from `scripts/setup-firefox.sh`, puppeteer-core 25.17.0 over WebDriver BiDi, headless; ports 48400 to 48402; about 1 minute; not in the default runs; "NOT RUN", status 3, without a Firefox). Headless Firefox never gives the page the focus, so every request is refused for real. Single player (in a level): refused at start-up, logged, running, no overlay, frames keep coming, a click asks again and is refused, no unhandled rejection or page error. A trap in the game's frame: overlay, with `?persist=0` and with persistence on. A network game (Chromium hosts by `?host=2`, Firefox joins by `?join=CODE` with persistence on, local relay, 400 tics with `-testdump`): Firefox refused the request, showed no overlay, both games ended by themselves (exit 0), Firefox's with "The game has ended.", they agree on every tic, and Firefox's audio refusals at the end are at most two console lines.
3. A real Alt+Tab: by hand only (below).

**Results** (final tree `e2bcd7d` plus this Outcome: `claude` merged in, wasm and native rebuilt; one test at a time on a machine nobody else was using, load 0.8 to 4.4)

| Test | Result | Time, load |
|---|---|---|
| `focus.js`, three runs | **24 passed, 0 failed** each | 47 s each, 0.8 to 1.2 |
| `firefox.js` (Firefox 160.0, puppeteer-core 25.17.0) | **16 passed, 0 failed** | 64 s, 1.2 to 2.2 |
| `smoke.js` | **29 passed, 0 failed** | 37 s, 2.2 to 3.0 |
| `persist.js` | **15 passed, 0 failed** | 93 s, 3.0 to 3.4 |
| `data.js` | **172 passed, 0 failed** | 114 s, 3.4 |
| `grptable.js` | **8 passed, 0 failed** | 1 s |
| `determinism.js` | **20 passed, 1 failed**, twice: the known "no stall over 100 ms" check (max 337 ms, p99 89.1; rerun: max 182 ms, p99 72.5, median 16.8 ms) | 11 minutes each, 2.8 to 3.3 |
| `netplay.js` (every scenario but `lag-matrix` and `old-new`, default ports) | **1286 passed, 0 failed** | 30 minutes, 2.8 to 4.4 |
| `make test GAME_RUNS=1` | **8 PASS**, exit 0 (draw check 16/0) | 9.3 minutes, 3.7 to 1.1 |

The first round's runs, on a machine shared with two other agents' network tests (load 2.6 to 16), are in the fix-round section below.

**Mutations** (each run against a build that differs only in `jfsw.js`; counts for the final tests)

| Mutation | Run | What failed |
|---|---|---|
| the page before the fix (this branch's base, `fdf3800`) | `focus.js` | 17 of 24: "Something went wrong: The document is not focused.. Reload the page to try again." (the user's message, doubled full stop and all) from the start-up refusal; the trap and the script error with `?persist=0` said "The game has ended." (the trap with persistence on passed: bugs.md L33) |
| the same | `firefox.js` | 9 of 16: the overlay with the user's message in the single player game and in the network game; 128 uncaught page errors there ("Closed before resume completed") |
| `FOCUS_SABOTAGE=unhandled` (the lock's promise left unhandled) | `focus.js` | 12 of 24, with "Something went wrong: The document is not focused. Reload the page to try again." |
| `FIREFOX_SABOTAGE=unhandled` | `firefox.js` | 9 of 16, the same message |
| no handler on `AudioContext.prototype.resume` | `firefox.js` | 1 of 16: 128 uncaught "Closed before resume completed" page errors at the end of the network game; its end still "The game has ended." |
| that, and `gameError()` testing `running` before the refusal (the order before the fix round) | `firefox.js` | 2 of 16: the network game's clean end (Firefox, persistence on) shown as "Something went wrong: Closed before resume completed.": the rejections came while the exit's save ran and `running` was still true. The order alone, with the audio handler in place, passes (16/0): the handler keeps those rejections from reaching `gameError()` at all |

**By hand: a real Alt+Tab**

Under `xvfb-run` with `openbox` and `xdotool` (`apt-get install openbox xdotool`), the final page served from `build-wasm/`, Firefox 160.0 driven by puppeteer-core with `focusmanager.testmode` false (puppeteer's profile sets it true, which ignores the window manager's focus) and the storage prompt answered by its test preferences; an `xterm` as the other window; a real click into the page first (with the focus in the address bar `document.hasFocus()` is false), and `xdotool keydown alt key Tab keyup alt` for Alt+Tab. The scripts are in the investigation's scratch directory (`ff-investigate/scripts/probe.js`, `net.js`, `runx.sh`).

- *Single player*, the main menu, five times Alt+Tab away and back with clicks between (openbox's Alt+Tab away sends `blur`, `focus`, `blur`, the last two 2 to 3 ms apart, as the network game's log below shows): four requests were refused ("pointer lock refused: The document is not focused." in the console, `pointerlockerror`), no overlay at any point, frames kept coming (288 to 2,487), the lock came back by itself on Alt+Tab back when a click was recent, and otherwise on a real click on the picture.
- *Network game*, Chromium host (headless) and Firefox guest (headful), real click on the picture (fire) before each of three Alt+Tabs away and back: the refusal came at the second and third (the first time the lock was granted in the 2 ms flicker and lost again); no overlay on either; the two games' tics stayed in step throughout (291/291, 544/544, 797/796, 1106/1107); the lock came back on each Alt+Tab back.
- Not covered: a desktop with another window manager (the user's), a private window, and audio playing (headless puppeteer runs have no sound).

**Play-test for the user (Arch, Firefox from `pacman`)**

1. `sudo pacman -S --needed firefox` (and Chromium or Edge for the other player). Serve the build as in `building.md` §6.3, with a relay in `config.js` (§6.6), or use the deployed site.
2. **Edge or Chromium hosts, Firefox joins.** Host with `?host=2` in Edge, open the invite link in Firefox (a private window, as in the report, and once in a normal one), click to join.
3. In the lobby, then in the menus (Escape), then in play: **Alt+Tab away and back** several times each; once while firing (click, then Alt+Tab at once), once while holding a movement key. Expected every time: no "Something went wrong" overlay; the game goes on in both browsers (the host still sees the Firefox player move and the game does not stall); on return the mouse is either captured again by itself or after **one click on the picture**, and mouse look works.
4. Also: Alt+Tab away for 30 seconds or more, then back; and click Start and Alt+Tab away straight away, before the game has drawn.
5. **The other way round:** Firefox hosts (`?host=2`), Edge or Chromium joins; repeat 3 and 4 on both.
6. Firefox's console (Ctrl+Shift+K) may show "Request for pointer lock was denied because the document is not focused" and "pointer lock refused: The document is not focused." as warnings. Any "Something went wrong" overlay, or "unhandled rejection" line, is a failure: note what was done just before.
7. At the end of a game (quit, or the host ends it) the page should say "The game has ended." (or why it ended), not "Something went wrong".

**Concerns**

- *The trap-message change is a change of behaviour at the end of a game:* for 250 ms after an exit, an error from the game (not a `DOMException`, not `ExitStatus`) replaces "The game has ended." The full `netplay.js` run (every way a network game ends) and `persist.js` passed with it; a real error in that window would now be reported, which is the intent.
- *Dropped promises still unwrapped* in `sw.js`: `AudioContext.close()` (rejects only for a context already closed), `webkitAudioContext` (only for browsers without `AudioContext`) and `Browser.requestFullscreen()`'s new container element (nothing calls it). The list is what a search of this build's `sw.js` for `requestPointerLock`, `requestFullscreen`, `exitFullscreen`, `resume()` and `close()` found; an Emscripten upgrade can add others, and `fromGame()` would take a refusal with a stack through `sw.js` for a crash again.
- *A refusal in the middle of a game* (SDL closing and reopening its audio device after a sound setting changed, while `resume()` calls are pending) is handled the same way but was not reproduced (bugs.md L33).
- *Headless differences that the tests work around*: Playwright's headless shell (no movement under pointer lock, renderer crash on a trap), so `focus.js` uses `channel: 'chromium'`; headless Firefox never focused and silent (its title sequence stalls), so `firefox.js` starts in a level. `focus.js` relies on Playwright faking `hasFocus()`: the lock loss there sends the game an Escape.
- *`determinism.js`'s stall check* failed in both runs, as known (an excepted check); its median was 16.8 ms in the rerun.
- `focus.js` failed once, unexplained, in the first round (one check, output lost; 1 of 8 runs then, 0 of 5 since, with the logs now kept).

### Fix round

After an independent review (no blocking defect) and a merge of `claude` (brief 06; this branch's second bug became L33, as L32 was taken).

- *Refusal first* (`gameError()`): once the game has exited, a `DOMException` is never fatal, also while the exit's save runs and `running` is still true; the mutation above shows the case. `ExitStatus` is excluded; the window after an exit is 250 ms (it was 2 s).
- *Persistence on in the tests*: `focus.js` has a trap with persistence on; `firefox.js` a trap with persistence on, and its Firefox guest joins the network game with persistence on and must end with "The game has ended.".
- *`focus.js`'s pixel checks* compare against a still baseline measured just before each (4,212 to 4,852 pixels change by themselves in that level, not 0); frames are counted over 3 s; the mouse-look comparison is made after the focus-loss check, so that check starts with the lock held (the comparison's own page used to take it first), and the test says why Playwright's faked focus makes the lock loss send Escape.
- *`bugs.md` L33*: a trap or script error in the frame shown as "The game has ended." with a fast save; Firefox's dropped `AudioContext.resume()` rejections at every game end; the mid-game case unverified.
- *Nits*: a synchronous throw from a wrapped call returns a rejected promise that already has its handler; a burst of refusals is logged as its first and one line with the count (the network game's 127 to 195 became two lines); the comment lists the dropped promises left alone; "The game could not start: ..." and `onExit`'s message from the game end with a full stop; `puppeteer-core` and every dependency pinned by `tests/web/firefox-deps/package-lock.json` (`npm ci`); `firefox.js` says "VERSION MISMATCH" when the cache or the Firefox binary has another version.
- *`deploy.md` checked*: its "Game data from another server" section is about `data.js`, untouched here; its overlay messages ("The game could not start: ...", "The game crashed: ...") still match (now with one full stop each).
- *First round's runs* (machine shared with two other agents' network tests, load 2.6 to 16): `smoke.js` failed three of five runs (screenshot timeouts, one "Up moves it up") and passed at load 2.7; `persist.js` 14/1 (the known 250 ms reload window) at load 9, 15/0 at load 3.7; `determinism.js` 19/2 at load 9 to 11; `netplay.js` 1277/8 (two games where "the host left the game" under load), `impaired` alone 39/0. All pass in the final runs above.
- Commits: `fa2ed49`, `d8e530e`, `d077afd` (first round); `243585b`, `53e9749` (fix round), `e2bcd7d` (merge of `claude`), and this Outcome.
