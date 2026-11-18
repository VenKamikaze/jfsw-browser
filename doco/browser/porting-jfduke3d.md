# Porting this work to jfDuke3D

This is what the jfSW browser project (briefs 00 to 06b, fixes F2 to F4) changed and found, and how much of it applies to [jonof/jfduke3d](https://github.com/jonof/jfduke3d). It is written for whoever coordinates the same project for jfDuke3D. Read it with this folder's [README](README.md), [PROMPT](PROMPT.md), [bugs.md](bugs.md) and [code-facts.md](code-facts.md); the briefs' Outcomes have the detail.

jfDuke3D facts below come from reading upstream `master` at `55c5f95` (18 Nov 2026), not from building it. Check them in that project's brief 00.

## 1. The short version

- **The engine work carries over almost as it is.**
  - jfDuke3D pins exactly the same submodule commits jfSW did: jfbuild `40a98be`, jfmact `731c0cc` and jfaudiolib `68be97f`.
  - So the user's jfbuild fork `claude` branch (`5950d14` plus later merges) can be used unchanged. It has:
    - the vnet-backed mmulti;
    - the relay lobby, "Start now" and the session ids;
    - the Emscripten platform layer and the hidden-tab hooks.
  - The jfaudiolib fork's `claude` brings the F2 ALSA MIDI crash fix with it.
- **Also reusable, with renames only:**
  - the page and its scripts: `web/` (`jfsw.js`, `data.js`, `grptable.js`, `config.js`, `index.html`, `jfsw.css`);
  - the build scripts (`scripts/build-wasm.sh`, `setup-emsdk.sh`, `fetch-test-data.sh`, `run-headless.sh`, `setup-firefox.sh`, `build-id.sh`);
  - the test harnesses (`tests/web/*.js`, `tests/net/lib.sh`, `tests/deploy/*`);
  - `deploy.md` and `data-hosting.md`;
  - vnet `v0.5.0` as `ext/vnet`.
- **What has to be redone: the game side.**
  - jfDuke3D's netcode lives in `src/game.c` (no `net.c`): `getpackets()` at line 445, `faketimerhandler()` at 774, `moveloop()` at 8464, `domovethings()` at 8955, the sync value at about 9086 and `checksync()` at 1090.
  - It has its own menus (`menues.c`), its own startup window code (`startgtk_game.c`, `startwin_game.c`), its own version check (`BYTEVERSION`) and the CON script VM (`gamedef.c`).
  - Every brief that touched `src/` in jfSW needs redoing against these files: 01's test hooks, 02's frame yields, 04's hidden-tab pass, 04b's lag cuts, 04c's drawing audit, 05's host and join, 05b's data warning.
- **At least one jfSW bug looks present in jfDuke3D.** `moveloop()` runs every tic whose inputs are in, and `domovethings()` returns 1 only for a multiplayer game load, not at a level end (`MODE_EOL`). That is the pattern of L20/F3: machines can play different numbers of tics after a level exit. Check it first; it is cheap to test with the jfSW F3 test's approach.

## 2. Repositories and branches

- **The main repo.** Fork `jonof/jfduke3d` the way `jfsw-browser` was made, with `master` as upstream and a `claude` working branch. Point its submodules at the user's forks, as jfSW's brief 00 did (Q1 b):
  - `jfbuild` at the fork's `claude`;
  - `jfaudiolib` at the fork's `claude`;
  - `jfmact` at `731c0cc`.
- **Submodule pointers are per repository.** jfDuke3D and jfSW pin the same forks, so a change to the jfbuild fork made for one game can break the other. Keep the forks' `claude` branches usable by both, and run both games' `make test` before moving a fork's `claude`. A Duke-only engine change belongs behind a run-time switch or in the game, never in a Duke-only fork branch the other game can't use.
- **Branch names.** git cannot hold a branch `claude` next to `claude/...`.
  - jfmact has `claude/keen-hamilton-ede0qw`, so it has no `claude` branch: ask the user before deleting that.
  - vnet now has `claude`, so a session's own `claude/...` branch can't be pushed there.
  - Expect the same in the new fork: check `git ls-remote` first.
- **vnet:** pin a tag (`v0.5.0` or later). WebTransport in the browser needs 0.5.0 (L31).

## 3. The briefs, and what each means for jfDuke3D

| jfSW brief | What it did | For jfDuke3D |
|---|---|---|
| 00 set-up | submodules, `ext/vnet`, scripts, `code-facts.md` | Redo. Verify the netcode facts below, with file:line |
| 01 vnet transport (native) | `mmulti_vnet.c`, `-relay`, `-host-room`, `-room`, tests | Reuse the jfbuild fork. Add the game's test hooks again (`-testquit`, `-testsync`, `-testnudge`; `sync.c` in jfSW) in `game.c` |
| 02 Emscripten port | build, ASYNCIFY yields, IDBFS, page, smoke, determinism | Reuse the platform layer and page. Find Duke's own blocking loops (menus, `dobonus`, the intro, `waitforeverybody`) and make sure each pumps events and yields |
| 02c focus loss (L24, L33) | the page catches refused pointer-lock, fullscreen and audio promises | Reuse `web/jfsw.js` as it is (it's the page, not the game) |
| 03 data download | `data.js`, the IndexedDB cache, the file picker, `grptable.js` | Reuse. Rebuild `grptable.js` from Duke's `src/grpscan.c` table. Duke also loads `.CON` files and `-x`/`-g` extras from the directory: see section 5 |
| 04 browser netplay | vnet in wasm, `HiddenNetPass`, `-testdump`, cross-play | Reuse the engine side. Write the hidden-tab pass and a per-tic state dump for Duke's game state (`ps[]`, `sprite[]`, `sector[]`, `hittype[]`, `randomseed`) |
| 04b lag cuts | flush each input at once; the master forwards as soon as the last input arrives | Redo in `game.c`'s `faketimerhandler()` and `getpackets()`. Same idea, different code |
| 04c drawing state (L19) | drawing left state the simulation reads; `DrawSetupLevelStats()` | Redo the audit for Duke's drawing: `displayrooms()` (2906), `animatesprites()` (5160), mirrors, camera sprites (`animatecamsprite`), `drawbackground()`. Duke has no ROR/FAF, but check every write those functions make to `sprite[]`, `sector[]`, `wall[]`, `hittype[]` and `ps[]` |
| 05 host and join | `?host=`/`?join=`, the lobby overlay, Start now, console and menus, native re-launch, startup window | Reuse mmulti's lobby and the page overlay. Redo `netlobby.c`'s game side for Duke's menus (`menues.c`), console (`osdcmds.c`) and startup windows. Duke's bonus screen (`dobonus`) needs the hidden-tab fix (L23) |
| 05b data and build warning (L26, L30) | data identity and build id exchanged; every player warned | Redo with Duke's packets. Duke has a version byte (`BYTEVERSION`, `duke3d.h:66-68`: JF 132, +1 Atomic, +2 shareware; checked at `game.c:642`). Add the CON scripts and the add-on GRPs to the identity |
| 06 deploy guide | `deploy.md`, `check-deploy.sh` | Reuse, with names and paths changed |
| 06b vnet 0.5.0 | WebTransport at full speed | Already in, if you start on 0.5.0 |
| F2 ALSA MIDI crash | jfaudiolib lock fix | Already in the fork |
| F3 level-exit tics (L20) | `if (ExitLevel) break;` in `MoveLoop` | Probably needed in `moveloop()`: see section 1 |
| F4 mouse aiming (L25) | the aim state travels with the input | Probably not needed: Duke already sends it in input bit 23 (`sector.c:2457`, `p->aim_mode = (sb_snum>>23)&1`). Check `game.c:7620` and `8039`, which set `aim_mode` directly |

## 4. jfDuke3D's netcode, compared with jfSW's

- **The same family:** Ken's master/slave and peer lockstep, the same mmulti, the same `inputfifo`/`movefifoend` fifos, `movesperpacket` and `bufferjitter`.
- **Modes.** `networkmode` 0 is master/slave and 1 is peer. jfDuke3D says the master/slave scheme is used for 5 to 8 players (the message at about `game.c:9080`). vnet relay games are master/slave only (01): check which mode Duke picks for 2 to 4 players and force master/slave for relay games.
- **A weaker sync check.** It runs every 8th tic (`(movefifoplc&7) == 7`) and covers `randomseed` plus each player's position, angle and `horiz`, in one byte (`game.c:9086-9091`). jfSW's tests didn't trust its own sync check (L12) and compared a full per-tic state hash instead (`-testdump`, 17 bytes per tic per machine). Build that first: every later brief's determinism test depends on it.
- **The warning.** `checksync()` shows "Out Of Sync - Please restart game" (`game.c:1114`). As in jfSW, only the machines that compare (the master) show it. Log it too (jfSW's 01 added a `buildprintf`), or the tests can't see it.
- **Prediction.** `fakedomovethings()` (8516) predicts the local player. jfSW's investigation (F4) checked that SW's prediction never changed real state. Do the same for Duke: hash the whole state before and after a predicted move.
- **The level end.** `ps[myconnectindex].gm |= MODE_EOL` (for example `game.c:6092`, `6395`) and the exit switch in `sector.c`. See section 1 for the extra-tics risk. Note too that `gm` is set on `ps[myconnectindex]` in places: check every `MODE_EOL` writer runs in the simulation on every machine, not only on the local one.
- **The version check:** a packet carrying `BYTEVERSION` is checked at `game.c:642`. 05b's data warning goes next to it.

## 5. Things specific to Duke to watch

- **CON scripts are part of the game data.** `GAME.CON`, `USER.CON` and `DEFS.CON` (and the `-x` option) are compiled at start-up. A loose `.CON` file in the game directory can override the GRP's.
  - Two machines with different CON files desync at once, and the GRP CRC alone won't show it.
  - In the browser, the page's file picker and `?data=` give only a GRP. Decide whether a loose CON is allowed at all; jfSW's `?files=` was test-only.
  - Include the compiled script's hash in 05b's identity.
- **CON commands that read machine-local state.** Duke 1.5's CON has no EDuke32 display events, but check that every command the VM runs in a tic reads only synced state. Look for anything touching `myconnectindex`, sound state, the screen or `ud.` settings that differ per machine. `ifrnd` uses the synced `TRAND`, but check that too.
- **Sound-gated random numbers** (jfSW L27: `RANDOM_RANGE` only when a sound is not playing). Search `actors.c` and `sector.c` for random calls inside `Sound`/`isspritemakingsound`/`issoundplaying` conditions. Headless tests have no sound, so they can't see this kind of desync: read the code.
- **Local-player code in the simulation** (jfSW L28: `Player+myconnectindex` in a pachinko win). Search `actors.c`, `sector.c`, `player.c`, `premap.c` and `gamedef.c` for `myconnectindex`, `screenpeek` and `ud.` fields set from the menu, inside simulation paths.
- **Shareware data.**
  - Duke 1.3D shareware (`DUKE3D.GRP` in `3dduke13.zip`) is the test data. Find a verified source, record its MD5 in `fetch-test-data.sh`, and quote its own licence as `deploy.md` does for SW (§1).
  - **Never commit a GRP.**
  - The shareware game caps players (check Duke's `VOLUMEONE` limits), and some code paths branch on `VOLUMEONE`. Mixed shareware and registered data desyncs, as in jfSW L26.
  - `web.archive.org` resets connections from the cloud container; `archive.org/download/...` worked.
- **Add-ons.** Atomic (`PLUTOPAK`), and the GRPs `grpscan.c` knows. As in jfSW, keep the browser to the shareware GRP plus the file picker until a brief says otherwise.
- **The bonus and end screens.** `dobonus()` and the episode end wait for a key on every machine. A hidden browser tab then holds up the room (jfSW L23; 05 made a hidden tab leave them by itself).

## 6. Bugs and lessons from jfSW to check or reuse

| jfSW | What it was | In jfDuke3D |
|---|---|---|
| L9 / L15 | a stale `libengine.a` after a submodule move; `ar rc` keeps old members | The same Makefiles: run `make veryclean && make -j4` after moving a pointer. The fork's Makefile fix (L15) comes with it |
| L12 | the sync check is too weak to trust | Duke's is weaker. Build the `-testdump` equivalent first |
| L18 | a lost relay session left the game frozen | The fix is partly mmulti's (shared), partly the game's (`RunLevel`): redo the game half |
| L19 | drawing left state the simulation reads; a hidden tab doesn't draw | Redo 04c's audit for Duke's drawing (section 3). A hidden tab skips drawing in both games |
| L20 | extra tics after a level exit | Probably present: section 1 |
| L23 | the bonus screen waits for a hidden tab | Present: `dobonus()` |
| L24 / L33 | the page took a refused pointer lock for a crash | Fixed in the page, which is shared |
| L25 | mouse aiming set locally | Probably not present: section 3, F4 row |
| L26 / L30 | no check of data or builds | Partly present: `BYTEVERSION` warns for some data. Add the CON hash and a build id (`scripts/build-id.sh`) |
| L27 / L28 / L29 | sound-gated random; local player in the simulation; a global autorun toggle | Search for the same patterns (section 5) |
| L31 / L34 | vnet's WebTransport bursts; "The session is closed." | Fixed in vnet 0.5.0 and in the page (`web/jfsw.js` notes the rejection). L34 (a vnet change to wait for pending writes before closing) is still open in vnet |
| B1 (05 review) | a newcomer at a departed player's relay address joined the running game | Fixed in mmulti (session ids, shared) |

## 7. Gotchas from the jfSW project

**Environment** (the cloud container):
- GitHub archive URLs answer 403; `emscripten-ports` (an orphan branch with the port archives) is the workaround brief 00 used. Reuse it.
- Chromium and Playwright are preinstalled: never run `playwright install`.
- Headless Chromium renders in software, so the "no frame stall over 100 ms" check always fails there. It needs real hardware; don't loosen it.
- The container can restart and kill background work: push after every milestone.
- Run one heavy test suite at a time. Several agents' suites at once made timing checks fail; on a quiet machine they passed.
- The disk allowance is fixed; clean old build trees and worktrees.

**Build:**
- `scripts/build-wasm.sh veryclean` also deletes the native binary: build native after wasm.
- `build-wasm.sh` copies `web/config.js` only when it is newer, so an edit made in `build-wasm/` is lost later. Deployments keep their own `config.js`.
- `scripts/build-id.sh` must ignore untracked files: Emscripten's `.tmp` objects sit in the tree mid-build (06b S1).

**The page:**
- Test hooks need `?test=1` **and** `testMode: true` in `config.js`, so a crafted link can't hand a visitor's game test arguments or another relay (05, S2).
- The relay comes only from `config.js`.
- The invite link carries `?data=`.
- Emscripten drops the promises of pointer-lock, fullscreen and `AudioContext.resume()` calls; the page catches them (02c).
- Chromium rejects a closed WebTransport session's pending write (L34); the page notes it.

**Netcode:**
- **The relay gives a departed member's address to the next joiner,** so places are matched by a random session id, not by address (05, B1).
- **A hidden tab** must keep stepping through vnet's wake callback and a `MessageChannel`, never `setTimeout` (throttled), and flush after every pass (04).
- **Chromium's intensive throttling** of hidden tabs is the hard case: play-test it on real hardware.
- **mmulti packs at most about 214 bytes of packets into one datagram** and resends everything unacknowledged with the next datagram. A big packet at a level start delays the ready packet behind it (05b's first 162-byte packet broke `tic1`). Keep start-up packets small, or send them once per session.
- **`waitforeverybody()`** should flush its ready packet at once (05b).
- **The test host's `-testquit`** stops sending 1.5 s after its last tic, so a guest that has fallen behind under load gives up with "the host left". That is a test artifact, not a game bug (06).

**Relay and deployment:**
- `-origins` matches host:port exactly.
- Use `-trust-forwarded-for` only behind the proxy (06, S1).
- WebTransport needs a real certificate on UDP 443. Testing with a self-signed one needs Chromium's `--ignore-certificate-errors-spki-list` plus `--webtransport-developer-mode`.
- The certbot deploy hook must copy only the game's own certificate lineage (06, S3).

**Process:**
- Review every brief independently, and re-review when a fix changes behaviour. Reviews found a real blocker in 05 and 06b after every test had passed.
- Require mutations: each new test must fail without its fix.
- Fix branches for the original game's bugs go on `fix/...` from `master` and are checked with a cherry-pick onto upstream. Keep session trailers off the fix commit so it can go upstream (F4).
- Use placeholder host names (`game.example.org`) everywhere. The user's real server name must never reach a repository.
- Never let an agent `rm -rf` a glob in `/tmp`: other agents' test directories live there (06).
- Check a merge for conflicts before committing anything after it. A scripted merge once committed `PROMPT.md` with conflict markers in it (06b).

## 8. A suggested order for jfDuke3D

1. **00:** set-up, plus a verified `code-facts.md` for `game.c`'s netcode, the CON VM's sources of state and Duke's blocking loops.
2. **01 and 02 in parallel:** native relay games with test hooks and a `-testdump` equivalent; the Emscripten build with the shared page.
3. **A level-exit check** (the F3 pattern) as soon as 01's tests exist. Also the sound-gated and local-player searches.
4. **03, then 04:** the data download (with the CON question settled), then browser netplay with the hidden-tab pass, plus the drawing audit (04c's) in the same brief or straight after.
5. **04b:** the lag cuts.
6. **05:** host and join.
7. **05b:** the data and build warning, including the CON hash.
8. **06:** the deployment guide.

Relative sizes from jfSW, if the engine forks are reused:

| Brief | Size |
|---|---|
| 01 | about half of jfSW's |
| 02 | about two thirds (the platform layer exists; Duke's loops don't) |
| 03 | small |
| 04 | about two thirds |
| 05 | about two thirds (the lobby exists; Duke's menus and startup windows don't) |
| 06 | small |
