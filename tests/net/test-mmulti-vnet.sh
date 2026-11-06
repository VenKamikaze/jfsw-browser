#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Test 1: mmulti over vnet with network impairment, without the game.
#
# Three tests/net/mmulti_peer processes (mmulti.c + mmulti_vnet.c + vnet, no
# game; only the mmulti.h API) play master and two slaves through a local vnet
# relay (127.0.0.1 only), each with its own vnet impairment (loss, duplication,
# reordering, latency, jitter; own seed). They exchange numbered packets and
# check that every packet arrived exactly once, in order, intact and from the
# right player; and that all three agree on numplayers, myconnectindex and the
# connecthead/connectpoint2 chain.
#
#   tests/net/test-mmulti-vnet.sh [options]
#
#   --runs N         repeat N times (default 1); run K uses seeds
#                    SEED-BASE+3K .. SEED-BASE+3K+2, so a run can be repeated
#   --count N        packets each way (default 150)
#   --impair SPEC    vnet impairment (default "loss=8,dup=5,reorder=8,rdelay=60,lat=15,jit=10")
#   --seed-base N    default 100
#   --stub-resend    for the "does it fail without the change" proof: build the
#                    peers with mmulti's resend logic stubbed out (each packet
#                    is sent once and never repeated): the test must FAIL
#   --no-impair      no impairment (the connection itself still goes through the relay)
#
# Why three processes on a local relay (and not three copies of mmulti in one
# process on vnet's loopback backend): mmulti keeps its state in globals, so
# three copies need renamed globals, which means building a modified mmulti.c;
# the processes use the real object code, the real relay (rooms, addresses,
# its UDP framing) and vnet's impairment on each process's sends. What is
# given up is exact repeatability: the seeds fix each process's loss pattern
# per send, but when the sends happen depends on timing, so a run cannot be
# replayed bit for bit. The checks do not depend on the pattern.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

runs=1; count=150; impair="loss=8,dup=5,reorder=8,rdelay=60,lat=15,jit=10"; seedbase=100; stub=""
while [ $# -gt 0 ]; do
    case "$1" in
        --runs) runs="$2"; shift 2 ;;
        --count) count="$2"; shift 2 ;;
        --impair) impair="$2"; shift 2 ;;
        --no-impair) impair=""; shift ;;
        --seed-base) seedbase="$2"; shift 2 ;;
        --stub-resend) stub=1; shift ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done

[ -f "$root/jfbuild/libengine.a" ] || { echo "jfbuild/libengine.a is missing: run make" >&2; exit 125; }
build_peer() {   # output [mmulti.c to use instead] [extra cc flags]
    local out="$1" src="${2:-}" flags="${3:-}"
    local srcs=("$root/tests/net/mmulti_peer.c")
    [ -n "$src" ] && srcs+=("$src")
    cc -std=gnu99 -O2 -Wall -Wextra $flags -I"$root/jfbuild/include" -I"$root/jfbuild/src" -o "$out" "${srcs[@]}" "$root/jfbuild/libengine.a" -lm || { echo "building the peer failed" >&2; exit 125; }
}

if [ -n "$stub" ]; then
    # one transmission per packet: mark it acknowledged as soon as it is packed
    python3 -I - "$root/jfbuild/src/mmulti.c" "$t_tmp/mmulti_noresend.c" <<'PY' || { echo "cannot stub the resend logic" >&2; exit 125; }
import sys
s = open(sys.argv[1]).read()
needle = "memcpy(&pakbuf[k],&pakmem[opak[other][i&(FIFSIZ-1)]+2],j); k += j;"
assert s.count(needle) == 1
s = s.replace(needle, needle + " opak[other][i&(FIFSIZ-1)] = 0; /* STUB: never resend */")
open(sys.argv[2], "w").write(s)
PY
    build_peer "$t_tmp/peer" "$t_tmp/mmulti_noresend.c" "-DHARNESS_VNET -I$root/jfbuild/src"
    t_note "resend logic stubbed out (expecting FAIL)"
else
    build_peer "$t_tmp/peer" "" "-DHARNESS_VNET"
fi

t_build_relay
rport=$((port_base + 10))
t_start_relay "$rport"

for run in $(seq 0 $((runs - 1))); do
    s0=$((seedbase + 3 * run))
    t_note "run $((run + 1)) of $runs: $count packets each way, ${impair:-no impairment}, seeds $s0 $((s0 + 1)) $((s0 + 2))"
    out="$t_tmp/run$run"; mkdir -p "$out"
    imp() { [ -n "$impair" ] && echo "$impair,seed=$1"; }

    VNET_IMPAIR="$(imp $s0)" "$t_tmp/peer" "$count" 90 -relay "127.0.0.1:$rport" -host-room 3 > "$out/p0.txt" 2>&1 &
    p0=$!; t_pids+=("$p0")
    if ! t_wait_for "$out/p0.txt" 'room code [A-Z0-9]{6}' 20; then t_bad "run $run: the master printed no room code"; cat "$out/p0.txt"; continue; fi
    code="$(grep -o 'room code [A-Z0-9]*' "$out/p0.txt" | head -1 | awk '{print $3}')"
    VNET_IMPAIR="$(imp $((s0 + 1)))" "$t_tmp/peer" "$count" 90 -relay "127.0.0.1:$rport" -room "$code" > "$out/p1.txt" 2>&1 &
    p1=$!; t_pids+=("$p1")
    VNET_IMPAIR="$(imp $((s0 + 2)))" "$t_tmp/peer" "$count" 90 -relay "127.0.0.1:$rport" -room "$code" > "$out/p2.txt" 2>&1 &
    p2=$!; t_pids+=("$p2")

    t_wait_pid "$p0" 100; s_0=$t_status
    t_wait_pid "$p1" 100; s_1=$t_status
    t_wait_pid "$p2" 100; s_2=$t_status

    ok=1
    for n in 0 1 2; do
        st=$(eval echo \$s_$n)
        res="$(grep -h '^RESULT' "$out/p$n.txt" | tail -1)"
        if [ "$st" -ne 0 ] || [ "${res#RESULT ok}" = "$res" ]; then
            t_bad "run $((run + 1)) player process $n: exit $st, ${res:-no RESULT line}"; ok=0
        fi
    done
    if [ "$ok" = 1 ]; then
        # agreement: numplayers, the chain, distinct indexes 0..2
        agree="$(for n in 0 1 2; do grep -h '^RESULT ok' "$out/p$n.txt" | sed 's/.*numplayers=\([0-9]*\) connecthead=\([0-9]*\) chain=\([0-9>]*\).*/\1 \2 \3/'; done | sort -u | wc -l)"
        idx="$(for n in 0 1 2; do grep -h '^RESULT ok' "$out/p$n.txt" | sed 's/.*index=\([0-9]*\) .*/\1/'; done | sort -n | tr '\n' ' ')"
        t_check "run $((run + 1)): all three agree on numplayers, connecthead and the chain ($(grep -h '^RESULT ok' "$out/p0.txt" | sed 's/.*numplayers/numplayers/;s/ sent.*//'))" test "$agree" -eq 1
        t_check "run $((run + 1)): indexes are 0 1 2 (got $idx)" test "$idx" = "0 1 2 "
        t_ok "run $((run + 1)): every packet arrived once, in order, intact ($(grep -h "^RESULT ok" "$out/p0.txt" | sed "s/.*sent=/sent=/"))"
    fi
done
[ "$t_fail" -eq 0 ] && t_note "$runs run(s), all packets delivered exactly once and in order"
t_result
