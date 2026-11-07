#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Tests for scripts/run-headless.sh, using a fake game binary (--sw) and a fake
# GRP, so no game data and no build are needed.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/run-headless.sh"
work="$(mktemp -d)" || { echo "mktemp failed" >&2; exit 2; }
[ -d "$work" ] || exit 2
trap 'rm -rf -- "$work"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

grp="$work/fake.grp"; echo x > "$grp"
mkfake() { printf '#!/bin/sh\n%s\n' "$2" > "$work/$1"; chmod +x "$work/$1"; }
mkfake exit0 'echo "args: $*"; echo "home: $HOME"; echo "vd: $SDL_VIDEODRIVER"; [ -e user_profiles_disabled ] && echo portable; ls; exit 0'
mkfake exit3 'exit 3'
mkfake kill9 'kill -KILL $$'
mkfake sleeper 'trap "exit 0" TERM; while :; do sleep 1; done'

run() { out="$("$script" --grp "$grp" "$@" 2>&1)"; rc=$?; }

# 1. normal run: status passed through, environment set, temp dir removed
run --sw "$work/exit0" -level1
check "exit 0 passes through" "$rc" 0
case "$out" in *"args: -nosetup -level1"*) ok "-nosetup and game args passed";; *) bad "args: $out";; esac
case "$out" in *"vd: dummy"*portable*|*portable*"vd: dummy"*) ok "dummy video, portable marker";; *) bad "env: $out";; esac
tmp="$(echo "$out" | sed -n 's/^home: //p')"
[ -n "$tmp" ] && [ ! -e "$tmp" ] && ok "temporary work directory removed" || bad "temp dir $tmp still there"

run --sw "$work/exit3"; check "exit 3 passes through" "$rc" 3

# 2. a game killed by SIGKILL is 137, not a timeout
run --sw "$work/kill9" --timeout 30; check "SIGKILL death is 137, not 124" "$rc" 137

# 3. timeout: 124
run --sw "$work/sleeper" --timeout 1; check "timeout is 124" "$rc" 124

# 4. --workdir is kept, and never removed
mkdir -p "$work/keep"; echo precious > "$work/keep/file"
run --sw "$work/exit0" --workdir "$work/keep"
check "--workdir run" "$rc" 0
[ "$(cat "$work/keep/file" 2>/dev/null)" = precious ] && ok "--workdir contents kept" || bad "--workdir contents lost"

# 5. mktemp failure must not delete the caller's directory
mkdir -p "$work/caller"; echo here > "$work/caller/file"
( cd "$work/caller" && TMPDIR=/nonexistent-dir "$script" --grp "$grp" --sw "$work/exit0" >"$work/o5" 2>&1; echo $? > "$work/rc5" )
check "mktemp failure exits 125" "$(cat "$work/rc5")" 125
[ "$(cat "$work/caller/file" 2>/dev/null)" = here ] && ok "caller's directory survives a mktemp failure" || bad "caller's directory was wiped"

# 7. a signal to this script takes the game down with it (background jobs of
# a non-interactive shell ignore SIGINT, so the game would otherwise be left
# running with its work directory deleted)
mkfake pidsleeper "echo \$\$ > '$work/game.pid'; trap 'exit 0' TERM; while :; do sleep 1; done"
# Job control on (set -m) so the script itself is not started with SIGINT
# ignored, as a plain background job of this non-interactive test would be (a
# Ctrl-C in a terminal reaches it normally).
for sig in INT TERM; do
    rm -f "$work/game.pid"
    set -m
    "$script" --grp "$grp" --sw "$work/pidsleeper" --timeout 60 >/dev/null 2>&1 &
    spid=$!
    set +m
    for _ in $(seq 50); do [ -s "$work/game.pid" ] && break; sleep 0.1; done
    gpid="$(cat "$work/game.pid" 2>/dev/null)"
    kill -"$sig" "$spid"
    wait "$spid"; src=$?
    want=130; [ "$sig" = TERM ] && want=143
    check "SIG$sig to the script: its status" "$src" "$want"
    if [ -n "$gpid" ] && ! kill -0 "$gpid" 2>/dev/null; then
        ok "SIG$sig to the script stops the game"
    else
        bad "SIG$sig to the script left the game ($gpid) running"
        [ -n "$gpid" ] && kill -KILL "$gpid" 2>/dev/null
    fi
done

# 8. music is off unless --music: MusicDevice = 1 in the work directory's
# sw.cfg (created if missing, changed if present, kept with --music)
mkfake showcfg 'grep "^MusicDevice" sw.cfg 2>/dev/null || echo "no MusicDevice"; exit 0'
run --sw "$work/showcfg"
case "$out" in *"MusicDevice = 1"*) ok "music off by default (new sw.cfg)";; *) bad "music not off in a new sw.cfg: $out";; esac
mkdir -p "$work/cfg"; printf '[Sound Setup]\nFXDevice = 0\nMusicDevice = 0\nNumVoices = 32\n' > "$work/cfg/sw.cfg"
run --sw "$work/showcfg" --workdir "$work/cfg"
case "$out" in *"MusicDevice = 1"*) ok "music off by default (existing sw.cfg changed)";; *) bad "existing sw.cfg not changed: $out";; esac
grep -q '^NumVoices = 32$' "$work/cfg/sw.cfg" && ok "the rest of an existing sw.cfg is kept" || bad "the rest of sw.cfg was lost"
printf '[Sound Setup]\nMusicDevice = 0\n' > "$work/cfg/sw.cfg"
run --sw "$work/showcfg" --workdir "$work/cfg" --music
case "$out" in *"MusicDevice = 0"*) ok "--music keeps the work directory's setting";; *) bad "--music changed the setting: $out";; esac

# 6. bad inputs
run --sw "$work/nonexistent"; check "missing binary is 125" "$rc" 125
run --sw "$work/exit0" --timeout abc; check "bad timeout is 2" "$rc" 2

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
