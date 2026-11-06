# Kick-off prompt: Shadow Warrior in the browser, with vnet netplay

You are the **coordinator** for a multi-brief project in [`VenKamikaze/jfsw-browser`](https://github.com/VenKamikaze/jfsw-browser), a fork of [jonof/jfsw](https://github.com/jonof/jfsw) (JonoF's Shadow Warrior port, C, SDL2, Build engine). This file is meant to live at `doco/browser/PROMPT.md` in that repo.

**The goal:** Shadow Warrior playable in a browser (Emscripten/WASM), with the game data downloaded from a URL on startup and online multiplayer over [vnet](https://github.com/VenKamikaze/vnet) (`v0.4.0`, MIT, a virtual-UDP library plus a Go relay). Players host or join a game by room code, from the in-game menu or the console. Desktop (native) players can join the same rooms. Joining a game already in progress is **out of scope**.

vnet was built for the same job in [`VenKamikaze/BitRiot`](https://github.com/VenKamikaze/BitRiot): see that repo's `doco/netplay/` (briefs 09, 12 and `deploy.md`) and vnet's `doco/integration.md`. Reuse what was learnt there; don't copy Bit Riot code wholesale.

## 0. Where things stand (hand-off; keep this up to date after every merge)

**6 Nov 2026: Q1 to Q5 answered, `claude` branches created, brief 00 in progress.**

- **Answers** are recorded in [`README.md`](README.md): submodules stay, on the user's forks (Q1 b); shareware data from a verified mirror (Q2); "Start now" is in (Q3); music later (Q4); upstream-friendly where cheap (Q5, default).
- **Repos:** the work spans four GitHub repos, all attached to the session with push access: `VenKamikaze/jfsw-browser` (this one), and the forks `VenKamikaze/jfbuild`, `VenKamikaze/jfaudiolib` and `VenKamikaze/jfmact`. The forks existed already (this prompt originally said they didn't), and they contain the commits jfsw pins.
- **`claude` branches:** jfsw-browser at `befcdd0` (= `master`), jfbuild at `40a98be` and jfaudiolib at `68be97f` (the commits jfsw pins; the forks' `master` branches are newer). **jfmact has no `claude` branch:** the remote already has `claude/keen-hamilton-ede0qw`, and git cannot hold `claude` next to `claude/…`. jfmact stays on `master` at `731c0cc` until a brief needs to change it; then ask the user whether that stale branch can be deleted.
- **Multi-repo git rules** are in the README ("Working across repos").
- **Test data:** `scripts/fetch-test-data.sh` (brief 00) downloads and verifies the shareware GRP. The source is `https://image.dosgamesarchive.com/games/3dsw12.zip` (MD5 `d77564e8764feeb1509dd0d534fb8952`); `web.archive.org` resets connections from the cloud container, `archive.org/download/3dsw12/3dsw12.zip` is the same file.
- **Bit Riot reference material** is on Bit Riot's `claude` branch, not `master`. Fetch it by URL (`git fetch https://github.com/VenKamikaze/BitRiot claude`) if the local clone has a `claude/…` remote branch, which blocks a plain fetch.
- **Next:** finish 00, then 01 and 02 in parallel.

## 1. Set up

1. **Ask the user Q1 to Q5 (§4) first.** Q1 and Q2 block brief 00.
2. **Create the `claude` branch** from `master` and push it. All work branches from `claude`. Never commit directly to `claude` or `master`.
3. **Run brief 00** (§5) yourself or with one implementer. It is small and every other brief needs it.
4. **Network check:** confirm that github.com, proxy.golang.org (for the relay), the emsdk download hosts and the Q2 data URL are reachable from the session. If a host is blocked, tell the user which one; don't work around it.

## 2. What the code does (verify in brief 00)

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
| 05 | Host and join from the game | 03, 04 | |
| 06 | Deployment guide | 05 | |

Later, not briefed: music (if Q4 says later), WebGL rendering, touch controls, the Wanton Destruction and Twin Dragon add-ons in the browser.

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
