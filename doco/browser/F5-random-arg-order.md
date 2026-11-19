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

RESULTS-PLACEHOLDER
