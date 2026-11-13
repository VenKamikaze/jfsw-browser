#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# F3 (bugs.md L20): when a level ends, every machine plays exactly the tics up
# to the tic that ended it, and so carries the same co-op state into the next
# level. Two headless games play co-op through a local vnet relay. The level
# ends at tic 200 the way an exit switch ends it (-testexit200: ExitLevel set
# inside the tic, for the next level), and the host (the master) is made to
# hold the inputs of the tics after it: the joiner's datagrams are 200 ms late
# (VNET_IMPAIR), so it has made its inputs about 8 tics ahead, and the host
# stops for 1.5 s inside the exit tic (-teststall200,1500), meanwhile they
# arrive. Before the fix the host then ran those tics and the joiner did not.
# Both players throw shurikens from tic 150 on (-testfire150), so the extra
# tics cost ammo that the next level keeps: the host ran out first, and the
# game went out of sync there. Then 300 tics of the next level.
#
#   tests/net/test-level-exit.sh [--sw FILE] [--runs N]
#
# Passes when, in every run: both games exit 0; both left the first level at
# tic 200 and the host stalled in it; both dumps (-testdump: 17 bytes a tic)
# are byte for byte the same, 500 records, the 201st of which is tic 1 of the
# next level (so each machine played exactly 200 tics of the first); the
# state dumps (-teststate) agree field for field at the next level's start
# and at its tic 300 (leaving out what is a machine's own: code-facts.md
# section 17); the players threw shurikens before the exit (fewer than 30 at
# the next level's start) and after it; the host had every player's inputs
# beyond tic 201 when it left (the case the old code got wrong); no desync.
# About 20 s a run.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sw="$root/sw"; runs=1
while [ $# -gt 0 ]; do
    case "$1" in
        --sw) sw="$2"; shift 2 ;;
        --runs) runs="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
t_need_data

exit_tic=200; tics=300; rport=$((port_base + 70))
common="-autonet 2,0,2,1,0,0,0,0,0,0 -testsync -testquit$tics -testdumpd.bin -teststate -teststate$tics -testexit$exit_tic -testfire150"
t_start_relay "$rport"

# the fields of a state dump that are this machine's own, not the simulation's (netplay.js stateDifferences)
own_fields() {
    sed -E -e 's/ (krandcount|numframes|myconnectindex|movefifoend|FadeAmt|FadeTics|NightVision)=[^ ]*//g' \
           -e '/drawscratch=/s/ (ang|xvel)=[^ ]*//g'
}

for run in $(seq 1 "$runs"); do
    t_note "run $run of $runs: the level ends at tic $exit_tic, the host stops 1.5 s in it, the joiner's datagrams are 200 ms late (load $(cut -d' ' -f1-3 /proc/loadavg))"
    d="$t_tmp/run$run"
    t_game h "$d/h" --sw "$sw" --timeout 120 -- -net -relay "127.0.0.1:$rport" -host-room 2 -- $common "-teststall$exit_tic,1500"
    hp=$game_pid
    t_wait_for "$d/h/sw.log" 'room code [A-Z0-9]{6}' 20 || { t_bad "the host never printed a room code"; continue; }
    code="$(grep -o 'room code [A-Z0-9]*' "$d/h/sw.log" | head -1 | awk '{print $3}')"
    VNET_IMPAIR="lat=200,seed=$((run + 1))" t_game j "$d/j" --sw "$sw" --timeout 120 -- -net -relay "127.0.0.1:$rport" -room "$code" -- $common
    jp=$game_pid
    t_wait_pid "$hp" 130; hs=$t_status
    t_wait_pid "$jp" 130; js=$t_status
    t_check "run $run: both games exited 0 (host $hs, joiner $js)" test "$hs" -eq 0 -a "$js" -eq 0
    for w in h j; do
        t_check "run $run: $w left the first level at tic $exit_tic" grep -q "TEST: leaving the level at tic $exit_tic for level 2\$" "$d/$w/sw.log"
        played="$(sed -n 's/^TEST: left the level after tic \([0-9]*\), .*/\1/p' "$d/$w/sw.log" | head -1)"
        t_check "run $run: $w played ${played:-?} tics of the first level (want $exit_tic)" test "${played:-0}" -eq "$exit_tic"
        t_check "run $run: $w logged no desync" bash -c "! grep -q 'OUT OF SYNC' '$d/$w/sw.log'"
    done
    t_check "run $run: the host stalled in the exit tic" grep -q "TEST: stalling for 1500 ms at tic $exit_tic\$" "$d/h/sw.log"
    # (before the fix the host ran those tics, since it they stay in its fifo: either way it had them)
    upto="$(sed -n 's/^TEST: left the level after tic \([0-9]*\), with the inputs of \(-\?[0-9]*\) more tics here/\1 + \2/p' "$d/h/sw.log" | head -1)"
    upto=$((${upto:-0}))
    t_check "run $run: the host had every player's inputs up to tic $upto when it left the first level (beyond $((exit_tic + 1)): the case the old code got wrong)" test "$upto" -ge $((exit_tic + 2))
    t_check "run $run: both dumps are byte for byte the same" cmp -s "$d/h/d.bin" "$d/j/d.bin"
    size="$(stat -c %s "$d/h/d.bin" 2>/dev/null || echo 0)"
    next="$(od -An -tu4 -j $((exit_tic * 17)) -N4 "$d/h/d.bin" 2>/dev/null | tr -d ' ')"
    t_check "run $run: the host's dump has $exit_tic tics of the first level and $tics of the next ($((size / 17)) records; record $((exit_tic + 1)) is tic ${next:-?})" test "$size" -eq $(((exit_tic + tics) * 17)) -a "${next:-0}" = 1
    for when in L2.start "L2.t$tics"; do
        grep "^$when " "$d/h/d.bin.state" 2>/dev/null | own_fields > "$d/h.$when"
        grep "^$when " "$d/j/d.bin.state" 2>/dev/null | own_fields > "$d/j.$when"
        t_check "run $run: the state dumps agree field for field at $when ($(wc -l < "$d/h.$when") lines)" bash -c "[ -s '$d/h.$when' ] && cmp -s '$d/h.$when' '$d/j.$when'"
    done
    a0="$(sed -n 's/^L2.start player 0 .* WpnAmmo1=\([0-9]*\) .*/\1/p' "$d/h/d.bin.state")"
    a1="$(sed -n "s/^L2.t$tics player 0 .* WpnAmmo1=\([0-9]*\) .*/\1/p" "$d/h/d.bin.state")"
    t_check "run $run: player 0 threw shurikens before the exit and after it (${a0:-?} at the next level's start, ${a1:-?} at its tic $tics)" test "${a0:-0}" -gt 0 -a "${a0:-30}" -lt 30 -a "${a1:-99}" -lt "${a0:-0}"
    if [ "$t_fail" -ne 0 ] && [ -n "${JFSW_TEST_VERBOSE:-}" ]; then
        for w in h j; do echo "---- $w log"; grep '^TEST\|OUT OF SYNC' "$d/$w/sw.log" | head -20; done
    fi
done
t_result
