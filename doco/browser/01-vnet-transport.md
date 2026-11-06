# 01: vnet transport for mmulti (native)

## Goal

Native players can create and join network games through a vnet relay by room code, using the game's existing master/slave networking. The plain UDP path (`-net`) keeps working exactly as it does today.

## Read first

- [`README.md`](README.md), in particular D3, D4, D5 and "Working across repos".
- [`code-facts.md`](code-facts.md): the `mmulti` sections (API, modes, the slot-filling handshake, timeouts), how `-net` reaches `initmultiplayersparms`, the `InitGame` wait loop, and `sync.c`.
- The Outcome of [00](00-setup.md).
- vnet `v0.4.0` at `ext/vnet`: `include/vnet.h`, `doco/integration.md` (including "Vendoring without CMake"), `doco/relay-protocol.md` (room creation, codes, address assignment), `relay/` (the Go relay: how to run it locally).
- Bit Riot's `doco/netplay/07-lockstep-netplay.md` and its Outcome (on Bit Riot's `claude` branch): how a lockstep game drove vnet natively, and what went wrong.

## In scope

### 1. Build

- vnet's `src/*.c` from `ext/vnet` compiled into the native build, per "Vendoring without CMake", for both renderer settings. The jfbuild `Makefile` (or jfsw's, whichever owns `mmulti.c`) gets the sources and include paths. vnet's own flags apply only to vnet's files.
- No CMake dependency.

### 2. A vnet-backed mmulti, chosen at run time

- `mmulti.h` stays unchanged (D4). Anything extra the game or later briefs need (the room code, the relay state, an error string) goes in a **new** header, e.g. `jfbuild/include/mmulti_vnet.h`.
- The implementation is your choice, but:
  - the UDP path's behaviour, packet format and timing are unchanged, and the diff to `mmulti.c` is small and upstream-friendly (Q5). `netinit`, `netsend`, `netread` and `netuninit` are the only socket users (code-facts §3): put the seam there, and the vnet side in a new file such as `jfbuild/src/mmulti_vnet.c`. Peer addresses are `sockaddr_storage` today; decide how a vnet address (`10.0.0.x:port`) is stored and compared (`vnet_addr_equal`);
  - mmulti's own resend, ordering and CRC logic (the `ipak`/`opak` FIFOs) carry on unchanged on top of vnet, which is unreliable datagrams like UDP;
  - `vnet_poll()` is called often enough: from `getpacket`, `flushpackets`, `sendpacket` and the `initmultiplayerscycle` wait loop at least.
- **Arguments**, parsed wherever `-net` arguments are parsed today (see code-facts):
  - `-relay <host:port or URL> -host-room <N>` creates a room for N players (2 to the game's cap), prints the room code, and makes this player the master (player 0, `10.0.0.1`, D5);
  - `-relay <...> -room <CODE>` joins a room; the joiner fills an open slot as a newcomer does today ("There's a slot to be filled");
  - `VNET_BACKEND_RELAY_AUTO` natively means the relay over UDP.
  - Print the room code where a player sees it (the console/OSD and stdout), and make it available through the new header for brief 05.
- **Errors and timeouts:** host loss and timeouts behave as today. Relay errors (unreachable, bad code, room full, relay closed the session) end the attempt with a clear message on stdout and the OSD, and the game exits the network start-up the way a failed `-net` start does today. Use `vnet_strerror()`.
- **Player caps:** `MultiSharewareCheck` calls `exit(0)` for more than 4 players on the shareware GRP (code-facts §10). `-host-room N` must be refused or clamped, with a message, before that can happen: 4 on shareware, 8 on registered.

### 3. Test-only and logging hooks (this brief owns them; brief 02 does not touch them)

- **Desync logging.** In a network game a desync is only drawn on screen ("GAME OUT OF SYNC!", code-facts §8). Log it too (`buildprintf`, once per occurrence, with the tic and the sync byte index): that is useful to players and is what the tests grep.
- **More sync bytes, test-only.** In a network game only `RandomSync` is exchanged (`NumSyncBytes == 1`). Add a test-only argument that sets `NumSyncBytes` to 8 on every player (as `-demosync*` do), so the network test checks player, enemy and missile positions too. Every player in a game must use the same value; say how that is ensured or checked.
- **Bounded run, test-only.** There is no "quit after N tics" (code-facts §7). Add a test-only argument that quits cleanly (exit 0) after N game tics, on every player of a network game.
- Mark test-only arguments as such in the code and in `code-facts.md`.

### 4. Determinism

- Nothing in the game's simulation changes. If something must, stop and ask.

## Out of scope

- The browser build (04), menu and console commands (05), "Start now" (05; Q3), joining mid-game (D2), peer-to-peer mode over the relay (D5).
- Changes to vnet. If vnet has a bug, write it up with a reproduction and stop.

## Tests

1. **mmulti over vnet with impairment.** A harness that links the mmulti layer without the game and runs three instances through the `mmulti.h` API, exchanging numbered packets, with loss, duplication and reordering from vnet's impairment layer (`vnet_impair`). It checks every packet arrives once, in order, intact, from the right player, and that all three agree on `numplayers`, `myconnectindex` and `connecthead`/`connectpoint2`.
   - mmulti keeps its state in globals, so three instances cannot share one process as-is. Choose one, and say why:
     (a) three copies of the mmulti objects in one process, with the globals renamed per copy (e.g. a generated `-include` header of `#define`s), on vnet's **loopback** backend, stepped deterministically; or
     (b) three processes over a local Go relay (`VNET_BACKEND_RELAY_UDP`) with impairment on each.
   - Run it from `make test` (or a script it calls), with a fixed seed, and a time limit.
2. **Three game processes.** Three native `sw` processes, headless (see 00's `scripts/run-headless.sh`, each with its own `--workdir`), through a local Go relay: one `-host-room 3`, two `-room <code>`, on the shareware GRP. A co-operative game (`-autonet`, code-facts §4) on a level with monsters, with 8 sync bytes, for long enough that many sync checks have been exchanged (**corrected:** there is one sync check per game tic, not one per 64 moves, and only the master compares, code-facts §8; the test counts the master's checks), then all three quit with the §3 knob and exit 0. The check: no desync logged on any of them, and the expected number of sync checks happened.
3. **Plain UDP is unchanged.** The same three-process game over `-net` on localhost, before and after the change, with the same result.
4. **Errors:** a bad room code, a full room, a relay that isn't running, and the host leaving during the wait each end in a clear message and a non-zero exit (or the existing behaviour, if that is what `-net` does today; say which), within a bounded time.
- **Prove each test fails without the change** where that makes sense: for example, test 1 with mmulti's resend logic stubbed out; test 2 with a deliberate change to the simulation on one player only (e.g. a test-only env var that nudges one value), showing the desync is logged and the test fails, then reverted.

## Acceptance criteria

1. Native builds with both renderer settings, from a fresh recursive clone.
2. Tests 1 to 4 pass, repeatedly (run test 1 ten times and test 2 three times; report the counts).
3. Plain UDP `-net` behaviour is unchanged.
4. The code, room size and errors behave as above, and the new header documents what brief 05 can use.
5. `code-facts.md` is updated with anything new learnt about mmulti.

## Dependencies

00.

## Notes

- **Git:** this brief changes jfbuild. Work on `browser/01-vnet-transport` in both jfsw-browser (from `claude`) and the jfbuild fork (from its `claude`), per "Working across repos". Push both branches after each commit. Commit the jfbuild submodule pointer in jfsw-browser after each jfbuild push.
- The relay needs Go (00's `scripts/setup.sh`) and runs locally on `127.0.0.1`. vnet's `doco/` and `relay/` say how.
- Brief 02 runs at the same time in another worktree, and also changes jfbuild (the SDL layer and the Makefile). Keep your jfbuild changes to the network files and the Makefile lines you need, to make the later merge easy.

## Outcome

Status: **review** (branches `browser/01-vnet-transport` in jfsw-browser and in the jfbuild fork; the coordinator marks it done after review and merge). jfbuild commits `9a6e97c` (the transport) and `a1d7264` (failures leave a state the game can act on), both pushed; the jfsw-browser pointer is on `a1d7264`.

**What landed**

- *Build.* jfbuild's `Makefile` compiles `ext/vnet/src/*.c` (via `VNETDIR ?= ../ext/vnet`) into `libengine.a` as `src/vnet-*.o`, with vnet's own flags only for those files (`-std=c11 -D_POSIX_C_SOURCE=200809L`, `_DARWIN_C_SOURCE` on macOS, `_WIN32_WINNT` on Windows) and `-DUSE_VNET=1 -I$(VNETDIR)/include` for `mmulti_vnet.c`. No CMake. `USE_VNET` is on when that directory exists and can be forced off; without it `mmulti_vnet.c` is stubs and `-relay` is refused with a message. Both renderer settings build from a fresh `make veryclean` (14 and 10 warnings, the same as before; none in the new files); `Makefile.msvc` lists the new object (stub build); the Xcode project was not touched.
- *Transport.* `jfbuild/include/mmulti_vnet.h` (new; `mmulti.h` is unchanged) and `jfbuild/src/mmulti_vnet.c`. `mmulti.c` gained about 70 lines, all additions: the four socket users hand over to the vnet side when `-relay` is given, and the argument parser and `initmultiplayerscycle` have small hooks. A vnet address is stored as an `AF_INET` sockaddr (`10.0.0.N:port`) in mmulti's existing `sockaddr_storage` arrays, so address comparison, printing and the whole start-up handshake are unchanged and `vnet_addr_equal` is not needed. Resend, order and CRC are mmulti's own, untouched. `vnet_poll()` runs inside every send and receive, so `getpacket`, `flushpackets`, `sendpacket` and the start-up cycle all pump it. Details and the full list of what the header offers brief 05 (state, room code, error text, player cap, host player count) are in `code-facts.md` §12 and the header.
- *Arguments*, read among the `-net` arguments: `-relay HOST:PORT`, `-host-room N`, `-room CODE` (see `building.md` §8). The room code is printed to stdout (flushed), the log and the OSD: `mmulti: room code ABC234 (you are 10.0.0.1, relay-udp; the room takes 8 players)`.
- *Caps.* `-host-room N` is clamped (with a message) to 4 on shareware / 8 registered, set by `InitGame` before the wait, and to the relay's room size, so `MultiSharewareCheck`'s `exit(0)` cannot be reached from a hosted game.
- *Errors.* Bad arguments and a failed relay start exit 1 at once (`app_main`); a relay or room failure during the wait ends the wait and `InitGame` prints `Network game failed: ...`, shows a message box and exits 1. A joiner whose host never answers fails after 15 s, one whose host stops answering during the wait after 10 s (relay games only; plain `-net` keeps its unlimited wait). Host loss during the game is as before. `mmulti: the relay session was lost` is printed once if the session ends mid-game.
- *Hooks* (this brief owns them): `GAME OUT OF SYNC: tic ..., sync byte ...` is logged once per sync byte (master only, see below); `-testsync` (8 sync bytes), `-testquit<N>` (quit with status 0 after N game tics), `-testnudge<T>` (a deliberate desync), all marked test-only in `net.h`, `sync.c` and `code-facts.md`. Every player must use the same `-testsync`/`-testquit`: this is checked through the version exchange (`GameVersion + TestVersionSalt()`), which prints `CheckVersion(): player N has version ...` on a mismatch. The only edits outside `sync.c` are one line in `domovethings`, three in `RunLevel`/`InitRunLevel`, and the argument parsing.
- *Tests* in `tests/net/`, run by `make test` (see `building.md` §8). `make test` also brings `libengine.a` up to date, which the top-level `make` does not do by itself.

**Test 1: option (b), three processes over a local relay.** Chosen over (a) because the real, unmodified `mmulti.c` object code runs, with the real relay (rooms, virtual addresses, UDP framing); (a) would need three copies of mmulti with renamed globals (a build of modified code) and a loopback mode inside `mmulti_vnet.c` that production never uses. Given up: exact replay. The seeds fix each process's loss/duplicate/reorder pattern per send, but when sends happen depends on timing, so a run is not bit-for-bit repeatable; nothing the test checks depends on the pattern. `tests/net/mmulti_peer.c` (mmulti.h API only, no game) runs as the master and two slaves with `VNET_IMPAIR="loss=8,dup=5,reorder=8,rdelay=60,lat=15,jit=10,seed=N"` per process (N from 100 on, three per run); each side sends 150 numbered packets of varying length and pattern, and checks sender, sequence (exactly the next one: so once, in order, none lost), length and content; all three must agree on `numplayers=3 connecthead=0 chain=0>1>2` and have indexes `0 1 2`.

**Results**

| Test | Result |
|---|---|
| 1. mmulti over vnet with impairment, `make test-mmulti` | 10 of 10 runs passed (every packet exactly once, in order, intact, 300 sent and 300 received per master; all three agreed on numplayers, myconnectindex, connecthead and the chain) |
| 2. three game processes, relay, co-op E1L1, 8 sync bytes, quit at 1200 tics | 3 of 3 passed, plus passes at 600 and 900 tics (the 900 with `loss=3,dup=2,reorder=3,lat=10,jit=5` on every process), and one UDP run (below). The master made 1195 to 1197 sync checks in 1200 tics (one check per game tic; the test demands at least tics - 40); no desync logged on any process; all three exit 0, numbered 0, 1, 2 |
| 3. plain UDP unchanged, `test-udp-unchanged.sh` | passed: the mmulti layer in all four old/new combinations (150 packets each way); the game three processes over `-net`: old and new binaries both run until stopped, print the same mmulti lines, and old master with new slaves and new master with old slaves both play 600 tics and quit; plus `test-three-games.sh --udp`, 1200 tics, no desync, 1196 checks |
| 4. errors, `test-errors.sh` | passed, 30 checks: malformed code, bad characters, `-room` without `-relay`, `-relay` alone, a `wss://` URL, `-host-room 1` and `many`, unresolvable relay (each exit 1 in about 0.2 s); relay not running (exit 1 after 10.2 s, "the relay did not answer"); no such room (0.2 s); host with all slots filled and a further joiner (exit 1 after 15.4 s, "the host did not answer: the room may be full or the host has left"); relay room full (0.3 s, "the room is full"); host killed during the wait (joiner exit 1 about 10 s later, "the host stopped answering"); caps (6 on shareware clamped to 4, 4 on a relay with rooms of 3 clamped to 3) |

**Each new test fails without the change**

- Test 1 with mmulti's resend logic stubbed out (`--stub-resend`: each packet is marked acknowledged as soon as it is packed, so it is sent once): all three processes fail ("test timed out (sent 300, received 26)" and similar); the 8% loss shows.
- Test 2 with `--nudge 1:300` (or 2:300; `-testnudge300` on one process): the master logs `GAME OUT OF SYNC: tic ..., sync byte ...`, makes about 590 mismatches, and the test fails ("player 0 logged no desync"). Reverted: the same test passes without the switch.
- Test 3 with `--mutate-wire` (the old `mmulti.c` answers a first contact with `0xac` for `0xab`, which nobody understands): the combinations with the changed side as master fail (old/old/old: "test timed out"; old master with new slaves: "start-up wait timed out"), while new master with old slaves, where the changed code only runs in the slaves, still passes.
- Test 4 against the build from before this brief (`--sw` the baseline): `badcode-format`, `room-no-relay` and `no-such-room` all fail (the game ignores `-relay` and waits for a host, 6 failed checks).

**Corrections** (the brief and `code-facts.md`)

- *Sync checks are not every 64 moves*: `getsyncstat` runs on every game tic (`player.c:7896-7900`, through the `#ifdef DEBUG` else), so there is one check per tic, as `code-facts.md` §8 already said; the brief's "every 64 moves" is corrected. *Only the master compares*: slaves store the master's bytes but their comparison call is commented out ("This doesn't work right in this case", `net.c`); a desync shows only on the master. `code-facts.md` §8 now says so; the tests look at the master.
- *The `-net` argument hazard (§4)* is handled for the three new options (the second scan skips them); the loop itself is not fixed, because that would change what `-net -nm:3 -level1` (no `--`) does today.
- *InitGame's wait* on SIGTERM ends in a segmentation fault a moment later (a consequence of `return` on `quitevent`, §10), noted there.
- *The top-level `make` does not rebuild an existing `jfbuild/libengine.a`* (new in `code-facts.md` §12 and `building.md` §8).

**A game bug found (not fixed; not in scope)**: in a 3-player co-op game on shareware E1L1 with idle players, all processes stop at game tic 1522 and spin in the actors' AI (`SpriteControl` -> `InitActorDecide` -> `InitActorReposition`/`DoActorOperate` -> `FindNewAngle` -> `move_scan` -> `clipmove`, sprite 831). It is identical over relay and over UDP and in the unmodified pre-brief build, so it is in the existing simulation. A single-player game passes tic 2500. The network tests quit at 1200 tics for this reason. See `code-facts.md` §12.

**Concerns**

- *Determinism*: nothing in the simulation changed apart from `-testnudge`, which exists only behind that argument. Over the relay, with and without impairment, the three simulations agreed on every sync byte for 1200 tics. Hardware is the same (x86-64) in these runs; native versus wasm remains unverified (brief 02/04). The sync check is weak by design: the sync bytes are the low byte of positions and of a few other values, and only the master evaluates them. A desync that does not move a position, or is cancelled within a byte, is not seen.
- *The `-net` hazard*: any further `-net` sub-option must be added to the skip list in the second scan in `game.c` (brief 05), and must not collide with the `-s`, `-g`, `-h`, `-f`, `-dr`, `-dp`, `-col`, `-name` prefixes.
- *Shareware cap*: handled by clamping at the host. A registered-GRP host with more than 4 players and a shareware joiner would still make the joiner's `MultiSharewareCheck` call `exit(0)` after the game started to connect (mixed GRPs are not supported anyway).
- *Slots*: the slot a joiner takes is the order its first ping reaches the master, not the order the room addresses were given out (10.0.0.2 need not be player 1). A joiner beyond the number of slots enters the relay room but gets no slot and fails after 15 s. Start now (Q3, brief 05) has no hook yet.
- *Time limits*: the 15 s and 10 s limits are constants in `mmulti_vnet.c`. Host loss during a running game is unchanged (stall), so a browser UI should add its own watchdog on `mmulti_vnet_state()` and the lockstep.
- *Machine load*: the tests are real-time (game tics are paced by the clock). With another job loading the cores, startup of three game processes can take over 20 s; the time limits in the scripts are generous (tics / 10 + 60 s for games, 45 s for the UDP comparison) but a very loaded machine can still exceed them.
- *Not done*: the vnet backend is native only (brief 04 does the browser); the Xcode project and `Makefile.msvc` link line for vnet's Windows libraries (`ws2_32` is already in the Windows link flags) are untested; nothing was tried on Windows or macOS.
