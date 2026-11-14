#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Brief 05b: print what this build's game code is made from, for the "different build" line of a
# network game: the git tree of src/ and the commits of jfbuild, jfmact and jfaudiolib, as full object
# ids (an abbreviated id changes length with the clone's size, so a shallow clone and a full one would
# disagree), hashed into 16 hex digits, with "+" when any of them has changes that are not committed.
# Commits that change only the docs, the tests or the page keep the same id. Prints nothing without
# git (the game then says nothing about builds).
cd "$(dirname "$0")/.." || exit 0
t=$(git rev-parse HEAD:src 2>/dev/null) || exit 0
b=$(git -C jfbuild rev-parse HEAD 2>/dev/null) || exit 0
m=$(git -C jfmact rev-parse HEAD 2>/dev/null) || exit 0
a=$(git -C jfaudiolib rev-parse HEAD 2>/dev/null) || exit 0
h=$(printf 'src %s\njfbuild %s\njfmact %s\njfaudiolib %s\n' "$t" "$b" "$m" "$a" | git hash-object --stdin 2>/dev/null) || exit 0
d=""
if [ -n "$(git status --porcelain -- src jfbuild jfmact jfaudiolib 2>/dev/null)" ]; then d="+"; fi
printf '%s%s\n' "$(printf '%s' "$h" | cut -c1-16)" "$d"
