# 00: Repo set-up, baseline and code facts

## Goal

Make the repository ready for briefs 01 to 06: submodules that resolve from a fresh clone, vnet at `ext/vnet`, set-up scripts for the native and Emscripten toolchains, verified test data, a green native build, a way to run the game headless, and a verified `code-facts.md` that later briefs can trust.

## Read first

- [`README.md`](README.md): decisions D1 to D12, the answers to Q1 to Q5, and **"Working across repos"**.
- [`PROMPT.md`](PROMPT.md) §2 ("What the code does"). Every claim there is unverified. Your `code-facts.md` replaces it.
- vnet: `doco/integration.md` in `VenKamikaze/vnet` at tag `v0.4.0`, in particular "Vendoring without CMake".
- Bit Riot (its `claude` branch; a local copy is at `/home/user/BitRiot-claude` in the coordinator's container): `scripts/setup-emsdk.sh` and `doco/netplay/09-wasm-port.md`. Adapt; don't copy wholesale.

## In scope

### 1. Submodules (Q1)

- `.gitmodules`: absolute URLs `https://github.com/VenKamikaze/jfbuild.git`, `.../jfmact.git`, `.../jfaudiolib.git`. Add `branch = claude` to jfbuild and jfaudiolib, and `branch = master` to jfmact (see the README for why jfmact has no `claude`).
- Leave the pinned commits as they are (jfbuild `40a98be`, jfaudiolib `68be97f`, jfmact `731c0cc`). The forks' `master` branches are newer; don't move to them.
- Add vnet as a submodule at `ext/vnet`, URL `https://github.com/VenKamikaze/vnet.git`, checked out at tag `v0.4.0` (`eb1feeb`). Nothing builds it yet (brief 01 does), but check that its `src/*.c` compile with the project's compiler and flags as described in "Vendoring without CMake" (a throwaway compile is fine; don't wire it into the Makefile).

### 2. `scripts/setup.sh` (native dependencies)

- Installs what the native build and the later briefs need: a C compiler and make, SDL2 development files, libvorbis (+ libogg), pkg-config, unzip, Python 3, optional GTK3 for the startup window, and Go for the vnet relay (only check its version if already installed: vnet's `relay/go.mod` says which version it needs).
- Supports **apt** (the cloud container is Ubuntu 24.04) and **pacman** (the user runs Arch Linux). Detect which is present. Idempotent and non-interactive.
- `--no-gtk` skips GTK3.

### 3. `scripts/setup-emsdk.sh` (Emscripten 6.0.13, D12)

- Adapted from Bit Riot's: pinned emsdk revision and Emscripten `6.0.13`, fetched with git, `EMSDK_DIR` override.
- **The default `EMSDK_DIR` must be outside the worktree**, e.g. `${XDG_CACHE_HOME:-$HOME/.cache}/jfsw-browser/emsdk`, so the parallel briefs 01 and 02, in separate worktrees, share one install.
- **Ports.** The cloud container gets HTTP 403 from GitHub archive URLs (`github.com/.../archive/...`, `codeload.github.com`), so Emscripten cannot download its ports there. Do what Bit Riot did:
  - Create an orphan branch **`emscripten-ports`** in jfsw-browser that holds the port archives this project needs: **SDL2** now, and **libogg and libvorbis** for later music. Use the exact archive names and URLs from the pinned emsdk's `tools/ports/*.py`. The archives can be taken from Bit Riot's `emscripten-ports` branch (`git fetch https://github.com/VenKamikaze/BitRiot emscripten-ports`). Verify each against the `HASH` in the pinned emsdk's port file before committing.
  - `--with-ports` fetches that branch, verifies the SHA-512 of each archive against the pinned emsdk, and seeds Emscripten's cache the way Emscripten itself would, so `-sUSE_SDL=2` (and `-sUSE_OGG=1 -sUSE_VORBIS=1`) download nothing.
  - The orphan branch is the one exception to "branches come from `claude`". Push it; never force-push it.
- **Prove it on a clean cache:** with a fresh `EMSDK_DIR`, run the script, then build a tiny C program with `emcc -sUSE_SDL=2` (and one with the Ogg and Vorbis ports) that links. Delete the throwaway output.

### 4. `scripts/fetch-test-data.sh` (Q2)

- Downloads `https://image.dosgamesarchive.com/games/3dsw12.zip`, falling back to `https://archive.org/download/3dsw12/3dsw12.zip`.
- Checks the MD5 `d77564e8764feeb1509dd0d534fb8952`, unzips `SWSW12.SHR` from it and `sw.grp` from that, and checks the GRP's CRC32 (`0x08A7FA1F`) and size (26,056,769) against the "Shareware Version" entry in `src/grpscan.c`.
- Writes `testdata/swshare.grp`. `testdata/` is git-ignored. Skips the download when a valid file is already there. Fails loudly, with a non-zero exit, on any mismatch, and never leaves an unverified file at the destination.
- `--dest DIR` and `--from-zip FILE` (use a local copy of the zip instead of downloading) options.
- Bash plus standard tools; Python is fine for the CRC32 (run it with `python3 -I`).

### 5. Native build and headless run

- `make -j4` is green from a fresh recursive clone on Ubuntu 24.04, with the default `USE_POLYMOST=1 USE_OPENGL=1` and also with `USE_POLYMOST=0 USE_OPENGL=0` (the software renderer is what the browser uses, D6). Record warnings that look relevant, don't fix them.
- Find and document **how to run the game headless**: `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy`, `-nosetup` (or whatever skips the startup window), where the game looks for GRPs and how to point it at `testdata/`, and where it writes config and `grpfiles.cache` (keep the test from writing into the user's home: find the knob, e.g. `HOME` or a command-line option).
- Find out how to get a **bounded, scripted run** that exits by itself with status 0: demo playback (`-dp<file>`), demo recording (`-dr<file>`), a level warp (`-level#`), or whatever the code offers. Record what exists and what's missing. Do **not** add new hooks to the game here: the test-only hooks belong to brief 02 (sync dump) and 01 (network). If there is no way to exit by itself, use a `timeout` and say so.
- `scripts/run-headless.sh`: wraps the above (environment, GRP path, temporary home, timeout), passes through extra game arguments, and returns the game's exit status, or a distinct status on timeout.

### 6. Docs

- **`doco/browser/code-facts.md`**: verify every claim in PROMPT.md §2 against this repo at the pinned submodule commits. Give file:line for each, mark each **confirmed**, **corrected** (with the right facts) or **not found**. Add what later briefs will need that §2 doesn't say, at least:
  - how `-net` arguments are parsed into `initmultiplayersparms` and the exact flow in `InitGame` around `initmultiplayerscycle` (01, 05);
  - every public symbol `mmulti.h` declares and which ones the game uses (01);
  - where `handleevents()` and `nextpage()` are, and the blocking loops that call them (02, ASYNCIFY yields);
  - the SDL layer's platform `#if`s and anything that will fight Emscripten: threads, `fork`/`exec`, signals, GL calls, file paths (02);
  - how the game finds GRPs (search path order, `SWGRP`, `-g`), and `grpfiles.cache` (03);
  - how the game uses sync data (`sync.c`, what is hashed, how a desync is reported), for the determinism checks in 01, 02 and 04;
  - the sound and music code paths jfaudiolib uses, and which drivers the Makefile builds (02).
- **`doco/browser/building.md`**: native set-up (apt and pacman), emsdk set-up, test data, the build, the headless run. Copy-pasteable commands.
- Update the status row for 00 in `README.md` and fill in this brief's **Outcome**.

## Out of scope

- Any change to game or engine code (`src/`, `jfbuild/`, `jfaudiolib/`, `jfmact/`). If something won't build without one, stop and report it.
- Building vnet into the game (01), the Emscripten build of the game (02).
- CI.

## Acceptance criteria

1. `git clone --recurse-submodules -b browser/00-setup https://github.com/VenKamikaze/jfsw-browser` into an empty directory gives every submodule, including `ext/vnet` at `eb1feeb`.
2. In that clone, `scripts/setup.sh` then `make -j4` builds `sw` (and `build`, if the Makefile builds it by default) with both renderer settings.
3. `scripts/fetch-test-data.sh` produces a verified `testdata/swshare.grp`, is a no-op on a second run, and fails (non-zero, no file left behind) on a corrupt or truncated zip and on a GRP with the wrong CRC.
4. `scripts/run-headless.sh` starts the game on the shareware GRP, gets past GRP detection and into the game or a demo, and exits within a bounded time. Say exactly how it exits (by itself or by timeout) and what the log shows.
5. `scripts/setup-emsdk.sh --with-ports` works on a clean `EMSDK_DIR` and an empty Emscripten cache, and the SDL2 and Ogg/Vorbis test programs link with no download attempted.
6. `code-facts.md` covers every §2 claim plus the list in §6, with file:line refs.
7. No GRP, zip or other game data is in any commit on `browser/00-setup` (check `git ls-files` and `git diff --stat claude..`). The `emscripten-ports` branch holds only the library archives.

## Tests

- `tests/fetch-test-data.sh` (bash): runs the fetch script against a local copy of the zip (`--from-zip`) into a temporary directory, and checks: the good case; the second-run no-op; a truncated zip; a zip with one flipped byte; a GRP of the right size and wrong CRC (build one). Each failing case must exit non-zero and leave no file behind. Show the test fails if the CRC check is removed from the script.
- The headless run and the clean-cache emsdk run are manual checks: put the commands and their output, trimmed, in the Outcome.

## Dependencies

Q1 (answered). Push access to `VenKamikaze/jfsw-browser` (granted).

## Notes

- **Git:** work on `browser/00-setup` in jfsw-browser (it exists, with the docs commit). Commit at each milestone and push only that branch, plus the new `emscripten-ports` orphan branch. Never merge, never touch `claude` or `master`, never open a PR, never force-push. This brief changes no fork.
- Builds use `-j4`: the container has 4 cores.
- The verified GRP is already at `/tmp/claude-0/-home-user/0670875d-ffe0-585c-b9e6-ec2e78eba3bf/scratchpad/swdata/dl/3dsw12.zip` (the zip) in the coordinator's container; use it with `--from-zip` to save downloads, but test the real download once.
- Network: report any host that is blocked. Don't work around it, except for the GitHub archive URLs as described in §3.

## Outcome

Status: **review** (branch `browser/00-setup`; the coordinator marks it done after review and merge). No game, engine or fork code changed; no fork repo was pushed.

**What landed**

- `.gitmodules`: absolute URLs for the three forks, `branch = claude` for jfbuild and jfaudiolib, `branch = master` for jfmact. Pins unchanged (`40a98be`, `68be97f`, `731c0cc`). `ext/vnet` added at `v0.4.0` (`eb1feeb`). A throwaway compile of all 13 `ext/vnet/src/*.c` with `gcc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra` and with the project's `-std=c99 -W -Wall -fno-strict-aliasing` gave no warnings.
- `scripts/setup.sh` (apt and pacman, `--no-gtk`), `scripts/setup-emsdk.sh` (emsdk revision `d7b4130`, Emscripten 6.0.13, default `EMSDK_DIR` `~/.cache/jfsw-browser/emsdk`, `--with-ports`), `scripts/fetch-test-data.sh`, `scripts/run-headless.sh`, `tests/fetch-test-data.sh`.
- Orphan branch `emscripten-ports` (pushed, one commit): SDL2 `release-2.32.10.zip` (taken from Bit Riot's branch), `libogg-1.3.5.zip` and `libvorbis-1.3.7.zip` (downloaded from the `releases/download` URLs, which were reachable here), `SHA512SUMS` and a README. All three SHA-512 values equal the `HASH` in the pinned emsdk's `tools/ports/{sdl2,ogg,vorbis}.py`. Library archives only.
- `doco/browser/code-facts.md` (every PROMPT §2 claim marked, plus the extra topics) and `doco/browser/building.md`.
- `.gitignore` now lists `/testdata/`.

**Corrections to PROMPT §2** (details in `code-facts.md` §1; PROMPT §2 now carries a pointer): `main` is `jfbuild/src/sdlayer2.c:254`, `app_main` is `game.c:3372`; the slot is assigned in `getpacket` (`mmulti.c:~1066`), not `initmultiplayerscycle`; `CommPlayers` can drop when players quit; the GRP table has six entries and the files are matched by CRC32 and size, not name; the `USE_GLES2` define is `build.h:20` (`glbuild.c:142` is a debug callback); `-nosetup` does not stop the GTK window on a first run without `sw.cfg`; shareware `MultiSharewareCheck` calls `exit(0)` above 4 players; absolute paths do not work in `SWGRP` or `-g`; `-dp` needs `-level#`; `-demosyncrecord` records during playback and a `-demosynctest` mismatch exits 0.

**Tests**

- `tests/fetch-test-data.sh`: 23 passed, 0 failed (good zip; second run no-op and untouched; truncated zip; zip with one flipped byte; right size and wrong CRC; wrong size; stale bad GRP removed or replaced; the script's constants equal `src/grpscan.c`). Every failing case exits non-zero and leaves an empty destination.
- With the CRC check line removed from `scripts/fetch-test-data.sh`: 21 passed, 2 failed (`GRP of the right size and the wrong CRC (exited 0)` and `wrong CRC: destination holds: swshare.grp`). Restored: 23 of 23.

**Native build** (fresh `git clone --recurse-submodules -b browser/00-setup`, `scripts/setup.sh`, `make -j4`): green with the defaults (14 warnings) and, after `make veryclean`, with `USE_POLYMOST=0 USE_OPENGL=0` (10 warnings). Both build `sw` and `build`. About 15 s each.

**Headless run** (manual check):

```
$ scripts/run-headless.sh --timeout 6 --workdir /tmp/wd1 -level1 -drdemo1     # records; stopped by the timeout
run-headless: stopped after 6s            (exit 124; the game itself quits cleanly on SIGTERM)
$ scripts/run-headless.sh --workdir /tmp/wd1 -level1 -dpdemo1                 # plays back
...
Music driver is No Sound                  (exit 0, by itself, after about 6 s)
```

The log shows `Scanning for GRP files...`, ` Checksumming swshare.grp`, `GRP file: swshare.grp`, `SHADOW WARRIOR(tm) (Shareware Version)`, `Setting video mode 640x480`, `FX driver is SDL`. A demo recorded with the software build plays back to the end in the OpenGL build too (exit 0). `ALSADrv: snd_seq_open err -2` is harmless noise. There is no built-in "run N frames and quit"; the demo playback is the only run that ends by itself (see `code-facts.md` §7).

**Clean-cache emsdk** (fresh `EMSDK_DIR`, empty Emscripten cache):

```
$ EMSDK_DIR=$PWD/emsdk-clean scripts/setup-emsdk.sh --with-ports
... Done installing SDK 'sdk-releases-eb132757325583b787fe9414b09afea9442b72ad-64bit'.
seeded port sdl2 from release-2.32.10.zip
seeded port ogg from libogg-1.3.5.zip
seeded port vorbis from libvorbis-1.3.7.zip
emsdk 6.0.13 is installed in .../emsdk-clean
$ emcc sdl.c -sUSE_SDL=2 -o sdl.js            # 7.8 s: "generating port: libSDL2.a", no download
$ emcc ov.c -sUSE_OGG=1 -sUSE_VORBIS=1 -o ov.js && node ov.js
Xiph.Org libVorbis 1.3.7
```

Re-running the script prints `Emscripten ports already seeded`. The whole install takes about 40 s (the toolchain is a 312 MB download from `storage.googleapis.com`).

**Blocked hosts:** none. The `github.com/xiph/*/releases/download/...` URLs for libogg and libvorbis were reachable (only `/archive/` URLs are blocked). `image.dosgamesarchive.com` worked.

**For later briefs**

- Brief 01: `mmulti.c` has `netinit`/`netsend`/`netread` as its only socket users; vnet needs C11 per file (the project builds with `-std=c99`).
- Brief 02: `Makefile.shared` already forces `USE_ASM=0`; under `emcc` `PLATFORM` is `UNKNOWN`, so check the Linux-only Makefile blocks; every wait is a busy loop with no sleep (`code-facts.md` §5); `wasm32` vs `x86_64` demo/sync compatibility is unverified.
- Brief 05: limit hosting to 4 players on the shareware GRP.
- Brief 03: `user_profiles_disabled` in the cwd is the engine's own switch for reading and writing everything in the working directory; use it for the browser data folder.

