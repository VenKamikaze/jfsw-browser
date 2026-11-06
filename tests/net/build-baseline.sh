#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Build the game as it was before brief 01 (the commit this branch was made
# from, on `claude`) into $JFSW_CACHE/baseline (default ~/.cache/jfsw-browser),
# for tests/net/test-udp-unchanged.sh to compare against. Prints the path of
# the baseline `sw` on its last line. Needs network access to the submodule
# forks (it checks out jfbuild, jfaudiolib and jfmact at the pinned commits).
#
#   tests/net/build-baseline.sh [commit]     (default: merge-base of HEAD and claude)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${JFSW_CACHE:-$HOME/.cache/jfsw-browser}"

base="${1:-}"
if [ -z "$base" ]; then
    for ref in claude origin/claude; do
        if git -C "$root" rev-parse -q --verify "$ref" >/dev/null; then base="$(git -C "$root" merge-base HEAD "$ref")"; break; fi
    done
fi
[ -n "$base" ] || { echo "no claude branch to compare with: give a commit" >&2; exit 1; }
base="$(git -C "$root" rev-parse --short "$base")"
dir="$cache/baseline-$base"

if [ ! -x "$dir/sw" ]; then
    mkdir -p "$cache"
    if [ ! -d "$dir" ]; then git -C "$root" worktree add --detach "$dir" "$base" >&2; fi
    ( cd "$dir" && git submodule update --init jfbuild jfaudiolib jfmact >&2 && make -j4 sw >&2 )
fi
[ -x "$dir/sw" ] || { echo "baseline build failed" >&2; exit 1; }
echo "$dir/sw"
