# 05: Host and join from the game

## Goal

A player can host or join an online game without typing command-line arguments: from the in-game console, from the menus, from an invite link in the browser, or from the native startup window. Hosting a browser game shows a lobby with the room code, a copyable invite link and who has joined. The host can start with fewer players than slots ("Start now", Q3). Every way a network game can fail or end tells the player why in plain words.

After this brief, a person who opens the page can play online with a friend using only the page, the menus and a link.

## Read first

- [`README.md`](README.md):
  - D1 to D5 (D3: host and join *restart* into a network game; nothing is torn down in-process);
  - D9 (the lobby is an HTML overlay);
  - Q3 ("Start now": yes; every client must learn the final player count before the game initialises);
  - Q5, and "Working across repos".
- [`PROMPT.md`](PROMPT.md) §5 (05's paragraph) and §0's note from 04c (a hidden guest holds up the room at every level end).
- [`code-facts.md`](code-facts.md) §3 (`mmulti`), §12 (brief 01: `-relay`, `-host-room`, `-room`), §15 (brief 04: the browser's network start, the hidden pass, the error states).
- The Outcomes of [01](01-vnet-transport.md), [02](02-emscripten-port.md), [03](03-data-download.md), [04](04-browser-netplay.md) and [04c](04c-hidden-first-frame.md).
- The code:
  - `jfbuild/include/mmulti_vnet.h` (made for this brief: state, room code, errors, player cap);
  - `jfbuild/src/mmulti.c` `initmultiplayersparms` and the start-up wait;
  - `jfbuild/src/mmulti_vnet.c`;
  - `src/game.c` `InitGame`, argument parsing, the bonus and stats screens (`BonusScreen`, `StatScreen`);
  - `src/osdcmds.c` (console commands);
  - `src/menus.c` (the network/multiplayer menu);
  - `src/startgtk_game.c`, `src/startwin_game.c` (the startup windows);
  - `web/jfsw.js`, `web/index.html`, `web/config.js` (the `relay` field), `web/data.js`;
  - `tests/web/netplay.js` and its helpers.
- vnet's [`relay-protocol.md`](../../ext/vnet/doco/relay-protocol.md) (rooms, `max_members`, errors) and `integration.md`. vnet is pinned and never changed here.
- Optional reference: Bit Riot's netplay lobby and its docs (`VenKamikaze/BitRiot`, `claude` branch; fetch it by URL, see PROMPT §0). It solved similar problems for another game: borrow ideas, not code that doesn't fit.

## What the coordinator found (check it; don't take it as given)

1. **The browser can start a network game today only on a `?test=1` page**, with `?args=-net -relay … -host-room N`. `web/config.js` has a `relay` field (empty by default) waiting for this brief.
2. **The relay knows rooms but sends no membership events.** Who has joined, and the final player count, must come from mmulti's own start-up exchange (the master knows who has connected), not from the relay.
3. **`-host-room N` waits for exactly N players.** "Start now" changes the number of players while players are waiting. Every slave must learn the final count before the game initialises (Q3). A player who arrives after the start must get a clear refusal, not a hang. This is an mmulti change in the jfbuild fork. Keep it small, and keep plain-UDP `-net` unchanged.
4. **A hidden guest holds up the room at every level end** (04c): the co-op bonus screen and the deathmatch stats screen wait for a key on every machine, and a hidden tab cannot press one. These screens are not simulation.

## In scope

### A. Starting a network game from the page (browser)

- `?host=N` and `?join=CODE` in the page address start a network game through the relay in `config.js`, as D3 says. The page builds the `-net -relay … -host-room N` / `-room CODE` arguments itself. They work on a normal page, not only with `?test=1`.
  - Validate both: N must be 2 to the game's limit, and CODE must be six characters from the relay's alphabet, case-insensitive. A bad value gets a clear message on the page, not a game.
  - No relay configured: say so clearly, and never fall back to some other relay.
- The relay URL comes only from `config.js`, never from the address bar (as brief 04 did with its test knobs: a crafted link must not route a visitor through another relay). `?relay=` stays a test-only knob, if it is kept at all.

### B. The lobby overlay (browser, D9)

- An HTML overlay while the network start-up wait runs. It shows:
  - the room code;
  - a copyable invite link (`?join=CODE` on this page's own address);
  - who has joined ("2 of 4") and the wait for the rest;
  - Cancel (back to the normal page);
  - for the host, **Start now**, once at least 2 players are in.
- The data comes from the game through `mmulti_vnet.h`. Add only what is needed, for example the number of players in and the state of the wait, read by the page through a small exported function. Keep `mmulti.h` unchanged (D4).
- The overlay goes when the game starts.
- It works with the keyboard, without a mouse. It is readable at phone width; the game itself is not for phones.

### C. "Start now" (Q3; jfbuild fork and game)

- The host can start with the players who are in (at least 2) before every slot is filled.
- Every machine starts with the same player count and the same player numbers, and learns them before the game initialises: before `InitGame`'s use of `numplayers`, and before the first tic.
- A player who joins after the start is refused with a clear message ("the game has already started"), and the players in the game are not disturbed.
- Prove the game agrees on every tic after a "Start now" with `-testdump`, browser and native, including a 2-of-4 start.
- Plain-UDP `-net` behaves exactly as before, as checked by `tests/net/test-udp-unchanged.sh`.
- Natively, "Start now" is reachable too: from the console (`start`, or similar) or a key during the wait. Say which.

### D. Host and join from inside the game

- **Console:** `host [players]` and `join <code>`. Both restart into a network game (D3):
  - in the browser, they reload the page with `?host=N` / `?join=CODE`;
  - natively, the game re-launches itself with the equivalent arguments (`execv` of its own binary on Linux; document Windows and macOS, and implement them if it is cheap). The relay comes from a setting.
- **Menus:** "Host Online Game" and "Join Online Game" in the original menus, where network games live.
  - Typing a room code into the original menus is the fiddly part. Choose the simplest thing that works: for example, Join opens the console with `join ` typed in, or uses a small text-entry item if one already exists in `menus.c`. Say why.
- **Native settings:** where the relay address lives (an `sw.cfg` setting, and/or a `-relay` remembered from the command line). With none set, `host`/`join` say so clearly. Use placeholder host names in docs (`relay.example.org`).
- **Native startup window** (GTK on Linux; Windows if cheap): a room-code field, and a host option with a player count. Both start the game with the right arguments.

### E. Clear end and error states

- Every failure says why, in words a player understands, on the page (browser) or in a message box or console line (native), and leaves the player somewhere sensible: the normal page, or the menu. The failures:
  - relay unreachable or not configured;
  - bad or unknown room code;
  - room full;
  - game already started;
  - host left during the wait;
  - host left during the game;
  - relay session lost;
  - a guest left mid-game.
- Brief 04 already handles some of these (`host-gone`, `room-full`, `relay-lost`). Reuse its messages; don't duplicate them.
- **The hidden guest at a level end** (finding 4): a network game must not stall indefinitely because one player's tab is hidden at a bonus or stats screen. Choose a fix that touches no simulation, for example a hidden tab continues the screen by itself, or after a short time. Document it. Show that the next level still agrees on every tic (`-testdump`, `-teststate`, as `hidden-level` does).

## Out of scope

- Joining mid-game (D2), peer-to-peer (D5), and any change to vnet or the relay.
- The netcode, the hidden pass's stepping, prediction.
- Matchmaking, public room lists, chat, accounts.
- Deployment (brief 06): Apache, TLS and WebTransport certificates, systemd.
- F1 (on hold).

## Acceptance criteria

1. In the browser, a player can host from the menu or the console, share the invite link, and have a second browser join from it and play a full game, with no `?test=1` and no hand-typed arguments. The same works with a native host and a browser guest, and the other way round.
2. The lobby shows the room code, the invite link and who is in, and updates as players join. Cancel works for both host and guest.
3. "Start now" starts a 2-of-3 and a 2-of-4 game in which every machine agrees on every tic. A late joiner is refused clearly.
4. Natively, `host`/`join` re-launch into a relay game. The startup window can join by code.
5. Every error state in §E is reached by a test and shows its message. None hangs.
6. A hidden guest does not stall the room at a level end, and the next level agrees on every tic.
7. `netplay.js` (all scenarios), `make test`, `smoke.js`, `persist.js`, `data.js` and `determinism.js` pass. The known 100 ms stall check is excepted. Plain-UDP `-net` is unchanged.

## Tests

1. **End to end in Playwright** through a local relay (`tests/web/`, a new `lobby.js` or new `netplay.js` scenarios):
   - host from the menu and from the console;
   - read the room code and invite link from the overlay;
   - join from the link in a second browser;
   - "Start now";
   - play to a `-testquit` end with identical dumps.
2. **Cross-play:** a native host started through `host` (re-launch) with a browser guest from the link, and a browser host with a native guest via `join`.
3. **Error states:** one check per §E item, each asserting its message and that the page or game ends up somewhere sensible within a time bound.
4. **The level-end wait:** a hidden guest at a co-op bonus screen, with a real level exit, not `-testexit`'s shortcut (see F3's Outcome on the bonus-screen path). The room continues, and the next level agrees.
5. **The native startup window:** if it can't be driven in the container, test the argument building it uses, and give play-test steps.
6. **Mutations**, each applied, rebuilt, run and reverted:
   - "Start now" without telling the slaves the final count: a disagreement or hang that the test catches;
   - an overlay that never updates the player count;
   - the level-end fix removed: the hidden guest stalls the room.
7. **Regression:** as in criterion 7.

## Dependencies

- 03 (the data loader), 04, 04b, 04c and F3 (all merged).
- Brief 06 comes after this one.

## Notes

- **Repos:** jfsw-browser and the jfbuild fork, on branches named `browser/05-host-and-join` in both, from `claude`. Merge the fork first and move the pointer, as in 04b. jfaudiolib shouldn't need changes. If jfmact needs changes, stop and ask first: it has no `claude` branch (README, "Working across repos").
- **This is the biggest brief so far.** Commit and push in stages (A+B, C, D, E), each with its tests passing, so that a container restart loses little.
- Ports, time limits and load as in 04's Notes.
- After moving the jfbuild pointer, run `make veryclean && make -j4` (`bugs.md` L9).
- **Update:**
  - `code-facts.md` (a new section);
  - `building.md` (the new page parameters, console commands, settings and tests);
  - `bugs.md` for lesser bugs found;
  - `web/config.js`'s comments for the `relay` field.
- **Play-test steps for the user** (Arch Linux, `pacman`) in the Outcome:
  - host in one browser, join from the link in another, or on another machine on the LAN with a local relay;
  - try "Start now" and Cancel;
  - host natively from the console.

## Outcome

**Status: review.** Implemented 13 Nov 2026 on `browser/05-host-and-join` in jfsw-browser and the jfbuild fork (from `claude` `791c1bf` and `a610e1e`). jfbuild: `18ee1c4` (the mmulti lobby). jfsw-browser: `58b97fa` (stages A to C and the code of D and E), `a80eed0` (the tests of C to E, the menus' layout), `ceca736` (the startup window's test), `33b6d20` (documentation, the lobby quit), `bbec1c5` (test-errors.sh), and the Outcome commit. What the code does, with the details, is `code-facts.md` §19; how to use and test it is `building.md` §6.6.

### What the coordinator found, checked

1. True: only `?test=1&args=...` could start a network game, and `config.js`'s `relay` was unused. Now `?host=N` and `?join=CODE` do it on any page, with the relay from `config.js` only (the fix round removed the test knob `?relay=` and made test mode a `config.js` setting; `lobby-errors` checks both).
2. True: the relay says nothing about members. Who is in comes from mmulti's own start-up exchange: the master counts its places and sends the count to the slaves in a fifth byte of its answer to their pings.
3. True: `-host-room N` waited for N. "Start now" makes the master's `numplayers` the number of players in; the go-ahead and the count travel in the same answer, so no slave can start with another count (the mutation that sends the old count hangs every game). Late joiners are told "the game has already started" (they used to get no answer and fail after 15 s). Plain UDP is unchanged: every new path is behind `mmulti_vnet_active()`; `test-udp-unchanged.sh` passes with old and new binaries mixed.
4. True, and also for the deathmatch table: both screens wait for a key on every machine. A hidden tab in a network game now leaves them at once.

### Choices, and why

- **The lobby's data flow** (D9, "a small exported function"): the game pushes its state to the page (`Module.jfswLobby`, an `EM_JS` call from the wait loop, on every change and every 100 ms) and gets the player's requests back as the return value. Nothing on the page calls into the wasm, so nothing runs inside the game while ASYNCIFY has `main` suspended. `mmulti_vnet.h` gained what the game needs (`lobbyplayers`, `lobbyslots`, `lobbystarted`, `startnow`, `leave`, `silentms`, `tellleft`); `mmulti.h` is unchanged (D4).
- **Who is in, and Cancel:** a guest who leaves the lobby (Cancel, or a closed tab) frees its place, and the later players move down, so "Start now" always keeps places 1 to n-1 and a newcomer can take the free place. Cancel sends a notice (the host's count drops at once, measured 0.4 s; a guest whose host cancels is told at once, 0.2 s); a closed tab is noticed after 3 s of silence.
- **Start now natively:** a line `start` on the host's standard input, or the GTK startup window's Start button, which reads "Start now (J of N in)" during the wait (the window is the only thing on screen then: the video mode is set after the wait, so neither the console nor a key in the game window can be used). Windows and macOS have the standard input only.
- **Menus:** "Host Online" (a list of 2 to 8 players; those above the data's limit are disabled) and "Join Online" in the main menu, where a single player picks a game. The room code is typed into the menus' own text entry, the one the player name uses (`MNU_InputString`), with a check and a message for a bad code. Simpler than opening the console with `join ` typed, and it needs no knowledge of the console. "Host Online Game" did not fit the main menu's large font, hence the shorter names.
- **Host and join restart** (D3): the page reloads with `?host=N`/`?join=CODE` (all other parameters kept); the desktop game sets `QuitFlag`, leaves through `Control()` (skipping the shareware "give up" page) and `execv`s itself (`/proc/self/exe` on Linux, `argv[0]` elsewhere, `_execv` on Windows: written but not built or run here). `host` without a count hosts the most the data allows, since Start now can begin earlier.
- **Native relay setting:** `[Comm Setup] Relay` in `sw.cfg`, set by the console's `relay HOST:PORT`, the startup window's relay field, or a successful `-net -relay HOST:PORT` start. Without one, host and join say how to set it.
- **Startup window** (GTK): one check box, "Online, through the relay:", with the relay's address, turns the existing join field into a room code and the existing player count into `-host-room`. Windows' startup window is unchanged (not cheap to do without a Windows build).
- **The end of a game whose host or guest has gone:** no packet from the host (on a slave) or from a guest (on the master) for 15 s, the relay's default session timeout, ends the game with the reason; the master first tells the others who left. A guest's disappearance cannot be turned into a quit inside the game without changing the netcode (a quit is an input bit that the missing player would have to send), so the game ends for everyone with "player P left the game"; the page offers the start page. The host's own proper quit now says "The host ended the game." to the others.
- **The hidden guest at a level end:** a hidden tab (`jfbuild_browser_hidden_netgame()`) leaves the bonus screen and the deathmatch table at once. No timer for visible players: they behave as in the original game.
- **Tests at a real level exit:** `-testswitch<T>` operates the level's real exit switch sprite (E1L1: sprite 403) through `OperateSprite()`, so `FinishedLevel` is set and every machine goes through `waitforeverybody`, the bonus screen and `TerminateLevel`, unlike `-testexit` (F3's coverage note).

### Error states (section E): where each is tested, with the measured time

| Failure | Message (after "Network game failed: ") | Test | Time |
|---|---|---|---|
| relay not configured | the page: "This page cannot host/join a network game: no relay is set up for it ..." | `lobby-errors` (`no-relay-*`, `relay-knob-ignored`) | at once, no game started |
| relay unreachable | the relay could not be reached | `lobby-errors`, `errors` | about 4 s |
| bad room code / bad player count | the page: "... is not a room code ..." / "... is not a number of players ..." / "the shareware version ... at most 4" | `lobby-errors` (7 cases); the menus: their own message; the console: a console line | at once |
| unknown room code | there is no room with that code | `lobby-errors`, `errors` | under 1 s |
| room full (relay) | the room is full | `lobby-errors`, `errors` | under 1 s |
| game already started | the game has already started (joining a game in progress is not possible) | `start-now` (browser and native late joiners), `lobby` | 0.5 to 1.2 s |
| host left during the wait | the host left the room before the game started (Cancel); the host stopped answering (closed tab, brief 04) | `lobby`, `errors` | 0.2 s; 10 s |
| host left during the game | the host left the game (its machine stopped answering N s ago) | `lobby-errors` (browser and native guests) | 15.1 to 15.3 s |
| relay session lost | the relay ended the session ... (brief 04) | `relay-lost` | under 4 s after thawing |
| a guest left mid-game | player P (Name) left the game (master); player P left the game (the others) | `lobby-errors` (browser and native hosts) | 15.3 s; 17.2 s |

Every browser case ends on the page's overlay with "Back to the start page" (the page without `?host=`/`?join=`); every native case prints the line to the console and `sw.log`, shows a message box and exits 1. "Every place is taken" (`FULL`) only happens if a place's player goes silent for 2 to 3 s while the room is otherwise full; it is not reached by a test.

### Tests (load average while running; 4 shared cores)

| Test | Result | Time, load |
|---|---|---|
| `netplay.js` (all but `lag-matrix` and `old-new`) | **1226 passed, 0 failed** (F3's 914 plus `start-now` 66, `lobby` 27, `host-join` 73, `lobby-errors` 86, `level-end` 60) | 27.5 minutes, load 1.1 to 7.1 |
| `netplay.js lobby` after the last page change (focus) | 27/0 | load 1.7 |
| `make test` (mmulti 10 runs, three games relay and UDP, UDP against the baseline, errors, level exit, startup window, draw) | all PASS; draw 16/0. `test-errors.sh` failed its `guestB-no-slot` and `guestC-room-full` cases first: they expected the old silence (see below); updated, PASS | 7.3 minutes plus 3 for the rest, load 0.9 to 3.8 |
| `tests/net/test-startwin.sh` | PASS (15 checks) | about 30 s, load 1.8 |
| `test-udp-unchanged.sh` | PASS (old and new mmulti and games mixed) | load 2 |
| `smoke.js` | 29/0 | load 0.9 |
| `persist.js` | 15/0 | |
| `grptable.js` | 8/0 | |
| `data.js` | 172/0 | load 3.1 |
| `determinism.js` | 20/1: only the known "no stall over 100 ms" (max 198 ms); native and wasm identical, the `.dms` equals the committed one | load 2.6 |

**`test-errors.sh` changed** (not loosened): `guestB-no-slot` asserted that a newcomer to a started game hears nothing and gives up after at least 14 s with "the host did not answer". The brief asks for a clear refusal, so it now asserts "the game has already started" within 5 s (the old code takes 15 s and says something else, so the case still bites). `guestC-room-full` had filled the relay's room with a joiner that waited for a place that never came; such a joiner is now refused and leaves, so the room is filled by a game of 3 on a relay that takes 3.

### Mutations (each applied, rebuilt, run, reverted)

| Mutation | Test | Result |
|---|---|---|
| "Start now" without telling the slaves the final count: the master's answer carries the original place count (`mmulti.c`) | `start-now` | every game fails: the slaves start a 3- or 4-player game, the master a 2-player one, and no machine gets past the start (all checks after the start fail, 3 of 3 games, 120 s each) |
| an overlay that never updates the player count (`showLobby` ignores `joined`) | `lobby` | 7 checks fail: the host's count and Start now stay at 1 of 3, so the game is never started from the lobby |
| the level-end fix removed (no early exit from the bonus and stats screens) | `level-end` | the room stalls: the visible host waits at E1L2's start for the hidden guest, which waits on the bonus screen; 15 checks fail, neither machine reaches tic 300 of the next level (188 s, then the time limit) |

### Not done, or only partly

- Windows: the re-launch uses `_execv` (written, not built); the Windows startup window has no online choice. macOS: the re-launch uses `argv[0]` (not run). Both have `start` on the standard input for Start now.
- The deathmatch stats screen's hidden-tab exit is the same two lines as the bonus screen's, but no test reaches it (deathmatch test games do not end cleanly: bugs.md L16).
- `FULL` (every place taken while the host still waits) is not reached by a test (see the table above).
- A visible player who does not press a key at the bonus screen still holds up the room, as in the original game (bugs.md L23).

### Play-test on Arch Linux (the user)

1. Get the branch and build from clean (`make veryclean`: the jfbuild pointer moved, bugs.md L9):

   ```bash
   sudo pacman -S --needed base-devel git python go sdl2 libvorbis libogg mesa glu alsa-lib gtk3 chromium
   git fetch origin && git checkout browser/05-host-and-join && git submodule update --init
   make veryclean && make -j4
   scripts/setup-emsdk.sh --with-ports && scripts/build-wasm.sh
   scripts/fetch-test-data.sh && ln -sf ../testdata/swshare.grp build-wasm/
   (cd ext/vnet/relay && go build -o /tmp/vnet-relay ./cmd/vnet-relay)
   ```

2. A local relay and the page with a relay set (terminal 1 and 2). For another machine on the LAN, use this machine's LAN address (say 192.168.1.10) instead of 127.0.0.1 in all four places, and open the page there by that address:

   ```bash
   /tmp/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v          # terminal 1
   sed -i "s|relay: ''|relay: 'ws://127.0.0.1:7778/vnet'|" build-wasm/config.js                   # (build-wasm/ only; web/config.js stays empty)
   (cd build-wasm && python3 -m http.server 8000 --bind 127.0.0.1)                                 # terminal 2
   ```

3. **Host in one browser, join from the link in another.** Open `http://127.0.0.1:8000/?host=3` in Chromium, click "Click to host a game of 3". The lobby shows a room code, an invite link (press Copy) and "1 of 3 players are in". Paste the link into a Firefox window (or a private Chromium window) and click "Click to join room ...": both lobbies say "2 of 3". Check: the code and link are readable, Tab moves through Copy, Start now and Cancel, and in a narrow window (phone width, or the browser's device toolbar) nothing is cut off.
4. **Start now:** press "Start now with 2 players" on the host. Both lobbies go and the game starts in the menus ("Lo Wang is waiting..." on the guest); start a co-op game from the host's Network Game menu and play a minute. Then open the invite link in a third window: it says "the game has already started". Close the guest's tab: about 15 s later the host's page says "player 2 (...) left the game".
5. **Cancel:** host again (`?host=2`), join from the link, press Cancel on the guest: the guest is back on the start page and the host's count goes back to 1 of 2. Join again, then press Cancel on the host: the guest says "the host left the room before the game started" at once.
6. **From the game's menus and console in the browser:** on `http://127.0.0.1:8000/`, start, Escape, "Host Online", "2 Players": the page reloads into the lobby. In another window start a game, Escape, "Join Online", type the code, Enter. Also: the console (Num Lock), `join <code>`. (A laptop without Num Lock: rebind "Show Console" in Options, Input, Keys Setup.)
7. **Host natively from the console** (a terminal, the GTK window may show):

   ```bash
   ./sw                       # in the game: Num Lock, then  relay 127.0.0.1:7777  and  host 2
   ```

   The game closes and starts again into the network game; its terminal and its startup window print the room code ("Lobby: give the other players the room code ..."). Join from a browser with `http://127.0.0.1:8000/?join=CODE`. With 3 places (`host 3`), type `start` and Enter in the terminal, or press "Start now (2 of 3 in)" in the startup window.
8. **The startup window:** `./sw -setup`, Game tab: tick "Online, through the relay:", relay `127.0.0.1:7777`, "Join multi-player game" with a room code from a browser host, Start.
9. **A hidden guest at a level end:** host and join as in 3 (`?host=2`), start co-op, and as the host walks to E1L1's exit switch, switch the guest's browser to another tab (or minimise it) and leave it there. The host presses the switch and Space on the bonus screen; the next level must start on the host within a few seconds (it used to wait for the hidden guest's key). Show the guest's tab again: it is in E1L2 with the host.
10. The tests on your machine, one at a time: `node tests/web/netplay.js lobby start-now host-join lobby-errors level-end` and `tests/net/test-startwin.sh` (needs `xorg-server-xvfb`).

