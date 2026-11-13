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

(To be written by the implementer.)
