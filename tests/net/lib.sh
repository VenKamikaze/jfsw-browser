#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Shared helpers for the network tests (source this file).
#
#   * ports: every test listens on 127.0.0.1 only, in a range of its own above
#     $JFSW_TEST_PORT_BASE (default 47100; use 47000-47999);
#   * the vnet relay is built from ext/vnet/relay with Go (once, into
#     ~/.cache/jfsw-browser or $JFSW_CACHE) and run locally;
#   * every process a test starts is recorded and stopped on exit, however the
#     test ends.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${JFSW_CACHE:-$HOME/.cache/jfsw-browser}"
port_base="${JFSW_TEST_PORT_BASE:-47100}"
export PATH="$PATH:/usr/local/go/bin"

t_pids=()
t_tmp="$(mktemp -d "${TMPDIR:-/tmp}/jfsw-net.XXXXXX")" || exit 125
t_fail=0

t_cleanup() {
    local p i alive
    # TERM first: run-headless.sh then stops its game (SIGTERM, SIGKILL after
    # 5 s). Only after that, KILL what is left.
    for p in "${t_pids[@]:-}"; do
        [ -n "$p" ] && kill -TERM "$p" 2>/dev/null
    done
    for i in $(seq 1 80); do
        alive=0
        for p in "${t_pids[@]:-}"; do
            [ -n "$p" ] && kill -0 "$p" 2>/dev/null && alive=1
        done
        [ "$alive" = 0 ] && break
        sleep 0.1
    done
    for p in "${t_pids[@]:-}"; do
        [ -n "$p" ] && kill -KILL "$p" 2>/dev/null
    done
    if [ -z "${JFSW_TEST_KEEP:-}" ]; then rm -rf "$t_tmp"; else echo "kept: $t_tmp" >&2; fi
}
trap t_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

t_note() { echo "== $*"; }
t_ok()   { echo "ok:   $*"; }
t_bad()  { echo "FAIL: $*"; t_fail=$((t_fail + 1)); }

# t_check DESCRIPTION CONDITION-EXIT-STATUS: usage  t_check "text" test -f file
t_check() {
    local what="$1"; shift
    if "$@"; then t_ok "$what"; else t_bad "$what"; fi
}

# Build the relay once per vnet revision.
t_build_relay() {
    local rev bin
    rev="$(git -C "$root/ext/vnet" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    bin="$cache/vnet-relay-$rev"
    if [ ! -x "$bin" ]; then
        command -v go >/dev/null || { echo "go not found (need Go 1.24 or newer for ext/vnet/relay)" >&2; exit 125; }
        mkdir -p "$cache"
        ( cd "$root/ext/vnet/relay" && go build -o "$bin.tmp" ./cmd/vnet-relay ) >&2 || { echo "relay build failed" >&2; exit 125; }
        mv "$bin.tmp" "$bin"
    fi
    relay_bin="$bin"
}

# t_start_relay PORT [relay flags...]: sets relay_pid, log in $t_tmp/relay-PORT.log
t_start_relay() {
    local port="$1"; shift
    [ -n "${relay_bin:-}" ] || t_build_relay
    "$relay_bin" -udp "127.0.0.1:$port" -http "" -v "$@" > "$t_tmp/relay-$port.log" 2>&1 &
    relay_pid=$!
    t_pids+=("$relay_pid")
    local i
    for i in $(seq 1 50); do
        grep -q '^LISTEN' "$t_tmp/relay-$port.log" 2>/dev/null && return 0
        kill -0 "$relay_pid" 2>/dev/null || break
        sleep 0.1
    done
    echo "relay did not start on 127.0.0.1:$port:" >&2; cat "$t_tmp/relay-$port.log" >&2
    exit 125
}

# t_wait_for FILE REGEX SECONDS: 0 when REGEX appears in FILE
t_wait_for() {
    local f="$1" re="$2" secs="$3" i
    for i in $(seq 1 $((secs * 10))); do
        grep -Eq -- "$re" "$f" 2>/dev/null && return 0
        sleep 0.1
    done
    return 1
}

# t_wait_pid PID SECONDS: wait for a child of this shell to end. Prints its
# status in t_status, or 999 if it did not end in time (it is then killed).
t_wait_pid() {
    local pid="$1" secs="$2" i
    for i in $(seq 1 $((secs * 10))); do
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null; t_status=$?
            return 0
        fi
        sleep 0.1
    done
    kill -TERM "$pid" 2>/dev/null; sleep 0.5; kill -KILL "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    t_status=999
    return 1
}

# t_game NAME WORKDIR [run-headless options -- ] game args...:
# start a headless game in the background; sets game_pid; its stdout and
# stderr go to $t_tmp/NAME.out and its log is WORKDIR/sw.log.
t_game() {
    local name="$1" wd="$2"; shift 2
    local sw_opts=()
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do sw_opts+=("$1"); shift; done
    [ "${1:-}" = "--" ] && shift
    "$root/scripts/run-headless.sh" --workdir "$wd" "${sw_opts[@]}" "$@" > "$t_tmp/$name.out" 2>&1 &
    game_pid=$!
    t_pids+=("$game_pid")
}

t_need_data() {
    [ -f "$root/testdata/swshare.grp" ] || { echo "testdata/swshare.grp is missing: run scripts/fetch-test-data.sh" >&2; exit 125; }
    [ -x "${sw:-$root/sw}" ] || { echo "${sw:-$root/sw} is missing: run make" >&2; exit 125; }
}

t_result() {
    if [ "$t_fail" -eq 0 ]; then echo "PASS"; exit 0; fi
    echo "FAILED: $t_fail check(s)"; exit 1
}
