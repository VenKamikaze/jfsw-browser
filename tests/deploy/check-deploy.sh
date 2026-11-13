#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# End-to-end check of doco/browser/deploy.md (brief 06): follows the guide as far as a
# machine without a public host name allows, and plays through what it set up.
#
#   sudo tests/deploy/check-deploy.sh                 # everything (about 3 minutes)
#   sudo tests/deploy/check-deploy.sh --quick         # the set-up and the curl checks, no browsers
#   sudo tests/deploy/check-deploy.sh --guide FILE    # take the configuration from another copy of the guide
#   sudo tests/deploy/check-deploy.sh --keep          # leave Apache, the relay and the files in place
#
# It needs root, Apache 2.4.47+ (Ubuntu's apache2 or Arch's httpd), openssl, curl, Go, node with
# Playwright and its Chromium (never `playwright install`), setpriv, and from the repository:
# build-wasm/ (scripts/build-wasm.sh), ./sw (make) and testdata/swshare.grp (scripts/fetch-test-data.sh).
# It is not part of `make test`.
#
# What it does, from the guide's own blocks (the fenced block after each "<!-- check-deploy: NAME -->"):
#   * site-config: the deployed config.js is the build's, with its settings replaced by this block;
#   * httpd-modules, apache-site: an Arch-style httpd.conf of its own (ServerRoot in a temporary
#     directory, the distribution's modules) that loads these lines and Includes sw.conf, with a
#     self-signed certificate for game.example.org in place of Let's Encrypt's;
#   * relay-cert-hook: run as certbot would (RENEWED_LINEAGE), as root;
#   * relay-unit: `systemd-analyze verify`, then its ExecStart flags, run as the vnet-relay user with
#     the unit's capability by setpriv (no systemd needed).
# and it puts the game in /srv/http/games/sw, maps game.example.org to 127.0.0.1 in /etc/hosts, and
# needs TCP 80 and 443, UDP 443 and 7777, and 127.0.0.1:8080 and 8081 free: the guide's own ports.
# Everything it adds (the files, the hosts line, the vnet-relay user and /etc/vnet-relay if it made
# them) is removed at the end unless --keep; Apache and the relay are stopped.
#
# Then: the guide's curl checks; the deployed page with ?test=1 (no hooks, ?args= unused); a game
# through the deployed page's lobby (two Chromium pages, ?host=3 and the invite link, and a native
# ./sw joining by code over UDP 7777); and a co-op game of the same three through a test-mode copy
# of the site (/srv/http/games/sw-test, there only while it runs) in which every machine's -testdump
# must agree on every tic, over WebTransport (Chromium trusts the certificate by its key hash, and
# --webtransport-developer-mode lets WebTransport use a certificate without a public root). See
# tests/deploy/play.js. Each check prints "ok:" or "FAIL:"; the script ends with PASS or FAILED.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guide="$root/doco/browser/deploy.md"
quick=0; keep=0
while [ $# -gt 0 ]; do
    case "$1" in
        --guide) guide="$(readlink -f "$2")"; shift 2 ;;
        --quick) quick=1; shift ;;
        --keep) keep=1; shift ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done

HOST=game.example.org
SITE=/srv/http/games/sw
TESTSITE=/srv/http/games/sw-test
fails=0
ok()   { echo "ok:   $*"; }
bad()  { echo "FAIL: $*"; fails=$((fails + 1)); }
note() { echo "== $*"; }
die()  { echo "check-deploy: $*" >&2; exit 125; }
expect() {  # expect DESCRIPTION TEXT REGEX...: every REGEX (grep -E, case-insensitive) must match a line of TEXT
    local what="$1" text="$2" re miss=""; shift 2
    for re in "$@"; do printf '%s\n' "$text" | grep -Eqi -- "$re" || miss="$miss [$re]"; done
    if [ -z "$miss" ]; then ok "$what"; else bad "$what: missing$miss; got: $(printf '%s' "$text" | tr '\r\n' '  ' | cut -c1-300)"; fi
}

# ---- prerequisites ----------------------------------------------------------------------------------
[ "$(id -u)" = 0 ] || die "run it as root (it configures Apache, a system user and /etc/hosts)"
[ -f "$guide" ] || die "no guide at $guide"
if command -v apache2 >/dev/null; then httpd=apache2; modules=/usr/lib/apache2/modules; user=www-data
elif command -v httpd >/dev/null; then httpd=httpd; modules=/usr/lib/httpd/modules; user=http
else die "no Apache (apache2 or httpd)"; fi
for t in openssl curl setpriv node; do command -v "$t" >/dev/null || die "$t not found"; done
export PATH="$PATH:/usr/local/go/bin"
# Everything here talks to this machine: no HTTP(S) proxy from the environment.
export no_proxy="$HOST,127.0.0.1,localhost${no_proxy:+,$no_proxy}" NO_PROXY="$HOST,127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
command -v go >/dev/null || die "go not found (Go 1.24 or newer, for the relay)"
for f in build-wasm/sw.wasm build-wasm/sw.js sw testdata/swshare.grp; do [ -e "$root/$f" ] || die "$f is missing (see doco/browser/building.md)"; done
grep -q "$HOST" /etc/hosts && die "/etc/hosts already names $HOST; remove that line first"
[ -e "$SITE" ] && die "$SITE exists; remove it first (or it is left from a --keep run)"
[ -e "$TESTSITE" ] && die "$TESTSITE exists; remove it first"
for p in 0050 01BB; do  # TCP 80, 443 listening
    awk -v p="$p" 'NR>1 && $4=="0A" && substr($2, index($2, ":")+1)==p {f=1} END {exit !f}' /proc/net/tcp /proc/net/tcp6 2>/dev/null && die "TCP port $((16#$p)) is in use"
done
for p in 01BB 1E61; do  # UDP 443, 7777
    awk -v p="$p" 'NR>1 && substr($2, index($2, ":")+1)==p {f=1} END {exit !f}' /proc/net/udp /proc/net/udp6 2>/dev/null && die "UDP port $((16#$p)) is in use"
done
for p in 1F90 1F91; do  # 127.0.0.1:8080, 8081
    awk -v p="$p" 'NR>1 && $4=="0A" && substr($2, index($2, ":")+1)==p {f=1} END {exit !f}' /proc/net/tcp /proc/net/tcp6 2>/dev/null && die "TCP port $((16#$p)) is in use"
done

w="$(mktemp -d "${TMPDIR:-/tmp}/jfsw-deploy.XXXXXX")" || die "mktemp failed"
chmod 755 "$w"
relay_pid=""; made_user=0; made_etc=0; made_srv=0; hosts_added=0
cleanup() {
    if [ "$keep" = 1 ]; then
        echo "kept: Apache ($httpd -f $w/httpd/conf/httpd.conf), the relay (pid $relay_pid), $SITE, the $HOST line in /etc/hosts, $w"
        echo "      stop them with: $httpd -f $w/httpd/conf/httpd.conf -k stop; kill $relay_pid; and remove the files"
        return
    fi
    [ -n "$relay_pid" ] && kill "$relay_pid" 2>/dev/null && wait "$relay_pid" 2>/dev/null
    if [ -f "$w/httpd/run/httpd.pid" ]; then
        "$httpd" -f "$w/httpd/conf/httpd.conf" -k stop 2>/dev/null
        local i; for i in $(seq 1 50); do [ -f "$w/httpd/run/httpd.pid" ] || break; sleep 0.1; done
    fi
    rm -rf "$TESTSITE"
    [ -f "$SITE/.check-deploy" ] && rm -rf "$SITE"
    rmdir /srv/http/games 2>/dev/null
    [ "$made_srv" = 1 ] && rmdir /srv/http 2>/dev/null
    [ "$hosts_added" = 1 ] && sed -i "/ $HOST # check-deploy\$/d" /etc/hosts
    [ "$made_etc" = 1 ] && rm -rf /etc/vnet-relay
    [ "$made_user" = 1 ] && userdel vnet-relay 2>/dev/null
    rm -rf "$w"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The fenced block after "<!-- check-deploy: NAME -->" in the guide.
block() {
    awk -v name="$1" '
        $0 ~ "<!-- check-deploy: " name " -->" { want = 1; next }
        want && /^```/ { if (inside) exit; inside = 1; next }
        inside { print }' "$guide"
}
for b in site-config httpd-modules apache-site relay-cert-hook relay-unit; do
    [ -n "$(block "$b")" ] || die "the guide has no block marked check-deploy: $b"
done

# ---- the site: config.js and the files ---------------------------------------------------------------
note "the site in $SITE"
[ -e /srv/http ] || made_srv=1
mkdir -p "$SITE"
touch "$SITE/.check-deploy"
files=(index.html jfsw.css grptable.js data.js jfsw.js sw.js sw.wasm)
for f in "${files[@]}"; do cp "$root/build-wasm/$f" "$SITE/"; done
cp "$root/testdata/swshare.grp" "$SITE/"
# the build's config.js with its settings (from "window.JFSW_CONFIG = {" to the end) replaced by the guide's
{ sed '/^window\.JFSW_CONFIG = {/,$d' "$root/build-wasm/config.js"; block site-config; } > "$SITE/config.js"
chmod a+rx /srv/http /srv/http/games; chmod -R a+rX "$SITE"
node -e 'global.window = {}; require(process.argv[1]); const c = window.JFSW_CONFIG; if (!c || !c.data) process.exit(1)' "$SITE/config.js" \
    && ok "the deployed config.js loads and sets window.JFSW_CONFIG" || bad "the deployed config.js does not load"
listed="$(sed -n '/^| File | About |/,/^$/p' "$guide" | grep -o '^| `[^`]*`\(, `[^`]*`\)*' | grep -o '`[^`]*`' | tr -d '`' | sort | tr '\n' ' ')"
want="$(printf '%s\n' "${files[@]}" config.js swshare.grp | sort | tr '\n' ' ')"
[ "$listed" = "$want" ] && ok "the guide lists exactly the files deployed here ($listed)" || bad "the guide's file list ($listed) is not the site's ($want)"
built="$(cd "$root/build-wasm" && ls | sort | tr '\n' ' ')"
want2="$(printf '%s\n' "${files[@]}" config.js | sort | tr '\n' ' ')"
[ "$built" = "$want2" ] && ok "build-wasm/ holds exactly those files (and nothing test-only)" || bad "build-wasm/ holds $built, the site needs $want2"

# ---- a self-signed certificate in Let's Encrypt's layout ---------------------------------------------
le="$w/le/live/$HOST"
mkdir -p "$le"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 \
    -keyout "$le/privkey.pem" -out "$le/fullchain.pem" -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST" -addext "basicConstraints=critical,CA:FALSE" 2>/dev/null \
    || die "openssl could not make a certificate"
spki="$(openssl x509 -in "$le/fullchain.pem" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)"
cacert=(--cacert "$le/fullchain.pem")

# ---- Apache ------------------------------------------------------------------------------------------
note "Apache ($("$httpd" -v | head -1 | sed 's/^Server version: //'))"
a="$w/httpd"
mkdir -p "$a/conf/extra" "$a/run" "$a/logs"
ln -s "$modules" "$a/modules"
types=/etc/mime.types; [ -f /etc/httpd/conf/mime.types ] && types=/etc/httpd/conf/mime.types
builtin="$("$httpd" -l)"
loadmod() { printf '%s\n' "$builtin" | grep -q "mod_$2.c" || echo "LoadModule $1 modules/mod_$2.so"; }
{
    echo "# Arch's httpd.conf in brief (what it loads and sets by default that the game needs), then the guide's lines."
    echo "ServerRoot \"$a\""
    echo "Listen 80"
    loadmod mpm_event_module mpm_event
    loadmod unixd_module unixd
    loadmod log_config_module log_config
    loadmod authz_core_module authz_core
    loadmod dir_module dir
    loadmod alias_module alias
    block httpd-modules
    echo "User $user"
    echo "Group $user"
    echo "ServerName localhost"
    echo "DefaultRuntimeDir \"$a/run\""
    echo "PidFile \"$a/run/httpd.pid\""
    echo "ErrorLog \"$a/logs/error_log\""
    echo "LogLevel warn"
    echo "LogFormat \"%h %l %u %t \\\"%r\\\" %>s %b\" common"
    echo "CustomLog \"$a/logs/access_log\" common"
    echo "TypesConfig $types"
    echo "DocumentRoot \"/srv/http\""
    echo "<Directory />"
    echo "    AllowOverride none"
    echo "    Require all denied"
    echo "</Directory>"
    echo "<Directory \"/srv/http\">"
    echo "    Options Indexes FollowSymLinks"
    echo "    AllowOverride None"
    echo "    Require all granted"
    echo "</Directory>"
    echo "DirectoryIndex index.html"
    echo "Include conf/extra/sw.conf"
} > "$a/conf/httpd.conf"
block apache-site | sed "s|/etc/letsencrypt/live/$HOST/|$le/|g; s|/var/run/httpd/|$a/run/|g" > "$a/conf/extra/sw.conf"
t="$("$httpd" -f "$a/conf/httpd.conf" -t 2>&1)"
expect "apachectl configtest: the guide's modules and sw.conf load" "$t" "Syntax OK"
"$httpd" -f "$a/conf/httpd.conf" -k start || die "Apache did not start: $(tail -5 "$a/logs/error_log" 2>/dev/null)"
for i in $(seq 1 50); do [ -f "$a/run/httpd.pid" ] && break; sleep 0.1; done
echo "127.0.0.1 $HOST # check-deploy" >> /etc/hosts; hosts_added=1

# ---- the relay ---------------------------------------------------------------------------------------
note "the relay"
rev="$(git -C "$root/ext/vnet" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cache="${JFSW_CACHE:-$HOME/.cache/jfsw-browser}"
bin="$cache/vnet-relay-$rev"
if [ ! -x "$bin" ]; then
    mkdir -p "$cache"
    ( cd "$root/ext/vnet/relay" && go build -o "$bin.tmp" ./cmd/vnet-relay ) || die "the relay did not build"
    mv "$bin.tmp" "$bin"
fi
cp "$bin" "$w/vnet-relay"; chmod 755 "$w/vnet-relay"
# the guide's cross-compile line for aarch64 (built only, not run)
if ( cd "$root/ext/vnet/relay" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o "$w/vnet-relay-arm64" ./cmd/vnet-relay ) 2>"$w/arm64.log"; then
    expect "the relay cross-compiles for aarch64" "$(file "$w/vnet-relay-arm64" 2>/dev/null || echo ELF)" "ARM aarch64|ELF"
else bad "the relay does not cross-compile for aarch64: $(tail -3 "$w/arm64.log")"; fi
if ! id vnet-relay >/dev/null 2>&1; then
    nologin=/usr/bin/nologin; [ -x "$nologin" ] || nologin=/usr/sbin/nologin
    useradd --system --no-create-home --shell "$nologin" vnet-relay && made_user=1 || die "useradd failed"
fi
[ -e /etc/vnet-relay ] || made_etc=1
block relay-cert-hook > "$w/vnet-relay-hook.sh"; chmod +x "$w/vnet-relay-hook.sh"
if RENEWED_LINEAGE="$le" "$w/vnet-relay-hook.sh"; then
    st="$(stat -c '%a %U:%G' /etc/vnet-relay/certs /etc/vnet-relay/certs/fullchain.pem /etc/vnet-relay/certs/privkey.pem 2>&1 | tr '\n' ' ')"
    expect "the certificate hook copies the certificate for vnet-relay ($st)" "$st" "^750 root:vnet-relay 644 root:vnet-relay 640 root:vnet-relay"
    setpriv --reuid vnet-relay --regid vnet-relay --init-groups cat /etc/vnet-relay/certs/privkey.pem >/dev/null 2>&1 \
        && ok "vnet-relay can read the key copy" || bad "vnet-relay cannot read /etc/vnet-relay/certs/privkey.pem"
else bad "the certificate hook failed"; fi
unit="$(block relay-unit)"
printf '%s\n' "$unit" | sed "s|/usr/local/bin/vnet-relay|$w/vnet-relay|" > "$w/vnet-relay.service"
if command -v systemd-analyze >/dev/null; then
    v="$(systemd-analyze verify "$w/vnet-relay.service" 2>&1)"
    [ -z "$(printf '%s\n' "$v" | grep -v -e '^$' -e 'Failed to open' -e 'not running' -e 'Failed to prepare filename' -e 'Unit .* not found' -e 'Failed to connect')" ] \
        && ok "systemd-analyze verify accepts the unit${v:+ (${v//$'\n'/; })}" || bad "systemd-analyze verify: $v"
else note "no systemd-analyze: the unit file is not verified"; fi
# ExecStart's flags (the continuation lines joined)
flags="$(printf '%s\n' "$unit" | awk '/^ExecStart=/ {on = 1} on { line = line " " $0; if ($0 !~ /\\$/) exit } END { print line }' \
    | sed 's/\\//g; s/^ *ExecStart=[^ ]*//')"
read -r -a flagv <<< "$flags"
note "vnet-relay${flags}"
caps=()
printf '%s\n' "$unit" | grep -q '^AmbientCapabilities=CAP_NET_BIND_SERVICE' && caps=(--inh-caps +net_bind_service --ambient-caps +net_bind_service)
nnp=(); printf '%s\n' "$unit" | grep -q '^NoNewPrivileges=yes' && nnp=(--no-new-privs)
setpriv --reuid vnet-relay --regid vnet-relay --init-groups "${caps[@]}" "${nnp[@]}" -- \
    "$w/vnet-relay" "${flagv[@]}" > "$w/relay.log" 2>&1 &
relay_pid=$!
for i in $(seq 1 50); do grep -q '^LISTEN' "$w/relay.log" && break; kill -0 "$relay_pid" 2>/dev/null || break; sleep 0.1; done
grep -q '^LISTEN' "$w/relay.log" && ok "the relay runs as vnet-relay: $(grep '^LISTEN' "$w/relay.log")" \
    || { bad "the relay did not start: $(tail -5 "$w/relay.log")"; exit 1; }
[ "$(stat -c %U /proc/$relay_pid)" = vnet-relay ] && ok "the relay's process belongs to vnet-relay" || bad "the relay runs as $(stat -c %U /proc/$relay_pid)"

# ---- the guide's curl checks -------------------------------------------------------------------------
note "the curl checks of the guide (section 6), with --cacert for the self-signed certificate"
base="https://$HOST/games/sw"
r="$(curl -sI "${cacert[@]}" -H 'Accept-Encoding: gzip' "$base/sw.wasm" | grep -iE '^HTTP|^cache-control|^content-type|^content-encoding')"
expect "sw.wasm: 200, no-cache, application/wasm, gzip" "$r" '^HTTP/1.1 200' '^Cache-Control: no-cache' '^Content-Type: application/wasm' '^Content-Encoding: gzip'
r="$(curl -sI "${cacert[@]}" -H 'Accept-Encoding: gzip' "$base/swshare.grp" | grep -iE '^HTTP|^etag|^cache-control|^content-type|^content-encoding')"
expect "swshare.grp: 200, an ETag, max-age=86400, application/octet-stream, gzip" "$r" '^HTTP/1.1 200' '^ETag: (W/)?"' '^Cache-Control: public, max-age=86400' '^Content-Type: application/octet-stream' '^Content-Encoding: gzip'
r="$(curl -s "${cacert[@]}" "$base/config.js" | grep -E '^ *(testMode|relay):')"
expect "config.js: testMode false and the relay wss://$HOST/vnet" "$r" "^ *testMode: false,$" "^ *relay: 'wss://$HOST/vnet',$"
ws() {  # ws ORIGIN: the first line of the answer to a WebSocket upgrade through Apache's /vnet
    curl -si --http1.1 -N --max-time 3 "${cacert[@]}" "https://$HOST/vnet" \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $1" | head -1
}
expect "the WebSocket upgrade through /vnet from the site's Origin: 101" "$(ws "https://$HOST")" '^HTTP/1.1 101 Switching Protocols'
expect "the same from another Origin: 403 (as the guide explains)" "$(ws https://other.example.org)" '^HTTP/1.1 403'
expect "healthz answers ok" "$(curl -s 127.0.0.1:8080/healthz)" '^ok'
expect "stats answers JSON" "$(curl -s 127.0.0.1:8081/stats)" '"webtransports":'
# further checks of what the guide's configuration says it does
r="$(curl -sI "http://$HOST/games/sw/?join=ABC234" | grep -iE '^HTTP|^location')"
expect "port 80 redirects to https, address kept" "$r" '^HTTP/1.1 301' "^Location: https://$HOST/games/sw/\?join=ABC234"
r="$(curl -sI "http://$HOST/.well-known/acme-challenge/x" | head -1)"
expect "port 80 serves the ACME challenge path itself (no redirect)" "$r" '^HTTP/1.1 404'
etag="$(curl -sI "${cacert[@]}" -H 'Accept-Encoding: gzip' "$base/sw.wasm" | sed -n 's/^ETag: //Ip' | tr -d '\r')"
r="$(curl -sI "${cacert[@]}" -H 'Accept-Encoding: gzip' -H "If-None-Match: $etag" "$base/sw.wasm" | head -1)"
expect "a browser revalidating sw.wasm (gzip, If-None-Match $etag) gets 304" "$r" '^HTTP/1.1 304'
r="$(curl -sI "${cacert[@]}" -H 'Accept-Encoding: gzip' "$base/" | grep -iE '^HTTP|^cache-control|^content-type')"
expect "the page: 200, no-cache, text/html" "$r" '^HTTP/1.1 200' '^Cache-Control: no-cache' '^Content-Type: text/html'
for f in jfsw.js sw.js config.js; do
    r="$(curl -sI "${cacert[@]}" "$base/$f" | grep -iE '^cache-control|^content-type')"
    expect "$f: no-cache, a JavaScript type" "$r" '^Cache-Control: no-cache' '^Content-Type: (text|application)/javascript'
done
r="$(curl -sI "${cacert[@]}" "$base/sw.wasm" | grep -iE '^cross-origin')"
[ -z "$r" ] && ok "no COOP/COEP headers are sent (none are needed)" || bad "unexpected headers: $r"
gz="$(curl -s "${cacert[@]}" -H 'Accept-Encoding: gzip' "$base/sw.wasm" | wc -c)"
ok "sw.wasm: $(stat -c %s "$SITE/sw.wasm") bytes, $gz with gzip"
crc="$(curl -s --compressed "${cacert[@]}" "$base/swshare.grp" | python3 -c 'import sys,zlib; d=sys.stdin.buffer.read(); print(len(d), hex(zlib.crc32(d)))')"
expect "data-hosting.md's download check: 26056769 bytes, crc 0x8a7fa1f" "$crc" '^26056769 0x8a7fa1f$'

# ---- the browsers and the desktop game ----------------------------------------------------------------
if [ "$quick" = 0 ]; then
    note "test-mode copy for the per-tic records: $TESTSITE (removed afterwards)"
    mkdir -p "$TESTSITE"
    for f in "${files[@]}" swshare.grp; do ln "$SITE/$f" "$TESTSITE/$f" 2>/dev/null || cp "$SITE/$f" "$TESTSITE/"; done
    sed 's/^\( *\)testMode: false,/\1testMode: true,/' "$SITE/config.js" > "$TESTSITE/config.js"
    chmod -R a+rX "$TESTSITE"
    DEPLOY_SPKI="$spki" DEPLOY_BASE="$base/" DEPLOY_TEST_BASE="https://$HOST/games/sw-test/" DEPLOY_RELAY_UDP="$HOST:7777" \
        DEPLOY_STATS="http://127.0.0.1:8081/stats" DEPLOY_WORK="$w/play" node "$root/tests/deploy/play.js"
    pst=$?
    rm -rf "$TESTSITE"
    [ "$pst" = 0 ] || bad "the browser and desktop checks (tests/deploy/play.js) failed: status $pst"
fi

# ---- the relay stopped: what Apache answers ------------------------------------------------------------
if [ "$keep" = 0 ]; then
    kill "$relay_pid" 2>/dev/null; wait "$relay_pid" 2>/dev/null; relay_pid=""
    expect "with the relay stopped, the WebSocket upgrade gets 503 (as the guide explains)" "$(ws "https://$HOST")" '^HTTP/1.1 503'
fi
w1="$(grep -ciE 'warn|error' "$a/logs/error_log" 2>/dev/null)"
note "Apache's error log: $w1 warning or error lines$( [ "$w1" -gt 0 ] && echo ": $(grep -iE 'warn|error' "$a/logs/error_log" | cut -c1-160 | sort | uniq -c | head -5 | tr '\n' ';')")"
note "relay log: $(grep -c . "$w/relay.log") lines; $(grep -c 'created' "$w/relay.log") rooms created"

if [ "$fails" = 0 ]; then echo "PASS"; exit 0; fi
echo "FAILED: $fails check(s)"; exit 1
