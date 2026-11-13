# Kick-off prompt: Shadow Warrior in the browser, with vnet netplay

You are the **coordinator** for a multi-brief project in [`VenKamikaze/jfsw-browser`](https://github.com/VenKamikaze/jfsw-browser), a fork of [jonof/jfsw](https://github.com/jonof/jfsw) (JonoF's Shadow Warrior port, C, SDL2, Build engine). This file is meant to live at `doco/browser/PROMPT.md` in that repo.

**The goal:** Shadow Warrior playable in a browser (Emscripten/WASM), with the game data downloaded from a URL on startup and online multiplayer over [vnet](https://github.com/VenKamikaze/vnet) (`v0.4.0`, MIT, a virtual-UDP library plus a Go relay). Players host or join a game by room code, from the in-game menu or the console. Desktop (native) players can join the same rooms. Joining a game already in progress is **out of scope**.

vnet was built for the same job in [`VenKamikaze/BitRiot`](https://github.com/VenKamikaze/BitRiot): see that repo's `doco/netplay/` (briefs 09, 12 and `deploy.md`) and vnet's `doco/integration.md`. Reuse what was learnt there; don't copy Bit Riot code wholesale.

## 0. Where things stand (hand-off; keep this up to date after every merge)

**13 Nov 2026: briefs 00 to 05 and F3 merged into `claude` (02 to 05 and F3: play-test pending). Brief 06 merged; 02c and F4 are in flight, 05b is written (see "In flight" below). F1 is on hold.**

- **Answers** are recorded in [`README.md`](README.md): submodules stay, on the user's forks (Q1 b); shareware data from a verified mirror (Q2); "Start now" is in (Q3); music later (Q4); upstream-friendly where cheap (Q5, default).
- **Repos:** the work spans four GitHub repos, all attached to the session with push access: `VenKamikaze/jfsw-browser` (this one), and the forks `VenKamikaze/jfbuild`, `VenKamikaze/jfaudiolib` and `VenKamikaze/jfmact`. The forks existed already (this prompt originally said they didn't), and they contain the commits jfsw pins.
- **`claude` branches:** created from jfsw-browser `befcdd0` (= `master`), jfbuild `40a98be` and jfaudiolib `68be97f` (the commits jfsw pinned; the forks' `master` branches are newer and match `jonof/*`). Briefs 01 and 02 are now merged into the forks' `claude` branches (jfbuild `27edad9`, jfaudiolib `a9d4ecb`). **jfmact has no `claude` branch:** the remote already has `claude/keen-hamilton-ede0qw`, and git cannot hold `claude` next to `claude/…`. jfmact stays on `master` at `731c0cc` until a brief needs to change it; then ask the user whether that stale branch can be deleted.
- **Multi-repo git rules** are in the README ("Working across repos").
- **Test data:** `scripts/fetch-test-data.sh` (brief 00) downloads and verifies the shareware GRP. The source is `https://image.dosgamesarchive.com/games/3dsw12.zip` (MD5 `d77564e8764feeb1509dd0d534fb8952`); `web.archive.org` resets connections from the cloud container, `archive.org/download/3dsw12/3dsw12.zip` is the same file.
- **Bit Riot reference material** is on Bit Riot's `claude` branch, not `master`. Fetch it by URL (`git fetch https://github.com/VenKamikaze/BitRiot claude`) if the local clone has a `claude/…` remote branch, which blocks a plain fetch.
- **Brief 00 landed:** submodules on the forks, `ext/vnet` at `v0.4.0`, `scripts/setup.sh`, `setup-emsdk.sh` (default install in `~/.cache/jfsw-browser/emsdk`, shared by all worktrees), `fetch-test-data.sh`, `run-headless.sh`, tests in `tests/`, and the verified [`code-facts.md`](code-facts.md) and [`building.md`](building.md). The orphan branch `emscripten-ports` holds the SDL2, Ogg and Vorbis port archives, because GitHub archive URLs answer 403 in the cloud container.
- **Brief 01 landed:** native relay games (`-net -relay HOST:PORT -host-room N` / `-room CODE`), `jfbuild/include/mmulti_vnet.h` for brief 05, test-only `-testsync`, `-testquit<N>`, `-testnudge<T>`, and `make test` (`test-mmulti`, `test-net`). The jfbuild fork's `claude` is at `75acb01`.
- **Bug policy** (README, "Bugs found in the original game"; `bugs.md`): game-breaking, reproducible bugs in things a normal multiplayer game uses get a brief and a fix branch from `master`, after checking upstream; others are noted. **F1** (co-op freeze at tic 1522) is briefed and **on hold** at the user's request; it blocks 04's full-level test.
- **Brief 02 landed:** the Emscripten build (`scripts/build-wasm.sh`, output in `build-wasm/`), the shell page in `web/`, IDBFS saves and settings, and the browser tests in `tests/web/` (smoke, persist, determinism; native and wasm sync bytes identical). The browser build links `mmulti_null.c` (no networking) until brief 04. **Play-test pending**: the steps are in 02's Outcome. The "no stall over 100 ms" frame check fails in this container (software-rendering headless Chromium); it needs real hardware.
- **After moving a submodule pointer, run `make veryclean && make -j4`:** top-level `make` reuses a stale `jfbuild/libengine.a` (`bugs.md` L9).
- **Brief 03 landed:** `web/config.js` (the one file a host edits), `web/data.js` (checked download with progress and stall detection, IndexedDB cache re-checksummed on every hit, file picker, clear errors), `web/grptable.js` (tested against `src/grpscan.c`), [`data-hosting.md`](data-hosting.md) (Apache example checked on Apache 2.4.58). A reload makes no request and the game doesn't re-checksum. Play-test pending (steps in 03's Outcome).
- **F2 landed (7 Nov 2026):** the user found a native crash in jfaudiolib's ALSA MIDI driver (empty `Lock`/`Unlock`, so the playback thread and the main thread corrupted the sequencer handle). Fixed on the jfaudiolib fork's `fix/alsa-midi-lock` (from the pin, applies to upstream `master`), merged into the fork's `claude`; `scripts/run-headless.sh` now turns music off unless `--music`. Verified by the user on Arch (10 of 10 runs clean with ALSA music); it can't be reproduced in the container (no ALSA sequencer). For music natively, a soundfont is needed (`pacman -S soundfont-fluid`).
- **Smoke-test flakes fixed (12 Nov 2026)**, merged from `browser/02-unlocked-mouse` (details in 02's Outcome, last section). (1) The Escape check's failures were the view turning, not the menu: while the pointer was not locked, SDL turned `mousemove`/`mouseenter`/`mouseleave` into absolute positions and reported the jumps as mouse motion. A real bug: an uncaptured mouse moving over the page turned the player. `web/jfsw.js` now passes those events to SDL only while SDL knows the pointer is locked; a new check covers it. (2) The menu checks were not at the menu: twelve Spaces skipped the intro and then started E1L1. The intro is now skipped with Shift, and the test finds the menu cursor's row. The menus read the arrows' state every ~100 ms, not presses (`bugs.md` L14, original behaviour), so a press moves one or two rows. `smoke.js` 29/0 in 12 of 12 runs; each sabotage (`blank`, `nokey`, `noesc`, `unlockedmouse`) fails its check; `persist` 15/0, `data` 172/0, `grptable` 8/0, `determinism` 20/1 (the known stall check).
- **Push access:** the session's GitHub scope listed only jfmact, vnet and BitRiot, and attaching jfsw-browser and jfaudiolib with `add_repo` was refused; pushing to jfsw-browser over git works anyway. jfbuild is attached.
- **Brief 04 landed (12 Nov 2026):** the browser build links `mmulti.c` + `mmulti_vnet.c` + vnet (`-relay ws(s)://…`, `RELAY_AUTO`: WebTransport, then WebSocket; plain `-net` is refused in the browser). A hidden tab in a network game is driven by vnet's wake callback through a `MessageChannel` (`HiddenNetPass` in `src/net.c`: make the inputs due, move, then `mmulti_vnet_flush()` so nothing waits for PAKRATE), draws nothing and keeps the room at 40 tics a second at about 30 passes a second. Test-only `-testdump<name>` (17 bytes per tic per machine) proves every machine, browser or native, steps identical tics. A lost relay session ends the game with a message (bugs.md L18). `tests/web/netplay.js`: 20 scenarios, 365 checks, about 15 minutes. The jfbuild fork's `claude` is at `c4e3aea`. Play-test pending (a really hidden tab, Chromium's intensive throttling): steps in 04's Outcome.
- **Process change (the user, 12 Nov 2026):** if a brief still needs work after its fix round, spawn a new implementer on the strongest model rather than going round again with the same one.
- **Brief 04b landed (12 Nov 2026):** `SendInputNow()` (net.c) flushes mmulti right after each input or combined packet is queued, so an input no longer waits for PAKRATE's 25 ms window; `MasterForward()` also runs from `getpackets()` after its receive loop, so the master forwards a tic as soon as its last input arrives. Input-to-tic medians: browser slave about 100-118 to 79 ms, native slave with 30 ms each way 105 to 64 ms, two natives 51 to 26 ms; datagrams per peer 1.8 to 2 times as many (45 to 72 a second; about a third of a slave's are redundant ack-only ones, code-facts §16, for brief 06's relay sizing). Test-only `-testlag`, `-teststate`, `-testslowstart`; scenarios `lag`, `tic1` (and `lag-matrix` by name). The tic-1 hash difference was scratch values that `FAF_DrawRooms` keeps in two marker sprites' `ang` (the hash leaves them out and now covers every sector's ceiling and floor stat). The jfbuild fork's `claude` is at `a610e1e`. `netplay.js` 591 checks. Play-test pending: steps in 04b's Outcome.
- **Brief 04c landed (13 Nov 2026), L19 fixed:** drawing leaves lasting changes the simulation reads (the ceiling/floor picture override planes' parallax bit and picture, `FAF_DrawRooms`; the slope bit of `FLOOR_SLOPE_DONT_DRAW` sectors, `PostDraw`), and a tab hidden before a level's first frame never drew. `DrawSetupLevelStats()` (draw.c) does what one frame does to them, at the end of `InitLevel` on every machine; visible play is unchanged (`old-new`: old and new builds agree on every tic). The drawing-path audit is code-facts §17. New: `hidden-first`, `hidden-level`, `old-new` (by name), `make test-draw`, test-only `-testexit`, `-testdrawcheck`. `netplay.js` 827 checks. Play-test pending: steps in 04c's Outcome. A hidden guest holds up the room at every level end (the bonus screen waits for a key on every machine): for brief 05.
- **F3 landed (13 Nov 2026), L20 fixed:** after the tic that ends a level, `MoveLoop` used to run every further tic whose inputs were in, so machines could play different numbers of tics and co-op carried different health, ammo and inventory into the next level (the old code fails the new tests in every game). Fix on `fix/level-exit-tics` from `master` (`ad79722`: `if (ExitLevel) break;` after `domovethings()`; not fixed upstream; applies cleanly to upstream `master`), merged through `browser/F3-level-exit-tics`. Every `ExitLevel` path is analysed in F3's Outcome and code-facts §18. New: test-only `-teststall`, `-testfire`; `netplay.js level-exit`, `tests/net/test-level-exit.sh` (in `make test-net`). `netplay.js` 914 checks. The fix commit carries this project's session trailers: if it goes upstream, the user may want a clean copy. Play-test pending: steps in F3's Outcome.
- **Brief 05 landed (13 Nov 2026):** host and join from the game.
  - **The page:** `?host=N` and `?join=CODE` on any page, with the relay from `config.js` only. An HTML lobby overlay shows the room code, a copyable invite link, who is in, Start now and Cancel.
  - **Start now** is an mmulti change in the jfbuild fork: every machine learns the final count together with the go-ahead.
  - **In the game:** the console's `host`, `join` and `relay` commands; Host Online and Join Online in the menus. Natively they re-launch the binary (`execv`), and the GTK startup window has online fields.
  - **Errors and level ends:** every error state ends with a sentence. A hidden player leaves the bonus and stats screens by itself.
  - **Review blocker B1, fixed:** the relay gives a departed player's address to the next joiner, so a guest who reopened the link was let into the running game and the host hung. Relay sessions now carry a random id.
  - **Test mode** now needs `testMode: true` in `config.js` as well as `?test=1`, so a crafted link can't route visitors through another relay. A deployment must keep it `false` (brief 06).
  - **Numbers:** the jfbuild fork's `claude` is at `5950d14`. `netplay.js` has 1286 checks (about 30 minutes) and `make test-net` has 8 scripts.
  - **Open:** `persist.js`'s "reload 250 ms after a save" check failed once in each of two loaded full runs (02's IndexedDB window; brief 05 doesn't touch saving). Look at it with the smoke flake follow-up. Play-test pending: steps in 05's Outcome.
- **In flight (13 Nov 2026, session ran low on tokens; each branch's Outcome has a "State (in progress)" section written by its agent — read it first):**
  - **06 deployment guide: landed (13 Nov 2026).** `deploy.md` covers Arch, Apache with TLS, the relay as a hardened systemd unit (WebSocket by default; WebTransport opt-in until vnet brief 15) and desktop players; `tests/deploy/check-deploy.sh` (needs root; not in `make test`) checks the guide's own blocks end to end. Its section "Game data from another server" covers `?data=`. Play-test pending: the user deploys on their own server (steps in 06's Outcome). Open: L30, L31, L32 (06's Outcome, last section).
  - **02c focus loss, L24** (`browser/02c-focus-loss`, worktree `/home/user/wt-02c`): the user's Firefox play-test (Alt+Tab shows the fatal overlay; the game keeps running). Implementation in progress; not reviewed yet.
  - **F4 mouse aiming, L25** (`fix/mouse-aim-sync` from `master`, `browser/F4-mouse-aim-sync`): an original-game desync found while investigating the user's deathmatch desync. Implementation in progress; not reviewed yet. The fix commit carries only the Co-Authored-By trailer (clean for upstream).
  - **05b data mismatch warning, L26:** written, not started. Start after F4 merges (both touch game.c/net.c). The user's decision: warn every player, don't refuse. The user's deathmatch desync was mixed registered and shareware data. Open question for the user: also warn on different builds (L30)?
  - **vnet brief 15** (WebTransport drops datagrams sent in a burst, the cause of L31): on vnet `docs/15-wt-datagram-bursts`, for a separate vnet session. When vnet tags the fix: move `ext/vnet`, recheck 3-player browser-hosted WebTransport, and make WebTransport the default again in deploy.md.
  - **Open for the user:** play-tests of 02-05, F3 and the above; F1 on hold; flaky checks (smoke Escape, persist reload-after-save under load); and offering `?data=` docs ("data from another server": CORS, trusted certificate, no login, Chrome local-network prompt, no file://) in deploy.md.
  - **Repo notes:** vnet's remote now has a `claude` branch, so this session's vnet branch `claude/keen-hamilton-ede0qw` can't be pushed; ask before using another branch name. The user's real server name appeared in a console log: never put it in the repo.
## 1. Set up

1. **Ask the user Q1 to Q5 (§4) first.** Q1 and Q2 block brief 00.
2. **Create the `claude` branch** from `master` and push it. All work branches from `claude`. Never commit directly to `claude` or `master`.
3. **Run brief 00** (§5) yourself or with one implementer. It is small and every other brief needs it.
4. **Network check:** confirm that github.com, proxy.golang.org (for the relay), the emsdk download hosts and the Q2 data URL are reachable from the session. If a host is blocked, tell the user which one; don't work around it.

## 2. What the code does (verify in brief 00)

> **Superseded.** Brief 00 verified this section; the verified facts, with file:line references and the corrections, are in [`code-facts.md`](code-facts.md). Read that instead. Corrections to the text below: `main` is in `jfbuild/src/sdlayer2.c` and calls `app_main` (`game.c:3372`); the player count does drop when players quit (it never rises); the open slot is assigned in `getpacket`, not `initmultiplayerscycle`; `grpscan.c` lists six GRPs, not four; the `USE_GLES2` define is in `jfbuild/include/build.h:20`; the shareware GRP caps a network game at 4 players and `MultiSharewareCheck` exits above that.

**Networking:** `jfbuild/src/mmulti.c` (1243 lines) behind `jfbuild/include/mmulti.h`.
- The game calls `initmultiplayersparms`, `initmultiplayerscycle`, `sendpacket`, `getpacket`, `flushpackets`, `uninitmultiplayers`, and reads the globals `numplayers`, `myconnectindex`, `connecthead`, `connectpoint2[]`, `networkmode`.
- One UDP socket, IPv4 and IPv6 (`sockaddr_storage`), default port `0x5bd9` (23513), `-p<port>`.
- `MAXPAKSIZ` is 256 bytes, well under vnet's 1100. `MAXPLAYERS` is 16. Resending and ordering are inside mmulti (the `ipak`/`opak` FIFOs, CRC16).
- Modes:
  - **Master/slave** (`-nm`, `-nm:N`): player 0 is the master. Open slots are filled from the first packet a newcomer sends; see "There's a slot to be filled" in `initmultiplayerscycle`.
  - **Peer-to-peer** (`-np` with a list of hosts).

**The game's network setup happens once, at startup:**
- `main` parses `-net …` (`src/game.c:3524`), or takes the desktop startup window's "join host" field (`HAVE_STARTWIN`, `game.c:3566-3590`, `startgtk_game.c:404`, `startwin_game.c:369`).
- `InitGame` (`game.c:901`) loops on `initmultiplayerscycle()` until everyone is in (`game.c:932-946`), before graphics load. It then fixes `CommPlayers`, `CommEnabled` and `NetBroadcastMode`.
- After that the player count never changes. Lockstep with sync checks is in `src/net.c` and `src/sync.c`, with many `waitforeverybody()` calls.
- The in-game "Network Game" menu (`src/menus.c:508-514`, `MNU_StartNetGame` at `menus.c:1994`) only sets options for a session that already exists. `ManualPlayerInsert` (`game.c:4086`) adds a local debug player, not a network one.
- **Player caps:** 4 on shareware, 8 on registered (`src/game.h:994-996`, `MultiSharewareCheck`).

**Loops:**
- `Control` (`game.c:2874`) runs `InitGame`, then `NewLevel()` until `QuitFlag`.
- `MenuLevel` (`game.c:2069`) and many nested `while (TRUE)` loops (`game.c:1730, 1816, 1876, 1993, 2178, 2818, 3126`) block, pumping `handleevents()` and `nextpage()`.

**Console:** jfbuild's OSD (`jfbuild/src/osd.c`). Game commands are registered in `src/osdcmds.c:149-156` (`restartvid`, `vidmode`, `quit`, `showfps`, `map`).

**Data:**
- `src/grpscan.c:43-48` lists the known GRP files by CRC32 and size:

  | File | Version | Size |
  |---|---|---|
  | `swshare.grp` | Shareware | 26,056,769 |
  | `sw.grp` | Registered | 47,536,148 |
  | `wt.grp` | Wanton Destruction | |
  | `tdragon12.grp` | Twin Dragon | |

- `ScanGroups` and `IdentifyGroup` (`game.c:3521`) check-sum every GRP on the search path (`addsearchpath`, `game.c:3392-3440`). The results are cached in `grpfiles.cache` by size and mtime.
- `SWGRP` (environment variable) and `-g<file>` (an extra GRP or ZIP) also exist.

**Renderer:** the `Makefile` has `USE_POLYMOST ?= 1` and `USE_OPENGL ?= 1` (lines 22-23). jfbuild has a `USE_GLES2` path (`jfbuild/src/glbuild.c:142`). With both off, the classic 8-bit software renderer draws through SDL2 (`jfbuild/src/sdlayer2.c`).

**Audio:** jfaudiolib has `driver_sdl.c`, `vorbis.c` and `driver_fluidsynth.c`. Music is `PlaySong` (`src/sounds.c:400`): CD tracks as Ogg files (`OggTrackName`), or MIDI.

**Demos:** `-dr<file>` records and `-dp<file>` plays back (with `-level#`). Use them for determinism checks, native against wasm.

**Build:** Makefiles only (`Makefile`, `Makefile.deps`, `Makefile.msvc`). There is no CMake.

## 3. Settled decisions

Don't reopen these inside a brief. If one proves wrong, stop and ask the user.

- **D1. The browser is the end goal.** The native Linux build must keep working, and native players must be able to join browser rooms.
- **D2. No joining mid-game.** The player count is fixed when the game starts, as it is today.
- **D3. "Join" and "Host" restart into a network game.** They don't convert a running session in place.
  - In the browser: reload the page with `?join=CODE` (or `?host=N`).
  - Natively: re-launch itself with the equivalent arguments.
  - `main` parses these exactly as it parses `-net` today. Nothing is torn down in-process.
- **D4. The transport is vnet `v0.4.0`** as a git submodule at `ext/vnet`.
  - Use `VNET_BACKEND_RELAY_AUTO`: WebTransport then WebSocket in the browser, the relay over UDP natively.
  - Keep `mmulti.h` unchanged: a vnet implementation sits behind it.
  - Plain UDP (today's `-net`) stays for native builds.
- **D5. Relay games use master/slave mode.** The room creator gets `10.0.0.1`, which is player 0, the master; joiners fill the open slots. Peer-to-peer mode over the relay is out of scope.
- **D6. The software renderer comes first.** WebGL through the GLES2 path is a later brief.
- **D7. The blocking loops stay.** The browser build uses Emscripten's ASYNCIFY, with a yield in the event or frame pump. Rewriting the game around `emscripten_set_main_loop` is out of scope.
- **D8. The page fetches the data.**
  - JavaScript downloads the GRP before `main` (URL from the page config, overridable with `?data=`), shows progress, and caches it in IndexedDB.
  - It writes the file into a folder on the game's search path, so the game's own GRP detection is unchanged.
  - A file picker covers people with their own copy.
  - No native downloader.
- **D9. The browser lobby is an HTML overlay** (room code, invite link, who has joined), not drawn by the engine. The console and menu entries lead to it.
- **D10. Git:** feature branches from `claude` and `--no-ff` merges. No pull requests unless the user asks; no force-pushes. GRP files and other game data are never committed.
- **D11. Licensing:** only the shareware GRP may be offered for public download by default. Hosting registered data is the user's call.
- **D12. Toolchain:** pin Emscripten 6.0.13, as Bit Riot does. Copy and adapt Bit Riot's `scripts/setup-emsdk.sh`.

## 4. Open questions (ask the user at the start)

- **Q1, blocking. Where do the submodules live?** jfbuild needs changes (`mmulti.c`, the SDL layer for Emscripten) and jfaudiolib probably does too. Options:
  - (a) **Recommended:** turn the three submodules into ordinary folders in this repo with `git subtree add`, keeping upstream history. It is one repo and one session, and upstream merges still work with `git subtree pull`.
  - (b) The user forks `jfbuild`, `jfmact` and `jfaudiolib` under `VenKamikaze`, and `.gitmodules` gets absolute URLs.
- **Q2, blocks testing from brief 02 on. Test data:** a URL for `swshare.grp` (or `sw.grp`) that this cloud session can reach, or another way to get it into the container. It must never be committed. Brief 01 can proceed without it.
- **Q3. "Start now":** should the host be able to start with fewer players than the number chosen, rather than waiting for every slot? It is a small change to the master's wait loop, but every client must learn the final count.
- **Q4. Music:** in scope (Ogg tracks through jfaudiolib's vorbis), or later? The default is later.
- **Q5. Upstream friendliness:** keep the changes easy to send upstream to jonof (new files, `#ifdef __EMSCRIPTEN__`, no reformatting)? The default is yes, where cheap.

Record the answers in `doco/browser/README.md`.

## 5. The briefs

Write each brief as `doco/browser/NN-short-name.md`. Each needs Goal, Scope, Out of scope, Acceptance criteria, Tests, Dependencies, Notes and an empty **Outcome** section. Keep a status table in `doco/browser/README.md`.

| # | Brief | Depends on | Can run alongside |
|---|---|---|---|
| 00 | Repo set-up, baseline, code facts | Q1 | |
| 01 | vnet transport for mmulti (native) | 00 | 02 |
| 02 | Emscripten port | 00, Q2 | 01 |
| 03 | Data download from a URL | 02 | 04 |
| 04 | Browser netplay | 01, 02 | 03 |
| 04b | Netcode lag cuts | 04 | |
| 04c | A tab hidden before the level's first frame (L19) | 04b | |
| 05 | Host and join from the game | 03, 04 | |
| 06 | Deployment guide | 05 | |

Later, not briefed: music (if Q4 says later), WebGL rendering, touch controls, the Wanton Destruction and Twin Dragon add-ons in the browser, mouse turns drawn between tics (view angle only), smoothing prediction corrections.

**00, set-up.**
- Settle Q1 and fix the submodules.
- Add `ext/vnet` at `v0.4.0`.
- Write `scripts/setup.sh` (SDL2, libvorbis, optional GTK3, Go for the relay) and `scripts/setup-emsdk.sh`.
- A green native build with `make`.
- `doco/browser/README.md` (status table, D1-D12, Q answers) and `code-facts.md` (§2, verified, with file:line).
- How to run the game headless for tests: `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy`, `-nosetup`, demos.
- vnet has no CMake requirement: see "vendoring without CMake" in vnet's `doco/integration.md`.

**01, vnet transport (native).**
- A vnet-backed mmulti, e.g. `mmulti_vnet.c`, chosen at runtime:
  - `-relay <url> -host-room <N>` creates a room and prints its code;
  - `-relay <url> -room <CODE>` joins one;
  - the plain UDP path is untouched.
- The room creator is master; joiners fill slots; host loss and timeouts behave as today.
- **Tests:**
  - (1) a harness test that links the mmulti layer alone: three instances on vnet's loopback backend with loss, duplication and reordering from vnet's impairment layer, exchanging numbered packets through the `mmulti.h` API;
  - (2) three native game processes headless through a local Go relay, playing a demo-scripted or `-autonet` game, with `sync.c` reporting no desync.
- Prove each test fails without the change.

**02, Emscripten port.**
- An Emscripten build target (Makefile or a small CMake, implementer's choice, documented).
- ASYNCIFY with the yields in the frame and event pump.
- Software renderer, keyboard and mouse (pointer lock), sound effects through SDL2 audio.
- Config and saves on IndexedDB (IDBFS).
- Start on a click, so audio is allowed.
- A shell page. Dev knobs only on `?test=1`.
- For this brief only, a dev way to load the GRP, e.g. `?data=` fetched into the search path with no cache. Brief 03 replaces it.
- **Tests:**
  - a Playwright smoke test (Chromium and Playwright are preinstalled; never run `playwright install`) that reaches the menu and checks the canvas is not blank;
  - a demo recorded natively that plays back in the wasm build with identical per-tick sync values (add a test-only hook to dump them);
  - frame time at 60 Hz.

**03, data download.**
- The proper loader from D8: a progress bar, an IndexedDB cache keyed by URL and size/ETag, a persisted `grpfiles.cache` (no re-checksum on reload), a file picker fallback, and clear errors (404, CORS, wrong or unknown file, quota).
- Document the server side: gzip or `mod_deflate`, CORS when cross-origin, cache headers.
- **Tests:** Playwright with a local HTTP server, covering first load, the cached second load (no network fetch), a corrupt or truncated file, and the file picker.

**04, browser netplay.**
- 01's transport in the wasm build with `RELAY_AUTO`.
- **Hidden tabs:** a lockstep game stalls everyone when one tab is hidden. Use vnet's wake callback and a `MessageChannel` to keep stepping, and send packets after every stepped frame, as Bit Riot's brief 12 did.
- Cross-play: native and browser players in one room.
- **Tests:** Playwright with a local Go relay, covering two browsers, a browser plus a native process, WebTransport and WebSocket, impairment, a hidden tab, and no desync across a full level. Prove the cross-play determinism holds, as in 02.

**04b, netcode lag cuts** (the user, 12 Nov 2026, after a read of `predict.c` and `net.c`). Prediction already makes your own movement local; what is left is when packets go.
- First a test-only measurement: the time from an input being made (`faketimerhandler`) to its tic running (`domovethings`), per machine, master and slave, with and without impairment.
- Send each input as soon as it is made, in every game: `faketimerhandler` calls `getpackets()` first, which often spends mmulti's 25 ms window (PAKRATE) on an ack, so the input waits for a later `dosendpackets` (brief 04's `mmulti_vnet_flush()` fixed this for hidden tabs only).
- The master forwards a tic as soon as the last input for it arrives (from `getpackets()`), not at its own next timer tick.
- Neither changes what is sent, so lockstep is unaffected; prove it with 04's `-testdump` agreement on every machine, browser and native, and show each change cuts the measured delay (mutation: undo it, the delay comes back).

**05, host and join from the game.**
- Console commands `host [players]` and `join <code>`, plus "Host Online Game" and "Join Online Game" in the menu.
  - Typing a room code into the original menus is the fiddly part; the console command comes first.
- Both restart into a network game per D3.
- The HTML lobby overlay per D9: room code, copyable invite link (`?join=CODE`), who is in, the wait for the rest, cancel.
- "Start now" if Q3 says yes.
- On desktop: the same commands re-launch the binary. The startup window gets a room-code field.
- Clear end-of-game and error states: host left, room full, bad code, relay unreachable.
- **Tests:** Playwright end to end through a local relay, from the menu or console to a finished network game, plus invite links and every error state.

**06, deployment guide.**
- `doco/browser/deploy.md`: Apache static hosting (wasm MIME type, compression, cache headers, the data URL), the relay behind Apache on `/vnet`, WebTransport on UDP 443 with a real certificate, which ports to open, and systemd.
- Reuse Bit Riot's `doco/netplay/deploy.md`. **Use placeholder host names and paths only** (`game.example.org`, `/srv/http/games/sw`); never the user's real ones.
- Validate it end to end in the container: Apache with TLS, the relay, two browsers and a native player.

## 6. Running each brief (the user's standard process)

1. **Branch** from `claude`: `browser/NN-short-name`.
2. **Implementer:** a Sonnet subagent. Give it:
   - the brief path, the repo and the branch;
   - "read `doco/browser/README.md`, `code-facts.md`, the brief and the Outcomes of its dependencies first";
   - the commit trailer lines this session's system reminder specifies;
   - "commit at each milestone and push the feature branch (only that branch) after each commit; never merge, never touch `claude`, never open a PR";
   - `-j4` builds (the container has 4 cores).

   Ask it to report: commit hashes, what changed, test results with counts, proof that the new tests fail without the change, and any concerns.
3. **Review:** a read-only Opus subagent, building in its own `git worktree`. It checks:
   - the acceptance criteria;
   - correctness;
   - determinism (native against wasm, and every machine in a room);
   - that the tests really fail without the change;
   - the untested glue.

   Findings are ranked blocking, should-fix or nit, each with file:line and a failure scenario, followed by a verdict. Give it the brief and the diff command, not your conclusions.
4. **Fix round:** send the worthwhile findings back to the **same** implementer (resume it). Re-review whenever a fix changes behaviour.
5. **Verify yourself:** rebuild, run every test, and read the fix diff.
6. **Merge:** `git merge --no-ff` into `claude`, then push `claude` and the feature branch.
7. **Record:** the status in the README table, the brief's Outcome filled in, and exact play-test steps for the user when a brief needs one (`done (play-test pending)`).
8. **Report** to the user in a few lines: what landed, the numbers, anything pending, and what's next. Keep a hand-off section at the top of this file (§0) up to date after every merge, so a fresh session can carry on.

Run 01 and 02 in parallel in separate worktrees, and share one emsdk install between them.

## 7. Rules and lessons (carried over from Bit Riot)

- **Tests:** never skip, loosen or quarantine one to get to green.
- **Network denials:** report a blocked host to the user; don't work around it.
- **A wrong brief:** if a brief is wrong about the code, fix the brief and `code-facts.md` in the same branch, and say so. Ask first if the scope would grow a lot.
- **Pushing:** push feature branches as soon as an implementer reports. The container can restart and kill background work. If a reviewer was interrupted, resume it rather than starting a new one.
- **Reviews find real bugs** even when every test passes, mostly in untested glue. Ask reviewers to try to break the tests: Bit Riot's first smoke test couldn't see a blank canvas.
- **Toolchain:** build-environment bugs hide behind a warm cache. When a brief adds a toolchain step, try it on a clean emsdk cache.
- **Browser details from Bit Riot:**
  - audio needs a user gesture;
  - dev knobs and test hooks belong behind `?test=1`;
  - the relay's `-origins` matches host:port exactly (a page on `:8443` needs `-origins localhost:8443`);
  - WebTransport needs a real certificate on UDP 443;
  - Chrome's intensive throttling of hidden tabs is the hard case for lockstep.
- **Don't change the game's simulation** (movement, AI, weapons) except where a brief needs it. Any change there risks desyncs between native and wasm, so the demo and sync checks must run after it.
- **The user's preferences:** Java is their main language, they run Arch Linux, they prefer open-source tools, and they like bash and Python for quick scripts. Give Arch commands (`pacman`) in play-test steps.

## 8. Kick-off

Ask Q1 to Q5. Create `claude`. Run 00. Then run 01 and 02 in parallel, and continue down the table, reporting to the user after each merge.
