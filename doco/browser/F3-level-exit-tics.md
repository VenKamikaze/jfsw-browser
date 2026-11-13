# F3: Machines play different numbers of tics after a level exit (L20)

## Goal

When a network game's level ends, every machine plays exactly the same tics of that level, natively and in the browser. Then co-op players always start the next level with the same health, weapons, ammo, armour and inventory on every machine. The fix is small, upstream-friendly, and on a branch from `master`. It goes into `claude` through an integration branch.

The user asked for this on 12 Nov 2026: fix it straight after 04c, before brief 05. 04c's reviewer reproduced the uneven tic count; 04c merged on 13 Nov 2026.

## Read first

- [`README.md`](README.md): "Bugs found in the original game" (the policy: a fix branch from `master` after checking upstream), "Working across repos", Q5.
- [`bugs.md`](bugs.md): L20, the whole entry, with the 04c reviewer's reproduction.
- [`code-facts.md`](code-facts.md) §8 (sync), §16 and §17, and the Outcomes of [04b](04b-lag-cuts.md) and [04c](04c-hidden-first-frame.md): `-testdump`, `-teststate`, `-testexit`, `stateDifferences()`, and the `hidden-level` scenario.
- [F2](F2-alsa-midi-lock.md), as the model for a fix brief (upstream check, fix branch, integration branch, Outcome).
- The code:
  - `src/game.c`: `MoveLoop` (the `while` over the fifo, `domovethings()`, 04c's test-only `TestExitReached` break), `RunLevel`, `InitRunLevel`, `NewLevel`, and the bonus and stats screens;
  - every place `ExitLevel` is set: exit switches, `MultiPlayLimits`, `FinishTimer`, the network new-game packet in `net.c`, menus, cheats, quitting;
  - `src/net.c`: `InitNetVars`, `getpackets`;
  - the co-op carry-over into the next level (`puser`, the `Player` fields kept by `InitPlayer`/`InitLevel`).

## What is known (check it; don't take it as given)

1. After the tic that sets `ExitLevel`, `MoveLoop` keeps calling `domovethings()` for every further tic whose inputs are all in. How many there are (0, 1 or more) depends on timing. The 04c reviewer saw 201 against 200 tics of level 1 in 1 of 3 two-browser games.
2. `InitRunLevel` then discards the rest of the fifo (`InitNetVars`) and resets `randomseed` (`InitTimingVars`). So the general random state does not split. What persists in co-op does split: health, weapon, ammo, armour and inventory. If an extra tic changes them on some machines only, the next level starts out of sync, which shows as `OUT OF SYNC` only later.
3. It is the original game's behaviour, natively too. Brief 04c did not cause it.
4. The likely fix is `if (ExitLevel) break;` right after `domovethings()` in `MoveLoop`: the general form of 04c's `-testexit` break.

## In scope

### 1. Upstream check
- Check whether `jonof/jfsw` `master`, or an open pull request, already changes this, and record the result with commit ids. If upstream fixed it, take its fix. (The 04c implementer looked on 13 Nov 2026: `master` still `befcdd0` with the same `MoveLoop`, and none of its 18 pull requests touches `ExitLevel` in `game.c` or `player.c`. Confirm.)

### 2. The fix, on `fix/level-exit-tics` from `master`
- Stop running tics of a level once a tic has set `ExitLevel`. That is the tic every machine runs identically.
- Go through every other way `ExitLevel` gets set, in a network game and alone: the new-game packet, menus, quitting, cheats, `-testquit`, demos. For each, say whether the fix changes behaviour and why that is right. A path that sets `ExitLevel` outside a tic must not now leave machines at different tics where they were the same before.
- Single-player play and demo playback must not change, or the change must be shown harmless. `determinism.js`'s `.dms` must stay identical to the committed one unless you show why it must change, and then ask before changing it.
- Keep it as small as possible, with a commit message written for upstream. It must apply cleanly to upstream `master`: check with a cherry-pick, as F2 did.

### 3. Integrate
- Branch `browser/F3-level-exit-tics` from `claude`, and merge `fix/level-exit-tics` into it.
- Once 04c's `-testexit` break is redundant, remove it or keep it. Say which and why. `-testexit` must still work for the tests.

## Out of scope

- Any other bug, F1 included (on hold).
- The bonus and stats screens' wait for a key on every machine (04c's N1, a brief-05 UX matter).
- The netcode, the hidden pass, vnet.

## Acceptance criteria

1. Every machine plays the same tics of every level in every network game, browser and native: the per-tic dumps of the old level have the same number of records on every machine, and they are identical.
2. Co-op state carried into the next level is identical on every machine, field for field at the new level's start, even when a player is hurt, fires or picks something up right at the exit.
3. Single-player play and demos are unchanged (`determinism.js`).
4. `netplay.js` (all scenarios), `make test`, `smoke.js`, `persist.js`, `data.js` and `determinism.js` pass. The known 100 ms stall check is excepted.

## Tests

1. **A regression test that fails on the old code.** The level ends for real, through the game's own exit and not `-testexit`'s break, for example a test-only way to trigger the exit at tic T that only sets `ExitLevel` the way an exit switch does.
   - Check that every machine played the same number of tics of the old level, with identical records.
   - Check, with `-teststate`, that the carried-over player state agrees at the new level's start.
   - Make the old code fail reliably, not 1 game in 3. For example, make one machine hold more inputs in its fifo at the exit, with latency impairment or a test-only delay. Report how often it fails on the old code.
   - Also make an extra tic change carried state, for example a player firing continuously or taking damage. Show that the old code then desyncs at the next level and the fix does not.
   - Cover browser and native (a `netplay.js` scenario). Add a native-only one in `tests/net/` if it is cheap.
2. **Mutation:** remove the fix, and the regression test fails.
3. **Regression:** as in criterion 4, including 04c's `hidden-level` and `old-new`.

## Notes

- Repos touched: jfsw-browser only.
- Ports, load and time limits as in 04's Notes.
- Update `bugs.md` L20 (fixed in F3, how), the README's fix table (F3 row), `code-facts.md` (the `MoveLoop` note), and `building.md` for any new argument or scenario.
- Play-test steps for the user (Arch Linux, `pacman`) in the Outcome: a two-player native co-op game through the relay, with both players firing as one of them hits the exit switch, then check that both start the next level with the same ammo and health and that the host never logs `OUT OF SYNC`.

## Outcome

**Status: review.** Implemented 13 Nov 2026. Commits: `fix/level-exit-tics` `ad79722` (the fix, from `master`); `browser/F3-level-exit-tics` (from `claude` `bbd9821`): `0ad1e2b` (merge of the fix), `ed09256` (test hooks), `9126059` (tests), `515b744` and the Outcome commit (docs).

### Upstream check

`jonof/jfsw` `master` is still `befcdd0` (`git ls-remote`, 13 Nov 2026), the commit `master` here is at; its `MoveLoop` is the one with the bug. Its 18 pull requests (`refs/pull/*/head`, fetched into a bare clone in the scratch directory: 1, 2, 4, 5, 6, 9, 19, 23, 24, 29, 37, 44 to 50): 1, 2, 4, 23, 24 and 37 are merged into `master`; none of the others adds or removes a line with `ExitLevel`, `MoveLoop` or `domovethings` (#46 touches `game.c` around `LoadGameOutsideMoveLoop`, the music after loading a game; #47 `game.c` elsewhere). Not fixed upstream; the brief's "What is known" 3 holds.

### The fix, and why

`MoveLoop` (game.c) after `domovethings()`:

```c
        if (ExitLevel)
            break;
```

with a comment; 8 lines, nothing else. The tic that sets `ExitLevel` inside the simulation is the same tic on every machine (lockstep), so stopping there makes every machine play the same tics of the level; the ones it no longer runs were never the same on every machine. The commit message is written for upstream. It applies to upstream `master`: cherry-picked onto `befcdd0` in a worktree of a fresh clone of `jonof/jfsw` (`1ca52a3` there, no conflict) and built there with its own submodules (`make -j4`, 14 s, green).

Checked from "What is known": (1) `MoveLoop`'s `while` runs every tic whose inputs are all in, and `RunLevel` checks `ExitLevel` only after `MoveLoop` and `drawscreen`: confirmed, and measured (below). (2) `InitRunLevel` resets the fifos and `InitTimingVars` the seed; what carries over is in code-facts §18 (`puser[]`'s `WeaponNum`, `LastWeaponNum`, `Health`; the `PLAYER` fields `PlayerLevelReset` leaves: ammo, weapons, armour, inventory, `HitBy`, ...). (3) Native too: every measurement below is also native against native. (4) The fix is that line.

### Every way `ExitLevel` is set (line numbers of this tree)

Inside a tic, so at the same tic on every machine; the fix makes every machine stop there:

| Where | What | Before | After |
|---|---|---|---|
| sector.c 2022, `OperateSprite` `TAG_LEVEL_EXIT_SWITCH` | exit switch (`Level++`, or `hitag`) | machines ran 0 or more further tics, a different number each | all stop at that tic. Note: without a `hitag` an extra tic in which another player also hit an exit did `Level++` again, on that machine only |
| sector.c 2227, `OperateTripTrigger` | walking into an exit sector (same) | same | same (it returns early in prediction, so prediction cannot set `ExitLevel`) |
| player.c 7805, `MultiPlayLimits` | deathmatch kill or time limit | same | same |
| player.c 8072, `FinishTimer` in `domovethings` | after a boss | same | same |
| weapon.c 5365, `ActorHealth` | the serpent boss below half health (level 4) | same | same |
| player.c 6909, `DoPlayerDeathCheckKeys` | restart after death, `CommPlayers <= 1` only | single player: further due tics ran | stops at that tic (single player, harmless) |
| sync.c, `TestTicHook` (`-testexit`) | test only | had its own stop (`TestExitReached`) | uses the game's stop; the own one is removed |

Outside a tic, at a moment of its own on each machine:

| Where | What | Why the fix is right |
|---|---|---|
| net.c 1490, `getpackets` `PACKET_TYPE_NEW_GAME` | a slave, when the master starts a new network game from the menu | It arrives at a different moment on every machine anyway, so they were never at the same tic; `NewGame` then resets every player (`PlayerGameReset`, `InitNewGame`), so the old level's tic count carries nothing. `getpackets` also runs inside a tic (the `FAKETIMERHANDLER()` calls in `domovethings`) and at the start of `MoveLoop`: the old loop then ran every tic in, the new one stops after the current tic; both timing-dependent as before. |
| menus.c 1967 `MNU_StartGame`, 2014 `MNU_StartNetGame` (the master; with the packet above), 2812 and 2840 (loading a game, single player only) | menus | Run from `MNU_CheckForMenus`, after `MoveLoop`'s loop; `RunLevel` leaves after the next `drawscreen` with no `MoveLoop` between: unchanged. |
| cheats.c 60 (`swstart`), 187 (`swtrek`); 80 and 87 (`NextCheat`, `PrevCheat`, not in the cheat table) | cheats | `CheatInput` refuses them when `CommEnabled`: single player only. Typed through the message input in `getinput`, which can run inside a tic (`FAKETIMERHANDLER`): the old loop then ran the remaining due tics of a level being left, the new one stops after the current one. A key press's timing; harmless. |
| osdcmds.c 117, `map` | console command | Refused in multiplayer. Dispatched before `MoveLoop` in `RunLevel`: the old loop then ran the due tics, the new one runs one. Harmless. |
| quitting (`QuitFlag`, `MultiPlayQuitFlag`, `MyCommPlayerQuit`, `-testquit`) | | They do not set `ExitLevel`: unchanged. |
| demos | | Playback (`DemoPlayBack`, `ScenePlayBack`) has its own loops and its own `ExitLevel` check: unchanged (`determinism.js`: the native `.dms` equals the committed one). A demo recorded through `MoveLoop` no longer records tics after an exit tic; playback ends at the exit either way. |

No path that sets `ExitLevel` outside a tic had machines at the same tic before; none needed more than the one line, so the brief's "stop and report" case did not arise. No further original-game divergence found (the `Level++` note above is the same bug).

### Integration

`browser/F3-level-exit-tics` merges `fix/level-exit-tics`. **04c's `-testexit` stop is removed** (`TestExitReached` in game.c, sync.c, net.h): `TestTicHook` sets `ExitLevel` in the tic, so the fix stops `MoveLoop` there just as it did. Keeping it would have hidden the fix from `hidden-level`; now `-testexit` ends a level as an exit switch does and its tests depend on the fix. `-testexit` still works (`hidden-level` 3 of 3 games, `level-exit`).

New test-only hooks (sync.c; building.md §6.5; code-facts §18): `-teststall<T>,<ms>` (this machine stops for `<ms>` ms at the start of tic T of the first level, after `-testexit`'s exit if the same tic; a yield in the browser; then `sampletimer()`, because `totalclock` moves only when sampled and the `FAKETIMERHANDLER()` calls in the rest of the tic would otherwise see no time pass), `-testfire[<N>]` (this machine's own inputs select the shurikens and hold fire from tic N on: about one throw every 8 tics; the inputs travel as any other), and `TestLevelEnd` (`TEST: left the level after tic T, with the inputs of K more tics here`, in games with `-testexit` or `-teststall`). Neither of the new arguments is in the version salt: they are per machine.

### The regression test, and how often the old code fails it

`netplay.js level-exit` (native host and browser, two browsers, browser host and native) and `tests/net/test-level-exit.sh` (two natives, also in `make test-net`): the level ends at tic 200 (`-testexit200`, to E1L2), every slave's datagrams are 200 ms late (latency impairment), the master stops 1.5 s inside the exit tic (`-teststall200,1500`), every player throws shurikens from tic 150 (`-testfire150`), then 300 tics of E1L2. Checks: every machine played exactly 200 tics of the first level (record count of each machine's dump) with identical records; the second level identical record for record, and field by field (`-teststate`) at its start, tics 1 to 3 and tic 300; the master had every player's inputs beyond tic 201 when it left (so the old code would run them); the shurikens were thrown before and after the exit (30, then 24 at E1L2's start, fewer at its tic 300); no `OUT OF SYNC`.

**The old code** (the fix line removed from this branch, native and wasm builds in the scratch directory) **fails it in every game**: `level-exit` 3 runs, 9 of 9 games (the master played 210 to 217 tics of the first level, the slaves 200, once 202; 27 to 30 failed checks a run: tic counts, records, `L2.start` `WpnAmmo1` 21 or 18 against 24, the second level's records from its tic 94, where the master runs out of shurikens first, and the master's `GAME OUT OF SYNC`); `test-level-exit.sh --runs 10`: 10 of 10 (208 against 200, 7 failed checks each). Which part makes it reliable (two natives, old code, the experiment script): no impairment, no stall: 0 of 6 games uneven; latency alone: 0 of 3; stall alone: 3 of 3, but only 201 against 200 (one tic seldom changes the ammo); both: every game. Without firing, one old-code game also went out of sync at the next level: an enemy hit a player in an extra tic (`HitBy` and the records differ from the next level's tic 1).

**Mutation:** removing the fix is exactly the old code above: both tests fail every time. The fixed build passed `level-exit` 4 times (12 games; once in the full run) and `test-level-exit.sh` 8 times (once in `make test`).

### Test results (fixed build; load average while running)

| Test | Result | Load |
|---|---|---|
| `make test` (mmulti 10 runs, three games relay and UDP, UDP against the baseline, errors, level exit, draw) | 6 PASS, 0 FAILED; draw 16/0; 8.0 minutes | 1.7 to 2.0 |
| `smoke.js` | 29/0 | 1.5 |
| `persist.js` | 15/0 | 2.0 |
| `grptable.js` | 8/0 | 3.5 |
| `determinism.js` | 20/1: the known "no stall over 100 ms" (max 212 ms); the native `.dms` equals the committed one; native and wasm identical | 3.5 |
| `data.js` | 172/0 | 3.0 |
| `netplay.js` (all but `lag-matrix` and `old-new`) | **914/0** (04c's 827 plus `level-exit` 87), 22.4 minutes; `hidden-first`, `hidden-level` included | 2.0 to 7.4 |
| `netplay.js old-new` (old build: `claude` `1468558`, the base of 04c, built in a scratch worktree) | 198/0 (11 games) | 3.4 to 4.0 |
| `netplay.js level-exit`, 2 more runs | 87/0, 87/0 | 3.1 to 4.2 |
| `tests/net/test-level-exit.sh --runs 5` | PASS (71 checks) | 4 |

### Play-test on Arch Linux (the user)

1. Get the branch and build from clean (the object files are shared between branches):

   ```bash
   sudo pacman -S --needed base-devel git python go sdl2 libvorbis libogg mesa glu alsa-lib gtk3
   git fetch origin && git checkout browser/F3-level-exit-tics && git submodule update --init
   make veryclean && make -j4
   (cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
   /tmp/vnet-relay -udp 127.0.0.1:7777 -http "" -v          # terminal 1
   ```

2. A co-op game of two native players through the relay (two terminals, or two machines with the relay's address instead of 127.0.0.1). The joiner's datagrams are made 200 ms late, which makes the old bug much likelier; `-teststate` lets you compare the carried state exactly (it writes a big file at each level start; leave it out for a normal game):

   ```bash
   mkdir -p /tmp/f3h /tmp/f3j
   (cd /tmp/f3h && ~/path/to/jfsw-browser/sw -net -relay 127.0.0.1:7777 -host-room 2 -- -autonet 2,0,2,1,0,0,0,0,0,0 -testdumpd.bin -teststate)   # terminal 2: prints the room code
   (cd /tmp/f3j && VNET_IMPAIR=lat=200,seed=1 ~/path/to/jfsw-browser/sw -net -relay 127.0.0.1:7777 -room CODE -- -autonet 2,0,2,1,0,0,0,0,0,0 -testdumpd.bin -teststate)   # terminal 3
   ```

   Play E1L1 together to its exit switch. As one player presses the switch, **both hold fire** with any weapon that has ammo (the shurikens are key 2). On the bonus screen press a key in both windows.
3. At the start of E1L2: both screens show the same health, armour and ammo for the weapon each holds (switch through the weapons in both). Play a minute more, firing. The host's terminal (and `/tmp/f3h/sw.log`) must never show `OUT OF SYNC`.
4. The exact check (optional): the players' state when E1L2 started must be equal, field for field, apart from what is a machine's own:

   ```bash
   carried() { grep '^L2.start player' "$1" | sed -E 's/ (movefifoend|FadeAmt|FadeTics|NightVision)=[^ ]*//g'; }
   diff <(carried /tmp/f3h/d.bin.state) <(carried /tmp/f3j/d.bin.state) && echo "same carried state"
   ```

5. The tests on your machine: `node tests/web/netplay.js level-exit` (needs `scripts/build-wasm.sh` and Chromium for Playwright) and `tests/net/test-level-exit.sh --runs 5`.
