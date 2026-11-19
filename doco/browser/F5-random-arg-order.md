# F5: The order of two random draws is left to the compiler (L35)

## Goal

Every compiler gives the game the same random numbers in the same order. In `DoRail()` and `SpawnGrenadeExp()` (`src/weapon.c`) two `RANDOM_RANGE()` results are the operands of one `-`, six statements in all. Both calls advance the one synced seed, so which is evaluated first decides both values, and the C standard does not say which comes first. The fix draws each number into a local in a statement of its own, in the order **gcc and clang use** (first operand first), so that native Linux games and demos stay bit for bit as they are and a build made with any other compiler or target agrees with them. The fix is small, upstream-friendly, on a branch from `master`, and goes into `claude` through an integration branch, as F3 and F4 did. No pull request is opened.

The user asked for this on 19 Nov 2026, after the same fix (D15) went into the sister port jfDuke3D (`jfduke3d-browser`, `doco/browser/F-D15-krand-order.md`), where gcc and clang really do draw in different orders and a gcc-native game and the browser desynced at tic 210 of a demo.

**What turned out to be different here (read this first):** in jfSW the six statements are all a `-` of two draws, and gcc 13.3 and clang 18 on x86-64 both evaluate the first operand first, at every optimisation level (from the assembly). So the original code does **not** make gcc-native and the browser disagree; there is no desync to cure, and the new tests pass on the old code as well as on the fixed one (see the Outcome). The fix is a hardening: it removes a dependence on an unspecified order. The tests that can fail are the ones that compare against a build with the *other* order (mutations), and they do.

## Read first

- [`README.md`](README.md): "Bugs found in the original game" (the policy), "Working across repos".
- [`bugs.md`](bugs.md): L35 (this brief's entry).
- [F3](F3-level-exit-tics.md) and [F4](F4-mouse-aim-sync.md): the models for a fix brief (upstream check, fix branch from `master`, integration branch, Outcome).
- [`code-facts.md`](code-facts.md) 24 (the rule, the generators, what the compilers do), §7 and §15 (`-testdump`).
- jfduke3d-browser, branch `claude`: `doco/browser/F-D15-krand-order.md` (method, audit, Outcome), `code-facts.md` §19, commit `851cc3c` on `fix/krand-arg-order`, `tests/tools/krand-order.py` and `krand-equiv.py` (the tools adapted here).
- The code: `src/game.h` (`RANDOM_P2`, `RANDOM_RANGE`, `RANDOM`, `STD_RANDOM*`), `src/game.c` (`krand1`, `RandomRange`, `StdRandomRange`), `src/weapon.c` (`DoRail`, `SpawnGrenadeExp`), `src/sync.c` (the test hooks), `tests/web/determinism.js`.

## Scope

1. **The audit**, exhaustive: every full expression in `src/*.c` and `src/*.h` with two or more draws from the synced generator that the standard does not sequence (arguments of one call, operands of a binary operator other than `&&` `||` `,`, both sides of an assignment, subscripts, initialiser lists, macros that expand to several draws, calls whose arguments call a function that draws). Record the unsynced generator's uses as well.
2. **The fix, on `fix/random-arg-order` from `master`** (`befcdd0`, upstream `jonof/jfsw` `HEAD`): one commit, upstream style, line endings kept, a message written for upstream, the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` only. It must cherry-pick cleanly onto upstream `HEAD`.
3. **The order**: what gcc does at every site, at `-O0`, `-Og`, `-O1`, `-O2` (the native build's) and `-O3`; if it varied with the level, stop and report.
4. **Integration branch `browser/F5-random-arg-order`** from `claude`: the fix merged `--no-ff`; the tools, the test hook and the tests; this document, `bugs.md`, `code-facts.md` 24, `building.md` 6.8 and the README row.

## Out of scope

- Other order-dependent code that does not draw synced random numbers; other desyncs (L27, the sound-gated draws in `miscactr.c`, is a different bug).
- Sending anything upstream. Upstream `jonof/jfsw` `master` is still `befcdd0` (see the Outcome), so it does not have the change.
- 32-bit builds, other CPU architectures, MSVC: gcc's and clang's order were measured for x86-64 only.

## Acceptance criteria

1. **The audit is exhaustive**: a clang-AST scanner finds N sites before the fix and 0 after, and is part of `make test`.
2. **gcc's order is kept** at every site and level, and the old and new code are equivalent over every changed hunk.
3. **gcc-native is unchanged**: byte-identical state dumps before and after, over test games and demos that reach the fixed sites.
4. **Browser equals native**: gcc native against wasm, tic by tic, and the test fails when the order is reversed.
5. **No regressions**: `make test` and the relevant browser tests pass.

## The audit

Method, three independent parts, all agreeing:

1. **Candidates from clang's AST** (`tests/tools/random-order.py`). `clang -Xclang -ast-dump=json` of every `src/*.c` (all but the Windows-only `startwin_game.c`); the functions that draw from the synced generator, directly or through others, are found by a fixed point from `krand1`, `krand2` and `RandomRange` (a call of any of them is a draw); every call, binary operator (not `&&` `||` `,`), assignment, subscript and initialiser list with draws in two or more operands is a site. `sizeof` operands are not evaluated and are skipped. **6 sites before the fix, 0 after** (79 files, about 55 seconds; also 6 with `-DDEBUG=1`, which compiles in the `RANDOM_DEBUG` variant of the macros). With `-v` it also lists what it does not count: expressions with two draws from the local generator (`rand()`, `STD_RANDOM*`: none) and expressions with one draw and a call through a function pointer (none). The scanner was tried on a file of invented cases (a binary operator, call arguments, a nested function that draws, both sides of an assignment, a nested operator: found; `&&`, `||`, `,`, `?:`, separate statements and declarators, `sizeof`: not found).
2. **A text search** of every statement (comments removed, split at `;` `{` `}`) of `src/*.c` and `*.h` with two or more draw macros, for the synced and for the local generator. The only statements with two synced draws that are not sites are the macro definitions and `if` statements whose condition and body each draw (`morph.c` 351 and 431, `ripper2.c` 1041, `skel.c` 557 and 562, `weapon.c` 16672) or whose condition is `&&`/`||` (`player.c` 5440): sequenced. No statement has two draws from the local generator. The `#if 0` block in `SpawnGrenadeExp()` has its draws in statements of their own.
3. **The compilers' order, from their assembly** (`tests/tools/random-asm-order.py`, below).

### Sites (all fixed)

| # | Where (`claude` `236d092`, before the fix) | Function | Draws | What | Verdict |
|---|---|---|---|---|---|
| 1 | `weapon.c:10190`, `:10191`, `:10192` | `DoRail` | 2 each | `np->xvel += (RANDOM_RANGE(140)-RANDOM_RANGE(140));` and the same for `yvel` and `zvel`: the velocity of a rail gun puff (one puff per step of the rod, up to 128) | **fixed** |
| 2 | `weapon.c:11643`, `:11644`, `:11645` | `SpawnGrenadeExp` | 2 each | `dx += RANDOM_RANGE(1000)-RANDOM_RANGE(1000);`, `dy`, and `dz = SPRITEp_MID(sp) + RANDOM_RANGE(1000)-RANDOM_RANGE(1000);`: where the explosion of a missile with Zilla's ID is | **fixed** |

Not sites (read, nothing to fix): `RANDOM_NEG` (`bunny.c`, `ripper.c`, `ripper2.c`: one draw), `SCALE_POINT_SPEED` (`sector.h`: one draw, used only in a comment), `RandomRange()` itself (draws once, or not at all for a range of 0 or less), the statements listed under part 2, and every call that takes one draw as an argument (`f(RANDOM_RANGE(n))` with `f` drawing too: the argument is evaluated before `f` runs). No expression has a function that draws (`SpawnSprite()` and the like) next to a draw.

**The local generator** (`STD_RANDOM_RANGE()`, `STD_RANDOM_P2()`, `rand()`; not synced): used for the choice of a sound (`bunny.c`, `inv.c`, `menus.c`, `miscactr.c`, `panel.c`, `sector.c`), a kill or suicide message (`player.c`), the bonus screen (`game.c`), a sprite's shade in drawing (`draw.c`), the camera shake (`quake.c`) and by the bots (`jplayer.c`: when to shoot, jump and where to aim; `rand()%numsectors` to choose a sector). None of them has two draws in one expression, and none is a draw that can split a network game except possibly the bots, whose use in a network game was not looked at (recorded in `bugs.md` L35).

### What neither function does in the shareware game

`DoRail()` and `InitRail()` return at once when `SW_SHAREWARE` (the rail gun is the registered game's: the weapons cheat gives the shareware `WpnFlags` `0x207F`, which leaves out `WPN_RAIL`), and `SpawnGrenadeExp()` draws these six numbers only when the missile's `u->ID` is `ZILLA_RUN_R0`, which only Zilla's own sprites have (`DoZillaDeathMelt()` calls it; Zilla is the boss of level 20, registered). So no shareware game, demo or test reaches any of the six statements, and a dynamic check needs a test hook (below). The velocity `DoRail()` gives a puff is used by nothing that moves it (`DoRailPuff` only makes it grow), so there only the number of draws reaches the state hash; the explosion's position in `SpawnGrenadeExp()` does.

## The fix

`fix/random-arg-order`, commit `e451cfd` (see the Outcome): `src/weapon.c` only, 24 insertions and 6 deletions. Each statement draws its two numbers into the locals `r0` and `r1`, in statements of their own, first operand first, and then does the arithmetic with them (`np->xvel += r0 - r1;`); `DoRail()` and `SpawnGrenadeExp()` each get `int r0, r1;` at the top, in the code's own style, and a two-line comment says why. The numbers drawn, the order and the arithmetic are exactly what the gcc and clang builds did. `krand1()`, `RandomRange()` and the engine are untouched.

## Decisions

1. **gcc's order, which is also clang's: first operand first.** The brief asked for gcc's order; here it is the text order, so the locals are drawn in the order they are named (`r0` then `r1`), which reads naturally. (In jfDuke3D gcc's order is last argument first and the locals are drawn from the highest number down; here that rule gives the opposite, and the measurement decides.)
2. **Locals reused within a function** (`r0`, `r1` for all three statements of a block), not six names: the statements are three copies of one pattern, so the diff reads as one.
3. **Hoist into locals, not a helper function or macro:** it is what upstream would write, and each site stays readable.
4. **The commit message says what is true:** gcc and clang agree today, so it is not a cure of an observed desync, and it says so (the request assumed a desync as in jfDuke3D; the audit and the assembly showed otherwise).
5. **`-testrandom` is a test hook in `sync.c`, not part of the fix**, and changes `GameVariant` for the length of two calls, because the shareware data is all there is to test with (never commit game data). It is in the version salt and inert without its argument.
6. **`random-order.py` is part of `make test`** (`make test-random-order`), skipped with `*** random-order.py: NOT RUN (not counted as passed; see its message above)` when clang is missing (exit 3); exit 1 for a site or for a file that was asked for and did not compile.
7. **The test goes into `determinism.js`** as part 7 (jfSW's existing native-against-wasm test, which already compares gcc native with wasm for the committed demo), with `DET_ONLY=random` to run it alone; no new file.
8. **No change to `jfbuild`, `jfaudiolib`, `jfmact`, `vnet` or `PROMPT.md`** (the engine's `krand()` is not called by the game or the engine).

## Outcome

Status: **review** (branch `browser/F5-random-arg-order`; the coordinator marks it done after review and merge).

**Commits.**

- `fix/random-arg-order` (pushed): `e451cfd`, one commit from `master` `befcdd0`: `src/weapon.c` (24 insertions, 6 deletions), the message written for upstream (it says that gcc and clang agree today, so nothing changes for them), the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` only. **Line endings kept:** no file of `src/` has a CR (0 of 22063 lines of `weapon.c` before, 0 of 22081 after; checked for every `src/*.c` and `*.h`, 143 files). **Cherry-picks cleanly onto upstream `HEAD`:** a fresh clone of `jonof/jfsw` with its own submodules (`jfbuild` `40a98be`, `jfaudiolib` `68be97f`, `jfmact` `731c0cc`), `git cherry-pick` of the commit: no conflict, the tree is identical to the fix branch's (`fb0014c` in the clone); built there as it is (`make -j4`, exit 0, the usual 14 warnings, none in the changed lines).
- `browser/F5-random-arg-order` (pushed): the `--no-ff` merge of the fix (`293d086`), the test hook, the three tools, `determinism.js` part 7, the `Makefile` line, and this document with `bugs.md` L35, `code-facts.md` 24, `building.md` 6.8 and the README row (`git log origin/claude..browser/F5-random-arg-order`). 14 files, +954 −14 (with this document): `src/weapon.c` (the fix), `src/sync.c`, `src/game.c`, `src/net.h` (`-testrandom`), `Makefile`, `tests/tools/random-order.py`, `random-equiv.py`, `random-asm-order.py`, `tests/web/determinism.js` and the five documents.

**Upstream.** `git ls-remote https://github.com/jonof/jfsw.git HEAD` on 19 Nov 2026: `befcdd01afe5151cac2f1dabf0a7256c42537284`, the commit `master` here is at. Its 18 pull requests (`refs/pull/*/head`, fetched into the scratch clone): none adds or removes a line with `RANDOM`, `DoRail` or `SpawnGrenadeExp` in `src/weapon.c`. Not fixed upstream. Nothing was sent (no pull request, no issue).

**The finding that changes the story: gcc and clang draw in the same order here.** For the six statements gcc 13.3 (x86-64) evaluates the **first** operand of the `-` first at `-O0`, `-Og`, `-O1`, `-O2` (the native build's, with `-fomit-frame-pointer`), `-O3` and `-Os`, and clang 18 does the same at the same six levels: 36 observations for each compiler, all "text order", none reversed or mixed (`tests/tools/random-asm-order.py -C <old tree> -l 10190,10191,10192,11643,11644,11645 weapon.c`: the source is compiled with every `RANDOM_RANGE()` replaced by a call numbered by `__COUNTER__`, and the calls are read from the assembly in the order they are made). So **gcc's order did not vary with the optimisation level** (the brief's stop condition did not arise), and gcc and the browser's clang agree on the original code: the unfixed browser build and the gcc-native build play the same, which part 7 of `determinism.js` shows directly (below; wasm is clang 24 of emsdk 6.0.13, not the clang 18 of the assembly check). The fix is therefore a hardening, not the cure of an observed desync as D15 is in jfDuke3D (where the sites are call arguments and a commutative `+`, which gcc orders differently from clang). It matters for a build whose compiler or target orders them differently, which was not available here (no 32-bit headers, no ARM compiler: untested; MSVC's order is not known). For the fixed code the same tool shows the whole sequence of draws of `DoRail()` (6) and `SpawnGrenadeExp()` (7) rising in text order at the same levels with both compilers.

**Acceptance 1: the audit is exhaustive.** `tests/tools/random-order.py`: **6 sites before the fix** (the old tree: `weapon.c` 10190-10192 and 11643-11645, exit 1), **0 after** (79 files, exit 0; the same 6 with `-DDEBUG=1`). The text search and the reading of every other statement with two draws agree (the audit above). Exit codes: 1 if a site is found or a requested file does not compile (`src/nonexistent.c` and `src/startwin_game.c` are exit 1), 3 only if clang is missing (checked by running it without clang on `PATH`). `make test-random-order` (the first step of `make test`) prints `*** random-order.py: NOT RUN (not counted as passed; see its message above)` for exit 3 and fails for any other non-zero status. The scanner finds all the cases of a file of invented ones and none of the sequenced ones (the audit, part 1).

**Acceptance 2: gcc's order is kept, and the equivalence of the hunks.** The order: above. The equivalence, by AST, for every function of every changed file (`tests/tools/random-equiv.py OLD_TREE NEW_TREE`: the sequence of full expressions that draw, the old tree evaluated with the measured order, the new tree's locals folded back into the expression that uses them): **`weapon.c`: 79 functions that draw, 212 events, 0 differ**. It finds the deliberate mistakes, one at a time, each reported with the event and both texts: the six hoists in reverse order (`DoRail()` and `SpawnGrenadeExp()` differ), `r1 - r0` for `r0 - r1`, a range of 1001 for 1000, `r1` left out of the sum for `dz`, one draw of the `zvel` pair left out; the unchanged tree is the control (0 differ).

**Acceptance 3: gcc-native is unchanged.** The two functions are out of the shareware game's reach, so `-testrandom` runs them (`code-facts.md` 24). Gcc-native `-testdump` records (17 bytes a tic, the hash of the whole state) and the `TEST: random:` lines (the explosion's position, the puffs' summed velocities and their hash, the seed after) of the game **before the fix** (the integration tree with `weapon.c` from `claude`) and **after**, 60 calls 8 tics apart from tic 100 in the first four levels, and 60 calls 90 tics apart from tic 300 during each of the two committed demos (`jfsw1.dmo`, `jfsw2.dmo`, played to their ends):

| Game | Records | Calls | Puffs | Dump before = after | Lines before = after |
|---|---|---|---|---|---|
| E1L1, 700 tics | 700 | 60 | 660 | byte-identical (sha1 `213f8b5b17`) | identical |
| E1L2 | 700 | 60 | 60 | byte-identical (`fb3e599199`) | identical |
| E1L3 | 700 | 60 | 330 | byte-identical (`667a0c15c3`) | identical |
| E1L4 | 700 | 60 | 2265 | byte-identical (`a43a109329`) | identical |
| demo `jfsw1` | 5999 | 60 | 677 | byte-identical (`373908551afe`) | identical |
| demo `jfsw2` | 5997 | 60 | 677 | byte-identical (`04caed711f72`) | identical |

14,796 records (251,532 bytes), 360 calls, 4,669 puffs: 0 bytes differ. **Which sites were reached** (a scratch build with a counter after each statement, not committed; the four levels): every one of the six statements, in every run: the three of `DoRail()` once per puff (660, 60, 330 and 2265 times in the four levels: the number of puffs) and the three of `SpawnGrenadeExp()` once per call (60 times each); in all, 14,007 executions of the `DoRail()` statements and 1,080 of the `SpawnGrenadeExp()` ones over the six games (counted in the four levels; for the two demos the puff lines of the log give the same numbers). The explosion's height shows the draws of `dz` (the hook gives `SpawnExpZadjust()` far-off limits); the puff velocities show only in the `TEST: random:` lines, which is why the mutations below are caught by them. The existing demos and every other game of the test suite do not reach the six statements (the audit: shareware).

**Acceptance 4: browser equals native.** `determinism.js` already compared gcc native (the Makefile's `cc`) with wasm for the committed demo (parts 1 to 6, nine sync bytes a tic against the committed `.dms`), but that demo never reaches the six statements. **Part 7** (`DET_ONLY=random` runs it alone, about 45 s) plays the `-testrandom100,20,15 -testquit500` game of E1L1 natively twice and in wasm and compares the per-tic records and the numbers the draws gave: gcc native twice identical, **wasm equals gcc native: 500 records byte for byte and 80 `TEST: random:` lines**, with the 20 `SpawnGrenadeExp()` calls and the 20 `DoRail()` calls (212 puffs) checked to have run. The full `determinism.js` on the integration branch: **28 passed, 1 failed**; the failure is the known "no stall over 100 ms" frame check (max 239 ms in this container's software-rendered Chromium; it was 20 passed and 1 failed in F3 for the same check), and parts 1 to 6 pass as before (the native `.dms` equals the committed one, wasm identical to it, the flipped-byte and other-demo checks, the browser-recorded demo identical natively and in wasm). **It also passes on the old code** (the integration tree with `weapon.c` from `claude`, native and wasm rebuilt: 8 passed, 0 failed), which is the finding above: the test cannot fail without the fix on gcc and clang. **What it does catch** (mutations; native is always the fixed gcc build, wasm is rebuilt from the mutated source, as a compiler with the other order would build it):

| Mutation | Part 7 | |
|---|---|---|
| the six hoists in reverse order in the wasm build | **6 passed, 2 failed**: the numbers, and the records from tic 101 | what a right-to-left compiler would do to the old code |
| only the three of `DoRail()` reversed | 7 passed, 1 failed: the numbers only (the puff velocity is in no state hash) | |
| only the three of `SpawnGrenadeExp()` reversed | 6 passed, 2 failed: the numbers and the records | |
| the same reversal in a gcc-native build, against the fixed gcc build, over E1L1 for 700 tics | 600 of 700 records differ, the first at tic 101 | the before and after comparison of acceptance 3 catches a wrong order |

**Acceptance 5: no regressions.** `make test` (native, under `flock`, with `env --default-signal=INT`): **exit 0**, about 13 minutes: `random-order.py` 0 sites; `test-mmulti` (10 runs); `test-net`'s relay game with 3 players, plain UDP, UDP against the baseline build, errors, the level exit (F3), mouse aiming (F4), data mismatch (05b), the startup window (skipped without xvfb as before) and rejoin: 10 `PASS` lines, 350 `ok:` lines, 0 failures; `test-draw` 16 passed, 0 failed. `smoke.js`: **29 passed, 0 failed**. `determinism.js`: above. `netplay.js ws native-host` (a native host with a browser guest and two browsers, with the relay): **40 passed, 0 failed**. Not run: `persist.js`, `data.js`, `grptable.js`, `focus.js` and the other `netplay.js` scenarios: nothing they test was touched (the change is in `weapon.c`, a test hook that does nothing without its argument, and tests).

**Tools made** (`tests/tools/`): `random-order.py` (static check, in `make test`), `random-equiv.py` (the equivalence proof), `random-asm-order.py` (the compilers' order from assembly); in `src/sync.c`: `-testrandom<T>[,<N>[,<S>]]` (test-only, in the version salt, inert without its argument). They are adaptations of jfDuke3D's `krand-order.py` and `krand-equiv.py` for jfSW's macros: the draws are `krand1()`, `krand2()` and `RandomRange()`; `sizeof` is skipped; a draw next to a call through a pointer and the local generator are reported with `-v` only; the equivalence tool numbers the draws per function and compares the ranges drawn too (a draw is `RandomRange(range)`, not a bare `krand()`); the model of gcc's order is the measured one (binary operators first to second); the files compared are the ones that differ between the trees. Not committed: the counting build, the scripts that played the games and compared the dumps, the mutated trees.

**Decisions** (the ones not already in the list above).

1. **Nothing is made of an observed desync that does not exist.** The commit message, `bugs.md` L35 and this document say that gcc and clang agree, and call the fix a hardening. The user asked for it knowing the Duke result; the Outcome reports what the measurement shows.
2. **Hook details:** the explosion goes in the sector whose middle is farthest from the first player (the first version put it on the player, who was thrown about and then hit an assertion in `COVERinsertsprite()` after a few calls in a demo; the rod, too, was first fired from the player, and went wherever he looked), and the rod is made by hand like `InitRail()` makes one, in that sector, along the longest of 32 lines to a wall (found with `hitscan()`), a little different each call. The floor and ceiling limits of the explosion's height are far off (`SpawnExpZadjust()` would otherwise clamp `dz` away in every sector of E1). `GameVariant` is the registered game's for the two calls only; no other code runs in that state.
3. **`-testquit` in a single-player game does not end the game:** it quits into the shareware "Give up?" page, which waits for a key (`CleanExit` in `TerminateGame`). Part 7 stops the native game with SIGTERM once the dump has its 500 records and presses Space in the browser until the game has ended. Not changed.
4. **Part 7 lives in `determinism.js`** (jfSW's native-against-wasm test), not in a new file or in Duke's strict form: that file already compares gcc native with wasm, and its demo checks needed no change.
5. **`random-order.py` counts `version-auto.c`** (79 files once the game is built, 78 in a fresh checkout): a generated file, harmless.

**Open.** (a) Gcc's and clang's order were measured for x86-64 only; a 32-bit or ARM build, MSVC and clang on macOS were not available, and the fix makes them agree with the x86-64 ones whatever their order is. (b) The six statements are unreachable in the shareware game, so no real game or demo exercises them; their checks are the hook, the assembly and the AST. A registered-game test (Zilla, level 20, and the rail gun) needs data that is not in the repository and was not run. (c) The bots' use of the local generator in network games was not looked at (`bugs.md` L35).
