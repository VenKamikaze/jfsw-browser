#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Three headless game processes play a co-operative game (E1L1, shareware GRP)
# over the network and each quits by itself after N game tics. Passes when
# none of them logs a desync and all exit 0, and when enough sync checks were
# made.
#
#   tests/net/test-three-games.sh [options]
#
#   --relay          (default) through a local vnet relay: one process hosts
#                    a room for 3 (-net -relay 127.0.0.1:P -host-room 3), two
#                    join it by its room code
#   --udp            plain UDP (-net -nm:3 / -net -nm HOST:PORT), no relay:
#                    the existing path, which must keep working
#   --tics N         game tics to play (default 1800: about 30 s)
#   --players N      2 to 4 (default 3)
#   --sw FILE        the game binary (default ./sw)
#   --impair SPEC    vnet impairment on every process (--relay only), e.g.
#                    "loss=5,dup=2,reorder=5,lat=20,jit=10"; each process gets
#                    its own "seed=" (the player number + 1)
#   --nudge N:T      test-only: process N (0 = host) moves its player 8 units
#                    at tic T (-testnudge): a deliberate desync that must make
#                    this test FAIL
#
# What counts, from each process's sw.log: exit status 0; the line
#   TEST: quitting after T game tics: C sync checks, M mismatches, 8 sync bytes, player I of P
# with T at least N (a catching-up process plays a few tics in one go) and P
# equal to the player count; no "OUT OF SYNC"; no "CheckVersion()". Only the
# master compares sync bytes (net.c: slaves store but do not compare), so only
# its C counts: it must be at least N - 40 (one sync check per game tic; the
# last few are still in flight when the game quits).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode=relay; tics=1800; players=3; sw="$root/sw"; impair=""; nudge=""
while [ $# -gt 0 ]; do
    case "$1" in
        --relay) mode=relay; shift ;;
        --udp) mode=udp; shift ;;
        --tics) tics="$2"; shift 2 ;;
        --players) players="$2"; shift 2 ;;
        --sw) sw="$2"; shift 2 ;;
        --impair) impair="$2"; shift 2 ;;
        --nudge) nudge="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
t_need_data

rport=$((port_base + 20))
uport=$((port_base + 30))
auto="-autonet 2,0,2,1,0,0,0,0,0,0 -testsync -testquit$tics"
limit=$((tics / 20 + 60))      # seconds

t_note "$players-player coop game, $tics tics, $mode${impair:+, impairment $impair}${nudge:+, nudge $nudge}"

game_args() {   # player index -> args after "--"
    local n="$1" a="$auto"
    [ -n "$nudge" ] && [ "${nudge%%:*}" = "$n" ] && a="$a -testnudge${nudge##*:}"
    echo "$a"
}

pids=(); idx=""
if [ "$mode" = relay ]; then
    t_start_relay "$rport"
    wd0="$t_tmp/p0"
    VNET_IMPAIR="${impair:+$impair,seed=1}" t_game p0 "$wd0" --sw "$sw" --timeout "$limit" -- -net -relay "127.0.0.1:$rport" -host-room "$players" -- $(game_args 0)
    pids+=("$game_pid")
    t_wait_for "$wd0/sw.log" 'room code [A-Z0-9]{6}' 20 || { t_bad "the host never printed a room code"; cat "$t_tmp/p0.out"; t_result; }
    code="$(grep -o 'room code [A-Z0-9]*' "$wd0/sw.log" | head -1 | awk '{print $3}')"
    t_note "room code $code"
    for n in $(seq 1 $((players - 1))); do
        VNET_IMPAIR="${impair:+$impair,seed=$((n + 1))}" t_game "p$n" "$t_tmp/p$n" --sw "$sw" --timeout "$limit" -- -net -relay "127.0.0.1:$rport" -room "$code" -- $(game_args "$n")
        pids+=("$game_pid")
    done
else
    t_game p0 "$t_tmp/p0" --sw "$sw" --timeout "$limit" -- -net "-nm:$players" "-p$uport" -- $(game_args 0)
    pids+=("$game_pid")
    sleep 1
    for n in $(seq 1 $((players - 1))); do
        t_game "p$n" "$t_tmp/p$n" --sw "$sw" --timeout "$limit" -- -net -nm "-p$((uport + n))" "127.0.0.1:$uport" -- $(game_args "$n")
        pids+=("$game_pid")
    done
fi

for n in $(seq 0 $((players - 1))); do
    t_wait_pid "${pids[$n]}" $((limit + 10))
    st=$t_status
    log="$t_tmp/p$n/sw.log"
    t_check "player $n exited 0 (got $st)" test "$st" -eq 0
    line="$(grep -h '^TEST: quitting after' "$log" 2>/dev/null | tail -1)"
    reached="$(echo "$line" | sed -n 's/^TEST: quitting after \([0-9]*\) game tics:.* 8 sync bytes, player [0-9]* of '"$players"'$/\1/p')"
    idx="$idx $(echo "$line" | sed -n 's/.* player \([0-9]*\) of .*/\1/p')"
    t_check "player $n played ${reached:-?} tics (need $tics or more; ${line:-no TEST line})" test "${reached:-0}" -ge "$tics"
    t_check "player $n logged no desync" bash -c "! grep -q 'OUT OF SYNC' '$log' '$t_tmp/p$n.out'"
    t_check "player $n saw no version mismatch" bash -c "! grep -q 'CheckVersion()' '$log'"
done

idxs="$(echo $idx | tr ' ' '\n' | sort -n | tr '\n' ' ')"
t_check "the players are numbered $(seq -s ' ' 0 $((players - 1))) (got $idxs)" test "$idxs" = "$(seq -s ' ' 0 $((players - 1))) "
t_check "the host is player 0" grep -q 'player 0 of' "$t_tmp/p0/sw.log"

checks="$(grep -h '^TEST: quitting after' "$t_tmp/p0/sw.log" 2>/dev/null | sed -n 's/.*: \([0-9]*\) sync checks.*/\1/p')"
t_check "master made ${checks:-?} sync checks (need at least $((tics - 40)))" test "${checks:-0}" -ge $((tics - 40))
if [ "$mode" = relay ] && [ -n "$impair" ]; then
    t_note "(with impairment: the game ran its $tics tics through $impair)"
fi

if [ "$t_fail" -ne 0 ] && [ -n "${JFSW_TEST_VERBOSE:-}" ]; then
    for n in $(seq 0 $((players - 1))); do echo "---- p$n log"; grep -v "^$" "$t_tmp/p$n/sw.log" | tail -n 25; done
fi
t_result
