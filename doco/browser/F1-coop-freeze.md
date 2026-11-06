# F1: Co-op game freezes at tic 1522

## Goal

Find the root cause of the freeze in a three-player co-operative game on shareware E1L1, and fix it in a way that can go upstream to JonoF unchanged.

## What is known

- Found by brief 01, confirmed by its reviewer. Three native players, co-op, shareware GRP, level 1, all players idle: every process freezes at game tic (`MoveThingsCount`) **1522**, spinning at 100% CPU.
- The master is stuck in `clipmove` ← `move_sprite(831)` ← `SpriteControl`; another run showed `FindNewAngle` → `move_scan` → `clipmove` for sprite 831, at about x −82975, y 61570.
- It happens over plain UDP `-net` and over the vnet relay, and in the build from **before** brief 01 (`d2b9ad6`). So it is in the existing game or engine, not in the new networking.
- A single-player `-level1` game passes tic 2600.

## Read first

- [`README.md`](README.md), especially **"Bugs found in the original game"** (the fix-branch rules) and "Working across repos".
- [`code-facts.md`](code-facts.md) (§7 demos and bounded runs, §8 sync, and what brief 01 added).
- The Outcome of [01](01-vnet-transport.md): `tests/net/test-three-games.sh` runs three headless games; `-testquit<N>`, `-testsync`, `-autonet`.

## In scope

0. **Check upstream first** (README, "Bugs found in the original game"): reproduce on the pinned build, then with jfbuild and jfaudiolib moved to their forks' current `master` (throwaway, not committed), and look at newer `jonof/*` commits and unmerged pull requests for a fix. The coordinator checked on 6 Nov 2026 and found none (the 5 newer jfbuild commits are macOS bundle, build-flag and big-endian table changes; the 4 jfaudiolib ones are build, byte-swap and SDL1 CD changes; no open PR touches the code involved), but check again, and record it in the Outcome. If upstream already fixes it, stop and report.
1. **Reproduce** it with brief 01's harness, then find the **smallest** reliable reproduction: does it need three players, or do two do? Co-op only, or deathmatch too? Does it depend on the players being idle? Is it always tic 1522 and sprite 831? A demo records one player only, so a single-player reproduction (if you can make one, e.g. by placing the player or with scripted input) is a bonus, not a requirement.
2. **Find the root cause.** Say exactly why the loop doesn't end: which loop, which values, and why they occur. Check whether it's a port bug (64-bit, uninitialised memory, out-of-bounds access, integer overflow, signedness) rather than original game logic: build with `-fsanitize=address,undefined` and/or run under valgrind or gdb. Say whether the original DOS game would plausibly have had it.
3. **Fix it**, following the README's rules:
   - The fix branch `fix/coop-freeze` starts from **`master`** (`befcdd0`) in jfsw-browser, or, if the bug is in the engine, from the pinned commit in the jfbuild fork (and must also apply cleanly to that fork's `master`). It holds only the fix, in upstream style, with a commit message written for upstream that explains the cause.
   - The smallest correct fix. Prefer fixing the cause (e.g. an uninitialised value) to adding a guard around the symptom; if a guard is the right fix (e.g. an iteration limit in a search loop), say why.
4. **Integration branch** `browser/F1-coop-freeze` from `claude`: merge the fix branch with `--no-ff` (and move the submodule pointer, if it's an engine fix), add the regression test, and update `code-facts.md`, `bugs.md` (if you find lesser bugs) and this brief's Outcome.

## Out of scope

- Other bugs. Game-breaking ones you find: describe them in your report (the coordinator writes a brief). Lesser ones: add them to `bugs.md`.
- Any change to networking.

## Tests

1. **Regression test:** brief 01's three-game test, run well past the freeze, e.g. 3000 tics or more, co-op, 8 sync bytes, no desync, all exit 0. Run it three times. Show it **fails (freezes) without the fix**, using the same test with a time limit, and passes with it. Add it to `make test-net` (or a target of its own, if it's slow; say how long it takes).
2. **Determinism:** the fix changes the simulation, so:
   - the committed demos from brief 02 (`tests/data/jfsw*.dmo.gz` with their `.dms`) still replay natively with identical `.dms` files; if one changes, explain, tic by tic, why that is correct;
   - brief 02's native-against-wasm determinism test still passes (`tests/web/determinism.js`; it needs the wasm build: `scripts/build-wasm.sh`);
   - brief 01's test 2 (three games, 1200 tics, relay) still passes.
3. If you find the cause in a way that a small unit-style test can catch (for example a function that loops forever on certain inputs), add that test too.

## Acceptance criteria

1. The root cause is explained in the Outcome and in the fix commit message.
2. `fix/coop-freeze` is based on `master` (or the pinned fork commit), contains only the fix, and builds on its own (`make -j4` on the fix branch, from a clean checkout).
3. The regression test passes with the fix and fails without it.
4. The determinism checks above pass.

## Dependencies

01 merged into `claude` (for the test harness). 02 merged (for the demo and wasm checks). The investigation itself can start as soon as 01's branch is available.

## Notes

- **Git:** the fix branch `fix/coop-freeze` (from `master`) and the integration branch `browser/F1-coop-freeze` (from `claude`), in jfsw-browser, plus same-named branches in the jfbuild fork if the fix is in the engine. Push after each commit. Never merge into `claude` or `master`, never open a PR, never force-push, nothing sent upstream.
- Test data: `scripts/fetch-test-data.sh`. Use `scripts/run-headless.sh` for game runs, with its own `--workdir` per process.
- A debug build (`-O0 -g`, or `RELEASE=0` if the Makefile has it) helps gdb; say which flags you used, and make sure the test runs on the normal build.

## Outcome

_Not started._
