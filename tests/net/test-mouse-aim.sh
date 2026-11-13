#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# F4 (bugs.md L25): toggling mouse aiming during a network game changes it on
# every machine at the same tic. The Mouse_Aiming key (U) used to change the
# player's PF_MOUSE_AIMING_ON on that player's own machine only, while
# PlayerAutoLook() reads it: on a sloped floor the view of a player without
# mouse aiming is tilted (horizoff), so after a toggle the next slope gave the
# machines different horiz values and the master said "GAME OUT OF SYNC!".
#
# Two headless games. One presses the key (-testaimkey, read by getinput() with
# the real key), then every machine puts that player on a sloped floor
# (-testslope), standing still. Games:
#   control  nobody presses: the slope tilts the player's view on both machines
#            (horizoff not 0), so the slope does reach PlayerAutoLook();
#   master   the host (the master) toggles at tic 100; on the slope at tic 300;
#   slave    the joiner toggles at tic 100, over plain UDP with its datagrams
#            80 ms late; on the slope at tic 300;
#   held     held mode (-testaimheld): the joiner holds the key from tic 250 to
#            349, is put on the slope at tic 280, and lets go on it;
#   exit     the level ends at tic 200 (-testexit200, to E1L2, played to its tic 300); the host presses
#            the key at tic 199 and the joiner at tic 201 (an input of the
#            first level that is never played); the joiner is put on a slope at
#            tic 100 of E1L2.
#
#   tests/net/test-mouse-aim.sh [--sw FILE] [--runs N] [--only NAME]
#
# Passes when, in every game: both exit 0; the key presses and the slope were
# logged; no "OUT OF SYNC"; both -testdump files have every tic and agree byte
# for byte; the state dumps (-teststate) agree field for field (what is a
# machine's own left out, code-facts.md section 17) 20 tics after the slope, and
# there the player's mouse aiming flag (Flags 0x40000000) is what the key made
# it, and the view is tilted exactly when mouse aiming is off. About 15 s a game.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sw="$root/sw"; runs=1; only=""
while [ $# -gt 0 ]; do
    case "$1" in
        --sw) sw="$2"; shift 2 ;;
        --runs) runs="$2"; shift 2 ;;
        --only) only="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
t_need_data

rport=$((port_base + 60)); uport=$((port_base + 64))
coop="-autonet 2,0,0,0,0,0,0,0,0,0"    # co-op, E1L1, no monsters (a deathmatch ends on a table that waits for a key)
t_start_relay "$rport"

# the fields of a state dump that are this machine's own (netplay.js stateDifferences)
own_fields() {
    sed -E -e 's/ (krandcount|numframes|myconnectindex|movefifoend|FadeAmt|FadeTics|NightVision)=[^ ]*//g' \
           -e '/drawscratch=/s/ (ang|xvel)=[^ ]*//g'
}
field() {   # FILE WHEN PLAYER FIELD
    sed -n "s/^$2 player $3 .* $4=\([^ ]*\).*/\1/p" "$1" | head -1
}

# game NAME TRANSPORT TICS PLAYER WHEN AIMING "HOST ARGS" "JOINER ARGS" "COMMON ARGS"
#   PLAYER: the player put on the slope; WHEN: the state dump checked (20 tics after it);
#   AIMING: 1 or 0, that player's mouse aiming there
game() {
    local name="$1" transport="$2" tics="$3" p="$4" when="$5" aiming="$6" hargs="$7" jargs="$8" cargs="$9"
    local run d hp jp hs js code w fl ho want
    [ -n "$only" ] && [ "$only" != "$name" ] && return
    for run in $(seq 1 "$runs"); do
        d="$t_tmp/$name.$run"
        t_note "$name, run $run of $runs ($transport; load $(cut -d' ' -f1-3 /proc/loadavg))"
        local common="$coop -testsync -testquit$tics -testdumpd.bin -teststate $cargs"
        if [ "$transport" = relay ]; then
            t_game "$name-h" "$d/h" --sw "$sw" --timeout 90 -- -net -relay "127.0.0.1:$rport" -host-room 2 -- $common $hargs
            hp=$game_pid
            t_wait_for "$d/h/sw.log" 'room code [A-Z0-9]{6}' 20 || { t_bad "$name: the host never printed a room code"; continue; }
            code="$(grep -o 'room code [A-Z0-9]*' "$d/h/sw.log" | head -1 | awk '{print $3}')"
            t_game "$name-j" "$d/j" --sw "$sw" --timeout 90 -- -net -relay "127.0.0.1:$rport" -room "$code" -- $common $jargs
            jp=$game_pid
        else
            t_game "$name-h" "$d/h" --sw "$sw" --timeout 90 -- -net -nm:2 "-p$uport" -- $common $hargs
            hp=$game_pid
            VNET_IMPAIR="lat=80,seed=$((run + 5))" t_game "$name-j" "$d/j" --sw "$sw" --timeout 90 -- -net -nm "-p$((uport + 1))" "127.0.0.1:$uport" -- $common $jargs
            jp=$game_pid
        fi
        t_wait_pid "$hp" 100; hs=$t_status
        t_wait_pid "$jp" 100; js=$t_status
        t_check "$name: both games exited 0 (host $hs, joiner $js)" test "$hs" -eq 0 -a "$js" -eq 0
        for w in h j; do
            t_check "$name: $w logged no desync" bash -c "! grep -q 'OUT OF SYNC' '$d/$w/sw.log'"
            t_check "$name: $w put player $p on a sloped floor" grep -q "TEST: player $p put on sloped sector" "$d/$w/sw.log"
        done
        case "$name" in
            master) t_check "$name: the host's key turned mouse aiming on at tic 100" grep -q 'TEST: Mouse_Aiming key pressed at tic 100 of level 1: mouse aiming on' "$d/h/sw.log" ;;
            slave)  t_check "$name: the joiner's key turned mouse aiming on at tic 100" grep -q 'TEST: Mouse_Aiming key pressed at tic 100 of level 1: mouse aiming on' "$d/j/sw.log" ;;
            held)   t_check "$name: the joiner held the key (on from tic 250, off at 350)" bash -c "grep -q 'key pressed at tic 250 of level 1: mouse aiming on' '$d/j/sw.log' && grep -q 'key held at tic 349 of level 1: mouse aiming on' '$d/j/sw.log' && grep -q 'key released at tic 350 of level 1: mouse aiming off' '$d/j/sw.log'" ;;
            exit)   t_check "$name: the host pressed the key at tic 199 and the joiner at tic 201" bash -c "grep -q 'key pressed at tic 199 of level 1: mouse aiming on' '$d/h/sw.log' && grep -q 'key pressed at tic 201 of level 1: mouse aiming on' '$d/j/sw.log'"
                    t_check "$name: both left the first level at tic 200" bash -c "grep -q 'TEST: leaving the level at tic 200 for level 2\$' '$d/h/sw.log' && grep -q 'TEST: leaving the level at tic 200 for level 2\$' '$d/j/sw.log'" ;;
        esac
        # (a machine can play a tic or two past -testquit before it stops: compare the first $tics)
        local n=$((tics * 17)) hn jn
        if [ "$name" = exit ]; then n=$(((200 + tics) * 17)); fi
        hn=$(stat -c %s "$d/h/d.bin" 2>/dev/null || echo 0); jn=$(stat -c %s "$d/j/d.bin" 2>/dev/null || echo 0)
        t_check "$name: both dumps have every tic ($((hn / 17)) and $((jn / 17)) records, want $((n / 17)))" test "$hn" -ge "$n" -a "$jn" -ge "$n"
        t_check "$name: and those records are byte for byte the same" cmp -s -n "$n" "$d/h/d.bin" "$d/j/d.bin"
        grep "^$when " "$d/h/d.bin.state" 2>/dev/null | own_fields > "$d/h.$when"
        grep "^$when " "$d/j/d.bin.state" 2>/dev/null | own_fields > "$d/j.$when"
        t_check "$name: the state dumps agree field for field at $when ($(wc -l < "$d/h.$when") lines)" bash -c "[ -s '$d/h.$when' ] && cmp -s '$d/h.$when' '$d/j.$when'"
        for w in h j; do
            fl="$(field "$d/$w/d.bin.state" "$when" "$p" Flags)"
            ho="$(field "$d/$w/d.bin.state" "$when" "$p" horizoff)"
            if [ -n "$fl" ]; then fl=$(( (0x$fl >> 30) & 1 )); fi
            t_check "$name: $w: player $p's mouse aiming at $when is ${fl:-?} (want $aiming)" test "${fl:-x}" = "$aiming"
            if [ "$aiming" = 1 ]; then
                t_check "$name: $w: player $p's view on the slope at $when is not tilted (horizoff ${ho:-?}, want 0)" test "${ho:-x}" = 0
            else
                t_check "$name: $w: player $p's view on the slope at $when is tilted (horizoff ${ho:-?}, want not 0)" test -n "$ho" -a "${ho:-0}" != 0
            fi
        done
        if [ "$t_fail" -ne 0 ] && [ -n "${JFSW_TEST_VERBOSE:-}" ]; then
            for w in h j; do echo "---- $w log"; grep '^TEST\|OUT OF SYNC' "$d/$w/sw.log" | head -20; done
        fi
    done
}

game control relay 400 0 t320 0 "" "" "-testslope300,0 -teststate320"
game master  relay 400 0 t320 1 "-testaimkey100" "" "-testslope300,0 -teststate320"
game slave   udp   400 1 t320 1 "" "-testaimkey100" "-testslope300,1 -teststate320"
game held    relay 400 1 t300 1 "" "-testaimheld -testaimkey250,100" "-testslope280,1 -teststate300"
game exit    relay 300 1 L2.t120 1 "-testaimkey199" "-testaimkey201" "-testexit200 -testslope100,1,2 -teststate120"
t_result
