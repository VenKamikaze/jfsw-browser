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

(To be written by the implementer.)
