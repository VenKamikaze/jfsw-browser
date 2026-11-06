# F2: Crash when the player dies while recording a demo

## Goal

Recording a demo (`-dr<name>`) no longer crashes when the player dies, and the demo written up to that point plays back. The fix can go upstream to JonoF unchanged.

## What is known

- Found by brief 02 while recording its determinism demos. After the player dies during `-dr` recording, recording carries on into a demo file that has already been closed, and `sw` crashes with a segmentation fault at the next 2048-packet buffer flush (`DEMO_BUFFER_MAX`, code-facts §7).
- So a demo recorded natively today ends at the player's death, and the game crashes. Reproduces every time.

## Read first

- [`README.md`](README.md), especially **"Bugs found in the original game"** (the fix-branch rules).
- [`code-facts.md`](code-facts.md) §7 (demos), and what brief 02 added.
- The Outcome of [02](02-emscripten-port.md): `tests/tools/synth_input.c` (an `LD_PRELOAD` shim that types scripted keys into the native game) and how it recorded `tests/data/jfsw*.dmo`.

## In scope

0. **Check upstream first** (README, "Bugs found in the original game"): reproduce on the pinned build, then with jfbuild and jfaudiolib moved to their forks' current `master` (throwaway, not committed), and look at newer `jonof/*` commits and unmerged pull requests for a fix. The coordinator checked on 6 Nov 2026 and found none (the 5 newer jfbuild commits are macOS bundle, build-flag and big-endian table changes; the 4 jfaudiolib ones are build, byte-swap and SDL1 CD changes; no open PR touches the code involved), but check again, and record it in the Outcome. If upstream already fixes it, stop and report.
1. Reproduce it natively with a scripted player who dies (e.g. walks into enemies at a high skill, or with scripted input), recording with `-dr`.
2. Find the root cause (`src/demo.c`, and where death or the level's end closes the file), and what the original game meant to happen when the player dies while recording: stop and keep a valid demo, or carry on recording across the restart. Choose the behaviour that keeps the demo valid and is closest to the original intent, and say why.
3. Fix it per the README's rules: `fix/demo-record-crash` from **`master`** (`befcdd0`), only the fix, upstream style, an upstream-ready commit message. Then an integration branch `browser/F2-demo-record-crash` from `claude` that merges it with `--no-ff` and adds the regression test and the docs.

## Out of scope

- Other demo features; other bugs (describe game-breaking ones in your report; add lesser ones to `bugs.md`).

## Tests

1. **Regression test:** record a demo in which the player dies (scripted input), headless; the game must not crash (exit status 0 or the documented stop status, no signal), and the demo must play back (`-dp`) to its end, exiting 0. Show it fails (crashes) without the fix.
2. **Determinism:** the committed demos' `.dms` files still replay identically natively, and brief 02's native-against-wasm test still passes. Recording in wasm, if the shim or the page's test hooks allow a death there too, behaves the same as native.

## Acceptance criteria

1. Root cause and chosen behaviour explained in the Outcome and the fix commit message.
2. `fix/demo-record-crash` is based on `master`, holds only the fix, and builds on its own.
3. The regression test passes with the fix and fails without it; the determinism checks pass.

## Dependencies

02 merged into `claude` (the shim and the demo tests).

## Notes

- **Git:** `fix/demo-record-crash` (from `master`) and `browser/F2-demo-record-crash` (from `claude`), in jfsw-browser. Push after each commit. Never merge into `claude` or `master`, never open a PR, never force-push, nothing sent upstream.

## Outcome

_Not started._
