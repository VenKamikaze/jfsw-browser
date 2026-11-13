# Deploying the browser game and the relay (Arch Linux, Apache)

This guide puts the browser build of Shadow Warrior on an Apache server and runs the vnet relay that network games go through, on an Arch Linux machine (x86_64 or aarch64). Browser players then host and join games by room code over `wss://` (WebTransport where it works), and desktop players join the same rooms over UDP. The paths and package names are Arch's; other distributions differ mainly in where Apache keeps its configuration. What was checked, and where, is at the [end](#what-was-checked-where).

Placeholders used throughout (replace them with your own):

| Placeholder | Meaning |
|---|---|
| `game.example.org` | the public host name of the web server (and, in the simple layout, of the relay) |
| `/srv/http/games/sw` | the directory the game's files go in, served at `https://game.example.org/games/sw/` (Arch's Apache serves `/srv/http`) |
| `relay.example.org` | the relay's host name, only if the relay runs on a different machine from Apache |
| `you@game.example.org` | your login on the server, for copying files |

Nothing in the page needs to know its own URL path: it loads its files relatively, so any directory works.

## The layout

The simplest layout, and the one this guide describes first, is **one machine running both Apache and the relay**:

```
browser ──HTTPS (TCP 443)──▶ Apache ──▶ /games/sw/        the page, the game, the game data
        ──WSS  (TCP 443)──▶ Apache ──▶ /vnet ──▶ relay 127.0.0.1:8080 (WebSocket)
        ──QUIC (UDP 443)───────────────────────▶ relay :443        (WebTransport, optional)
desktop ──UDP 7777─────────────────────────────▶ relay :7777
```

The page takes its relay **only from `config.js`** (the `relay` field): there is no default relay and no link parameter for it, so that a crafted link cannot send visitors through someone else's relay. With the relay behind the same Apache, the page on `https://game.example.org/games/sw/` uses `relay: 'wss://game.example.org/vnet'`. From a `wss://` URL the game also derives the WebTransport address, `https://game.example.org/vnet` on UDP 443, and tries it first; a `ws://` URL means WebSocket only.

### Ports to open

On the machine's firewall, and forwarded from the router if the machine is behind NAT:

| Port | Protocol | For | Needed |
|---|---|---|---|
| 443 | TCP | Apache: the page, the game data and the browsers' WebSocket (`/vnet`) | yes |
| 80 | TCP | Apache: Let's Encrypt's HTTP challenge and the redirect to HTTPS | yes, if you use certbot's HTTP challenge |
| 7777 | UDP | the relay: desktop players | yes, for desktop players |
| 443 | UDP | the relay: WebTransport (HTTP/3) for browsers | optional; browsers fall back to the WebSocket without it |

Do **not** open 8080 or 8081: the relay's HTTP and stats listeners stay on `127.0.0.1`, and only Apache talks to them. The relay makes no outbound connections.

## 1. Build the web game

The output is WebAssembly and JavaScript, which runs the same everywhere, so build it on your usual PC (x86_64 Arch; building on an aarch64 server has not been tried). From a fresh clone:

```bash
sudo pacman -S --needed base-devel git python go rsync
git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser ~/jfsw-browser
cd ~/jfsw-browser
scripts/setup-emsdk.sh                  # once: Emscripten 6.0.13 into ~/.cache/jfsw-browser/emsdk
scripts/build-wasm.sh                   # the browser build, into build-wasm/
scripts/fetch-test-data.sh              # the shareware game data, checked, as testdata/swshare.grp
```

(`scripts/setup-emsdk.sh --with-ports` if GitHub archive downloads are blocked where you build; `doco/browser/building.md` §6 has the details.)

The site needs exactly these files, and nothing else from `build-wasm/`:

| File | About |
|---|---|
| `index.html` | the page |
| `jfsw.css` | its style |
| `config.js` | the site's settings: **your own copy**, see [section 2](#2-configjs-for-the-site) |
| `grptable.js`, `data.js` | the game data download, check and cache |
| `jfsw.js` | the page's glue: start-up, the lobby, messages |
| `sw.js` | Emscripten's loader |
| `sw.wasm` | the game, about 2.6 MB (about 0.9 MB with gzip) |
| `swshare.grp` | the shareware game data, 26,056,769 bytes (11.6 MB with gzip); from `testdata/`, see [The game data](#the-game-data) |

None of them is test-only. The browser tests' hooks are in `jfsw.js`, but they work only when `config.js` has `testMode: true`, which a public site never has.

Copy them to the server, with your `config.js` (section 2) instead of the build's:

```bash
ssh you@game.example.org 'sudo install -d -o you /srv/http/games/sw'      # once
rsync -av --delay-updates \
    build-wasm/{index.html,jfsw.css,grptable.js,data.js,jfsw.js,sw.js,sw.wasm} \
    ~/sw-site/config.js testdata/swshare.grp \
    you@game.example.org:/srv/http/games/sw/
```

`--delay-updates` puts the new files in place together at the end, so a visitor who loads the page during the copy does not get a new `sw.js` with an old `sw.wasm` (which fails: see [Troubleshooting](#troubleshooting)). rsync sends only what changed; the GRP goes once.

### The game data

The site serves `swshare.grp` itself, from the same directory, so no CORS is needed. `doco/browser/data-hosting.md` explains its headers, compression and caching; the Apache configuration below includes them. The page keeps the file in the visitor's browser (IndexedDB) and checks its size and CRC-32 before it uses it, so a visitor downloads it once.

**Where the file comes from:** `scripts/fetch-test-data.sh` downloads the official 3D Realms shareware archive `3dsw12.zip` (`https://image.dosgamesarchive.com/games/3dsw12.zip`, or the same file at `https://archive.org/download/3dsw12/3dsw12.zip`), checks its MD5 (`d77564e8764feeb1509dd0d534fb8952`), unpacks `SWSW12.SHR` from it and `SW.GRP` from that, and checks the GRP (26,056,769 bytes, CRC-32 `08A7FA1F`). Serve that file; do not serve the zips (the page does not unpack them).

**What the archive's licence says.** The archive's `LICENSE.TXT` (also inside `SWSW12.SHR`), section [3], "GRANT", says:

> [A] INDIVIDUALS are encouraged to share and give copies of the Game to friends, family, coworkers, and members of any not-for-profit organization, but only without charge.

> [D] These grants are subject to the conditions that no copyright information or trademark will be added or removed, and all of the Game's files as released by 3D Realms will be included without modification (except for "New Levels" as permitted below by this license).

Read the whole file before you put the data online. This guide makes no claim about what it allows; whether to serve the GRP is your decision (decision D11 of this project: only the shareware GRP may be offered for public download, by default).

**The registered `sw.grp` must not be put on a public site.** Players who own the game use the page's "Use your own copy of the game data..." button; the file stays on their machine. (A registered game allows 8 players instead of 4, and every player in a room needs the same data.)

## 2. `config.js` for the site

`config.js` is the one file you edit. `scripts/build-wasm.sh` copies the repository's `web/config.js` into `build-wasm/` whenever that file is newer, so keep **your own copy outside the build** and deploy that one:

```bash
mkdir -p ~/sw-site && cp web/config.js ~/sw-site/config.js      # once; then edit ~/sw-site/config.js
```

The settings part of it, for the layout above (the comments above it in the file explain every field):

<!-- check-deploy: site-config -->
```js
window.JFSW_CONFIG = {
  testMode: false,
  relay: 'wss://game.example.org/vnet',
  data: {
    url: 'swshare.grp',
    size: 26056769,
    crc32: '08a7fa1f',
    revalidate: false
  }
};
```

- `relay`: the relay's WebSocket URL, as the browser reaches it. Empty means no network games: the page then says so when someone tries to host or join.
- `testMode` **must stay `false`**. With `true`, a link with `?test=1` turns on the test hooks and the test-only parameters, among them `?args=`, which hands the visitor's game any arguments, a different relay included.
- `data`: the GRP's URL (relative to the page), size and CRC-32 (data-hosting.md). Changing any of the three makes every visitor download the file again.

After you update the repository, compare your copy with the new `web/config.js` (`diff web/config.js ~/sw-site/config.js`) in case a field was added.

### If the relay is on another machine

Set `relay: 'wss://relay.example.org/vnet'`. The game derives WebTransport at `https://relay.example.org/vnet` (UDP 443 on that machine). See [The relay on a different machine](#the-relay-on-a-different-machine).

## 3. Apache

Arch's `apache` package (2.4.47 or later is needed for the WebSocket proxying below; Arch has a current 2.4). In `/etc/httpd/conf/httpd.conf`, make sure these modules are loaded (uncomment the lines; some are loaded already):

<!-- check-deploy: httpd-modules -->
```apache
LoadModule mime_module modules/mod_mime.so
LoadModule filter_module modules/mod_filter.so
LoadModule deflate_module modules/mod_deflate.so
LoadModule headers_module modules/mod_headers.so
LoadModule rewrite_module modules/mod_rewrite.so
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule ssl_module modules/mod_ssl.so
LoadModule socache_shmcb_module modules/mod_socache_shmcb.so
```

and add `Include conf/extra/sw.conf` at the end. Then create `/etc/httpd/conf/extra/sw.conf` (fold the two `<Directory>`/`DeflateAlterETag` parts and the three proxy lines into your existing `:443` virtual host instead, if you have one):

<!-- check-deploy: apache-site -->
```apache
Listen 443

<VirtualHost *:80>
    ServerName game.example.org
    DocumentRoot "/srv/http"
    # Everything to HTTPS, except Let's Encrypt's challenge files.
    RewriteEngine on
    RewriteCond %{REQUEST_URI} !^/\.well-known/acme-challenge/
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName game.example.org
    DocumentRoot "/srv/http"
    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/game.example.org/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/game.example.org/privkey.pem

    # Keep the ETag of a compressed answer as it is, so that a browser revalidating a file it has
    # gets "304 Not Modified" instead of the whole file again (Apache 2.4.58 or later; allowed here,
    # not in <Directory>). See data-hosting.md.
    DeflateAlterETag NoChange

    # The game: static files.
    <Directory "/srv/http/games/sw">
        Require all granted
        AddType application/wasm .wasm
        AddType application/octet-stream .grp
        AddOutputFilterByType DEFLATE text/html text/css text/javascript application/javascript application/wasm application/octet-stream
        # Revalidate on every load, so a redeploy reaches every browser on its next load (unchanged
        # files come back as 304). The page, its scripts and the wasm must always be of one build.
        Header set Cache-Control "no-cache"
        # The game data: the page keeps its own copy (IndexedDB) and never uses the HTTP cache for it;
        # this is for other clients.
        <Files "swshare.grp">
            Header set Cache-Control "public, max-age=86400"
        </Files>
    </Directory>

    # The relay's WebSocket endpoint. Apache adds X-Forwarded-For, which the relay reads with -trust-forwarded-for.
    ProxyRequests off
    ProxyPass        /vnet http://127.0.0.1:8080/vnet upgrade=websocket
    ProxyPassReverse /vnet http://127.0.0.1:8080/vnet
</VirtualHost>
```

Notes:

- `Listen 443` is only needed if nothing else in your configuration already listens on 443 (Arch's stock `conf/extra/httpd-ssl.conf` does; don't include both).
- No `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy` headers are needed: the build uses no threads (no `-pthread`, no `SharedArrayBuffer`).
- `mod_proxy_wstunnel` is not needed: `upgrade=websocket` on `ProxyPass` (Apache 2.4.47+) does the job.
- Every file but the GRP is `no-cache`, the wasm included. A long `max-age` on `sw.wasm` would let a browser keep an old `sw.wasm` next to a new `sw.js` after a redeploy, and the game then fails to start.

### The certificate

For a host reachable from the internet on TCP 80, `certbot` gets a Let's Encrypt certificate (`sudo pacman -S certbot`). Get it first with the 443 virtual host commented out (Apache will not start while the certificate files are missing), or with `--standalone` while Apache is stopped, then enable the 443 virtual host:

```bash
sudo certbot certonly --webroot -w /srv/http -d game.example.org
sudo systemctl enable --now certbot-renew.timer      # the timer Arch's certbot package ships; systemctl list-timers shows it
```

Add a deploy hook that reloads Apache after a renewal, `/etc/letsencrypt/renewal-hooks/deploy/httpd.sh` (then `sudo chmod +x` it):

```sh
#!/bin/sh
systemctl reload httpd
```

If TCP 80 is not reachable from the internet, use certbot's DNS challenge instead.

Then:

```bash
sudo apachectl configtest && sudo systemctl enable --now httpd    # or: sudo systemctl reload httpd
```

## 4. The relay

The relay is one static Go binary with no run-time dependencies, in this repository's `ext/vnet/relay` (its `README.md` lists every flag and limit).

### Build it

Either on the PC, from the same checkout, for the server's architecture (`GOARCH=arm64` for aarch64, `amd64` for x86_64):

```bash
cd ~/jfsw-browser/ext/vnet/relay
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o vnet-relay-arm64 ./cmd/vnet-relay
scp vnet-relay-arm64 you@game.example.org:/tmp/vnet-relay
```

or on the server itself (Go 1.24 or later):

```bash
sudo pacman -S --needed go git
git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser ~/jfsw-browser
cd ~/jfsw-browser/ext/vnet/relay && CGO_ENABLED=0 go build -trimpath -o /tmp/vnet-relay ./cmd/vnet-relay
```

Install it and give it its own user:

```bash
sudo install -m 755 /tmp/vnet-relay /usr/local/bin/vnet-relay
sudo useradd --system --no-create-home --shell /usr/bin/nologin vnet-relay
```

Check that it runs: `vnet-relay -udp 127.0.0.1:0 -http 127.0.0.1:0` prints a `LISTEN ...` line (Ctrl+C to stop).

### WebTransport's certificate (optional)

WebTransport needs the relay to hold a real certificate for the page's relay host name (here the same Let's Encrypt one as Apache's). The relay runs as `vnet-relay`, which cannot read `/etc/letsencrypt`, so give it a copy that a certbot hook refreshes, `/etc/letsencrypt/renewal-hooks/deploy/vnet-relay.sh`:

<!-- check-deploy: relay-cert-hook -->
```sh
#!/bin/sh
# Copies the renewed certificate where the relay can read it; the relay notices new files within a minute, no restart.
set -eu
lineage="${RENEWED_LINEAGE:-/etc/letsencrypt/live/game.example.org}"
d=/etc/vnet-relay/certs
install -d -m 750 -o root -g vnet-relay "$d"
install -m 644 -o root -g vnet-relay "$lineage/fullchain.pem" "$d/fullchain.pem"
install -m 640 -o root -g vnet-relay "$lineage/privkey.pem"   "$d/privkey.pem"
```

```bash
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/vnet-relay.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/vnet-relay.sh      # once now, for the first copy
```

QUIC wants bigger UDP buffers than the default (it works without, with less headroom):

```bash
printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' | sudo tee /etc/sysctl.d/90-vnet-relay.conf
sudo sysctl --system
```

Skip this section, and the `-wt` flags below, to run without WebTransport.

### The service

`/etc/systemd/system/vnet-relay.service`:

<!-- check-deploy: relay-unit -->
```ini
[Unit]
Description=vnet relay (Shadow Warrior network games)
After=network-online.target
Wants=network-online.target

[Service]
User=vnet-relay
Group=vnet-relay
ExecStart=/usr/local/bin/vnet-relay \
    -udp :7777 \
    -http 127.0.0.1:8080 -trust-forwarded-for \
    -origins game.example.org \
    -stats 127.0.0.1:8081 \
    -wt :443 -wt-cert /etc/vnet-relay/certs/fullchain.pem -wt-key /etc/vnet-relay/certs/privkey.pem \
    -v
# Binding UDP 443 (WebTransport) needs this; drop it, and the -wt line, without WebTransport.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now vnet-relay
journalctl -u vnet-relay -f        # the LISTEN line, then "room ... created" and "closed"
```

What the flags do here:

- `-udp :7777`: desktop players, on every interface.
- `-http 127.0.0.1:8080 -trust-forwarded-for`: the WebSocket listener, reachable only by Apache. The relay takes each browser's address from the `X-Forwarded-For` header Apache adds, so its per-address limits count players, not Apache. Never use `-trust-forwarded-for` on a listener the internet can reach directly.
- `-origins game.example.org`: only pages from your site may open sessions. It is matched against the browser's `Origin` exactly, **including a port**: a page served on a non-standard port, say 8443, needs `-origins game.example.org:8443`. List several, comma separated. It is the *page's* host, wherever the relay runs.
- `-stats 127.0.0.1:8081`: counters as JSON, local only (`curl -s 127.0.0.1:8081/stats`): rooms, sessions, `websockets`, `webtransports`, `rate_limited`. Optional.
- `-wt :443 ...`: WebTransport on UDP 443, so the URL the game derives from `wss://game.example.org/vnet`, `https://game.example.org/vnet`, needs no port. Apache does not use UDP 443 (it has no HTTP/3), so the two do not clash.
- `-v`: log rooms as they are created and closed. The relay's log does not name each member's transport; `/stats` counts the WebTransport sessions, and each browser's console says which one it got (`relay-wt` or `relay-ws`).

### Limits and time-outs: the defaults fit this game

**Packet and byte rates** (`-client-pps 600`, `-client-bps 600000`, per member, bursts of twice that; excess datagrams are dropped and counted in `/stats` as `rate_limited`). The busiest member of a room is the host (the master): it sends every other player each tic and its acknowledgements. Measured through the relay (30 s co-op games on E1L1, every player a desktop game; `-testlag` counts what the host sends):

| Players | Host sends, datagrams a second (per other player) | Host sends, bytes a second (relay frames, UDP) |
|---|---|---|
| 2 | 68 (68) | 5,250 |
| 3 | 130 (65) | 9,660 |
| 4, the most the shareware data allows | 188 (63) | 15,800 |
| 8, registered data: computed, not measured | about 440 (63); at most 560 (80) | about 50,000; under 160,000 |

A guest sends to the host only, about 67 a second. The per-player rate cannot exceed about 80 a second (one datagram per input, 40 a second, plus at most one paced datagram per 25 ms; brief 04b), which gives the bound for 8 players. So **the defaults are enough**: with the shareware data the host uses a third of `-client-pps` and 3 % of `-client-bps`. For 8-player games with registered data the measured rate fits, but the bound is close to 600, so a server for such games should raise the packet rate: `-client-pps 1000`. Nothing else needs raising.

**Time-outs.** The relay drops a member that has been silent for 15 s (`-session-timeout`), and the game ends a network game when the host, or a guest, has sent nothing for 15 s (with "the host left the game" or "player P left the game"). The two are meant to be equal: a player who vanishes ends the game after 15 s, and the relay frees their place at the same time; a newcomer who then gets the same virtual address is still refused ("the game has already started"), because the game matches places by session, not by address. **Leave `-session-timeout` (15 s) and `-keepalive` (5 s) alone.** A shorter session time-out drops desktop players who stall for a few seconds (the relay sees silence; the game would have waited); a longer one keeps vanished players' places in the relay longer and changes nothing in the game. `-room-idle` (30 min) closes a room that carried no data that long: a host waiting alone in the lobby for half an hour loses the room.

**Per-address limits.** Every cap is per source address, so a LAN party behind one NAT shares 128 members, 16 rooms and 20 room joins a second. Fine for home use; the relay's README lists the flags to raise them.

### The relay on a different machine

Run it the same way on that machine, with its own certificate for `relay.example.org` (the hook's `lineage` then names it) and a TLS proxy in front of `/vnet`: Apache's `ProxyPass` lines as above in a virtual host for `relay.example.org`, or the Caddy and nginx snippets in `ext/vnet/relay/README.md`. Set `relay: 'wss://relay.example.org/vnet'` in `config.js`, and keep `-origins game.example.org` (the *page's* host, not the relay's). Open the ports from the table on the relay's machine instead, and tell desktop players `relay.example.org:7777`.

## 5. Desktop players

There is no Windows or macOS build in this project, and no packaged Linux build: desktop players on Linux build the game from source. On Arch:

```bash
sudo pacman -S --needed git
git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser ~/jfsw-browser
cd ~/jfsw-browser
git checkout <the commit your site runs>; git submodule update --init      # see "Builds must match" below
scripts/setup.sh                    # pacman: compiler, SDL2, Vorbis, GTK3, ...
make -j"$(nproc)"
scripts/fetch-test-data.sh && mkdir -p ~/.jfsw && cp testdata/swshare.grp ~/.jfsw/
```

Then join a room whose code a browser host shows (or host one):

```bash
./sw -net -relay game.example.org:7777 -room CODE --
./sw -net -relay game.example.org:7777 -host-room 3 --      # prints the room code; type "start" and Enter to begin with fewer
```

Or start `./sw`, open the console (Num Lock), and type `relay game.example.org:7777` once (it is kept in `sw.cfg`), then `join CODE` or `host 3`; or use the main menu's **Host Online** and **Join Online** after setting the relay; or, in the GTK startup window (`./sw -setup`), tick "Online, through the relay:", give `game.example.org:7777`, and choose "Join multi-player game" with the room code. `doco/browser/building.md` §6.6 has the details.

### Builds must match

A browser player and a desktop player can only play together on the **same build** of the game. Nothing checks it: every build of this project announces the same game version, so the room accepts any of them, and what happens depends on what changed between the two builds:

- **The game's simulation differs** (a fix that changes what happens in the game): the game starts and the machines drift apart. Only the host notices: its screen shows "GAME OUT OF SYNC! Restart the game." and its log says `GAME OUT OF SYNC: tic T, ...`, and the game goes on, with each player seeing a different game. (Found with a deliberate difference, `-testnudge`; `bugs.md` L24.)
- **Only the lobby or network code differs**: it may still work. A build from before brief 05 (no session ids in the lobby) and the current one played together and agreed on every tic, either way round.
- **In one browser, a page and a wasm of different builds** (an old `sw.wasm` kept by a cache, or a half-finished copy): the game does not start. The page says "The game could not start: ..." or "The game crashed: LinkError: WebAssembly.instantiate(): ...". A reload fixes it once the browser has both files of one build, which the `no-cache` headers above make sure of.

So: after a redeploy, tell desktop players which commit the site runs (the game prints it at start, `Version 20260105-115-g246c0af`: the part after `g` is the commit; a browser prints the same line in its console), and have them `git checkout` that commit and `make` again.

## 6. Check it

From any machine (the expected answers are under each command):

```bash
curl -sI -H 'Accept-Encoding: gzip' https://game.example.org/games/sw/sw.wasm | grep -iE '^HTTP|^cache-control|^content-type|^content-encoding'
#   HTTP/1.1 200 OK
#   Cache-Control: no-cache
#   Content-Type: application/wasm
#   Content-Encoding: gzip

curl -sI -H 'Accept-Encoding: gzip' https://game.example.org/games/sw/swshare.grp | grep -iE '^HTTP|^etag|^cache-control|^content-type|^content-encoding'
#   HTTP/1.1 200 OK
#   ETag: "..."
#   Cache-Control: public, max-age=86400
#   Content-Type: application/octet-stream
#   Content-Encoding: gzip

curl -s https://game.example.org/games/sw/config.js | grep -E '^ *(testMode|relay):'
#   testMode: false,
#   relay: 'wss://game.example.org/vnet',

curl -si --http1.1 -N --max-time 3 https://game.example.org/vnet \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://game.example.org' | head -1
#   HTTP/1.1 101 Switching Protocols
#   (403 Forbidden: the Origin is not in -origins; 503 Service Unavailable: the relay is not running)
```

On the server, `curl -s 127.0.0.1:8080/healthz` answers `ok`, and `curl -s 127.0.0.1:8081/stats` shows the counters.

The `--http1.1` matters if your Apache also speaks HTTP/2: a WebSocket upgrade is an HTTP/1.1 request.

**Test mode is off:** open `https://game.example.org/games/sw/?test=1`. The page must look exactly as without `?test=1`: no line starting "test mode: args=" under the game. (With `testMode: true` in `config.js` that line appears, and links can hand visitors' games arguments.)

Then play:

1. Open `https://game.example.org/games/sw/?host=3` in one browser and click "Click to host a game of 3". The lobby shows a six-letter room code, an invite link (`https://game.example.org/games/sw/?join=CODE`, with Copy) and "1 of 3 players are in". (Or start the game and use the main menu's **Host Online**.)
2. Open the invite link in another browser (another machine, a private window, a phone): "Click to join room CODE". Both lobbies say "2 of 3".
3. A desktop player joins with the code (section 5): the lobbies say "3 of 3" and the game starts; the host picks a co-op game in the menus. (With 3 places and 2 players in, the host can press "Start now".)
4. WebTransport: in each browser's console (F12) the game says `mmulti: room code ... (you are 10.0.0.1, relay-wt; ...)` or `joined room ... (relay-wt)`; `relay-ws` means the WebSocket. On the server, `curl -s 127.0.0.1:8081/stats` shows `"webtransports":` with the number of WebTransport sessions while they play. A browser that cannot reach UDP 443 falls back to the WebSocket after about 3 s, so play works either way.

## Without TLS

Plain HTTP works on a LAN, but browsers allow WebTransport only on HTTPS pages, so it is WebSocket only. Serve the page on port 80 (no redirect), put the `<Directory>` block and the three proxy lines into the port-80 virtual host, and set `relay: 'ws://game.example.org/vnet'` in `config.js`. Run the relay without the `-wt` flags. Desktop players are not affected: they use UDP 7777 either way.

## Updating

- **The game:** rebuild, copy the files again with the `rsync` above (your own `config.js`; check `diff web/config.js ~/sw-site/config.js` for new fields). Browsers get the new build on their next page load; a page that is already open keeps running the old one until it is reloaded. Tell desktop players the new commit (see [Builds must match](#builds-must-match)): a room of mixed builds can go out of sync.
- **The relay:** rebuild, `sudo install` it again and `sudo systemctl restart vnet-relay`. A restart ends every room in progress (players see "the relay ended the session ...").

## Troubleshooting

The page's messages and the desktop game's (in its console, `sw.log` and a message box) are the same, after "Network game failed: ".

| Message or symptom | Likely cause |
|---|---|
| "This page cannot host (join) a network game: no relay is set up for it ..." | `relay` in the deployed `config.js` is empty |
| "the relay could not be reached" (browser) | the relay is not running, Apache's `/vnet` proxy is missing, or the page's `Origin` is not in `-origins`: run the WebSocket `curl` check above (403 or 503) |
| "the relay could not be reached" or "the relay did not answer" (desktop) | UDP 7777 is not open or not forwarded, or the wrong `HOST:PORT` in the relay setting |
| "there is no room with that code" | a wrong code, or the relay was restarted since the room was made |
| "the room is full" | every place in the room is taken |
| "the game has already started (joining a game in progress is not possible)" | late joiners are refused: the host starts a new room |
| "the host left the room before the game started" / "the host stopped answering" | the host pressed Cancel / closed the tab in the lobby |
| "the host left the game ..." / "player P (Name) left the game ..." | that player's machine sent nothing for 15 s (closed tab, lost connection) |
| "the relay ended the session (room closed, timed out, or the relay restarted)" | the relay restarted, or this machine was silent for 15 s |
| "The game could not start: ..." or "The game crashed: LinkError: WebAssembly.instantiate(): ..." | `sw.js` and `sw.wasm` from different builds: a cached old `sw.wasm` (check `Cache-Control: no-cache` with `curl`) or a copy still in progress; reload |
| "GAME OUT OF SYNC! Restart the game." on the host's screen | the players run different builds (see [Builds must match](#builds-must-match)), or a game bug |
| the game data does not download | see data-hosting.md; the page's message says what failed |
| browsers always say `relay-ws`, never `relay-wt` | UDP 443 is closed, `-wt` is off, or the relay cannot read its certificate copy (see its log) |
| the relay logs a certificate warning | the renewal hook did not run: run it by hand and check `sudo certbot renew --dry-run` |
| `rate_limited` grows in `/stats` during games | a member sends more than `-client-pps` or `-client-bps` allow: see the limits above |

## What was checked where

This guide was followed end to end in the project's cloud container, which is Ubuntu 24.04 (x86_64), not Arch, by `tests/deploy/check-deploy.sh` (`doco/browser/building.md` §6.7 says how to run it). It takes the configuration blocks of this file as they are (`config.js`, the module lines, `sw.conf`, the certificate hook, the unit's command line) and:

- runs Ubuntu's Apache 2.4.58 with an Arch-style `httpd.conf` (the module lines above, `Include` of `sw.conf`), a self-signed certificate for `game.example.org` in place of Let's Encrypt's, `game.example.org` mapped to 127.0.0.1 in `/etc/hosts`, and the game in `/srv/http/games/sw`;
- runs the relay built from `ext/vnet/relay` as the `vnet-relay` user with the unit's flags, by hand (`setpriv`, the capability as the unit gives it): the container has no systemd (`systemd-analyze verify` checked the unit file);
- makes every `curl` check above and gets the answers given;
- checks that the deployed page ignores `?test=1`, and plays: two Chromium pages from `https://game.example.org/games/sw/` (the lobby, the invite link) and a desktop `sw` joining by code over UDP 7777; and a co-op game of the same three through a test-mode copy of the site (for the per-tic records only), in which every machine agrees on every tic, with WebTransport on UDP 443 (Chromium trusting the self-signed certificate by its key hash).

Not checked there: certbot and Let's Encrypt (no public host name), the renewal timer and the Apache reload hook, systemd itself (`systemctl`, `journalctl`), `sysctl` (not allowed in the container), `pacman` and Arch's own `httpd.conf` and paths, the aarch64 relay binary (it was cross-compiled, not run), and a real network between the players.
