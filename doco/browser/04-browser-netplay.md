# 04: Browser netplay

## Goal

The browser build plays network games over vnet. The same relay room can hold browser players and native players, in any mix and with either one hosting. Every machine in a room agrees on every tic. A tab that goes hidden keeps the room playing at full speed. Brief 05 then adds the commands, menus and lobby overlay that lead into these games; this brief makes the game itself work.

## Read first

- [`README.md`](README.md): D1 to D5, D7, D10, Q5, "Working across repos", and "Bugs found in the original game".
- [`code-facts.md`](code-facts.md): §3 (`mmulti`), §4 (start-up order and the command line, and the `-net` argument hazard), §5 (where the game blocks), §7 and §8 (demos, sync data and its weaknesses), §12 (brief 01: mmulti over vnet, the test hooks), §13 (brief 02: the browser port).
- The Outcomes of [01](01-vnet-transport.md) and [02](02-emscripten-port.md). They record what actually landed: the native relay transport and its tests, the `EMSCRIPTEN` block in `jfbuild/Makefile` that swaps `mmulti.c` for `mmulti_null.c`, the two yields in `jfbuild/src/sdlayer2.c`, the page's test hooks, and both "Concerns" lists (hidden tabs, the time limits, the weak sync check).
- [`bugs.md`](bugs.md) L1 (new `-net` sub-options must be skipped in the second argument scan), L11 (only the master compares sync bytes) and L12 (only the low byte of each coordinate is hashed).
- vnet's `doco/integration.md`, in full, especially "Hidden browser tabs" and "Setup details". vnet is `ext/vnet` at `v0.4.0`. It is not changed from here.
- Bit Riot's `doco/netplay/12-browser-netplay.md` and its Outcome, on Bit Riot's `claude` branch (`git fetch https://github.com/VenKamikaze/BitRiot claude`). It solved the same hidden-tab problem. Read "Background tabs", the review fix round (S1: send the inputs after every stepped frame, not at the next wake) and how its tests imitate a hidden, throttled tab. Reuse what it learnt; don't copy its code.

## In scope

### 1. The vnet-backed mmulti in the browser build

- Replace `mmulti_null.c` in the `EMSCRIPTEN` block of `jfbuild/Makefile` with the real `mmulti.c` plus `mmulti_vnet.c` and `ext/vnet/src/*.c`, built as brief 01 builds them natively (vnet's own flags only for vnet's files). Link `-lwebsocket.js` in `Makefile.emscripten`. The WebTransport transport needs no extra flag (vnet `doco/11-vnet-webtransport.md`).
- `mmulti.c` doesn't compile for the browser (code-facts §13: `IP_RECVDSTADDR`, `IP_SENDSRCADDR`, `recvmsg` control messages). In the browser only relay games exist, so compile the plain-UDP socket code out under `__EMSCRIPTEN__` (small `#ifdef`s, Q5), or find a neater split. `mmulti.h` stays unchanged (D4). A plain `-net` without `-relay` in the browser fails with a clear message and exit status 1. It doesn't silently start a single-player game.
- `mmulti_vnet.c` uses `VNET_BACKEND_RELAY_AUTO` (D4): WebTransport, then WebSocket in the browser; relay-over-UDP natively, as now.
- **Arguments.** In the browser, `-relay` takes the relay's WebSocket URL (`wss://host/vnet`, or `ws://127.0.0.1:PORT/vnet` for local tests). The WebTransport URL is derived from it by vnet, unless given. Natively `-relay` keeps taking `HOST:PORT` and still refuses a URL. Any new sub-option (e.g. a WebTransport URL or a certificate hash for tests) is added to the skip list in `game.c`'s second argument scan (L1) and must not collide with the prefixes listed in 01's Outcome ("The `-net` hazard"). Test-only knobs stay test-only: a development certificate hash, an explicit WebTransport URL and an impairment spec are read only on a page with `?test=1` (Bit Riot review fix S5: a crafted link must not route a visitor through another relay or degrade their connection). A browser has no `VNET_IMPAIR`, so impairment needs such a knob, passed to `vnet_config.impair`.
- **The page.** `web/config.js` gets the relay's WebSocket URL (empty by default: no relay configured). With `?test=1`, `?args=` already passes game arguments; that is how the tests start network games. Starting a network game without `?test=1` (`?host=`, `?join=`, the lobby, the menu entries) is **brief 05**, not this one. Whatever reaches `wm_msgbox` before an exit (a failed relay, a bad code, a full room, the host lost during the wait) must show on the page's end-of-game overlay. It mostly already does (02); check it with the network failures.

### 2. Hidden tabs

A hidden tab stops `requestAnimationFrame` and runs timers at about 1 Hz (less after five minutes). Today `showframe()`'s yield then waits for its 100 ms timer, so the game gets a turn about once a second, and `sampletimer()` caps one clock step at a quarter second. In a lockstep game that tab then delivers its inputs late, and every other player waits for it.

- **Drive the hidden tab from network events.** Set `vnet_config.wake`. The callback must not call vnet: it posts a message through a `MessageChannel` (not `emscripten_async_call` or `setTimeout`, which are throttled). The message resumes the game if it is suspended in a yield. Keep a timer-driven turn (about 1 Hz is enough) for vnet's own deadlines (vnet's `integration.md`).
- **Step what the room allows, and send at once.** In a hidden tab in a network game, the game must step every tic it can (its clock must not hold it back: the visible machines set the pace), and it must send its packets right after the tics it stepped. Bit Riot lost two thirds of its hidden-tab speed by sending them only at the next wake (S1). Decide how this fits the game's clock (`totalclock`, `sampletimer()`'s quarter-second cap) and its movement loop. Describe the design in the Outcome. (**Correction found in the work:** in this game the input for a tic is made and sent by `faketimerhandler()`, which the engine calls from inside its drawing code, not by the movement loop. A hidden pass that draws nothing must therefore call it itself, which is the whole of "send at once" here: `sendpacket()` sends immediately. Letting a hidden tab run ahead of its clock was built and measured and gave nothing; see the Outcome and `code-facts.md` §15.)
- **Draw nothing while hidden**, if that is cheap. Nobody sees the frames, and drawing costs time the hidden tab doesn't have.
- **Hidden passes only in a network game.** A hidden single-player game must still pause, as it does today (02).
- **A hidden host.** The master is woken by its slaves' packets in the same way. Check that a room with a hidden *host* keeps playing.
- **A tab that is frozen** (a blocked main thread, a sleeping laptop) for a few seconds must not end the game: the room waits, then carries on, and every machine still agrees.

### 3. Cross-play and determinism

- Native and browser players in one room, through one relay: two browsers; a browser host with a native player; a native host with a browser player.
- **Every machine agrees.** Today only the master compares sync bytes (L11), and only the low byte of each coordinate goes in (L12). For the tests, add a **test-only** way for *every* machine to record its own per-tic sync values. For example, `-testsyncdump<name>` writes the nine sync bytes per tic, as `-demosyncrecord` does for demos. (**Landed as `-testdump<name>`**: `-testsyncdump` would have been taken for `-testsync`, which the argument scan matches by prefix. It also writes a hash of the whole simulation state; see the Outcome.) In the browser the page hands the file to the test (`window.jfswTest.readFile`). Optionally use stronger values in that dump than the game's sync bytes, e.g. a hash of the full coordinates. The tests then compare the dumps of all machines byte for byte, tic for tic. This must not change what goes on the wire, the version exchange (unless the argument is given, as with `-testsync`), or any game behaviour without the argument.
- Keep brief 02's native-against-wasm demo check passing (`tests/web/determinism.js`).

## Out of scope

- Commands and menus to host or join, `?host=`/`?join=` without `?test=1`, the lobby overlay, "Start now", the desktop startup window's room-code field: all brief 05.
- Deployment (Apache, TLS, a real certificate, systemd): brief 06.
- Joining mid-game (D2), peer-to-peer mode over the relay (D5), music (Q4), WebGL (D6).
- **F1** (the co-op freeze at tic 1522): on hold at the user's request. Don't fix it here (see Tests).
- Any change to the simulation (movement, AI, weapons). Only test-only hooks behind arguments. If the cross-play test finds a native-against-wasm difference, **stop and report it** with the first differing tic and what differs, before fixing anything.
- Changes to vnet. If vnet looks wrong, report it.

## Acceptance criteria

1. `scripts/build-wasm.sh` builds the browser game with the vnet transport. The native build and `make test` are unchanged and green.
2. Two browsers, and a browser with a native player (each side hosting once), play a relay game: co-op, E1L1, with `-autonet`, `-testsync` and `-testquit`. No desync is logged, every machine's per-tic sync dump is identical, and all players end with status 0.
3. Over WebSocket and over WebTransport (vnet's `RELAY_AUTO` with a `-dev-cert` relay; check the transport each browser actually used), and with impairment on every machine.
4. A hidden, throttled browser tab, as a slave and as the host, keeps the room at **at least 90 %** of the nominal tic rate (measured on the other machines, in tics per second over at least 30 s), and every machine still agrees. With the wake handler disabled, the same scenario falls well below that (the proof).
5. A browser tab that is frozen for 5 s mid-game: the room resumes, every machine still agrees, and the game doesn't end.
6. Failures in the browser end on the page's overlay with the game's message: relay unreachable, no such room, room full, host gone during the wait, and a plain `-net` without `-relay`.
7. Test-only knobs work only with `?test=1`.
8. Nothing in the simulation changed. Brief 02's demo check (native against wasm) still passes.

## Tests

Use Playwright with Chromium (preinstalled; **never** run `playwright install`), a local Go relay built as brief 01's tests build it, and native games run with `scripts/run-headless.sh` or the `tests/net/` helpers. Put the browser tests in `tests/web/` (e.g. `tests/web/netplay.js`, with named scenarios that can run one at a time). Each test stops every process it started, as `tests/net/lib.sh` does.

1. **Two browsers**, WebSocket: a whole bounded game (1200 tics, as in brief 01), sync dumps equal, no desync.
2. **Browser and native**: a browser host with a native slave, then a native host with a browser slave. Dumps equal.
3. **WebTransport**: the same as 1 over WebTransport (a `-dev-cert` relay, the hash passed as a test knob). Check the transport each browser reports.
4. **Impairment**: 1 or 2 with loss, duplication, reordering and latency on every machine (a different seed per machine).
5. **Hidden tab**: Playwright can't really hide a tab (Bit Riot 12, "What the tests did instead"). Imitate it as Bit Riot did: override `document.hidden` and `visibilityState` and dispatch `visibilitychange`; stop `requestAnimationFrame`; hold `setTimeout`/`setInterval` to at least one second; leave WebSocket, WebTransport and `MessageChannel` events alone. Measure the tic rate on every machine: once with a hidden slave, once with a hidden host.
6. **Frozen tab**: block one page's main thread for 5 s mid-game.
7. **Errors**: the failures in criterion 6, each checked on the page.
8. **Knob gating**: the test-only knobs do nothing without `?test=1`.
9. **Desync detection works**: `-testnudge` on one browser makes the master log `GAME OUT OF SYNC` and the dumps differ from that tic on. Do it once with the nudged browser as a slave and once as the master.
10. **Regression**: `make test`, `node tests/web/smoke.js`, `persist.js`, `data.js` and `determinism.js` (the last one's 100 ms stall check fails in this container under load, as recorded in 02; report its numbers, don't count it).

**"No desync across a full level"** (PROMPT §5) needs F1, which is on hold. A three-player co-op game on E1L1 freezes at tic 1522 in the unmodified game. So the bounded games quit at 1200 tics, as brief 01's do. Also try, and record, one longer game that avoids the freeze, if a cheap one exists: two players, another level or deathmatch. Don't investigate the freeze itself.

**Prove each new test fails without the change**, by a mutation applied, rebuilt, run and reverted. For example: the wake handler emptied (the hidden-tab rate falls); sending moved back to the next wake (the hidden-tab rate falls); the dump compared with one byte flipped; the knob gate removed. List them in the Outcome.

## Dependencies

- 01 (native transport, test hooks, relay build) and 02 (browser build, page, yields): both merged.
- vnet `v0.4.0` (`ext/vnet`).
- Can run alongside 03 (merged already). Brief 05 depends on this one.

## Notes

- Repos touched: jfsw-browser and the jfbuild fork, on branches named `browser/04-browser-netplay` in both (README, "Working across repos"). jfaudiolib and jfmact shouldn't need changes. If one does, stop and ask the coordinator (jfmact has no `claude` branch).
- The relay checks the page's origin: `-origins` matches `host:port` exactly (a page on `127.0.0.1:48301` needs `-origins 127.0.0.1:48301`).
- Ports: browser tests use 127.0.0.1 ports 48300 to 48399, and native network tests keep 47000 to 47999 (`JFSW_TEST_PORT_BASE`), so different tests don't collide.
- Tics are paced by the clock (01: about 40 game tics per second). The tests are real time and the container has 4 shared cores: run them one at a time, and set the time limits as brief 01 did. A headless Chromium renders the canvas in software, which costs CPU. Say what the load was when you report rates.
- After moving the jfbuild submodule pointer, run `make veryclean && make -j4` (`bugs.md` L9).
- Update `code-facts.md` (a new §15 for this brief), `building.md` (how to run the new tests, the new arguments), and `bugs.md` if you find lesser bugs. Game-breaking bugs you find: report them to the coordinator, who writes a brief.

## Outcome

Status: **review** (branch `browser/04-browser-netplay` in jfsw-browser and in the jfbuild fork; the coordinator marks it done after review and merge). jfbuild commits `d3b1f3a` (the vnet-backed mmulti for the browser, the hidden-tab driver), `b53291f` (a draw counter for the tests) and `a0d6606` (review fix round), all pushed; the jfsw-browser pointer is on `a0d6606`. jfsw-browser commits: `1af888c`, `8463cb6`, `e50a061`, `e7fca4e`, `a6cb7af` and the review fix round (see `git log`). Nothing was merged, no pull request was opened, `claude` and `master` were not touched in any repo. Not tested: a person playing, real Firefox/Safari, a real (non-headless) tab that is really hidden, a public relay with a real certificate, Windows or macOS.

**What landed**

- *Browser mmulti.* The `EMSCRIPTEN` block in `jfbuild/Makefile` no longer swaps in `mmulti_null.c`; the engine library holds `mmulti.c`, `mmulti_vnet.c` and `ext/vnet/src/*.c`, and `Makefile.emscripten` links `-lwebsocket.js`. `mmulti.c` compiles its plain UDP code out under `__EMSCRIPTEN__` (the three socket functions become short versions that only know the relay); the native side is unchanged and `mmulti.h` is unchanged. In the browser `-relay` takes the relay's `ws://`/`wss://` URL (a `HOST:PORT` is refused with a message); `VNET_BACKEND_RELAY_AUTO` tries WebTransport and falls back to WebSocket. A plain `-net` without `-relay` ends the game with a message on the overlay (exit status 1). No new `-` argument for the knobs, so the second argument scan needed no change.
- *Test knobs.* `?relay_wt=`, `?relay_cert=` and `?impair=` reach the game through `Module.jfswKnobs`, which `web/jfsw.js` fills only on a `?test=1` page. `web/config.js` has the (empty) `relay` field for brief 05.
- *Hidden tabs.* `jfbuild/src/sdlayer2.c`: with a relay session and `document.hidden`, a yield ends on a vnet wake (callback posts to a `MessageChannel`), on `visibilitychange` or on a 250 ms timer, and `handleevents()` yields on every call. `src/game.c`/`src/net.c`: in that state `RunLevel` draws nothing and calls `HiddenNetPass()` (`faketimerhandler(); MoveLoop();`). A hidden single player game is not affected. Design and what was tried: `code-facts.md` §15.
- *Per-machine sync record.* Test-only `-testdump<name>`: 17 bytes per game tic (tic, nine sync bytes, a hash of the whole state), flushed per tic, nothing on the wire.
- *Also fixed:* `libengine.a` / `libengine.wasm.a` are deleted before `ar rc` (bugs.md L15: a stale `mmulti_null.o` made the browser ignore `-net` silently).
- *Docs:* `code-facts.md` §15 (new), `building.md` §6.5, `bugs.md` L15 to L17 (L11/L12 notes), this Outcome.

**Hidden-tab design** (the brief asks for it here; rewritten in the review fix round: the first version claimed inputs were "sent at once", which was wrong). The browser gives a hidden tab no animation frames and about one timer tick a second. vnet's wake callback fires from the WebSocket / WebTransport event that queued a datagram; it only posts a message (a `MessageChannel` message is not throttled, a timer is). The message resumes the game from its yield; the game then runs one pass (`HiddenNetPass`): `faketimerhandler()` (makes this player's input for a tic if its clock says one is due) once and then again while another is due (at most 8: catching up to the tab's own clock, not running ahead of it), then `MoveLoop()` (receives, and moves every tic for which all players' inputs are in). Nothing is drawn or presented, and a 250 ms timer (clamped to 1 s by the browser) keeps vnet's own deadlines running. **Sending.** `sendpacket()` queues at once but mmulti's `dosendpackets()` puts at most one datagram per peer on the wire every 25 ms (`PAKRATE`), and `getpackets()` inside `faketimerhandler()` can spend that window on an ack first, so an input could sit until the next network event. The pass therefore ends with `mmulti_vnet_flush()` (new, mmulti.c): it sends what is held back now, ignoring the window; only the hidden pass calls it. (The first fix re-posted a message while data was held back, which spun at about 1,000 passes a second and kept a core busy; replaced after review.) A hidden tab runs about 31 to 40 passes a second, one per network event. The pass is used only when a relay session exists; a hidden single player game still pauses as in brief 02 (about 10 tics a second measured). The clock itself needs no bypass: `sampletimer()` runs in real time inside the pass. A first version let a hidden tab make inputs ahead of its own clock and a hidden master relay by itself; neither changed the rate (40.0 either way; a 3 s stall left the room 0.8 to 1.2 s late either way, the game already speeds a slave up by the lag it measures), so both are gone.

**Results** (final run of `node tests/web/netplay.js` after the fix round, all scenarios one after another: **365 passed, 0 failed**; headless Chromium, software-rendered canvas, 4 shared cores, load average 4 to 6 while the games ran). Every game: co-op E1L1, 2 or 3 players, `-autonet 2,0,2,1,0,0,0,0,0,0 -testsync -testquit1200 -testdump`; each machine ended with status 0, played at least 1,200 tics, logged no `OUT OF SYNC` and no `CheckVersion()`, and **every machine's dump was identical record for record** (tic, nine sync bytes, state hash).

| Scenario | Checks | What it shows |
|---|---|---|
| `ws` | 15 | two browsers over the WebSocket; both report `relay-ws` |
| `ws3` | 21 | three browsers |
| `browser-host` | 14 | browser host, native slave (UDP to the relay): browser and native machines agree on every tic |
| `native-host` | 14 | native host, browser slave: the same |
| `wt` | 35 | two browsers, then a native host with two browsers, over WebTransport (`-dev-cert` relay, hash and URL as knobs); every browser reports `relay-wt` |
| `impaired` | 39 | `lat=30,jit=10,loss=4,dup=2,reorder=3`, a seed on every machine: browser host + native slave, then three browsers |
| `impaired-wt` | 17 | two browsers over WebTransport with it; both report the knob in use |
| `hidden-slave` | 21 | a hidden, throttled browser slave (no animation frames, timers held to 1 s, `document.hidden`; WebSocket and `MessageChannel` left alone), **hidden at tic 140; the rate is measured from 100 tics after the hide (here tic 250) to tic 1450**: 40.0 tics a second on the visible host and 40.0 on the hidden tab; 1,122 vnet wake-ups, 0 pictures asked for after the hide; 27,226 of its yields were entered with data held back by the send window and ended at median 0.0 / p95 0.1 ms |
| `hidden-thin` | 21 | the same with only every 10th vnet wake-up let through (`?wake_every=10`, as if the peer were quiet): 39.3 and 39.2 tics a second (an old-style pass, one input per pass and no kick, ran at 16 with every 12th) |
| `hidden-host` | 21 | a hidden, throttled browser host with a native slave, hidden at tic 139: 40.0 and 40.0 |
| `hidden-frozen` | 23 | the hidden slave's main thread stuck for 3 s (hidden at tic 145): the room is 1.1 s late afterwards (not 3 s), all agree, 40.6 / 40.2 tics a second from tic 700 |
| `hidden-local` | 6 | a single player game in a throttled hidden tab: 0 hidden-tab passes, the picture is still asked for once a frame, 10.1 tics a second against 41.6 visible |
| `frozen-slave` | 16 | a visible browser slave blocked for 5 s at tic 334: the host moves 3 tics meanwhile, then the room goes on to 1,200 and everybody agrees |
| `frozen-host` | 16 | a browser host blocked for 5.1 s (native slave): the slave moves 14 tics, then the same |
| `nudge-slave` | 13 | `-testnudge300` on the slave: the master logs `GAME OUT OF SYNC: tic 300, sync byte 1 (PlayerSync), player 1 differs from the master`; the dumps first differ at tic 301 and all 400 later state hashes differ |
| `nudge-master` | 13 | the same with the master nudged (5 log lines) |
| `errors` | 34 | on the page overlay, status 1: relay not listening (4.0 s, "the relay could not be reached"), plain `-net` (0.2 s), a `HOST:PORT` `-relay` (0.2 s), a malformed room code (0.2 s), no such room (0.2 s), room full (0.4 s), host gone during the wait (10.2 s after it left: "the host stopped answering") |
| `knobs` | 8 | without `?test=1` the page hands the game no knobs and has no test hooks; with it all three arrive, the game says so, WebTransport takes effect, a bad impairment spec is refused |
| `relay-lost` | 5 | the relay drops a tab that was frozen 6 s (`-session-timeout 3s -keepalive 1s`): 3.6 s after it thawed that machine's game ends with status 1 and "Network game failed: the relay ended the session ..." on the overlay |
| `long` | 13 | one longer game: co-op on **E1L2**, 2 players, 5,000 tics (about two minutes), browser host and native slave, 40.0 tics a second, all records equal |

Regression, on the same tree (native rebuilt with `make veryclean && make -j4`): `make test GAME_RUNS=1` **5 PASS, 0 FAILED** (including the plain-UDP comparison and the error tests); `node tests/web/smoke.js` **29 passed, 0 failed**; `data.js` **172 passed, 0 failed** (all of these re-run after the fix round); `persist.js` **15 passed, 0 failed** (earlier runs gave 14/1 on  "save: reloaded 250 ms after game0.sav reached its full size, the save was still there in 2 of 3 tries" "save: reloaded 250 ms after the save...", an edge-of-window check, brief 02; three failures in the first runs after heavy jobs, clean in every later one including this one); `determinism.js` **20 passed, 1 failed**, the failure being the known 100 ms stall check (median 17.1, p95 63.5, p99 140, max 366 ms over 140 s, load 3.5): the native and wasm `.dms` files are still identical in both directions. Native warnings: unchanged (none in the new code).

**Each new test fails without the change** (one mutation at a time, rebuilt, run, reverted and rebuilt; the first rows were run on the first version of the pass and not repeated, the rows marked on the build with the kick, and the others, on the build of this fix round):

| Mutation | Test | What failed |
|---|---|---|
| the wake handler emptied (`jfbuild_browser_wake`), on the build with the kick | `hidden-slave`, `hidden-host` | 0 wake-ups; the room runs only on its own kicks and the timer: **10.2 tics a second (hidden slave) and 10.9 (hidden host)** instead of 40, 7 checks failed in each |
| `HiddenNetPass` without the kick (S1) | `hidden-thin` (also `hidden-slave`) | yields entered with data held back last median 98 ms / p95 107 ms (hidden-thin; 32 / 41 ms in `hidden-slave`) against the 15 ms limit: 1 failed. The tic rate stays at 40 (the data is late, not lost) |
| `HiddenNetPass` without both the kick and the catching-up loop (the first version) | `hidden-thin` with `NETPLAY_WAKE_EVERY=12` | 16.1 tics a second, 7 failed. Each alone: the loop without the kick 16.0 (7 failed); the kick without the loop 34.4 and 33.9 (2 failed, below 36); both 37.3 and 38.1 (pass). The test's default is every 10th (39.2 to 40.0 with both) |
| the lost-session exit in `RunLevel` disabled (S4) | `relay-lost` | the frozen machine never ends (30 s, "Ready."): 3 failed |
| `HiddenNetPass()` without `faketimerhandler()` | `hidden-slave` | the whole room stops once the tab is hidden: dumps of 131 and 127 tics; 7 failed |
| `hidden_netgame()` without the "relay session exists" condition | `hidden-local` | 12 hidden-tab passes in a single player game and no frame yields: 2 failed |
| `RunLevel` draws while hidden | `hidden-slave` | 523 pictures asked for after hiding (limit 20): 1 failed |
| knob gate `if (TEST)` made `if (true)` | `knobs` | the page hands all three knobs to the game without `?test=1`: 1 failed |
| the browser's plain-`-net` refusal removed | `errors` | the game starts single player ("Ready.", still running after 60 s): 4 failed |
| one byte of player 1's record flipped at tic 600 | `ws` | "first difference at tic 600 (record 599): p0 against p1 differ in PlayerSync": 1 failed |
| the relay run with `-session-timeout 3s -keepalive 1s` (a negative control, nothing of mine to mutate: vnet and the game already survive a freeze) | `frozen-slave` | the relay drops the frozen member after 3 s ("session closed by the relay"); the game is stuck at tic 339: 6 failed. With `NETPLAY_FREEZE_MS=20000` against a normal relay the game survived a 20 s freeze in one trial |
| a harsh impairment (`NETPLAY_IMPAIR='lat=150,jit=40,loss=25,dup=5,reorder=10'`, a control) | `impaired-wt` | the same 1,200 tics take 180 s instead of 34 s and one machine has 1,176 when the limit hits: 3 failed (the ordinary spec costs nothing measurable: 34.1 s against 33.6 s unimpaired) |
| `-testnudge` on the slave or the master | `nudge-slave`, `nudge-master` | these are the proof that the dump comparison and the master's log see a desync, and that the dumps stay different |

Not mutation-run: the `wt` scenarios (a run without the two knobs would report `relay-ws` and fail the transport check; not tried), `native-host`/`browser-host` (a native-against-wasm difference would show as a dump difference; none exists to introduce), `ws3`, `long`, the `errors` cases other than plain `-net`, and the free-run variant described above (it was a measurement, not a test).

**Corrections** (to the brief and `code-facts.md`; both are updated in this branch)

- *`-testsyncdump`* would have been taken for `-testsync` (matched by prefix in the argument scan): the argument is `-testdump<name>`. Brief and `building.md` say so.
- *Where the input is made.* §5 of `code-facts.md` said the clock is polled by `handleevents()` and `getpackets()`; the part that matters for a hidden tab is that **`faketimerhandler()` (net.c), which makes and sends the player's input for a tic, is called by the engine from inside its drawing code**. A pass that does not draw must call it. Added to §15 and to the brief's hidden-tab section.
- *The game already catches a slow slave up* (`totalclock -= synctics * i`, net.c), so the brief's "step ahead of the clock" is not needed (above).
- *`tests/web/lib.js` `warpScript` (and `DET_WARP`) do not change the game's pace*: a single player game ran at 40 tics a second with `performance.now` made 1x, 1.5x and 2.5x faster (measured; the page's own `performance.now()` did run faster). I could not tell why (`clock_gettime` is what SDL's counter uses). I did not use it for anything here and did not touch it; the "play the long demos 4x faster" shortcut of `determinism.js` may not work.
- *A stale static library* hid the whole browser mmulti (bugs.md L15), fixed.

**Concerns**

- *A really hidden tab* was not tested; Playwright cannot hide one (as Bit Riot found). The imitation is `document.hidden`/`visibilityState` overrides, no animation frames, timers held to 1 s; WebSocket, WebTransport and `MessageChannel` events untouched. Chromium's intensive throttling after five minutes hidden (timers about once a minute) is covered only by reasoning: the wake path does not use timers, and vnet keeps the session alive across a long gap. Play-test it.
- *Mid-game relay loss* now ends that machine's game with the overlay message and status 1 (bugs.md L18, `relay-lost`). A host that disappears while the others' sessions are fine still stalls them as in brief 01; brief 05's UI needs a watchdog for that.
- *A hidden tab in a running game keeps a core busy*: while mmulti holds data back it runs passes back to back (about 1,000 a second; 27,000 to 47,000 hidden yields in a 35 s game). No finer wait exists in a hidden tab (timers are clamped to 1 s). Whether a real browser throttles chains of messages in a long-hidden tab, or a laptop minds the load, is for the play-test.
- *Draw skipping in a hidden tab* skips `drawscreen()` altogether (its `DrawCheckKeys` and panel/sprite bookkeeping included). All 14 hidden runs agreed record for record with machines that did draw, so nothing the simulation reads is lost, and with the drawing put back (mutation) the same results came out, so skipping is only a saving of CPU.
- *Latency in a hidden tab.* A hidden tab is driven by events, so its input falls due when the next event arrives (at most one other player's input interval, 25 ms, in a 2-player room; sparser if the others are paused): a pass can be a little late. The measured rate was exactly nominal; what it does to the felt latency of the visible players was not measured.
- *`bounded` games are 1,200 to 1,500 tics* because of F1 (the 3-player co-op freeze at tic 1522). A 2-player E1L1 game passed 1,500 tics; E1L2 passed 5,000. I did not look at F1. A deathmatch game played its 5,000 tics and agreed but did not exit (bugs.md L16, not investigated).
- *CPU.* Software-rendered Chromium, two or three of them and the game wasm on four shared cores; the rates above held at load 4 to 6, but a quieter machine would not hurt.
- `persist.js` and the 100 ms stall check of `determinism.js` are as flaky or as unverifiable as before (above).
- *Not done:* Firefox, a real GPU, mixed GRPs, anything on Windows or macOS (nothing was tried there; the native side only gained the `libengine.a` rebuild rule).

**Play-test steps (Arch Linux)**

```
sudo pacman -S --needed base-devel git unzip python nodejs npm go sdl2 libvorbis libogg mesa glu alsa-lib gtk3
git clone --recurse-submodules -b browser/04-browser-netplay https://github.com/VenKamikaze/jfsw-browser
cd jfsw-browser
scripts/setup-emsdk.sh && scripts/build-wasm.sh      # about 3 minutes the first time
scripts/fetch-test-data.sh && make -j4               # the shareware data, and the native ./sw
cp testdata/swshare.grp build-wasm/
(cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
/tmp/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v      # terminal 1
(cd build-wasm && python3 -m http.server 8000 --bind 127.0.0.1)                          # terminal 2
```

Host from a browser: open `http://127.0.0.1:8000/?test=1&args=-net%20-relay%20ws://127.0.0.1:7778/vnet%20-host-room%202%20--%20-autonet%202,1,2,1,0,0,0,0,0,0`, click "Click to start", and read the room code from the DevTools console (`mmulti: room code ABC234 ...`) or the game's on-screen console. Join from a second tab (same URL with `-room ABC234` instead of `-host-room 2`, in a second Chromium window), or from the desktop game: `./sw -net -relay 127.0.0.1:7777 -room ABC234 -- -autonet 2,1,2,1,0,0,0,0,0,0`. And the other way round: `./sw -net -relay 127.0.0.1:7777 -host-room 2 -- -autonet 2,1,2,1,0,0,0,0,0,0` natively, the page with `-room CODE`.

Things only a person can check:
- **A tab that is really hidden.** With a native host and a browser guest playing, switch to another tab for a minute, then five minutes (Chrome's intensive throttling), and back. The native window must never show the game waiting for more than a moment and the guest's picture must be current as soon as you return. Then host from the browser, hide that tab and watch the native guest keep playing.
- **A frozen or sleeping tab:** in Chrome `chrome://discards`, *Freeze* the guest's tab for 5 s, or suspend the browser with `kill -STOP` / `kill -CONT`; the other player's game stops, then carries on. (A laptop lid closed for a few seconds is the same.)
- **Sound and feel** in a network game: shooting, doors, enemies; does the lag with a second player feel like the desktop game?
- **WebTransport against a real certificate** and **Firefox** (brief 06): which transport the log line says (`relay-wt` or `relay-ws`).
- **Errors:** a wrong room code, the relay stopped before you press start, a third player in a 2-player room: the page should show the game's message and a reload button.
- **The tests on your own machine:** `npm i playwright && npx playwright install chromium`, then `node tests/web/netplay.js` (about 14 minutes, one scenario at a time with `--list` and a name).

### Review fix round

- **S1 (sent at once was false): fixed and tested.** `dosendpackets` sends one datagram per peer per 25 ms; `getpackets()` inside `faketimerhandler()` can use the window for an ack, so an input waited for the next network event. `mmulti_vnet_sendpending()` (new, mmulti.c) plus `jfbuild_browser_kick()` keep the hidden tab passing until it is out. The comment, `code-facts.md` §15 and this Outcome are corrected. Test: every hidden scenario now records how long each hidden yield lasted that was entered with data held back (`Module.jfswOwedLog`) and requires p95 under 15 ms (measured 0.1 ms; without the kick 107 ms in `hidden-thin`, 41 ms in `hidden-slave`); the check first requires at least 50 such yields, so it cannot pass vacuously.
- **S2 (one input per pass): fixed, with a qualification.** The pass loops `faketimerhandler()` while an input is due (at most 8). With the vnet wake-ups thinned (`?wake_every`), one input per pass and no kick ran at 16 tics a second with every 12th wake-up; both changes together give 37 to 38 (every 12th) and 39 to 40 (every 10th, the test's setting). At the ordinary 40 wake-ups a second the old pass already held 40 tics a second, because `domovethings` also calls `faketimerhandler()` from its long loops, so the reviewer's example (a host sending every 30 ms) is covered by that, not by this loop; the loop only matters when wake-ups are sparse. Neither change alone is enough there.
- **S3 (rate window not tied to the hide): fixed.** The tests record the tic at which the tab was hidden (120 to 145 in every run), start the window 100 tics later (tic 250 or, with the stall, 700) and fail if the hide came after it began. The earlier numbers were not wrong: the window began 105 to 130 tics after the hide. The reviewer's count (about 1,130 hidden yields cover at most 1,070 tics) assumed one tic per pass; a pass moves every tic that is ready (about 1.2 per yield here) and the 40 tics a second is read from the dump files, not from the yield counter.
- **S4: fixed (cheap).** bugs.md L18; `RunLevel` ends a relay game whose session is FAILED once nothing has moved for 2 s: overlay message, status 1, 3.6 s after the frozen tab thawed (`relay-lost`, 5 checks; fails with the exit disabled).
- **N1** the `USE_VNET=0` stub refuses plain `-net` under `__EMSCRIPTEN__` too and the `mmulti.c` comment says so. **N2** the `MessageChannel` and the `visibilitychange` listener are made by the first hidden yield. **N3** an over-long `relay_wt`, `relay_cert` or `impair` knob is refused with a message, not cut. **N4** the `ws://` / `wss://` check is case-insensitive. **N5** partly: a game started without `?test=1` but with the knobs in its address runs and reports none; it cannot be started into a network game before brief 05, so that is all there is to check. **N6** the run-time figures say about 15 minutes everywhere (a full run took 14 to 16 minutes). **N7** the wake-handler mutation was run against `hidden-host` as well (10.9 tics a second).
- *Results after the fix round*: `netplay.js` **365 passed, 0 failed**; `make test GAME_RUNS=1` 5 PASS; `smoke.js` 29/0; `data.js` 172/0; `persist.js` 15/0; `determinism.js` 20/1 (the stall check: median 17.1, p95 63.5, p99 140, max 366 ms; native and wasm `.dms` identical).
