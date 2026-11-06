#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Build the browser version (Emscripten/WebAssembly) into build-wasm/.
#
#   scripts/build-wasm.sh             # incremental build, 4 jobs
#   scripts/build-wasm.sh -j2         # other make options are passed through
#   scripts/build-wasm.sh clean       # remove the wasm objects (native objects are untouched)
#   scripts/build-wasm.sh veryclean   # ... and the libraries and build-wasm/
#   EMSDK_DIR=/opt/emsdk scripts/build-wasm.sh
#
# Needs Emscripten 6.0.13 (scripts/setup-emsdk.sh [--with-ports]). Software renderer only
# (USE_POLYMOST=0 USE_OPENGL=0, D6). See doco/browser/building.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="${EMSDK_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/jfsw-browser/emsdk}"

if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    echo "build-wasm: no emsdk in $EMSDK_DIR; run scripts/setup-emsdk.sh first" >&2
    exit 1
fi
# emsdk_env.sh clears EM_CACHE (a private Emscripten cache, handy where the ports cannot be downloaded).
saved_cache="${EM_CACHE:-}"
# shellcheck disable=SC1091
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
[ -z "$saved_cache" ] || export EM_CACHE="$saved_cache"

case "$(emcc --version | head -1)" in
    *" 6.0.13 "*) ;;
    *) echo "build-wasm: expected Emscripten 6.0.13, got: $(emcc --version | head -1)" >&2; exit 1 ;;
esac

cd "$root"
jobs=(-j4)
for a in "$@"; do case "$a" in -j*) jobs=() ;; esac; done
exec emmake make "${jobs[@]}" USE_POLYMOST=0 USE_OPENGL=0 "$@"
