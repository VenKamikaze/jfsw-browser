//-------------------------------------------------------------------------
/*
Shadow Warrior is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.
*/
//-------------------------------------------------------------------------

// Hosting and joining a network game through a vnet relay from inside the game (brief 05).
// See netlobby.h. Nothing here runs in a plain UDP game or a single player game, except the
// host/join commands, which only start a relay game.

#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
# define _DEFAULT_SOURCE    // realpath, setenv (the game is built with -std=c99)
#endif

#include "build.h"
#include "baselayer.h"
#include "osd.h"
#include "mmulti.h"
#include "mmulti_vnet.h"
#include "game.h"
#include "net.h"
#include "netlobby.h"

#ifdef __EMSCRIPTEN__
# include <emscripten.h>
#elif defined(_WIN32)
# include <process.h>
#else
# include <poll.h>
# include <unistd.h>
#endif

#if defined(RENDERTYPESDL) && defined(HAVE_GTK) && !defined(__EMSCRIPTEN__)
# define NETLOBBY_GTK
# include "startwin.h"
#endif

char NetRelay[128] = "";

static int savedargc;
static char const * const *savedargv;
#ifndef __EMSCRIPTEN__
static char savedexe[BMAX_PATH+1];     // argv[0] made absolute before the game changes directory
#endif

void NetSetArgs(int argc, char const * const argv[])
{
    savedargc = argc;
    savedargv = argv;
#if !defined(__EMSCRIPTEN__) && !defined(_WIN32)
    // The game changes into ~/.jfsw early on (app_main), so a relative argv[0] ("./sw") would name
    // the wrong file by the time of a re-launch. Linux uses /proc/self/exe anyway (NetRelaunch).
    if (argc > 0 && strchr(argv[0], '/') && argv[0][0] != '/')
        {
        char *abs = realpath(argv[0], NULL);
        if (abs && strlen(abs) < sizeof(savedexe)) strcpy(savedexe, abs);
        free(abs);
        }
#elif defined(_WIN32)
    if (argc > 0 && !_fullpath(savedexe, argv[0], sizeof(savedexe)))
        savedexe[0] = 0;
#endif
}

// The new process of a re-launch says so first thing in its log, which it starts afresh
// (JFSW_RELAUNCHED in the environment, set by NetRelaunch).
void NetLogRelaunch(void)
{
#ifndef __EMSCRIPTEN__
    const char *r = getenv("JFSW_RELAUNCHED");
    if (r && *r)
        buildprintf("Re-launched by host/join from a running game:%s\n", r);
#endif
}

void NetNoteRelayArg(int argc, char const * const argv[])
{
#ifndef __EMSCRIPTEN__
    int i;
    for (i = 0; i + 1 < argc; i++)
        {
        if (!Bstrcasecmp(argv[i], "-relay") && argv[i+1][0] != '-' && strlen(argv[i+1]) < sizeof(NetRelay))
            {
            if (strcmp(NetRelay, argv[i+1]))
                buildprintf("The relay %s is remembered for host and join (sw.cfg).\n", argv[i+1]);
            strcpy(NetRelay, argv[i+1]);
            }
        }
#else
    (void)argc; (void)argv;
#endif
}

int NetIsRoomCode(const char *code, char *out)
{
    int n;
    if (!code || strlen(code) != 6) return 0;
    for (n = 0; n < 6; n++)
        {
        char c = code[n];
        if (c >= 'a' && c <= 'z') c = c - 'a' + 'A';
        if (!((c >= 'A' && c <= 'Z') || (c >= '2' && c <= '9')) || c == 'I' || c == 'O') return 0;
        if (out) out[n] = c;
        }
    if (out) out[6] = 0;
    return 1;
}

// ---- The start-up wait ------------------------------------------------------------------------

#define LOBBY_START  1
#define LOBBY_CANCEL 2

#ifdef __EMSCRIPTEN__
// The page's lobby overlay (web/jfsw.js, Module.jfswLobby): what the wait looks like, and what
// the player asked for since the last call (1 start now, 2 cancel).
EM_JS(int, jfsw_page_lobby, (int state, const char *code, int joined, int slots, int host, int started, int pending), {
    if (!Module.jfswLobby) return 0;
    return Module.jfswLobby({ state: state, code: UTF8ToString(code), joined: joined, slots: slots, host: !!host, started: !!started, pending: !!pending }) | 0;
});
// The page restarts itself into a network game (?host=N or ?join=CODE). 1: it is reloading;
// 0: no relay is configured for the page.
EM_JS(int, jfsw_page_netgame, (const char *code, int players), {
    if (!Module.jfswNetGame) return 0;
    return Module.jfswNetGame(UTF8ToString(code), players) | 0;
});
#elif !defined(_WIN32)
// A line "start" typed into the terminal the game was started from (or a pipe). Never read from
// a terminal whose foreground job is not ours: that would stop the game (SIGTTIN).
static int stdinrequest(void)
{
    static int dead;
    static char line[64];
    static int len;
    struct pollfd p;
    char c;
    int r = 0;

    if (dead) return 0;
    if (isatty(0) && tcgetpgrp(0) != getpgrp()) return 0;
    for (;;)
        {
        p.fd = 0; p.events = POLLIN; p.revents = 0;
        if (poll(&p, 1, 0) <= 0 || !(p.revents & (POLLIN|POLLHUP))) break;
        if (read(0, &c, 1) != 1) { dead = 1; break; }
        if (c == '\n' || c == '\r')
            {
            line[len] = 0;
            if (!Bstrncasecmp(line, "start", 5)) r |= LOBBY_START;
            else if (!Bstrncasecmp(line, "cancel", 6)) r |= LOBBY_CANCEL;
            len = 0;
            }
        else if (len < (int)sizeof(line) - 1)
            line[len++] = c;
        }
    return r;
}
#endif

int NetLobbyWait(void)
{
    int joined = -1, slots = -1, state = -1, req, j, s, st, host;
    int hinted = 0;
    unsigned int lastpage = 0;

    while (initmultiplayerscycle())
        {
        handleevents();
        if (quitevent)
            {
            if (mmulti_vnet_active())
                {
                // The startup window's Cancel, a closed window, SIGTERM: tell the others and
                // leave. (Returning, as plain UDP still does, carries on with an unfinished
                // start and crashes a moment later: bugs.md L4.)
                buildputs("Lobby: cancelled; leaving the room.\n");
                mmulti_vnet_leave();
                uninitmultiplayers();
                exit(0);
                }
            return 0;
            }
        if (!mmulti_vnet_active())
            continue;       // plain UDP: the wait as it always was

        req = 0;
        st = mmulti_vnet_state();
        host = mmulti_vnet_hostplayers() > 0;
        j = mmulti_vnet_lobbyplayers();
        s = mmulti_vnet_lobbyslots();
#ifdef __EMSCRIPTEN__
        if (st != state || j != joined || s != slots || getticks() - lastpage >= 100)
            {
            lastpage = getticks();
            req = jfsw_page_lobby(st, mmulti_vnet_roomcode(), j, s, host, 0, mmulti_vnet_startpending());
            }
#else
        (void)lastpage; (void)state;
# ifndef _WIN32
        req = stdinrequest();
# endif
# ifdef NETLOBBY_GTK
        startwin_netlobby(j, s, host && st == MMULTI_VNET_READY);
        if (startwin_netlobby_poll()) req |= LOBBY_START;
# endif
#endif
        if (st == MMULTI_VNET_READY && j > 0 && (j != joined || s != slots))
            buildprintf("Lobby: %d of %d players are in room %s.\n", j, s, mmulti_vnet_roomcode());
#ifndef __EMSCRIPTEN__
        if (st == MMULTI_VNET_READY && host && !hinted)
            {
            hinted = 1;
            buildprintf("Lobby: give the other players the room code %s. To start before every place is filled, "
# ifdef NETLOBBY_GTK
                "press Start now in the startup window, or "
# endif
                "type start and press Enter here.\n", mmulti_vnet_roomcode());
            }
#else
        (void)hinted;
#endif
        if (st != state || j != joined || s != slots)
            fflush(stdout);     // a launcher or a test reading our output wants the count now
        state = st; joined = j; slots = s;

        if (req & LOBBY_CANCEL)
            {
            buildputs("Lobby: cancelled; leaving the room.\n");
            mmulti_vnet_leave();
            uninitmultiplayers();
            exit(0);
            }
        if (req & LOBBY_START)
            {
            if (!host)
                buildputs("Lobby: only the host can start the game.\n");
            else if (!mmulti_vnet_startnow())
                buildputs("Lobby: starting needs at least 2 players in the room; press it again when there are.\n");
            fflush(stdout);
            }
        }

    if (mmulti_vnet_active() && mmulti_vnet_state() != MMULTI_VNET_FAILED)
        {
        buildprintf("Lobby: the game starts with %d players; you are player %d.\n", numplayers, myconnectindex + 1);
        fflush(stdout);
#ifdef __EMSCRIPTEN__
        jfsw_page_lobby(mmulti_vnet_state(), mmulti_vnet_roomcode(), numplayers, numplayers, mmulti_vnet_hostplayers() > 0, 1, 0);
#endif
#ifdef NETLOBBY_GTK
        startwin_netlobby(0, 0, 0);
#endif
        }
    return 1;
}

// ---- Host and join: restarting into a network game (D3) ----------------------------------------

#ifndef __EMSCRIPTEN__
static const char *relaunchargv[256];
static int relaunchargc;
static char relaunchplayers[8], relaunchroom[8];
#endif

int NetRestart(int players, const char *code)
{
    char room[8];

    if (CommEnabled || numplayers > 1)
        {
        buildputs("You are in a network game: leave it first (the menu's Quit), then host or join.\n");
        return 0;
        }
    if (code)
        {
        if (!NetIsRoomCode(code, room))
            {
            buildprintf("\"%s\" is not a room code: a room code is 6 letters and digits (no 0, 1, I or O), as the host's lobby shows it.\n", code);
            return 0;
            }
        }
    else if (players < 2 || players > MAX_SW_PLAYERS)
        {
        buildprintf("A game for 2 to %d players can be hosted%s.\n", MAX_SW_PLAYERS, SW_SHAREWARE ? " with the shareware data" : "");
        return 0;
        }

#ifdef __EMSCRIPTEN__
    if (jfsw_page_netgame(code ? room : "", code ? 0 : players) == 1)
        {
        buildputs(code ? "Joining: the page restarts into the network game.\n" : "Hosting: the page restarts into the network game.\n");
        return 1;
        }
    buildputs("No relay is set up for this page (the relay field of config.js), so it cannot host or join a network game.\n");
    return 0;
#else
    {
    int i;

    if (!NetRelay[0])
        {
        buildputs("No relay is set. Set the relay's address first with the console command  relay HOST:PORT  (it is kept in sw.cfg), "
            "or start the game once with -net -relay HOST:PORT.\n");
        return 0;
        }
    if (savedargc < 1)
        {
        buildputs("The game cannot restart itself here: start it with -net -relay ... instead.\n");
        return 0;
        }

    // the program, the network arguments, then the rest of this run's arguments without its own -net group
    relaunchargc = 0;
    relaunchargv[relaunchargc++] = savedargv[0];
    relaunchargv[relaunchargc++] = "-net";
    relaunchargv[relaunchargc++] = "-relay";
    relaunchargv[relaunchargc++] = NetRelay;
    if (code)
        {
        strcpy(relaunchroom, room);
        relaunchargv[relaunchargc++] = "-room";
        relaunchargv[relaunchargc++] = relaunchroom;
        }
    else
        {
        sprintf(relaunchplayers, "%d", players);
        relaunchargv[relaunchargc++] = "-host-room";
        relaunchargv[relaunchargc++] = relaunchplayers;
        }
    relaunchargv[relaunchargc++] = "--";
    for (i = 1; i < savedargc && relaunchargc < (int)SIZ(relaunchargv) - 1; i++)
        {
        if (!Bstrcasecmp(savedargv[i], "-net") || !Bstrcasecmp(savedargv[i], "/net"))
            {
            for (i++; i < savedargc && strcmp(savedargv[i], "--"); i++) ;
            continue;
            }
        relaunchargv[relaunchargc++] = savedargv[i];
        }
    relaunchargv[relaunchargc] = NULL;

    buildprintf("%s: the game restarts into the network game (relay %s).\n", code ? "Joining" : "Hosting", NetRelay);
    QuitFlag = TRUE;
    return 1;
    }
#endif
}

int NetRelaunchPending(void)
{
#ifdef __EMSCRIPTEN__
    return 0;
#else
    return relaunchargc > 0;
#endif
}

void NetRelaunch(void)
{
#ifndef __EMSCRIPTEN__
    extern void uninitsystem(void);
    char exe[BMAX_PATH+1];
    static char line[2048];
    const char *path = savedexe[0] ? savedexe : relaunchargv[0];
    int i;

    if (!relaunchargc) return;

    line[0] = 0;
    for (i = 0; i < relaunchargc; i++)
        {
        strncat(line, " ", sizeof(line) - strlen(line) - 1);
        strncat(line, relaunchargv[i], sizeof(line) - strlen(line) - 1);
        }
    buildprintf("Re-launching:%s\n", line);
    fflush(stdout);
# ifdef _WIN32
    {
    static char env[sizeof(line) + 20];
    snprintf(env, sizeof(env), "JFSW_RELAUNCHED=%s", line);
    _putenv(env);
    }
# else
    setenv("JFSW_RELAUNCHED", line, 1);
# endif

# if defined(__linux__)
    {
    ssize_t n = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
    if (n > 0) { exe[n] = 0; path = exe; }
    }
# else
    (void)exe;
# endif
    uninitsystem();
# ifdef _WIN32
    {
    // _execv joins the arguments into one command line without quoting them (an argument with a
    // space would be split): quote each one as the C runtime parses them. Not built or run in
    // this project (no Windows build): brief 05's Outcome.
    static char quoted[64][BMAX_PATH*2];
    static const char *qargv[65];
    int n, j, q, bs;
    for (n = 0; n < relaunchargc && n < 64; n++)
        {
        const char *a = relaunchargv[n];
        char *o = quoted[n];
        int len = 0, need = !*a || strpbrk(a, " \t\"") != NULL;
        if (!need) { qargv[n] = a; continue; }
        o[len++] = '"';
        for (j = 0; a[j] && len < (int)sizeof(quoted[n]) - 4; j++)
            {
            for (bs = 0; a[j] == '\\'; j++) bs++;
            if (!a[j]) { for (q = 0; q < bs * 2; q++) o[len++] = '\\'; break; }
            if (a[j] == '"') { for (q = 0; q < bs * 2 + 1; q++) o[len++] = '\\'; }
            else { for (q = 0; q < bs; q++) o[len++] = '\\'; }
            o[len++] = a[j];
            }
        o[len++] = '"';
        o[len] = 0;
        qargv[n] = o;
        }
    qargv[n] = NULL;
    _execv(path, (char * const *)qargv);
    }
# else
    if (strchr(path, '/')) execv(path, (char * const *)relaunchargv);
    else execvp(path, (char * const *)relaunchargv);
# endif
    // only reached if it failed
    buildprintf("The game could not re-launch itself (%s): start it with the arguments above.\n", strerror(errno));
    exit(1);
#endif
}

int NetStartwinArgs(const char **out, int hostroom, const char *joinroom)
{
    static char players[8], room[8];
    int n = 0;

    if (hostroom < 2 && !(joinroom && joinroom[0]))
        return 0;
    if (!NetRelay[0])
        {
        wm_msgbox("Network game failed", "An online game needs the relay's address (HOST:PORT).");
        return -1;
        }
    out[n++] = "-relay";
    out[n++] = NetRelay;
    if (joinroom && joinroom[0])
        {
        if (!NetIsRoomCode(joinroom, room))
            {
            wm_msgbox("Network game failed", "\"%s\" is not a room code: a room code is 6 letters and digits (no 0, 1, I or O).", joinroom);
            return -1;
            }
        out[n++] = "-room";
        out[n++] = room;
        }
    else
        {
        sprintf(players, "%d", hostroom);
        out[n++] = "-host-room";
        out[n++] = players;
        }
    return n;
}

// ---- A network game whose host or guest has gone -----------------------------------------------

static int hostquit;

void NetHostQuit(void)
{
    if (mmulti_vnet_active())
        hostquit = 1;
}

void NetEndMessage(void)
{
    if (hostquit && myconnectindex != connecthead)
        {
        buildputs("The host ended the game.\n");
        wm_msgbox("Network game over", "The host ended the game.");
        }
}

static void NetFailExit(const char *why)
{
    buildprintf("Network game failed: %s\n", why);
    uninitmultiplayers();
    wm_msgbox("Network game failed", "%s.", why);
    exit(1);
}

void NetGoneCheck(void)
{
    static unsigned int lastcheck, stucksince;
    static int stuckplc = -1;
    char why[160];
    int i, s;

    if (!CommEnabled || numplayers < 2 || !mmulti_vnet_active())
        return;
    if (getticks() - lastcheck < 250)
        return;
    lastcheck = getticks();

    if (mmulti_vnet_state() == MMULTI_VNET_FAILED)
        {
        // The relay session is lost, or the master said a player left. RunLevel ends the game
        // itself once nothing more moves; this covers the waits outside it (between levels, the
        // menus): the same rule, nothing moved for 2 s.
        if (movefifoplc != stuckplc)
            {
            stuckplc = movefifoplc;
            stucksince = getticks();
            }
        else if (getticks() - stucksince > 2000)
            NetFailExit(mmulti_vnet_errormsg());
        return;
        }

    if (myconnectindex == connecthead)
        {
        TRAVERSE_CONNECT(i)
            {
            if (i == myconnectindex)
                continue;
            s = mmulti_vnet_silentms(i);
            if (s > NET_GONE_MS)
                {
                mmulti_vnet_tellleft(i);
                snprintf(why, sizeof(why), "player %d (%s) left the game (their machine stopped answering %d s ago)",
                    i + 1, Player[i].PlayerName, s / 1000);
                NetFailExit(why);
                }
            }
        }
    else
        {
        s = mmulti_vnet_silentms(connecthead);
        if (s > NET_GONE_MS)
            {
            snprintf(why, sizeof(why), "the host left the game (its machine stopped answering %d s ago)", s / 1000);
            NetFailExit(why);
            }
        }
}
