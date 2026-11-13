#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Brief 05 review (B1): the relay gives a departed member's address (10.0.0.N)
# to the next joiner. A newcomer at the address of a player who is in the
# running game must be refused ("the game has already started"), not taken
# for that player: mmulti tells sessions apart by a random session id in the
# start-up exchange, not by the address. Two headless games through a local
# relay whose session timeout is 3 s (so that a vanished player's address is
# free again soon), co-op:
#
#   vanish  the guest's process is killed mid-game (no goodbye); 4.5 s later a
#           newcomer joins with the same room code and gets the guest's
#           address. The newcomer is refused at once; the host ends its game
#           with "player 2 (...) left the game" about 15 s after the guest's
#           last packet (the newcomer's pings do not count as the guest's).
#   quit    the guest quits properly at tic 200 (the console's quit, the
#           game's own quit); 3 s later a newcomer joins and gets its
#           address. The newcomer is refused at once; the host plays on alone
#           to tic 1200 and exits 0.
#
#   tests/net/test-rejoin.sh [--sw FILE]
#
# Before the fix the newcomer was let in ("you are player 2"): in "vanish" the
# host waited for its inputs for ever with no message, in "quit" the newcomer
# sat at tic 0 for ever. About 1 minute.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sw="$root/sw"
while [ $# -gt 0 ]; do
    case "$1" in
        --sw) sw="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
t_need_data

rport=$((port_base + 90))
auto="-autonet 2,0,2,1,0,0,0,0,0,0"
t_start_relay "$rport" -session-timeout 3s -keepalive 1s

game_proc() { pgrep -P "$1" -x sw | head -1; }   # the sw under a run-headless wrapper

# newcomer NAME CODE: a joiner that must be refused; checks its message, time and address
newcomer() {
    local name="$1" code="$2" t0 took
    t0=$(date +%s.%N)
    t_game "$name" "$t_tmp/$name" --sw "$sw" --timeout 40 -- -net -relay "127.0.0.1:$rport" -room "$code" -- $auto -testdumpd.bin
    t_wait_pid "$game_pid" 30; local st=$t_status
    took=$(echo "$(date +%s.%N) - $t0" | bc)
    t_check "$name: got the departed guest's address (10.0.0.2), so the case is the one under test" grep -q "joined room $code as 10.0.0.2" "$t_tmp/$name.out"
    t_check "$name: refused, exit 1 (got $st) after ${took}s (under 10 s)" bash -c "[ $st -eq 1 ] && [ \$(echo '$took < 10' | bc) -eq 1 ]"
    t_check "$name: told the game has already started" grep -q "Network game failed: the game has already started" "$t_tmp/$name.out"
    t_check "$name: never started a game" bash -c "! grep -q 'Lobby: the game starts' '$t_tmp/$name.out' && [ ! -s '$t_tmp/$name/d.bin' ]"
}

t_note "vanish: the guest's process dies mid-game, a newcomer gets its address (load $(cut -d' ' -f1-3 /proc/loadavg))"
t_game h1 "$t_tmp/h1" --sw "$sw" --timeout 120 -- -net -relay "127.0.0.1:$rport" -host-room 2 -- $auto -testquit4000 -testdumpd.bin
hp=$game_pid
t_wait_for "$t_tmp/h1.out" 'room code [A-Z0-9]{6}' 20 || t_bad "no room code"
code="$(grep -o 'room code [A-Z0-9]*' "$t_tmp/h1.out" | head -1 | awk '{print $3}')"
t_game g1 "$t_tmp/g1" --sw "$sw" --timeout 120 -- -net -relay "127.0.0.1:$rport" -room "$code" -- $auto -testquit4000 -testdumpd.bin
gp=$game_pid
t_wait_for "$t_tmp/g1.out" 'Lobby: the game starts' 30 || t_bad "the game did not start"
for i in $(seq 1 100); do [ "$(stat -c %s "$t_tmp/h1/d.bin" 2>/dev/null || echo 0)" -ge $((200 * 17)) ] && break; sleep 0.2; done
kill -KILL "$(game_proc "$gp")" 2>/dev/null
tkill=$(date +%s.%N)
sleep 4.5
newcomer n1 "$code"
t_wait_pid "$hp" 40; hs=$t_status
took=$(echo "$(date +%s.%N) - $tkill" | bc)
t_check "vanish: the host ended with status 1 (got $hs), ${took}s after the guest died (14 to 30 s)" bash -c "[ $hs -eq 1 ] && [ \$(echo '$took >= 14 && $took <= 30' | bc) -eq 1 ]"
t_check "vanish: the host says player 2 left the game" grep -q "Network game failed: player 2 (.*) left the game" "$t_tmp/h1.out"

t_note "quit: the guest quits properly at tic 200, a newcomer gets its address"
t_game h2 "$t_tmp/h2" --sw "$sw" --timeout 120 -- -net -relay "127.0.0.1:$rport" -host-room 2 -- $auto -testquit1200 -testdumpd.bin
hp=$game_pid
t_wait_for "$t_tmp/h2.out" 'room code [A-Z0-9]{6}' 20 || t_bad "no room code"
code="$(grep -o 'room code [A-Z0-9]*' "$t_tmp/h2.out" | head -1 | awk '{print $3}')"
t_game g2 "$t_tmp/g2" --sw "$sw" --timeout 120 -- -net -relay "127.0.0.1:$rport" -room "$code" -- $auto -testquit1200 -testdumpd.bin "-testosd200,quit"
gp=$game_pid
t_wait_for "$t_tmp/g2.out" 'console command at tic 200: quit' 60 || t_bad "the guest did not quit"
t_wait_pid "$gp" 20
sleep 3
newcomer n2 "$code"
t_wait_pid "$hp" 60; hs=$t_status
t_check "quit: the host played on alone and exited 0 (got $hs)" test "$hs" = 0
t_check "quit: the host reached tic 1200" grep -Eq "TEST: quitting after 1[0-9]{3} game tics" "$t_tmp/h2.out"
t_result
