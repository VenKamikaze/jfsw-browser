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

(To be written by the implementer.)
