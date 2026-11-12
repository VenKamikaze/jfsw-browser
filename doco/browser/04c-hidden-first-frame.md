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

(To be written by the implementer.)
