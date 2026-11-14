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

(To be written by the implementer.)
