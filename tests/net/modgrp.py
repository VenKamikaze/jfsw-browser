#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Brief 05b: make a modified copy of the shareware GRP for the tests (never committed; the tests make
# it at run time from testdata/swshare.grp). Prints the copy's CRC32 (8 hex digits, upper case).
#
#   tests/net/modgrp.py map IN OUT          # E1L1 ($BULLET.MAP): deathmatch starts 2 and 3 turned by 90 degrees
#   tests/net/modgrp.py registered IN OUT   # SHADSW.BIN renamed SWREG.BIN: the game takes it for registered data
#
# Either way grpscan.c no longer knows the file (its CRC is not in the table), so the game reports it as
# "unknown data, CRC ...".
import struct
import sys
import zlib


def entries(f):
    n = struct.unpack('<I', f[12:16])[0]
    off = 16 + 16 * n
    for i in range(n):
        name = bytes(f[16 + 16 * i:28 + 16 * i]).rstrip(b'\0')
        size = struct.unpack('<I', f[28 + 16 * i:32 + 16 * i])[0]
        yield i, name, off, size
        off += size


def turn_starts(f):
    for _, name, m, _ in entries(f):
        if name == b'$BULLET.MAP':
            break
    else:
        sys.exit('no $BULLET.MAP')
    p = m + 20
    ns = struct.unpack('<H', f[p:p + 2])[0]; p += 2 + 40 * ns
    nw = struct.unpack('<H', f[p:p + 2])[0]; p += 2 + 32 * nw
    nsp = struct.unpack('<H', f[p:p + 2])[0]; p += 2
    turned = 0
    for k in range(nsp):
        s = p + 44 * k
        pic = struct.unpack('<h', f[s + 14:s + 16])[0]
        lo, hi = struct.unpack('<hh', f[s + 38:s + 42])
        if pic == 2307 and hi == 42 and lo in (2, 3):       # ST1, MULTI_PLAYER_START
            ang = struct.unpack('<h', f[s + 28:s + 30])[0]
            f[s + 28:s + 30] = struct.pack('<h', (ang + 512) & 2047)
            turned += 1
    if turned != 2:
        sys.exit('expected two deathmatch starts to turn, found %d' % turned)


def registered(f):
    for i, name, _, _ in entries(f):
        if name == b'SHADSW.BIN':
            f[16 + 16 * i:28 + 16 * i] = b'SWREG.BIN'.ljust(12, b'\0')
            return
    sys.exit('no SHADSW.BIN')


mode, src, dst = sys.argv[1:4]
f = bytearray(open(src, 'rb').read())
if f[:12] != b'KenSilverman':
    sys.exit('not a GRP: ' + src)
{'map': turn_starts, 'registered': registered}[mode](f)
open(dst, 'wb').write(f)
print('%08X' % (zlib.crc32(bytes(f)) & 0xffffffff))
