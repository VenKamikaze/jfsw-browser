# Lesser bugs in the original game

Bugs found in upstream jfsw, jfbuild or jfaudiolib (at the pinned commits) while doing the browser work that **don't break the game**. Game-breaking, reproducible bugs get their own fix brief instead (see "Bugs found in the original game" in [`README.md`](README.md)). Nothing here has been sent upstream.

Each entry: where, what happens, how it was found, and its state (**open**, **worked around** in a brief, or **fixed** on a `fix/` branch).

| # | Where | What happens | Found in | State |
|---|---|---|---|---|
| L1 | `src/game.c:3686-3690` (second argument scan) | The loop meant to skip the arguments after `-net` uses `i` instead of `cnt` (`i` is `MAX_SW_PLAYERS` there), so it skips nothing: every mmulti argument is also parsed as a game option, by prefix (`-s…` skill, `-g…` group file, `-h…` def file, `-col` eats the next argument, `-name`). | 00 review | **worked around** in 01: the new `-relay`, `-room`, `-host-room` are skipped explicitly. Any new `-net` sub-option must be too. |
| L2 | `src/game.c:3547` | `-nosetup` doesn't stop the startup window on a first run with no `sw.cfg` (the test is `configloaded < 0 \|\| …`). | 00 | open (headless runs unset `DISPLAY`) |
| L3 | `src/sync.c:511-525` (`demosync_test`) | A demo sync mismatch prints `Demo out of sync - …` and exits with status **0**. | 00 | open (tests grep the output) |
| L4 | `src/game.c:937-939` (`InitGame`) | A quit event during the wait for network players makes `InitGame` return instead of exit, and `Control` carries on with an unfinished initialisation; a SIGTERM there ends in a segmentation fault a moment later. The user was quitting anyway. | 00, 01 | open |
| L5 | `jfbuild/src/cache1d.c` (`findfrompath`) | An absolute path in `SWGRP` or `-g` silently fails (the leading `/` is stripped), and the error shown is "Failed to load PALETTE.DAT!" rather than "file not found". | 00 | open |
| L6 | `src/player.c:7898-7900` | `#ifdef DEBUG` where `DEBUG` is defined as `0`, so the branch is taken: sync data is computed on every move instead of every 64th. Harmless, a little slower. | 00 review | open |
| L7 | `src/sync.c` (`-Warray-bounds`) | `Player[connecthead]` with `connecthead == -1` when the player list is empty. Not reachable in a running game. | 00 | open |
| L8 | `src/break.c` (`SpawnBreakFlames`) | Declared and called with one argument but defined with two. Undefined behaviour in C; harmless on x86, but a call through a mismatched signature **traps in WebAssembly**. | 02 | **fixed** in 02 (the call passes the unused argument). Candidate for its own upstream `fix/` branch. |
| L9 | top-level `Makefile` | `make` never rebuilds an existing `jfbuild/libengine.a`, so engine edits go stale until the library is rebuilt by hand. | 01 | **worked around**: `make test` rebuilds it; `building.md` §8 says how. |
| L10 | `jfbuild/src/mmulti.c` | `syncstate` is declared and read by the game ("Missed Network packet!") but never set by mmulti, so that message never appears. | 00 | open |
| L11 | `src/net.c` | Slaves store the master's sync bytes but their comparison call is commented out, so only the master can detect a desync. | 01 | open (tests look at the master) |
| L12 | `src/sync.c` | The sync check hashes only the low byte of coordinates, so it can miss small divergences. | 01 review | open (relevant to 04's cross-play check) |
