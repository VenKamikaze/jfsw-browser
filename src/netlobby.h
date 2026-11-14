// Hosting and joining a network game through a vnet relay from inside the game (brief 05):
// the start-up wait ("lobby"), "start now", the console and menu commands that restart into a
// network game, and the end of a network game whose host or guest has gone.
// See netlobby.c, and jfbuild/include/mmulti_vnet.h for the transport side.

#ifndef NETLOBBY_H
#define NETLOBBY_H

// The relay for host/join natively (sw.cfg, [Comm Setup] Relay = HOST:PORT). A -net -relay
// HOST:PORT on the command line is remembered here. The browser uses its page's config.js.
extern char NetRelay[128];

// app_main, first thing (before it changes directory): the command line, for a re-launch.
void NetSetArgs(int argc, char const * const argv[]);
// app_main, once the log is open: a re-launched game says so in its new log.
void NetLogRelaunch(void);
// app_main, after a successful -net: remember a -relay HOST:PORT among those arguments.
void NetNoteRelayArg(int argc, char const * const argv[]);

// InitGame's start-up wait (it replaces the loop on initmultiplayerscycle()). Plain UDP waits
// exactly as before. A relay game also feeds the lobby (the browser page's overlay, the GTK
// startup window, the console) and takes "start now" and "cancel" from it. Returns 0 if the
// game is to quit (quitevent), else 1 (the caller checks mmulti_vnet_state() for FAILED).
int NetLobbyWait(void);

// Restart into a network game through the relay (D3): host one of PLAYERS places (code NULL),
// or join the room CODE. In the browser the page reloads with ?host=N / ?join=CODE; natively
// the game quits and re-launches itself with -net -relay ... -host-room N / -room CODE.
// Returns 1 if the restart is under way, 0 (after printing why) if it cannot be done.
int NetRestart(int players, const char *code);
// Is CODE a room code (6 of A-Z without I and O, 2-9, any case)? Upper-cased into OUT[7].
int NetIsRoomCode(const char *code, char *out);

// Natively, after Control() returns: carry out a re-launch NetRestart() asked for (it does not
// return then). 1 while one is pending (Control skips the shareware "give up" screen).
int NetRelaunchPending(void);
void NetRelaunch(void);

// The arguments for -net from the startup window's online choices: -relay NetRelay and
// -host-room N (HOSTROOM > 1) or -room CODE. OUT gets up to 6 pointers (into static storage).
// Returns the count, 0 if no online game was chosen, -1 (after a message) if it cannot be made.
int NetStartwinArgs(const char **out, int hostroom, const char *joinroom);

// From getpackets(): in a relay game, end the game with a message when the host (on a slave) or
// a guest (on the master) has not been heard from for NET_GONE_MS, or the relay session failed
// and nothing more moves. The master tells the remaining players who left.
void NetGoneCheck(void);
#define NET_GONE_MS 15000

// net.c MyCommPlayerQuit: the host quit the game (relay games: the end message says so).
void NetHostQuit(void);
// After Control(): show why a network game ended, if the reason is not otherwise visible.
void NetEndMessage(void);
void NetPageNotice(const char *text);   // brief 05b: the page's notice (browser only)

#endif
