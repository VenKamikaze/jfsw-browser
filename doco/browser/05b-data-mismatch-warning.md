# 05b: Warn every player when the players' game data differs (L26)

## Goal

When the players of a network game don't all have the same game data, every player is told who has what, and that the game will probably go out of sync. This covers a shareware against a registered GRP, a different add-on, and a modified or unknown GRP. The game is **not** refused: it goes on (the user's decision, 13 Nov 2026). The warning shows natively (console, log, the game's screen) and in the browser (the game's screen and the page).

Found on 13 Nov 2026: the user's deathmatch went out of sync at a respawn. They then reproduced it with one player on the registered `sw.grp` and the other on the shareware `swshare.grp`. Nothing told them the data differed.

## Dependencies

Brief 05 (the relay games, `netlobby.c`, the page overlay), F4 if it has merged (both touch `game.c` and `net.c`: rebase onto whichever merges first), and 02c if it has merged (the page).

## Read first

- [`README.md`](README.md); [`code-facts.md`](code-facts.md) §8 (sync) and §19 (the relay lobby); [`bugs.md`](bugs.md) L26; 05's Outcome; [`data-hosting.md`](data-hosting.md) (`?data=`, the file picker).
- The code:
  - `src/game.c`: `GameVersion` (about line 118), the shareware increment (about line 3768), `SendVersion` at each level start (about line 3099), `CheckVersion` (about line 3142), the `Player[]` reset that keeps `PlayerVersion` (about lines 1154-1157), `IdentifyGroup`/`DetectShareware` (about lines 3390 and 3631);
  - `src/net.c`: `SendVersion` (about line 469), `CheckVersion` (about line 485), the version packet's receipt (about line 1515), `getpackets`' `default:` (about line 1606);
  - `src/net.h`: `PACKET_VERSION` (about lines 116-120);
  - `src/grpscan.c`: `ScanGroups`, `GroupsFound()`, the known-GRP table;
  - `src/netlobby.c`: the page calls (`jfsw_page_lobby`, about line 130);
  - `web/jfsw.js`: the overlay, and the comment at about line 235 that says "the game would refuse mismatched data anyway". It is wrong; brief 05's N3 relied on it.
- The investigation, in the scratchpad (not the repo):
  - a GRP patcher, `dm-desync/scripts/modgrp.py`;
  - modified GRPs, `dm-desync/data/sw.grp` (one map differs) and `dm-desync/data/reg/sw.grp` (shareware detected as registered);
  - the pair runner, `dm-desync/scripts/pair2.sh` (`M_GRP`/`S_GRP` set each machine's GRP);
  - prototype test hooks, `dm-desync/prototype-hooks.diff` (`-testkill`, which kills a player at tic T on every machine).

## What is known (from the investigation; check it)

1. **Nothing compares the data.** mmulti, the relay lobby and `netlobby.c` exchange nothing about game data. The game's only check is `GameVersion`: 13, plus 1 for shareware (registered, Wanton Destruction and Twin Dragon are all 13). It is sent at every level start through the master. On a difference, `CheckVersion` logs `player N has version V, expecting W` and shows "You cannot play with different versions!" six times as quotes (about 4.5 s), then the game goes on. Any other mismatch (registered against an add-on, a modified GRP, user maps) gets nothing.
2. **`grpscan` already has the identity.** It computes a CRC32 for every GRP it finds and matches it against its table, but only to choose the variant. An unknown GRP falls back to `DetectShareware`.
3. **Reproduced, natively.** A master on a modified GRP against a slave on the original goes out of sync at the first deathmatch respawn, and not before:
   - with one map different, both report version 14 and nothing warns;
   - with shareware detected as registered, the version lines appear and the game goes on.

   The respawn spot is `RANDOM_RANGE(MAX_SW_PLAYERS)` (player.c:8162), where `MAX_SW_PLAYERS` is 4 for shareware and 8 for registered. Many other simulation branches depend on `SW_SHAREWARE` (sprite.c:6140-6325, weapon.c, track.c, `loadboard`), so a real mixed game can diverge anywhere.
4. **The suggested design.**
   - Each machine sends its data identity with the version at every level start: the main GRP's CRC32 and size, the edition name or "unknown", the add-on GRP's CRC if any, and optionally a `-map` user map's name and CRC. Use an extended `PACKET_VERSION` or a new packet type sent right after `SendVersion`.
   - It is stored per player next to `PlayerVersion`.
   - It is compared in `CheckVersion` after `waitforeverybody`.
   - Every machine prints one line per player whose data differs from its own. Old builds ignore the new data: an extended packet is read only as far as `Version`, and a new packet type falls into `default:`.

## In scope

1. **The exchange and the check,** as in known 4, or better if you find it.
   - Every machine must learn every other player's data, not only the master's.
   - Keep `GameVersion` as it is, so players with the same data don't get a version warning.
   - A peer whose build doesn't send the data is treated as unknown. Say nothing about its data, or one neutral line. Don't warn falsely.
   - Plain UDP and the relay alike; native and browser.
2. **The warning text.**
   - One line per differing player, naming what each has, for example: "Player 2 has different game data (Registered Version) from yours (Shareware Version): the game will probably go out of sync."
   - An unknown GRP shows its CRC: "(unknown data, CRC 1A2B3C4D)".
   - Replace the six "You cannot play with different versions!" quotes with the specific line(s). Keep a clear line of its own for a real build/version difference.
3. **Where it shows:**
   - native stdout, `sw.log` and the console;
   - the game's screen, long enough to read: the quotes last about 4.5 s, so use a longer-lived line or repeat it;
   - in the browser, also a notice on the page. Add an `EM_JS` call like `jfsw_page_lobby`, and a `Module.jfswNotice` banner in `jfsw.js` that stays until closed and works with the keyboard. A hidden tab misses the in-game quote.
4. **When:** at game start and at every level start, where the exchange happens. Not in the lobby, unless it turns out cheap.
5. **Different builds too** (the user, 13 Nov 2026: "if it's easy, also warn if builds differ"; bugs.md L30 on brief 06's branch).
   - Every build reports `GameVersion` 13 today, so nothing tells players that their builds differ. Brief 06 found a deliberate simulation difference goes on with only the host's "GAME OUT OF SYNC!", while the build from before brief 05 and the current one agreed on every tic.
   - Send the build's own version string alongside the data identity, for example `game_version` (`src/version-auto.c`, `git describe`) and any test-version salt.
   - When it differs, every machine shows a separate, milder line, for example "Player 2 runs a different build (X) from yours (Y): if the game logic differs, the game may go out of sync."
   - Don't refuse the game, and don't bump `GameVersion`: it is also the saved-game version.
   - If it turns out not to be easy, for example because the string can't be kept stable across builds whose game logic is the same, say why in the Outcome and leave it out.
6. **Correct the wrong claim:** `web/jfsw.js` about line 235, and 05's Outcome note N3. Also say in `data-hosting.md` (the file picker and `?data=`) that players with different data can join one game but will probably go out of sync.

## Out of scope

- Refusing such a game. The user decided against it.
- The mouse-aiming desync (F4).
- Making mixed data play in sync.

## Acceptance criteria

1. In a game whose players' data differs, every machine shows the warning naming the differing player(s) and what they have: master and slaves, native and browser. In the browser the page shows it too.
2. With the same data on every machine, nothing new is shown, apart from item 5's build line when the builds differ. Every existing scenario stays quiet.
3. A peer on an older build gets no false warning. Mixed old and new builds behave as before, apart from the new lines on the new ones.
4. Single player and demos are unchanged (`determinism.js`).
5. `netplay.js` (all scenarios), `make test GAME_RUNS=1`, `smoke.js`, `persist.js`, `data.js`, `grptable.js` and `determinism.js` pass. The known 100 ms stall check and persist's reload-after-save window under load are excepted: rerun those and report both runs.

## Tests

1. **Native, in `tests/net/`, in `make test-net`.**
   - Two games, one on a modified copy of the shareware GRP made by a test script from `testdata/swshare.grp` at run time. Never commit a GRP.
   - Check that both machines print the warning naming the other player, with the right descriptions.
   - Cover both kinds of difference: same variant with one map changed, and a different variant.
   - Check that matching data prints nothing.
   - Add a 3-player game in which only one player differs, if cheap: every machine names that player.
2. **Browser:** a `netplay.js` scenario, browser plus native, one with modified data. Check the page's notice appears, and doesn't appear with matching data.
3. **Old against new:** if practical, an old build (before this brief, built in a worktree) against a new one. No crash, no false data warning, and the old one behaves as before. Brief 04c's `old-new` scenario shows how to run two builds.
4. **Mutation:** without the check, the tests fail.
5. **Regression,** as in criterion 5.

## Notes

- **Repos touched:** jfsw-browser (game and page). jfbuild should not need changes. If it does, use a branch of the same name in the fork, as brief 05 did.
- **Branch:** `browser/05b-data-mismatch-warning` from `claude`.
- **Ports:** away from the other agents'; use 497xx.
- **Records to update:**
  - `bugs.md` L26;
  - `code-facts.md` (the version packet and the data identity);
  - `building.md`;
  - `data-hosting.md`.
- **Play-test steps** for the user (Arch) in the Outcome:
  - Edge or Chromium with the server's shareware data, Firefox with a registered `sw.grp` from the file picker. Both players see the warning, in the game and on the page.
  - Then both on the same data: no warning.

## Outcome

**Status: review.** Implemented 14 Nov 2026 on `browser/05b-data-mismatch-warning` (from `claude` `08b0ca3`).

**Commits:**
- `58149ee`: the packet's definition (work in progress at the token limit);
- `57293ab`: the exchange, the check, the page's notice and the tests;
- `9ff8da5`: docs;
- `3306647`: a smaller packet, and `waitforeverybody()` flushes its ready (below);
- then this Outcome.

### What "What is known" said, checked

1. **Confirmed.** mmulti, the relay lobby and `netlobby.c` exchange nothing about data. `GameVersion` (game.c:118) is 13, plus 1 for shareware (game.c, after the GRP is chosen). `CheckVersion` logged and showed six quotes, then went on.
2. **Confirmed.** `ScanGroups()` has every GRP's CRC32 and size (cached in `grpfiles.cache`). `IdentifyGroup()` returns NULL for a GRP it does not know, and the game then uses `DetectShareware()`. `FreeGroups()` runs right after, so the identity has to be taken before it.
3. **Reproduced in the investigation;** the new test plays the same two copies. The respawn mechanism is as described (player.c:8162).
4. **Done as suggested,** with a new packet type rather than an extended `PACKET_VERSION`. An older build drops an unknown type silently, and a new build can tell "not sent" (unknown) from "sent and different".

### What changed

**The exchange** (net.c, net.h, game.c):
- `NetDataIdentity()`, from `app_main` before `FreeGroups()`, records this machine's data identity:
  - the main GRP's CRC32 and size (for an add-on, the registered GRP it needs);
  - the add-on's CRC32 and size;
  - the known edition's name, or "" for a GRP grpscan does not know;
  - `game_version` (`git describe`);
  - the new build id.
- `SendDataIdentity()` broadcasts it as `PACKET_TYPE_DATA_ID` (39) right after `SendVersion()`, at every level start. In master/slave mode a slave's packet reaches the others through the master's proxy, as the version does, so every machine learns every player's identity.
- The receiver keeps each player's identity for the whole session.

**The check:** `CheckVersion()`, per other player.
- The log line `CheckVersion(): player N has version V, expecting W` is kept when the versions differ.
- Then one of:
  - "Player N has different game data (theirs) from yours (mine): the game will probably go out of sync.", or
  - "Player N runs a different version of the game (V) from yours (W): the game will probably go out of sync.", when only the version differs, for example an older build with shareware against registered data.
- Separately, when both build ids are known and differ: "Player N runs a different build (theirs) from yours (mine): if the game logic differs, the game may go out of sync."
- An unknown GRP shows as "unknown data, CRC 1A2B3C4D". A player that sent no identity, an older build, is never named.
- The six "You cannot play with different versions!" quotes are gone.

**Where it shows:**
- `buildprintf`: stdout, `sw.log` and the console.
- The game's screen: each line as two quotes, because about 60 characters fit one line. They stay 15 s instead of 4.5 s.
- In the browser, also the page: `NetPageNotice()` (netlobby.c, `EM_JS`) calls `Module.jfswNotice(text)`. The new `#notice` (index.html, jfsw.css, jfsw.js, next to brief 02c's error handling) sits below the picture, in the lobby overlay's style, with `role="alert"`.
  - It stays until its Close button is pressed.
  - When it first opens, Close takes the focus and the keys stay with the page while the focus is there: Enter or Space presses Close, Escape closes it, and the game then gets the keyboard back.
  - The same text at the next level start does not open it again.
- **When:** at the start of every level, network games only. Not in the lobby: the lobby has no game packets yet. The identity would have to go into mmulti's or the relay's lobby messages, which means jfbuild and vnet changes, and that is not cheap.

**Item 5, the build line: easy, done.**
- `git describe` alone changes with every commit, docs included, so it would name builds whose game code is the same. The line therefore compares a build id: `scripts/build-id.sh`, from the `Makefile`'s `version-auto.c` rule, the same for the native and the wasm builds. It is the git tree of `src/` and the commits of jfbuild, jfmact and jfaudiolib, with `+` for changes that are not committed.
- Commits that change only docs, tests or the page keep the id. Any change to the game code changes it, test hooks included, because they live in `src/`.
- What the line shows is the two `git describe` strings ("... with local changes" for a `+`).
- Without git the id is empty and nothing is said about builds.
- `GameVersion` is not changed, and the game is never refused.

**A side effect, found and fixed: the packet's size.** The first version of the packet (162 bytes) made `netplay.js tic1` fail in 3 to 4 of 8 games. The build before 05b, and 05b with the packet left out, both passed 8 of 8.
- **The cause.** mmulti puts at most about 214 bytes of packets into one datagram (`MAXPAKSIZ` 256), and every unacknowledged packet goes again with the next ones. At a level start the data packet and the options packet no longer fit together, so the master's ready went only after its earlier packets were acknowledged. A master that then stopped reading the network held the slave for 3 s: that is `tic1`'s `-testslowstart`, and could be a long precache in a real game.
- **The fix, two parts.**
  - The packet is now 110 bytes, with strings of 28, 24 and 40 bytes.
  - `waitforeverybody()` flushes its ready packet when it queues it (`mmulti_vnet_flush()`, as `SendInputNow()` does for inputs), so the ready no longer waits for mmulti's 25 ms window.
- **Checked.** `tic1` passes 8 of 8, and natively 5 of 5 slow-start pairs had the uneven start.

**The wrong claim** is corrected in `web/jfsw.js` (the invite link's comment), in 05's N3 and in `data-hosting.md`, which now says that players with different data can join one game but will probably go out of sync, and are told so.

### Tests

**`tests/net/test-data-mismatch.sh`** (in `make test-net`; ports 49700 to 49705 from `JFSW_TEST_PORT_BASE=49600`). The modified GRPs are made at run time by `tests/net/modgrp.py` from `testdata/swshare.grp` and are never kept.

| Game | Setup | What every machine must print |
|---|---|---|
| `match` | both on the shareware GRP | nothing at all |
| `map` | the host's copy has one map changed (the same variant: the old version check saw nothing) | both name the other's data: "Shareware Version" against "unknown data, CRC B5284941" |
| `variant` | the joiner's copy is taken for registered data; plain UDP | both name the data, and the `CheckVersion()` log line appears (13 against 14 with the salt) |
| `three` | three players, only the second differs | players 1 and 3 name player 2; player 2 names players 1 and 3 |
| `build` | same data; the joiner reports another build (`-testbuildid`) | the build line on both, nothing about data |

Every game also ends with status 0 and plays its 200 tics.

**`netplay.js data-mismatch`:**
- **Games.** A browser host on the page's shareware data against a native joiner on the map copy; a native host on the copy against a browser joiner; a browser and a native on the same data.
- **Why the copy is native.** The page accepts only GRPs it knows (data.js `verify`), so the modified data has to be on the native side.
- **What it checks.** The lines on every machine. The page's notice text equals the lines, Close had the focus when the notice opened, and Close closes it. With the same data there are no lines and no notice.
- **Every other scenario.** `checkGame()` now also requires every other game in every scenario to print none of these lines and to show no notice. Build lines are excepted when a machine runs another build (`NETPLAY_SW`, `WASM_DIR`, an old one).

**Old against new.** A native build of `claude` `08b0ca3` (before 05b, in a worktree) hosted a game with this build joining (`--old-sw`), with different data (the map copy) and with the same data:
- both ended with status 0 and played every tic;
- the new build printed nothing about the old one's data or build;
- the old build printed nothing either.

`test-udp-unchanged.sh` (in `make test`) also mixes the pre-brief-01 build with this one over UDP, and passed.

**Mutations** (the data packet never sent):
- **Native:** `test-data-mismatch.sh` failed 11 checks. `map`, `three` and `build` printed nothing. In `variant` the version line came instead of the data line, which is what an older peer would get. `match` passed.
- **Browser:** `netplay.js data-mismatch` with the mutated wasm and native failed 10 checks: the lines and the page's notice were missing in both mismatched games, and the matching game passed.

### Test results (rebuilt from clean: native 14 warnings as before, wasm; one test at a time; `JFSW_WEB_PORT_OFFSET=1400`)

| Test | Result |
|---|---|
| `tests/net/test-data-mismatch.sh` | PASS (5 games, 42 checks); `--old-sw` (the `claude` build before 05b) `old-map` and `old-match`: PASS |
| `netplay.js` (every default scenario, `data-mismatch` included) | first run, with the 162-byte packet: 1688/3, all 3 failures in `tic1` (see "A side effect"); rerun of `tic1` alone 189/4; `tic1` on the build before 05b 153/0, and without the packet 169/0. After the fix: `tic1` 193/0, then the full run **1691/0** (30 minutes, load 2.1 to 6.5) |
| `make test GAME_RUNS=1` | 10 PASS (now including `test-data-mismatch.sh` and F4's `test-mouse-aim.sh`), 0 FAILED; `test-draw` 16/0; 12 minutes |
| `determinism.js` | 20/1 in both runs: only the known "no stall over 100 ms" (max 174 ms, then 267 ms). The native `.dms` equals the committed `jfsw1.dms` both times, and native and wasm are identical. |
| `smoke.js` | 29/0 on the first build. On the final build, 7 runs: the first two (right after `determinism.js`) failed one check each, a menu cursor check ("Up moves it up", then "Down moves the menu cursor down"), and the next five passed 29/0. The build before 05b passed 4 of 4. Single player does not reach any code this brief changed apart from start-up's `NetDataIdentity()`, so I take it for the cursor check's timing, but it is noted under Concerns. |
| `persist.js` | 15/0, twice |
| `data.js` | 172/0, twice |
| `grptable.js` | 8/0, twice |
| `focus.js` (02c) | 24/0, twice |

### Play-test on Arch Linux (the user)

1. **Build.**

   ```bash
   sudo pacman -S --needed base-devel pkgconf git unzip python go sdl2 libvorbis libogg mesa glu alsa-lib gtk3 firefox chromium
   git fetch origin && git checkout browser/05b-data-mismatch-warning && git submodule update --init
   make veryclean && make -j4
   scripts/setup-emsdk.sh && scripts/build-wasm.sh
   scripts/fetch-test-data.sh                    # testdata/swshare.grp
   (cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
   ```

2. **Relay and page.** In `build-wasm/config.js`, set `relay: 'ws://127.0.0.1:7778/vnet'`. Then, in two terminals:

   ```bash
   /tmp/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v
   cd build-wasm && ln -sf ../testdata/swshare.grp . && python3 -m http.server 8000 --bind 127.0.0.1
   ```

3. **Different data.**
   - Edge or Chromium: open `http://127.0.0.1:8000/?host=2`. The page downloads the shareware data. Click to host.
   - Firefox: open the invite link (`?join=CODE`). Before clicking to join, choose "Use your own copy of the game data..." and pick your registered `sw.grp`. Then join.
   - The host starts a game (deathmatch or co-op, E1L1).
   - At the level start both windows must show, on the game's screen for about 15 s, two lines such as "Player 2 has different game data (Registered Version) / from yours (Shareware Version): it will probably go out of sync."
   - Below the picture, both pages must show a red-edged notice "The players' game differs" with the full sentence. It stays until you press its Close button; press Enter, Space or Escape at once, or click Close later. Without being closed it is still there after a minute.
   - The game goes on. In a deathmatch it will probably go out of sync at the first respawn ("GAME OUT OF SYNC!" on the host): that is what the warning is about.
4. **Native against the browser** (optional): with the registered data in `~/.jfsw/`, run `./sw -net -relay 127.0.0.1:7777 -room CODE --` against the browser host. The native game prints the line in its terminal and `~/.jfsw/sw.log`, and shows it on its screen.
5. **Same data.**
   - In Firefox, choose "Use the download instead" (or clear the site's data), so both have the shareware data. Play again: no lines and no notice.
   - Do the same with both on the registered data: still nothing.
6. **The tests on your machine:** `tests/net/test-data-mismatch.sh` (about 1.5 minutes) and `node tests/web/netplay.js data-mismatch`.

### Concerns

- **`smoke.js`.** It failed a menu-cursor check in 2 of 7 runs on the final build, the first two, right after `determinism.js`, and passed 5 in a row after that. The build before 05b passed 4 of 4. I found no path from this brief's changes to the single-player menu, but the count is small. A second pair of eyes on a few more runs would settle it.
- **`waitforeverybody()` now flushes its ready.** That changes when a datagram goes (earlier), not what is in it. The full `netplay.js` and `make test` passed with it.

- **The page refuses unknown data.** It accepts only GRPs it knows. So in the browser the only real mismatches are known editions against each other: shareware, registered, and the Mac versions (Wanton Destruction is not started yet). The browser test therefore puts the modified copy on the native side.
- **The build id and local edits.** It does not tell two different sets of uncommitted changes apart: both are `<id>+`. It does tell a modified build from a clean one.
- **A mid-game join** is not possible, so the per-session identity is enough.
- **User maps** (`-map`) are not part of the identity (optional in the brief). Players on different user maps are not told.
