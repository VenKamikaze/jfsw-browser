#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install the native build dependencies of jfsw-browser.
#
#   scripts/setup.sh              # everything, including GTK3 for the startup window
#   scripts/setup.sh --no-gtk     # without GTK3 (the game then has no startup window)
#
# Supports apt (Debian, Ubuntu) and pacman (Arch). Non-interactive and idempotent:
# packages that are already installed are skipped. Uses sudo when not root.
# Installs: C/C++ compiler and make, pkg-config, SDL2, libvorbis + libogg, OpenGL
# headers, ALSA headers, unzip, Python 3, git, and (unless --no-gtk) GTK3.
# Go is only checked: the vnet relay needs the version in ext/vnet/relay/go.mod.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GTK=1
for arg in "$@"; do
    case "$arg" in
        --no-gtk) GTK=0 ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
done

SUDO=""
if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || { echo "not root and no sudo: run as root" >&2; exit 1; }
    SUDO="sudo"
fi

if command -v apt-get >/dev/null 2>&1; then
    pkgs="build-essential pkg-config git unzip python3 libsdl2-dev libvorbis-dev libogg-dev libgl1-mesa-dev libglu1-mesa-dev libasound2-dev"
    [ "$GTK" = 1 ] && pkgs="$pkgs libgtk-3-dev"
    export DEBIAN_FRONTEND=noninteractive
    $SUDO apt-get update -qq
    # shellcheck disable=SC2086
    $SUDO apt-get install -y -qq --no-install-recommends $pkgs
elif command -v pacman >/dev/null 2>&1; then
    pkgs="base-devel pkgconf git unzip python sdl2 libvorbis libogg mesa glu alsa-lib"
    [ "$GTK" = 1 ] && pkgs="$pkgs gtk3"
    # shellcheck disable=SC2086
    $SUDO pacman -S --needed --noconfirm $pkgs
else
    echo "neither apt-get nor pacman found: install a C/C++ compiler, make, pkg-config, SDL2, libvorbis, libogg, OpenGL headers, unzip, Python 3 (and GTK3) by hand" >&2
    exit 1
fi

# Go is optional (only the vnet relay needs it, and nothing builds that yet).
need="$(sed -n 's/^go \([0-9.]*\).*/\1/p' "$root/ext/vnet/relay/go.mod" 2>/dev/null | head -1 || true)"
if command -v go >/dev/null 2>&1; then
    have="$(go env GOVERSION | sed 's/^go//')"
    echo "Go $have found (the vnet relay needs ${need:-unknown} or newer)"
    if [ -n "$need" ] && [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
        echo "warning: Go $have is older than the relay's $need" >&2
    fi
else
    echo "Go not installed (optional; the vnet relay needs ${need:-a recent} Go. Arch: pacman -S go)"
fi

echo "native build dependencies are installed"
