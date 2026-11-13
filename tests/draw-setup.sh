#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Brief 04c: DrawSetupLevelStats() (src/draw.c) must leave every sector and
# wall exactly as one drawn frame does, on every level, so that a machine that
# never draws (a hidden browser tab in a network game) has the same state from
# tic 1 on as one that drew (bugs.md L19). Each shareware level is started
# headless as a single player game with the test-only -testdrawcheck (sync.c):
# the game works out what DrawSetupLevelStats() makes of the sectors, puts the
# map back, draws its first frame and compares every sector and wall with it.
#
#   tests/draw-setup.sh [--sw FILE]        (needs ./sw and testdata/swshare.grp)
#
# Runs: -testdrawcheck (the map as it is), -testdrawcheck2 (a second override
# marker added to the plane of each one, where the markers' order matters: the
# shareware maps have none), and two controls that must find differences on
# the levels with override markers (E1L1, E1L3): -testdrawcheck3 (nothing
# applied at setup) and -testdrawcheck4 (two markers per plane, only the
# parallax bits cleared: what the first version of DrawSetupLevelStats did).
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sw="$root/sw"
while [ $# -gt 0 ]; do
    case "$1" in
        --sw) sw="$2"; shift 2 ;;
        *) echo "usage: $0 [--sw FILE]" >&2; exit 2 ;;
    esac
done
[ -x "$sw" ] || { echo "no game binary $sw (make)" >&2; exit 2; }
[ -f "$root/testdata/swshare.grp" ] || { echo "no testdata/swshare.grp (scripts/fetch-test-data.sh)" >&2; exit 2; }
work="$(mktemp -d)" || exit 2
trap 'rm -rf -- "$work"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

# markers per level (the shareware maps: E1L1 2, E1L2 0, E1L3 6, E1L4 0)
markers=(0 2 0 6 0)
for mode in 1 2 3 4; do
    for level in 1 2 3 4; do
        rm -rf "$work/run"
        out="$("$root/scripts/run-headless.sh" --sw "$sw" --timeout 30 --workdir "$work/run" "-level$level" "-testdrawcheck$mode" 2>&1)"
        line="$(printf '%s\n' "$out" | grep -m1 'TEST: draw check')"
        n="$(printf '%s\n' "$line" | sed -n 's/.*: \([0-9]*\) of [0-9]* sectors and \([0-9]*\) of [0-9]* walls differ.*/\1 \2/p')"
        name="-testdrawcheck$mode, E1L$level"
        if [ -z "$n" ]; then bad "$name: no check line (${out: -300})"; continue; fi
        set -- $n
        want="${markers[$level]}"
        [ "$mode" -ge 2 ] && [ "$mode" -ne 3 ] && want=$((want * 2))
        printf '%s\n' "$line" | grep -q "($want override markers)" || { bad "$name: $want override markers expected: $line"; continue; }
        if [ "$mode" -le 2 ] || [ "${markers[$level]}" -eq 0 ]; then
            if [ "$1" = 0 ] && [ "$2" = 0 ]; then ok "$name: no sector or wall differs ($want override markers)"
            else bad "$name: $line"; fi
        else
            # a control: the override sectors must differ (one per marker in the map), walls not
            if [ "$1" = "${markers[$level]}" ] && [ "$2" = 0 ]; then ok "$name (control): the check finds the ${markers[$level]} override sectors"
            else bad "$name (control): ${markers[$level]} sectors expected: $line"; fi
        fi
    done
done
echo "draw-setup: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
