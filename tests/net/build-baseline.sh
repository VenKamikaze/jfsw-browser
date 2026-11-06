#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Build the game as it was before brief 01 into $JFSW_CACHE/baseline-<commit>
# (default ~/.cache/jfsw-browser),
# for tests/net/test-udp-unchanged.sh to compare against. Prints the path of
# the baseline `sw` on its last line. Needs network access to the submodule
# forks (it checks out jfbuild, jfaudiolib and jfmact at the pinned commits).
#
#   tests/net/build-baseline.sh [commit]     (default: $JFSW_BASELINE, else f3c1a22)
#
# The default is fixed: f3c1a22 is `claude` just before brief 01 was merged
# (its game and jfbuild are upstream's, with no relay code). It must not be
# worked out from `claude` (it used to be the merge-base of HEAD and claude):
# once brief 01 is on `claude`, that commit already has the relay code, and
# its mmulti.c no longer builds on its own as the "old" mmulti.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${JFSW_CACHE:-$HOME/.cache/jfsw-browser}"

PRE_BRIEF_01=f3c1a22
base="${1:-${JFSW_BASELINE:-$PRE_BRIEF_01}}"
base="$(git -C "$root" rev-parse -q --verify --short "$base^{commit}")" || {
    echo "baseline commit ${1:-${JFSW_BASELINE:-$PRE_BRIEF_01}} not found: fetch more history (git fetch origin claude) or give a commit" >&2; exit 1; }
# (brief 01 added tests/net/; jfbuild is a submodule, so look at this repo's tree)
if git -C "$root" ls-tree -r "$base" -- tests/net/lib.sh | grep -q .; then
    echo "baseline $base already has brief 01's relay code: give a commit from before brief 01" >&2; exit 1
fi
dir="$cache/baseline-$base"

if [ ! -x "$dir/sw" ]; then
    mkdir -p "$cache"
    if [ ! -d "$dir" ]; then git -C "$root" worktree add --detach "$dir" "$base" >&2; fi
    ( cd "$dir" && git submodule update --init jfbuild jfaudiolib jfmact >&2 && make -j4 sw >&2 )
fi
[ -x "$dir/sw" ] || { echo "baseline build failed" >&2; exit 1; }
echo "$dir/sw"
