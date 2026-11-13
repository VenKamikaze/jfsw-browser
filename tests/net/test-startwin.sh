#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Brief 05: the GTK startup window's online choices, under a virtual X server
# (xvfb-run). The window is filled in by the test-only JFSW_TEST_STARTWIN
# (src/startgtk_game.c): it ticks "Online, through the relay", types the relay
# address and either sets "Host multi-player game" with a player count or
# "Join multi-player game" with a room code, and presses Start; the rest is
# the window's own code (its Start handler, NetStartwinArgs() in netlobby.c,
# app_main's start of the network game). The host's window then shows the
# lobby, and "startnow=2" presses its Start now button once 2 players are in.
#
#   tests/net/test-startwin.sh [--sw FILE]
#
# Passes when: the host's window hosted a game of 3 through the relay and the
# joiner's window joined it by its room code (typed in lower case); the host
# pressed Start now with 2 of 3 in; both games started with 2 players, played
# 300 tics, wrote byte-for-byte equal dumps and exit 0; the relay typed into
# the window is kept in sw.cfg; and Online with Join and no code shows a
# message and starts nothing. About 40 s. Skipped (exit 0, "SKIP") without
# xvfb-run or a GTK build.
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
if ! command -v xvfb-run >/dev/null; then echo "SKIP: no xvfb-run"; exit 0; fi
if ! grep -q startwin_netlobby "$sw" 2>/dev/null; then echo "SKIP: $sw has no GTK startup window"; exit 0; fi

rport=$((port_base + 80)); tics=300
common="-autonet 2,0,2,1,0,0,0,0,0,0 -testsync -testquit$tics -testdumpd.bin"
t_start_relay "$rport"
t_note "the startup window hosts (3 places, Start now at 2) and another joins by code (load $(cut -d' ' -f1-3 /proc/loadavg))"

# xvfb-run -a: a display of its own for each game
startwin_game() {   # NAME SETTINGS
    local name="$1" settings="$2"
    JFSW_TEST_STARTWIN="$settings" xvfb-run -a "$root/scripts/run-headless.sh" --display --workdir "$t_tmp/$name" --sw "$sw" --timeout 120 -- -setup $common > "$t_tmp/$name.out" 2>&1 &
    game_pid=$!
    t_pids+=("$game_pid")
}

startwin_game h "host=3 relay=127.0.0.1:$rport startnow=2"
hp=$game_pid
t_wait_for "$t_tmp/h.out" 'room code [A-Z0-9]{6}' 30 || { t_bad "the host's window never made a room"; cat "$t_tmp/h.out" | tail -20; t_result; }
code="$(grep -o 'room code [A-Z0-9]*' "$t_tmp/h.out" | head -1 | awk '{print $3}')"
startwin_game j "room=$(echo "$code" | tr A-Z a-z) relay=127.0.0.1:$rport"
jp=$game_pid
t_wait_pid "$hp" 120; hs=$t_status
t_wait_pid "$jp" 60; js=$t_status

t_check "the host's window chose the online game" grep -q "TEST: startup window: host=3 relay=127.0.0.1:$rport" "$t_tmp/h.out"
t_check "the host made a room through the relay" grep -q "mmulti: room code $code" "$t_tmp/h.out"
t_check "the joiner's window joined room $code" grep -q "mmulti: joined room $code" "$t_tmp/j.out"
t_check "the host's window pressed Start now with 2 of 3 in" grep -q "TEST: startup window: pressing Start now with 2 of 3 in" "$t_tmp/h.out"
t_check "the host started with 2 players" grep -q "Lobby: the game starts with 2 players; you are player 1" "$t_tmp/h.out"
t_check "the joiner started with 2 players" grep -q "Lobby: the game starts with 2 players; you are player 2" "$t_tmp/j.out"
t_check "the host exited 0 ($hs)" test "$hs" = 0
t_check "the joiner exited 0 ($js)" test "$js" = 0
for n in h j; do
    t_check "$n played $tics tics" grep -Eq "TEST: quitting after [0-9]+ game tics: .* player [01] of 2" "$t_tmp/$n.out"
    t_check "$n logged no desync" bash -c "! grep -q 'OUT OF SYNC' '$t_tmp/$n.out'"
done
t_check "both dumps have $tics records and are the same" bash -c "[ \$(stat -c %s '$t_tmp/h/d.bin') -ge $((tics * 17)) ] && cmp -s '$t_tmp/h/d.bin' '$t_tmp/j/d.bin'"
t_check "the relay typed into the window is kept in sw.cfg" grep -q "^Relay = \"127.0.0.1:$rport\"" "$t_tmp/j/sw.cfg"

t_note "Online and Join with no room code: the window says so and stays (it used to start a single player game)"
startwin_game e "room= relay=127.0.0.1:$rport"
ep=$game_pid
t_wait_for "$t_tmp/e.out" 'Startup window: Type the room code' 30
t_check "the window asked for the room code" grep -q "Startup window: Type the room code of the game to join" "$t_tmp/e.out"
sleep 3
t_check "and started nothing: no single player game, the window is still up" bash -c "kill -0 $ep 2>/dev/null && ! grep -q 'Loading sound and graphics' '$t_tmp/e.out'"
# (the window ignores SIGTERM while it waits for a choice: end the game itself, then its wrappers end)
for p in /proc/[0-9]*; do
    [ "$(readlink "$p/cwd" 2>/dev/null)" = "$t_tmp/e" ] && [ "$(cat "$p/comm" 2>/dev/null)" = sw ] && kill -KILL "${p#/proc/}"
done
t_wait_pid "$ep" 20
t_result
