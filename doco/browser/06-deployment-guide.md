# 06: Deployment guide

## Goal

A person with a Linux server (Arch Linux, x86_64 or aarch64) and a domain name can put the browser game and the vnet relay online by following one document, `doco/browser/deploy.md`. Browser players then host and join games by room code over `wss://` (WebTransport where it works), and desktop players join the same rooms over UDP. The guide is checked end to end in the container. It uses placeholder host names and paths only.

## Dependencies

Brief 05 (host and join), merged. Briefs 03 (data download, `data-hosting.md`) and 04 (browser netplay, the relay in the browser).

## Read first

- [`README.md`](README.md): the status table, D1 to D12, the Q answers (Q2: shareware data from a verified mirror).
- [`building.md`](building.md): the native and wasm builds, §6.6 (host and join, **test mode**, the relay in `config.js`).
- [`data-hosting.md`](data-hosting.md): the data file's Apache example (checked on Apache 2.4.58), compression, CORS and cache headers, `config.js`'s `data`, `relay` and `testMode`.
- The Outcomes of [03](03-data-download.md), [04](04-browser-netplay.md), [04b](04b-lag-cuts.md) (datagram rates) and [05](05-host-and-join.md) (the fix round's S2: test mode is a `config.js` setting).
- `code-facts.md` §16 (datagrams per peer) and §19 (the relay lobby, session ids).
- `web/config.js`, `web/jfsw.js` (the page parameters at the top), `scripts/build-wasm.sh` (what lands in `build-wasm/`).
- vnet's relay: `ext/vnet/relay/README.md` (every flag, the limits, WebTransport, the proxy snippets) and `ext/vnet/doco/integration.md`.
- **Bit Riot's guide**, the model for this one: `doco/netplay/deploy.md` on Bit Riot's `claude` branch (`git fetch https://github.com/VenKamikaze/BitRiot claude`, or the local `BitRiot-claude` checkout). Reuse its structure and what it learnt (the layout diagram, the ports table, Apache's `upgrade=websocket`, `-trust-forwarded-for`, the certificate copy for the relay user, the systemd unit, the checks, the troubleshooting table). Don't copy its Bit Riot specifics: this game's page reads its relay from `config.js`, has no `?relay=` and no default relay.

## What is known (check it; don't take it as given)

1. **Files to deploy.** `scripts/build-wasm.sh` writes the page, its scripts, the wasm and `config.js` into `build-wasm/`. Some of what is there may be test-only. The guide must list exactly the files a site needs and nothing else.
2. **`config.js` is the one file an operator edits.** It holds `data` (the GRP's URL, size and crc32), `relay` (the WebSocket URL, empty means no network games) and `testMode`. **The deployed `config.js` must keep `testMode: false`**: with `true`, a crafted link with `?test=1` could hand a visitor's game test arguments, including another relay (brief 05 review, S2). `build-wasm.sh` copies `web/config.js` over the build's copy at every build (data-hosting.md), so the guide must say how to keep the operator's own copy.
3. **The relay comes only from `config.js`.** There is no default relay (unlike Bit Riot's page) and no link parameter. A page on `https://game.example.org/...` with the relay behind the same Apache uses `relay: 'wss://game.example.org/vnet'`. WebTransport is tried first and derived from a `wss://` URL (`https://game.example.org/vnet` on UDP 443); a `ws://` URL uses WebSocket only.
4. **The relay's limits against this game's traffic.**
   - 04b measured 45 to 72 datagrams a second per peer.
   - In master/slave mode the master sends to every slave, so in an 8-player game (registered data) it sends about 7 × 72 ≈ 500 a second.
   - The relay's default `-client-pps` is 600 sustained, with bursts of twice that.
   - Check the master's real rate in the largest game the data allows (4 players shareware; 8 registered if you can test it, or a native 8-player game over the relay with a test GRP setting if there is one; otherwise compute it from measured per-peer rates and say so). Say in the guide whether the defaults are enough, and if not, which flag to raise and by how much.
   - Also check `-client-bps` the same way.
5. **Time-outs.** Two time-outs apply:
   - the relay drops a silent member after its session timeout (15 s by default);
   - mmulti ends a game 15 s after a player's last packet.

   Check that the defaults work together (brief 05's rejoin case depends on the relay freeing a vanished member's address) and say whether an operator should leave them alone.
6. **Builds must match.** A browser player and a desktop player can only play together on the same game build. Find out what happens today when they differ, for example a browser with an old cached `.wasm`, or a desktop player on an older checkout. Is it a refusal with a message, a desync caught by sync.c, or something worse? Document it in the guide. The cache headers must make a redeploy reach every browser on its next load, as Bit Riot's `no-cache` does. Don't change the game here; if it fails badly, record it in `bugs.md` and tell the coordinator.
7. **Native players.**
   - Desktop players build from source: `scripts/setup.sh` and `make`, on Arch with `pacman`.
   - They join with `sw -net -relay game.example.org:7777 -room CODE --`, or use the console's `relay` and `join`, the menus, or the GTK startup window's online fields.
   - There is no Windows or macOS build in this project. Say so.
8. **The data file.**
   - The site hosts `swshare.grp` itself; data-hosting.md covers its headers, and the IndexedDB cache re-checks the file.
   - Say where an operator gets the shareware GRP: the archive and MD5 used by `scripts/fetch-test-data.sh`.
   - Quote what the shareware archive's own licence text says about redistribution, naming the file in the archive. Make no legal claims beyond that.
   - The registered `sw.grp` must not be put on a public site. Players with it use the page's file picker.
9. **No COOP/COEP headers** should be needed if the build uses no threads. Check the build flags.

## In scope

### 1. `doco/browser/deploy.md`

Bit Riot's layout, for this game:
- **Placeholders table:**
  - `game.example.org`;
  - `/srv/http/games/sw`, served at `https://game.example.org/games/sw/`;
  - `relay.example.org`, only if the relay is on another machine;
  - `you@game.example.org` for copying.

  **Never the user's real host names or paths.**
- **The layout diagram and the ports table:**
  - TCP 443 and 80;
  - UDP 7777 for desktop players;
  - UDP 443 for WebTransport (optional);
  - not 8080 or 8081.
- **Build the web game** on the PC: the exact commands from a fresh clone (`--recurse-submodules`, the `claude` branch, `scripts/setup-emsdk.sh`, `scripts/build-wasm.sh`); the list of files to copy; `rsync` to the server.
- **`config.js` for the site:**
  - `data`, `relay` and `testMode: false`;
  - how to keep the edited copy across rebuilds;
  - the relay on another machine.
- **Apache** (Arch's `apache`, 2.4.47+):
  - the modules;
  - a vhost on 80 (redirect, ACME challenge) and one on 443;
  - the game's `<Directory>` with the MIME types, compression and cache headers. Bring data-hosting.md's GRP settings into the same config, or link to it, without contradicting it;
  - `ProxyPass /vnet ... upgrade=websocket`;
  - certbot on Arch, with the renewal timer and a reload hook.
- **The relay:**
  - build it with Go from `ext/vnet/relay` (native or cross-compiled for arm64);
  - its own system user;
  - the WebTransport certificate copy with a certbot deploy hook, and the UDP buffer sysctl;
  - the systemd unit, hardened as Bit Riot's is;
  - each flag explained: `-udp :7777`, `-http 127.0.0.1:8080 -trust-forwarded-for`, `-origins game.example.org` (exact, including any port), `-stats` and `-wt`;
  - any limit this game needs raised (known 4).
- **Desktop players** (known 7).
- **Check it:**
  - the `curl` checks: the wasm's type and encoding, the GRP's headers, the WebSocket upgrade through `/vnet` with 101, 403 and 502 explained, and `healthz`;
  - a check that the deployed page ignores `?test=1`;
  - then play: host in one browser with `?host=2` or the menus, join from the invite link in another, a desktop player joining by code, WebTransport visible in the relay's log.
- **Without TLS** (a LAN): WebSocket only, with the `ws://` relay URL in `config.js`.
- **Updating:** the game (copy again, keep `config.js`, matching builds, known 6) and the relay (a restart ends every room).
- **Troubleshooting table**, for this game's own messages (the lobby's and the end-of-game overlay's).

Link it from the README and from `building.md` and `data-hosting.md` where they mention deployment.

### 2. Validate it end to end in the container

- **Apache:** follow the guide as written, as far as a container allows. Use Apache 2.4.x (the distribution's package; the container is not Arch, so say which one), with a self-signed certificate for `game.example.org`, mapped to 127.0.0.1 in `/etc/hosts` or by the browser's host-resolver rule, the game in `/srv/http/games/sw`, and data-hosting.md's GRP settings.
- **The relay:** built from `ext/vnet/relay`, with the unit's flags. Run it under systemd if the container has it, otherwise the same command line by hand, and say so.
- **Play:**
  - two Chromium pages from `https://game.example.org/games/sw/`, through `wss://game.example.org/vnet` (Apache's proxy), and one native `sw` over UDP 7777, play a co-op game through the relay;
  - every machine's `-testdump` agrees on every tic. Use the native player's test arguments, and a test-mode copy of the site only for the dumps if you need browser dumps. Say how;
  - the deployed page itself must show that `?test=1` does nothing.
- **WebTransport:** try it with Chromium flags that trust the self-signed certificate for QUIC (for example `--ignore-certificate-errors-spki-list` with the certificate's SPKI hash, and `--origin-to-force-quic-on`). If it cannot be checked, say why, as Bit Riot did.
- **The `curl` checks** in the guide must give the answers it says they give.
- **A script:** put the validation in `tests/deploy/check-deploy.sh` (or similar), so that it can be run again. It needs root and Apache, so it is not part of `make test`. Document how to run it in `building.md`.
- If a host the validation needs is blocked, report it; don't work around it.

### 3. Small fixes the guide needs

Only if the validation shows them:
- `build-wasm.sh` keeping a site's `config.js`, or a `--deploy` output without test files;
- a wrong header in data-hosting.md.

Keep them small and say why. Don't change the game's simulation or the netcode.

## Out of scope

- Music (Q4), WebGL, touch controls, the add-ons.
- A Windows or macOS build.
- Docker or other hosting than Apache, except a link to the relay README's Caddy and nginx snippets.
- F1 (on hold), and changes to vnet or the relay.
- Fixing a build-mismatch problem found under known 6. Record it; the coordinator decides.

## Acceptance criteria

1. `doco/browser/deploy.md` exists, follows the outline above, uses placeholders only, and every command and config block in it was run or loaded in the container, or is marked as not checkable there with the reason. This covers certbot against a real CA, systemd if it is absent, and Arch-specific paths.
2. The end-to-end validation passes: two browsers and a native player play through Apache with TLS and the relay, and every machine agrees on every tic. The script reproduces it.
3. The deployed `config.js` has `testMode: false`, and the deployed page ignores `?test=1` (checked).
4. The relay limits against this game's traffic (known 4) and the build-mismatch behaviour (known 6) are measured or found out, and the guide says what to do about them.
5. No regression: `netplay.js` (all scenarios), `make test GAME_RUNS=1`, `smoke.js`, `persist.js`, `data.js`, `grptable.js` and `determinism.js` pass, with the known 100 ms stall check excepted. This applies even if the brief changes nothing but documents and scripts.

## Tests

1. `tests/deploy/check-deploy.sh`: the end-to-end validation (acceptance 2 and 3).
   - **Mutation:** break the deployment in two ways and show the script fails with a clear message each time. Use a wrong `-origins` (the WebSocket upgrade gets 403), and `testMode: true` in the deployed `config.js`.
2. The `curl` checks in the guide, run against the container's Apache.
3. Regression, as in acceptance 5.

## Notes

- **Repos touched:** jfsw-browser only.
- **Ports:** pick test ports that don't clash with the other suites, and list them in `building.md`.
- **Container gaps:** the container is not Arch, may lack systemd, and cannot get a Let's Encrypt certificate. Say in the guide what was checked where, as Bit Riot's last paragraph does.
- **The user's play-test**, in the Outcome. Deploy on their own server by following the guide, then check:
  - a browser host;
  - a browser guest from the invite link, on another network if possible, for example a phone's hotspot;
  - a desktop player on Arch joining by code;
  - the relay log showing WebTransport sessions;
  - a redeploy reaching a browser that was already open, after it reloads.
- Update the README status row, and PROMPT §0 once it merges.

## Outcome

**Status: review.** Implemented 13 Nov 2026 on `browser/06-deployment-guide` (jfsw-browser only; no submodule moved, no game or netcode change). Commits: `cef0ee9` (the draft guide), `613c891` (the check script and `play.js`, bugs.md L24 and L25), `73e1bd8` (`--no-tls`, data-hosting.md's wasm header, building.md §6.7, links), `6e00ee1` (the sysctl step, the "checked where" section), `d4bca92` and `fb34db3` (the Outcome, L25 under load, a load-aware warning in `play.js`), and this Outcome's last commit. A container restart in the middle lost nothing that was committed or built; every test below was run after it.

### What was done

- **[`deploy.md`](deploy.md)**, Bit Riot's layout for this game: placeholders, the layout diagram and the ports table; building the web game from a fresh clone and the exact file list (eight files plus the GRP; `rsync --delay-updates`); the game data (where it comes from, the licence quoted, the registered GRP kept off the site); `config.js` (`relay`, `testMode: false`, `data`) kept as the operator's own copy outside the build; Apache on Arch (modules, a port-80 vhost for the redirect and ACME, a 443 vhost with the game's `<Directory>`, MIME types, gzip, `no-cache` on everything but the GRP, `DeflateAlterETag NoChange`, `ProxyPass /vnet ... upgrade=websocket`, `SSLSessionCache`), certbot with the timer and a reload hook; the relay (build, cross-compile, own user, the WebTransport certificate copy by a certbot deploy hook, the sysctl, the hardened unit, every flag explained, limits and time-outs with measurements); desktop players (build on Arch, every way to join, no Windows or macOS build); builds that must match and what happens when they do not; the `curl` checks with their answers, the `?test=1` check and the play steps; without TLS (its own vhost block); updating; a troubleshooting table of this game's own messages; and what was checked where.
- **`tests/deploy/check-deploy.sh`** (root; not in `make test`) and **`tests/deploy/play.js`**: follow the guide with its own configuration blocks (each after a `<!-- check-deploy: NAME -->` comment, so a change to the guide is what gets tested; `--guide FILE` takes another copy, which is how the mutations were made), check what it says, and play through it. `--quick` (no browsers), `--no-tls`, `--keep`. It removes everything it added and stops Apache and the relay. How to run it, what it touches and its ports (the guide's own: TCP 80 and 443, UDP 443 and 7777, 127.0.0.1:8080 and 8081) are in `building.md` §6.7.
- **Small fixes the validation showed** (no change to the game, the page or the build script):
  - `data-hosting.md`'s Apache example cached `sw.wasm` for a day (`max-age=86400`, with the GRP). After a redeploy a browser could then pair an old `sw.wasm` with a new `sw.js`, which does not start (measured, below). Now `no-cache`, rechecked on Apache 2.4.58.
  - `data-hosting.md` said `build-wasm.sh` copies `web/config.js` "each time it runs". It copies it when `web/config.js` is newer than the copy (a make rule), so an edit made in `build-wasm/` survives until the next change to `web/config.js`, then is silently lost. The guide keeps the site's `config.js` outside the build instead; `build-wasm.sh` needed no change, and no `--deploy` output either (nothing in `build-wasm/` is test-only).
- `bugs.md` **L24** (no build check between machines) and **L25** (WebTransport and a browser host with two guests run slow), both open, for the coordinator.
- README: the status row (review) and a link to the guide; `building.md` §6.6 and `data-hosting.md` link to it.

### The known facts, checked

1. **Files to deploy:** `build-wasm/` holds exactly `index.html`, `jfsw.css`, `config.js`, `grptable.js`, `data.js`, `jfsw.js`, `sw.js`, `sw.wasm`, and the site needs all of them and `swshare.grp`. None is test-only: the hooks are in `jfsw.js`, and need `testMode: true`. The check compares the guide's table, `build-wasm/` and the deployed directory.
2. **`config.js`:** true, with the correction above about when it is copied. The deployed one has `testMode: false` (checked with `curl`); `--guide` with `testMode: true` is mutation 2.
3. **The relay only from `config.js`:** true. With `relay: 'wss://game.example.org/vnet'` and the relay on `-wt :443`, both browsers reported `relay-wt`, so the game derived `https://game.example.org/vnet` on UDP 443 and used it; with `ws://` (`--no-tls`) both reported `relay-ws`.
4. **The relay's limits** (measured; see the tables below and in the guide): the defaults are enough. A host sends 68 datagrams a second per other player in a 2-player game and 63 in a 4-player game; the master of a 4-player game (the largest shareware game) sends 188 a second and 15,800 bytes a second, against `-client-pps 600` and `-client-bps 600000`. No 8-player game could be run (no registered data; there is no test setting for more players with the shareware GRP, and a modified GRP was ruled out: the archive's licence forbids modifying the game). Computed for 8: about 440 a second (7 × 63), and at most about 560 (7 × 80, the pacing bound); bytes about 50,000 to 70,000 a second. `rate_limited` stayed 0 in every game. The guide says: defaults enough; for 8-player registered games raise `-client-pps` to 1000 for headroom; nothing else.
5. **Time-outs:** the relay's 15 s session time-out and the game's 15 s `NET_GONE_MS` are meant to be equal (brief 05 chose the game's from the relay's default), and brief 05's rejoin cases, which depend on the relay freeing a vanished member's address, pass with the defaults (`rejoin-vanish`, `rejoin-quit` in the full `netplay.js` run below, on a relay with default time-outs). The guide says to leave `-session-timeout` and `-keepalive` alone and why.
6. **Builds must match** (found out; the game not changed; `bugs.md` L24). Every build announces game version 13, `CheckVersion()` only logs, and the relay lobby has no build check:
   - A **simulation difference** (made deliberately: `-testnudge200` on the guest of a 2-player native relay game, no `-testsync`): the game goes on; from tic 200 the master logs `GAME OUT OF SYNC: tic 200, sync byte 0 (RandomSync), player 1 differs from the master` and shows "GAME OUT OF SYNC! Restart the game."; 198 of 398 sync checks failed; the guest says nothing (slaves never compare, L11). So: a desync caught by sync.c on the host only, not a refusal.
   - A **desktop player on an older checkout**: the build from before brief 05 (`f21a67a`, no session ids in the lobby) against the current one, 400 tics, host old and guest new and the other way round: both played and their dumps were identical.
   - **A browser with an old cached `.wasm`**: the current page and `sw.js` with the pre-05 `sw.wasm`: "The game could not start: ASM_CONSTS[emAsmAddr] is not a function"; the pre-05 `sw.js` with the current `sw.wasm`: "The game crashed: LinkError: WebAssembly.instantiate(): Import #1 "env" "jfsw_page_lobby": function import requires a callable". With every file `no-cache` (the guide's Apache, checked: `304` on revalidation thanks to `DeflateAlterETag NoChange`), a reload always gets one build.
   - The guide says how to see a build's commit (the `Version ...-g<commit>` line) and to have desktop players check out the site's commit.
7. **Desktop players:** the check's desktop game joins with exactly `sw -net -relay game.example.org:7777 -room CODE --` (through `/etc/hosts`). The console, menu and startup-window ways are brief 05's and are covered by its tests, not rerun against this deployment. No Windows or macOS build: said.
8. **The data file:** served by the site; `data-hosting.md`'s headers checked again (gzip, ETag, `max-age=86400`, the CRC check of the download). Source and MD5 as in `fetch-test-data.sh`. `LICENSE.TXT` of `3dsw12.zip` (also in `SWSW12.SHR`), section [3] "GRANT", [A] and [D], quoted word for word; no other claim. The registered GRP: the picker only.
9. **No COOP/COEP:** the wasm link has no `-pthread` and no shared memory (`Makefile.emscripten`); no such header is sent, and the game runs (checked).

**Measurements for known 4** (30 s co-op games on E1L1 through a local relay, every player native unless said; `-testlag` counts; load average 0.4 to 2.4):

| Game | Host sends: datagrams a second (to each) | payload bytes a datagram | Host's bytes a second, relay frames |
|---|---|---|---|
| 2 natives | 68.3 | 51.9 | 5,250 |
| 3 natives | 129.8 (65.1, 64.7) | 59.0 | 10,900 |
| 4 natives | 187.5 (62.8, 62.4, 62.3) | 59.2 | 15,800 |
| 4 natives, all firing (`-testfire100`) | 191.8 | 59.1 | 16,100 |
| browser host, browser and native guests, WebSocket (in `check-deploy.sh`) | 96.4 to 98.6 (48 to 49 each) | 93 to 99 | about 10,000 |
| the same over WebTransport (L25) | 68 (34 each) | 212 to 219 | about 15,000 |

A guest sends 66 to 69 datagrams a second, all to the host.

**L25, found by the validation.** In the deployment, a game hosted by a browser with a browser and a desktop guest ran at 24.8 to 26.8 tics a second over WebTransport (three games measured from the host's `-testlag`; a fourth took 56 s for 1,200 tics), against 40.0 over WebSocket in the same set-up, 40.0 for two browsers over WebTransport, 40.0 for a browser host with one desktop guest over WebTransport, and 26.7 for three browsers over WebTransport. The host's page dropped 951 datagrams and the guest's 223 in one game because more than 16 writes to the WebTransport datagram stream were pending (vnet `relay_wt.c`, `JS_MAX_DATAGRAMS_IN_FLIGHT`). Pinning the certificate by hash (`?relay_cert=` on the test copy) instead of `--webtransport-developer-mode` gave 25.6, so the test's Chromium flags are not the cause. Brief 04's `netplay.js wt` (native host, two browser guests) runs at full speed, which is why it was not seen before. The game is still correct (every tic agrees); it is slower. vnet is not changed here; the guide says WebTransport can be left off for browser-hosted games of three or more until it is fixed. `check-deploy.sh` prints a WARNING line with the tic rate but does not fail on it.

### What was checked where

In the cloud container (Ubuntu 24.04 x86_64, Apache 2.4.58, Go 1.24.7, Chromium under Playwright, no systemd): everything in "What was checked where" at the end of `deploy.md`: the whole guide through `check-deploy.sh`, with and without TLS, Chromium with WebTransport on UDP 443 (with `--ignore-certificate-errors-spki-list` and `--webtransport-developer-mode`; `--origin-to-force-quic-on`, the brief's suggestion, sent the page's own requests over HTTP/3 to the relay and broke the page; trusting the certificate in Chromium's NSS store was not enough for QUIC either), `systemd-analyze verify` on the unit, the relay cross-compiled for aarch64, the `rsync` line into a local directory, `sysctl -w` with the guide's values.

Not checkable there, and why: certbot and Let's Encrypt (no public name, no inbound internet), the certbot timer and the Apache reload hook (no systemd, no certbot), `systemctl`/`journalctl`, the `sysctl.d` file with `sysctl --system` (system-wide; `sysctl -w` was used and undone), Arch itself (`pacman`, Arch's own `httpd.conf`, `/usr/bin/nologin`, the `http` user, package versions; the check uses an Arch-style configuration on Ubuntu's Apache), an aarch64 machine, `ssh` to a server, Firefox, and a real network between players (loss, NAT, a phone on another network).

### Tests

The check script (one at a time; load average while running):

| Run | Result |
|---|---|
| `check-deploy.sh`, during the work (load 0.4 to 4) | the first run FAILED only its four WebTransport checks (Chromium did not yet trust the certificate for QUIC; the browsers fell back to the WebSocket and the per-tic game ran at 40 tics a second); after `--webtransport-developer-mode`, PASS three times (61 checks each), the per-tic game over WebTransport at 24.8 to 26.8 tics a second (L25; a WARNING line, not a check) |
| `check-deploy.sh`, the final tree, three runs while other sessions' tests loaded the container (load 3 to 15) | PASS once (64 checks; the per-tic game at 8.9 tics a second, 1,253 datagrams dropped by the host's page); FAILED twice, each with one failed group: in the per-tic game over WebTransport the browser guest gave up, "Network game failed: the host left the game (its machine stopped answering 15 s ago)", at 8.6 and 11.1 tics a second with 1,518 and 1,598 datagrams dropped (L25 under load); every other check passed (60) |
| `check-deploy.sh --no-tls` | PASS twice (57 checks, then 59 on the final tree with the sysctl step): 40.0 tics a second at load 0.8; 27.2 at load 3 to 9, nothing dropped |
| `check-deploy.sh --quick` | PASS |

So the script reproduces the validation on a machine that is not busy; on a loaded one, L25 can end its WebTransport game (2 of 6 such games, both at load 7 or more). It is not loosened: the game it reports is a real failure of the WebTransport path.

Regression (acceptance 5), one at a time, after the restart, on the final code:

| Test | Result | Time, load |
|---|---|---|
| `netplay.js` (all but `lag-matrix` and `old-new`) | **1286 passed, 0 failed** (`rejoin-vanish`, `rejoin-quit` with the relay's default time-outs included) | 31.5 minutes, load 3.7 to 8 |
| `make test GAME_RUNS=1` | **8 PASS** (mmulti 10 runs, three games over the relay and over UDP, UDP against the baseline, errors, level exit, startup window, rejoin); draw 16 passed, 0 failed | 9.3 minutes, load 3.5 to 4.4 |
| `smoke.js` | 29 passed, 0 failed | load 1.9 to 2.4 |
| `persist.js` | 15 passed, 0 failed | load 2.4 to 3.1 |
| `data.js` | 172 passed, 0 failed | load 3.1 to 3.6 |
| `grptable.js` | 8 passed, 0 failed | |
| `determinism.js` | 20 passed, 1 failed: only the known "no stall over 100 ms" check (max 240 ms, p99 104.7 ms) | load 3.6 to 4 |

Nothing in the game, the page or the build changed in this brief, so these are the same code as brief 05's merge; they were run because acceptance 5 asks for them.

### Mutations

Each is a copy of the guide with one line changed, deployed with `check-deploy.sh --guide FILE` (the full run), so the deployment really is broken that way. Both were run during the work and again on the final guide (load 7), with the same results; in the final `testMode` run the per-tic WebTransport game also failed, as in the loaded runs above (L25), which has nothing to do with the mutation:

| Mutation | Result |
|---|---|
| the unit's `-origins game.example.org` changed to `-origins other.example.org` | FAILED, 3 checks: "the WebSocket upgrade through /vnet from the site's Origin: 101: missing [^HTTP/1.1 101 Switching Protocols]; got: HTTP/1.1 403 Forbidden", the 403 check for another Origin (it got 101), and `play.js`: "A: the lobby shows a room code (... Network game failed: the relay could not be reached (relay unreachable).)" |
| `testMode: true` in the guide's `config.js` block | FAILED, 2 checks: "config.js: testMode false ...: missing [^ *testMode: false,$]; got: testMode: true, ...", and `play.js`: "the deployed page gives ?test=1 no test hooks (window.jfswTest is object)", "and shows no "test mode: args=" line", and "and the game does not see ?args= ... (mmulti: creating a room on relay wss://relay.example.org/vnet ...)": the crafted link sent the game to another relay, the danger S2 describes |

### Play-test on Arch Linux (the user)

On your own server (Arch, Apache, a real domain), following `deploy.md` from the top; replace the placeholders with your names.

1. On the PC: section 1 (clone the branch, `scripts/setup-emsdk.sh`, `scripts/build-wasm.sh`, `scripts/fetch-test-data.sh`), section 2 (`~/sw-site/config.js` with your relay URL and `testMode: false`), the `rsync`.
2. On the server: section 3 (modules, `sw.conf`, certbot, the reload hook, `apachectl configtest`), section 4 (the relay built or copied, the user, the certificate hook run once, the sysctl, the unit, `systemctl enable --now vnet-relay`). Open TCP 80 and 443, UDP 7777 and UDP 443 on the firewall and the router.
3. Section 6's `curl` checks from another machine: each must give the answer shown. Open `https://game.example.org/games/sw/?test=1`: no "test mode" line.
4. **A browser host:** `https://game.example.org/games/sw/?host=3` on the PC, "Click to host a game of 3"; note the code.
5. **A browser guest from the invite link, on another network if possible:** send the link to a phone on its mobile data (not your Wi-Fi), or a laptop on a phone's hotspot; "Click to join room ...": both lobbies say 2 of 3.
6. **A desktop player on Arch joining by code:** section 5's build, at the commit you deployed, then `./sw -net -relay game.example.org:7777 -room CODE --`. All three start; the host picks co-op in the menus; play a few minutes, including a fight.
7. **WebTransport:** in the browsers' consoles (F12), `relay-wt`; on the server `curl -s 127.0.0.1:8081/stats` shows `"webtransports": 2` during the game, and `journalctl -u vnet-relay` shows the room created and closed. Please also say whether that three-player game felt slow (L25: in the container a browser host with two guests over WebTransport ran at two thirds of the normal speed); compare with a game where the host's browser cannot use UDP 443 (block it, or remove `-wt` and restart the relay: then all say `relay-ws`).
8. **A redeploy reaching an open browser:** leave a browser on the page; change something visible (for example the `<title>` in `build-wasm/index.html`, or rebuild after a `git pull`), `rsync` again; reload the open page: the change is there, and the browser's network panel shows `304` for the files that did not change.
9. Optional: the check script on a spare Arch machine or VM (`sudo tests/deploy/check-deploy.sh`), which would check the Arch-only parts it could not check here (`httpd`, `/usr/lib/httpd/modules`, the `http` user); it needs the ports free and nothing at `/srv/http/games/sw`.
