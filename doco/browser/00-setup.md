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

_Not started._
