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

(To be written by the implementer.)
