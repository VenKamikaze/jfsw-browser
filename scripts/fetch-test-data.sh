#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Fetch and verify the Shadow Warrior shareware 1.2 data used for testing.
#
#   scripts/fetch-test-data.sh                   # -> testdata/swshare.grp
#   scripts/fetch-test-data.sh --dest DIR        # write DIR/swshare.grp instead
#   scripts/fetch-test-data.sh --from-zip FILE   # use a local 3dsw12.zip, no download
#   scripts/fetch-test-data.sh --md5 HEX         # expected MD5 of the zip (tests only)
#
# Downloads 3dsw12.zip from the official 3D Realms archive (falling back to
# archive.org), checks its MD5, unzips SWSW12.SHR from it and sw.grp from that, and
# checks the GRP against the "Shareware Version" entry of src/grpscan.c: CRC32
# 0x08A7FA1F, 26,056,769 bytes. Everything is built in a temporary directory beside
# the destination and moved into place only when every check has passed, so an
# unverified file is never left at the destination (an invalid file that is already
# there is removed). Does nothing when a valid file is already there. Exits non-zero
# on any failure. testdata/ is git-ignored: game data is never committed.
set -euo pipefail

URLS=(
    "https://image.dosgamesarchive.com/games/3dsw12.zip"
    "https://archive.org/download/3dsw12/3dsw12.zip"
)
ZIP_MD5="d77564e8764feeb1509dd0d534fb8952"
GRP_NAME="swshare.grp"
GRP_CRC="08a7fa1f"
GRP_SIZE=26056769

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/testdata"
from_zip=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dest) [ $# -ge 2 ] || { echo "--dest needs a directory" >&2; exit 2; }; dest="$2"; shift 2 ;;
        --from-zip) [ $# -ge 2 ] || { echo "--from-zip needs a file" >&2; exit 2; }; from_zip="$2"; shift 2 ;;
        --md5) [ $# -ge 2 ] || { echo "--md5 needs a hex string" >&2; exit 2; }; ZIP_MD5="$2"; shift 2 ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

die() { echo "fetch-test-data: $*" >&2; exit 1; }

# crc32 of a file as 8 lower-case hex digits
crc32_of() {
    python3 -I -c 'import sys, zlib
c = 0
with open(sys.argv[1], "rb") as f:
    for b in iter(lambda: f.read(1 << 20), b""):
        c = zlib.crc32(b, c)
print("%08x" % (c & 0xffffffff))' "$1"
}

size_of() { wc -c < "$1" | tr -d ' '; }

# 0 when $1 is the verified shareware GRP
grp_ok() {
    [ -f "$1" ] && [ "$(size_of "$1")" = "$GRP_SIZE" ] && [ "$(crc32_of "$1")" = "$GRP_CRC" ]
}

need=(unzip python3 md5sum mktemp)
[ -n "$from_zip" ] || need+=(curl)
for t in "${need[@]}"; do
    command -v "$t" >/dev/null 2>&1 || die "$t is required but not installed (scripts/setup.sh installs it)"
done

mkdir -p "$dest"
# leftovers of a run that was killed (the only run using this directory, we assume)
rm -rf "$dest"/.fetch.??????
out="$dest/$GRP_NAME"

if [ -e "$out" ]; then
    if grp_ok "$out"; then
        echo "$out is already there and verified (CRC32 0x${GRP_CRC^^}, $GRP_SIZE bytes)"
        exit 0
    fi
    echo "removing $out: it is not the shareware GRP" >&2
    rm -f "$out"
fi

tmp="$(mktemp -d "$dest/.fetch.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

zip="$tmp/3dsw12.zip"
if [ -n "$from_zip" ]; then
    [ -f "$from_zip" ] || die "$from_zip does not exist"
    cp "$from_zip" "$zip"
    have="$(md5sum "$zip" | cut -d' ' -f1)"
    [ "$have" = "$ZIP_MD5" ] || die "MD5 of the zip is $have, expected $ZIP_MD5"
else
    got=0
    for url in "${URLS[@]}"; do
        echo "downloading $url"
        if curl -fsSL --retry 2 --connect-timeout 20 -o "$zip" "$url"; then
            have="$(md5sum "$zip" | cut -d' ' -f1)"
            if [ "$have" = "$ZIP_MD5" ]; then
                got=1
                break
            fi
            echo "MD5 of the download from $url is $have, expected $ZIP_MD5" >&2
        else
            echo "failed: $url" >&2
        fi
    done
    [ "$got" = 1 ] || die "could not download a verified 3dsw12.zip from any URL"
fi

unzip -C -p "$zip" SWSW12.SHR > "$tmp/SWSW12.SHR" || die "SWSW12.SHR is not in the zip (or it is damaged)"
unzip -C -p "$tmp/SWSW12.SHR" sw.grp > "$tmp/$GRP_NAME" || die "sw.grp is not in SWSW12.SHR (or it is damaged)"

[ "$(size_of "$tmp/$GRP_NAME")" = "$GRP_SIZE" ] || die "sw.grp is $(size_of "$tmp/$GRP_NAME") bytes, expected $GRP_SIZE"
have="$(crc32_of "$tmp/$GRP_NAME")"
[ "$have" = "$GRP_CRC" ] || die "CRC32 of sw.grp is 0x${have^^}, expected 0x${GRP_CRC^^}"

mv "$tmp/$GRP_NAME" "$out"
echo "wrote $out (CRC32 0x${GRP_CRC^^}, $GRP_SIZE bytes, Shareware Version)"
