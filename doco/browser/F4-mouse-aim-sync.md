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

(To be written by the implementer.)
