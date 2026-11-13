#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# End-to-end check of doco/browser/deploy.md (brief 06): follows the guide as far as a
# machine without a public host name allows, and plays through what it set up.
#
#   sudo tests/deploy/check-deploy.sh                 # everything (about 3 minutes): WebSocket, the guide's default
#   sudo tests/deploy/check-deploy.sh --wt            # with the guide's opt-in WebTransport section (bugs.md L31)
#   sudo tests/deploy/check-deploy.sh --no-tls        # the guide's "Without TLS": plain HTTP, ws://
#   sudo tests/deploy/check-deploy.sh --quick         # the set-up and the curl checks, no browsers
#   sudo tests/deploy/check-deploy.sh --guide FILE    # take the guide's blocks from another copy (the mutation runs)
#   sudo tests/deploy/check-deploy.sh --keep          # leave Apache, the relay and the files in place
#
# It needs root, Apache 2.4.58+ (Ubuntu's apache2 or Arch's httpd), openssl, curl, file, python3, setpriv,
# Go 1.24+, node with Playwright and its Chromium (never `playwright install`), and from the repository:
# build-wasm/ (scripts/build-wasm.sh), ./sw (make) and testdata/swshare.grp (scripts/fetch-test-data.sh).
# It is not part of `make test`.
#
# The guide's blocks are taken as they are: the fenced block after each "<!-- check-deploy: NAME -->".
#   rsync            the files deployed (the brace list and the other sources), checked against the guide's file
#                    table and build-wasm/;
#   site-config      the deployed config.js is the build's, with its settings replaced by this block;
#   httpd-modules, apache-site (apache-site-notls)
#                    a small Arch-layout httpd.conf of its own (ServerRoot in a temporary directory, the
#                    distribution's modules) that loads these lines and Includes sw.conf, with a self-signed
#                    certificate for game.example.org in Let's Encrypt's layout;
#   relay-build-server, relay-build
#                    the relay is built with the server line and cross-compiled for aarch64 with the PC line,
#                    from the working tree, into this run's directory (nothing cached);
#   relay-user, relay-unit (and with --wt relay-unit-wt, relay-cert-hook, relay-sysctl)
#                    the user is made with the guide's useradd line; the unit (and drop-in) go through
#                    `systemd-analyze verify`; its User=, Group= and hardening lines are checked; the relay runs
#                    as that user with the unit's flags, capabilities and NoNewPrivileges (setpriv; no systemd
#                    needed), and its HTTP and stats listeners must be on 127.0.0.1;
#   curl-checks, curl-server
#                    run as written (CURL_CA_BUNDLE trusts the test certificate), answers compared with the
#                    guide's (tests/deploy/run-block.py);
#   desktop-join     the desktop player's command, used by tests/deploy/play.js.
# Then play.js: the deployed page with ?test=1 (no hooks, ?args= unused); a game through the deployed page's lobby
# (two Chromium pages, ?host=3 and the invite link, and a native ./sw joining by code over UDP 7777); and a co-op
# game of the same three through a test-mode copy of the site (inside the game's directory, so under the guide's
# <Directory> settings, and there only while it runs) in which every machine's -testdump must agree on every tic.
#
# It changes the machine while it runs: game.example.org in /etc/hosts, the game in /srv/http/games/sw, the
# vnet-relay user, with --wt /etc/vnet-relay and two sysctl values; it uses the guide's own ports (TCP 80
# and 443, UDP 7777, with --wt UDP 443, 127.0.0.1:8080 and 8081), which must be free. It refuses to start if
# the hosts line, the site, the user or /etc/vnet-relay already exist, and on every exit it removes what it added,
# puts back the sysctl values and the modes of /srv/http and /srv/http/games, and stops Apache and the relay
# (unless --keep). Each check prints "ok:" or "FAIL:"; the script ends with PASS or FAILED.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guide="$root/doco/browser/deploy.md"
quick=0; keep=0; tls=1; wt=0
while [ $# -gt 0 ]; do
    case "$1" in
        --guide) guide="$(readlink -f "$2")"; shift 2 ;;
        --quick) quick=1; shift ;;
        --keep) keep=1; shift ;;
        --no-tls) tls=0; shift ;;
        --wt) wt=1; shift ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
[ "$wt" = 1 ] && [ "$tls" = 0 ] && { echo "--wt needs TLS: not with --no-tls" >&2; exit 2; }

HOST=game.example.org
SITE=/srv/http/games/sw
TESTSITE="$SITE/check-deploy-test"
sch=https; wsch=wss; site_block=apache-site
[ "$tls" = 0 ] && { sch=http; wsch=ws; site_block=apache-site-notls; }
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
for t in openssl curl file python3 setpriv node; do command -v "$t" >/dev/null || die "$t not found"; done
export PATH="$PATH:/usr/local/go/bin"
command -v go >/dev/null || die "go not found (Go 1.24 or newer, for the relay)"
# Everything here talks to this machine: no HTTP(S) proxy from the environment.
export no_proxy="$HOST,127.0.0.1,localhost${no_proxy:+,$no_proxy}" NO_PROXY="$HOST,127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
for f in build-wasm/sw.wasm build-wasm/sw.js sw testdata/swshare.grp; do [ -e "$root/$f" ] || die "$f is missing (see doco/browser/building.md)"; done
grep -q "$HOST" /etc/hosts && die "/etc/hosts already names $HOST; remove that line first"
[ -e "$SITE" ] && die "$SITE exists; remove it first (or it is left from a --keep run)"
# (S2) never reuse or overwrite a real relay set-up
id vnet-relay >/dev/null 2>&1 && die "a user vnet-relay exists (a real relay set-up?): this check makes and removes its own; run it on a machine without one"
[ -e /etc/vnet-relay ] && die "/etc/vnet-relay exists (a real relay's certificate copy?): this check makes and removes its own; run it on a machine without one"
inuse() {  # inuse tcp|udp HEXPORT [loopback]: is something listening there
    local f files=()
    for f in /proc/net/$1 /proc/net/${1}6; do [ -r "$f" ] && files+=("$f"); done
    awk -v p="$2" -v k="$1" 'FNR>1 && (k=="udp" || $4=="0A") && substr($2, index($2, ":")+1)==p {f=1} END {exit !f}' "${files[@]}"
}
for p in 0050 01BB 1F90 1F91; do inuse tcp "$p" && die "TCP port $((16#$p)) is in use"; done
for p in 1E61 $([ "$wt" = 1 ] && echo 01BB); do inuse udp "$p" && die "UDP port $((16#$p)) is in use"; done

w="$(mktemp -d "${TMPDIR:-/tmp}/jfsw-deploy.XXXXXX")" || die "mktemp failed"
chmod 755 "$w"
relay_pid=""; made_user=0; made_etc=0; hosts_added=0; sysctl_old=()
srv_mode="$(stat -c %a /srv/http 2>/dev/null)"; games_mode="$(stat -c %a /srv/http/games 2>/dev/null)"
cleanup() {
    if [ "$keep" = 1 ]; then
        echo "kept: Apache ($httpd -f $w/httpd/conf/httpd.conf), the relay (pid $relay_pid), $SITE, the $HOST line in /etc/hosts,"
        echo "      the vnet-relay user$([ "$made_etc" = 1 ] && echo ", /etc/vnet-relay")$([ ${#sysctl_old[@]} -gt 0 ] && echo ", the sysctl values (were: ${sysctl_old[*]})"), $w"
        echo "      stop them with: $httpd -f $w/httpd/conf/httpd.conf -k stop; kill $relay_pid; then remove the files and the user and put the sysctl values back"
        return
    fi
    [ -n "$relay_pid" ] && kill "$relay_pid" 2>/dev/null && wait "$relay_pid" 2>/dev/null
    if [ -f "$w/httpd/run/httpd.pid" ]; then
        "$httpd" -f "$w/httpd/conf/httpd.conf" -k stop 2>/dev/null
        local i; for i in $(seq 1 50); do [ -f "$w/httpd/run/httpd.pid" ] || break; sleep 0.1; done
    fi
    [ -f "$SITE/.check-deploy" ] && rm -rf "$SITE"
    if [ -z "$games_mode" ]; then rmdir /srv/http/games 2>/dev/null; else chmod "$games_mode" /srv/http/games 2>/dev/null; fi
    if [ -z "$srv_mode" ]; then rmdir /srv/http 2>/dev/null; else chmod "$srv_mode" /srv/http 2>/dev/null; fi
    [ "$hosts_added" = 1 ] && sed -i "/ $HOST # check-deploy\$/d" /etc/hosts
    local kv; for kv in "${sysctl_old[@]}"; do sysctl -q -w "$kv" >/dev/null 2>&1; done
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
need=(rsync site-config httpd-modules "$site_block" relay-build relay-build-server relay-user relay-unit curl-checks curl-server desktop-join)
[ "$wt" = 1 ] && need+=(relay-unit-wt relay-cert-hook relay-sysctl)
for b in "${need[@]}"; do [ -n "$(block "$b")" ] || die "the guide has no block marked check-deploy: $b"; done

# ---- the site: the files the rsync line copies, config.js -------------------------------------------
note "the site in $SITE"
rs="$(block rsync | awk '/^rsync / {on = 1} on { line = line " " $0; if ($0 !~ /\\$/) exit } END { print line }' | sed 's/\\//g')"
brace="$(printf '%s' "$rs" | grep -o 'build-wasm/{[^}]*}' | sed 's|build-wasm/{||; s|}||' | tr ',' '\n' | sort)"
others="$(printf '%s' "$rs" | tr ' ' '\n' | grep -v -e '^$' -e '^-' -e '^rsync$' -e '^build-wasm/' -e ':' | sed 's|.*/||' | sort)"
dest="$(printf '%s' "$rs" | tr ' ' '\n' | grep ':' | tail -1 | sed 's/^[^:]*://')"
printf '%s' "$rs" | grep -q -- '--delay-updates' && ok "the rsync line uses --delay-updates" || bad "the rsync line has no --delay-updates (a visitor can get a new sw.js with an old sw.wasm mid-copy)"
[ "${dest%/}" = "$SITE" ] && ok "the rsync line copies to $SITE/, the guide's site" || bad "the rsync line copies to $dest, not $SITE/"
copied="$(printf '%s\n%s\n' "$brace" "$others" | grep -v '^$' | sort | tr '\n' ' ')"
listed="$(sed -n '/^| File | About |/,/^$/p' "$guide" | grep -o '^| `[^`]*`\(, `[^`]*`\)*' | grep -o '`[^`]*`' | tr -d '`' | sort | tr '\n' ' ')"
built="$( (cd "$root/build-wasm" && ls; echo swshare.grp) | sort | tr '\n' ' ')"
[ "$copied" = "$listed" ] && ok "the rsync line copies exactly the guide's file table ($copied)" || bad "the rsync line copies [$copied], the file table lists [$listed]"
[ "$copied" = "$built" ] && ok "and exactly what the build makes (build-wasm/ and the GRP; nothing test-only)" || bad "the rsync line copies [$copied], build-wasm/ and the GRP are [$built]"
[ -n "$srv_mode" ] || mkdir -p /srv/http
[ -n "$games_mode" ] || mkdir -p /srv/http/games
mkdir -p "$SITE"
touch "$SITE/.check-deploy"
for f in $brace; do [ -f "$root/build-wasm/$f" ] && cp "$root/build-wasm/$f" "$SITE/" || bad "the rsync line names build-wasm/$f, which the build does not make"; done
for f in $others; do
    case "$f" in
        config.js) { sed '/^window\.JFSW_CONFIG = {/,$d' "$root/build-wasm/config.js"; block site-config; } > "$SITE/config.js" ;;
        swshare.grp) cp "$root/testdata/swshare.grp" "$SITE/" ;;
        *) bad "the rsync line copies $f, which this check does not know" ;;
    esac
done
# without TLS the guide says: relay: 'ws://game.example.org/vnet'
[ "$tls" = 0 ] && [ -f "$SITE/config.js" ] && sed -i "s|^\( *relay: \)'wss://$HOST/vnet',|\1'ws://$HOST/vnet',|" "$SITE/config.js"
chmod a+rx /srv/http /srv/http/games; chmod -R a+rX "$SITE"
node -e 'global.window = {}; require(process.argv[1]); const c = window.JFSW_CONFIG; if (!c || !c.data) process.exit(1)' "$SITE/config.js" 2>/dev/null \
    && ok "the deployed config.js loads and sets window.JFSW_CONFIG" || bad "the deployed config.js does not load"

# ---- a self-signed certificate in Let's Encrypt's layout ---------------------------------------------
le="$w/le/live/$HOST"
mkdir -p "$le"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 \
    -keyout "$le/privkey.pem" -out "$le/fullchain.pem" -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST" -addext "basicConstraints=critical,CA:FALSE" 2>/dev/null \
    || die "openssl could not make a certificate"
spki="$(openssl x509 -in "$le/fullchain.pem" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)"
cacert=(--cacert "$le/fullchain.pem")
export CURL_CA_BUNDLE="$le/fullchain.pem"      # so that the guide's curl lines run as written

# ---- Apache ------------------------------------------------------------------------------------------
note "Apache ($("$httpd" -v | head -1 | sed 's/^Server version: //'))"
a="$w/httpd"
mkdir -p "$a/conf/extra" "$a/run" "$a/logs"
ln -s "$modules" "$a/modules"
types=/etc/mime.types; [ -f /etc/httpd/conf/mime.types ] && types=/etc/httpd/conf/mime.types
builtin="$("$httpd" -l)"
loadmod() { printf '%s\n' "$builtin" | grep -q "mod_$2.c" || echo "LoadModule $1 modules/mod_$2.so"; }
{
    echo "# A small httpd.conf in Arch's layout: the modules the game needs besides the guide's lines, Arch's"
    echo "# <Directory \"/srv/http\"> (with Indexes), then the guide's module lines and Include of sw.conf."
    echo "ServerRoot \"$a\""
    echo "Listen 80"
    loadmod mpm_event_module mpm_event
    loadmod unixd_module unixd
    loadmod log_config_module log_config
    loadmod authz_core_module authz_core
    loadmod dir_module dir
    loadmod alias_module alias
    loadmod autoindex_module autoindex      # Arch loads it: without it a directory never lists, and -Indexes would go untested
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
block "$site_block" | sed "s|/etc/letsencrypt/live/$HOST/|$le/|g; s|/run/httpd/|$a/run/|g" > "$a/conf/extra/sw.conf"
t="$("$httpd" -f "$a/conf/httpd.conf" -t 2>&1)"
expect "apachectl configtest: the guide's modules and sw.conf load" "$t" "Syntax OK"
"$httpd" -f "$a/conf/httpd.conf" -k start || die "Apache did not start: $(tail -5 "$a/logs/error_log" 2>/dev/null)"
for i in $(seq 1 50); do [ -f "$a/run/httpd.pid" ] && break; sleep 0.1; done
echo "127.0.0.1 $HOST # check-deploy" >> /etc/hosts; hosts_added=1

# ---- the relay: built with the guide's lines ----------------------------------------------------------
note "the relay"
gobuild() {  # gobuild BLOCK OUT: the block's "go build" command (after any "cd ... &&"), its -o replaced, run in ext/vnet/relay
    local c
    c="$(block "$1" | grep 'go build' | head -1 | sed 's/^.*&& *//' | sed -E "s|-o [^ ]+|-o $2|")"
    [ -n "$c" ] || { bad "the guide's $1 block has no go build line"; return 1; }
    echo "   $c"
    ( cd "$root/ext/vnet/relay" && env $c ) > "$w/$1.log" 2>&1 || { bad "the guide's build line failed: $c: $(tail -3 "$w/$1.log")"; return 1; }
}
gobuild relay-build-server "$w/vnet-relay" || die "no relay to run"
expect "the server build line makes a static x86_64 binary" "$(file -b "$w/vnet-relay")" "x86-64|x86_64" "statically linked"
if gobuild relay-build "$w/vnet-relay-arm64"; then
    expect "the PC cross-compile line makes an aarch64 binary (built, not run)" "$(file -b "$w/vnet-relay-arm64")" "ELF 64-bit .*ARM aarch64" "statically linked"
fi
chmod 755 "$w/vnet-relay"
# the user, with the guide's useradd line (Ubuntu has no /usr/bin/nologin: the same line with its own then)
ua="$(block relay-user | grep '^sudo useradd ' | sed 's/^sudo //')"
ruser="${ua##* }"
[ -n "$ua" ] || die "the relay-user block has no useradd line"
if ! $ua 2>"$w/useradd.log"; then
    [ -x /usr/bin/nologin ] || ua="${ua//\/usr\/bin\/nologin//usr/sbin/nologin}"
    $ua || die "useradd failed: $ua: $(cat "$w/useradd.log")"
fi
made_user=1
ok "the user from the guide's line: $ruser"

# the unit (and with --wt the drop-in): what it says, systemd-analyze verify, then its command line
unit="$(block relay-unit)"
dropin=""; [ "$wt" = 1 ] && dropin="$(block relay-unit-wt)"
mkdir -p "$w/system/vnet-relay.service.d"
printf '%s\n' "$unit" | sed "s|/usr/local/bin/vnet-relay|$w/vnet-relay|" > "$w/system/vnet-relay.service"
[ -n "$dropin" ] && printf '%s\n' "$dropin" | sed "s|/usr/local/bin/vnet-relay|$w/vnet-relay|" > "$w/system/vnet-relay.service.d/webtransport.conf"
if command -v systemd-analyze >/dev/null; then
    v="$(cd "$w/system" && systemd-analyze verify "$w/system/vnet-relay.service" 2>&1)"
    [ -z "$(printf '%s\n' "$v" | grep -v -e '^$' -e 'Failed to open' -e 'not running' -e 'Failed to prepare filename' -e 'Unit .* not found' -e 'Failed to connect')" ] \
        && ok "systemd-analyze verify accepts the unit$([ -n "$dropin" ] && echo " and the drop-in")" || bad "systemd-analyze verify: $v"
else note "no systemd-analyze: the unit file is not verified"; fi
val() {  # val KEY: the effective value of KEY= in the unit with the drop-in after it ("" if never set)
    printf '%s\n%s\n' "$unit" "$dropin" | sed -n "s/^$1=//p" | tail -1
}
uuser="$(val User)"; ugroup="$(val Group)"
[ -n "$uuser" ] && [ "$uuser" != root ] && [ "$uuser" != 0 ] && [ "$uuser" = "$ruser" ] \
    && ok "the unit runs the relay as $uuser, the user the guide makes" || bad "the unit's User= is \"$uuser\": it must be the guide's own user ($ruser), never root"
[ -n "$ugroup" ] && [ "$ugroup" != root ] && [ "$ugroup" != 0 ] && ok "and group $ugroup" || bad "the unit's Group= is \"$ugroup\""
for kv in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes PrivateDevices=yes; do
    [ "$(val "${kv%%=*}")" = "${kv#*=}" ] && ok "the unit has $kv" || bad "the unit has ${kv%%=*}=$(val "${kv%%=*}"), not ${kv#*=}"
done
capb="$(val CapabilityBoundingSet)"; capa="$(val AmbientCapabilities)"
if [ "$wt" = 1 ]; then
    [ "$capb" = CAP_NET_BIND_SERVICE ] && [ "$capa" = CAP_NET_BIND_SERVICE ] && ok "with the drop-in: CAP_NET_BIND_SERVICE only (for UDP 443)" \
        || bad "with the drop-in, the capabilities are bounding \"$capb\", ambient \"$capa\" (want CAP_NET_BIND_SERVICE only)"
else
    [ -z "$capb" ] && [ -z "$capa" ] && printf '%s\n' "$unit" | grep -q '^CapabilityBoundingSet=$' && ok "the unit gives the relay no capabilities" \
        || bad "the unit's capabilities: bounding \"$capb\", ambient \"$capa\" (want none: CapabilityBoundingSet= empty)"
fi
# ExecStart: the last one set (a drop-in clears it with an empty ExecStart= first), continuation lines joined
flags="$(printf '%s\n%s\n' "$unit" "$dropin" | awk '/^ExecStart=./ {line = ""; on = 1} on { line = line " " $0; if ($0 !~ /\\$/) { last = line; on = 0 } } END { print last }' \
    | sed 's/\\//g; s/^ *ExecStart=[^ ]*//')"
read -r -a flagv <<< "$flags"
note "vnet-relay${flags}"
[ "$wt" = 1 ] && ! printf '%s' "$flags" | grep -q -- ' -wt ' && bad "the drop-in's command line has no -wt"
[ "$wt" = 0 ] && printf '%s' "$flags" | grep -q -- ' -wt' && bad "the default unit has -wt: the guide's default is WebSocket only (L31)"

if [ "$wt" = 1 ]; then
    [ -e /etc/vnet-relay ] || made_etc=1
    block relay-cert-hook > "$w/vnet-relay-hook.sh"; chmod +x "$w/vnet-relay-hook.sh"
    # (S3) another site's renewal must not install its certificate for the relay
    mkdir -p "$w/le/live/other.example.org"; cp "$le"/*.pem "$w/le/live/other.example.org/"
    RENEWED_LINEAGE="$w/le/live/other.example.org" "$w/vnet-relay-hook.sh"
    [ ! -e /etc/vnet-relay/certs ] && ok "the certificate hook ignores another site's renewal (other.example.org)" || bad "the certificate hook copied another site's certificate"
    if RENEWED_LINEAGE="$le" "$w/vnet-relay-hook.sh"; then
        st="$(stat -c '%a %U:%G' /etc/vnet-relay/certs /etc/vnet-relay/certs/fullchain.pem /etc/vnet-relay/certs/privkey.pem 2>&1 | tr '\n' ' ')"
        expect "the certificate hook copies the game's certificate for $ugroup ($st)" "$st" "^750 root:$ugroup 644 root:$ugroup 640 root:$ugroup"
        setpriv --reuid "$uuser" --regid "$ugroup" --init-groups cat /etc/vnet-relay/certs/privkey.pem >/dev/null 2>&1 \
            && ok "$uuser can read the key copy" || bad "$uuser cannot read /etc/vnet-relay/certs/privkey.pem"
    else bad "the certificate hook failed"; fi
    # the UDP buffers for QUIC: the file must be one sysctl --system reads; the values set with sysctl -w for the run
    sf="$(block relay-sysctl | grep -o 'tee [^ ]*' | head -1 | sed 's/^tee //')"
    [[ "$sf" == /etc/sysctl.d/*.conf ]] && ok "the sysctl file $sf is one sysctl --system reads (/etc/sysctl.d/*.conf)" || bad "the sysctl file \"$sf\" is not /etc/sysctl.d/*.conf: sysctl --system would ignore it"
    for kv in $(block relay-sysctl | grep -o 'net\.core\.[a-z_]*=[0-9]*'); do
        old="$(sysctl -n "${kv%%=*}" 2>/dev/null)" && sysctl_old+=("${kv%%=*}=$old")
        sysctl -q -w "$kv" >/dev/null 2>&1 && [ "$(sysctl -n "${kv%%=*}")" = "${kv#*=}" ] && ok "sysctl $kv (was $old)" || bad "sysctl -w $kv failed"
    done
fi

caps=(--bounding-set -all)
[ -n "$capb" ] && caps=(--bounding-set "-all,+$(printf '%s' "$capb" | tr 'A-Z' 'a-z' | sed 's/cap_//g; s/ /,+/g')")
[ -n "$capa" ] && caps+=(--inh-caps "+$(printf '%s' "$capa" | tr 'A-Z' 'a-z' | sed 's/cap_//g')" --ambient-caps "+$(printf '%s' "$capa" | tr 'A-Z' 'a-z' | sed 's/cap_//g')")
nnp=(); [ "$(val NoNewPrivileges)" = yes ] && nnp=(--no-new-privs)
setpriv --reuid "$uuser" --regid "$ugroup" --init-groups "${caps[@]}" "${nnp[@]}" -- \
    "$w/vnet-relay" "${flagv[@]}" > "$w/relay.log" 2>&1 &
relay_pid=$!
for i in $(seq 1 50); do grep -q '^LISTEN' "$w/relay.log" && break; kill -0 "$relay_pid" 2>/dev/null || break; sleep 0.1; done
listen="$(grep '^LISTEN' "$w/relay.log")"
[ -n "$listen" ] && ok "the relay runs: $listen" || { bad "the relay did not start: $(tail -5 "$w/relay.log")"; exit 1; }
[ "$(stat -c %U /proc/$relay_pid)" = "$uuser" ] && ok "the relay's process belongs to $uuser" || bad "the relay runs as $(stat -c %U /proc/$relay_pid)"
# (S1) what the internet can reach
if printf '%s' "$flags" | grep -q -- '-trust-forwarded-for'; then
    printf '%s' "$listen" | grep -q ' http=127\.0\.0\.1:' && ok "with -trust-forwarded-for, the HTTP listener is on 127.0.0.1 (only Apache reaches it)" \
        || bad "the relay trusts X-Forwarded-For on a listener the internet can reach ($(printf '%s' "$listen" | grep -o 'http=[^ ]*')): anyone could claim any address"
fi
if printf '%s' "$listen" | grep -q ' stats=[^ ]'; then
    printf '%s' "$listen" | grep -q ' stats=127\.0\.0\.1:' && ok "the stats listener is on 127.0.0.1" || bad "the stats listener is public ($(printf '%s' "$listen" | grep -o 'stats=[^ ]*'))"
fi

# ---- the guide's curl checks, as written -------------------------------------------------------------
note "the curl checks of the guide (section 6), as written ($sch)"
subs=(); [ "$tls" = 0 ] && subs=("https://$HOST" "http://$HOST" "wss://$HOST" "ws://$HOST")
if block curl-checks | python3 "$root/tests/deploy/run-block.py" "${subs[@]}"; then ok "every curl check of the guide gives the answer it says"; else bad "the guide's curl checks (above)"; fi
if block curl-server | python3 "$root/tests/deploy/run-block.py"; then ok "the server's own checks (healthz, stats) give the answers given"; else bad "the guide's server checks (above)"; fi
note "more checks of what the guide says the configuration does"
base="$sch://$HOST/games/sw"
ws() {  # ws ORIGIN: the first line of the answer to a WebSocket upgrade through Apache's /vnet
    curl -si --http1.1 -N --max-time 3 "$sch://$HOST/vnet" \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $1" | head -1
}
expect "a WebSocket upgrade from another Origin: 403 (as the guide explains)" "$(ws $sch://other.example.org)" '^HTTP/1.1 403'
if [ "$tls" = 1 ]; then
    r="$(curl -sI "http://$HOST/games/sw/?join=ABC234" | grep -iE '^HTTP|^location')"
    expect "port 80 redirects to https, address kept" "$r" '^HTTP/1.1 301' "^Location: https://$HOST/games/sw/\?join=ABC234"
    r="$(curl -sI "http://$HOST/.well-known/acme-challenge/x" | head -1)"
    expect "port 80 serves the ACME challenge path itself (no redirect)" "$r" '^HTTP/1.1 404'
fi
etag="$(curl -sI -H 'Accept-Encoding: gzip' "$base/sw.wasm" | sed -n 's/^ETag: //Ip' | tr -d '\r')"
r="$(curl -sI -H 'Accept-Encoding: gzip' -H "If-None-Match: $etag" "$base/sw.wasm" | head -1)"
expect "a browser revalidating sw.wasm (gzip, If-None-Match $etag) gets 304" "$r" '^HTTP/1.1 304'
r="$(curl -sI -H 'Accept-Encoding: gzip' "$base/" | grep -iE '^HTTP|^cache-control|^content-type')"
expect "the page: 200, no-cache, text/html" "$r" '^HTTP/1.1 200' '^Cache-Control: no-cache' '^Content-Type: text/html'
for f in jfsw.js sw.js config.js data.js grptable.js jfsw.css; do
    r="$(curl -sI "$base/$f" | grep -iE '^HTTP|^cache-control|^content-type')"
    expect "$f: 200, no-cache, its type" "$r" '^HTTP/1.1 200' '^Cache-Control: no-cache' '^Content-Type: (text/javascript|application/javascript|text/css)'
done
mkdir -m 755 "$SITE/check-deploy-listing"
expect "no directory listings in the game's directory (Options -Indexes)" "$(curl -sI "$base/check-deploy-listing/" | head -1)" '^HTTP/1.1 403'
rmdir "$SITE/check-deploy-listing"
r="$(curl -sI "$base/sw.wasm" | grep -iE '^cross-origin')"
[ -z "$r" ] && ok "no COOP/COEP headers are sent (none are needed)" || bad "unexpected headers: $r"
gz="$(curl -s -H 'Accept-Encoding: gzip' "$base/sw.wasm" | wc -c)"
ok "sw.wasm: $(stat -c %s "$SITE/sw.wasm") bytes, $gz with gzip"
crc="$(curl -s --compressed "$base/swshare.grp" | python3 -c 'import sys,zlib; d=sys.stdin.buffer.read(); print(len(d), hex(zlib.crc32(d)))')"
expect "data-hosting.md's download check: 26056769 bytes, crc 0x8a7fa1f" "$crc" '^26056769 0x8a7fa1f$'

# ---- the browsers and the desktop game ----------------------------------------------------------------
if [ "$quick" = 0 ]; then
    join="$(block desktop-join | grep -- ' -room CODE' | head -1 | sed 's/#.*//; s/^ *\.\/sw *//')"
    [ -n "$join" ] && ok "the desktop player's command from the guide: ./sw $join" || bad "the guide's desktop-join block has no ./sw ... -room CODE line"
    note "test-mode copy for the per-tic records: $TESTSITE (inside the game's directory, under the guide's settings; removed afterwards)"
    mkdir -p "$TESTSITE"
    for f in $brace swshare.grp; do ln "$SITE/$f" "$TESTSITE/$f" 2>/dev/null || cp "$SITE/$f" "$TESTSITE/"; done
    sed 's/^\( *\)testMode: false,/\1testMode: true,/' "$SITE/config.js" > "$TESTSITE/config.js"
    chmod -R a+rX "$TESTSITE"
    DEPLOY_SPKI="$spki" DEPLOY_BASE="$base/" DEPLOY_TEST_BASE="$base/check-deploy-test/" DEPLOY_DESKTOP_JOIN="$join" \
        DEPLOY_TRANSPORT="$([ "$wt" = 1 ] && echo relay-wt || echo relay-ws)" \
        DEPLOY_STATS="http://127.0.0.1:8081/stats" DEPLOY_WORK="$w/play" node "$root/tests/deploy/play.js"
    pst=$?
    rm -rf "$TESTSITE"
    [ "$pst" = 0 ] || bad "the browser and desktop checks (tests/deploy/play.js) failed: status $pst"
fi

# ---- the relay stopped: what Apache answers ------------------------------------------------------------
if [ "$keep" = 0 ]; then
    kill "$relay_pid" 2>/dev/null; wait "$relay_pid" 2>/dev/null; relay_pid=""
    expect "with the relay stopped, the WebSocket upgrade gets 503 (as the guide explains)" "$(ws "$sch://$HOST")" '^HTTP/1.1 503'
fi
w1="$(grep -ciE 'warn|error' "$a/logs/error_log" 2>/dev/null)"
note "Apache's error log: $w1 warning or error lines$( [ "$w1" -gt 0 ] && echo ": $(grep -iE 'warn|error' "$a/logs/error_log" | cut -c1-160 | sort | uniq -c | head -5 | tr '\n' ';')")"
note "relay log: $(grep -c . "$w/relay.log") lines; $(grep -c 'created' "$w/relay.log") rooms created"
if [ "$wt" = 1 ]; then
    grep -qi 'buffer size' "$w/relay.log" && bad "the relay's QUIC warns about its UDP buffers: $(grep -i 'buffer size' "$w/relay.log" | head -1)" || ok "the relay's QUIC got its UDP buffers (no buffer-size warning in its log)"
fi

if [ "$fails" = 0 ]; then echo "PASS"; exit 0; fi
echo "FAILED: $fails check(s)"; exit 1
