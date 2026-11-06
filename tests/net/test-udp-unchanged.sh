#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Test 3: plain UDP (-net, no relay) is unchanged.
#
#   tests/net/test-udp-unchanged.sh --base-sw FILE [--mutate-wire]
#
# --mutate-wire (for the "does it bite" proof): the old mmulti.c is changed to
# answer a slave's first contact with another byte (0xac for 0xab), which the
# new one cannot understand, and only part A is run: the combinations that mix
# old and new must fail.
#
# FILE is the game as it was before this work (tests/net/build-baseline.sh
# builds it and prints the path). Neither part needs anything but the shareware
# GRP (testdata/swshare.grp) and a built ./sw.
#
# A. The mmulti layer alone (tests/net/mmulti_peer.c), over plain UDP on
#    127.0.0.1, three players, every combination of the old mmulti.c (the
#    commit before this work) and the new one in the master and the slaves:
#    all new, all old, old master with new slaves, new master with old slaves.
#    Each must pass the same packet exchange as test 1 (without impairment:
#    plain UDP has none). That is the wire format and the start-up handshake.
# B. The game, three processes over -net on 127.0.0.1, co-operative, left to
#    run for 45 s: with the old binary and with the new one. Both must start
#    the game on all three (exit 124 = stopped by the time limit, not a crash; a game that is still waiting for the others at the start of the level when SIGTERM comes exits 0 instead, which means the time limit was too short for this machine)
#    and print the same mmulti lines once the order of "Player N is here" is
#    ignored. Then the old master with two new slaves, and the new master with
#    two old slaves, which play 600 tics (the new side quits by itself).
#    The three-process test with the new binary alone over UDP and its sync
#    check is tests/net/test-three-games.sh --udp.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

base_sw=""; mutate=""
while [ $# -gt 0 ]; do
    case "$1" in
        --base-sw) base_sw="$2"; shift 2 ;;
        --mutate-wire) mutate=1; shift ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
[ -x "$base_sw" ] || { echo "--base-sw FILE is needed (tests/net/build-baseline.sh)" >&2; exit 125; }
[ -f "$root/jfbuild/libengine.a" ] || { echo "jfbuild/libengine.a is missing: run make" >&2; exit 125; }
t_need_data

# ---- A ----
basedir="$(dirname "$base_sw")"
basesha="$(git -C "$basedir/jfbuild" rev-parse HEAD)"
git -C "$basedir/jfbuild" show "$basesha:src/mmulti.c" > "$t_tmp/mmulti_old.c" || { echo "cannot read the old mmulti.c" >&2; exit 125; }
if [ -n "$mutate" ]; then
    grep -q 'pakbuf\[k++\] = 0xab;' "$t_tmp/mmulti_old.c" || { echo "mutation does not apply" >&2; exit 125; }
    sed -i 's/pakbuf\[k++\] = 0xab;/pakbuf[k++] = 0xac;/' "$t_tmp/mmulti_old.c"
fi
cc -std=gnu99 -O2 -Wall -I"$root/jfbuild/include" -I"$root/jfbuild/src" -o "$t_tmp/peer_old" "$root/tests/net/mmulti_peer.c" "$t_tmp/mmulti_old.c" -lm || exit 125
cc -std=gnu99 -O2 -Wall -DHARNESS_VNET -I"$root/jfbuild/include" -o "$t_tmp/peer_new" "$root/tests/net/mmulti_peer.c" "$root/jfbuild/libengine.a" -lm || exit 125

uport=$((port_base + 40))

# combo MASTER-VERSION SLAVE1-VERSION SLAVE2-VERSION  (each "old" or "new")
combo() {
    local v0="$1" v1="$2" v2="$3" out="$t_tmp/combo-$1-$2-$3" st n
    local vs=("$v0" "$v1" "$v2") ps=()
    mkdir -p "$out"
    "$t_tmp/peer_$v0" 150 60 -nm:3 "-p$uport" > "$out/p0.txt" 2>&1 &
    ps+=("$!"); t_pids+=("$!")
    sleep 0.5
    "$t_tmp/peer_$v1" 150 60 -nm "-p$((uport + 1))" "127.0.0.1:$uport" > "$out/p1.txt" 2>&1 &
    ps+=("$!"); t_pids+=("$!")
    "$t_tmp/peer_$v2" 150 60 -nm "-p$((uport + 2))" "127.0.0.1:$uport" > "$out/p2.txt" 2>&1 &
    ps+=("$!"); t_pids+=("$!")
    local ok=1
    for n in 0 1 2; do
        t_wait_pid "${ps[$n]}" 80; st=$t_status
        if ! { grep -q '^RESULT ok' "$out/p$n.txt" && [ "$st" -eq 0 ]; }; then
            ok=0
            echo "  process $n (${vs[$n]}): exit $st, $(grep -h '^RESULT' "$out/p$n.txt" | tail -1)"
        fi
    done
    if [ "$ok" = 1 ]; then
        t_ok "UDP, master $v0, slaves $v1 and $v2: 150 packets each way exchanged, in order, intact"
    else
        t_bad "UDP, master $v0, slaves $v1 and $v2"
    fi
}
t_note "A. mmulti over plain UDP, old and new mmulti.c"
combo new new new
combo old old old
combo old new new
combo new old old

[ -n "$mutate" ] && t_result

# ---- B ----
t_note "B. the game over -net on 127.0.0.1"
auto="-autonet 2,0,2,1,0,0,0,0,0,0"

# game3 TAG SW0 SW1 SW2 SECONDS extra-game-args...: sets st[0..2]
game3() {
    local tag="$1" secs="$5" n
    local sws=("$2" "$3" "$4") gp=()
    shift 5
    t_game "$tag-0" "$t_tmp/$tag-0" --sw "${sws[0]}" --timeout "$secs" -- -net -nm:3 "-p$uport" -- $auto "$@"
    gp+=("$game_pid")
    sleep 1
    for n in 1 2; do
        t_game "$tag-$n" "$t_tmp/$tag-$n" --sw "${sws[$n]}" --timeout "$secs" -- -net -nm "-p$((uport + n))" "127.0.0.1:$uport" -- $auto "$@"
        gp+=("$game_pid")
    done
    st=()
    for n in 0 1 2; do
        t_wait_pid "${gp[$n]}" $((secs + 20))
        st+=("$t_status")
    done
}
mm() { grep -h '^mmulti:' "$1/sw.log" | sed 's/Player [0-9]* is here/Player N is here/' | sort | uniq -c; }

game3 old "$base_sw" "$base_sw" "$base_sw" 45
for n in 0 1 2; do t_check "old binary, process $n ran until stopped (exit ${st[$n]}, want 124)" test "${st[$n]}" -eq 124; done
game3 new "$root/sw" "$root/sw" "$root/sw" 45
for n in 0 1 2; do t_check "new binary, process $n ran until stopped (exit ${st[$n]}, want 124)" test "${st[$n]}" -eq 124; done
for n in 0 1 2; do
    t_check "process $n prints the same mmulti lines with the old and the new binary" test "$(mm "$t_tmp/old-$n")" = "$(mm "$t_tmp/new-$n")"
    t_check "process $n printed mmulti lines at all" test -n "$(mm "$t_tmp/new-$n")"
    t_check "process $n started the game (old and new)" bash -c "grep -q 'Loading sound and graphics' '$t_tmp/old-$n/sw.log' && grep -q 'Loading sound and graphics' '$t_tmp/new-$n/sw.log'"
done
t_check "the master saw both players join (old)" test "$(grep -c 'mmulti: Player [12] is here' "$t_tmp/old-0/sw.log")" -eq 2

# Mixed: the side that is new quits after 600 tics by itself. (No -testsync: the
# old binary does not know it, and a mismatch would misread packets.)
game3 mixA "$base_sw" "$root/sw" "$root/sw" 45 -testquit600
for n in 1 2; do
    t_check "old master, new slave $n: played 600 tics and quit (exit ${st[$n]})" test "${st[$n]}" -eq 0
    t_check "old master, new slave $n: reached tic 600" grep -q '^TEST: quitting after [0-9]* game tics' "$t_tmp/mixA-$n/sw.log"
done
game3 mixB "$root/sw" "$base_sw" "$base_sw" 45 -testquit600
t_check "new master, old slaves: played 600 tics and quit (exit ${st[0]})" test "${st[0]}" -eq 0
t_check "new master, old slaves: reached tic 600" grep -q '^TEST: quitting after [0-9]* game tics' "$t_tmp/mixB-0/sw.log"

t_result
