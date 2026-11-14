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

### State (in progress)

Stopped on the coordinator's request (session out of tokens), 14 Nov 2026. Nothing is built or tested yet.

**Done (uncompiled):** `src/net.h` gains `PACKET_TYPE_DATA_ID` (39) and the `PACKET_DATA_ID` struct:
- the main GRP's CRC32 and size;
- the add-on's CRC32 and size;
- the edition name;
- `Build`, the `git describe` string;
- `BuildId`;
- prototypes for `NetDataIdentity()` and `SendDataIdentity()`.

**Left: the game**
1. **`net.c`, identity.** Implement `NetDataIdentity()`. The main GRP is `gamegrp`; for an add-on, the registered GRP found in `GroupsFound()`; otherwise the `GroupsFound()` entry whose name is `grpfile`. Unknown data is shown as "unknown data, CRC X". Call it in `game.c` just before `buildprintf("GRP file: ...")`, because `FreeGroups()` comes after.
2. **`net.c`, exchange.** `SendDataIdentity()`, called after `SendVersion` (game.c about line 3102). Receive it in `getpackets`, check `packbufleng`, and store it per player in a static array, which is never reset per level.
3. **`net.c`, `CheckVersion`.** Keep the `CheckVersion():` log line for version differences. Then, per other player:
   - a data line when the data is known and differs;
   - otherwise a version line when the versions differ;
   - a milder build line when both `BuildId`s are known and differ.

   Each goes to `buildprintf`, and to two `adduserquote` lines with `user_quote_time[0]` set to about 600 tics. Replace the six quotes, and send the peer one `SendMessage` instead of six.
4. **`netlobby.c`.** Add `NetPageNotice()`, an `EM_JS` call to `Module.jfswNotice(text)`.
5. **`Makefile`.** In the `version-auto.c` rule, add `game_build_id`: the `src` tree hash, the jfbuild, jfmact and jfaudiolib HEADs, and `+` when that working tree has changes. Add an empty one to `src/version.c` and `src/version.h`. This makes item 5 easy: the id stays the same across commits that touch only the docs.

**Left: the page**

6. **`web/jfsw.js` and `index.html`.** A `#notice` banner beside the stage, in the lobby overlay's style, with `role="alert"` and a Close button:
   - it stays until closed;
   - on the first appearance it focuses Close, and the page keeps the keys while the focus is inside the banner;
   - it shows again only when the text changes;
   - `window.jfswNotice` records it for the tests.
7. **The wrong claim.** Correct the comment at about line 235 of `web/jfsw.js`, 05's N3, and `data-hosting.md`.

**Left: tests**

8. `tests/net/test-data-mismatch.sh` in `make test-net`, ports 497xx. It should use modified GRP copies made at run time (`dm-desync/scripts/modgrp.py`; for a different variant, rename SHADSW.BIN to SWREG.BIN) and cover a 3-player game.
9. A `netplay.js` scenario. Use `desyncExpected` for mismatched data, because the dumps differ.
10. The old-against-new run, the mutations, and the regression suites.

**Left: docs**

11. The docs (`bugs.md` L26, `code-facts.md`, `building.md`, `data-hosting.md`), this Outcome, and the README row.

