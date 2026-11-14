# Building and running

Copy-pasteable commands. Written for Ubuntu 24.04 (the cloud container) and Arch Linux (the user's machine). All paths are relative to the repository root.

## 1. Get the source

```sh
git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser
cd jfsw-browser
git submodule status        # ext/vnet must say 8572c74 (v0.5.0)
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

`EMSDK_DIR=/some/dir` changes the install location. The default is outside the worktree so that several worktrees share one install. `EM_CACHE=/some/dir` (optional) makes both `setup-emsdk.sh --with-ports` and `build-wasm.sh` use a private Emscripten cache instead of the emsdk's own (`emsdk_env.sh` clears the variable; both scripts put it back): `EM_CACHE=$HOME/em-cache scripts/setup-emsdk.sh --with-ports && EM_CACHE=$HOME/em-cache scripts/build-wasm.sh`.

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

That is `emmake make -j4 USE_POLYMOST=0 USE_OPENGL=0` after sourcing the emsdk (the software renderer only, D6). `Makefile` includes `Makefile.emscripten` when the compiler is `emcc`; `jfbuild/Makefile.shared` and `jfaudiolib/Makefile.shared` recognise `wasm32-unknown-emscripten` as `PLATFORM=EMSCRIPTEN`. There is no startup window, no GTK and no editor (`build`). Network games go through vnet (brief 04): the engine library contains `mmulti.c` (its plain UDP code compiled out under `__EMSCRIPTEN__`), `mmulti_vnet.c` and `ext/vnet/src/*.c`, and the link adds `-lwebsocket.js`; see section 6.5. **A browser build tree from before brief 04 has a `jfbuild/libengine.wasm.a` that still holds `mmulti_null.wasm.o`** (`ar rc` keeps old members and the linker found `initmultiplayersparms` there first, so `-net` silently did nothing): the engine `Makefile` now removes the archive before it builds it, so an ordinary `scripts/build-wasm.sh` fixes it.

Objects are named `*.wasm.o` and libraries `lib*.wasm.a`, so a native build and a browser build live in the same tree without touching each other (`make clean` in one does not remove the other's objects, except `src/version-auto.c`, which both regenerate). The output is in `build-wasm/` (git-ignored): `index.html`, `jfsw.js`, `jfsw.css`, `config.js`, `grptable.js`, `data.js` (copied from `web/`), `sw.js` and `sw.wasm`. About 25 s for a full build on 4 cores once the system libraries are cached (they are built on first use).

Debug build (function names in traces, run-time assertions) into another directory: `scripts/build-wasm.sh WASM_DEBUG=1 WASMDIR=build-wasm-debug`.

Link options: `-sASYNCIFY` (the game's loops block; `jfbuild/src/sdlayer2.c` hands control back to the browser once per frame, and in event-pumping loops that do not draw), `-sALLOW_MEMORY_GROWTH`, `-sEXIT_RUNTIME` (so `exit()` from anywhere reaches the page's `onExit`), `-sINVOKE_RUN=0` (the page starts `main` from the button), `-lidbfs.js`, `-lwebsocket.js` (vnet's WebSocket transport; WebTransport needs no flag).

### 6.3 Serve and play

```sh
scripts/fetch-test-data.sh                     # testdata/swshare.grp
cd build-wasm && ln -sf ../testdata/swshare.grp .     # config.js says: download ./swshare.grp
python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/ in Chromium or Firefox, click "Click to start"
```

The page downloads the GRP named in `config.js` (default: `swshare.grp` next to the page), checks it, keeps it in its own IndexedDB database (`jfsw-data`) and writes it to `/data/sw.grp` for the game; a reload makes no request for it. `?data=<url>` loads the GRP from elsewhere (it must send CORS headers if it is on another origin), and the page offers "Use your own copy..." for a `.grp` on disk. See [`data-hosting.md`](data-hosting.md). The game keeps `sw.cfg`, saved games and the log in IndexedDB (the folder `/persist`); `/data` is in memory only. To forget the cached data while testing: DevTools, Application, IndexedDB, delete `jfsw-data` (or press "Download again"). Page options and test hooks (`?test=1`) are described at the top of `web/jfsw.js`.

### 6.4 Browser tests

```sh
scripts/build-wasm.sh && make -j4           # the determinism test needs the native ./sw too
node tests/web/smoke.js                     # canvas is drawn, menu reached, keyboard, audio, pointer, Escape, no errors
node tests/web/determinism.js               # native against wasm: sync bytes, frame times
node tests/web/persist.js                   # settings and saves survive a reload (also one without quitting, and one 500 ms after a save)
node tests/web/data.js                      # game data: download, cache, errors, picker, quota, config changes (about 2 minutes)
node tests/web/grptable.js                  # web/grptable.js agrees with src/grpscan.c (no browser)
node tests/web/focus.js                     # brief 02c: a refused pointer lock or a lost focus does not end the game; a trap still does (about 1 minute)
```

They use the preinstalled Chromium through Playwright (`require('playwright')`; never run `playwright install`), serve `build-wasm/` and `testdata/swshare.grp` on 127.0.0.1 ports 48101 and up (data.js: 48201 and 48202; focus.js: 48104), and clean up after themselves. `focus.js` uses the full Chromium build in headless mode (`channel: 'chromium'`, the same preinstalled browser) rather than Playwright's default headless shell, which reports no mouse movement under pointer lock and crashes on a wasm trap (`code-facts.md` §20). `FOCUS_SABOTAGE=unhandled node tests/web/focus.js` leaves the lock's promise unhandled, as before the fix: its first part must fail. `JFSW_WEB_PORT_OFFSET=<n>` moves every port the browser tests use (these, `netplay.js`'s 48300 to 48399 and `firefox.js`'s 48400 to 48402) up by n, so that two checkouts can run them on one machine at once (F4).

#### Firefox (brief 02c; optional, not part of the default runs)

```sh
scripts/setup-firefox.sh                    # a pinned stock Firefox (160.0, SHA-256 checked) and puppeteer-core (25.17.0), in ~/.cache/jfsw-browser
node tests/web/firefox.js                   # about 1 minute
FIREFOX=/usr/bin/firefox node tests/web/firefox.js     # another Firefox (Arch: sudo pacman -S firefox); puppeteer-core still from the script
```

Playwright's Firefox needs Playwright's own patched build, so `firefox.js` drives a stock Firefox headless over WebDriver BiDi with `puppeteer-core`. The repository has no `package.json`: the tests use the globally installed Playwright, and `setup-firefox.sh` installs `puppeteer-core` with `npm ci` into the cache, from `tests/web/firefox-deps/package-lock.json`, which pins it and every dependency (`FIREFOX_CACHE=DIR` moves both; `--no-firefox` installs only `puppeteer-core`; `PUPPETEER_CORE=DIR` points the test at another copy). Headless Firefox never gives the page the focus, so it refuses every pointer-lock request as a desktop Firefox does after Alt+Tab. The test checks a single player game (refusals at start-up and after a click: logged, game running, no overlay), a wasm trap (still fatal, with `?persist=0` and with persistence on), and a network game through a local relay (Chromium hosts by `?host=2`, Firefox joins with persistence on: 400 tics, both end by themselves with "The game has ended." and agree on every tic). Ports 48400 (page), 48401 and 48402 (relay). Without a Firefox or `puppeteer-core` it prints `firefox: NOT RUN` and exits with status 3, which is not a pass; when the cache holds other versions than the test pins (or the pinned Firefox reports another version) it prints `firefox: VERSION MISMATCH` and exits with status 3. `FIREFOX_SABOTAGE=unhandled` leaves the lock's promise unhandled, as before the fix: it must fail.

A real Alt+Tab is not tested (it depends on the window manager and on timing). It was checked by hand under `xvfb-run` with `openbox` and `xdotool` (`apt-get install openbox xdotool`): the Outcome of brief 02c says how.

### 6.5 Network games in the browser, and their tests (brief 04)

A browser plays only through a relay. The game takes the same arguments as the desktop one, with one difference: `-relay` is the relay's **WebSocket URL** (`wss://host/vnet`; `ws://127.0.0.1:PORT/vnet` for a local relay) instead of `HOST:PORT`. vnet then tries WebTransport first (derived from a `wss://` URL) and falls back to WebSocket; the game prints which it got (`... relay-wt` or `... relay-ws`). A plain `-net` without `-relay`, or a `HOST:PORT` for `-relay`, ends the game with a message on the page (exit status 1). Players start network games from the page address, the console or the menus (section 6.6, brief 05); a test page can still pass the arguments itself:

```sh
# a local relay for the page, a native player and the browser (WebSocket on /vnet, UDP for native games;
# -origins must name the page's host:port exactly)
(cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
/tmp/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v
# page: http://127.0.0.1:8000/?test=1&args=-net%20-relay%20ws://127.0.0.1:7778/vnet%20-host-room%202%20--%20-autonet%202,0,2,1,0,0,0,0,0,0
./sw -net -relay 127.0.0.1:7777 -room CODE -- -autonet 2,0,2,1,0,0,0,0,0,0
```

Test-only page parameters (only with `?test=1`; the top of `web/jfsw.js` has the list): `?relay_wt=<https url>` and `?relay_cert=<64 hex>` (an explicit WebTransport URL and the certificate hash of a relay started with `-wt ADDR -dev-cert`), `?impair=<spec>` (`lat=30,jit=10,loss=4,dup=2,reorder=3,seed=N`, a browser has no `VNET_IMPAIR`). Test-only game arguments (all machines): `-testsync`, `-testquit<N>`, `-testnudge<T>` (brief 01) **`-testdump<name>`** (brief 04: this machine writes 17 bytes for every game tic to the file `<name>`: the tic, the nine sync bytes and a 32 bit hash of the whole simulation state; flushed per tic), and from brief 04b **`-teststate[<T>]`** (with `-testdump<name>`: also `<name>.state`, the whole simulation state field by field, one line per object, when the level starts, at tics 1 to 3 and at tic T; repeatable up to 16 tics; slow, so off unless asked) and **`-testlag<name>`** (36 bytes per tic to `<name>`: when this machine's input for the tic was made, when every input was in, when the tic ran, how long its packet waited in mmulti, how long the master held the complete tic, `otherminlag`, `bufferjitter`, the clock corrections so far; at `-testquit` the log says how many datagrams went to each peer). `-testslowstart<ms>` (04b review: this machine waits that long before the level's first frame, clock running; the `tic1` scenario gives it to the master). From brief 04c, **`-testexit<T>,<L>`** (all machines: at the start of game tic T of the first level every machine leaves it for level L, as a level exit switch does but without the co-op bonus screen, and plays no further tic of it (since F3 by the game's own stop at an exit tic, bugs.md L20); the next level's tics count from 1 again, so `-testquit<N>` then ends the game at tic N of the new level); with it, `-teststate` labels the dumps of the second level played `L2.start`, `L2.t1`, and so on (`-teststate<T>` applies to every level). And **`-testdrawcheck[2|3|4]`** (single player: compares what `DrawSetupLevelStats()` makes of every sector with what the level's first frame really leaves, prints `TEST: draw check, ...` and exits; `2` adds a second override marker to every override plane, `3` and `4` are controls that must find differences): `tests/draw-setup.sh` (also `make test-draw`, part of `make test`; about 10 s) runs it on the four shareware levels. From F3, **`-teststall<T>,<ms>`** (this machine only: at the start of game tic T of the first level it stops for `<ms>` ms with its clock running, a yield in the browser, then goes on with the tic; meanwhile the others' inputs arrive, so it holds the inputs of the tics after T) and **`-testfire[<N>]`** (this machine's own inputs select the shurikens and hold fire from tic N of the first level on, and in every later level: its player throws one every 8 tics or so until they run out, so the ammo carried into the next level changes every few tics); and in a game with `-testexit` or `-teststall`, every machine logs `TEST: left the level after tic T, with the inputs of K more tics here` when it leaves a level. From F4 (bugs.md L25): **`-testaimkey<T>[,<N>[,<L>]]`** (this machine only: its Mouse_Aiming key, U, is down while it makes the inputs of game tics T to T+N-1 of the L-th level it plays; N and L are 1 if left out; `getinput()` reads it with the real key, so one press toggles mouse aiming, and every press logs `TEST: Mouse_Aiming key pressed|held|released at tic T of level L: mouse aiming on|off`), **`-testaimheld`** (this machine: mouse aiming in held mode, as the menu's "Momentary" setting; saved in its `sw.cfg`), **`-testaimon`** (this machine starts with mouse aiming on; also saved), **`-testoldaim`** (this machine handles mouse aiming as a build without F4's fix: the flag is set here only, the input carries no `SK_MOUSE_AIM`, its options packet is the old, shorter one, and no player's flag is taken from the input; a stand-in for an older build in one game with newer ones) and, from 05b, **`-testbuildid<name>`** (this machine reports the build `<name>` in its data identity: the other machines print the "different build" line); and **`-testslope<T>,<P>[,<L>]`** (all machines, in the version salt: at the start of game tic T of the L-th level player P is put, standing still and facing along the slope, in the middle of a sloped sector, where `PlayerAutoLook()` tilts the view of a player without mouse aiming; logs `TEST: player P put on sloped sector S ...`). The full formats are in `src/sync.c`.

```sh
scripts/build-wasm.sh && make -j4 && scripts/fetch-test-data.sh   # the tests need the native ./sw as well
node tests/web/netplay.js --list           # the scenarios
node tests/web/netplay.js ws               # one scenario
node tests/web/netplay.js                  # all of them but lag-matrix and old-new, about 28 minutes (brief 05); one at a time, the tests are real time
```

`tests/web/netplay.js` builds the relay with Go as `tests/net/lib.sh` does (`~/.cache/jfsw-browser/vnet-relay-<rev>`), serves `build-wasm/` (`WASM_DIR=other node tests/web/netplay.js ...` for another build, as the mutation runs do) and uses 127.0.0.1 ports 48300 (page), 48301 (relay UDP), 48302 (relay WebSocket) and 48303 (relay WebTransport, UDP); `NETPLAY_PORT_BASE=N` moves them to N to N+3 (brief 02c), for a run next to another on the same machine. Native machines run under `scripts/run-headless.sh` in a temporary directory (`JFSW_TEST_KEEP=1` keeps it). Every scenario ends with "no process this test started is left running".

Brief 04b added three scenarios. `lag` (about 3 minutes, in the full run) plays three measured games (two browsers; a native host with a browser; two native games with 30 ms each way) and checks the send path: a machine's packets wait under 5 ms in mmulti at the median, the master hands on a complete tic within 2 ms at the median and 8 ms at p95, at most 80 datagrams a second go to each peer, the lag correction does not oscillate, and the native slave with 30 ms each way sees its input in a tic within 85 ms at the median. `tic1` (about 2 minutes) gives the master `-testslowstart3000` in 8 games, so it runs tic 1 after one frame while the slave draws many, and checks that they agree field by field. `lag-matrix` (about 7 minutes, **only by name**) is the report: input-to-tic delay of master and slave for every pairing, unimpaired and with 30 ms each way (`NETPLAY_LAG_ONLY=browsers,natives-30ms` picks games, `NETPLAY_LAG_REPS=3` repeats them). Other knobs: `NETPLAY_SW=/path/to/sw` runs another native build (as `WASM_DIR` does for the page); `NETPLAY_STATE=1` gives every machine `-teststate`, and a dump difference then names the objects and fields that differ (`NETPLAY_STATE=600,1200` adds those tics).

Brief 04c added three scenarios (a tab hidden before the level's first frame, bugs.md L19). `hidden-first` (about 2.5 minutes, in the full run) plays four games of 400 tics in which one browser is made hidden as soon as its game is started (before the level loads; the throttling of a background tab is added once its relay session is up): a native host with a hidden browser guest, two browsers, a browser host with a hidden browser guest and a native guest, and a hidden browser host with a native guest. It checks that the hidden tab drew no frame of the level (`numframes` in its state dumps does not move from the level's start to its last tic), that the visible machines did draw before tic 1, that every record and every field agree at the start, at tics 1 to 3 and at the last tic, and that the override sectors have no parallax bit at tic 1. `hidden-level` (about 2.5 minutes, in the full run) does the same across a level change while hidden: E1L1 to E1L3 (six override sectors) at tic 200 with `-testexit200,3`, then 400 tics there, for a native host with a hidden browser, two browsers, and a hidden browser host. `old-new` (about 2 minutes, **only by name**) needs the build from before brief 04c (`NETPLAY_OLD_SW=/path/to/old/sw NETPLAY_OLD_WASM=/path/to/old/build-wasm node tests/web/netplay.js old-new`; the old page is served under `/old/`): in eleven games an old and a new machine play in one room, both visible (every pairing of browser and native, E1L1 and E1L3), and must agree on every record and on every field at tics 1 to 3, and differ when the level starts (before any frame) in exactly the override sectors' stat. The field comparison (`stateDifferences()`) leaves out a player's `FadeAmt` and `FadeTics`, which the original game sets only for the player a machine looks through (`code-facts.md` §17).

05b added `data-mismatch` (about 1.5 minutes, in the full run; bugs.md L26): a browser host on the page's shareware data with a native joiner on a copy with one map changed (made at run time by `tests/net/modgrp.py`; the page itself accepts only GRPs it knows), a native host on the copy with a browser joiner, and a browser and a native on the same data. With different data every machine names the other player and both datas (`unknown data, CRC ...` for the copy), and the browser's page shows the same lines in its notice, which gave Close the focus and closes with it; with the same data nothing is said and no notice shows. Without the exchange the mismatched games fail. Since 05b, `checkGame()` also requires every other scenario to say nothing about data, version or build.

F4 added `mouse-aim` (about 2 minutes, in the full run; bugs.md L25): three games of 400 tics, co-op without monsters, the slaves' datagrams 60 ms late: a browser host presses U at tic 100 against a native joiner, a native host against a browser joiner that presses U at tic 100, and two browsers whose joiner holds U in held mode from tic 250 to 349; every machine puts the player who pressed it on a sloped floor at tic 300 (280 in held mode). It checks the usual game checks (every tic agrees, no desync), that the key turned mouse aiming on, that both machines agree field by field 20 tics after the slope, and that there the player has mouse aiming and an untilted view on both. The game without the fix fails it in every game (9 of 9 in three runs): the host goes out of sync at the slope, and the machine that did not see the key tilts the player's view (`horizoff` 6 against 0).

F3 added `level-exit` (about 70 s, in the full run; bugs.md L20): three games (a native host and a browser, two browsers, a browser host and a native) in which the level ends at tic 200 by `-testexit200` (the next level, E1L2) while the master holds the inputs of the tics after it: every slave's datagrams are 200 ms late (latency impairment, so a slave has made its inputs about 8 tics ahead) and the master stops for 1.5 s inside the exit tic (`-teststall200,1500`); every player throws shurikens from tic 150 (`-testfire150`). It checks that every machine played exactly 200 tics of the first level with the same records, that the second level agrees record for record and field by field at its start, tics 1 to 3 and tic 300, that the master had every player's inputs beyond tic 201 when it left (the case the original game got wrong), and that the shurikens were thrown before and after the exit. The game of the original `MoveLoop` (the fix removed) fails it in every game: the master plays 8 to 17 more tics of the first level (a slave can play extra tics too, fewer than the master), so the tic counts and records always differ; in most games the master also starts the next level with fewer shurikens and goes out of sync there.

Brief 06b added `wt-host` (about 1.5 minutes, in the full run; bugs.md L31): a browser hosts two guests over WebTransport, three browsers and then two browsers and a native guest, 1200 tics each. Every machine agrees on every tic, every browser reports `relay-wt`, the host runs at least 36 tics a second (its `-testlag` record, tic 100 to the end), no page drops a WebTransport datagram (`Module.vnetWT`'s drop counter, sampled during the game) and the relay drops nothing (`/stats` on 127.0.0.1:49701: `wt_rx_queue_drops`, `wt_datagram_drops`, `rate_limited`, `ws_queue_drops`). On vnet 0.4.0 it fails (32 to 35 tics a second, 445 to 514 datagrams dropped by the host). `NETPLAY_RELAY=/path/to/vnet-relay` runs another relay binary (with `WASM_DIR` and `NETPLAY_SW`, a whole older build). `tests/web/firefox.js` part 4 (`FIREFOX_ONLY=4` runs it alone; relay WebTransport on UDP 49702) plays the same game with Firefox as the host and two Chromium guests.

### 6.6 Hosting and joining (brief 05)

**The relay** is the one `web/config.js` names (`relay: 'wss://relay.example.org/vnet'`, or `'ws://127.0.0.1:PORT/vnet'` for a local relay whose `-origins` names the page's host:port). Never from the address, not even on a test page.

**Test mode** (`?test=1` and the test-only parameters at the top of `web/jfsw.js`) needs `testMode: true` in `config.js` as well; the default is `false`, and a public site must keep it so (**the deployed `config.js` leaves `testMode: false`**: [`deploy.md`](deploy.md) §2). The browser tests serve a `config.js` with `testMode: true` themselves (`tests/web/server.js`, `configText()`), so nothing needs changing to run them. To use test pages by hand on your own server, set `testMode: true` in `build-wasm/config.js`.

**Page parameters:**

| Address | What happens |
|---|---|
| `?host=N` | "Click to host a game of N": the game starts with `-net -relay <relay> -host-room N --` and the lobby opens: room code, invite link (with Copy), "J of N players are in", Start now (once 2 are in), Cancel. N is 2 to 8; 4 with the shareware data. |
| `?join=CODE` | "Click to join room CODE": `-net -relay <relay> -room CODE --`; the same lobby without Start now. CODE is 6 letters and digits, any case, no 0, 1, I or O. The invite link is `?join=CODE` on the page's own address. |
| a bad N or CODE, both, or no relay in `config.js` | The page says why and offers "Go to the start page"; no game starts. |

The lobby works with the keyboard alone (Tab, Enter, Space; the game does not see the keys while it is up) and reads at phone width. Cancel leaves the room (the others are told at once) and goes back to the page without `?host=`/`?join=`; so does the button on the end-of-game overlay of a network game. Other parameters (`?data=`, and on a test page `?test=1`, `?args=`, ...) are kept. The invite link is `?join=CODE`, plus `&data=...` when the host's page has `?data=` (every player needs the same game data). Start now with fewer than 2 players in is not offered; once pressed, it shows "Starting..." until every player in the room has answered, and is offered again if they leave.

**In the game** (browser and desktop):
- Console (**Num Lock** opens it; the key is "Show Console" in Options, Input, Keys Setup): `host [players]` (default: the most the data allows), `join <code>`, and on the desktop `relay [HOST:PORT]` (show or set the relay for host and join; kept in `sw.cfg` as `[Comm Setup] Relay = "HOST:PORT"`).
- Main menu: **Host Online** (hot key G, then Enter; a list of 2 to 8 players) and **Join Online** (J, Enter; type the code, Enter). Disabled during a network game.
- Both restart into the network game (D3): the page reloads with `?host=N` / `?join=CODE`; the desktop game quits and re-launches itself with `-net -relay <its relay setting> -host-room N | -room CODE --` and the rest of its arguments (Linux: `/proc/self/exe`). A desktop game without a relay setting says how to set one; a `-net -relay HOST:PORT` start remembers its relay.
- **Start now on the desktop:** type `start` and Enter in the terminal the host was started from, or press "Start now" in the GTK startup window (it shows the lobby while the game waits; `-setup` or a first run opens it). `cancel` (or the window's Cancel) leaves the room.
- **Startup window** (GTK): tick "Online, through the relay:", give the relay's `HOST:PORT`, then "Join multi-player game" with the room code, or "Host multi-player game" with the number of players.

```sh
./sw -net -relay relay.example.org:7777 -host-room 4 --      # prints the room code; type "start" to begin with fewer
./sw                                     # then, in the console:  relay relay.example.org:7777   and   host 3   or   join ABC234
JFSW_TEST_STARTWIN="host=3 relay=127.0.0.1:47180 startnow=2" ./sw -setup    # test only: fills in the window and presses Start
```

**How a network game ends** (each says why on the page, or natively in the console, the log and a message box, and exits with status 1 unless the host ended the game): the relay cannot be reached or none is configured; a bad or unknown room code; the relay's room is full; every place in the game is taken; the game has already started (a late joiner, within about a second); the host left the room before the game started (Cancel: at once; a closed tab: 10 s); the host left the game (15 s after its last packet); a player left the game (the host after 15 s, the others about 2 s later); the relay session was lost (brief 04); the host ended the game (status 0, "The host ended the game."). A hidden tab leaves the co-op bonus screen and the deathmatch table by itself, so it does not hold up the room at a level end.

**Tests** (one at a time; local relay, ports as in 6.5):

```sh
node tests/web/netplay.js start-now      # Start now: 2 of 3 and 2 of 4, browser and native hosts; late joiners refused (about 3 minutes)
node tests/web/netplay.js lobby          # the lobby on ordinary pages (relay in config.js): code, link, count, keyboard, Cancel, phone width (about 1.5 minutes)
node tests/web/netplay.js host-join      # console and menus, browser and native (re-launch); every game agrees on every tic (about 3 minutes)
node tests/web/netplay.js lobby-errors   # every refusal and end of section E, browser and native (about 4 minutes)
node tests/web/netplay.js level-end      # a hidden guest or host at the bonus screen after the real exit switch (about 1.5 minutes)
node tests/web/netplay.js level-end-dm   # the same at the deathmatch stats table (about 1 minute)
node tests/web/netplay.js rejoin-vanish rejoin-quit   # a newcomer at a departed guest's relay address is refused (about 1.5 minutes)
node tests/web/netplay.js compaction     # a game after the lobby renumbered its players (about 1 minute)
tests/net/test-startwin.sh               # the GTK window's online host and join under xvfb-run, and its message for a missing code (in make test-net; about 40 s)
tests/net/test-rejoin.sh                 # natively: a newcomer at a vanished or quit guest's address is refused (in make test-net; about 1 minute)
```

Test-only game arguments from brief 05: **`-testswitch<T>`** (all machines: at tic T of the first level every machine operates the level's exit switch, as a player does; unlike `-testexit` the bonus screen follows) and **`-testosd<T>,<command>`** (this machine runs a console command at tic T, e.g. `-testosd60,host 2`). The test-only environment variable `JFSW_TEST_STARTWIN` fills in the startup window (`host=N`, `room=CODE`, `relay=HOST:PORT`, `startnow=K`) and presses Start. `scripts/run-headless.sh --display` keeps `DISPLAY` for it, and the script now passes its standard input to the game (for `start`).

### 6.7 Deploying, and checking a deployment (brief 06)

Putting the game and the relay online (Arch, Apache, TLS, systemd) is [`deploy.md`](deploy.md). `tests/deploy/check-deploy.sh` follows that guide in a container or a spare machine and plays through it; it is **not** part of `make test`, because it needs root and changes the machine while it runs:

```sh
scripts/build-wasm.sh && make -j4 && scripts/fetch-test-data.sh     # what it deploys
sudo tests/deploy/check-deploy.sh            # everything, about 2 minutes: the guide's default (WebTransport and WebSocket); ends with PASS or FAILED
sudo tests/deploy/check-deploy.sh --ws       # the guide's "Without WebTransport" (the WebSocket-only drop-in)
sudo tests/deploy/check-deploy.sh --no-tls   # the guide's "Without TLS" (plain HTTP, ws://)
sudo tests/deploy/check-deploy.sh --quick    # the set-up and the curl checks only, under a minute
sudo tests/deploy/check-deploy.sh --guide /path/to/deploy.md   # another copy of the guide (the mutation runs)
sudo tests/deploy/check-deploy.sh --keep     # leave Apache, the relay, the user, the files and the sysctl values in place (it says how to undo them)
```

It takes the guide's blocks as they are (each follows a `<!-- check-deploy: NAME -->` comment: `rsync`, `site-config`, `httpd-modules`, `apache-site`, `apache-site-notls`, `relay-build`, `relay-build-server`, `relay-user`, `relay-cert-hook`, `relay-sysctl`, `relay-unit`, `relay-unit-ws`, `curl-checks`, `curl-server`, `desktop-join`), so a change to one of them is checked by the next run: the files deployed are the `rsync` line's (checked against the file table and `build-wasm/`), the relay is built with the guide's own build lines (from the working tree, into the run's directory; nothing is cached, so a changed tree is always what runs), the unit's `User=`, `Group=` and hardening lines are checked and the relay runs as that user with the unit's flags and capabilities, the HTTP and stats listeners must be on 127.0.0.1, the certificate hook must ignore another site's renewal, the sysctl file must be an `/etc/sysctl.d/*.conf`, and the `curl` checks run as written (`CURL_CA_BUNDLE` trusts the test certificate; `tests/deploy/run-block.py` compares the answers with the guide's). It needs Apache 2.4.58+ (`apache2` or `httpd`), openssl, curl, file, python3, setpriv, Go and Playwright's Chromium, and it uses the guide's own ports, which must be free: **TCP 80 and 443, UDP 7777 and 443 (not 443 with `--ws` or `--no-tls`), and 127.0.0.1:8080 and 8081** (no other suite uses them).

While it runs it adds `game.example.org` to `/etc/hosts`, the game to `/srv/http/games/sw` (and a test-mode copy inside it, `check-deploy-test/`, during the game with per-tic records, so that the guide's `<Directory>` settings apply to it too), the system user `vnet-relay`, `/etc/vnet-relay` and two sysctl values (not the last two with `--ws` or `--no-tls`). **It refuses to start if any of these already exists** (a real relay's user or certificate copy is never reused or overwritten), and on every exit it removes what it added, puts the sysctl values and the modes of an existing `/srv/http` and `/srv/http/games` back, and stops Apache and the relay. Apache runs with a small configuration of its own (an Arch-layout `httpd.conf` under a temporary `ServerRoot`), so the distribution's Apache configuration is not touched. Chromium reaches `game.example.org` through `--host-resolver-rules` and trusts the self-signed certificate by its key hash (`--ignore-certificate-errors-spki-list`); for WebTransport it also needs `--webtransport-developer-mode` to accept it (`tests/deploy/play.js`, which stops its native games and the browser on SIGINT or SIGTERM).

## 7. Layout of what brief 00 added

| Path | What |
|---|---|
| `scripts/setup.sh` | native dependencies (apt, pacman) |
| `scripts/setup-emsdk.sh` | pinned Emscripten and the ports |
| `scripts/fetch-test-data.sh` | verified `testdata/swshare.grp` |
| `scripts/setup-firefox.sh` | a pinned stock Firefox and `puppeteer-core` for `tests/web/firefox.js` (brief 02c) |
| `scripts/run-headless.sh` | headless, bounded game runs |
| `tests/fetch-test-data.sh`, `tests/run-headless.sh` | tests for the fetch and run scripts |
| `ext/vnet` | vnet `v0.5.0` (submodule, `8572c74` since brief 06b; `v0.4.0` before; built into the engine library, native and browser) |
| `Makefile.emscripten`, `scripts/build-wasm.sh`, `web/` | the browser build and its page (brief 02) |
| `tests/web/`, `tests/tools/`, `tests/data/` | browser tests, the key-playing shim that records demos, the committed demo |
| `doco/browser/code-facts.md` | what the code does, with file:line |
| `tests/net/` | the network tests of brief 01 (section 8) |

## 8. Network games and their tests (brief 01)

Native players can play through a vnet relay as well as over plain UDP. The relay is a small Go program in the vnet submodule (`ext/vnet/relay`, Go 1.24 or newer); run it on any machine that players can reach by UDP:

```sh
(cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
/tmp/vnet-relay -udp :7777 -http "" -v           # UDP only: no WebSocket (a native-only relay); -max-members 8 is the default room size
```

```sh
./sw -net -relay relay.example.org:7777 -host-room 3 -- -autonet 2,0,2,1,0,0,0,0,0,0
# prints "mmulti: room code ABC234 ..." (stdout, sw.log, the on-screen console), then waits for two more players
./sw -net -relay relay.example.org:7777 -room ABC234 -- -autonet 2,0,2,1,0,0,0,0,0,0
```

`-host-room N` takes 2 up to 4 players on the shareware GRP (8 registered) and the relay's room size; more is clamped with a message. The host can start before every place is filled: `start` and Enter on its standard input, or the startup window's Start now (brief 05, section 6.6, which also has the console's and the menus' host and join). `-autonet` (code-facts §4) starts the game without menus once everyone is in; without it the host picks the game in the menus. A failed start (bad code, no such room, room full, relay down) prints why and exits with status 1. Plain UDP as before: `./sw -net -nm:3 -- ...` for the master, `./sw -net -nm HOST[:PORT] -- ...` for the others. Impairment for testing: `VNET_IMPAIR="loss=5,dup=2,reorder=3,lat=20,jit=10,seed=N"` in the environment (own seed per process). Details: `code-facts.md` §12 and `jfbuild/include/mmulti_vnet.h`.

Tests (all local, on 127.0.0.1, ports 47000 to 47999 from `JFSW_TEST_PORT_BASE`, default 47100; they build the relay with Go into `~/.cache/jfsw-browser` the first time; each stops every process it started):

```sh
make test                      # everything below, about 12 minutes
make test-mmulti               # test 1, 10 runs (no game data needed), about 2 minutes
make test-net GAME_RUNS=3      # tests 2 to 4, the level exit (F3) and mouse aiming (F4); needs testdata/swshare.grp
make test-draw                 # brief 04c: DrawSetupLevelStats against a drawn frame, every shareware level (tests/draw-setup.sh), about 10 s
tests/net/test-level-exit.sh [--sw FILE] [--runs N]           # F3: a level exit while the host holds later inputs (in make test-net, GAME_RUNS runs), about 20 s a run
tests/net/test-data-mismatch.sh [--sw FILE] [--only NAME] [--old-sw FILE]   # 05b: players with different game data or builds are told so (in make test-net), about 1.5 minutes
tests/net/test-mouse-aim.sh [--sw FILE] [--runs N] [--only NAME] [--old]   # F4: mouse aiming toggled, then a slope: 10 games (in make test-net), about 3 minutes a run; --old: every machine as without the fix (must fail)
tests/net/test-mmulti-vnet.sh --runs 10 [--stub-resend]       # mmulti over vnet with loss, duplication, reordering
tests/net/test-three-games.sh [--udp] [--tics N] [--impair SPEC] [--nudge N:T]   # three game processes, co-op, quit after N tics
tests/net/test-udp-unchanged.sh --base-sw "$(tests/net/build-baseline.sh)" [--mutate-wire]   # plain -net against the pre-brief build
tests/net/test-errors.sh [--only REGEX] [--sw FILE]           # bad code, full room, relay down, host leaves, caps
tests/net/test-startwin.sh [--sw FILE]                        # brief 05: the GTK startup window's online host and join, under xvfb-run
```

`tests/net/build-baseline.sh` builds the game as it was before brief 01. **`make test` therefore runs `git worktree add` on your repository** (a detached worktree of the commit this branch was made from, in `~/.cache/jfsw-browser/baseline-<commit>`; `git worktree list` shows it, `git worktree remove` deletes it) and needs network access to the submodule forks the first time (it checks out jfbuild, jfaudiolib and jfmact there and builds them). After editing anything in `jfbuild/`, run `make test` or `make -C jfbuild USE_POLYMOST=1 USE_OPENGL=1 USE_ASM=0 libengine.a`: the top-level `make` does not rebuild an existing `jfbuild/libengine.a`.
