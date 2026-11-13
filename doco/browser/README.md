# Shadow Warrior in the browser: work briefs

The goal is Shadow Warrior (JFShadowWarrior) playable in a browser (Emscripten/WASM). The game data is downloaded from a URL on startup, and online multiplayer runs over [vnet](https://github.com/VenKamikaze/vnet) `v0.4.0`. Players host or join by room code, and native desktop players can join the same rooms.

Each brief (`NN-*.md`) is one unit of work, sized for a single implement → review → merge cycle, and written so that a fresh session can pick it up.

**Starting a fresh session on this work?** Point it at [`PROMPT.md`](PROMPT.md). Its §0 is the hand-off.

**Reading order:** this file, then the brief, then [`code-facts.md`](code-facts.md) (what the code actually does, with file:line refs), then the **Outcome** sections of every brief yours depends on: they record what actually landed.

## Status

| # | Brief | Repos touched | Depends on | Status |
|---|---|---|---|---|
| 00 | [Repo set-up, baseline, code facts](00-setup.md) | jfsw-browser | Q1 | done |
| 01 | [vnet transport for mmulti (native)](01-vnet-transport.md) | jfsw-browser, jfbuild | 00 | done |
| 02 | [Emscripten port](02-emscripten-port.md) | jfsw-browser, jfbuild, jfaudiolib | 00, Q2 | done (play-test pending) |
| 03 | [Data download from a URL](03-data-download.md) | jfsw-browser | 02 | done (play-test pending) |
| 04 | [Browser netplay](04-browser-netplay.md) | jfsw-browser, jfbuild | 01, 02 | done (play-test pending) |
| 04b | [Netcode lag cuts](04b-lag-cuts.md) | jfsw-browser, jfbuild | 04 | done (play-test pending) |
| 04c | [A tab hidden before the level's first frame (L19)](04c-hidden-first-frame.md) | jfsw-browser | 04b | done (play-test pending) |
| 05 | [Host and join from the game](05-host-and-join.md) | jfsw-browser, jfbuild | 03, 04 | done (play-test pending) |
| 06 | [Deployment guide](06-deployment-guide.md) | jfsw-browser | 05 | written |
| 02c | [A refused pointer lock shows the fatal overlay (L24)](02c-focus-loss.md) | jfsw-browser | 02 | written (found by the user's Firefox play-test, 13 Nov 2026) |
| 05b | [Warn every player when the players' game data differs (L26)](05b-data-mismatch-warning.md) | jfsw-browser | 05 | written (the user, 13 Nov 2026: warn, don't refuse) |

01 and 02 can run in parallel, as can 03 and 04.

**Fixes to bugs in the original game** (see "Bugs found in the original game" below):

| # | Brief | Fix branch (from `master`) | Depends on | Status |
|---|---|---|---|---|
| F1 | [Co-op game freezes at tic 1522](F1-coop-freeze.md) | `fix/coop-freeze` | 01 (for the regression test) | on hold (the user, 6 Nov 2026) |
| F2 | [Native crash in the ALSA MIDI music driver](F2-alsa-midi-lock.md) | `fix/alsa-midi-lock` (jfaudiolib fork, from `68be97f`) | 00 | done (verified by the user on Arch, 7 Nov 2026) |
| F3 | [Machines play different numbers of tics after a level exit (L20)](F3-level-exit-tics.md) | `fix/level-exit-tics` (from `master`), integrated on `browser/F3-level-exit-tics` | 04c (for the tests) | done (play-test pending) |
| F4 | [Toggling mouse aiming mid-level desyncs the game (L25)](F4-mouse-aim-sync.md) | `fix/mouse-aim-sync` (from `master`), integrated on `browser/F4-mouse-aim-sync` | F3 (for the tests) | written |

Later, not briefed: music (Q4), WebGL rendering through the GLES2 path, touch controls, the Wanton Destruction and Twin Dragon add-ons in the browser, mouse turns drawn between tics (view angle only), smoothing prediction corrections.

## Settled decisions

Don't reopen these inside a brief. If one proves wrong, stop and ask the user.

- **D1. The browser is the end goal.** The native Linux build must keep working, and native players must be able to join browser rooms.
- **D2. No joining mid-game.** The player count is fixed when the game starts, as it is today.
- **D3. "Join" and "Host" restart into a network game.** In the browser: reload the page with `?join=CODE` (or `?host=N`). Natively: re-launch itself with the equivalent arguments. `main` parses these exactly as it parses `-net` today. Nothing is torn down in-process.
- **D4. The transport is vnet `v0.4.0`**, a git submodule at `ext/vnet`. Use `VNET_BACKEND_RELAY_AUTO` (WebTransport then WebSocket in the browser, the relay over UDP natively). `mmulti.h` stays unchanged: a vnet implementation sits behind it. Plain UDP (today's `-net`) stays for native builds.
- **D5. Relay games use master/slave mode.** The room creator gets `10.0.0.1`, which is player 0, the master; joiners fill the open slots. Peer-to-peer over the relay is out of scope.
- **D6. The software renderer comes first.** WebGL through GLES2 is later.
- **D7. The blocking loops stay.** The browser build uses ASYNCIFY, with a yield in the event or frame pump. No rewrite around `emscripten_set_main_loop`.
- **D8. The page fetches the data.** JavaScript downloads the GRP before `main` (URL from the page config, overridable with `?data=`), shows progress, caches it in IndexedDB, and writes it into a folder on the game's search path, so the game's own GRP detection is unchanged. A file picker covers people with their own copy. No native downloader.
- **D9. The browser lobby is an HTML overlay** (room code, invite link, who has joined), not drawn by the engine. The console and menu entries lead to it.
- **D10. Git:** feature branches from `claude` and `--no-ff` merges. No pull requests unless the user asks; no force-pushes. GRP files and other game data are never committed.
- **D11. Licensing:** only the shareware GRP may be offered for public download by default. Hosting registered data is the user's call.
- **D12. Toolchain:** Emscripten 6.0.13, as Bit Riot pins. `scripts/setup-emsdk.sh` is adapted from Bit Riot's.

## Answers to the open questions (6 Nov 2026)

- **Q1. Submodules: keep them, on the user's forks.** `.gitmodules` points at `https://github.com/VenKamikaze/{jfbuild,jfmact,jfaudiolib}.git` with absolute URLs. The forks already existed and contain the commits jfsw pins. Changes to jfbuild or jfaudiolib are made in the fork, on a branch, and the submodule pointer in this repo moves with them. See "Working across repos".
- **Q2. Test data: the shareware 1.2 release.** `scripts/fetch-test-data.sh` downloads `https://image.dosgamesarchive.com/games/3dsw12.zip` (the official 3D Realms archive; MD5 `d77564e8764feeb1509dd0d534fb8952`, the same as the SlackBuilds `jfsw_demo_data` package), unzips `SWSW12.SHR` from it and `sw.grp` from that, and checks the GRP against `src/grpscan.c`: CRC32 `0x08A7FA1F`, 26,056,769 bytes ("Shareware Version"). The file is stored as `testdata/swshare.grp`, which is ignored by git. Same file: `https://archive.org/download/3dsw12/3dsw12.zip`. `web.archive.org` resets connections from the cloud container.
  - That host sends **no CORS headers**, so a page on another origin cannot fetch it. Brief 03 must plan to serve the extracted GRP from the game's own origin (or a CORS-enabled host).
- **Q3. "Start now": yes.** The host can start with fewer players than the number of slots chosen. Every client must learn the final player count before the game initialises.
- **Q4. Music: later.** Sound effects are in scope; Ogg/MIDI music is an unbriefed follow-up.
- **Q5. Upstream friendliness: yes, where cheap** (the default; not asked explicitly). Prefer new files, `#ifdef __EMSCRIPTEN__` and no reformatting of upstream code.

## Working across repos

The work spans four GitHub repos:

| Repo | Role | `claude` branch |
|---|---|---|
| `VenKamikaze/jfsw-browser` | the game, docs, scripts, tests | from `master` `befcdd0` |
| `VenKamikaze/jfbuild` (submodule `jfbuild/`) | engine, `mmulti.c`, SDL layer | from `40a98be` (the commit jfsw pins; the fork's `master` is newer) |
| `VenKamikaze/jfaudiolib` (submodule `jfaudiolib/`) | audio | from `68be97f` (pinned; the fork's `master` is newer) |
| `VenKamikaze/jfmact` (submodule `jfmact/`) | input and config library | **none**; stays on `master` `731c0cc` (see below) |

vnet is a fourth submodule at `ext/vnet`, pinned to the `v0.4.0` tag (`eb1feeb`). It is never changed from here.

**Rules:**

1. A brief's branch is `browser/NN-short-name` in jfsw-browser, from its `claude`.
2. If the brief changes jfbuild or jfaudiolib, it uses a branch with **the same name** in that fork, from the fork's `claude`. Commit there, push that branch, then commit the new submodule pointer on the jfsw-browser branch. Every pointer committed in jfsw-browser must be a commit that is pushed to the fork.
3. **Merging:** merge the fork's branch first (`--no-ff` into the fork's `claude`, push). Then, on the jfsw-browser feature branch, move the submodule pointer to the fork's new `claude` merge commit, commit, and merge jfsw-browser (`--no-ff` into `claude`, push). After the merge, `claude` in jfsw-browser always points at commits on the forks' `claude` branches.
4. A fresh `git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser` must always work.
5. Changes to engine code stay upstream-friendly (Q5): new files where possible, `#ifdef __EMSCRIPTEN__`, no reformatting.

**jfmact:** the fork has a stale branch `claude/keen-hamilton-ede0qw` (identical to `master`), and git cannot have a `claude` branch next to it. If a brief needs to change jfmact, ask the user whether that branch can be deleted before creating `claude` there.

## Bugs found in the original game

The user's policy (6 Nov 2026):

- A bug in the original game (or engine) that **breaks the game** (a freeze, a crash, a lost game), **reproduces reliably**, and is **in something a normal multiplayer game is likely to use** gets its own brief (`Fn-short-name.md`) and its own fix. The project is quick web multiplayer games over vnet, in the browser and natively.
- **A game-breaking bug in a feature a normal multiplayer game is unlikely to use** (demo recording, the editor, single-player-only features, and so on) is out of scope for a brief and fix: note it in `bugs.md` as **not planned**, with the reason, and tell the user. If unsure, ask. (6 Nov 2026: the crash when the player dies while recording a demo, `bugs.md` L13: demo recording won't happen in quick web multiplayer games.)
- **Lesser bugs** (wrong messages, cosmetic problems, odd edge cases that don't stop play) go in [`bugs.md`](bugs.md), to look at later. Don't fix them inside an unrelated brief, unless the brief can't work around them; then fix them in the smallest way and say so in `bugs.md`.
- **First, check that upstream hasn't already fixed it** (the user's rule). The submodules are pinned behind their forks' `master` (jfbuild by 5 commits, jfaudiolib by 4; on 6 Nov 2026 the forks matched `jonof/*` exactly, and jfsw and jfmact had nothing newer). Before fixing: compare `jonof/<repo>` `HEAD` with the pinned commit, read the newer commits that touch the code involved, look at upstream's unmerged pull requests (`git ls-remote https://github.com/jonof/<repo> 'refs/pull/*/head'`, fetched into a scratch bare repo), and **re-run the reproduction with the submodule moved to the fork's current `master`**. If a newer upstream commit fixes it, the fix is to move the pin (its own brief), not a new patch. Record what was checked in the Outcome.
- **A fix is made so that it can go upstream to JonoF unchanged:**
  1. The fix branch, `fix/<short-name>`, starts from **`master`** (upstream jfsw, `befcdd0`), not from `claude`, and holds only the fix: upstream code style, no reformatting, no browser or vnet code, no `doco/`, a commit message written for upstream. If the fix is in jfbuild or jfaudiolib, the fix branch is in that fork, from the commit jfsw pins (it is on the fork's `master` history; the fork's `master` is upstream's), and must also apply cleanly to the fork's current `master` (check with a throwaway rebase or cherry-pick, and say so).
  2. An integration branch, `browser/Fn-short-name`, from `claude`, merges the fix branch with `--no-ff` and adds what upstream doesn't want: the regression test, the Outcome, `code-facts.md` and `bugs.md` updates. It is reviewed and merged into `claude` like any brief.
  3. Nothing is sent upstream (no pull request, no issue) unless the user asks.
- A fix changes the simulation, so after it: the committed demos must still replay with identical `.dms` files (or the brief explains, tic by tic, why a demo legitimately changed), and the native-against-wasm check from 02 must still pass.

## Process

See [`PROMPT.md`](PROMPT.md) §6 and §7: implementer subagent per brief, read-only review in its own worktree, fix round, coordinator verification, `--no-ff` merge, Outcome filled in, hand-off updated.
