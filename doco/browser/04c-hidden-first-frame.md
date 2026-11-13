# 04c: A tab hidden before the level's first frame (L19)

## Goal

Make every machine in a network game agree on the game state from tic 1 of every level, whether or not it has drawn a frame. Brief 04's hidden pass lets a hidden browser tab play without drawing. Drawing has a lasting side effect on the game state that the simulation reads. So a guest whose tab is hidden before a level's first frame silently goes out of sync: missiles behave differently on that machine, and a player standing on a sky floor dies there only. That is [`bugs.md`](bugs.md) L19.

The user asked for this brief on 12 Nov 2026, after 04b merged, to be done before brief 05. Brief 05's lobby makes "switch tabs while waiting for the game to start" a normal thing to do.

## Read first

- [`README.md`](README.md): D4, Q5, "Bugs found in the original game".
- [`bugs.md`](bugs.md) L19, the whole entry.
- [`code-facts.md`](code-facts.md):
  - §15 (brief 04: the hidden pass);
  - §16 (brief 04b): "The tic 1 difference", `-teststate`, `-testslowstart`.
- The Outcomes of [04](04-browser-netplay.md) and [04b](04b-lag-cuts.md). Read especially 04b's tic-1 investigation, the `tic1` scenario, `stateDifferences()` in `tests/web/netplay.js`, and the hidden-tab scenarios and their helpers.
- The code:
  - `src/draw.c`: `FAF_DrawRooms`, which saves and restores the override sectors' stat and picnum in the marker sprites' TAG4 and TAG5, and restores the stat with the parallax bit cleared. Also `drawscreen`, and everything it calls that writes to the game state.
  - `src/game.c`: `RunLevel`, `InitRunLevel`, the hidden branch that calls `HiddenNetPass()` (about line 3185), level changes, and `-teststate`/`-testslowstart`.
  - `src/net.c`: `HiddenNetPass`.
  - The readers of the parallax bit: `move_missile` (`sprite.c`, about 7348), `DoPlayerTestPlaxDeath` (`player.c`, about 5447), `SectorZadjust` (`rooms.c`, about 427), `SpawnSplash` and the hitscans (`weapon.c`).
  - `src/sync.c`: `TestStateHash`, `TestStateFull`.

## What is known (check it; don't take it as given)

1. On E1L1, the ceiling/floor picture override markers (`STAT_CEILING_FLOOR_PIC_OVERRIDE`, sprites 51 and 924) belong to sectors 149 (ceiling) and 238 (floor).
2. The first `FAF_DrawRooms()` clears the parallax bit of those sectors for good. Later frames leave it clear.
3. In the original game every machine draws at least one frame before tic 1: a visible tab makes its own inputs only while drawing. So all machines agree.
4. A browser tab hidden before its first frame never draws, keeps the bits, and differs from tic 1 on. Measured in 04b: a native host and a browser guest hidden from its start gave 200 records of 200 different, in exactly `sector 149 ceilingstat` and `sector 238 floorstat`.
5. The same must happen at **every level start**, not just the first. A tab hidden through a level change never draws the new level's first frame. Check this: it follows from the code, but 04b did not test it.
6. Brief 04's hidden scenarios passed with identical dumps. But 04's hash did not cover sector stat bits, and the guest was hidden only after the game had started. So 04's tests do not show there are no other drawing side effects of this kind.

## In scope

### 1. Audit the drawing path for lasting writes to the game state

- Go through everything `drawscreen()` and its callees write. That includes `FAF_DrawRooms`, the mirror and camera code (`jsector.c`), `analyzesprites`, interpolation (`DoInterpolations`/`RestoreInterpolations`), `gotpic`/`gotsector`, the panel, and anything else they reach. List every write to a variable the simulation reads, meaning anything `domovethings()` and its callees can see.
- For each one, say:
  - whether it is restored before the simulation runs, or whether it lasts;
  - if it lasts, whether the simulation reads it;
  - whether it depends on how many frames were drawn, or on what was in view.
- Also check the reverse direction: does any simulation code read draw-only state (`gotsector`, `gotpic`, the mirror flags, anything set only while drawing)? Example: `game.c` about line 5779 reads `gotsector`. Find out what it is, and whether the simulation reaches it.
- Record the results in `code-facts.md` (a new §17). A tab hidden for a whole level is now normal, so every frame-count-dependent or view-dependent write the simulation reads is a desync. Fix them all in this brief, or, if one is too big, stop and report it.

### 2. Fix L19 (and anything else §1 finds)

The fix must give every machine, drawing or not, the same state from tic 1 of every level as the original game gives a machine that drew first. Two candidate forms; choose, and say why in the Outcome:

- **(A) Coordinator's preference: apply the lasting effect without drawing.**
  - At a point every machine passes on every level before tic 1, clear the parallax bit of every override marker's sector exactly as `FAF_DrawRooms`' restore does. The point is after the level and its sprites are set up, and before the first frame and the first tic.
  - It runs everywhere, natively too. It is idempotent with the drawing that follows, so a visible game's state from tic 1 on is unchanged. **Show that**: compare `-teststate` dumps of the old and new build in a visible game (native and browser, 2 players), field for field at the start of tics 1 to 3. They must be identical apart from fields 04b already excludes.
  - Check that nothing between level load and the first frame reads the bit, such as spawn or setup code or the first `SectorZadjust`. Otherwise clearing it earlier would change that.
  - Keep it small and upstream-friendly (Q5), with a comment that says why.
- **(B) Draw one frame before the hidden pass takes over.** The frame is drawn to the screen buffer and need not be shown. It must happen on every level start, including after a level change while hidden. With ASYNCIFY and Chromium's throttling of hidden tabs, say what guarantees the frame happens before tic 1.

Whichever you choose:

- Savegames and demos must keep working, or be shown not to be affected. A savegame restores sector state. Say whether a network game can load one, and what the loaded state's bits are.
- Brief 04's hidden-tab behaviour must not change otherwise: owed yields, passes per second, and no drawing while hidden.

### 3. Make the hash and the dumps see it

- 04b's `TestStateHash()` already covers every sector's ceiling and floor stat. If §1 finds other lasting draw-time writes the simulation reads, make the hash cover them too, still test-only, and say so.

## Out of scope

- The netcode, prediction, vnet, the relay.
- Brief 05's lobby and UI.
- Other original-game bugs. Note any new ones in `bugs.md` under the bug policy, and don't fix them here unless §1 makes them desyncs in browser play.
- F1 (on hold).

## Acceptance criteria

1. The §1 audit is in `code-facts.md` §17, with each write and its verdict.
2. A guest hidden **before the first frame of the level** agrees with the host on every tic: dumps identical, record for record. Check this for a native host with a browser guest, two browsers, and a browser host with a native guest. Also check a browser host hidden before its first frame, with a native guest.
3. The same holds **across a level change while hidden**, if the test machinery can change level in a reasonable time. If it can't, say why, and show it from the code and from the state dumps at the new level's start.
4. A visible game's state from tic 1 is unchanged by the fix (§2 (A)'s comparison, or the equivalent for (B)).
5. `netplay.js` (all scenarios), `make test`, `smoke.js`, `persist.js`, `data.js` and `determinism.js` still pass. The known 100 ms stall check is excepted, as before. `determinism.js`'s native and wasm `.dms` files must stay identical, since single-player play must not change.

## Tests

1. **A `hidden-first` scenario** (or several) in `tests/web/netplay.js` covering the pairings in criterion 2.
   - The tab is hidden before the level starts, for example from page load, so it never draws a frame of the level.
   - Use `-teststate` and `stateDifferences()`: every record and every field agree at the start of tics 1 to 3 and at the last tic.
   - It must check that the hidden machine really drew no frame of the level before tic 1. Use `numframes` in the state dump, or a test-only counter.
   - Use a map that has override markers (E1L1 does; check whether E1L2, used by the co-op tests, does).
2. **A level-change version**, if feasible (criterion 3).
3. **Mutations**, each applied, rebuilt, run and reverted:
   - remove the fix: `hidden-first` fails, naming the sector stat fields;
   - for (A), clear the bit at the wrong time, after tic 1, so the dumps differ at tic 1;
   - for (B), skip the frame.
4. **Regression**: as in criterion 5, plus 04b's `tic1` and the hidden scenarios unchanged.

## Dependencies

- 04b (merged): `-teststate`, `-testslowstart`, the sector-stat hash, `tic1`, `stateDifferences()`.
- Brief 05 comes after this one.

## Notes

- Repos touched: jfsw-browser, on branch `browser/04c-hidden-first-frame` from `claude`. jfbuild shouldn't need changes. If it does, use the same branch name in the fork, merge the fork first, and move the pointer, as in 04b.
- Ports, time limits and load as in 04's Notes: browser tests on 127.0.0.1 48300 to 48399, native network tests on 47000 to 47999, one test at a time, and report the load with any timing.
- After moving a submodule pointer, run `make veryclean && make -j4` (`bugs.md` L9).
- Update `bugs.md` L19 (fixed in 04c, how), `code-facts.md` (§17, and §16's note), and `building.md` for any new argument or scenario.
- Write play-test steps for the user (Arch Linux, `pacman`) in the Outcome. For example: start a browser game as a guest, switch to another tab before the host starts, shoot into E1L1's override skies, and check that both screens agree.

## Outcome

Implemented in one session on `browser/04c-hidden-first-frame` (jfsw-browser only; jfbuild unchanged, no pointer move). Status: review.

**What landed**

- *The fix, form (A): the lasting effect applied without drawing.* `DrawSetupLevelStats()` (`src/draw.c`, next to `FAF_DrawRooms`, declared in `src/game.h`, with a comment that says why) clears the parallax bit of every ceiling/floor picture override marker's plane exactly as `FAF_DrawRooms()`' restore does, and sets the slope bit of every `FLOOR_SLOPE_DONT_DRAW` sector as `PostDraw()` does (the audit's second lasting first-frame write; it changes nothing in the shareware maps, whose two such sectors already have the bit). `InitLevel` calls it last in the level setup, after `SetupMirrorTiles()` and `initlava()`: on every machine, natively too, at every level start (`NewLevel` runs `InitLevel` for each level). 11 lines of game code and 1 call; the frames that follow find the bits as they would leave them, so drawing changes nothing more.
- *Why (A) and not (B).* (A) does not depend on drawing at all, so nothing has to guarantee a frame before tic 1 in a throttled, ASYNCIFY-suspended hidden tab (with (B) the frame would have to be forced in `RunLevel` before the first `MoveLoop` on every level, drawn by a tab that is not seen, and the marker scratch fields would still differ with the number of frames); it is the same on native and browser builds, small, and an upstream-friendly change (a function and a call, no `#ifdef`). It is also the coordinator's preference.
- *The audit* (`code-facts.md` §17, a table of every write with its verdict): only two drawing writes last and are read by the simulation, both depending only on whether any frame was drawn: the override sectors' parallax bit (L19) and the `FLOOR_SLOPE_DONT_DRAW` slope bit; both are now applied at setup. Everything else is restored within the frame (interpolations, the room-over-room floors and ceilings, the stacked-water sprite copies and the sprite lists and free lists, borrowed cstat bits), is drawing-only state the simulation never reads (gotpic/gotsector, the automap bits, tsprite, `visibility`, the mirror and camera state and tile sizes, `GlobStackSect`, the boss meter's flags, the player's view fields, the panel's status-bar sprites, the override markers' scratch `ang`/`xvel`), is local view state the simulation does not read (the 2D map sets `owner = -2` on hit-match floor sprites), or is compiled only in `DEBUG` builds (`spriteinfo`, `CameraTestMode`). The drawing code uses only C `rand()`, never the game's random numbers. The engine's drawing writes no sector, wall or sprite field. The other direction: the `gotsector` read at `game.c` about 5779 is in `drawoverheadmap` (drawing); the only draw-set field the simulation reads, `circle_camera_dist`, drives only another drawing field. Nothing of this is too big for this brief, and no divergence of the original game was found in the drawing path. §17 also checks that nothing between the new call and the first frame reads the bits (`SectorSetup` and the spawning code, which do, run before it, as they ran before the first frame) and that the simulation never sets them again on those sectors (checked in the shareware maps; the registered maps could not be checked).
- *Savegames and demos.* Network games cannot save or load (`MNU_SaveGameCheck`, `MNU_LoadGameCheck`, the F2/F3/F6/F9 keys only with `CommPlayers <= 1`). Loading returns from `InitLevel` before the new call (`LoadGameOutsideMoveLoop`), so a loaded game keeps the bits it saved (saved by a drawing game: cleared); the format is unchanged. A demo is recorded by a drawing game (cleared bits from tic 1); playback now always has them cleared, even in the tics `DemoPlayBack` may run before its first frame. The committed demos give the same `.dms` files (determinism.js, below).
- *The hash and the dumps* needed nothing new: 04b's `TestStateHash()` already covers every sector's ceiling and floor stat, and no other lasting draw-time write is read by the simulation.
- *Test hooks.* `-testexit<T>,<L>` (`src/sync.c`, test-only, inert without it): at the start of tic T of the first level every machine leaves it for level L, as a level exit switch does but without the co-op bonus screen (which waits for a key: a hidden tab or a native test game would never leave it), and `MoveLoop` runs no further tic of that level, so every machine plays exactly T tics of it (see L20 below for why that matters). It is in the version salt like `-testquit`. `-teststate` now labels the dumps of the second level played `L2.start`, `L2.t1`, ... (the first level's labels are unchanged).
- *Tests* (`tests/web/netplay.js`): `hidden-first` and `hidden-level` (in the full run) and `old-new` (by name); `room()` takes `onStart(i, m)` and per-machine options (`old`: the page that `NETPLAY_OLD_WASM` names, served under `/old/`; `sw`: another native binary). The field comparison now leaves out a player's `FadeAmt` and `FadeTics`: the first comparison at a late tic (t400) found them different (player 0: 2 and 4 on player 0's own machine, 0 and 0 on the other), because the original game sets the screen flash only for the player a machine looks through (`PlayerUpdateHealth`, panel.c, `SetFadeAmt`, menus.c) and only the palette code reads them; the records (state hash) agreed throughout.
- *Docs:* `code-facts.md` §17 (and §16's note), `bugs.md` L19 (fixed), L20 and L21 (new), `building.md` §6.5, the README status row.

**Results** (final tree, rebuilt from clean: `make veryclean && make -j4`, 14 warnings as before; `scripts/build-wasm.sh clean` and build; one test at a time; the container was shared and busy, load averages as given)

- `node tests/web/netplay.js` (every scenario but `lag-matrix` and `old-new`, 21.3 minutes, load average 2.2 to 8.4): **827 passed, 0 failed** (04b's 591, plus `hidden-first` 116 and `hidden-level` 120). 04b's `tic1`: 8 of 8 games uneven, all agree. Brief 04's hidden scenarios as before: 40.0 to 40.6 tics a second on both machines, 42 to 67 hidden passes a second (6 for `hidden-thin`), at most 6 yields entered with data held back, nothing drawn while hidden.
- `old-new` (by name, old build = this branch's base, `claude` 1468558, built into the scratch directory; load 2.6 to 3.0): **198 passed, 0 failed** (11 games).
- `make test GAME_RUNS=1`: **5 PASS**, exit 0 (7.6 minutes, load 2.0 to 3.5).
- `tests/web/smoke.js` **29 passed, 0 failed**; `persist.js` **15 passed, 0 failed**; `data.js` **172 passed, 0 failed** (load 2.6 to 3.0).
- `tests/web/determinism.js` **20 passed, 1 failed**: the known "no stall over 100 ms" frame check (7,271 frames over 140 s: median 16.8 ms, p95 35.1, p99 70.6, max 261; load 2.6). The native playback still gives the committed `jfsw1.dms`, and the native and wasm sync bytes are identical in both directions, so single player play is unchanged.
- Native build: 14 warnings, as before (none in the code 04c touched).
- (A comment in `src/sync.c` was reflowed after these builds; no code changed.)

**Criterion by criterion**

1. The audit is `code-facts.md` §17.
2. `hidden-first`: a native host with a hidden browser guest, two browsers, a browser host with a hidden browser guest and a native guest (three machines), and a hidden browser host with a native guest. In every game the hidden tab drew no frame of the level (`numframes` unchanged from the level's start to tic 400; 2 pictures asked for in all, before the level), was driven by hidden passes (873 to 1,604 per game in the final run over both scenarios, 99 % resumed by network events), the visible machines drew 1 to 47 frames before tic 1, all records agreed (400 of 400), every field agreed at the start, tics 1 to 3 and 400, and the override sectors had no parallax bit at tic 1 on every machine.
3. `hidden-level`: every machine leaves E1L1 at tic 200 for E1L3 (481 sectors, six override sectors) and plays 400 tics there, the tab hidden throughout: native host with a hidden browser, two browsers, a hidden browser host with a native guest. The hidden tab drew no frame of either level; 600 of 600 records and every field at both levels' start, tics 1 to 3 and last tic agree; E1L3's six override sectors have no parallax bit at its tic 1. So a level change while hidden is tested, not only argued.
4. `old-new`: in eleven games an old-build machine (the tree before this brief) and a new one play in one room, both visible: native and native, browser and browser, browser and native both ways, each with the old build as host and as guest, on E1L1, and three on E1L3. Every game: 60 of 60 records agree and every field at tics 1 to 3; at the level's start (before any frame) the two differ in exactly the override sectors' stat (E1L1: sector 149 ceilingstat, 238 floorstat; E1L3: sectors 6, 52, 227, 229, 263, 264) and in nothing else, so the fix only moves when the bits are cleared: 198 checks passed.
5. Regression: below.

**Mutations** (each applied, built into its own native binary and page, run with `NETPLAY_SW` and `WASM_DIR`, reverted; load average 1.4 to 2.9)

| Mutation | Run | What failed |
|---|---|---|
| no fix (the `DrawSetupLevelStats()` call removed) | `hidden-first`, `hidden-level` | every game: 24 of 116 and 33 of 120 checks. The records differ from tic 1 in all of them (400 of 400, 600 of 600), and the failure names the fields: `sec 149 ceilingstat: 0 against 1; sec 238 floorstat: 0 against 1` (and the hash), at the start of the second level `sec 6 floorstat, sec 52 ceilingstat, sec 227 floorstat, sec 229 ceilingstat, sec 263 ceilingstat, sec 264 floorstat`; the parallax-bit check fails on the hidden machine only |
| the bits cleared too late (at the start of tic 2 instead of at setup) | `hidden-first`, `hidden-level` | every game: 16 of 116 and 21 of 120 checks. The dumps differ at tic 1 (and 2: 2 records per level), naming the same fields, and agree from tic 3 on |

**Concerns**

- *L20 (bugs.md, suspected, not reproduced):* when a level ends (an exit switch, a deathmatch limit), `MoveLoop` goes on running every tic for which it already has all inputs before `RunLevel` sees `ExitLevel`, and how many that is is timing. In co-op the next level keeps health, weapons, ammo and inventory, so a machine that ran an extra tic in which something happened would start the next level out of sync. Found by reading while writing `-testexit` (which avoids it); not part of the drawing audit and not tested. For the user, under the bug policy.
- *L21 (lesser):* the savegame picture skips `PostDraw` (single player).
- *Maps other than the shareware ones:* that nothing in the simulation sets the bits again was checked for the shareware GRP only. (The first version also relied on one marker per plane; since the review round it does not: see below.)
- The `hidden-first` throttling: Playwright cannot hide a tab; the page says it is hidden from the click on "Start" on, and the background-tab throttling is imitated from when its relay session is up (before that, a page held to one timer run a second would take minutes to start). The game's hidden path depends only on `document.hidden` and the session, so the hidden tab never drew; a real background tab is the play test.

**Play-test steps (Arch Linux)**

```
sudo pacman -S --needed base-devel git unzip python nodejs npm go sdl2 libvorbis libogg mesa glu alsa-lib gtk3
git clone --recurse-submodules -b browser/04c-hidden-first-frame https://github.com/VenKamikaze/jfsw-browser
cd jfsw-browser
scripts/setup-emsdk.sh && scripts/build-wasm.sh      # about 3 minutes the first time
scripts/fetch-test-data.sh && make -j4
cp testdata/swshare.grp build-wasm/
(cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
/tmp/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v      # terminal 1
(cd build-wasm && python3 -m http.server 8000 --bind 127.0.0.1)                          # terminal 2
```

1. *A guest hidden before the game starts.* In terminal 3 host natively: `./sw -net -relay 127.0.0.1:7777 -host-room 2 -- -autonet 2,0,2,1,0,0,0,0,0,0` (co-op, E1L1; the room code is printed). Open `http://127.0.0.1:8000/?test=1&args=-net%20-relay%20ws://127.0.0.1:7778/vnet%20-room%20CODE%20--%20-autonet%202,0,2,1,0,0,0,0,0,0` in Chromium (or Firefox), click Start and **at once switch to another tab** (or minimise the window), so the guest's tab is in the background when the level starts. Wait a minute in the other tab, then come back.
2. *Play where the bits matter.* E1L1's two override sectors are a small stacked-water pool about 33,000 units east of the start (ahead and a little to the left of the way the players face at the start; a rectangular pool on the map, Tab): sector 238 is its surface, 149 the water under it. With both players, jump into the pool and swim down, fire rockets or shurikens into the water surface from above and from below, and let enemies shoot over it. Both screens must show the same thing (the same player alive, missiles going the same way), and the host's console (and stdout) must never say `OUT OF SYNC`. On `claude` (before this brief) the same steps with the guest in the background desync: a player landing on the surface dies on the guest's machine only, and the host logs `OUT OF SYNC`.
3. *The other way round:* host in the browser (`...&args=-net%20-relay%20ws://127.0.0.1:7778/vnet%20-host-room%202%20--%20-autonet%202,0,2,1,0,0,0,0,0,0`), switch away from it right after Start, join natively with `./sw -net -relay 127.0.0.1:7777 -room CODE -- -autonet 2,0,2,1,0,0,0,0,0,0`, and play as in step 2 from the native side.
4. *A level change while in the background:* as step 1, then finish E1L1 (the exit switch) while the guest's tab is in the background (each player presses Space on the bonus screen; switch to the guest tab only to press it, and away again before E1L2 starts), and play on. E1L3 has six override sectors (pools and skies); reaching it takes two exits.
5. *The tests on your machine:* `node tests/web/netplay.js hidden-first hidden-level`, and with the build from `claude` in another worktree (`git worktree add ../jfsw-claude claude`, build it there): `NETPLAY_OLD_SW=../jfsw-claude/sw NETPLAY_OLD_WASM=../jfsw-claude/build-wasm node tests/web/netplay.js old-new`.

### Review fix round

The independent review found no blockers. What was changed (commit `d6aa0ae`):

- **S1: `DrawSetupLevelStats()` does exactly what one frame does, on any map.** The first version only cleared the parallax bit, which is not what a frame does when two override markers share a plane: a frame then also leaves the first marker's picture (TAG2) and stat bits (TAG6) for good, and the simulation reads that picture (`FAF_ConnectCeiling`/`FAF_ConnectFloor`, rooms.c 646/652, compare it with `FAF_MIRROR_PIC`). `FAF_DrawRooms`' two marker loops are now `FAF_PicOverrideApply()` and `FAF_PicOverrideRestore()` (draw.c). `FAF_DrawRooms` calls them around `drawrooms()` and behaves as before; its `gotpic` loop is separate now, which changes nothing because it reads only `gotsector`. `DrawSetupLevelStats()` calls the two back to back, with nothing in between. The `FLOOR_SLOPE_DONT_DRAW` part does not depend on marker order (each marker only clears and then sets the bit), so it stays as it was.
  - *Test:* a new test-only `-testdrawcheck[2|3|4]` (sync.c). In a single player game it works out what `DrawSetupLevelStats()` makes of every sector, puts the map back, draws the first frame, compares every sector and wall, prints one line and exits. `tests/draw-setup.sh` (`make test-draw`, now part of `make test`, about 10 s) runs it on all four shareware levels in four modes:
    - the map as it is;
    - a second marker added to every override plane (TAG2 + 1);
    - control 3, nothing applied: it finds E1L1's 2 and E1L3's 6 override sectors;
    - control 4, two markers per plane with only the parallax bits cleared (the first version): it finds them too. For example, on E1L1 the frame leaves sector 149 with ceilingstat `0x180` and picnum 781, where clearing the bit alone gives `0` and 2356.
  - *Results:* 16 passed, 0 failed. With the fix and the doubled markers, no sector or wall differs on any level. `code-facts.md` §17 no longer relies on "one marker per plane".
- **L20: reproduced by the reviewer.** With `-testexit`'s stop turned off, 1 of 3 two-browser games ran 201 tics of level 1 against 200. It is not fixed here; `bugs.md` L20 now says:
  - it is reproduced (tic count);
  - a desync needs a lasting co-op change in an extra tic;
  - the likely fix is `if (ExitLevel) break;` after `domovethings()` in `MoveLoop`.
  - *Checked:* `InitRunLevel` resets the random seed (`InitTimingVars`: `randomseed = 17`) and the input fifos (`InitNetVars`).
  - *Upstream:* jonof/jfsw `master` is still `befcdd0`, with the same `MoveLoop`. None of its 18 pull requests touches `ExitLevel` in game.c or player.c, so it is not fixed upstream.
- **N1: a level change in normal play waits for a key on every machine.** Both screens wait for Space, Enter or a mouse button, and a hidden tab gets no keys:
  - the co-op `BonusScreen` (game.c about 2526);
  - the deathmatch table in `StatScreen`.

  So in normal play, "hidden across a level change" means hidden again after that key, before the next level's first frame. `-testexit` skips the screen so that its test can stay hidden throughout. For brief 05: a guest whose tab stays hidden holds up the whole room at every level end. This is in §17.
- **N2:** a player's `NightVision` is per machine too. Only `DoPlayerNightVisionPalette()` (inv.c) sets it, only for `screenpeek`. Only drawing (`analyzesprites`) and the F11 key (game.c 4777) read it, and it is not in the state hash. It is now in `stateDifferences()`'s ignore set and in §17's per-machine list, with the reason in a comment.
- **N3:** the `-testexit` level is now in the version salt.
- **N5:** `bugs.md` L19 (1) now says the marker's `ang` is 0 from the first frame on since 04c.

**Results after the fix round.** The container restarted in the middle of the first try, so everything below was rebuilt from clean afterwards:
- the base `1468558` for `old-new`;
- the remove-the-fix mutation;
- the final tree (`make veryclean && make -j4`: 14 warnings as before; `scripts/build-wasm.sh clean` and build).

Each was then run one at a time. The load averages (1, 5 and 15 minutes) are as given.

| Run | Result | Load |
|---|---|---|
| mutation: the `DrawSetupLevelStats()` call removed, `hidden-first` and `hidden-level` | 57 failed, 179 passed. All 7 games fail: records differ from tic 1, naming `sec 149 ceilingstat`, `sec 238 floorstat` and, on E1L3, its six sectors | 2.5 to 2.6 |
| `old-new` (11 games, old base and new build in one room) | **198 passed, 0 failed** | 2.5 to 3.3 |
| `netplay.js` full (21.1 min) | **827 passed, 0 failed**. Hidden scenarios: 39.9 to 40.0 tics a second; 42, 44 and 69 hidden passes a second (6 for `hidden-thin`); at most 6 yields with data held back | 1.9 to 8.1 |
| `make test GAME_RUNS=1` (7.7 min) | **5 PASS**, plus `test-draw` 16 passed, 0 failed; exit 0 | 1.9 to 5.7 |
| `smoke.js` | **29 passed, 0 failed** | 1.9 to 2.5 |
| `persist.js` | **15 passed, 0 failed** | 2.5 to 3.6 |
| `data.js` | **172 passed, 0 failed** | 3.0 to 3.6 |
| `determinism.js` | **20 passed, 1 failed**: only the known "no stall over 100 ms" check (7,549 frames over 140 s: median 16.7 ms, p99 61.7, max 160). The committed `jfsw1.dms` still matches, and native and wasm agree byte for byte | 2.7 to 3.7 |
