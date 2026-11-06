# Building and running

Copy-pasteable commands. Written for Ubuntu 24.04 (the cloud container) and Arch Linux (the user's machine). All paths are relative to the repository root.

## 1. Get the source

```sh
git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser
cd jfsw-browser
git submodule status        # ext/vnet must say eb1feeb (v0.4.0)
```

The submodules (`jfbuild`, `jfaudiolib`, `jfmact`, `ext/vnet`) are fetched from the user's forks over absolute URLs, so the clone works from anywhere. Already cloned without `--recurse-submodules`: `git submodule update --init --recursive`.

## 2. Native dependencies

```sh
scripts/setup.sh              # apt (Ubuntu/Debian) or pacman (Arch), incl. GTK3
scripts/setup.sh --no-gtk     # without the GTK3 startup window
```

It installs: compiler and `make`, `pkg-config`, `git`, `unzip`, Python 3, SDL2, libvorbis and libogg, OpenGL headers, ALSA headers, and GTK3. It is idempotent and non-interactive, and uses `sudo` unless run as root. Go is only checked: the vnet relay (`ext/vnet/relay`) needs Go 1.24 or newer (Arch: `sudo pacman -S go`; Ubuntu 24.04's own package is older, so use go.dev's tarball).

By hand, Arch: `sudo pacman -S --needed base-devel pkgconf git unzip python sdl2 libvorbis libogg mesa glu alsa-lib gtk3`.

## 3. Build

```sh
make -j4                                          # OpenGL + Polymost (default); builds ./sw and ./build
make veryclean && make -j4 USE_POLYMOST=0 USE_OPENGL=0   # software renderer only (what the browser uses, D6)
```

Switching renderer settings needs `make veryclean` first (the objects differ). `make veryclean` cleans the submodules too. About 15 s on 4 cores. There are 14 compiler warnings (10 with the software renderer) in the existing code; none are in anything the browser work touches (see `code-facts.md` §11). Build without GTK: `make WITHOUT_GTK=1 -j4`.

`./sw` is the game, `./build` is the map editor.

## 4. Test data (shareware 1.2)

```sh
scripts/fetch-test-data.sh                  # downloads, verifies, writes testdata/swshare.grp
scripts/fetch-test-data.sh --from-zip /path/to/3dsw12.zip   # use a local copy of the zip
scripts/fetch-test-data.sh --dest DIR       # somewhere other than testdata/
tests/fetch-test-data.sh [3dsw12.zip]       # the script's tests (downloads the zip if none is given)
tests/run-headless.sh                       # tests for run-headless.sh (fake game, no data needed)
```

It fetches `https://image.dosgamesarchive.com/games/3dsw12.zip` (falling back to `archive.org`), checks the zip's MD5 (`d77564e8764feeb1509dd0d534fb8952`), unpacks `SWSW12.SHR` and `sw.grp` from it, and checks the GRP's CRC32 (`0x08A7FA1F`) and size (26,056,769 bytes) against `src/grpscan.c`. Nothing is left at the destination unless every check passed; a second run does nothing. `testdata/` is git-ignored: game data is never committed.

## 5. Run the game headless

```sh
scripts/run-headless.sh --timeout 10 -level1        # E1L1 for 10 s, then stopped (exit 124)
```

Options go before the game's arguments: `--grp FILE`, `--timeout SEC` (default 30), `--workdir DIR` (kept afterwards), `--sw FILE`. It runs `./sw -nosetup …` with `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy`, `DISPLAY` unset, and `HOME` and the working directory set to a throw-away directory (or `--workdir`) that holds a `user_profiles_disabled` file (the game's own "portable" switch) and a symlink to the GRP, so config, log, `grpfiles.cache` and demos all land there and nothing touches your home. Exit status: the game's own, 124 when stopped by the timeout, 125 for a script problem.

A bounded run that ends by itself: record a demo, then play it back (playback exits with status 0 at its end).

```sh
rm -rf /tmp/sw-demo
scripts/run-headless.sh --timeout 6 --workdir /tmp/sw-demo -level1 -drdemo1   # exit 124: stopped; wrote demo1.dmo
scripts/run-headless.sh --workdir /tmp/sw-demo -level1 -dpdemo1               # exit 0, by itself, in about 6 s
```

On a normal desktop run, the first time (no `sw.cfg`) the game shows its GTK startup window even with `-nosetup`; `run-headless.sh` avoids that by unsetting `DISPLAY`. For a windowed run: `./sw` with the GRP in `~/.jfsw/` or next to the binary (the GRP scan covers the current directory, the binary's directory, `~/.jfsw` and `DATADIR`; but without `user_profiles_disabled` the game does `chdir ~/.jfsw` first, so "current directory" then means `~/.jfsw`, not where you started).

More about demos, sync checks and what exits when: `code-facts.md` §7.

## 6. Emscripten (browser builds, from brief 02 on)

### 6.1 Toolchain

```sh
scripts/setup-emsdk.sh                  # emsdk + Emscripten 6.0.13 into ~/.cache/jfsw-browser/emsdk
scripts/setup-emsdk.sh --with-ports     # the same, plus the SDL2, Ogg and Vorbis ports
source ~/.cache/jfsw-browser/emsdk/emsdk_env.sh
emcc --version                          # 6.0.13
```

`EMSDK_DIR=/some/dir` changes the install location. The default is outside the worktree so that several worktrees share one install.

`--with-ports` is for networks that block GitHub archive URLs (the cloud container answers 403). Emscripten downloads its ports from GitHub on first use; with `--with-ports` they are taken from the orphan branch `emscripten-ports` of this repository (archives of SDL2 2.32.10, libogg 1.3.5, libvorbis 1.3.7), checked against the SHA-512 in the pinned emsdk's `tools/ports/*.py`, and unpacked into Emscripten's cache the way Emscripten would, so `-sUSE_SDL=2` and `-sUSE_OGG=1 -sUSE_VORBIS=1` download nothing. It fetches that branch with git, so run it from a clone with the `origin` remote. It does not take Emscripten's cache lock, so don't run it while `emcc` is running. If the emsdk pin in the script changes, refresh the branch. (Outside such a network none of this is needed: the first `emcc` call with `-sUSE_SDL=2` downloads SDL2 and builds it, about 10 s.)

Check it:

```sh
cat > /tmp/t.c <<'C'
#include <SDL.h>
int main(void){ SDL_Init(SDL_INIT_VIDEO); SDL_Quit(); return 0; }
C
emcc /tmp/t.c -sUSE_SDL=2 -o /tmp/t.js && echo ok
```

### 6.2 Build the game for the browser

```sh
scripts/build-wasm.sh                   # incremental; the first build also builds Emscripten's system libraries
scripts/build-wasm.sh clean             # remove the wasm objects only
scripts/build-wasm.sh veryclean         # and the libraries and build-wasm/
```

That is `emmake make -j4 USE_POLYMOST=0 USE_OPENGL=0` after sourcing the emsdk (the software renderer only, D6). `Makefile` includes `Makefile.emscripten` when the compiler is `emcc`; `jfbuild/Makefile.shared` and `jfaudiolib/Makefile.shared` recognise `wasm32-unknown-emscripten` as `PLATFORM=EMSCRIPTEN`. There is no startup window, no GTK and no editor (`build`); the network code is `mmulti_null.c` (single player) until the vnet transport is built for the browser (brief 04).

Objects are named `*.wasm.o` and libraries `lib*.wasm.a`, so a native build and a browser build live in the same tree without touching each other (`make clean` in one does not remove the other's objects, except `src/version-auto.c`, which both regenerate). The output is in `build-wasm/` (git-ignored): `index.html`, `jfsw.js`, `jfsw.css` (copied from `web/`), `sw.js` and `sw.wasm`. About 25 s for a full build on 4 cores once the system libraries are cached (they are built on first use).

Debug build (function names in traces, run-time assertions) into another directory: `scripts/build-wasm.sh WASM_DEBUG=1 WASMDIR=build-wasm-debug`.

Link options: `-sASYNCIFY` (the game's loops block; `jfbuild/src/sdlayer2.c` hands control back to the browser once per frame, and in event-pumping loops that do not draw), `-sALLOW_MEMORY_GROWTH`, `-sEXIT_RUNTIME` (so `exit()` from anywhere reaches the page's `onExit`), `-sINVOKE_RUN=0` (the page starts `main` from the button), `-lidbfs.js`.

### 6.3 Serve and play

```sh
scripts/fetch-test-data.sh                     # testdata/swshare.grp
cd build-wasm && ln -sf ../testdata/swshare.grp .     # the dev data loader fetches ./swshare.grp
python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/ in Chromium or Firefox, click "Click to start"
```

`?data=<url>` loads the GRP from elsewhere (it must send CORS headers if it is on another origin). The game keeps `sw.cfg`, saved games and the log in IndexedDB (the folder `/persist`); the GRP is in memory only. Page options and test hooks (`?test=1`) are described at the top of `web/jfsw.js`.

### 6.4 Browser tests

```sh
scripts/build-wasm.sh && make -j4           # the determinism test needs the native ./sw too
node tests/web/smoke.js                     # canvas is drawn, menu reached, no errors
node tests/web/determinism.js               # native against wasm: sync bytes, frame times
node tests/web/persist.js                   # settings and saves survive a reload
```

They use the preinstalled Chromium through Playwright (`require('playwright')`; never run `playwright install`), serve `build-wasm/` and `testdata/swshare.grp` on 127.0.0.1 ports 48101 and up, and clean up after themselves.

## 7. Layout of what brief 00 added

| Path | What |
|---|---|
| `scripts/setup.sh` | native dependencies (apt, pacman) |
| `scripts/setup-emsdk.sh` | pinned Emscripten and the ports |
| `scripts/fetch-test-data.sh` | verified `testdata/swshare.grp` |
| `scripts/run-headless.sh` | headless, bounded game runs |
| `tests/fetch-test-data.sh`, `tests/run-headless.sh` | tests for the fetch and run scripts |
| `ext/vnet` | vnet `v0.4.0` (submodule; not built yet) |
| `Makefile.emscripten`, `scripts/build-wasm.sh`, `web/` | the browser build and its page (brief 02) |
| `tests/web/`, `tests/tools/`, `tests/data/` | browser tests, the key-playing shim that records demos, the committed demo |
| `doco/browser/code-facts.md` | what the code does, with file:line |
