#!/usr/bin/env python3
# Runs the commands of one of deploy.md's command blocks and compares what they print with the answers the guide
# gives under each one (brief 06; used by check-deploy.sh). The block comes on standard input:
#
#   command [\ continuation lines]
#   #   expected line                      one per line of output that must appear (case-insensitive; "..." matches anything)
#   #   (a remark in brackets)             not compared
#
# Every expected line must match one line of the command's output, in any order. Arguments: pairs FROM TO of plain
# text replaced in the commands and the expected lines (check-deploy.sh --no-tls: https://game.example.org -> http://...).
# Prints "ok:" / "FAIL:" lines like check-deploy.sh; the exit status is the number of failures.
import re
import subprocess
import sys

subs = list(zip(sys.argv[1::2], sys.argv[2::2]))


def sub(t):
    for a, b in subs:
        t = t.replace(a, b)
    return t


cmds = []          # [command text, [expected lines]]
cur = None
cont = False
for raw in sys.stdin.read().splitlines():
    line = raw.rstrip()
    if cont:
        cur[0] += '\n' + line
        cont = line.endswith('\\')
        continue
    if not line.strip():
        continue
    m = re.match(r'^#\s{1,}(.*)$', line)
    if m:
        exp = m.group(1).strip()
        if cur is not None and exp and not exp.startswith('('):
            cur[1].append(exp)
        continue
    cur = [line, []]
    cmds.append(cur)
    cont = line.endswith('\\')

fails = 0
for cmd, exps in cmds:
    cmd = sub(cmd)
    exps = [sub(e) for e in exps]
    try:
        out = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True, timeout=30).stdout
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
    lines = [l.rstrip('\r') for l in out.splitlines()]
    short = ' '.join(cmd.split())[:110]
    if not exps:
        print('FAIL: the guide gives no expected answer for: ' + short)
        fails += 1
        continue
    missing = []
    for e in exps:
        pat = re.escape(e).replace(re.escape('...'), '.*')
        if not any(re.fullmatch(pat, l.strip(), re.I) for l in lines):
            missing.append(e)
    if missing:
        fails += 1
        print('FAIL: ' + short + ': expected ' + ' | '.join(missing) + '; got: ' + ' | '.join(lines)[:300])
    else:
        print('ok:   ' + short + ' -> ' + ' | '.join(exps))
sys.exit(min(fails, 100))
