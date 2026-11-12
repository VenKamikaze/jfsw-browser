# 04b: Netcode lag cuts

## Goal

Shorten the time between a player's input and the tic that uses it, in every network game (browser and native, host and guest), by changing only *when* packets are sent, never what they contain. Prediction (`src/predict.c`) already makes a player's own movement, turning and looking feel local. Shooting, using, opening, inventory and weapon changes are not predicted, so they wait for the full lockstep round trip. That round trip is what this brief shortens.

The user asked for this brief on 12 Nov 2026, after the coordinator read `predict.c` and `net.c` and found two send delays that are not needed.

## Read first

- [`README.md`](README.md): D4, Q5, "Working across repos", and "Bugs found in the original game".
- [`code-facts.md`](code-facts.md): §3 (`mmulti`), §8 (sync), §12 (brief 01), §15 (brief 04: the hidden pass and `mmulti_vnet_flush()`).
- The Outcome of [04](04-browser-netplay.md), especially the review fix round (S1: PAKRATE and the ack that uses the send window) and the `netplay.js` scenarios and helpers you will reuse.
- The code:
  - `src/net.c`: `faketimerhandler` (it makes and sends this machine's input; the master's "I am MASTER" loop at about line 1100 builds and sends the combined packet), `getpackets`, and the lag correction (`myminlag`, `otherminlag`, `bufferjitter`, `TIMERUPDATESIZ`);
  - `src/game.c`: `MoveLoop`;
  - `jfbuild/src/mmulti.c`: `sendpacket`, `dosendpackets` (PAKRATE, one datagram per peer every 25 ms), `getpacket`, `unsent[]`, `mmulti_vnet_flush`.
- [`bugs.md`](bugs.md) L11 and L12 (the sync check's weaknesses; 04's `-testdump` is the real agreement check).

## What the coordinator found (check it; don't take it as given)

1. **The input waits for the send window.** `faketimerhandler` calls `getpackets()` before it makes the input. `getpacket()` calls `dosendpackets()` for every peer first. When 25 ms have passed, that sends a datagram without the new input (acks and resends). The new input's own `sendpacket()` then finds the window used and returns. The input goes out at the next `dosendpackets` after the window: roughly 16 to 33 ms later in a 60 Hz browser tab, up to 25 ms natively. A guest pays it twice, going to the host and coming back. Brief 04 fixed this for hidden tabs only.
2. **The host forwards a tic only at its own timer tick.** The master builds the combined master-to-slave packet only inside `faketimerhandler`, once per master tic. A guest's input that arrives just after the master's tick waits up to 25 ms (about 12 ms on average) before it is forwarded, even when it was the last input missing for that tic.

## In scope

### 1. Measure first (test-only)

- A test-only way for each machine to record, for each tic, when its own input for that tic was made and when the tic ran (`domovethings`). For example, a `-testlag<name>` argument, or extra fields in 04's `-testdump` records (a new argument is safer: the dump format is compared byte for byte). Use one clock per machine (`getticks()` or `performance.now()`), since only differences on the same machine matter.
- Also measure where the time goes, as far as is cheap: the wait between `sendpacket()` and the datagram leaving (`dosendpackets` actually sending), and, on the master, the wait between the last input for a tic arriving and the combined packet going out.
- Report the input-to-tic delay (median, p95) for the master and a slave, before any change. Do it for two browsers, browser and native, and native and native, each unimpaired and with latency impairment (e.g. 30 ms each way). This is the baseline the later steps are measured against.
- Nothing goes on the wire, and nothing changes in the game without the argument (as with `-testdump`). Add any new `-` argument to the skip list in `game.c`'s second argument scan (L1), and check its prefix against the existing ones (`-testsync`, `-testdump`, `-testquit`, `-testnudge`).

### 2. Send each input when it is made

- Once `faketimerhandler` has handed this machine's input to mmulti (`netsendpacket`/`netbroadcastpacket`), it goes on the wire in the same call, not at a later `dosendpackets`.
  - The simplest form: call 04's `mmulti_vnet_flush()` (or a renamed, general version of it) right after the input is sent.
  - The alternative: let `sendpacket()` bypass PAKRATE when it queues new data, and keep the limit for sends that carry only acks or resends.
  - Choose, and say why, in the Outcome.
- This applies to relay games in the browser and natively. Apply it to plain-UDP `-net` games too, unless that makes it harder: the code is shared and the content sent is the same. Say what you did. It is a change to upstream-style code, so keep it small (Q5).
- **The datagram rate stays bounded.** Report datagrams per second per peer before and after, on master and slave. At most about twice the old rate is fine (an input datagram per tic plus the acks); more needs a reason.
- Brief 04's hidden pass keeps working and keeps its checks (owed yields, passes per second). If this step makes the hidden pass's own flush redundant, it may go, but the hidden scenarios must pass unchanged.

### 3. The master forwards a tic as soon as it is complete

- When `getpackets()` on the master stores the last input missing for `movefifosendplc` (every player now has it), the combined packet for that tic, and any later tics that are now complete, is sent then, not at the master's next `faketimerhandler` tick.
- Move the "I am MASTER" send loop into a function called from both places.
- **Hazards to handle:**
  - `getpackets()` reads incoming datagrams into the global `packbuf`, and the master send loop builds its outgoing packet in the same `packbuf`. Sending from inside the receive loop would overwrite the packet being read. Use another buffer, or send after the receive loop.
  - The master only sends a tic once its *own* input for it exists, so this only helps when a slave's input is the last to arrive.
  - The lag correction (`myminlag`, `otherminlag`, `bufferjitter`) measures how far ahead each machine's inputs are. Earlier forwarding changes what it sees. Check that it still settles (no clock oscillation on the slaves; log `otherminlag` and the `totalclock` corrections in a test run) and say what it settles to.
- Nothing about the packet's content, or the order of tics, changes.

## Out of scope

- Prediction itself: predicting shooting or weapon changes, smoothing prediction corrections, drawing mouse turns between tics. These are on the "later" list.
- Any change to the simulation, to `MovesPerPacket`, or to the lag-correction algorithm. If the measurement shows that `bufferjitter` or the slave's clock offset is the biggest remaining cost, report it with numbers; don't change it here.
- vnet, the relay, and peer-to-peer connections (D5).
- Brief 05's UI, and deployment (brief 06; it will cover relay placement and WebTransport in production).
- F1 (on hold).

## Acceptance criteria

1. The measurement exists, is test-only, and reports the baseline and the final delay for the master and a slave, in every combination listed in §1.
2. The slave's input-to-tic delay falls measurably. As a guide, about one tic (25 ms) or more at the median, unimpaired. The master's falls or stays the same. Report the numbers, whatever they are. If a step gains nothing, say so and drop it.
3. Every machine still agrees on every tic: 04's dumps are identical in every scenario, browser and native, both hosting, with impairment.
4. The datagram rate per peer is reported and stays bounded (§2).
5. `netplay.js` (all scenarios), `make test`, `smoke.js`, `persist.js`, `data.js` and `determinism.js` still pass (the last one's 100 ms stall check excepted, as before).

## Tests

1. **A `lag` scenario** (or several) in `tests/web/netplay.js` that runs the §1 measurement and checks the result: the slave's median input-to-tic delay is under a bound set from the measured improvement, with a clear margin. The bound must fail on the old code. A native-only version through `tests/net/` too, if that is cheap.
2. **Agreement**: the existing scenarios (ws, ws3, browser-host, native-host, wt, impaired, impaired-wt, long, nudge-*) still pass with their dumps identical.
3. **Mutations**, each applied, rebuilt, run and reverted:
   - undo step 2 (the delay returns, and the `lag` check fails);
   - undo step 3 (the slave's delay rises by about half a tic, or more under latency);
   - for step 3, use the receive buffer as the send buffer (a dump difference, or a desync, shows it);
   - remove the hidden pass's flush, if step 2 made it redundant (the hidden scenarios still pass).
4. **Regression**: as in criterion 5.

## Dependencies

- 04 (merged): `-testdump`, `netplay.js`, `mmulti_vnet_flush()`, the hidden pass.
- Brief 05 comes after this one.

## Notes

- Repos touched: jfsw-browser and the jfbuild fork, on branches named `browser/04b-lag-cuts` in both, from `claude`. jfaudiolib and jfmact shouldn't need changes.
- Ports, time limits and load as in brief 04's Notes: browser tests on 127.0.0.1 48300 to 48399, native network tests on 47000 to 47999, one test at a time, report the load with every rate or delay.
- After moving the jfbuild submodule pointer, run `make veryclean && make -j4` (`bugs.md` L9).
- Update `code-facts.md` (§15, or a new §16), `building.md` (the new argument and scenario), and `bugs.md` for any lesser bugs found.

## Outcome

(Empty: filled in by the implementer.)
