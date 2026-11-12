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
- **Step what the room allows, and send at once.** In a hidden tab in a network game, the game must step every tic it can (its clock must not hold it back: the visible machines set the pace), and it must send its packets right after the tics it stepped. Bit Riot lost two thirds of its hidden-tab speed by sending them only at the next wake (S1). Decide how this fits the game's clock (`totalclock`, `sampletimer()`'s quarter-second cap) and its movement loop. Describe the design in the Outcome.
- **Draw nothing while hidden**, if that is cheap. Nobody sees the frames, and drawing costs time the hidden tab doesn't have.
- **Hidden passes only in a network game.** A hidden single-player game must still pause, as it does today (02).
- **A hidden host.** The master is woken by its slaves' packets in the same way. Check that a room with a hidden *host* keeps playing.
- **A tab that is frozen** (a blocked main thread, a sleeping laptop) for a few seconds must not end the game: the room waits, then carries on, and every machine still agrees.

### 3. Cross-play and determinism

- Native and browser players in one room, through one relay: two browsers; a browser host with a native player; a native host with a browser player.
- **Every machine agrees.** Today only the master compares sync bytes (L11), and only the low byte of each coordinate goes in (L12). For the tests, add a **test-only** way for *every* machine to record its own per-tic sync values. For example, `-testsyncdump<name>` writes the nine sync bytes per tic, as `-demosyncrecord` does for demos. In the browser the page hands the file to the test (`window.jfswTest.readFile`). Optionally use stronger values in that dump than the game's sync bytes, e.g. a hash of the full coordinates. The tests then compare the dumps of all machines byte for byte, tic for tic. This must not change what goes on the wire, the version exchange (unless the argument is given, as with `-testsync`), or any game behaviour without the argument.
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

_(to be filled in by the implementer)_
