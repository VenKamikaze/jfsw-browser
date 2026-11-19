#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Shows in which order a compiler really draws the random numbers of a place, from the assembly it makes (F5,
# doco/browser/F5-random-arg-order.md, code-facts.md 24).
#
#   tests/tools/random-asm-order.py [-C TREE] [--cc gcc|clang] [--levels O0,Og,O1,O2,O3,Os] [-l LINE,LINE...] FILE.c [FILE.c ...]
#   tests/tools/random-asm-order.py [...] -f FUNCTION [-f ...] FILE.c
#
# A scratch copy of TREE's src/ (default: this tree) gets RANDOM(), RANDOM_P2() and RANDOM_RANGE() redefined as calls of
# rndid(range, __LINE__, __COUNTER__): every use of one of them, wherever the macro came from, gets its own number, in the order of
# the text. Each FILE.c is compiled to assembly at each level, and the calls of rndid() are read from it in the order they are made:
# the numbers show which draw the compiler made first. Prints, for every function and source line in which two or more draws
# are made (with -l: for these lines), the numbers in the order of the calls: "text order" when they rise (the first operand
# first), "reverse" when they fall, "mixed". For the sites that random-order.py finds, give their lines. A line with an if, && or ||
# has two draws that are sequenced, and the compiler may lay their code out in any order: those are not sites.
# With -f NAME (repeatable) it prints the whole sequence of draws of that function instead, and whether it rises (exit
# status 1 when it does not): for code that draws into locals.
# gcc 13 on x86-64 draws the first operand of a - first, at every level (code-facts.md 24); clang does too.
import argparse, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def flags():
    f = ['-Isrc', '-Ijfbuild/include', '-Ijfmact', '-Ijfaudiolib/include', '-DRENDERTYPESDL=1', '-DUSE_POLYMOST=1',
         '-DUSE_OPENGL=1', '-DDATADIR="/x"', '-w', '-std=c99', '-fno-strict-aliasing']
    r = subprocess.run('sdl2-config --cflags', shell=True, capture_output=True, text=True)
    return f + (r.stdout.split() if r.returncode == 0 else [])


def calls(asm):
    func, win, out = None, [], []
    for ln in open(asm):
        s = ln.strip()
        m = re.match(r'^([A-Za-z_][\w.]*):\s*(#.*)?$', s)
        if m and not m.group(1).startswith('.L'):
            func, win = m.group(1), []
            continue
        if not s or s.startswith('.'):
            continue
        if re.match(r'callq?\s+rndid', s):
            regs = {}
            for w in win[-30:]:
                mm = re.match(r'mov[lq]?\s+\$(-?\d+),\s*%(\w+)', w)
                if mm:
                    regs[mm.group(2)] = int(mm.group(1))
            out.append((func, regs.get('esi'), regs.get('edx')))
            win = []
        else:
            win.append(s)
    return out


def verdict(seq):
    if all(a < b for a, b in zip(seq, seq[1:])):
        return 'text order'
    if all(a > b for a, b in zip(seq, seq[1:])):
        return 'reverse'
    return 'mixed'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-C', dest='tree', default=ROOT)
    ap.add_argument('--cc', default='gcc')
    ap.add_argument('--levels', default='O0,Og,O1,O2,O3,Os')
    ap.add_argument('-f', dest='funcs', action='append', default=[])
    ap.add_argument('-l', dest='lines', default='', help='only these source lines (comma separated)')
    ap.add_argument('files', nargs='+')
    a = ap.parse_args()
    if not shutil.which(a.cc):
        print('random-asm-order: NOT RUN: %s not found' % a.cc)
        return 3
    tmp = tempfile.mkdtemp(prefix='random-asm-')
    try:
        for d in ('src', 'jfbuild/include', 'jfmact', 'jfaudiolib/include'):
            shutil.copytree(os.path.join(a.tree, d), os.path.join(tmp, d), ignore=shutil.ignore_patterns('*.o', '*.a'))
        gh = os.path.join(tmp, 'src', 'game.h')
        t = open(gh).read()
        for old, new in (('(MOD_P2(krand1(),(pwr_of_2)))', '(MOD_P2(rndid(1,__LINE__,__COUNTER__),(pwr_of_2)))'),
                         ('(RandomRange(range))', '(rndid(range,__LINE__,__COUNTER__))'),
                         ('#define RANDOM() (krand1())', '#define RANDOM() (rndid(0,__LINE__,__COUNTER__))')):
            if old not in t:
                print('random-asm-order: game.h does not have %s' % old)
                return 1
            t = t.replace(old, new)
        t = t.replace('#if RANDOM_DEBUG\nint RandomRange', 'int rndid(int,int,int);\n#if RANDOM_DEBUG\nint RandomRange', 1)
        open(gh, 'w').write(t)
        bad = 0
        for f in a.files:
            for lv in a.levels.split(','):
                asm = os.path.join(tmp, 'x.s')
                p = subprocess.run([a.cc] + flags() + ['-fomit-frame-pointer', '-' + lv, '-S', os.path.join('src', os.path.basename(f)), '-o', asm],
                                   cwd=tmp, capture_output=True, text=True)
                if p.returncode != 0:
                    print('random-asm-order: %s -%s failed:\n%s' % (f, lv, p.stderr[-1500:]))
                    return 1
                cs = calls(asm)
                if a.funcs:
                    for fn in a.funcs:
                        seq = [c[2] for c in cs if c[0] == fn]
                        print('%s %s -%s %s(): %d draws %s: %s' % (a.cc, f, lv, fn, len(seq), seq[:12] if len(seq) > 12 else seq, verdict(seq)))
                        bad += verdict(seq) != 'text order'
                else:
                    by = {}
                    for fn, line, c in cs:
                        by.setdefault((fn, line), []).append(c)
                    want = set(int(x) for x in a.lines.split(',') if x)
                    for (fn, line), seq in sorted(by.items(), key=lambda kv: (kv[0][0], kv[0][1] or 0)):
                        if len(seq) >= 2 and (not want or line in want):
                            print('%s %s -%s %s():%s draws %s: %s' % (a.cc, f, lv, fn, line, seq, verdict(seq)))
        return 1 if bad else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
