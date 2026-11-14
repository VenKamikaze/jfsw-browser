#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Brief 05b (bugs.md L26): when the players' game data differs, every machine
# says so, naming the player and what each has; the game goes on. Headless games
# through a local relay (one over plain UDP), co-op without monsters, 200 tics.
# The modified GRPs are made here from testdata/swshare.grp (tests/net/modgrp.py)
# and never kept. Games:
#   match     both on the shareware GRP: no line about data, version or build;
#   map       the host on a copy with one map changed (same variant: the old
#             version check sees nothing): both machines name the other's data,
#             the host's as "unknown data, CRC ...";
#   variant   the joiner on a copy taken for registered data, over plain UDP:
#             both name the data, and the version differs too (13 against 14,
#             plus the test salt);
#   three     three players, only the second differs: players 1 and 3 name
#             player 2, player 2 names players 1 and 3;
#   build     same data, the joiner reports another build (-testbuildid): the
#             milder build line on both, nothing about data.
#
#   tests/net/test-data-mismatch.sh [--sw FILE] [--only NAME]
#   tests/net/test-data-mismatch.sh --old-sw FILE   # also: an older build (no data packet) against this one
#
# --old-sw adds two games, an older build as host against this one: with
# different data (the map copy) and with the same; this build must say nothing
# about the older one's data or build (it does not know them), and neither may
# fail. Passes when every game ends with status 0 and prints exactly the lines
# above. About 15 s a game.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sw="$root/sw"; only=""; oldsw=""
while [ $# -gt 0 ]; do
    case "$1" in
        --sw) sw="$2"; shift 2 ;;
        --only) only="$2"; shift 2 ;;
        --old-sw) oldsw="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
t_need_data

rport=$((port_base + 100)); uport=$((port_base + 104))
tics=200
common="-autonet 2,0,0,0,0,0,0,0,0,0 -testquit$tics"
grp="$root/testdata/swshare.grp"
mkdir -p "$t_tmp/map" "$t_tmp/reg"
mapcrc="$(python3 -I "$root/tests/net/modgrp.py" map "$grp" "$t_tmp/map/sw.grp")" || { echo "modgrp.py failed" >&2; exit 125; }
regcrc="$(python3 -I "$root/tests/net/modgrp.py" registered "$grp" "$t_tmp/reg/sw.grp")" || { echo "modgrp.py failed" >&2; exit 125; }
t_start_relay "$rport"

SHARE="Shareware Version"
MAP="unknown data, CRC $mapcrc"
REG="unknown data, CRC $regcrc"
data_line() {   # PLAYER THEIRS MINE
    echo "Player $1 has different game data ($2) from yours ($3): the game will probably go out of sync."
}
build_line_re() {   # PLAYER: the build line, any builds
    echo "^Player $1 runs a different build \(.*\) from yours \(.*\): if the game logic differs, the game may go out of sync\.\$"
}
notes() {       # LOG: every line this brief adds
    grep -E '^Player [0-9]+ (has different game data|runs a different (build|version))' "$1"
}
export -f notes     # (the checks run it in bash -c)

# game NAME TRANSPORT "SW,GRP,ARGS for player 1" "... player 2" ["... player 3"]
#   (empty SW or GRP: this build, the shareware GRP); sets d (the work directory)
game() {
    local name="$1" transport="$2"; shift 2
    local n=$# i spec psw pgrp pargs code pids=() st
    d="$t_tmp/$name"
    t_note "$name ($n players, $transport; load $(cut -d' ' -f1-3 /proc/loadavg))"
    for i in $(seq 1 $n); do
        spec="${!i}"
        psw="${spec%%,*}"; spec="${spec#*,}"; pgrp="${spec%%,*}"; pargs="${spec#*,}"
        psw="${psw:-$sw}"; pgrp="${pgrp:-$grp}"
        if [ "$transport" = udp ]; then
            if [ "$i" = 1 ]; then
                t_game "$name-$i" "$d/$i" --sw "$psw" --grp "$pgrp" --timeout 60 -- -net -nm:$n "-p$uport" -- $common $pargs
            else
                t_game "$name-$i" "$d/$i" --sw "$psw" --grp "$pgrp" --timeout 60 -- -net -nm "-p$((uport + i - 1))" "127.0.0.1:$uport" -- $common $pargs
            fi
        elif [ "$i" = 1 ]; then
            t_game "$name-$i" "$d/$i" --sw "$psw" --grp "$pgrp" --timeout 60 -- -net -relay "127.0.0.1:$rport" -host-room $n -- $common $pargs
            t_wait_for "$d/1/sw.log" 'room code [A-Z0-9]{6}' 20 || { t_bad "$name: the host never printed a room code"; return; }
            code="$(grep -o 'room code [A-Z0-9]*' "$d/1/sw.log" | head -1 | awk '{print $3}')"
        else
            t_game "$name-$i" "$d/$i" --sw "$psw" --grp "$pgrp" --timeout 60 -- -net -relay "127.0.0.1:$rport" -room "$code" -- $common $pargs
        fi
        pids+=("$game_pid")
    done
    for i in $(seq 1 $n); do
        t_wait_pid "${pids[$((i - 1))]}" 70; st=$t_status
        t_check "$name: player $i ended with status 0 ($st)" test "$st" -eq 0
        t_check "$name: player $i played $tics tics" grep -q "TEST: quitting after" "$d/$i/sw.log"
    done
}
# want NAME PLAYER LINES...: exactly these lines of this brief (in any order), nothing more
want() {
    local name="$1" p="$2"; shift 2
    local got wantf="$t_tmp/$name.$p.want"
    printf '%s\n' "$@" | sed '/^$/d' | sort > "$wantf"
    got="$(notes "$d/$p/sw.log" | sort)"
    t_check "$name: player $p printed $(wc -l < "$wantf") line(s) about the others ($(echo "$got" | sed '/^$/d' | wc -l) printed)" bash -c "diff <(notes '$d/$p/sw.log' | sort) '$wantf' > /dev/null"
    [ -n "${JFSW_TEST_VERBOSE:-}" ] && echo "$got" | sed "s/^/    $p: /"
    return 0
}
run() { [ -z "$only" ] || [ "$only" = "$1" ]; }

if run match; then
    game match relay ",," ",,"
    want match 1; want match 2
    for p in 1 2; do t_check "match: player $p saw no version mismatch" bash -c "! grep -q 'CheckVersion()' '$d/$p/sw.log'"; done
fi
if run map; then
    game map relay ",$t_tmp/map/sw.grp," ",,"
    want map 1 "$(data_line 2 "$SHARE" "$MAP")"
    want map 2 "$(data_line 1 "$MAP" "$SHARE")"
    for p in 1 2; do t_check "map: player $p saw no version mismatch (the same variant)" bash -c "! grep -q 'CheckVersion()' '$d/$p/sw.log'"; done
fi
if run variant; then
    game variant udp ",," ",$t_tmp/reg/sw.grp,"
    want variant 1 "$(data_line 2 "$REG" "$SHARE")"
    want variant 2 "$(data_line 1 "$SHARE" "$REG")"
    t_check "variant: the host's log has the version difference too" grep -Eq 'CheckVersion\(\): player 1 has version [0-9]+, expecting [0-9]+' "$d/1/sw.log"
    t_check "variant: the joiner's log has it too" grep -Eq 'CheckVersion\(\): player 0 has version [0-9]+, expecting [0-9]+' "$d/2/sw.log"
fi
if run three; then
    game three relay ",," ",$t_tmp/map/sw.grp," ",,"
    want three 1 "$(data_line 2 "$MAP" "$SHARE")"
    want three 2 "$(data_line 1 "$SHARE" "$MAP")" "$(data_line 3 "$SHARE" "$MAP")"
    want three 3 "$(data_line 2 "$MAP" "$SHARE")"
fi
if run build; then
    game build relay ",," ",,-testbuildidtest-build-x"
    for p in 1 2; do
        t_check "build: player $p printed the build line and nothing about data" bash -c "[ \"\$(notes '$d/$p/sw.log' | wc -l)\" = 1 ] && notes '$d/$p/sw.log' | grep -Eq '$(build_line_re $((3 - p)))'"
    done
    t_check "build: the host names the joiner's build" grep -q '^Player 2 runs a different build (test-build-x) from yours' "$d/1/sw.log"
    t_check "build: the joiner calls its own build test-build-x" grep -q '^Player 1 runs a different build (.*) from yours (test-build-x)' "$d/2/sw.log"
fi
if [ -n "$oldsw" ]; then
    if run old-map; then
        game old-map relay "$oldsw,$t_tmp/map/sw.grp," ",,"
        want old-map 2
        t_check "old-map: the older build printed none of this brief's lines either" bash -c "! notes '$d/1/sw.log' | grep -q ."
    fi
    if run old-match; then
        game old-match relay "$oldsw,," ",,"
        want old-match 2
        for p in 1 2; do t_check "old-match: player $p saw no version mismatch" bash -c "! grep -q 'CheckVersion()' '$d/$p/sw.log'"; done
    fi
fi
t_result
