#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Install a pinned Emscripten SDK, for the browser build of jfsw-browser.
# Adapted from Bit Riot's scripts/setup-emsdk.sh.
#
#   scripts/setup-emsdk.sh                  # installs into ~/.cache/jfsw-browser/emsdk
#   EMSDK_DIR=/opt/emsdk scripts/setup-emsdk.sh
#   source "$EMSDK_DIR/emsdk_env.sh"        # then: emcc --version
#   scripts/setup-emsdk.sh --with-ports     # also seed the Emscripten ports
#
# Both the emsdk repository revision and the Emscripten version are pinned, so
# every machine gets the same compiler. emsdk is fetched with git (never a GitHub
# archive download, which some networks block); the toolchain binaries come from
# storage.googleapis.com.
#
# The default EMSDK_DIR is outside the worktree ($XDG_CACHE_HOME or ~/.cache, then
# jfsw-browser/emsdk) so that several worktrees share one install.
#
# --with-ports (-sUSE_SDL=2, -sUSE_OGG=1 -sUSE_VORBIS=1): Emscripten fetches its
# ports from GitHub archive URLs, which some networks block (the cloud container
# answers 403). The repository's orphan branch `emscripten-ports` holds those
# archives; this verifies each one's SHA-512 against the HASH in the emsdk's
# tools/ports/<name>.py, unpacks it into $(em-config CACHE)/ports/<name>/ the way
# Emscripten itself would, and writes the .emscripten_url marker, so Emscripten
# finds the port up to date and downloads nothing. Without a blocked network it is
# optional (Emscripten downloads the ports itself on first use). It writes into
# Emscripten's cache without taking its lock, so do not run it while an emcc or an
# emcmake build is running.
set -euo pipefail

EMSDK_COMMIT="d7b4130688bfa348392b921ab04015aa15c4f154"  # emscripten-core/emsdk, 2026-10-20
EMSDK_VERSION="6.0.13"                                    # Emscripten release installed by that revision

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="${EMSDK_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/jfsw-browser/emsdk}"

WITH_PORTS=0
for arg in "$@"; do
    case "$arg" in
        --with-ports) WITH_PORTS=1 ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
done

if [ ! -d "$EMSDK_DIR/.git" ]; then
    mkdir -p "$EMSDK_DIR"
    git init -q "$EMSDK_DIR"
    git -C "$EMSDK_DIR" remote add origin https://github.com/emscripten-core/emsdk.git
fi
if [ "$(git -C "$EMSDK_DIR" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$EMSDK_COMMIT" ]; then
    git -C "$EMSDK_DIR" fetch -q --depth 1 origin "$EMSDK_COMMIT"
    git -C "$EMSDK_DIR" checkout -q --force "$EMSDK_COMMIT"
fi

cd "$EMSDK_DIR"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"

if [ "$WITH_PORTS" = 1 ]; then
    # name | file on the emscripten-ports branch | URL Emscripten fetches (its marker)
    PORTS='
sdl2|release-2.32.10.zip|https://github.com/libsdl-org/SDL/archive/release-2.32.10.zip
ogg|libogg-1.3.5.zip|https://github.com/xiph/ogg/releases/download/v1.3.5/libogg-1.3.5.zip
vorbis|libvorbis-1.3.7.zip|https://github.com/xiph/vorbis/releases/download/v1.3.7/libvorbis-1.3.7.zip
'
    # In a subshell: emsdk_env.sh unsets EMSDK_DIR.
    # shellcheck disable=SC1091
    cache="$(. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1; em-config CACHE)"
    emports="$EMSDK_DIR/upstream/emscripten/tools/ports"

    pending=""
    while IFS='|' read -r name file url; do
        [ -n "$name" ] || continue
        if [ "$(cat "$cache/ports/$name/.emscripten_url" 2>/dev/null || true)" != "$url" ]; then
            pending="$pending $name"
        fi
    done <<< "$PORTS"

    if [ -z "$pending" ]; then
        echo "Emscripten ports already seeded in $cache/ports"
    else
        tmp="$(mktemp -d)"
        trap 'rm -rf "$tmp"' EXIT
        git -C "$root" fetch -q origin emscripten-ports
        git -C "$root" archive --format=tar FETCH_HEAD | tar -x -C "$tmp"
        mkdir -p "$cache/ports"
        while IFS='|' read -r name file url; do
            [ -n "$name" ] || continue
            case " $pending " in *" $name "*) ;; *) continue ;; esac
            want="$(sed -n "s/^HASH = '\([0-9a-f]\{128\}\)'.*/\1/p" "$emports/$name.py")"
            have="$(sha512sum "$tmp/$file" | cut -d' ' -f1)"
            if [ -z "$want" ] || [ "$want" != "$have" ]; then
                echo "SHA-512 of $file does not match tools/ports/$name.py (the emsdk pin changed? refresh the emscripten-ports branch)" >&2
                exit 1
            fi
            # Unpack exactly as Emscripten does (shutil.unpack_archive into a temporary
            # directory, then a rename), and write its marker.
            rm -rf "$cache/ports/$name.tmp" "$cache/ports/$name"
            mkdir -p "$cache/ports/$name.tmp"
            python3 -c 'import shutil, sys; shutil.unpack_archive(sys.argv[1], sys.argv[2])' "$tmp/$file" "$cache/ports/$name.tmp"
            printf '%s\n' "$url" > "$cache/ports/$name.tmp/.emscripten_url"
            mv "$cache/ports/$name.tmp" "$cache/ports/$name"
            echo "seeded port $name from $file"
        done <<< "$PORTS"
    fi
fi

echo
echo "emsdk $EMSDK_VERSION is installed in $EMSDK_DIR"
echo "Use it with:  source \"$EMSDK_DIR/emsdk_env.sh\""
