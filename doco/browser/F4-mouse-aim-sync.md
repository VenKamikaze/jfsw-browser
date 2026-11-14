# F4: Toggling mouse aiming mid-level desyncs the game (L25)

## Goal

A player who turns mouse aiming on or off during a network game changes it on every machine at the same tic. Then a game never goes out of sync because of it, natively or in the browser. The fix is small and upstream-friendly, on a branch from `master`, and goes into `claude` through an integration branch, as F3 did.

Found on 13 Nov 2026 by the investigation of the user's deathmatch desync ("GAME OUT OF SYNC!" on the host only, play carried on). The user's game also had mismatched game data (brief 05b), so it is not proven that this was the cause there. It is a real desync of its own, reproduced every time.

## Dependencies

F3 (for the tests: `-testdump`, `-teststate`, `stateDifferences()`), and brief 05's test hooks.

## Read first

- [`README.md`](README.md): "Bugs found in the original game" (the policy), "Working across repos".
- [`bugs.md`](bugs.md): L25.
- [F3](F3-level-exit-tics.md): the model for a fix brief (upstream check, fix branch, integration branch, Outcome).
- `code-facts.md` §8 (sync).
- The investigation's prototype hooks: `-testaimflip<T>` and `-testslope<T>,<P>`, as a diff in the scratchpad at `dm-desync/prototype-hooks.diff`, with the runner `dm-desync/scripts/pair2.sh`. Reuse them or write your own.
- The code:
  - `src/game.c` `getinput` (about lines 5240-5290: the Mouse_Aiming key, `gs.MouseAimingOn`, `PF_MOUSE_AIMING_ON`);
  - `InitNetPlayerOptions` (about line 3115) and `PACKET_TYPE_PLAYER_OPTIONS` (net.c about line 1540);
  - `src/player.c` `PlayerAutoLook` (about line 1811) and `DoPlayerHorizon` (about lines 1940-1975);
  - the `SK_*` input bits (`src/game.h`) and how they are packed and sent (`net.c`, `TEST_SYNC_KEY`);
  - demo recording and playback (`demo.c`).

## What is known (from the investigation; check it)

1. **The flag is set locally.** The Mouse_Aiming key (U) flips `PF_MOUSE_AIMING_ON` in the local player's `Flags` inside `getinput`: game.c:5249/5257 in held mode, and 5267 in toggle mode, the default.
2. **The others learn it late.** They learn the flag only from `PACKET_TYPE_PLAYER_OPTIONS`, which `InitNetPlayerOptions` sends once per level.
3. **The simulation reads it.** `PlayerAutoLook` (player.c:1811) reads the flag. On a sloped floor, a player without mouse aiming gets `horizoff` adjusted, and `horiz = horizbase + horizoff`. Once the flag differs between machines, that player's `horiz` differs the next time they stand on a slope. `horiz` is in `PlayerSync2`, so the production one-byte mode shows "GAME OUT OF SYNC!" on the host only. It is small, so play goes on.
4. **Reproduced.** One machine toggles at tic 100 (`-testaimflip100`); every machine then puts that player on a slope at tic 300 (`-testslope300,P`). It fails 3 of 3, whether master or slave toggles. The first difference is at tic 301, in `PlayerSync2`: `horizoff` is 0 on one machine and 6 on the other, and `Flags` differs by `0x40000000`. The control game, without the toggle, stays in sync.
5. **Upstream.** jonof/jfsw `master` (`befcdd0`) has the same code (game.c:5041-5073, player.c:1811, net.c:1446). Check its open pull requests too.
6. **The suggested fix.** Send the flag's *state* with every input, in a free input bit (bit 28, a new `SK_MOUSE_AIM`; check that it is free). `getinput` keeps `gs.MouseAimingOn` and the local mouse mapping, but stops writing `pp->Flags`. The simulation then sets or clears `PF_MOUSE_AIMING_ON` from that bit for every player, at a fixed point in the tic. Re-sending the options packet would not work: it arrives at a different tic on each machine.
7. **Side findings** (record them in `bugs.md`, out of scope here):
   - the sound-gated `RANDOM_RANGE` calls in `miscactr.c` (about lines 185 and 232);
   - `PachinkoCheckWin` (miscactr.c:837) using `Player+myconnectindex`;
   - `PLAYER_RUN_LOCK` (player.c:117), where one player's autorun toggle flips the global `gs.AutoRun`.

## In scope

### 1. Upstream check
- Check jonof/jfsw `master` and its pull requests, with commit ids. If upstream fixed it, take its fix.

### 2. The fix, on `fix/mouse-aim-sync` from `master`
- Make the mouse-aiming state part of each player's synced input, applied in the simulation at the same tic on every machine.
- **Demos and single player must not change.**
  - `determinism.js`'s `.dms` must stay identical, and so must the playback of demos recorded before the fix.
  - Decide whether the bit applies in single player and in demos. One option: only when `CommEnabled`, with the old local behaviour kept otherwise.
  - Say why your choice is right.
- **Old and new builds in one game.**
  - A peer without the fix never sends the bit, and its players' flags would be cleared on new machines. Decide between bumping the net version (`GameVersion`, or the test-version salt mechanism, so mixed builds are told) and accepting it. Say why.
  - Keep plain UDP and the relay alike.
- Check every other place that reads or writes `PF_MOUSE_AIMING_ON` (grep it):
  - the options packet;
  - the "Mouse Aiming Off" look nudge (`SK_LOOK_UP`);
  - the menus' mouse-aiming setting;
  - `gs.MouseAimingOn` at level start.

  Make them consistent with the new rule.
- Keep it small, with a commit message written for upstream, and no session trailers on the fix commit. F3's carried them and the user may want a clean copy for upstream, so for this fix commit end with only `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; integration and test commits keep both trailers. It must apply cleanly to upstream `master`: check with a cherry-pick, as F2 and F3 did.

### 3. Integrate
- Branch `browser/F4-mouse-aim-sync` from `claude` and merge `fix/mouse-aim-sync` into it.
- Add the test-only hooks there, not on the fix branch: `-testaimflip<T>`, `-testslope<T>,<P>`, or your own versions.
  - They change behaviour only when given.
  - They go in the version salt where they change the simulation, as the other test hooks do.
  - Document them in `building.md`.

## Out of scope

- The data-mismatch warning (brief 05b).
- The side findings (record only).
- Any other desync, and F1 (on hold).

## Acceptance criteria

1. Toggling mouse aiming at any tic, by any player, master or slave, never desyncs a game: native and browser, over the relay and UDP. That includes standing on slopes afterwards and the toggle at a level change.
2. The mouse-aiming behaviour each player sees is unchanged: the toggle still takes effect for the player at once, as far as they can tell. Say how many tics of delay the input path adds, if any.
3. Single player and demos are unchanged (`determinism.js`).
4. `netplay.js` (all scenarios), `make test GAME_RUNS=1`, `smoke.js`, `persist.js`, `data.js`, `grptable.js` and `determinism.js` pass. The known 100 ms stall check is excepted, and persist's known reload-after-save window under load: rerun and report both runs.

## Tests

1. **Regression, native, in `tests/net/`, in `make test-net`.** Two games; one toggles at tic T; the toggling player then stands on a slope; no `OUT OF SYNC`, and identical `-testdump` records.
   - Cover master toggling and slave toggling.
   - Cover held mode and toggle mode, if both are reachable from a test.
   - Cover a toggle in the tic of a level exit or at a level start, if cheap.
2. **Browser:** a `netplay.js` scenario, browser plus native, with the same check.
3. **Mutation:** without the fix, both tests fail. Report how often (the investigation saw 3 of 3).
4. **Regression,** as in criterion 4.

## Notes

- **Repos touched:** jfsw-browser only.
- **Ports:** away from the other agents' (briefs 06 and 02c may still be running; their ports are in the 483xx range). Use 496xx, and say which.
- **Records:**
  - `bugs.md`: L25 fixed in F4, plus the side findings as new entries;
  - the README's fix table (F4 row);
  - `code-facts.md` (the input bits and the flag);
  - `building.md` (the new hooks and test).
- **Play-test steps** for the user (Arch, `pacman`) in the Outcome: a two-player game, one player presses U a few times and walks over slopes and stairs, and the host must never show "GAME OUT OF SYNC!". Do it browser against browser and native against browser.

## Outcome

**Status: review.** Implemented 13 Nov 2026, with a fix round after the review on the same day.

**Commits:**
- `fix/mouse-aim-sync`, from `master` `befcdd0`; both commits carry only the `Co-Authored-By` trailer:
  - `5eec5fa`: the fix;
  - `dace2e9`: the review's nits (the prototype in `player.h`, `MouseAimInInput[]` cleared in `InitGame`).
- `browser/F4-mouse-aim-sync`, from `claude` `ee49c57`:
  - `72d1455` and `a60d096`: merges of the fix branch;
  - `d17c456`, `0eddf6f`, `9122c00`: hooks and tests;
  - `d947c8a`: docs;
  - `1cf7c63`: the fix round;
  - `5af93ee`: merge of `claude` (briefs 06 and 02c);
  - then this Outcome.

### Upstream check

`jonof/jfsw` `master` is still `befcdd0` (`git ls-remote`, 13 Nov 2026), with the code as described in "What is known". It has 18 pull requests (`refs/pull/*/head`, fetched into a bare clone in the scratch directory):
- #1, 2, 4, 23, 24 and 37 are merged into `master`;
- #5, 6, 9, 19, 29 and 44 to 50 are not.

None adds or removes a line with `PF_MOUSE_AIMING_ON`, `MouseAiming`, `Mouse_Aiming`, `PlayerAutoLook`, `SK_MOUSE` or `horizoff`. #5, #19, #46 and #47 touch `game.c`, all elsewhere (the startup window, music, the GRP list). Not fixed upstream.

**Cherry-pick check.** Both fix commits were cherry-picked onto `befcdd0` in a fresh clone of `jonof/jfsw` (`8da4da0` and `025149e` there), with no conflict. That clone was built with its own submodules (jfbuild `40a98be`, no relay code): green, 14 warnings as before. The review also checked `git am -3`.

### The fix, and why

"What is known" 1 to 4 were checked and hold. Bit 28 of `SW_PACKET.bits` was unused: grep for `SK_*`, `BIT(28)` and `1<<28`; the review confirmed this. Every reader and writer of `PF_MOUSE_AIMING_ON` is listed in code-facts §21.

- **Input.** In a network game (`CommEnabled`), `getinput()` (game.c) keeps the player's own state in `gs.MouseAimingOn` only. That covers the toggle, held mode and the "Mouse Aiming Off" `SK_LOOK_UP` nudge, all as before. It sends the state in every input as the new `SK_MOUSE_AIM` (bit 28, game.h). The bit is set right after `loc->bits` is cleared, before any early return, so it is in every input made.
- **Simulation.** `DoPlayerMouseAimSync()` (player.c) sets or clears each player's flag from that bit. `domovethings()` calls it right after copying the inputs, which is the same tic on every machine. `DoPrediction()` (predict.c) calls it for its copy of the local player.
- **What the player sees.** The mouse's Y axis follows the key at once, as before.
  - The simulation sees the change in the tic that plays that input, like any other key. The input path adds no tic of its own.
  - The local view shows the change at once, because prediction applies it from the first predicted tic.
  - Before the fix, the simulation on the player's own machine saw it up to one input-to-tic delay earlier (code-facts §16). That was the bug: the other machines never saw it at all.
- **`ChopsCheck()`** (single player: the hands come up after 30 s without input) masks the bit out, so that it never counts as a key.
- **Options packet.** It gains a last byte, `MouseAimInInput`; see "Mixed builds".

**Single player and demos** (decision): when `CommEnabled` is false, `getinput()` sets the flag directly as it always did and never sends the bit. So single-player play, demo recording and demo playback are byte for byte as before: the native `.dms` equals the committed one (`determinism.js`). A demo recorded during a network game carries bit 28 in its inputs, and playback (`CommEnabled` false) ignores it. Applying the bit outside network games would have changed nothing for the better, and would risk old demos: they lack the bit, so playback would clear the flag.

**Mixed builds** (decision): no net-version bump, but the options packet tells newer machines who sends the bit.
- **Why not bump `GameVersion`.** It is also the saved-game version (save.c: `SaveGame` writes it, `LoadGame` refuses any other). A bump would make every saved game unloadable, which is a high price for a network-only fix. A salt-like change to the exchanged version only would make every mixed game report "You cannot play with different versions!" and then carry on in the same state.
- **What the packet does.** An older build sends a packet one byte shorter. The newer machines then leave that player's flag to the options packet (`MouseAimInInput[]`, net.c), exactly as an older build does.
- **Result.** A game of older and newer builds behaves as an older one: in sync until any player toggles mid-level, then out of sync at the next slope, as in the original game. An older build never reads the bit, so it misses a newer player's toggle as well.
- **Why the byte matters.** Without it, the newer machines would clear the flag of an older-build player who had mouse aiming on from the start. That game would go out of sync on the first slope with nobody touching a key. `oldjoin` below shows exactly that.
- **Transports.** Plain UDP and the relay behave alike: the packets are the same.

**Every other use of the flag**, made consistent:
- The options packet still carries `MouseAimingOn`: the flag at the level start, which is also what an older build uses.
- `InitPlayerGameSettings()` still sets the local flag from `gs.MouseAimingOn` at each level start. The first input of the level carries the same value.
- The menus change only `gs.MouseAimingType`. Held mode and toggle mode both go through `getinput()`.
- `gs.MouseAimingOn` is saved in `sw.cfg` as before.
- A toggle in the input of a tic after a level exit is never played. The next level starts from `gs.MouseAimingOn`, on every machine.

The change is 51 lines in 6 files (`5eec5fa`), plus 5 in `dace2e9`.

### Integration and tests

New test-only hooks (sync.c; building.md §6.5; code-facts §21):
- **`-testaimkey<T>[,<N>[,<L>]]`:** this machine's Mouse_Aiming key is down for the inputs of tics T to T+N-1 of the L-th level. `getinput()` reads it with the real key.
- **`-testaimheld`:** held mode.
- **`-testaimon`:** mouse aiming on from the start.
- **`-testoldaim`:** this machine handles mouse aiming as a build without the fix (no bit, the short options packet, no flag taken from the input). It stands in for an older build; given to every machine, it is the old game.
- **`-testslope<T>,<P>[,<L>]`:** every machine puts player P, standing still, in the middle of a sloped sector at tic T. Since the fix round the player faces along the slope, so the view tilts on any level. This hook is in the version salt; the others are per machine and change only inputs or local settings.

`JFSW_WEB_PORT_OFFSET` (tests/web/lib.js) moves every port the browser tests use. That includes brief 02c's `focus.js` and `firefox.js`. 02c's `NETPLAY_PORT_BASE` still overrides it for `netplay.js`. The runs here used offset 1300 (`netplay.js` 49600 to 49699, the rest 494xx and 495xx) and `JFSW_TEST_PORT_BASE=49600` (49660 to 49665).

**`tests/net/test-mouse-aim.sh`** (in `make test-net`): 10 games of two natives, co-op without monsters. Most go through the relay; `slave` goes over plain UDP with 80 ms latency.

| Game | What it does |
|---|---|
| `control` | nobody presses the key; the slope tilts the view on both machines |
| `master` | the host toggles at tic 100, then is put on a slope at tic 300 |
| `slave` | the joiner toggles at tic 100, then a slope at tic 300 |
| `held` | held mode: the joiner holds the key from tic 250 to 349, slope at 280 |
| `exit` | presses at tics 199 and 201 around a level exit at 200 |
| `l2ctl` | the control for the second level: slope at E1L2's tic 100 tilts the view |
| `l2` | a toggle at tic 30 of E1L2, then that slope |
| `off` | mouse aiming on from the start, toggled off at tic 100 |
| `oldjoin` | the joiner is the older-build stand-in, with mouse aiming on from the start |
| `oldhost` | the host is the older-build stand-in |

Each game checks:
- both exit 0;
- the key and the slope were logged;
- no `OUT OF SYNC`;
- every tic is in both dumps, and they agree byte for byte;
- the state dumps agree field by field 20 tics after the slope;
- there the flag is what the key made it, and the view is tilted exactly when mouse aiming is off.

**`netplay.js mouse-aim`** (in the full run): three games of 400 tics, slaves 60 ms late:
- a browser host presses U, with a native joiner;
- a native host, with a browser joiner that presses U;
- two browsers, where the joiner holds U in held mode.

It makes the same checks.

**Mutations:**

| What was run | Result |
|---|---|
| Native, the old behaviour (a build with the fix's three lines turned back) | `master`, `slave` and `held` failed in 3 of 3 runs, 9 of 9 games. The host is out of sync at the slope; the machine that did not see the key has `horizoff` 6 against 0. |
| `test-mouse-aim.sh --old` (every machine `-testoldaim`), 3 runs after the fix round | `master`, `slave`, `held`, `l2` and `off` failed every time, 15 of 15 games, 5 failed checks each. `control`, `l2ctl`, `exit`, `oldjoin` and `oldhost` passed, as they must. |
| Browser (`netplay.js mouse-aim` with the old-behaviour wasm and native) | 9 of 9 games failed in 3 runs. |
| The fix without the `MouseAimInInput` check | `oldjoin` fails (the newer host cleared the stand-in's flag); `oldhost` passes. |

`exit` passes on the old code too: the old code also resends the options at each level start. It checks the fix's own behaviour across a level change. `l2` is the level-change case that fails without the fix.

### Fix round (after the review)

The review (independent, read-only) approved the code as correct and upstream-ready, with nothing blocking. It confirmed:
- bit 28 is free;
- the bit is in every input;
- the apply point is the same tic on every machine;
- the `CommEnabled` choice;
- mixed builds behave as the old game;
- not bumping `GameVersion`;
- `git am -3` onto `befcdd0` is clean.

Fixed:
- **Should-fix 1.** code-facts said a mixed game stays in sync "until a player of the older build toggles". In fact any player's toggle desyncs a mixed game, as in the original; the reviewer saw the host's OUT OF SYNC. Corrected (§21).
- **Should-fix 2.** The `exit` case could not fail. On E1L2, `-testslope`'s sector 317 with the player's angle gave no tilt, even with mouse aiming off. `-testslope` now turns the player along the slope. New `l2ctl` is the control that the slope tilts on E1L2, and new `l2` is a mid-level toggle in the second level, which fails under `--old`.
- **Nits:**
  - `DoPlayerMouseAimSync` is declared in `player.h`;
  - `MouseAimInInput[]` is cleared in `InitGame`. Not in `InitNetVars`, which runs at every level start, possibly after the other players' options packets have arrived;
  - new `off` case: toggle-off in toggle mode;
  - a code-facts line on demos recorded during a network game.
- The nits that belong upstream are a follow-up commit on the fix branch (`dace2e9`, `Co-Authored-By` only), cherry-picked onto `befcdd0` again and merged into the integration branch.
- **Merge of `claude`.** Briefs 06 and 02c came in. The conflicts were all both-sides:
  - bugs.md: 02c's L24 with this L25;
  - building.md: 02c's Firefox section with the port offset;
  - code-facts: 02c's §20, so F4's section is now §21;
  - `lib.js` exports;
  - `netplay.js`: 02c's `NETPLAY_PORT_BASE`, whose default now follows the offset.

### Test results (after the fix round and the merge; rebuilt from clean: native 14 warnings as before, wasm)

| Test | Result | Load (1 min) |
|---|---|---|
| `determinism.js` | 20/1, run twice: the known "no stall over 100 ms" (max 125 ms, then 302 ms). The native `.dms` equals the committed `jfsw1.dms`, and native and wasm are identical, both times. | 4.1; 1.0 to 3.5 |
| `smoke.js` | 29/0 | 4.0 |
| `persist.js` | 15/0 | 3.6 |
| `data.js` | 172/0 | 3.3 |
| `grptable.js` | 8/0 | 3.3 |
| `focus.js` (02c, Chromium) | 24/0 | 2.4 |
| `netplay.js`, every default scenario (`hidden-frozen` and `mouse-aim` included) | **1346/0**, 30 minutes | 1.4 to 7.7 |
| `make test GAME_RUNS=1` | 9 PASS, 0 FAILED: mmulti 10 runs; three games over relay and over UDP; UDP against the pre-brief-01 baseline, including old master with new slaves and the reverse; errors; level exit; mouse aim (10 games); startup window; rejoin. `test-draw` 16/0. 11 minutes | 1 to 4 |
| `tests/net/test-mouse-aim.sh`, fixed build, alone | PASS in every run: before the fix round 4 runs (7 games), after it 1 run plus the one in `make test` (10 games) | |

Before the fix round (13 Nov):
- `make test GAME_RUNS=1`: 9 PASS, draw 16/0.
- `netplay.js mouse-aim`: 60/0.
- `grptable.js`: 8/0.
- A full `netplay.js` run stopped at 34 scenarios with 1312 ok and 1 failure, `hidden-frozen`'s stall timing at load 6 to 9. It was not seen again in the run above.

### Play-test on Arch Linux (the user)

1. **Get the branch and build.**

   ```bash
   sudo pacman -S --needed base-devel pkgconf git unzip python go sdl2 libvorbis libogg mesa glu alsa-lib gtk3
   git fetch origin && git checkout browser/F4-mouse-aim-sync && git submodule update --init
   make veryclean && make -j4
   scripts/setup-emsdk.sh && scripts/build-wasm.sh        # the browser build (once: emsdk into ~/.cache/jfsw-browser)
   scripts/fetch-test-data.sh                             # testdata/swshare.grp, if you do not have it
   (cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
   ```

2. **Start a relay and serve the page.** Use three terminals. In `build-wasm/config.js`, set `relay: 'ws://127.0.0.1:7778/vnet'`.

   ```bash
   /tmp/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v      # terminal 1
   cd build-wasm && ln -sf ../testdata/swshare.grp . && python3 -m http.server 8000 --bind 127.0.0.1   # terminal 2
   ```

3. **Browser against browser.**
   - Open `http://127.0.0.1:8000/?host=2` in Chromium and click to host. The lobby shows the room code.
   - Open the invite link (`?join=CODE`) in Firefox (`sudo pacman -S firefox`) and click to join.
   - In the host's menus, start a deathmatch (or co-op) on E1L1, Seppuku Station.
   - Both players: press **U** a few times during the game (the screen says "Mouse Aiming On" / "Off"). Each time, walk over ramps, sloped streets and stairs, and stand still on a ramp. Do this with mouse aiming on and off, and once while dead and after respawning.
   - Then go to E1L2 (the exit at the end of E1L1, or a kill limit) and do the same there.
   - **The host must never show the red "GAME OUT OF SYNC! / Restart the game."**, and neither window should end with an error.
   - On a ramp with mouse aiming off, the view tilts with the slope; with it on, it does not.
4. **Native against browser.** Host in the browser as above, and join from a native game (its console, Num Lock, also has `join CODE`):

   ```bash
   ./sw -net -relay 127.0.0.1:7777 -room CODE --
   ```

   Then repeat with the native game hosting (`./sw -net -relay 127.0.0.1:7777 -host-room 2 --`, type `start` in its terminal once the browser is in) and the browser joining. The same checks apply: press U a few times on both sides, walk the slopes, and the host never shows "GAME OUT OF SYNC!". The native host's terminal and `~/.jfsw/sw.log` must never show `OUT OF SYNC`.
5. **For comparison (optional):** the same game on `claude` before F4 goes out of sync on the host the first time a player who pressed U stands on a ramp.
6. **The tests on your machine:** `tests/net/test-mouse-aim.sh` (about 3 minutes), `tests/net/test-mouse-aim.sh --old`, which must fail in `master`, `slave`, `held`, `l2` and `off`, and `node tests/web/netplay.js mouse-aim` (needs Chromium for Playwright).

### Concerns

- Mixed old and new builds still desync on any mid-level toggle, as the original game does. That cannot be avoided without the older build's help. Nothing warns about it beyond the existing version check, which does not see this.
- The options packet is one byte longer. An older build ignores the extra byte; a newer build treats the shorter packet as an older build. Upstream may want this noted in its changelog.
