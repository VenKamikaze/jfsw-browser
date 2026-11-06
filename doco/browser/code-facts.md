# Code facts

What the code actually does, verified in brief 00 against this repository at `browser/00-setup` with the submodules at their pinned commits (jfbuild `40a98be`, jfaudiolib `68be97f`, jfmact `731c0cc`). This replaces [`PROMPT.md`](PROMPT.md) §2. Paths are relative to the repository root; `jfbuild/…` and `jfaudiolib/…` are in the submodules. Line numbers are for those commits.

Each claim from PROMPT §2 is marked **confirmed**, **corrected** or **not found**, in §1. Sections 2 to 9 are what later briefs need that §2 did not say. Section 10 lists things that behave unexpectedly.

How the checks were made: reading the code, plus runs of the real binary on the shareware GRP (`scripts/run-headless.sh`, see [`building.md`](building.md)). Runs are marked "(run)".

## 1. The claims in PROMPT §2

### Networking

| Claim | Verdict | Facts |
|---|---|---|
| `jfbuild/src/mmulti.c` is 1243 lines, behind `jfbuild/include/mmulti.h` | **confirmed** | `wc -l` = 1243. |
| The game calls `initmultiplayersparms`, `initmultiplayerscycle`, `sendpacket`, `getpacket`, `flushpackets`, `uninitmultiplayers` and reads `numplayers`, `myconnectindex`, `connecthead`, `connectpoint2[]`, `networkmode` | **corrected** | Right, plus `initsingleplayers` (`src/game.c`, single player path) and `syncstate` (`src/net.c`, `src/sync.c`). `getpacket` is called only from `src/net.c`, `sendpacket` only from `src/net.c` (6 live sites). `networkmode` is read in one place, `src/game.c:964`. The full list is in §3. |
| One UDP socket, IPv4 and IPv6 (`sockaddr_storage`) | **confirmed** | `mysock` (`mmulti.c:102`), `otherhost[]` is `sockaddr_storage` (`:104`). `USE_IPV6` is `#define`d at `mmulti.c:6`, so `netinit` (`:130`) tries an IPv6 socket first (dual stack) and falls back to IPv4. |
| Default port `0x5bd9` (23513), `-p<port>` | **confirmed** | `#define NETPORT 0x5bd9` (`:101`). `-p<port>` is parsed in `initmultiplayersparms` (`:645`) at `:657-660`, accepted when 1 to 65534. A host argument may carry its own port, `host:port` (`lookuphost`, `:886`, accepted when 1025 to 65534). |
| `MAXPAKSIZ` is 256, well under vnet's 1100 | **confirmed** | `mmulti.c:76`. The 256 bytes include mmulti's own header and CRC (`pakbuf[MAXPAKSIZ]`, `:94`), so game payloads are smaller. vnet's limit is `VNET_MAX_DATAGRAM 1100` (`ext/vnet/include/vnet.h:99`). |
| `MAXPLAYERS` is 16 | **confirmed** | `mmulti.c:75`; the header calls it `MAXMULTIPLAYERS 16` (`mmulti.h:11`). |
| Resending and ordering are inside mmulti (`ipak`/`opak` FIFOs, CRC16) | **confirmed** | `ipak`/`opak`, `FIFSIZ 512` (`:96-98`); `dosendpackets` (`:946`) packs unacknowledged packets plus acks; CRC16 `getcrc16` (`:589`). `pakmem` is a 4 MB arena (`:99`). |
| Master/slave (`-nm`, `-nm:N`): player 0 is the master. Open slots are filled from the first packet a newcomer sends, see "There's a slot to be filled" in `initmultiplayerscycle` | **corrected** | The `-n` options are `-nm`, `-nm:N` (also `-n0`, `-n0:N`; N is 1 to 16), `-np`/`-n1` (`:666-668`). An IP with no `-n` option means `-nm` with 2 players (`:745`). **The slot is not filled in `initmultiplayerscycle`.** The comment at `:785` is where the master checks that every slot has an address (`otherhost[i].ss_family == AF_UNSPEC` means a slot is still open, so not ready). The assignment is in `getpacket` (`:1066-1085`): when the master gets an `0xaa` "ping" (`ic0 == -1`) from a host it does not know, it gives that host the lowest free slot and answers `0xab` carrying `{slot, numplayers, netready}`. See §3. |
| Peer-to-peer (`-np` with a list of hosts) | **confirmed** | `MMULTI_MODE_P2P`. Every machine lists all hosts in the same order, with `*` or `.` standing for itself (`:721-731`); each is told "player i of n" by its peers, and it refuses to start if they disagree (`:1158-1170`). |

### The game's network setup

| Claim | Verdict | Facts |
|---|---|---|
| `main` parses `-net …` (`src/game.c:3524`) | **corrected** | `main` is `jfbuild/src/sdlayer2.c:254`; it initialises SDL and GTK, then calls `app_main` (`:294`). `app_main` is `src/game.c:3372`. It scans for `-net` at `:3487-3493` (`netparam` = the index after `-net`, `endnetparam` = the index of a `--` argument or `argc`) and calls `initmultiplayersparms(endnetparam - netparam, &argv[netparam])` at `:3524-3526`. So `-net -nm:3 -- -level1` is how a master with 3 players is started. **Hazard:** the second, full argument scan has a `-net` skip loop that uses `i` instead of `cnt` (`game.c:3686-3690`; `i` is `MAX_SW_PLAYERS` there, left over from the loop at `:3641`), so it skips nothing: every argument given to mmulti (`-nm:3`, `-p1234`, `-np`, host names with a leading `-`…) is **also** parsed as a game option by prefix (`-s*` skill, `-g*` `initgroupfile`, `-h*` def file, `-col` swallows the next argument, `-name`, …). `-nm`, `-nm:N`, `-np` and `-pNNNN` happen to match none of them today. Briefs 01 and 05: a new `-net` sub-option must not collide with those prefixes, or that loop must be fixed (not done here). |
| The startup window's "join host" field (`HAVE_STARTWIN`, `game.c:3566-3590`, `startgtk_game.c:404`, `startwin_game.c:369`) | **confirmed** | `HAVE_STARTWIN` is set at `game.c:3363-3369` (Windows, macOS frameworks, or `HAVE_GTK`). The window's settings are read back at `startgtk_game.c:398-405` and `startwin_game.c:368-386` (`numplayers`, `joinhost`); `game.c:3567-3592` turns them into `-nm <host>` or `-nm:N` and calls `initmultiplayersparms`. The window is shown when `CONFIG_ReadSetup()` returned -1 (no `sw.cfg`), or `-setup`, or `ForceSetup && no -nosetup` (`:3547`). **So `-nosetup` does not stop it on a first run with no `sw.cfg`** (§10). |
| `InitGame` (`game.c:901`) loops on `initmultiplayerscycle()` until everyone is in (`game.c:932-946`), before graphics load | **confirmed** | `InitGame` is `game.c:901`. Order: `initengine()` (`:910`), `InitSetup()`, `inittimer(120, NULL)`, `InitPalette()`, then at `:932-946` either the wait loop (`handleevents()` each pass; on `quitevent` it just `return`s, `:937-939`, see §10) or `initsingleplayers()`. Then `initsynccrc()`, `MultiSharewareCheck()` (`:953`), `LoadDemoRun()`, `LoadImages("tiles000.art")` (`:971`). The video mode is set later still (log: "Setting video mode" comes after "Loading sound and graphics…") (run). |
| It then fixes `CommPlayers`, `CommEnabled` and `NetBroadcastMode` | **confirmed** | `game.c:955-965`: `CommPlayers = OrigCommPlayers = numplayers`; if more than 1, `CommEnabled = TRUE`, `gNet.MultiGameType = MULTI_GAME_COMMBAT` (or AI bots) and `NetBroadcastMode = (networkmode == MMULTI_MODE_P2P)`. |
| After that the player count never changes | **corrected** | It never goes up, but it goes down: a player who quits mid-level (`MyCommPlayerQuit`, `src/net.c:614`) or from the menu level (`MenuCommPlayerQuit`, `net.c:678`) is marked `IsDisconnected` and `CommPlayers--`. Nobody joins after `InitGame` (D2 holds). |
| Lockstep with sync checks in `src/net.c` and `src/sync.c`, many `waitforeverybody()` calls | **confirmed** | `waitforeverybody` is `net.c:537`; 13 references to it in `src/`. Details in §8. |
| The "Network Game" menu (`menus.c:508-514`, `MNU_StartNetGame` at `menus.c:1994`) only sets options for a session that already exists | **confirmed, with a detail** | The "Start Game" item is `menus.c:508` and the group `networkgroup` is `:514`. `MNU_StartNetGame` (`:1994`) does not touch the connection: it sets `Skill`/`Level` from `gs.NetMonsters`/`gs.NetLevel`, `ExitMenus()`, `DemoPlaying = FALSE`, `ExitLevel = TRUE`, `NewGame = TRUE` and returns to `Control`'s `NewLevel` loop. `MenuLevel` also calls it (`game.c:2104`) for `AutoNet`. |
| `ManualPlayerInsert` (`game.c:4086`) adds a local debug player, not a network one | **confirmed** | `game.c:4086`; it is only reached from `InitLevel` under `#if DEBUG` (`game.c:1370`), and `DEBUG` is `0` (`game.h:32`), so it is dead in this build. |
| Player caps: 4 on shareware, 8 on registered (`game.h:994-996`, `MultiSharewareCheck`) | **confirmed** | `MAX_SW_PLAYERS_SW 4`, `MAX_SW_PLAYERS_REG 8` (`game.h:994-996`). `MultiSharewareCheck` (`game.c:846`) pops a message box and **calls `exit(0)`** when `numplayers > 4` on shareware, after the players have all connected. Brief 05 must limit "Host" to 4 players on the shareware GRP. `MAX_SW_PLAYERS` also sizes arrays, so it is a run-time value (`SW_SHAREWARE` is set by GRP detection). |

### Loops

| Claim | Verdict | Facts |
|---|---|---|
| `Control` (`game.c:2874`) runs `InitGame`, then `NewLevel()` until `QuitFlag` | **confirmed** | `Control` is `game.c:2874-2892`: `InitGame()`, `MNU_InitMenus()`, `GameIntro()`, then `while (!QuitFlag) NewLevel();`, then `TerminateGame()`. |
| `MenuLevel` (`game.c:2069`) and many nested `while (TRUE)` loops (`1730, 1816, 1876, 1993, 2178, 2818, 3126`) block, pumping `handleevents()` and `nextpage()` | **corrected** | The line numbers are right (they are `while (TRUE)` in `LogoLevel`, `CreditsLevel`, `SybexScreen`, `TitleLevel`, `MenuLevel`, `StatScreen`, `RunLevel`), but they are sequential screens, not nested. Every blocking site, not only those, is listed in §5. |

### Console

| Claim | Verdict | Facts |
|---|---|---|
| jfbuild's OSD (`jfbuild/src/osd.c`); game commands registered in `src/osdcmds.c:149-156` | **confirmed** | `SetupOSDCommands` is `osdcmds.c:147-157`: `restartvid`, `vidmode`, `quit`, `showfps`, and `map` (**only when `SW_REGISTERED`**, `:154`). The OSD is fed by `OSD_DispatchQueued()` in the menu and level loops. Other console commands (`CON_*`, `src/console.c`) are separate: the in-game text console. |

### Data

| Claim | Verdict | Facts |
|---|---|---|
| `src/grpscan.c:43-48` lists known GRPs by CRC32 and size | **corrected** | The table `grpfiles[]` is `grpscan.c:42-50`, six entries, not four (below). |
| `ScanGroups` and `IdentifyGroup` (`game.c:3521`) check-sum every GRP on the search path (`addsearchpath`, `game.c:3392-3440`); results cached in `grpfiles.cache` by size and mtime | **confirmed, with details** | They are *defined* in `grpscan.c:127` and `:237`, *called* at `game.c:3521-3522`. `klistpath("/", "*.grp")` (`grpscan.c:140`) lists the **current directory and the search-path directories** (`cache1d.c:911-923` starts with `d = "."`). Note the current directory at that point is already `~/.jfsw` in the default mode, because `chdir` (`game.c:3446`) runs before the scan; so the directory the game was started from is only scanned in portable mode (or if the chdir did not happen). Verified by a run with `HOME=/proc/nonexistent`, no `user_profiles_disabled`, GRP only in the start directory: found (run). Cache file `grpfiles.cache`: `grpscan.c:53`, read at `:71`, written at `:223`, relative to the current directory. A cached entry is trusted when file size and mtime match (`:149-152`); otherwise "Checksumming <file>" is printed and the CRC32 computed. `addsearchpath` calls: `game.c:3392` (DATADIR), `:3404` (app dir), `:3411` (global support dir), `:3423` (cwd, portable mode), `:3437-3440` (`~/.jfsw`). |
| `SWGRP` (environment variable) and `-g<file>` | **confirmed, with limits** | `SWGRP` names the GRP to prefer (`game.c:3517`), default `sw.grp`; `IdentifyGroup` falls back to the first *recognised* GRP found when the name is not among them. `-g<file>` (`game.c:4061`) calls `initgroupfile` on an extra GRP or ZIP (ZIP via kplib, `cache1d.c:8` defines `WITHKPLIB`). **Neither accepts an absolute path**: `findfrompath` strips leading `/` (`cache1d.c:315`), so the name is resolved only against the current directory and the search path (§6) (run). |

GRP table (`src/grpscan.c:42-50`):

| Name | CRC32 | Size | `game` | File name |
|---|---|---|---|---|
| Registered Version | `0x7545319F` | 47,536,148 | `GRPFILE_GAME_REG` | `sw.grp` |
| **Shareware Version** | `0x08A7FA1F` | 26,056,769 | `GRPFILE_GAME_SHARE` | `swshare.grp` |
| Mac Demo Version | `0x4227F535` | 26,056,769 | `GRPFILE_GAME_SHARE` | `swmacshare.grp` |
| Mac Registered Version | `0xD54A99C9` | 47,536,148 | `GRPFILE_GAME_REG` | `swmac.grp` |
| Wanton Destruction (Addon) | `0xA9AAA7B7` | 48,698,128 | `GRPFILE_GAME_WD` | `wt.grp` |
| Twin Dragon (Addon, v1.2) | `0xA1A65BE8` | 12,499,012 | `GRPFILE_GAME_TD`, `GRPFILE_ADDON` | `tdragon12.grp` |

Twin Dragon needs a registered GRP loaded first (`game.c:3594-3610`). The file *name* does not matter to detection (CRC32 and size do); the name only has to end in `.grp` to be scanned.

### Renderer, audio, demos, build

| Claim | Verdict | Facts |
|---|---|---|
| `Makefile` has `USE_POLYMOST ?= 1` and `USE_OPENGL ?= 1` (lines 22-23) | **confirmed** | Also `USE_ASM ?= 1` (`:24`), which `jfbuild/Makefile.shared:114` then forces to `0` for every platform. |
| jfbuild has a `USE_GLES2` path (`jfbuild/src/glbuild.c:142`) | **corrected** | `USE_GLES2` is `#define`d as `12` in `jfbuild/include/build.h:20` and used in `glbuild.c` (15 places), `mdsprite.c`, `polymost.c`, `polymosttex.c`, `sdlayer2.c:846`. `glbuild.c:142` is only inside the GL debug-message callback. Build with `USE_OPENGL=USE_GLES2` (or `12`). Not tried here (D6). |
| With both off, the classic 8-bit software renderer draws through SDL2 (`jfbuild/src/sdlayer2.c`) | **confirmed** | Built and run with `USE_POLYMOST=0 USE_OPENGL=0` (run). `showframe` (`sdlayer2.c:1064`) either blits an SDL surface to the window surface (`SDL_UpdateWindowSurface`, `:1153`, the default) or, when `BUILD_USESDLRENDERER` is set in the environment (`:346`), uses an `SDL_Renderer` + texture (`:905-925`). With `USE_OPENGL` built in but no GL available at run time (`glunavailable`, `BUILD_NOGL` env, `:334`) the same software path is used. |
| jfaudiolib has `driver_sdl.c`, `vorbis.c`, `driver_fluidsynth.c` | **confirmed** | Also `driver_alsa.c` (MIDI sequencer), `driver_nosound.c`, plus Windows and Core Audio drivers. Which are built: §9. |
| Music is `PlaySong` (`src/sounds.c:400`): CD tracks as Ogg files (`OggTrackName`), or MIDI | **confirmed** | `PlaySong` is `sounds.c:400`. It returns at once when `DemoMode` or music is off. For the **shareware** GRP the CD and Ogg branch is skipped (`!SW_SHAREWARE`, `:438`), so shareware plays its MIDI songs only. |
| `-dr<file>` records and `-dp<file>` plays back (with `-level#`) | **confirmed, with details** | `-dr` and `-dp` are `game.c:3868-3893`; `-level#` is `:3799` (a `DEBUG`-only duplicate at `:3969`). Details in §7. |
| Build: Makefiles only | **confirmed** | `Makefile`, `Makefile.deps`, `Makefile.msvc`, plus `xcode/` and `makemsc.bat`. No CMake in jfsw or the three submodules. vnet has a CMake build, but is vendored without it (brief 01). |

## 2. The shape of the program

- `main` (`jfbuild/src/sdlayer2.c:254`) -> `app_main` (`src/game.c:3372`): arguments, `preinitengine()`, `CONFIG_ReadSetup()`, `ScanGroups()`, `-net`, optional startup window, `initgroupfile(grp)`, the rest of the arguments (`game.c:3672-4078`), then `Control()` (`:4080`).
- `Control` -> `InitGame` -> `GameIntro` (logo, intro movie `playanm(0)`, `MenuLevel`) -> `NewLevel` loop. Each `NewLevel` is `InitLevel` + `RunLevel` + `StatScreen` + `TerminateLevel` (`game.c:1566-1625`). In demo mode `NewLevel` calls `DemoPlayBack` instead of `RunLevel`.
- Exits: `QuitFlag` leaves the `Control` loop and calls `TerminateGame`. Many error paths and `swexit` call `exit()` directly from the middle of loops (`net.c:588`, `demo.c:234,572`, `sync.c:525`, `MultiSharewareCheck`). Under Emscripten each of them is a termination of the program.
- A SIGTERM (or any `SDL_QUIT`) sets `quitevent` in `handleevents()`; the level loops turn it into `QuitFlag`, and the game exits with status 0 (run). `scripts/run-headless.sh` uses this to stop a run.

## 3. `mmulti` for brief 01

`jfbuild/include/mmulti.h` declares, and `jfbuild/src/mmulti.c` defines:

| Symbol | Used by the game? | Notes |
|---|---|---|
| `int myconnectindex, numplayers, networkmode` | yes (very widely) | `networkmode` is -1 until a mode is parsed; `MMULTI_MODE_MS 0`, `MMULTI_MODE_P2P 1`. |
| `int connecthead, connectpoint2[MAXMULTIPLAYERS]` | yes (`net.c`, `sync.c`, `save.c`, `game.c`) | A linked list of connected players: `TRAVERSE_CONNECT`. After parse: `connecthead = 0`, `connectpoint2[i] = i+1`, last = -1. |
| `unsigned char syncstate` | yes (`net.c`, `sync.c`) | Defined at `mmulti.c:565`; **nothing in mmulti sets it**. |
| `void initsingleplayers(void)` | yes (`game.c`, single player) | Resets state (`mmulti.c:628`). |
| `void initmultiplayers(int, char const *const[])` | no | Parse + cycle until ready (`:876`). |
| `int initmultiplayersparms(int, char const *const[])` | yes (`game.c:3525, 3582`) | Parses `-p`, `-n…`, host names; opens the socket (`netinit`); returns 1 for a usable multiplayer setup, else 0 (and closes the socket). Sets `networkmode`, `numplayers`, `myconnectindex`, the connect list. |
| `int initmultiplayerscycle(void)` | yes (`game.c:935`) | One step of the start-up wait. Returns non-zero while still waiting; 0 when ready. Called from `InitGame` in a loop with `handleevents()`. |
| `void setpackettimeout`, `sendlogon`, `sendlogoff`, `getoutputcirclesize`, `setsocket`, `genericmultifunction` | no | Empty stubs (`mmulti.c:566-571`). |
| `void uninitmultiplayers(void)` | yes (`game.c`, 3 sites) | Closes the socket. |
| `void sendpacket(int other, unsigned char *buf, int len)` | yes (`net.c`, 6 live call sites, all in `netsendpacket`; two more are commented out) | Reliable, ordered, per-destination; appends to `opak[other]`. |
| `int getpacket(int *other, unsigned char *buf)` | yes (`net.c`) | Reads the socket, handles acks, retransmits, the `0xaa`/`0xab` start-up protocol; returns the length of the next packet from any player, or 0. With `buf == NULL` it only processes (used by `flushpackets` and the start-up cycle). |
| `void flushpackets(void)` | yes (`game.c`, 5 sites) | `getpacket(&i, 0)`: acks and resends only. |

Start-up protocol (master/slave): a slave sends the master `0xaa` pings every 250 ms (`initmultiplayerscycle`, `mmulti.c:815-835`). The master answers each new address with `0xab {slot, numplayers, netready}` (`getpacket`, `:1066-1085`) and records its address (`savesnatchhost`). The master sets `netready` when every slot has an address, has been heard from, and has not timed out (`PRESENCETIMEOUT 2000` ms). The slave takes its slot from the reply (`myconnectindex = pakbuf[k+1]`, `numplayers = pakbuf[k+2]`, `:1130-1145`) and is ready when the master says so. Pings are answered during the game too, with the same slot, so a restarted client gets its slot back; a stranger arriving when all slots have addresses gets no reply.

Other points for brief 01:

- Every packet starts with `crc16ofs` (2 bytes) and ends with the CRC16. A regular packet carries `icnt0` (4 bytes) + 32 bytes of ack bits + the packets. Start-up packets use `icnt0 == -1`.
- Slaves in master/slave mode only talk to the master (`getpacket`, `:1020`, `:1222`). The game itself relays between slaves (`PACKET_TYPE_PROXY`, `net.h:34`, `NetBroadcastMode`).
- `netinit` (`:130`), `netsend` (`:267`) and `netread` (`:400`) are the only socket users: that is where a vnet backend goes. `netuninit` is non-static (`:114`).
- Timing in mmulti uses its own static `GetTickCount()` (a `gettimeofday` wrapper, `mmulti.c:53`), not `totalclock`.
- `jfbuild/src/mmulti_null.c` is an unused stub of the same API (single player only). The `Makefile` builds `mmulti.c` (`jfbuild/Makefile:82`); `mmulti_null.c` is only mentioned in `Makefile.deps:20`. It is a single-player stub (`initmultiplayersparms` returns 0, no packets), so it is no use for netplay, and it defines an extra `isvalidipaddress` that is not in the header.
- Packet type bytes the game puts in the first byte of its payloads: `net.h:27-47` (`PACKET_TYPE_MASTER_TO_SLAVE 0`, `SLAVE_TO_MASTER 1`, `MESSAGE 4`, `BROADCAST 17`, `PROXY 19`, `NEW_GAME 30`, `PLAYER_OPTIONS 32`, `RTS 33`, `MENU_LEVEL_QUIT 35`, `VERSION 38`, `NULL_PACKET 127`, `PLAYER_READY 250`).

## 4. Startup order and the command line (briefs 03, 05)

`app_main` argument handling happens twice: a first scan for `-setup`, `-nosetup`, `-net` and `-?` (`game.c:3467-3510`), and a second, full scan after the GRP is chosen (`:3672-4078`). Arguments seen here, all with a leading `-`:

- `-nosetup`, `-setup`: startup window control (`game.c:3477-3485`).
- `-net <args…> [--]`: passed to mmulti (§3).
- `-level<N>`: start level N (1-based index into `LevelInfo`) at once, skipping the intro and menus (`game.c:3799`); `GameIntro` returns early when `UserMapName` is set (`:2852`). `-s<N>` skill 1 to 4 (`:3807`).
- `-dr<name>`, `-dp<name>`: demo record and play (§7). `-nodemo`: no attract-mode demos (`NoDemoStartup`, `:3741`).
- `-name <player>`, `-g<file>`, `-h<def>`, `-turnscale`, `-movescale`, `-short`, `-nometers`, `-cheat`, `-autonet <rules…>`.
- `DEBUG` is `0` (`game.h:32`), so the `#if DEBUG` options (`-allsync` at `game.c:3745-3751`, `-commbat`, `-coop`, `-bots`, `-ddr`, `-cam`, `-debugsecret`, …) do not exist in this build. `-f2`/`-f4`/`-f8` (`MovesPerPacket`, `game.c:3762-3775`) and `-nopredict` (`PredictionOn`, `:3782-3786`) are **not** inside `#if DEBUG` and do work.

Files and directories, in order of use:

1. `CONFIG_ReadSetup()` (`game.c:3516`) reads `sw.cfg` (`SETUPFILENAME`, `src/common.h:67`, `config.c:581`), relative to the current directory. At that point the current directory is: the directory the game was started in, or `~/.jfsw` (see §6) once `chdir(dirpath)` has run (`game.c:3446`).
2. `ScanGroups()`, `IdentifyGroup()`, then `initgroupfile(grpfile)` (`game.c:3617`, "GRP file: …"), `DetectShareware()` if no recognised GRP.
3. `InitGame`: palette, `LoadDemoRun()` reads `demos.run` and `demotxt.run` with plain `fopen` (`game.c:763-790`), i.e. **from the current directory, not from the GRP**; the shareware GRP has no such files, so no attract-mode demos (run).

## 5. Where the game blocks (brief 02, ASYNCIFY)

The event pump is `handleevents()` (`jfbuild/src/sdlayer2.c:1259`; `SDL_PollEvent` loop; sets `quitevent`, updates keyboard/mouse state and the OSD). The frame flip is `nextpage()` (`jfbuild/src/engine.c:7968`) -> `showframe()` (`sdlayer2.c:1064`) for 8-bit modes. The clock is `totalclock`, advanced by `sampletimer()` (`sdlayer2.c:635`, from `SDL_GetPerformanceCounter`; there is **no timer thread or interrupt**: it is polled: `handleevents()` itself calls `sampletimer()` (`sdlayer2.c:1431`), so every event-pumping loop advances `totalclock`; `faketimerhandler` (starts `net.c:812`, call at `:829`) and `getpackets()` (starts `net.c:1136`, call at `:1143`) call it too; and `inittimer(120, NULL)` registers no callback). Nothing in the game sleeps: every wait is a busy loop on `totalclock`, `handleevents()` and `getpackets()`.

Loops that call `handleevents()` (all need a yield under ASYNCIFY, and the first one that runs would suffice only if every loop reaches it):

| Where | What |
|---|---|
| `game.c:1736` (`LogoLevel`), `1794`/`1804`/`1818` (`CreditsLevel`), `1878` (`SybexScreen`), `1995` (`TitleLevel`) | Intro screens; each `while (TRUE)` ends on a key or a `totalclock` time. |
| `game.c:2180` (`MenuLevel`) | The main menu loop: `handleevents`, `OSD_DispatchQueued`, `MNU_CheckForMenusAnyKey`, `getpackets` when networked, draw, `nextpage`. |
| `game.c:2519` (`BonusScreen`), `2820` (`StatScreen`) | End-of-level screens. |
| `game.c:3128` (`RunLevel`) | The game loop: `handleevents`, `OSD_DispatchQueued`, `MoveLoop` (`getpackets`, `domovethings` while enough input packets), `drawscreen` (calls `nextpage`). **This is the one that runs nearly all the time.** |
| `game.c:936` | `InitGame`'s wait for players. |
| `net.c:576` (`waitforeverybody`), `730` (`ErrorCorrectionQuit`) | Lockstep barriers; also `getpackets()` in the loop. |
| `demo.c:423` (`DemoPlayBack`) | Demo playback loop. |
| `anim.c:349`, `395` | The intro movie (`playanm`). |
| `cache.c:636` | Texture pre-caching (every 8 tiles). |
| `menus.c:1982`, `3557`, `5010` | Modal menu loops and `MNU_Delay`-style waits. |
| `jnstub.c`, `jbhlp.c` | The editor only; not in `sw`. |

Other points:

- `handleevents()` is also where `quitevent` and focus (`appactive`) are set.
- `drawscreen`/`nextpage` are called many times per frame loop iteration; a once-per-`handleevents` yield is enough to get a browser frame.
- The game loop draws as fast as it can and the logic runs at `synctics` (a fixed rate off `totalclock` at 120 Hz); with the polled clock the browser's frame rate does not change game speed, but a hidden-tab throttle will stall lockstep.

## 6. File paths and the search path (brief 03)

The "search path" is a stack in `jfbuild/src/cache1d.c:253-264`: `addsearchpath(dir)` (`:264`) pushes a directory, which must exist. Lookup is `findfrompath` (`:298`): first `./<name>` (the **current directory**), then each search-path directory from the most recently added to the first. Leading `/` are stripped from the name and `..` is collapsed, so an absolute path cannot be opened this way.

`app_main` adds, in this order (`game.c:3388-3445`): `DATADIR` (`/usr/local/share/games/jfsw` by default, from the `Makefile`), the directory of the executable (`Bgetappdir`, `jfbuild/src/compat.c:118`; on Linux from `/proc/<pid>/exe`, `:139`), the global support dir (`Bgetsupportdir(TRUE)`, NULL on Linux), and then either:

- the current directory, if a file named `user_profiles_disabled` exists in it ("portable" mode; no `chdir`), or
- `$HOME/.jfsw` (created if missing), followed by `chdir($HOME/.jfsw)`.

Lookup order (`findfrompath`) is therefore: current directory, then (portable) the same directory again or (default) `~/.jfsw`, then the executable's directory, then `DATADIR`. The GRP scan (`klistpath`) walks the same places: the current directory first, then the stack. In the default mode the current directory at scan time is `~/.jfsw` (the `chdir` comes first), not where the game was started.

What goes where:

| File | Written/read | Relative to |
|---|---|---|
| `sw.cfg` | read at start (`CONFIG_ReadSetup`), written by `CONFIG_WriteSetup` (`config.c:762`) on exit and when settings change | current directory (`~/.jfsw`, or the portable cwd) |
| `sw.log` | `buildsetlogfile("sw.log")` (`game.c:3452`) | same |
| `grpfiles.cache` | `grpscan.c:223` | same |
| `*.dmo`, `*.dms` | demo record (`fopen`) and sync files | same; demo *reading* uses `kopen4load` (§7) |
| save games | `src/save.c` | same |
| the GRP(s) | scanned by CRC32 in the current directory and the search-path directories | cwd at scan time (`~/.jfsw` in default mode) + search path |
| `sw.def`, `swvoxfil.txt`, `swplock.txt`, `swcustom.txt` | `kopen4load`: loose files first (cwd, search path), then the GRP | |

`kopen4load(name, 0)` (`cache1d.c:577`) tries a loose file first via `openfrompath`, then ZIPs added with `-g` (kplib), then the group files from the last added to the first. So a loose file in the search path overrides the same name inside the GRP. `initgroupfile` (`:433`) accepts a ZIP (checked by magic number) as well as a GRP.

Things to know for the browser: there is no `HOME`, `/proc` or `DATADIR` there. In Emscripten's virtual filesystem, put the GRP in the current directory at scan time or in a directory that `addsearchpath` is given. The portable mode (`user_profiles_disabled` in the cwd) already does that and keeps the config in the cwd, so a data folder written by the page needs no engine change. Detection reads the whole GRP once for its CRC32 (26 MB, about 0.1 s natively), then caches the result in `grpfiles.cache`.

## 7. Demos and bounded runs (briefs 01, 02, 04)

There is no "run N frames then quit" option (checked: no such argument in `app_main`). What exists:

- **`-dp<name>` plays back `<name>.dmo` and then exits by itself with status 0**: at the end of `DemoPlayBack`, `if (DemoDone && !DemoMode && !NewGame) { TerminateLevel(); TerminateGame(); exit(0); }` (`src/demo.c:568-573`). It needs the level too: `-level1 -dpname`. Without `-level#` the playback tries `title.map` and ends with "Level not found: title.map" (run). The `.dmo` is read with `kopen4load` (`demo.h:54-58`, `DEMO_FILE_GROUP`): current directory, search path, then the GRP. It runs flat out (no frame limit): a 6-second demo plays in about 6 CPU-seconds natively because it renders every frame (run).
- **`-dr<name>` records `<name>.dmo`** from the start of the level until the game is stopped (no end). It records one player only (`DemoRecCnt`, `demo.h`). Stop it with SIGTERM: the game exits cleanly with 0. The demo is written in 2048-packet buffers (`DEMO_BUFFER_MAX`), so a short recording has data up to the last full buffer. A demo header holds the map name, song, level, the players' start positions, `Skill` and the `gNet` struct (`DemoWriteHeader`, `demo.c:169`); with `fwrite` of C structs, so whether a demo recorded on 64-bit x86 plays back on 32-bit wasm is **unverified** (brief 02 must check).
- **`-demosyncrecord` and `-demosynctest`** (with `-dp`): while a demo plays, `demosync_record()` (`sync.c:498`) writes nine bytes per tic (one per sync function, §8) to `<name>.dms`; `demosync_test()` (`sync.c:511`) reads them back and compares. On a mismatch it prints `Demo out of sync - Sync Byte Number %d - Iteration %d.` to **stdout** and `exit(0)`: **the exit status is 0 on failure**, so a test must grep for that text (run: recorded and re-tested a demo with no mismatch; with an empty `.dms` it reports "Sync Byte Number 0 - Iteration 1"). The `.dms` must be recorded during a *playback* (`-dp -demosyncrecord`), not during `-dr`: `demosync_record` is only called from `DemoPlayBack` (`demo.c:504`). Both flags set `NumSyncBytes = 8` (`game.c:3920, 3927`).
- Demo time is `totalclock`-independent: playback consumes one recorded input packet per `synctics`, so the result depends on game logic only (and on `randomseed`). This is what the determinism checks between native and wasm rely on.
- Shareware has no attract-mode demos: `demos.run` is a loose file (`game.c:763`) and the GRP has no `.dmo` (run: none listed).

Recipe (all with `scripts/run-headless.sh`, same `--workdir`):

```sh
scripts/run-headless.sh --timeout 6 --workdir /tmp/w -level1 -drdemo1     # exits 124 (stopped), writes /tmp/w/demo1.dmo
scripts/run-headless.sh --workdir /tmp/w -level1 -dpdemo1                 # exits 0 by itself
scripts/run-headless.sh --workdir /tmp/w -level1 -dpdemo1 -demosyncrecord # writes demo1.dms
scripts/run-headless.sh --workdir /tmp/w -level1 -dpdemo1 -demosynctest | grep -c "out of sync"   # expect 0
```

## 8. Sync data (briefs 01, 02, 04)

- **What is hashed.** `src/sync.c` has nine functions, each returning one byte (a CRC16 folded to 8 bits, `updatecrc`, table from `initsynccrc`, `sync.c:43-60`): `RandomSync` (the low 16 bits of `randomseed`, and when `NumSyncBytes == 1` also `PlayerSync`, `PlayerSync2`, `MissileSync` folded in), `PlayerSync` (x, y, z, angle of each connected player), `PlayerSync2` (horizon, health, `bcnt`), `SOSync` (sector objects), `EnemySync`, `MissileSync`, `ShrapSync`, `MiscSync`, `MissileSkip4Sync` (positions and angles of the sprites in those status lists). Only the low byte of each coordinate goes in (`& 255`). Names in `SyncNames[]` (`sync.c:280`). `MAXSYNCBYTES` is 16 (`net.h:51`).
- **How many.** `NumSyncBytes` defaults to 1 (`sync.c:36`), so in a network game only the `RandomSync` byte is exchanged; `-demosync*` set 8; `-allsync` (16) is `DEBUG`-only and so absent.
- **When, and what is sent.** `getsyncstat()` (`sync.c:309`) fills the player's `syncval` FIFO from `domovethings` (`player.c:7860`), only if `CommEnabled && CommPlayers >= 2`. `SYNC_TEST` is `TRUE` (`net.h:50`), so the branch at `player.c:7896-7900` is compiled in: it runs `getsyncstat()` when `!(movefifoplc & 0x3f)` (every 64th move) **and, through the `#ifdef DEBUG` `else` (taken, since `DEBUG` is defined as `0`), on every other move too**. So in practice it runs on every move. Each call stores `NumSyncBytes` bytes (1 by default; 9 are computed per call, `SyncFunc[]`). What goes on the wire: `AddSyncInfoToPacket` (`net.c:796`) appends up to 4 pending entries of `NumSyncBytes` bytes each to a movement packet; `GetSyncInfoFromPacket` (`sync.c:416`) compares each other player's value with the master's (`connecthead`) and sets `syncstat[sb] = 1` on a difference.
- **How a desync is reported.** `SyncStatMessage` (`sync.c:336`, called from the draw code): with `NumSyncBytes == 1` it draws "GAME OUT OF SYNC!" and "Restart the game." over the menu font (no console output, no exit); with more it prints "GAME OUT OF SYNC - <name>" and the first failure. For tests this means: in a network test, screen-scrape is the only signal; add a hook (brief 02/04's sync dump) rather than rely on it. For demos, see §7.
- **`syncstate`** (`mmulti.h`): "Missed Network packet!" is drawn when it is non-zero, but mmulti never sets it (§3).

## 9. The SDL layer, audio and build, for brief 02

**Build system.**

- `jfbuild/Makefile.shared` detects the platform from `$(CC) -dumpmachine` (`:22-60`): `LINUX`, `BSD`, `WINDOWS`, `DARWIN`, `HAIKU`, else `UNKNOWN`. Under `emcc` that is `UNKNOWN`/`wasm32-unknown-emscripten`, which skips the Linux blocks (the `-DDATADIR` define at `Makefile:172,176` and the extra `JFAUDIOLIB_LDFLAGS`). `RENDERTYPE` becomes `SDL` for everything but Windows.
- `SDL2CONFIG` (default `sdl2-config`) and `PKGCONFIG` can be overridden (`Makefile.shared:6-9`); `HAVE_GTK` is set from `pkg-config gtk+-3.0`, off with `WITHOUT_GTK=1` (`:92-102`). GTK is only for the startup window (`src/startgtk_game.c`, `jfbuild/src/startgtk_*.c`), not needed in a browser.
- `USE_ASM` is forced to 0 (`Makefile.shared:114`); the engine then builds `a-c.c` instead of `a.c` (`jfbuild/Makefile:73,91`). No NASM needed.
- `jfbuild/Makefile` builds `libengine.a` and `libbuild.a`; `jfaudiolib/Makefile` builds `libjfaudiolib.a` and a `test` program (`all: $(JFAUDIOLIB) test`, so `make all` there also builds `test`).
- The C standard is `-std=c99` for C, `-std=c++98` for the C++ link step (`Makefile:50-51`). vnet needs the POSIX feature-test macro its `CMakeLists.txt:60-66` sets (`-D_POSIX_C_SOURCE=200809L`; `_DARWIN_C_SOURCE` on macOS), see below.
- vnet compile check (throwaway, `gcc`, `-Iext/vnet/include -Iext/vnet/src`, not in the Makefile; re-run in the fix round): with the project's own flags `-std=c99 -W -Wall -fno-strict-aliasing` and **no feature macro**, `src/resolve.c` (`struct addrinfo`, "storage size of 'hints' isn't known") and `src/vnet.c` (`CLOCK_MONOTONIC` undeclared) **fail**; the other 11 compile. With `-D_POSIX_C_SOURCE=200809L` added, all 13 compile with no output, under `-std=c99 -W -Wall -fno-strict-aliasing` and under `-std=c11 -Wall -Wextra -O2`. So brief 01 needs no C11, only the feature-test macro that vnet's `CMakeLists.txt:60-66` sets for its own build (`_POSIX_C_SOURCE=200809L`, `_DARWIN_C_SOURCE` on macOS) when it compiles `ext/vnet/src/*.c`. For Emscripten vnet wants `-lwebsocket.js` and no ports.

**SDL layer** (`jfbuild/src/sdlayer2.c`, 1582 lines; SDL 2 only, `:15`):

- Platform `#if`s: `__APPLE__` (OS X frameworks, window, event quirks), `HAVE_GTK` (startup window, `wmgtk_init` before the first window), `USE_OPENGL` / `USE_POLYMOST` (GL driver loading, swap), `USE_OPENGL == USE_GLES2/USE_GL3` (context attributes, `:844-858`). There are no Windows/Linux-specific blocks in the SDL layer itself.
- `main` calls `SDL_Init(VIDEO | TIMER | GAMECONTROLLER)` (`:261`), `wmgtk_init`, `startwin_open`, `baselayer_init`, then `app_main`. `atexit(uninitsystem)` (`:331`).
- Window: `setvideomode` (`:808`) uses `SDL_CreateWindow`; fullscreen requests become `SDL_WINDOW_FULLSCREEN` (>8 bpp) or `SDL_WINDOW_FULLSCREEN_DESKTOP` (`:876-877`). `sw.cfg` defaults to a 640x480 8-bit fullscreen mode (log: "Setting video mode 640x480 (8-bit fullscreen, display 0)") (run).
- Mouse: `SDL_SetRelativeMouseMode` on focus (`:181,190,546`). Joystick: SDL GameController.
- Timing: `SDL_GetPerformanceCounter` / `SDL_GetTicks` only (`:613-663`). No threads, no signals, no `fork`/`exec`/`system` in the engine, SDL layer or game (checked by grep). `engine.c:5470` installs a SIGFPE handler only under `DEBUGGINGAIDS`.
- Environment variables read: `HOME` (`compat.c:101`), `SWGRP`, `BUILD_NOGL`, `BUILD_GLDRV`, `BUILD_USESDLRENDERER`, `BUILD_NOP6`.
- File system: plain POSIX `open`/`read`/`lseek`/`access`/`stat`/`opendir`, `getcwd`/`chdir` (`game.c:3446`), `mkdir`. `Bgetappdir` uses `/proc/<pid>/exe` on Linux (`compat.c:139`), and `Bgetsupportdir(TRUE)` returns NULL; both are fine when absent. `klistpath` uses `Bopendir`.
- The engine assumes 32-bit `int`; all of it was written for 32-bit, so wasm32 matches the original, but packed structs and `long` use should be checked when native and wasm demos are compared.
- 8-bit rendering is into `frame` (`bytesperline`); `showframe` converts via the window surface, so the software path needs no GL. `getticks()` returns milliseconds as `unsigned int`.
- Sockets: `mmulti.c` uses BSD sockets with `getaddrinfo`, `recvmsg`-style address tracking and `IPV6_PKTINFO`-style options. These do not exist in a browser; brief 01/04 replace them with vnet.

**Audio** (jfaudiolib, 68be97f):

- `jfaudiolib/Makefile:17-62` always builds `drivers.c fx_man.c cd.c multivoc.c mix.c mixst.c pitch.c vorbis.c music.c midi.c driver_nosound.c asssys.c`, and adds by platform: `driver_sdl.c` when `sdl2-config --version` works (`JFAUDIOLIB_HAVE_SDL`), `driver_alsa.c` when `pkg-config alsa` exists (MIDI through the ALSA sequencer, uses a `pthread`), `driver_fluidsynth.c` when `pkg-config fluidsynth` exists (pthread), `-DHAVE_VORBIS` when `pkg-config vorbisfile` exists. `driver_sdlmixer.c` replaces `driver_sdl.c` with `JFAUDIOLIB_USE_SDLMIXER=1`. On this build: SDL, ALSA and vorbisfile. Under `emcc` the `pkg-config` probes find nothing, so only SDL (via `sdl2-config`) would be selected, and vorbis stays off unless `-DHAVE_VORBIS` and the ports are given.
- Sound effects: `FX_Init` (`src/sounds.c:1231`) with `ASS_AutoDetect` picks the SDL driver ("SDLDrv: audio driver: dummy" under `SDL_AUDIODRIVER=dummy`); sample mixing is in `multivoc.c`, fed from an SDL audio callback. `driver_sdl.c:483` starts an `SDL_Thread` only to loop CD playback.
- Music: `MUSIC_Init` (`sounds.c:1339`). MIDI needs ALSA or FluidSynth; without them "Music driver is No Sound" (this container: "ALSADrv: snd_seq_open err -2", harmless). The shareware GRP's songs are MIDI (`.mid` in the GRP), so shareware has no music under Emscripten until a MIDI path exists (Q4, later).
- Ogg: `jfaudiolib/src/vorbis.c` (`HAVE_VORBIS`), used for `OggTrackName` replacement tracks and registered-only.

**Startup window.** `HAVE_STARTWIN` (GTK) is compiled into the default Linux build. Nothing in the browser build needs it (`WITHOUT_GTK=1`).

## 10. Surprises

- `-nosetup` does not suppress the GTK startup window on a first run with no `sw.cfg`, because the test is `configloaded < 0 || …` (`game.c:3547`) and `CommandSetup` is not consulted for the first part. With no `DISPLAY` GTK fails to initialise and the window is skipped. `scripts/run-headless.sh` unsets `DISPLAY` and `WAYLAND_DISPLAY`.
- The `-demosynctest` mismatch exits 0 (§7).
- `InitGame`'s wait for players returns (not exits) on `quitevent` (`game.c:937-939`), after which `Control` carries on to `MNU_InitMenus` with an unfinished initialisation. In the browser, brief 05 should not rely on a quit during the wait; reloading the page is the supported way out (D3).
- An absolute path in `SWGRP` or `-g` silently fails (§1), giving the engine error "Failed to load PALETTE.DAT!" rather than "file not found".
- The default `SDL_VIDEODRIVER` run needs `ALSA lib … seq_hw.c` noise tolerated: it is printed on stderr by libasound when there is no sequencer.
- `MultiSharewareCheck` exits the process for more than 4 players on the shareware GRP (§1).
- Native 64-bit and a future wasm32 build must agree on demo/sync results; that is untested until brief 02.

## 11. Warnings seen in the native build (not fixed)

`make -j4` with the defaults produces 14 compiler warnings, none in anything these briefs touch: `-Wunused-result` on `chdir`, `fread`, `fgets` (`game.c:3441`, `jnstub.c`), `-Wtype-limits` and `-Wsign-compare` in `mdsprite.c`, `polymosttex.c`, `-Wimplicit-fallthrough` in `weapon.c`, `-Warray-bounds` in `sync.c`, `-Wstringop-truncation` in `vorbis.c`, `-Wmaybe-uninitialized` in `rg_etc1.cpp`. With `USE_POLYMOST=0 USE_OPENGL=0`: 10, the same set minus the GL-only ones. The `-Warray-bounds` in `sync.c` is `Player[i].syncval[...]` with `connecthead` = -1 when the list is empty; not reachable in a running game.
