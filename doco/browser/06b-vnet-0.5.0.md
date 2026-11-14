# 06b: vnet 0.5.0: WebTransport at full speed for browser hosts (L31)

## Goal

Move `ext/vnet` from `v0.4.0` to `v0.5.0` and show that a browser host with two or more guests over WebTransport runs at 40 tics a second (bugs.md L31 fixed). Then make WebTransport the deployment guide's default again, with nothing else lost or slower.

## Dependencies

06 (the guide, `check-deploy.sh --wt`), 05b if it has merged (rebase onto it). vnet `v0.5.0` (`8572c74`), its brief 15 and that brief's Outcome (`ext/vnet/doco/15-wt-datagram-bursts.md` once moved).

## What vnet 0.5.0 changes (from its brief 15 Outcome; check it)

- **Browser.**
  - vnet's 16-write limit on WebTransport datagrams is gone. A datagram is now refused only when 512 are queued, or when the oldest unsettled write has been stale for 250 ms, counted from the first event-loop turn after it was made.
  - `datagrams.outgoingHighWaterMark` is set to 64 when the session opens.
  - New: `vnet_stats.tx_dropped`, which counts datagrams the backend dropped.
- **Relay.**
  - A WebTransport reader that only drains, with a bounded queue of its own (`/stats` gains `wt_rx_queue_drops`).
  - A per-client send queue of 512.
  - quic-go is **vendored** in `relay/third_party/quic-go` (v0.59.0 with two queue constants raised to 1024; `go.mod` has a `replace`). It costs about 3.5 MB per connection at worst (`relay/README.md`, "Sizing WebTransport").
- **API:** an addition only (minor bump). Check that nothing in `jfbuild/src/mmulti_vnet.c` or the page breaks.
- **Firefox was not tested** by vnet.

## In scope

1. **The upgrade.**
   - Move the submodule to `v0.5.0` (record the commit).
   - Rebuild native, wasm and the relay from clean: `make veryclean && make -j4`, `scripts/build-wasm.sh`, `bugs.md` L9.
   - Check that `deploy.md`'s relay build commands, including the arm64 cross-compile, still work with the vendored quic-go and the `replace`.
2. **Show that L31 is fixed.**
   - Add a `netplay.js` scenario: a browser host with two browser guests (or a browser and a native guest) over WebTransport. Check the tic rate, about 40 a second over 1,200 tics, and `tx_dropped` 0 or close to it.
   - Measure the same game on `v0.4.0`, which should be about 25. If you can, do it as a mutation (an old relay or an old page).
   - Run it in Firefox too, through `tests/web/firefox.js`'s set-up from brief 02c, if cheap. Firefox supports WebTransport and the user plays in it.
   - `check-deploy.sh --wt`: its tic-rate warning becomes a real check, and it must pass.
3. **The guide.**
   - Make WebTransport the default again in the relay unit, with the certificate copy and `CAP_NET_BIND_SERVICE`. The WebSocket-only set-up becomes the documented alternative.
   - Update the L31 caveat, the ports table, "Check it" and troubleshooting.
   - Add the new `/stats` fields (`wt_rx_queue_drops`, and `wt_datagram_drops` if it is listed) and the memory note.
   - `check-deploy.sh`'s default run checks WebTransport again; keep a WebSocket-only mode.
4. **Records:** `bugs.md` L31 fixed (how, the measurements), the README, `code-facts.md` where vnet's behaviour is described, `building.md`, and PROMPT §0.

## Out of scope

Any change to vnet itself: report problems, as a vnet follow-up for the user. Also brief 05b's content, and F1.

## Acceptance criteria

1. A browser host with two guests over WebTransport runs at about 40 tics a second, and every machine agrees on every tic.
2. No regression:
   - `netplay.js` full;
   - `make test GAME_RUNS=1`;
   - `smoke.js`, `persist.js`, `data.js`, `grptable.js`, `focus.js`, `determinism.js` (its known stall check is excepted; rerun and report both runs);
   - `check-deploy.sh` in every mode.
3. `deploy.md` defaults to WebTransport again, and every block in it is checked as before.

## Notes

- **Repos touched:** jfsw-browser only (the submodule pointer).
- **Branch:** `browser/06b-vnet-0.5.0` from `claude`.
- **Ports:** 497xx, apart from `check-deploy.sh`'s fixed ones.
- **Play-test for the user, on their own server:**
  - rebuild and redeploy the relay (the vendored quic-go);
  - redeploy the page;
  - host a three-player game from a browser over WebTransport (`relay-wt` in the console);
  - check it feels like the WebSocket game;
  - check `/stats` for `webtransports`, and that `wt_rx_queue_drops` stays 0.

## Outcome

**Status: review.** Implemented 14 Nov 2026 on `browser/06b-vnet-0.5.0` (from `claude` `8a16f0b`, in a worktree of its own). Commits: `0d56c0a` (`ext/vnet` to `v0.5.0`, `8572c74`), `40134f3` (`netplay.js wt-host`, `firefox.js` part 4, `NETPLAY_RELAY`), `f185be6` (the guide, `check-deploy.sh`, the records), and the Outcome commit. Nothing in the game, the engine or the page changed; vnet itself was not changed.

### What vnet 0.5.0 changes, checked

- **The browser side** is as the brief says (`ext/vnet/src/relay_wt.c`): the 16-write cap is gone; a datagram is refused when 512 are queued or the oldest unsettled write is stale (250 ms from the first event-loop turn after it, counted with a `MessageChannel`); `outgoingHighWaterMark` is set to 64 at open; `vnet_stats.tx_dropped` is new (appended to the struct). The API change is an addition only: `jfbuild/src/mmulti_vnet.c` compiles unchanged, natively and for the browser, with the same warnings as before (14 native; the wasm build's one in `mmulti_vnet.c`, `sockport` set but not used, was there on 0.4.0 too). The page does not touch any of it.
- **The relay**: the draining WebTransport reader with its own bounded queue (`/stats` `wt_rx_queue_drops`), a per-client send queue of 512 (`wt_datagram_drops`), and quic-go vendored in `relay/third_party/quic-go` with a `replace` in `go.mod`. The guide's build lines work with it unchanged: `check-deploy.sh` builds the relay with the server line (`CGO_ENABLED=0 go build -trimpath ...`) and cross-compiles with the PC line (`GOOS=linux GOARCH=arm64 ...`; `file`: "ELF 64-bit ... ARM aarch64 ... statically linked"); `netplay.js` and `firefox.js` build it with a plain `go build`.
- **Built from clean** after the pointer moved (bugs.md L9): `scripts/build-wasm.sh veryclean` and a full wasm build, then `make veryclean && make -j4`. One oddity: the first wasm build after the clean carried a build id ending in `+` ("with local changes", brief 05b), and in the first `wt-host` run the native guest and the browsers therefore named each other's builds as different (the game went on correctly). `scripts/build-id.sh` then printed no `+`, and an incremental rebuild of both gave them the same id; what was dirty during that first build was not found (the worktree's submodules had just been checked out). Worth knowing for the next clean build; not changed here.

### L31 is fixed

**`netplay.js wt-host`** (new, in the full run): a browser hosts two guests over WebTransport (a `-dev-cert` relay on loopback, the certificate hash as the test knob): three browsers, then two browsers and a native guest, 1,200 tics each. It requires every machine to agree on every tic, `relay-wt` on every browser, the host at least 36 tics a second (its `-testlag` record, tic 100 to the end), no WebTransport datagram dropped by any page (`Module.vnetWT`'s drop counter, sampled every 0.5 s during the game) and nothing dropped by the relay (`/stats`).

| Build (page, native, relay) | three browsers: host's tics a second; pages' drops | two browsers and a native guest |
|---|---|---|
| **0.5.0** (this branch) | **40.0**; 0, 0, 0 | **39.9** (40.0 in a second run); 0, 0 |
| 0.4.0 (claude `8a16f0b`: page, `sw`, relay `eb1feeb`), the mutation | 32.4; host 445, guests 80 and 41 | 34.3; host 481, guest 150 |
| 0.4.0 page and `sw`, 0.5.0 relay | 35.2; host 514 | 37.0; host 295, guest 246 |
| 0.5.0 page and `sw`, 0.4.0 relay | 40.0; 0 | 40.0; 0 |

So the page's fix is what this game needs; the relay's fix (bursts above 32 in one task) is for bigger bursts than it makes. The mutation (everything 0.4.0) fails 4 checks: both rates and both drop checks. The relay's counters were 0 in every run (`wt_rx_queue_drops` does not exist on the 0.4.0 relay).

**In the deployment** (`check-deploy.sh`: Apache with TLS, the relay on UDP 443 with a real, self-signed certificate, a browser host, a browser guest and a desktop guest, 1,200 tics): 0.5.0 **40.2 tics a second, no datagram dropped** (now a check); the 0.4.0 tree's own `check-deploy.sh --wt` on the same machine minutes later: 19.8 tics a second, 1,504 and 215 datagrams dropped by the two pages (its warning; it was not a check there).

**Firefox** (`tests/web/firefox.js` part 4, new; `FIREFOX_ONLY=4` runs it alone; Firefox 160 from `scripts/setup-firefox.sh`): Firefox hosts by `?host=3` over WebTransport (`serverCertificateHashes` with the dev certificate works in headless Firefox), two Chromium pages join over WebTransport; 1,200 tics, all agree, Firefox reports `relay-wt`, **40.0 tics a second, nothing dropped** by any page. With the 0.4.0 page: 37.5 tics a second, Firefox's own page dropped none, each Chromium guest about 190 (one failed check). So Firefox's datagram writes do not hit 0.4.0's cap the way Chromium's do; vnet's brief 15 had no Firefox to try.

### The guide

- WebTransport is the default again: the unit has the `-wt` line and `CAP_NET_BIND_SERVICE` (ambient and bounding, nothing else); the certificate hook (game lineage only) and the sysctl come before it as part of the set-up. **"Without WebTransport"** is a drop-in, `vnet-relay.service.d/websocket-only.conf` (`ExecStart=` cleared and set without `-wt`, `AmbientCapabilities=` and `CapabilityBoundingSet=` emptied).
- The L31 caveat is gone; instead: the relay must be built from vnet 0.5.0 or later, and a troubleshooting row says what a 0.4.0 relay or page does. The ports table (UDP 443 needed unless without WebTransport), the layout diagram, "Check it" step 4 (`relay-wt`, `"webtransports":2`, the drop counters at 0), "Without TLS" (uses the drop-in) and the troubleshooting table (`relay-ws` causes; growing `wt_rx_queue_drops` or `wt_datagram_drops`) match. `-stats` now lists `ws_queue_drops`, `wt_datagram_drops` and `wt_rx_queue_drops`. A memory note: 250 to 300 KB per WebTransport connection in normal play, up to about 3.5 MB at worst (vnet 0.5.0's deeper queues), and `-max-wt` to cap it on a small machine.
- `check-deploy.sh`: WebTransport by default (the hook, the sysctl, UDP 443, the capability); `--ws` takes the drop-in (no capabilities; the browsers must say `relay-ws`); `--no-tls` uses the drop-in too; `--wt` is gone. `play.js`: the host's tic rate (at least 36) and the pages' WebTransport drops (0) are checks now, and the relay's four drop counters must be 0.

### Tests

The check script on the final tree (one at a time; the machine otherwise idle):

| Run | Result | Load |
|---|---|---|
| `check-deploy.sh` (WebTransport) | PASS, 89 checks; 40.2 tics a second, nothing dropped | 0.9 to 4.4 |
| `check-deploy.sh --ws` | PASS, 81 checks; `relay-ws`, 40.0 tics a second, no capabilities | 4.5 to 5.9 |
| `check-deploy.sh --no-tls` | PASS, 79 checks; 40.0 tics a second | 5.9 to 6.4 |
| `check-deploy.sh --quick` | PASS, 53 checks | 5.6 |

Regression (acceptance 2), one at a time, on the final tree:

| Test | Result | Load |
|---|---|---|
| `netplay.js` full (now with `wt-host`) | **1759 passed, 0 failed** (`wt-host`: 39.9 and 40.0 tics a second, nothing dropped) | 1.4 to 8.5 |
| `make test GAME_RUNS=1` | **10 PASS** (with F4's and 05b's scripts), draw 16 passed, 0 failed | 1.4 to 6.3 |
| `smoke.js` | 28 passed, 1 failed ("Up moves it up": the menu's arrow-key check, bugs.md L14's known flake); rerun: **29 passed, 0 failed** | 1.3 to 2.7 |
| `persist.js` | 15 passed, 0 failed | 2.7 to 3.2 |
| `focus.js` | 37 passed, 0 failed | 3.2 to 1.6 |
| `data.js` | 172 passed, 0 failed | 1.6 to 2.4 |
| `grptable.js` | 8 passed, 0 failed | |
| `determinism.js` | 20 passed, 1 failed, twice: only the known "no stall over 100 ms" check (max 357 ms, then 574 ms); native and wasm identical both times | 2.4 to 3.1 |
| `firefox.js` (all four parts) | **24 passed, 0 failed** | 3.1 to 6.3 |

### Concerns

- **An uncaught "The session is closed."** (corrected in the fix round below: not rare, and now traced.)
- The first wasm build after the clean was marked as having local changes (fixed in the fix round below: `scripts/build-id.sh`).
- Not checked: a real network, and Firefox on the deployment (`check-deploy.sh` drives Chromium only). Firefox was checked as a WebTransport host on loopback.

### Play-test on Arch Linux (the user)

1. On the PC: `git fetch && git checkout claude` (once 06b is merged; or `browser/06b-vnet-0.5.0`), `git submodule update --init`, and check `git submodule status`: `ext/vnet` at `8572c74` (v0.5.0). Build from clean (the submodule moved, bugs.md L9): `scripts/build-wasm.sh veryclean && scripts/build-wasm.sh`, then `make veryclean && make -j4` (the wasm `veryclean` also deletes `./sw`).
2. **Redeploy the relay** (it now vendors quic-go): `deploy.md` §4, "Build it" (`cd ext/vnet/relay && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o vnet-relay-arm64 ./cmd/vnet-relay` for an aarch64 server), copy it, `sudo install -m 755 /tmp/vnet-relay /usr/local/bin/vnet-relay`, and `sudo systemctl restart vnet-relay` (this ends any room in progress).
3. **Turn WebTransport on** if you followed brief 06's guide (WebSocket only): the certificate hook (§4, "WebTransport's certificate"; run it once), the sysctl, and the unit's `ExecStart` with the `-wt` line and the two `Capabilit...` lines (or remove the WebTransport drop-in you may have from 06 and use the new unit); open **UDP 443**; `sudo systemctl daemon-reload && sudo systemctl restart vnet-relay`. `journalctl -u vnet-relay` shows `LISTEN ... wt=[::]:443`.
4. **Redeploy the page**: the `rsync` line of §1 (your own `config.js`).
5. Host a three-player game from a browser: `https://game.example.org/games/sw/?host=3`, a second browser from the invite link (on another network if you can), and a desktop player with `./sw -net -relay game.example.org:7777 -room CODE --` (built at the same commit). In the browsers' consoles (F12): `relay-wt`.
6. Play a few minutes: it should feel like the WebSocket game did (no slow motion, no lag that grows). On the server, during the game, `curl -s 127.0.0.1:8081/stats`: `"webtransports":2`, and `wt_rx_queue_drops`, `wt_datagram_drops` and `rate_limited` at 0.
7. If you play in Firefox: host the same game from Firefox (it was checked as a WebTransport host on loopback, not on a real network).
8. Optional: `sudo tests/deploy/check-deploy.sh` on a spare machine or VM (not the real server: it refuses to run next to a real relay set-up).

### Fix round (review findings, 14 Nov 2026)

Commits: `f50ff23` (B1, S1), `5bf9599` (nits), `96472ce` (code-facts, bugs.md L34, this Outcome's corrections), and the commit of this section.

- **B1: "The session is closed." was not rare** (the review: 3 of 4 `wt-host` games, 5 of 8 probe runs; this Outcome's "once in about 15" was wrong). The cause, as the reviewer traced it: at the game's exit `vnet_wt_close` calls `s.wt.close()` while the datagram writer still has unsettled writes (usual with 0.5.0's queue depth of 64), and Chromium rejects a promise of its own with a `WebTransportError`. Harmless (after `exit()`), but an unhandled rejection. **Fixed on the page:** `web/jfsw.js`'s `unhandledrejection` handler, after `gameError()` (so a real game error is still fatal), calls `preventDefault()` for a `WebTransportError`, or any `DOMException` once the game has ended, and logs it with `console.info`. The vnet fix (defer `wt.close()` until `s.dgT` is empty, capped at about 250 ms) is recorded for vnet as `bugs.md` **L34**. Checked: `wt-host` 8 times in a row (16 games), with `wt`, `impaired-wt` and `knobs`: **608 passed, 0 failed**, no page error, the browser host at 39.9 to 40.1 tics a second in all 16 games.
- **S1: the build id ended in `+` on every full wasm build** (Emscripten's `*.wasm-<hash>.o.tmp` files are untracked files in `src/` and the submodules while `version-auto.c` is generated). `scripts/build-id.sh` now uses `git status --porcelain --untracked-files=no --ignore-submodules=untracked`. Checked: after `scripts/build-wasm.sh veryclean` and a full wasm build, then `make veryclean && make -j4`, both binaries carry `976d8bcd3a8a10a0` with no `+`; with a tracked edit (a line appended to `src/version.c`) `build-id.sh` prints `976d8bcd3a8a10a0+`, and without it again `976d8bcd3a8a10a0`.
- **Nits:** `netplay.js`'s `PORT_STATS` is `PORT_BASE + 1401` and `firefox.js`'s `PORT_WT` is `PORT_WEB + 1302` (49701 and 49702 with the default ports, and they move with `NETPLAY_PORT_BASE` and the port offset); `firefox.js` part 4 also requires no page error on the two Chromium guests; `README.md` and `PROMPT.md` say `v0.5.0` in their first lines; `deploy.md` says it is the page's vnet code that needs 0.5.0 (the relay's fix is for bigger bursts), so both are rebuilt. `play.js`'s 36 tics check is kept under `--ws` and `--no-tls` too: they ran at 39.9 to 40.0 here (load up to 7.4), and a busy VM that cannot keep 36 a second is worth a failure.

**Results after the fix round** (one at a time):

| Test | Result | Load |
|---|---|---|
| `netplay.js` full | **1759 passed, 0 failed** | 2.3 to 8.5 |
| `check-deploy.sh` (WebTransport) | PASS, 89 checks; 40.0 tics a second | 4.5 to 6.2 |
| `check-deploy.sh --ws` | PASS, 81 checks; 39.9 tics a second | 6.2 to 7.4 |
| `focus.js` | 37 passed, 0 failed | 3.5 to 7.4 |
| `smoke.js` | 29 passed, 0 failed | 3.5 |
| `firefox.js` part 4 | 9 passed, 0 failed (with the guests' page errors) | 3.6 to 6.7 |
