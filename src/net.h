//-------------------------------------------------------------------------
/*
Copyright (C) 1997, 2005 - 3D Realms Entertainment

This file is part of Shadow Warrior version 1.2

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

Original Source: 1997 - Frank Maddin and Jim Norwood
Prepared for public release: 03/28/2005 - Charlie Wiederhold, 3D Realms
*/
//-------------------------------------------------------------------------

#define PACKET_TYPE_MASTER_TO_SLAVE                 0
#define PACKET_TYPE_SLAVE_TO_MASTER                 1
//#define PACKET_TYPE_PLAYER_NAME                     3
#define PACKET_TYPE_MESSAGE                         4
//#define PACKET_TYPE_GAME_INFO                       8
#define PACKET_TYPE_BROADCAST                       17
#define SERVER_GENERATED_BROADCAST                  18
#define PACKET_TYPE_PROXY                           19

#define PACKET_TYPE_NEW_GAME                        30
//#define PACKET_TYPE_NEW_LEVEL                       31
#define PACKET_TYPE_PLAYER_OPTIONS                  32
#define PACKET_TYPE_RTS                             33
#define PACKET_TYPE_DUMMY                           34
#define PACKET_TYPE_MENU_LEVEL_QUIT                 35
#define PACKET_TYPE_NAME_CHANGE                     36
#define PACKET_TYPE_VERSION                         38

#define PACKET_TYPE_NULL_PACKET                     127
#define PACKET_TYPE_PLAYER_READY                    250
#define PACKET_TYPE_DONT_USE                        255  // old logoff

#define BIT_CODEC TRUE
#define SYNC_TEST TRUE
#define MAXSYNCBYTES 16

#ifdef __GNUC__
#  if __GNUC__ == 4 && __GNUC_MINOR__ >= 7
#    define PACKED __attribute__ ((packed, gcc_struct))
#  else
#    define PACKED __attribute__ ((packed))
#  endif
#else
# define PACKED
# ifdef _MSC_VER
#  pragma pack(1)
# endif
# ifdef __WATCOMC__
#  pragma pack(push,1);
# endif
#endif

// Slave->Master: PlayerIndex = who to send the packet to (-1 = all)
// Master->Slave: PlayerIndex = who sent the packet originally
typedef struct PACKED
    {
    BYTE PacketType;  // first byte is always packet type
    BYTE PlayerIndex;
    } PACKET_PROXY,*PACKET_PROXYp;

typedef struct PACKED
    {
    BYTE PacketType;  // first byte is always packet type
    BYTE FirstPlayerIndex;
    BOOL AutoAim;
    BYTE Level;
    BYTE Episode;
    CHAR Skill;
    BYTE GameType;
    BOOL HurtTeammate;
    BOOL SpawnMarkers;
    BOOL TeamPlay;
    BYTE KillLimit;
    BYTE TimeLimit;
    BOOL Nuke;
    }PACKET_NEW_GAME,*PACKET_NEW_GAMEp;

typedef struct PACKED
    {
    BYTE PacketType;  // first byte is always packet type
    BOOL AutoRun;
    BOOL MouseAimingOn;
    BYTE Color;
    char PlayerName[32];
    BYTE MouseAimInInput;   // 1: this player's mouse aiming travels with each input (SK_MOUSE_AIM)
    }PACKET_OPTIONS,*PACKET_OPTIONSp;

typedef struct PACKED
    {
    BYTE PacketType;  // first byte is always packet type
    BYTE Color;
    char PlayerName[32];
    }PACKET_NAME_CHANGE,*PACKET_NAME_CHANGEp;

typedef struct PACKED
    {
    BYTE PacketType;  // first byte is always packet type
    BYTE RTSnum;
    }PACKET_RTS,*PACKET_RTSp;

typedef struct PACKED
    {
    BYTE PacketType;  // first byte is always packet type
    int Version;
    }PACKET_VERSION,*PACKET_VERSIONp;

#undef PACKED
#ifdef _MSC_VER
# pragma pack()
#endif
#ifdef __WATCOMC__
# pragma pack(pop);
#endif

extern BYTE syncstat[MAXSYNCBYTES];
extern BOOL MouseAimInInput[MAX_SW_PLAYERS_REG];
VOID DoPlayerMouseAimSync(PLAYERp pp);
extern BOOL PredictionOn;
extern PLAYER PredictPlayer;
extern PLAYERp ppp;
extern short predictangpos[MOVEFIFOSIZ];
extern int predictmovefifoplc;
extern BOOL Prediction;
extern short NumSyncBytes;

// ---- Test-only hooks (sync.c). Not for players. ----
// Arguments: -testsync (8 sync bytes in a network game), -testquit<N> (quit
// cleanly, exit status 0, after N game tics), -testnudge<T> (this player
// moves 8 units in x at tic T: a deliberate desync, for proving that the
// sync check bites), -testlag<name> (input-to-tic timing, sync.c),
// -testdump<name> (this machine writes a record of
// every game tic to the file <name>: see sync.c; no effect on the game) and -teststate[<T>]
// (with -testdump, the whole state field by field at the start and at tics 1 to 3 and T),
// -testslowstart<ms> (wait before the first frame of the level), -testexit<T>,<L> (every machine
// leaves the first level at tic T for level L, sync.c). -testquit works in network games only (a single player
// game prints the TEST line but does not exit). All players of a game must be given the same -testsync,
// -testquit and -testexit; this is checked through the version exchange.
extern int TestQuitTics;        // 0 = off
extern int TestQuitReached;
extern int TestNudgeTic;        // -1 = off
extern int SyncChecks, SyncMismatches;      // counted in every game
void TestSyncArg(void);
void TestQuitArg(int tics);
void TestNudgeArg(int tic);
VOID HiddenNetPass(VOID);        // browser build: one pass of the game loop of a hidden tab (net.c)
extern int TestLagOn;           // -testlag<name>: input-to-tic timing, see sync.c
void TestLagArg(const char *name);
void TestLagMade(int idx);      // own input idx made
void TestLagTag(int idx);       // the next packet handed to mmulti carries fifo index idx
void TestLagScan(void);         // after getpackets() stored a packet
void TestLagForward(int idx);   // master: combined packet for idx is handed to sendpacket
void TestLagCorrect(int clockticks);    // a totalclock correction of the lag correction
void TestLagPassStart(void);    // getpackets() begins
void TestLagFlushing(int on);   // SendInputNow() is flushing (1) or done (0)
void TestDumpArg(const char *name);   // -testdump<name>: every machine records each tic to <name> (sync.c)
void TestStateArg(int tic);     // -teststate[<T>]: with -testdump, full state dumps at the start, tics 1-3 and T (sync.c)
void TestStateStart(void);      // -teststate: the full state when RunLevel starts (sync.c)
void TestSlowStartArg(int ms);  // -testslowstart<ms>: wait that long before the first frame (sync.c)
void TestSlowStart(void);       // from RunLevel, after TestStateStart
extern int TestExitTic;         // -testexit<T>,<L>: 0 = off (sync.c)
extern int TestExitLevel;       // L, 0 = the next level
void TestExitArg(const char *arg);
extern int TestSwitchTic;      // -testswitch<T> (sync.c)
void TestSwitchArg(int tic);    // -testswitch<T>: every machine operates the level's exit switch at tic T (sync.c)
void TestOsdArg(const char *arg);   // -testosd<T>,<command>: this machine runs a console command at tic T (sync.c)
void TestStallArg(const char *arg);   // -teststall<T>,<ms>: this machine stops <ms> ms at the start of tic T (sync.c)
void TestFireArg(int tic);      // -testfire[<N>]: this machine's player throws shurikens from tic N on (sync.c)
void TestInputHook(SW_PACKET *loc);   // from faketimerhandler, after getinput
void TestAimKeyArg(const char *arg);  // -testaimkey<T>[,<N>[,<L>]]: this machine's Mouse_Aiming key is down at tics T..T+N-1 (sync.c)
void TestAimHeldArg(void);      // -testaimheld: mouse aiming in held mode on this machine (sync.c)
int TestAimKeyDown(void);       // from getinput: the test's key is down for the input being made
int TestAimKeyPressed(void);    // from getinput: ... and was not for the one before
void TestSlopeArg(const char *arg);   // -testslope<T>,<P>[,<L>]: every machine puts player P on a slope at tic T (sync.c)
void TestLevelEnd(void);        // from RunLevel when it leaves a level
extern int TestDrawCheck;       // -testdrawcheck[2]: DrawSetupLevelStats against the first frame (sync.c)
void TestDrawCheckArg(int mode);
int TestDrawCheckLevel(void);   // from InitLevel: 1 = it took the place of DrawSetupLevelStats
void TestDrawCheckFrame(void);  // from RunLevel after each frame
int TestVersionSalt(void);
void TestTicHook(void);         // from domovethings, once per game tic
void TestQuitFinish(void);      // from RunLevel when TestQuitReached

void InitPrediction(PLAYERp pp);
void DoPrediction(PLAYERp ppp);
void CorrectPrediction(int actualfifoplc);

//TENSW: safe packet senders
void netsendpacket(int ind, BYTEp buf, int len);
void netbroadcastpacket(BYTEp buf, int len);
int netgetpacket(int *ind, BYTEp buf);


enum MultiGameTypes
    {
    MULTI_GAME_NONE,
    MULTI_GAME_COMMBAT,
    MULTI_GAME_COMMBAT_NO_RESPAWN, // JUST a place holder for menus. DO NOT USE!!!
    MULTI_GAME_COOPERATIVE,
    MULTI_GAME_AI_BOTS
    };

//extern SHORT MultiGameType;    // defaults to NONE

// global net vars
// not saved in .CFG file
// used for current game
typedef struct
    {
    LONG KillLimit;
    LONG TimeLimit;
    LONG TimeLimitClock;
    SHORT MultiGameType; // used to be a stand alone global
    BOOL TeamPlay;
    BOOL HurtTeammate;
    BOOL SpawnMarkers;
    BOOL AutoAim;
    BOOL NoRespawn; // for commbat type games
    BOOL Nuke;
    }gNET,*gNETp;

extern gNET gNet;

typedef struct
    {
    int Rules,
        Level,
        Enemy,
        Markers,
        Team,
        HurtTeam,
        Kill,
        Time,
        Color,
        Nuke;
    }AUTO_NET, *AUTO_NETp;

extern AUTO_NET Auto;
extern BOOL AutoNet;

VOID getpackets(VOID);
VOID SendMulitNameChange(char *new_name, int new_color);
VOID InitNetVars(void );
VOID InitTimingVars(void );
VOID PauseAction(void );
VOID ResumeAction(void );
void ErrorCorrectionQuit(void );
void Connect(void );
void waitforeverybody(void );
BOOL MenuCommPlayerQuit(short quit_player);
VOID SendVersion(int version);
VOID InitNetPlayerOptions(void );
VOID CheckVersion(int GameVersion);
VOID SendMessage(short pnum,char *text);
void PauseGame(void );
void ResumeGame(void );

