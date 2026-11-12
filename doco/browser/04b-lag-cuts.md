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

Implemented in two sessions (the first stopped on the tic 1 question below). Branch `browser/04b-lag-cuts` in jfsw-browser and in the jfbuild fork. Status: review.

**What landed**

- *Measurement (test-only).* `-testlag<name>` (`src/sync.c`): one 36-byte record per game tic from this machine's own clock (`CLOCK_MONOTONIC`): input made, every input here, tic ran, how long the packet carrying it waited in mmulti between `sendpacket()` and a datagram leaving, how long the master held the complete tic before queueing the combined packet, `otherminlag`, `bufferjitter`, the clock corrections so far; and at `-testquit` the datagram count per peer. Two observation-only hooks in `jfbuild/src/mmulti.c` (`mmulti_test_queuehook`, `mmulti_test_sendhook`, NULL unless set). A record is written 16 tics after its tic ran: on the old code the datagram, and on the master the combined packet, often left only after the tic had run, so a record written at once said "unknown" for exactly the waits it measures (found while setting the bounds; the first session's numbers for the old code undercounted the master's waits). Nothing goes on the wire and nothing changes without the argument. `-testlag` is not a prefix of, nor prefixed by, `-testsync`, `-testdump`, `-testquit`, `-testnudge` or the new `-teststate`; the game options are scanned by prefix, and these are game options, not `-net` sub-options, so the L1 skip list needs nothing.
- *Step 2: every input goes on the wire when it is made.* `SendInputNow()` (`src/net.c`) calls `mmulti_vnet_flush()` right after `faketimerhandler()` hands mmulti this machine's input (slave, broadcast mode) or the master's combined packet. Chosen over a `sendpacket()` that bypasses PAKRATE for new data because it needs no engine change (the function exists since 04 and sends what is queued, ignoring the window) and keeps the limit for everything else: datagrams with only acknowledgements and resends still go at most once per 25 ms. It applies to every network game, relay and plain UDP alike (`mmulti_vnet_flush()` lives in `mmulti.c` and works on any peer; only its name is vnet's, kept to keep the change small; its comments in `mmulti.c` and `mmulti_vnet.h` now say so).
- *Step 3: the master forwards a tic as soon as it is complete.* The "I am MASTER" loop is `MasterForward()`, called from `faketimerhandler()` as before and from the end of `getpackets()`, **after** the receive loop (`packbuf` is both the receive and the send buffer). The same inputs and the same order of tics; the bytes that depend on when the master sends follow its timing, as they always did: the lag-correction bytes of every 32nd tic (`TIMERUPDATESIZ`: each slave's `myminlag` measured so far) and how many of the master's sync records go in each packet (`AddSyncInfoToPacket`, up to 4, as many as are ready).
- *The hidden pass's own flush is gone*: step 2 made it redundant (all four hidden scenarios measured the same without it: mutation table). The hidden scenarios pass unchanged.
- *The tic 1 difference*: test-only, see below (`-teststate`, the hash, the `tic1` scenario).
- *Tests:* `lag` (in the full run), `tic1` (in the full run; the master gets the test-only `-testslowstart<ms>`, added in the fix round), `lag-matrix` (the report, only by name); `NETPLAY_SW` (another native build), `NETPLAY_STATE` (state dumps and named fields on a dump difference). Docs: `code-facts.md` §16, `building.md` §6.5, `bugs.md` L17 and L19, this Outcome.

**The tic 1 difference** (investigated first). Case **(a)**: the hash covered state that legitimately differs per machine: the drawing code's scratch space.

- *Made observable.* `-teststate[<T>]` (new, test-only, with `-testdump<name>`) writes `<name>.state`: the whole state as text, one line per object (globals, every connected player, every live sprite with its User, every stat list, the head of the free list, every sector with its sprite list and SectUser, every wall, the sector objects, the `Anim` list, the interpolations, the hash), when `RunLevel` starts, at the start of tics 1 to 3 and at tic T. `netplay.js` names the differing objects and fields when two machines' dumps first differ at a tic that has a state dump (`NETPLAY_STATE=1`, or `=600,1200`). It is off by default because the first dump (1.3 MB on E1L1) delays a browser's first frame, and that by itself changes how a game starts.
- *Reproduced: 180 games, 90 differed.* That delay turned out to make the case frequent. Short games (20 tics), `-teststate`, the old hash, one at a time, load 1 to 4, every pairing on the three builds:

| build | browser + browser | browser host + native | native host + browser | native + native |
|---|---|---|---|---|
| before (claude and the measurement hooks) | 5 of 15 differed | 15 of 15 | 0 of 15 | 0 of 15 |
| step 2 only | 9 of 15 | 14 of 15 | 13 of 15 | 0 of 15 |
| steps 2 and 3 | 6 of 15 | 15 of 15 | 13 of 15 | 0 of 15 |

  In all 180 games the dumps differed **exactly when** one machine ran tic 1 after a single drawn frame and the other after more (`numframes` in the state dumps), never otherwise. So it is not caused by 04b, which only makes the uneven start more likely when a browser is the slave (its first frame is less often before the master's inputs). The native-only games never had a machine with a single frame (a native game drew 13 to 39 frames before tic 1 here).
- *Which state.* In every differing game the field comparison at tics 1 to 3 found exactly two fields: `ang` of sprites 51 and 924 (1 on the machine that had drawn one frame, 0 on the other); every other field of every object agreed. The records agreed again from that machine's second frame on (1 to 8 records differed).
- *What wrote it, and why the amount differs.* Sprites 51 and 924 are E1L1's two ceiling/floor picture override markers (`STAT_CEILING_FLOOR_PIC_OVERRIDE`, picnum 2307, hitag 136, set up in `sprite.c`). On every frame `FAF_DrawRooms()` (`draw.c`) saves the sector's ceiling (or floor) stat into the marker's `ang` (`SPRITE_TAG4`) and its picnum into `xvel` (`SPRITE_TAG5`), substitutes the override picture, draws, and restores the stat from `ang` **with the parallax bit cleared**. So after the first frame `ang` holds the map's stat (1, parallax) and after any later frame the stat without it (0). How many frames a machine draws before tic 1 is timing: a browser whose first frame comes late catches its clock up inside that frame (many inputs at once), and the next `MoveLoop` runs tic 1. Nothing else reads those two fields of those sprites: they have no User, their cstat (0x8000, 0xa000) has no blocking or hitscan bit, and the only other code that walks that stat list is `PreCacheOverride` (picnum). Not prediction and not start-up code: the state at `start` (after `InitRunLevel`, before the first input) agreed in every game, and nothing else differed at tic 1.
- *The fix (test-only, `TestStateHash()`, with a comment).* The markers' `ang` is left out of the hash; and every sector's ceiling and floor stat is now hashed, because the same first frame clears the parallax bit of the two override sectors (sector 149's ceiling, 238's floor) for good, the same on every machine that has drawn, and the game does read that bit (a shot into a parallax sky: `weapon.c`, `player.c`). So the hash still covers everything the angle stood for, and more.
- *Not hiding a real difference.* With the fixed hash, 40 more short games (10 per pairing, state dumps on, 24 of them uneven) all agreed; the `tic1` scenario checks the records **and** every field at the start and tics 1 to 3 in 8 games (two of each pairing), and makes every game uneven for certain: the master gets the test-only `-testslowstart3000` (it waits 3 s before its first frame with its clock running, so that frame makes its due inputs, forwards tic 0 and it runs tic 1 straight after; the slave draws 148 to 1,720 frames meanwhile). It requires all 8 to be uneven. With the old hash (mutation, rerun in the fix round) all 8 games fail, and the field comparison then reports only the hash as differing. All 48 `lag-matrix` games and every scenario of the full run agreed record for record with the stronger hash.
- *Found on the way* (bugs.md L19, **a game-breaking, reproducible desync that brief 04's hidden pass introduced; not fixed here, the user decides where**): a browser tab hidden before the level's first frame (a guest who switches tabs while the host starts the game) never draws, keeps the two parallax bits, and so differs from the other machines in sector state from tic 1 on. The simulation reads those bits every tic, with no shot needed: `move_missile()` (`sprite.c` about 7348) turns any missile there, enemy fire included, into `HIT_PLAX_WALL`; `DoPlayerTestPlaxDeath()` (`player.c` about 5447) kills a player who lands on a parallax floor, on the hidden machine only; `SectorZadjust()` (`rooms.c` about 427) changes z ranges over a parallax floor; `SpawnSplash()` and the hitscan paths in `weapon.c` test it too. Measured: native host, browser slave hidden from its start: all 200 records differ, and the field dumps name exactly `sector 149 ceilingstat` and `sector 238 floorstat`. In the original game every machine draws before tic 1, so it does not happen there. Likely fixes: apply `FAF_DrawRooms()`'s lasting effect once when a level starts without a frame drawn, or draw one frame before a hidden tab goes headless. No scenario hides a tab before its first frame.

**Results: input to tic** (median ms of each game from tic 200 to 1,200, two `lag-matrix` runs of each build one after another, one at a time; headless Chromium, software-rendered, 4 shared cores, load average as given; "before" is `claude` with the measurement hooks, `MasterForward()` called only from `faketimerhandler()` and an empty `SendInputNow()`):

| game (first hosts) | machine | before | step 2 only | steps 2 and 3 | load before / 2 / 2+3 |
|---|---|---|---|---|---|
| browsers | master | 66.1, 50.8 | 31.9, 27.9 | 51.2, 30.2 | 3.5, 4.8 / 5.5, 4.7 / 4.8, 4.7 |
| browsers | slave | 117.5, 100.9 | 75.5, 55.9 | 78.7, 78.6 | 3.5, 4.8 / 5.5, 4.7 / 4.8, 4.7 |
| browsers-30ms | master | 151.4, 131.4 | 99.9, 129.9 | 105.8, 102.1 | 5.2, 5.5 / 5.9, 6.3 / 5.1, 5.2 |
| browsers-30ms | slave | 188.7, 197.8 | 155.1, 150.3 | 153.1, 147.4 | 5.2, 5.5 / 5.9, 6.3 / 5.1, 5.2 |
| browser-host | master | 94.8, 137.4 | 104.1, 55.1 | 46.4, 135.8 | 5.2, 5.2 / 5.6, 5.8 / 5.2, 5.0 |
| browser-host | slave | 175.6, 174.8 | 126.0, 99.1 | 93.0, 101.3 | 5.2, 5.2 / 5.6, 5.8 / 5.2, 5.0 |
| browser-host-30ms | master | 262.1, 181.5 | 165.1, 162.3 | 184.2, 186.1 | 5.0, 6.0 / 5.5, 4.8 / 5.0, 5.0 |
| browser-host-30ms | slave | 300.5, 224.8 | 200.8, 175.1 | 225.5, 177.1 | 5.0, 6.0 / 5.5, 4.8 / 5.0, 5.0 |
| native-host | master | 100.5, 76.4 | 75.8, 50.2 | 58.6, 125.0 | 5.5, 5.1 / 5.7, 4.7 / 5.8, 5.2 |
| native-host | slave | 179.5, 164.6 | 104.4, 85.3 | 88.2, 146.4 | 5.5, 5.1 / 5.7, 4.7 / 5.8, 5.2 |
| native-host-30ms | master | 149.1, 302.2 | 101.1, 128.1 | 125.7, 101.4 | 5.7, 5.3 / 5.5, 5.4 / 5.5, 5.6 |
| native-host-30ms | slave | 188.9, 325.7 | 148.8, 165.7 | 177.4, 156.1 | 5.7, 5.3 / 5.5, 5.4 / 5.5, 5.6 |
| natives | master | 25.5, 25.6 | 25.5, 25.6 | 25.5, 25.6 | 4.1, 3.7 / 4.0, 3.9 / 4.0, 4.0 |
| natives | slave | 50.4, 51.2 | 25.7, 25.6 | 25.6, 25.6 | 4.1, 3.7 / 4.0, 3.9 / 4.0, 4.0 |
| natives-30ms | master | 88.2, 86.9 | 73.6, 73.5 | 73.6, 73.3 | 3.1, 3.0 / 3.0, 3.0 / 3.1, 3.2 |
| natives-30ms | slave | 104.7, 104.8 | 65.2, 65.3 | 63.7, 63.4 | 3.1, 3.0 / 3.0, 3.0 / 3.1, 3.2 |

Where the time went:

| game | slave packet wait in mmulti, median: before / after | master packet wait: before / after | master holds a complete tic, mean (p95): before | step 2 only | steps 2 and 3 | datagrams a second, master / slave: before | after |
|---|---|---|---|---|---|---|---|
| browsers | 28.2, 27.5 / 0.1, 0.1 | 27.3, 25.2 / 0.1, 0.1 | 5.7 (19.4), 4.3 (18.2) | 6.3 (20.6), 2.2 (17.2) | 0.0 (0.0), 0.0 (0.0) | 29.3, 29.6 / 29.7, 29.4 | 54.2, 55.7 / 59.3, 59.4 |
| browsers-30ms | 27.3, 27.0 / 0.0, 0.0 | 27.8, 26.4 / 0.0, 0.0 | 4.5 (19.6), 4.6 (19.7) | 5.0 (19.9), 6.8 (19.7) | 0.0 (0.0), 0.0 (0.1) | 29.8, 29.3 / 29.4, 29.6 | 53.1, 53.0 / 59.4, 59.2 |
| browser-host | 15.4, 13.5 / 0.0, 0.0 | 31.7, 31.0 / 0.1, 0.2 | 3.5 (18.8), 3.5 (19.4) | 3.1 (18.4), 5.0 (20.9) | 0.0 (0.1), 0.0 (0.1) | 25.7, 25.9 / 38.9, 39.0 | 53.1, 47.8 / 70.4, 68.0 |
| browser-host-30ms | 14.1, 14.7 / 0.0, 0.0 | 31.1, 31.3 / 0.0, 0.0 | 3.2 (19.1), 3.9 (19.7) | 4.7 (21.5), 4.5 (20.1) | 0.0 (0.1), 0.0 (0.1) | 24.2, 26.3 / 38.8, 38.9 | 45.1, 49.2 / 71.0, 67.3 |
| native-host | 32.2, 31.7 / 0.1, 0.1 | 14.4, 15.2 / 0.1, 0.1 | 12.3 (23.3), 9.9 (22.6) | 12.5 (22.8), 14.2 (23.5) | 0.0 (0.0), 0.0 (0.0) | 39.0, 39.0 / 25.3, 26.0 | 57.5, 57.0 / 58.4, 57.9 |
| native-host-30ms | 30.2, 34.2 / 0.0, 0.0 | 14.8, 15.4 / 0.0, 0.0 | 11.1 (22.6), 11.9 (22.2) | 12.5 (23.2), 10.6 (22.7) | 0.0 (0.0), 0.0 (0.0) | 39.0, 39.0 / 27.2, 23.7 | 55.9, 55.4 / 59.1, 59.5 |
| natives | 14.5, 13.8 / 0.0, 0.0 | 14.5, 14.4 / 0.0, 0.0 | 7.8 (22.5), 7.8 (22.4) | 0.0 (0.0), 0.0 (0.0) | 0.0 (0.0), 0.0 (0.0) | 39.1, 39.0 / 39.0, 38.9 | 69.0, 68.4 / 71.6, 70.9 |
| natives-30ms | 14.8, 13.0 / 0.0, 0.0 | 14.4, 14.9 / 0.0, 0.0 | 11.4 (22.9), 11.2 (22.4) | 2.0 (3.8), 2.1 (3.9) | 0.0 (0.0), 0.0 (0.0) | 39.1, 38.9 / 39.0, 39.0 | 65.3, 64.2 / 68.6, 69.0 |

- *Slaves* gain the most: two browsers 101 to 118 ms before, 79 after (about 30 ms, more than a tic); two native games 51, 25.6 (one tic); native with 30 ms each way 105, 63.5 (41 ms). Games with a browser and a native machine are the noisiest (the browser shares the cores with everything): their slaves are lower after on the whole (browser host: 175 and 176 before, 93 and 101 after; native host: 165 and 180, 88 and 146), but single runs overlap. *Masters* fall or stay the same within the noise: browsers 51 and 66 before, 30 and 51 after; natives 25.5 unchanged; natives with 30 ms 87 and 88, 73.5; the mixed games move both ways by more than a tic between runs of the same build.
- *The wire.* The send wait is gone: 25 to 32 ms at the median for a browser's packets and 13 to 15 for a native machine's before, 0.0 to 0.2 after. Datagrams per peer: 24 to 39 a second before, 45 to 72 after, 1.8 to 2.0 times (about one per input plus the acknowledgements the window still paces); the test bound is 80. **Many of the extra ones are redundant** (review N2, verified with counts `-testlag` now logs: on the slaves about two thirds of the increase, on the masters a fifth to two thirds): `faketimerhandler()` calls `getpackets()` before it makes the input, `getpacket()` calls `dosendpackets()`, and when the window has passed that sends a datagram with acknowledgements only, just before the flush sends the input with the same acknowledgements. In a `lag` run, of each slave's 1,803 to 2,110 datagrams (two runs) 1,202 to 1,206 carried new data and 597 to 908 only acks or resends, and 590 to 762 of those went in the same receive pass just before one with new data (about 20 to 25 a second, a third of all); the masters had 70 to 575 such. A later cut (an acknowledgement-only datagram not sent when an input is about to follow, or the input made before the receive) would take a slave back to about 40 to 46 a second; it needs a change in `mmulti.c`'s pacing and was not made here. Brief 06 should size the relay for about 70 datagrams a second per player and direction.
- *Step 3's share.* It removes the master's forwarding wait completely (mean 0.0 and p95 at most 0.1 ms after, in every game). Before it, with step 2 only, that wait was a mean of 2 to 7 ms (p95 17 to 21) with a browser master, 11 to 14 ms (p95 23) with a native master and a browser slave, 2 ms with two native games and 30 ms latency, and 0 between two unimpaired native games (their 120 Hz timers keep the master's own input last, once step 2 makes the slave's arrive sooner). In end-to-end delay that is measurable only where the noise is small: natives with 30 ms, slave 65.2 and 65.3 with step 2 only, 63.7 and 63.4 with both (about 1.7 ms); natives unimpaired 25.6 either way. In the browser games the share (expected about the mean wait, 2 to 14 ms) is smaller than the game-to-game spread under this load (browsers' slave: 75.5 and 55.9 with step 2 only, 78.7 and 78.6 with both), so **for browsers it is not measurable here**. It is kept because it removes a wait of 10 to 14 ms on average for every native master with a browser guest, and up to a tic (p95 about 20 ms) for every master, which the brief's "about half a tic" expected; the `lag` test checks the mechanism.
- *Lag correction.* It settles: on the slaves `otherminlag` at -1 to 4 and `bufferjitter` at 1 tic (native slaves) or 3 to 9 (browser slaves; higher with 30 ms); after tic 200 the clock was corrected not at all in 13 of 16 `lag-matrix` slave games, by 3 or 6 clock ticks in the rest, and in the `lag` runs at most once and never back and forth. A browser slave's tics now wait longer in the lockstep buffer (about 34 ms against 14 to 30) while its input comes back complete in about 42 ms instead of 85: the lag correction holds them longer, which gives back part of the saving. That buffer is now the largest remaining cost in browser games; it is the lag-correction algorithm, out of scope (reported, not changed).
- *Agreement.* Every measured game agreed record for record (except the 90 short games above, with the old hash): 48 `lag-matrix` games, 24 `lag` games (all builds), 40 short games with the fixed hash, and the full run below.

**Tests** (final tree, rebuilt with `make veryclean && make -j4` and `scripts/build-wasm.sh` after the last pointer move; one test at a time):

- `node tests/web/netplay.js` (every scenario but `lag-matrix`, one after another, 16.6 minutes, load average 2.9 to 7.4): **547 passed, 0 failed**. Every game's dumps were identical record for record (with the stronger hash). `lag`: 73 checks (browsers: slave 73.8 ms median, master 50.3; native host with a browser: 75.8 / 110.4; natives with 30 ms: master 73.3, slave 63.4; packet waits 0.0 to 0.1 ms; forwarding 0.0 / 0.0); `tic1`: 109 checks, 5 of 6 games uneven; the hidden scenarios without the pass's flush: 40.0 tics a second on both machines, 42 to 67 passes a second, at most 6 yields with data held back.
- `make test GAME_RUNS=1`: **5 PASS, 0 FAILED**, exit 0 (7.6 minutes; includes the plain-UDP comparison against the pre-brief-01 build, so plain `-net` with the flush still talks to the old game).
- `tests/web/smoke.js` **29 passed, 0 failed**; `persist.js` **15 passed, 0 failed**; `data.js` **172 passed, 0 failed**.
- `tests/web/determinism.js` **20 passed, 1 failed**: the known "no stall over 100 ms" frame check (7,259 frames over 140 s: median 16.8 ms, p95 36.7, p99 69.3, max 300; load average 3.3). The native and wasm sync bytes and `.dms` files are identical in both directions.
- Native build: 14 warnings, as before (none in the code 04b touched).

**Mutations** (each applied, rebuilt into its own directory, run with `NETPLAY_SW`/`WASM_DIR`, reverted):

| Mutation | Run | What failed |
|---|---|---|
| undo step 2 (`SendInputNow()` empty) | `lag` | 7 failed: every machine's packets waited 13.6 to 31.5 ms in mmulti at the median (bound 5), and the native slave with 30 ms took 100.5 ms at the median (bound 85) |
| undo step 3 (no `MasterForward()` from `getpackets()`) | `lag` | 2 failed: the browser master held a complete tic 0.0 / 19.5 ms (median / p95; mean 6.3) and the native master 9.9 / 22.1 (mean 10.3), bound 2 / 8. The slave's delay did not rise measurably in the browser games (see step 3's share); with 30 ms between natives by about 1.7 ms |
| both undone (the "before" build) | `lag` | 10 failed (both of the above) |
| step 3 with the receive buffer as the send buffer (`MasterForward()` inside the receive loop, right after a slave's input is stored, before its sync bytes are read from `packbuf`) | `ws`, `native-host` | the master logged `OUT OF SYNC` in both (it read its own outgoing packet's sync bytes as the slave's): 2 failed; the dumps still agreed (the input had already been copied out) |
| the hidden pass's flush removed (step 2 made it redundant) | `hidden-slave`, `hidden-host`, `hidden-thin`, `hidden-frozen` | nothing: 86 passed (40.0 tics a second, 6 of 1,535 yields with data held back, 43 passes a second hidden slave); so it was removed |
| the old hash (markers' angle in, sector stat out) | `tic1` | first version: 8 failed (the three uneven browser-host games, 1 to 2 records each); rerun with `-testslowstart` in the fix round: **32 failed, all 8 games** differ at tic 1 (9 to 26 records) and the field comparison names only the hash |

**Concerns**

- *Step 3 for browsers* is a mechanism gain (the forwarding wait is gone) whose end-to-end effect is below the noise of this container; on a quiet machine it should be visible as a few ms for a guest of a browser host and about 10 ms for a guest of a native host.
- *The bounds.* The `lag` test bounds the mechanisms (packet wait under 5 ms, forwarding under 2 / 8 ms, at most 80 datagrams a second), which were 0.0 to 0.2 ms, 0.0 / 0.1 ms and 45 to 72 here at load 3 to 6, and the end-to-end delay only for two native games with 30 ms (85 ms; 63.4 to 63.9 after, 100 to 105 before). Browser delay is reported, not bounded: it moved by 20 ms between two runs of the same build.
- *The buffer.* After 04b the lockstep buffer (`bufferjitter`) is the largest part of a browser guest's delay and grew a little; it is the lag-correction algorithm (out of scope).
- *L19* (above): a game-breaking, reproducible desync for a guest who switches tabs before the level's first frame. Caused by brief 04's hidden pass, not by 04b or the original game; for the user to decide where it is fixed.
- *Datagram rate* about doubles (1.8 to 2.0 times), and many of the extra datagrams are redundant acknowledgements (about 20 to 25 a second per slave, above); a relay serving many rooms sees that (brief 06).
- *Not done:* the optional native-only `tests/net/` version of the lag test (the `lag` scenario's native game covers it); Firefox, a real GPU, a real network.

**Play-test steps (Arch Linux)**

```
sudo pacman -S --needed base-devel git unzip python nodejs npm go sdl2 libvorbis libogg mesa glu alsa-lib gtk3
git clone --recurse-submodules -b browser/04b-lag-cuts https://github.com/VenKamikaze/jfsw-browser
cd jfsw-browser
scripts/setup-emsdk.sh && scripts/build-wasm.sh      # about 3 minutes the first time
scripts/fetch-test-data.sh && make -j4
cp testdata/swshare.grp build-wasm/
(cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
/tmp/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v      # terminal 1
(cd build-wasm && python3 -m http.server 8000 --bind 127.0.0.1)                          # terminal 2
```

Host natively and join from the browser (or the other way round, as in brief 04's play-test):
`./sw -net -relay 127.0.0.1:7777 -host-room 2 -- -autonet 2,1,2,1,0,0,0,0,0,0`, then the page `http://127.0.0.1:8000/?test=1&args=-net%20-relay%20ws://127.0.0.1:7778/vnet%20-room%20CODE%20--%20-autonet%202,1,2,1,0,0,0,0,0,0` (the code is in the native game's console and stdout).

Things only a person can check:
- **Does shooting feel sooner?** Fire, open a door, switch weapons as the guest (the browser, and then a second native game as guest); compare with the same on `claude` (build both: `git worktree add ../jfsw-claude claude`). The guest should feel about a tic (25 ms) or more quicker; the host about the same or a little quicker. Movement and turning were already predicted and should feel unchanged.
- **Over a real network** (the relay on another machine, or Wi-Fi): the same comparison; and check that the game does not stutter more than before (the datagram rate doubled).
- **A tab hidden before the game starts** (L19, known to desync): host natively, open the browser guest and switch to another tab before the host's game starts, come back after a minute and play near the start area; the host's console should say `OUT OF SYNC` sooner or later. Only to see it for yourself; it is not fixed in this branch.
- **The tests on your own machine**: `node tests/web/netplay.js lag tic1`, and `node tests/web/netplay.js lag-matrix` for the full table (about 7 minutes; the numbers will be lower and steadier than here).

### Review fix round

- **S1 (MSVC build).** `TestLagNow()` uses `QueryPerformanceCounter()`/`QueryPerformanceFrequency()` under `_WIN32` (declared in `sync.c` as `windows.h` declares them, so the file does not include it) and `clock_gettime(CLOCK_MONOTONIC)` elsewhere; `<time.h>` only outside `_WIN32`. Microseconds either way. The state dump prints address offsets as `long long` with `%lld` (it truncated on Win64). Not built with MSVC here (no Windows); the native and wasm builds are unchanged otherwise.
- **S2 (L19).** Rewritten as above and in `bugs.md`: a game-breaking, reproducible desync introduced by brief 04's hidden pass (missiles, a player landing on a parallax floor, z ranges, splashes and hitscans read the bits every tic). Not fixed; the likely fixes are named.
- **N1.** The `MasterForward()` comment, `code-facts.md` §16 and this Outcome say: the same inputs and order of tics; the lag-correction and sync-check bytes follow the master's timing, as before (checked: `myminlag` is updated at each of the master's own inputs and sent and reset every 32nd tic; `AddSyncInfoToPacket` sends up to 4 of the sync records that are ready).
- **N2.** Verified and documented (the wire, above; `code-facts.md` §16). `-testlag`'s log line now splits the datagrams into those with new data, those with acknowledgements and resends only, and those of the latter sent in the same receive pass just before one with new data. Behaviour not changed.
- **N3.** The comment above `HiddenNetPass()` says that the pass now flushes once per input it makes (plus a receive pass that completes a tic on the master), bounded by its at most 9 `faketimerhandler()` calls and `MoveLoop()`: at most about 19 datagrams per peer, on a catch-up pass only.
- **N4.** `-testslowstart<ms>` (new, test-only, inert without it): the machine waits that long when the level starts, before its first frame, with its clock running (by yielding in the browser, since a busy wait stopped the other pages of the same Chromium; by a busy wait natively). It first flushes mmulti: without that, the packet `waitforeverybody()` had just queued could sit in the send window until the machine polled again, so the others stayed in their own wait for those seconds (seen in the first version of the scenario: 2 of 8 games even). `tic1` gives it to the master (a slow slave would not do: its tic 1 needs a round trip after its first frame) in 8 games over the four pairings and requires all 8 to be uneven: 8 of 8 in every run since. Old-hash mutation rerun: 32 failed (table).
- *Results after the fix round*: rebuilt from clean (`make veryclean && make -j4`, `scripts/build-wasm.sh clean` and build; no pointer move in this round), one at a time: `netplay.js` **591 passed, 0 failed** (17.0 minutes, load average 2.4 to 7.7; `tic1` 8 of 8 uneven; the `lag` datagram counts as above); `make test GAME_RUNS=1` **5 PASS**, exit 0; `smoke.js` **29/0**; `persist.js` **15/0**; `data.js` **172/0**; `determinism.js` **20/1**, the known stall check (7,464 frames over 140 s: median 16.8 ms, p95 33.8, p99 64.1, max 189; load 3.8), native and wasm sync bytes identical. Native warnings: 14, as before.

### Coordinator verification and merge (12 Nov 2026)

- Independent review (read-only, own worktree): no blockers; S1 (MSVC build), S2 (L19 severity) and N1 to N4 were fixed or documented in the fix round above; N5 (browser delays reported, not bounded) accepted.
- Fix diff read (`8a9385a..eb03a72`). Rebuilt from clean (`make veryclean && make -j4`: 14 warnings as before; `scripts/build-wasm.sh clean` and build), one test at a time: `netplay.js` 591 passed, 0 failed; `make test GAME_RUNS=1` 5 PASS; `smoke.js` 29/0; `persist.js` 15/0; `data.js` 172/0; `determinism.js` 20/1 (the known "no stall over 100 ms" check: max 133 ms, p99 53.7 ms, load 2.5 to 4.2; it needs real hardware).
- Merged: jfbuild `browser/04b-lag-cuts` into the fork's `claude` (`a610e1e`, same tree as the verified `5b0016a`), the pointer moved to it (`9c701f2`), then jfsw-browser with `--no-ff`.
- L19 stays open for the user (bugs.md).

