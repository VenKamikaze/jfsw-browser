#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Run the game with no display, no sound and a throw-away home directory.
#
#   scripts/run-headless.sh [options] [--] [game arguments...]
#
#   --grp FILE      the GRP to use (default testdata/swshare.grp; see
#                   scripts/fetch-test-data.sh)
#   --timeout SEC   stop the game after SEC seconds (default 30). A running
#                   game never ends by itself unless a demo is playing, so a
#                   run that ends this way is not a failure of the game: it
#                   exits with 124 (SIGTERM makes the game quit cleanly,
#                   which is why it shows "exited with status 0" internally)
#   --workdir DIR   run in DIR (created if needed, kept afterwards) instead of
#                   a temporary directory, e.g. to record a demo in one run
#                   and play it back in the next
#   --sw FILE       the game binary (default ./sw)
#
# What it sets up, all of it needed by the game as it stands:
#   * SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy, DISPLAY unset;
#   * HOME is the work directory, so nothing is written to the real home;
#   * a user_profiles_disabled file in the work directory. This is the game's
#     own switch for a "portable" install: the current directory is added to
#     the search path and sw.cfg, sw.log, grpfiles.cache and demos are written
#     there. (Without it the game looks only in the binary's directory and in
#     ~/.jfsw, and chdirs into ~/.jfsw.)
#   * a symlink to the GRP under its own name, so the game's GRP scan (which
#     only looks at the search path and recognises files by CRC32) finds it;
#   * -nosetup, which skips the startup window.
#
# Exit status: the game's own, except 124 when the timeout stopped it
# (and 125 for a problem in this script, 2 for bad options).
#
# Bounded runs the game offers (it has no "run N frames and quit" option):
#   -level1 -dpNAME   plays back NAME.dmo, then exits by itself with 0
#   -level1 -drNAME   records NAME.dmo until it is stopped: use --timeout
#   -demosyncrecord / -demosynctest (with -dp) write / check NAME.dms.
#     A mismatch prints "Demo out of sync" to stdout and still exits 0.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
grp="$root/testdata/swshare.grp"
sw="$root/sw"
secs=30
workdir=""

while [ $# -gt 0 ]; do
    case "$1" in
        --grp) [ $# -ge 2 ] || { echo "--grp needs a file" >&2; exit 2; }; grp="$2"; shift 2 ;;
        --timeout) [ $# -ge 2 ] || { echo "--timeout needs seconds" >&2; exit 2; }; secs="$2"; shift 2 ;;
        --workdir) [ $# -ge 2 ] || { echo "--workdir needs a directory" >&2; exit 2; }; workdir="$2"; shift 2 ;;
        --sw) [ $# -ge 2 ] || { echo "--sw needs a file" >&2; exit 2; }; sw="$2"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        --) shift; break ;;
        *) break ;;
    esac
done

[ -x "$sw" ] || { echo "run-headless: $sw not found: run make first" >&2; exit 125; }
[ -f "$grp" ] || { echo "run-headless: $grp not found: run scripts/fetch-test-data.sh" >&2; exit 125; }
case "$secs" in ''|*[!0-9]*) echo "run-headless: --timeout must be whole seconds" >&2; exit 2 ;; esac

if [ -z "$workdir" ]; then
    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT
else
    mkdir -p "$workdir"
fi
workdir="$(cd "$workdir" && pwd)"
sw="$(cd "$(dirname "$sw")" && pwd)/$(basename "$sw")"
grp="$(cd "$(dirname "$grp")" && pwd)/$(basename "$grp")"

: > "$workdir/user_profiles_disabled"
ln -sf "$grp" "$workdir/$(basename "$grp")"

cd "$workdir" || exit 125
unset DISPLAY WAYLAND_DISPLAY
export HOME="$workdir" SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy

timeout -s TERM -k 5 "$secs" "$sw" -nosetup "$@"
rc=$?
if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    echo "run-headless: stopped after ${secs}s" >&2
    exit 124
fi
exit "$rc"
