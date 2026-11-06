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
2. **Three game processes.** Three native `sw` processes, headless (see 00's `scripts/run-headless.sh`, each with its own `--workdir`), through a local Go relay: one `-host-room 3`, two `-room <code>`, on the shareware GRP. A co-operative game (`-autonet`, code-facts §4) on a level with monsters, with 8 sync bytes, for long enough that many sync checks have been exchanged (they are sent every 64 moves: state how many), then all three quit with the §3 knob and exit 0. The check: no desync logged on any of them, and the expected number of sync checks happened.
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

_Not started._
