#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Tests for scripts/fetch-test-data.sh.
#
#   tests/fetch-test-data.sh [PATH/TO/3dsw12.zip]
#
# The zip comes from the argument, then $JFSW_TEST_ZIP, then a download (the same
# URLs as the script). Everything else is built in a temporary directory.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/fetch-test-data.sh"
work="$(mktemp -d)" || { echo "mktemp failed" >&2; exit 2; }
[ -n "$work" ] && [ -d "$work" ] || exit 2
trap 'rm -rf -- "$work"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

# check NAME  EXPECTED_STATUS(0|nonzero)  DIR  [script args...]
# runs the script, keeps its output in $out, and checks the exit status
run() {
    out="$("$script" "$@" 2>&1)"
    rc=$?
}
expect_rc0()  { [ "$rc" = 0 ] && ok "$1" || { bad "$1 (exit $rc)"; echo "$out" | sed 's/^/       /'; }; }
expect_fail() { [ "$rc" != 0 ] && ok "$1 (exit $rc)" || { bad "$1 (exited 0)"; echo "$out" | sed 's/^/       /'; }; }
expect_msg()  { case "$out" in *"$2"*) ok "$1: message mentions '$2'" ;; *) bad "$1: message lacks '$2'"; echo "$out" | sed 's/^/       /' ;; esac; }
# nothing in DIR except (maybe) nothing: no swshare.grp, no .fetch.* leftovers
expect_empty() {
    if [ -z "$(ls -A "$2")" ]; then ok "$1: nothing left in the destination"
    else bad "$1: destination holds: $(ls -A "$2" | tr '\n' ' ')"; fi
}

# ---- the zip ----
zip="${1:-${JFSW_TEST_ZIP:-}}"
if [ -z "$zip" ]; then
    zip="$work/3dsw12.zip"
    curl -fsSL --retry 2 -o "$zip" https://image.dosgamesarchive.com/games/3dsw12.zip ||
        curl -fsSL --retry 2 -o "$zip" https://archive.org/download/3dsw12/3dsw12.zip ||
        { echo "no zip given and the download failed" >&2; exit 2; }
fi
[ "$(md5sum "$zip" | cut -d' ' -f1)" = d77564e8764feeb1509dd0d534fb8952 ] ||
    { echo "$zip is not the expected 3dsw12.zip (MD5 d77564e8764feeb1509dd0d534fb8952)" >&2; exit 2; }

# ---- the constants agree with src/grpscan.c ----
line="$(grep '"Shareware Version"' "$root/src/grpscan.c")"
crc="$(echo "$line" | sed -n 's/.*0x\([0-9A-Fa-f]*\), *\([0-9]*\),.*/\1/p' | tr A-F a-f)"
size="$(echo "$line" | sed -n 's/.*0x\([0-9A-Fa-f]*\), *\([0-9]*\),.*/\2/p')"
[ "$crc" = "$(sed -n 's/^GRP_CRC="\(.*\)"/\1/p' "$script")" ] && [ "$size" = "$(sed -n 's/^GRP_SIZE=\(.*\)/\1/p' "$script")" ] &&
    ok "script's CRC32 and size match src/grpscan.c ($crc, $size)" ||
    bad "script's CRC32/size differ from src/grpscan.c ($crc, $size)"

# ---- 1. good case ----
d="$work/good"
run --dest "$d" --from-zip "$zip"
expect_rc0 "good zip"
if [ -f "$d/swshare.grp" ] && [ "$(wc -c < "$d/swshare.grp")" = 26056769 ]; then ok "good zip: swshare.grp has the right size"; else bad "good zip: swshare.grp missing or wrong size"; fi
[ "$(ls -A "$d")" = swshare.grp ] && ok "good zip: only swshare.grp in the destination" || bad "good zip: destination holds: $(ls -A "$d" | tr '\n' ' ')"

# ---- 2. second run is a no-op (and needs no zip at all) ----
before="$(stat -c '%i %Y' "$d/swshare.grp")"
run --dest "$d" --from-zip "$work/does-not-exist.zip"
expect_rc0 "second run"
expect_msg "second run" "already there"
[ "$before" = "$(stat -c '%i %Y' "$d/swshare.grp")" ] && ok "second run: file untouched" || bad "second run: file was rewritten"

# ---- 3. truncated zip ----
d="$work/trunc"
head -c $(( $(wc -c < "$zip") / 2 )) "$zip" > "$work/trunc.zip"
run --dest "$d" --from-zip "$work/trunc.zip"
expect_fail "truncated zip"
expect_msg "truncated zip" "MD5"
expect_empty "truncated zip" "$d"

# ---- 4. one flipped byte ----
d="$work/flip"
python3 -I - "$zip" "$work/flip.zip" <<'PY'
import sys
b = bytearray(open(sys.argv[1], "rb").read())
b[len(b) // 2] ^= 0x01
open(sys.argv[2], "wb").write(b)
PY
run --dest "$d" --from-zip "$work/flip.zip"
expect_fail "zip with one flipped byte"
expect_msg "flipped byte" "MD5"
expect_empty "flipped byte" "$d"

# ---- 5. right size, wrong CRC (a fake zip with the matching MD5 passed in) ----
fake() { # fake OUT.zip GRPSIZE : SWSW12.SHR (a zip) holding sw.grp of that size
    python3 -I - "$1" "$2" <<'PY'
import io, sys, zipfile
out, size = sys.argv[1], int(sys.argv[2])
grp = bytes(size - 1) + b"\x01"           # zeros, so it compresses; not the real GRP
inner = io.BytesIO()
with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("SW.GRP", grp)
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    z.writestr("SWSW12.SHR", inner.getvalue())
PY
}
d="$work/crc"
fake "$work/badcrc.zip" 26056769
run --dest "$d" --from-zip "$work/badcrc.zip" --md5 "$(md5sum "$work/badcrc.zip" | cut -d' ' -f1)"
expect_fail "GRP of the right size and the wrong CRC"
expect_msg "wrong CRC" "CRC32"
expect_empty "wrong CRC" "$d"

# ---- 6. wrong size ----
d="$work/size"
fake "$work/badsize.zip" 1000
run --dest "$d" --from-zip "$work/badsize.zip" --md5 "$(md5sum "$work/badsize.zip" | cut -d' ' -f1)"
expect_fail "GRP of the wrong size"
expect_msg "wrong size" "bytes"
expect_empty "wrong size" "$d"

# ---- 7. a bad file already at the destination is removed on failure, replaced on success ----
d="$work/stale"
mkdir -p "$d"
cp "$work/good/swshare.grp" "$d/swshare.grp"
printf 'x' | dd of="$d/swshare.grp" bs=1 seek=100 conv=notrunc 2>/dev/null   # one byte changed, same size
run --dest "$d" --from-zip "$work/trunc.zip"
expect_fail "stale bad GRP, bad zip"
expect_empty "stale bad GRP, bad zip" "$d"
cp "$work/good/swshare.grp" "$d/swshare.grp"
printf 'x' | dd of="$d/swshare.grp" bs=1 seek=100 conv=notrunc 2>/dev/null
run --dest "$d" --from-zip "$zip"
expect_rc0 "stale bad GRP, good zip"
cmp -s "$d/swshare.grp" "$work/good/swshare.grp" && ok "stale bad GRP replaced by the verified one" || bad "stale bad GRP was not replaced"

# ---- 8. leftovers of a killed run are cleaned up ----
d="$work/stale2"
mkdir -p "$d/.fetch.abc123"; echo junk > "$d/.fetch.abc123/3dsw12.zip"
run --dest "$d" --from-zip "$zip"
expect_rc0 "run after a killed run"
[ ! -e "$d/.fetch.abc123" ] && ok "stale .fetch.* directory removed" || bad "stale .fetch.* directory left"

# ---- 9. a missing tool is reported up front and a valid GRP is not deleted ----
bin="$work/bin"; mkdir -p "$bin"
for t in bash env dirname basename cat sed tr cut wc rm mkdir mktemp cp mv md5sum unzip ls head; do
    p="$(command -v "$t")" && ln -sf "$p" "$bin/$t"
done
d="$work/notool"; mkdir -p "$d"; cp "$work/good/swshare.grp" "$d/swshare.grp"
out="$(PATH="$bin" "$BASH" "$script" --dest "$d" --from-zip "$zip" 2>&1)"; rc=$?
expect_fail "python3 missing"
expect_msg "python3 missing" "python3 is required"
[ -f "$d/swshare.grp" ] && ok "python3 missing: the valid GRP is still there" || bad "python3 missing: the GRP was deleted"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
