#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Test 4: errors when starting or losing a network game through a relay. Each
# must end with a clear message on stdout (and in sw.log) and exit status 1,
# within a bounded time. Headless game processes against a local relay.
#
#   tests/net/test-errors.sh [--sw FILE] [--only REGEX]
#
# --only runs just the cases whose name matches REGEX (names are the first
# word of each check line). Run with --sw pointing at a build from before the
# relay existed (tests/net/build-baseline.sh) to see that these checks bite
# (tried with --only 'badcode-format|room-no-relay|no-such-room': all fail).
# Cases with a waiting time check a lower bound as well (host-leaves at least
# 9 s), so that shortening the start-up limits in mmulti_vnet.c is noticed.
#
# What happens today with plain -net (for comparison): a -net that cannot be
# set up (bad arguments, an unresolvable host) prints "mmulti error: ..." and
# the game carries on as a single player game; one that is set up waits for the
# other players without any time limit, and a master that disappears is never
# noticed. With -relay the same situations end the game with exit status 1:
#   - bad or malformed -relay, -room, -host-room: at once;
#   - the relay is not running or does not answer: after the relay timeout
#     (10 s);
#   - no room with that code, or the room is full (the relay's limit): as soon
#     as the relay says so;
#   - the host has all its players: at once, "the game has already started"
#     (brief 05; before it the newcomer got no answer and gave up 15 s after
#     the join with "the host did not answer");
#   - the host never answers: 15 s after the join;
#   - the host leaves while the others are waiting for players: 10 s after the
#     last answer.
# Host loss during the game itself behaves as with -net (the lockstep waits).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sw="$root/sw"; only="."
while [ $# -gt 0 ]; do
    case "$1" in
        --sw) sw="$2"; shift 2 ;;
        --only) only="$2"; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
t_need_data

rport=$((port_base + 50))
dead=$((port_base + 59))        # nothing listens here
auto="-autonet 2,0,2,1,0,0,0,0,0,0"

want() { echo "$1" | grep -Eq -- "$only"; }

# expect_fail NAME MAX-SECONDS REGEX game-args-before-"--"...
# Starts the game in the background and checks it ends with exit 1, in time,
# with REGEX in its output. Leaves the elapsed time in $took.
expect_fail() {
    local name="$1" max="$2" re="$3"; shift 3
    local t0 t1
    want "$name" || return 0
    local min="${minsec:-0}"; minsec=0
    t0=$(date +%s.%N)
    t_game "$name" "$t_tmp/$name" --sw "$sw" --timeout $((max + 30)) -- "$@"
    t_wait_pid "$game_pid" $((max + 10)); local st=$t_status
    t1=$(date +%s.%N)
    took=$(echo "$t1 - $t0" | bc)
    t_check "$name: exit status 1 (got $st) after ${took}s (between ${min}s and ${max}s)" bash -c "[ $st -eq 1 ] && [ \$(echo '$took <= $max && $took >= $min' | bc) -eq 1 ]"
    t_check "$name: message /$re/: $(grep -h -m1 -E "$re" "$t_tmp/$name.out" "$t_tmp/$name/sw.log" 2>/dev/null | head -1)" bash -c "grep -Eq -- '$re' '$t_tmp/$name.out' '$t_tmp/$name/sw.log'"
}

t_start_relay "$rport" -max-members 3      # rooms of at most 3
t_start_relay "$((rport + 1))"                  # rooms of the default size (8)
t_note "bad arguments (no relay needed)"
expect_fail badcode-format 5 'is not a room code|6 letters and digits' -net -relay "127.0.0.1:$rport" -room abc -- $auto
expect_fail badcode-chars 5 'is not a room code' -net -relay "127.0.0.1:$rport" -room "AB0DE1" -- $auto
expect_fail badcode-IO 5 'is not a room code' -net -relay "127.0.0.1:$rport" -room "ABCDEI" -- $auto
expect_fail badcode-O 5 'is not a room code' -net -relay "127.0.0.1:$rport" -room "oBCDE2" -- $auto
expect_fail relay-with-np 5 'peer-to-peer mode is not available' -net -relay "127.0.0.1:$rport" -room ABCDE2 -np -- $auto
expect_fail relay-with-hostname 5 'host names cannot be combined' -net -relay "127.0.0.1:$rport" -room ABCDE2 127.0.0.1 -- $auto
expect_fail hostroom-twenty 5 'number of players from 2 to 8 \(4 with the shareware' -net -relay "127.0.0.1:$rport" -host-room 20 -- $auto
expect_fail room-no-relay 5 'need -relay' -net -room ABCDE2 -- $auto
expect_fail relay-alone 5 'exactly one of' -net -relay "127.0.0.1:$rport" -- $auto
expect_fail relay-url 5 'not the URL' -net -relay "wss://example.org/vnet" -room ABCDE2 -- $auto
expect_fail hostroom-one 5 'number of players from 2' -net -relay "127.0.0.1:$rport" -host-room 1 -- $auto
expect_fail hostroom-word 5 'number of players from 2' -net -relay "127.0.0.1:$rport" -host-room many -- $auto
expect_fail relay-unresolvable 12 'cannot resolve relay host no-such-host.invalid' -net -relay "no-such-host.invalid:7777" -room ABCDE2 -- $auto

t_note "the relay is not running"
expect_fail relay-down 16 'could not be reached|did not answer' -net -relay "127.0.0.1:$dead" -room ABCDE2 -- $auto
expect_fail relay-down-host 16 'could not be reached|did not answer' -net -relay "127.0.0.1:$dead" -host-room 2 -- $auto

t_note "no such room"
expect_fail no-such-room 12 'no room with that code' -net -relay "127.0.0.1:$rport" -room ABCDE2 -- $auto

if want 'guestB-no-slot|guestC-room-full'; then
t_note "no place in the game; the relay's room full (relay limit 3 members)"
t_game host "$t_tmp/host" --sw "$sw" --timeout 80 -- -net -relay "127.0.0.1:$rport" -host-room 2 -- $auto
hostpid=$game_pid
t_wait_for "$t_tmp/host/sw.log" 'room code [A-Z0-9]{6}' 20 || t_bad "the host printed no room code"
code="$(grep -o 'room code [A-Z0-9]*' "$t_tmp/host/sw.log" | head -1 | awk '{print $3}')"
t_game guestA "$t_tmp/guestA" --sw "$sw" --timeout 80 -- -net -relay "127.0.0.1:$rport" -room "$code" -- $auto
guestapid=$game_pid
t_wait_for "$t_tmp/guestA/sw.log" 'mmulti: Player 0 is here' 20 || t_bad "guest A did not meet the host"
t_wait_for "$t_tmp/host/sw.log" 'mmulti: Player 1 is here' 20 || t_bad "the host did not meet guest A"
# guest B enters the room (the relay takes 3) but the game has no place for it: since brief 05 the
# host says so at once (it used to give no answer, and B gave up after 15 s)
expect_fail guestB-no-slot 5 'the game has already started' -net -relay "127.0.0.1:$rport" -room "$code" -- $auto
for p in "$guestapid" "$hostpid"; do
    kill -TERM "$p" 2>/dev/null; t_wait_pid "$p" 15
done
# the relay's room full: a game of 3 on a relay that takes 3 per room; a fourth is refused by the relay
t_game hostF "$t_tmp/hostF" --sw "$sw" --timeout 80 -- -net -relay "127.0.0.1:$rport" -host-room 3 -- $auto
hostfpid=$game_pid
t_wait_for "$t_tmp/hostF/sw.log" 'room code [A-Z0-9]{6}' 20 || t_bad "the host printed no room code"
codef="$(grep -o 'room code [A-Z0-9]*' "$t_tmp/hostF/sw.log" | head -1 | awk '{print $3}')"
t_game fillA "$t_tmp/fillA" --sw "$sw" --timeout 80 -- -net -relay "127.0.0.1:$rport" -room "$codef" -- $auto
fillapid=$game_pid
t_game fillB "$t_tmp/fillB" --sw "$sw" --timeout 80 -- -net -relay "127.0.0.1:$rport" -room "$codef" -- $auto
fillbpid=$game_pid
t_wait_for "$t_tmp/hostF/sw.log" 'Lobby: the game starts with 3 players' 30 || t_bad "the game of 3 did not start"
expect_fail guestC-room-full 12 'the room is full' -net -relay "127.0.0.1:$rport" -room "$codef" -- $auto
for p in "$fillbpid" "$fillapid" "$hostfpid"; do
    kill -TERM "$p" 2>/dev/null; t_wait_pid "$p" 15
done
fi

if want 'host-leaves'; then
t_note "the host leaves while the others wait for players"
t_game host2 "$t_tmp/host2" --sw "$sw" --timeout 80 -- -net -relay "127.0.0.1:$((rport + 1))" -host-room 3 -- $auto
host2pid=$game_pid
t_wait_for "$t_tmp/host2/sw.log" 'room code [A-Z0-9]{6}' 20 || t_bad "the second host printed no room code"
code2="$(grep -o 'room code [A-Z0-9]*' "$t_tmp/host2/sw.log" | head -1 | awk '{print $3}')"
t0=$(date +%s.%N)
t_game joiner "$t_tmp/joiner" --sw "$sw" --timeout 80 -- -net -relay "127.0.0.1:$((rport + 1))" -room "$code2" -- $auto
joinerpid=$game_pid
t_wait_for "$t_tmp/joiner/sw.log" 'mmulti: Player 0 is here' 20 || t_bad "the joiner did not meet the host"
# the game process itself (a child of the run-headless script) vanishes without a word
gamepid="$(pgrep -P "$host2pid" -x sw | head -1)"
if [ -n "$gamepid" ]; then kill -KILL "$gamepid"; else t_bad "could not find the host's game process"; fi
t0=$(date +%s.%N)
t_wait_pid "$joinerpid" 40; st=$t_status
took=$(echo "$(date +%s.%N) - $t0" | bc)
t_check "host-leaves: the joiner exited 1 (got $st) ${took}s after the host died (between 9 s and 20 s)" bash -c "[ $st -eq 1 ] && [ \$(echo '$took <= 20 && $took >= 9' | bc) -eq 1 ]"
t_check "host-leaves: message: $(grep -h -m1 'the host stopped answering' "$t_tmp/joiner.out" "$t_tmp/joiner/sw.log" 2>/dev/null | head -1)" bash -c "grep -q 'the host stopped answering' '$t_tmp/joiner.out' '$t_tmp/joiner/sw.log'"
kill -TERM "$host2pid" 2>/dev/null; t_wait_pid "$host2pid" 15
fi

if want 'cap'; then
t_note "player caps, clamped with a message (4 on the shareware GRP, and the relay's room size)"
t_game cap4 "$t_tmp/cap4" --sw "$sw" --timeout 15 -- -net -relay "127.0.0.1:$((rport + 1))" -host-room 6 -- $auto
t_wait_for "$t_tmp/cap4/sw.log" 'hosting a 4-player game' 12
t_check "-host-room 6 on shareware: clamped to 4 with a message ($(grep -h -m1 'hosting a' "$t_tmp/cap4/sw.log" 2>/dev/null))" grep -q 'allows at most 4 players; hosting a 4-player game' "$t_tmp/cap4/sw.log"
t_game cap3 "$t_tmp/cap3" --sw "$sw" --timeout 15 -- -net -relay "127.0.0.1:$rport" -host-room 4 -- $auto
t_wait_for "$t_tmp/cap3/sw.log" 'hosting a 3-player game' 12
t_check "-host-room 4 on a relay with rooms of 3: clamped to 3 with a message ($(grep -h -m1 'hosting a' "$t_tmp/cap3/sw.log" 2>/dev/null))" grep -q 'relay takes at most 3 players per room; hosting a 3-player game' "$t_tmp/cap3/sw.log"

fi

t_result
