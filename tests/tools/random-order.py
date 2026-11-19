#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Finds every place where the game draws two or more numbers from the simulation's random generator in one full
# expression, where the C standard leaves the order of evaluation open (bugs.md L35, doco/browser/F5-random-arg-order.md).
#
#   tests/tools/random-order.py              # scans src/*.c with clang's AST; prints the sites; exit 1 if there are any
#   tests/tools/random-order.py FILE.c ...   # only these files
#   tests/tools/random-order.py -v           # also lists what the scan looked at but does not count (see below)
#
# The simulation's (synced) generator is krand1() (game.c; krand2() in a RANDOM_DEBUG build). RANDOM(), RANDOM_P2(),
# RANDOM_RANGE() (-> RandomRange()), RANDOM_NEG() and SCALE_POINT_SPEED all end there. A random call is a call of
# krand1() or krand2(), or of a function that calls one of them, directly or not (RandomRange(), a spawn function, ...).
# A combination of two such calls is a bug when the standard does not sequence them:
#   * two arguments of one call, or an argument and the called function's own expression,
#   * the two operands of a binary operator other than && || and the comma, and of an assignment (also compound),
#   * two operands of an array subscript, two elements of an initialiser list.
# Not a bug: the condition of ?: against its branches, && || and , (sequenced), separate statements, separate
# declarators of one declaration (each is a full expression), and a call that runs after its arguments are all
# evaluated (f(RANDOM()) with f drawing numbers itself is fine: the argument is evaluated first).
# The cure is to draw each number into a local, in the order you mean, in statements of their own (code-facts.md 24).
#
# Listed with -v, not counted: (a) the same combinations made of calls of the other generator, STD_RANDOM*(), StdRandomRange(),
# rand(): it is the local, not synced, one (draw code, sounds, bots), so its order cannot desync a game; (b) a draw and a call
# through a function pointer in one expression ("possible"): the pointer's target is not known, the sites are read by hand.
#
# Needs clang (the AST comes from `clang -Xclang -ast-dump=json`), python3 and the SDL2 and GTK3 headers (sdl2-config,
# pkg-config); about 30 seconds for all of src/ (part of `make test`). Without clang it prints NOT RUN and exits 3; a file
# that was asked for and could not be compiled is exit 1. A single FILE.c is scanned alone: the functions that draw numbers
# through others are only known from the files given, so scan all of src/ for a verdict.
import glob, json, os, shutil, subprocess, sys, threading

sys.setrecursionlimit(200000)
threading.stack_size(512 * 1024 * 1024)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SEQUENCED_OPS = {'&&', '||', ','}
SYNCED = {'krand1', 'krand2', 'RandomRange'}   # RandomRange() is defined in game.c; named so that a scan of one file knows it too
LOCAL = {'rand', 'StdRandomRange'}


def flags():
    f = ['-fsyntax-only', '-w', '-std=c99', '-Isrc', '-Ijfbuild/include', '-Ijfmact', '-Ijfaudiolib/include',
         '-DRENDERTYPESDL=1', '-DUSE_POLYMOST=1', '-DUSE_OPENGL=1', '-DHAVE_GTK', '-DDATADIR="/x"']
    for cmd in ('sdl2-config --cflags', 'pkg-config --cflags gtk+-3.0'):
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if r.returncode == 0:
            f += r.stdout.split()
    # RANDOM_ORDER_CFLAGS: more compiler flags (for example -DDEBUG=1, to look at the code that build compiles in)
    return f + os.environ.get('RANDOM_ORDER_CFLAGS', '').split()


class Scan:
    def __init__(self):
        self.st = {'file': None, 'line': 0}
        self.funcs = {}      # function name -> names it calls
        self.cands = []      # (file, line, function, [sets of callee names, one per operand that has calls])

    def loc(self, l):
        # clang prints a location's file and line only when they changed since the last one printed
        if not isinstance(l, dict):
            return None
        if 'spellingLoc' in l or 'expansionLoc' in l:
            self.loc(l.get('spellingLoc'))
            return self.loc(l.get('expansionLoc'))
        if 'file' in l:
            self.st['file'] = l['file']
        if 'line' in l:
            self.st['line'] = l['line']
        return (self.st['file'], self.st['line'])

    @staticmethod
    def callee(n):
        def find(x):
            if x.get('kind') == 'DeclRefExpr':
                r = x.get('referencedDecl', {})
                return r.get('name') if r.get('kind') == 'FunctionDecl' else '<ptr>'
            for c in x.get('inner', []):
                r = find(c)
                if r:
                    return r
            return None
        inn = n.get('inner', [])
        return (find(inn[0]) if inn else None) or '<indirect>'

    def walk(self, n, fname):
        k = n.get('kind')
        l0 = self.loc(n['loc']) if 'loc' in n else None
        b = None
        if n.get('range'):
            b = self.loc(n['range'].get('begin'))
            self.loc(n['range'].get('end'))
        pos = b or l0 or (None, self.st['line'])
        isdef = k == 'FunctionDecl' and any(c.get('kind') == 'CompoundStmt' for c in n.get('inner', []))
        if isdef:
            fname = n.get('name')
        if k == 'UnaryExprOrTypeTraitExpr':
            # sizeof(expr) does not evaluate expr
            return set()
        kids = [self.walk(c, fname) for c in n.get('inner', [])]
        s = set()
        for x in kids:
            s |= x
        if k == 'CallExpr':
            s.add(self.callee(n))
        if isdef:
            self.funcs.setdefault(fname, set()).update(s)
        comb = k in ('CallExpr', 'InitListExpr', 'ArraySubscriptExpr') or \
            (k in ('BinaryOperator', 'CompoundAssignOperator') and n.get('opcode') not in SEQUENCED_OPS)
        if comb and fname and sum(1 for x in kids if x) >= 2:
            self.cands.append((pos[0], pos[1], fname, k, [x for x in kids if x]))
        return s


def scan_file(path, fl):
    p = subprocess.run(['clang', '-Xclang', '-ast-dump=json'] + fl + [path], cwd=ROOT, capture_output=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode('utf8', 'replace')[-2000:])
        return None
    out = {}

    def main():
        s = Scan()
        d = json.loads(p.stdout)
        for top in d.get('inner', []):
            s.walk(top, None)
        out['s'] = s
    t = threading.Thread(target=main)
    t.start()
    t.join()
    return out['s']


def closure(funcs, base):
    drawing = set(base)
    grew = True
    while grew:
        grew = False
        for k, v in funcs.items():
            if k not in drawing and v & drawing:
                drawing.add(k)
                grew = True
    return drawing


def main():
    args = [a for a in sys.argv[1:] if a != '-v']
    verbose = '-v' in sys.argv[1:]
    if not shutil.which('clang'):
        print('random-order: NOT RUN: clang not found')
        return 3
    if args:
        files = args
    else:
        # src/startwin_game.c is the Windows start-up window: it needs windows.h and cannot be compiled here
        files = [f for f in sorted(glob.glob(os.path.join(ROOT, 'src', '*.c'))) if os.path.basename(f) != 'startwin_game.c']
    files = [os.path.relpath(os.path.abspath(f), ROOT) for f in files]
    fl = flags()
    funcs, cands, failed = {}, [], []
    for f in files:
        s = scan_file(f, fl) if os.path.isfile(os.path.join(ROOT, f)) else None
        if s is None:
            failed.append(f)
            continue
        for k, v in s.funcs.items():
            funcs.setdefault(k, set()).update(v)
        cands += s.cands
    if failed or not files:
        # a file that was asked for and did not compile was not scanned: that is a failure, not a pass
        print('random-order: FAILED: could not scan %s' % (', '.join(failed) if failed else 'anything (no files)'))
        return 1
    synced = closure(funcs, SYNCED)
    local = closure(funcs, LOCAL)
    sites, localsites, possible = {}, {}, {}
    for file, line, fname, kind, kids in cands:
        key = (file, line, fname)
        ns = sum(1 for k in kids if k & synced)
        if ns >= 2:
            sites[key] = kind
        elif ns == 1 and any(k & {'<indirect>', '<ptr>'} for k in kids if not (k & synced)):
            possible[key] = kind
        if sum(1 for k in kids if k & local) >= 2:
            localsites[key] = kind
    for (file, line, fname), kind in sorted(sites.items()):
        print('%s:%d: %s(): two or more random numbers drawn in one expression (%s), in no fixed order' % (file, line, fname, kind))
    if verbose:
        for (file, line, fname), kind in sorted(possible.items()):
            print('%s:%d: %s(): possible: a random draw and a call through a pointer in one expression (%s)' % (file, line, fname, kind))
        for (file, line, fname), kind in sorted(localsites.items()):
            print('%s:%d: %s(): local (not synced) generator: two draws in one expression (%s)' % (file, line, fname, kind))
    print('random-order: %d site(s) in %d file(s)%s' % (len(sites), len(files),
          ' (not counted: %d possible with a pointer call, %d with the local generator)' % (len(possible), len(localsites)) if verbose else ''))
    return 1 if sites else 0


if __name__ == '__main__':
    sys.exit(main())
