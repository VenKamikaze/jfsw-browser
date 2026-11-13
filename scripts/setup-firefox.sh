#!/usr/bin/env bash
# Install a pinned stock Firefox and puppeteer-core, for tests/web/firefox.js (brief 02c).
#
#   scripts/setup-firefox.sh             # into ~/.cache/jfsw-browser/firefox-<version> and .../puppeteer-core-<version>
#   FIREFOX_CACHE=/some/dir scripts/setup-firefox.sh
#   node tests/web/firefox.js            # then finds both there
#
# Playwright's Firefox needs Playwright's own patched build, which the tests do not install (never run
# `playwright install`). firefox.js drives a stock Firefox instead, over WebDriver BiDi with puppeteer-core.
#
# Firefox comes from archive.mozilla.org (the release's tarball for Linux x86-64, en-US), checked against the
# SHA-256 pinned below (Mozilla's SHA256SUMS for the release has the same value); download.mozilla.org is the
# fallback. puppeteer-core comes from npm with `npm ci`: tests/web/firefox-deps/ holds the package.json and the
# package-lock.json that pin it and every dependency (PUPPETEER_SKIP_DOWNLOAD: it downloads no browser).
# Both go outside the worktree, so several worktrees share them; a second run does nothing.
#
# On Arch the packaged Firefox works too: FIREFOX=/usr/bin/firefox node tests/web/firefox.js (puppeteer-core is
# still needed: this script installs it, and with --no-firefox it installs only that).
set -euo pipefail

FIREFOX_VERSION="160.0"
FIREFOX_SHA256="fde774e9757c8878534c05ec210db592bf6a1b244c57941ffb2e364c04f35fcd"   # linux-x86_64/en-US/firefox-160.0.tar.xz
PUPPETEER_VERSION="25.17.0"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${FIREFOX_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/jfsw-browser}"
FF_DIR="$CACHE/firefox-$FIREFOX_VERSION"
PP_DIR="$CACHE/puppeteer-core-$PUPPETEER_VERSION"

WITH_FIREFOX=1
for arg in "$@"; do
    case "$arg" in
        --no-firefox) WITH_FIREFOX=0 ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
done

if [ "$WITH_FIREFOX" = 1 ]; then
    if [ -x "$FF_DIR/firefox/firefox" ]; then
        echo "Firefox $FIREFOX_VERSION: already in $FF_DIR"
    else
        mkdir -p "$CACHE"
        tmp="$(mktemp -d "$CACHE/.firefox-XXXXXX")"
        trap 'rm -rf "$tmp"' EXIT
        tarball="$tmp/firefox-$FIREFOX_VERSION.tar.xz"
        ok=0
        for url in "https://archive.mozilla.org/pub/firefox/releases/$FIREFOX_VERSION/linux-x86_64/en-US/firefox-$FIREFOX_VERSION.tar.xz" \
                   "https://download.mozilla.org/?product=firefox-$FIREFOX_VERSION&os=linux64&lang=en-US"; do
            echo "Fetching $url"
            if curl -fsSL --retry 3 -o "$tarball" "$url"; then ok=1; break; fi
        done
        [ "$ok" = 1 ] || { echo "setup-firefox: could not download Firefox $FIREFOX_VERSION" >&2; exit 1; }
        got="$(sha256sum "$tarball" | cut -d' ' -f1)"
        if [ "$got" != "$FIREFOX_SHA256" ]; then
            echo "setup-firefox: SHA-256 mismatch: $got, expected $FIREFOX_SHA256" >&2
            exit 1
        fi
        mkdir -p "$tmp/unpacked"
        tar -xJf "$tarball" -C "$tmp/unpacked"
        [ -x "$tmp/unpacked/firefox/firefox" ] || { echo "setup-firefox: no firefox/firefox in the tarball" >&2; exit 1; }
        rm -rf "$FF_DIR"
        mv "$tmp/unpacked" "$FF_DIR"
        echo "Firefox $FIREFOX_VERSION: installed in $FF_DIR"
    fi
    "$FF_DIR/firefox/firefox" --version || true
fi

DEPS="$root/tests/web/firefox-deps"
if [ -f "$PP_DIR/node_modules/puppeteer-core/package.json" ] && cmp -s "$DEPS/package-lock.json" "$PP_DIR/package-lock.json"; then
    echo "puppeteer-core $PUPPETEER_VERSION: already in $PP_DIR"
else
    command -v npm >/dev/null || { echo "setup-firefox: npm is needed for puppeteer-core" >&2; exit 1; }
    mkdir -p "$PP_DIR"
    cp "$DEPS/package.json" "$DEPS/package-lock.json" "$PP_DIR/"
    (cd "$PP_DIR" && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund >/dev/null)
    echo "puppeteer-core $PUPPETEER_VERSION: installed in $PP_DIR (npm ci, from tests/web/firefox-deps/package-lock.json)"
fi
