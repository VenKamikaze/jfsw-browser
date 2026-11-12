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
#include "build.h"

#include "keys.h"
#include "game.h"
#include "tags.h"
#include "names2.h"
#include "net.h"
#include "mmulti_vnet.h"
#ifndef _WIN32
#include <time.h>
#endif
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif
#include "menus.h"

BOOL SyncPrintMode = TRUE;
short NumSyncBytes = 1;
int SyncChecks, SyncMismatches;
char sync_first[MAXSYNCBYTES][60];
int sync_found = FALSE;

static int crctable[256];
#define updatecrc(dcrc,xz) (dcrc = (crctable[((dcrc)>>8)^((xz)&255)]^((dcrc)<<8)))

void initsynccrc(void)
{
	int i, j, k, a;

	for(j=0;j<256;j++)      //Calculate CRC table
	{
		k = (j<<8); a = 0;
		for(i=7;i>=0;i--)
		{
			if (((k^a)&0x8000) > 0)
				a = ((a<<1)&65535) ^ 0x1021;   //0x1021 = genpoly
			else
				a = ((a<<1)&65535);
			k = ((k<<1)&65535);
		}
		crctable[j] = (a&65535);
	}
}

#if SYNC_TEST
BYTE
PlayerSync(VOID)
    {
    short i;
    unsigned short crc = 0;
    PLAYERp pp;

    for (i = connecthead; i >= 0; i = connectpoint2[i])
        {
        pp = Player + i;
        updatecrc(crc, pp->posx & 255);
        updatecrc(crc, pp->posy & 255);
        updatecrc(crc, pp->posz & 255);
        updatecrc(crc, pp->pang & 255);
        }

    return ((BYTE) crc & 255);
    }

BYTE
PlayerSync2(VOID)
    {
    short i;
    unsigned short crc = 0;
    PLAYERp pp;

    for (i = connecthead; i >= 0; i = connectpoint2[i])
        {
        pp = Player + i;

        updatecrc(crc, pp->horiz & 255);
        updatecrc(crc, User[pp->PlayerSprite]->Health & 255);
        updatecrc(crc, pp->bcnt & 255);
        }

    return ((BYTE) crc & 255);
    }

BYTE
SOSync(VOID)
    {
    unsigned short crc = 0;
    SECTOR_OBJECTp sop;

    for (sop = SectorObject; sop < &SectorObject[MAX_SECTOR_OBJECTS]; sop++)
        {
        // if (sop->xmid == MAXLONG)
        // continue;

        updatecrc(crc, (sop->xmid) & 255);
        updatecrc(crc, (sop->ymid) & 255);
        updatecrc(crc, (sop->zmid) & 255);
        updatecrc(crc, (sop->vel) & 255);
        updatecrc(crc, (sop->ang) & 255);
        updatecrc(crc, (sop->ang_moving) & 255);
        updatecrc(crc, (sop->spin_ang) & 255);
        }

    return ((BYTE) crc & 255);
    }


BYTE
EnemySync(VOID)
    {
    unsigned short crc = 0;
    short j, nextj;
    SPRITEp spr;

    TRAVERSE_SPRITE_STAT(headspritestat[STAT_ENEMY], j, nextj)
        {
        spr = &sprite[j];
        updatecrc(crc, (spr->x) & 255);
        updatecrc(crc, (spr->y) & 255);
        updatecrc(crc, (spr->z) & 255);
        updatecrc(crc, (spr->ang) & 255);
        }

#if 0
    extern char DemoTmpName[];
    //DSPRINTF(ds, "Demo Tmp Name %s", DemoTmpName);
    //MONO_PRINT(ds);

        {
        if (Once < 1 && DemoTmpName[0] != '\0')
            {
            FILE *fout;

            Once++;
            fout = fopen(DemoTmpName, "wb");

            //DSPRINTF(ds, "Demo Tmp Name %s", DemoTmpName);
            //MONO_PRINT(ds);

            TRAVERSE_SPRITE_STAT(headspritestat[STAT_ENEMY], j, nextj)
                {
                spr = &sprite[j];

                fprintf(fout, "num %d, spr->x %d, spr->y %d, spr->z %d, spr->ang %d, spr->picnum %d\n", j, spr->x, spr->y, spr->z, spr->ang, spr->picnum);
                }
            fclose(fout);
            }
        }
#endif

    return ((BYTE) crc & 255);
    }

BYTE
MissileSync(VOID)
    {
    unsigned short crc = 0;
    short j, nextj;
    SPRITEp spr;

    TRAVERSE_SPRITE_STAT(headspritestat[STAT_MISSILE], j, nextj)
        {
        spr = &sprite[j];
        updatecrc(crc, (spr->x) & 255);
        updatecrc(crc, (spr->y) & 255);
        updatecrc(crc, (spr->z) & 255);
        updatecrc(crc, (spr->ang) & 255);
        }

    return ((BYTE) crc & 255);
    }

BYTE
MissileSkip4Sync(VOID)
    {
    unsigned short crc = 0;
    short j, nextj;
    SPRITEp spr;

    TRAVERSE_SPRITE_STAT(headspritestat[STAT_MISSILE_SKIP4], j, nextj)
        {
        spr = &sprite[j];
        updatecrc(crc, (spr->x) & 255);
        updatecrc(crc, (spr->y) & 255);
        updatecrc(crc, (spr->z) & 255);
        updatecrc(crc, (spr->ang) & 255);
        }

    return ((BYTE) crc & 255);
    }

BYTE
ShrapSync(VOID)
    {
    unsigned short crc = 0;
    short j, nextj;
    SPRITEp spr;

    TRAVERSE_SPRITE_STAT(headspritestat[STAT_SHRAP], j, nextj)
        {
        spr = &sprite[j];
        updatecrc(crc, (spr->x) & 255);
        updatecrc(crc, (spr->y) & 255);
        updatecrc(crc, (spr->z) & 255);
        updatecrc(crc, (spr->ang) & 255);
        }

    return ((BYTE) crc & 255);
    }

BYTE
MiscSync(VOID)
    {
    unsigned short crc = 0;
    short j, nextj;
    SPRITEp spr;

    TRAVERSE_SPRITE_STAT(headspritestat[STAT_MISC], j, nextj)
        {
        spr = &sprite[j];
        updatecrc(crc, (spr->x) & 255);
        updatecrc(crc, (spr->y) & 255);
        updatecrc(crc, (spr->z) & 255);
        updatecrc(crc, (spr->ang) & 255);
        }

    return ((BYTE) crc & 255);
    }

BYTE
RandomSync(VOID)
    {
    unsigned short crc = 0;

    updatecrc(crc, randomseed & 255);
    updatecrc(crc, (randomseed >> 8) & 255);

    if (NumSyncBytes == 1)
        {
        updatecrc(crc,PlayerSync() & 255);
        updatecrc(crc,PlayerSync2() & 255);
        updatecrc(crc,MissileSync() & 255);
        }

    return ((BYTE) crc & 255);
    }

/*
#define STAT_SKIP2_START    2
#define STAT_ENEMY          2
#define STAT_DEAD_ACTOR     3 //misc actor stuff - dead guys etc
#define STAT_MISSILE        4
#define STAT_SKIP2_END      4

#define STAT_SKIP4_START    5
#define STAT_ITEM           5
#define STAT_SKIP4          6
#define STAT_MISSILE_SKIP4  7
#define STAT_ENEMY_SKIP4    8
#define STAT_SKIP4_END      8
*/

char *SyncNames[] =
    {
    "RandomSync",
    "PlayerSync",
    "PlayerSync2",
    "SOSync",
    "EnemySync",
    "MissileSync",
    "ShrapSync",
    "MiscSync",
    "MissileSkip4Sync",
    NULL
    };

static BYTE(*SyncFunc[MAXSYNCBYTES + 1]) (VOID) =
    {
    RandomSync,
    PlayerSync,
    PlayerSync2,
    SOSync,
    EnemySync,
    MissileSync,
    ShrapSync,
    MiscSync,
    MissileSkip4Sync,
    NULL
    };

void
getsyncstat(void)
    {
    int i;
    PLAYERp pp = Player + myconnectindex;

    if (!CommEnabled)
        return;

    if (CommPlayers < 2)
        return;

    for (i = 0; SyncFunc[i]; i++)
        {
        pp->syncval[pp->syncvalhead & (SYNCFIFOSIZ - 1)][i] = (*SyncFunc[i])();
        }

    pp->syncvalhead++;
    }

////////////////////////////////////////////////////////////////////////
//
// Sync Message print
//
////////////////////////////////////////////////////////////////////////


void
SyncStatMessage(void)
    {
    int i, j;
    static unsigned int MoveCount = 0;
    extern unsigned int MoveThingsCount;

    if (!CommEnabled)
        return;

    if (!SyncPrintMode)
        return;

    if (CommPlayers <= 1)
        return;

    for (i = 0; i < NumSyncBytes; i++)
        {
        // syncstat is NON 0 - out of sync
        if (syncstat[i] != 0)
            {
            if (NumSyncBytes > 1)
                {
                sprintf(ds, "GAME OUT OF SYNC - %s", SyncNames[i]);
                printext256(68L, 68L + (i * 8), 1, 31, ds, 0);
                }

            if (!sync_found && sync_first[i][0] == '\0')
                {
                // sync_found one so test all of them and then never test again
                sync_found = TRUE;

                // save off loop count
                MoveCount = MoveThingsCount;

                for (j = 0; j < NumSyncBytes; j++)
                    {
                    if (syncstat[j] != 0 && sync_first[j][0] == '\0')
                        {
                        sprintf(ds, "OUT OF SYNC - %s", SyncNames[j]);
                        strcpy(sync_first[j], ds);
                        }
                    }
                }
            }
        }

    // print out the sync_first message you got
    for (i = 0; i < NumSyncBytes; i++)
        {
        if (sync_first[i][0] != '\0')
            {
            if (NumSyncBytes > 1)
                {
                sprintf(ds, "FIRST %s", sync_first[i]);
                printext256(50L, 50L, 1, 31, ds, 0);
                sprintf(ds, "MoveCount %u",MoveCount);
                printext256(50L, 60L, 1, 31, ds, 0);
                }
            else
                {
                short w,h;
                // production out of sync error

                sprintf(ds,"GAME OUT OF SYNC!");
                MNU_MeasureString(ds, &w, &h);
                MNU_DrawString(TEXT_TEST_COL(w), 20, ds, 0, 19);

                sprintf(ds,"Restart the game.");
                MNU_MeasureString(ds, &w, &h);
                MNU_DrawString(TEXT_TEST_COL(w), 30, ds, 0, 19);
                }
            }
        }

    if (syncstate != 0)
        printext256(68L, 92L, 1, 31, "Missed Network packet!", 0);
    }


void
GetSyncInfoFromPacket(char *packbuf, int packbufleng, int *j, int otherconnectindex)
    {
    int sb, i;
    extern int syncvaltottail;
    PLAYERp ppo = &Player[otherconnectindex];
    BOOL found = FALSE;

    // have had problems with this routine crashing when players quit
    // games.

    // if ready2send is not set then don't try to get sync info

    if (!ready2send)
        return;

    // Suspect that its trying to traverse the connect list
    // for a player that does not exist.  This tries to take care of that

    TRAVERSE_CONNECT(i)
        {
        if (otherconnectindex == i)
            found = TRUE;
        }

    if (!found)
        return;

    // sync testing
    //while ((*j) != packbufleng) // changed this on Kens suggestion
    while ((*j) < packbufleng)
        {
        for (sb = 0; sb < NumSyncBytes; sb++)
            {
            ppo->syncval[ppo->syncvalhead & (SYNCFIFOSIZ - 1)][sb] = packbuf[(*j)++];
            }
        ppo->syncvalhead++;
       }

    // update syncstat
    // if any of the syncstat vars is non-0 then there is a problem
    for (i = connecthead; i >= 0; i = connectpoint2[i])
        {
        if (Player[i].syncvalhead == syncvaltottail)
            return;
        }

    //for (sb = 0; sb < NumSyncBytes; sb++)
    //    syncstat[sb] = 0;

    while (TRUE)
        {
        for (i = connectpoint2[connecthead]; i >= 0; i = connectpoint2[i])
            {
            for (sb = 0; sb < NumSyncBytes; sb++)
                {
                if (Player[i].syncval[syncvaltottail & (SYNCFIFOSIZ - 1)][sb] != Player[connecthead].syncval[syncvaltottail & (SYNCFIFOSIZ - 1)][sb])
                    {
                    // the on-screen "GAME OUT OF SYNC" message is not visible to a
                    // log or a test: say it once per sync byte (tic = sync check index)
                    if (!syncstat[sb])
                        buildprintf("GAME OUT OF SYNC: tic %d, sync byte %d (%s), player %d differs from the master\n",
                            syncvaltottail, sb, SyncNames[sb], i);
                    SyncMismatches++;
                    syncstat[sb] = 1;
                    }
                }
            }

        SyncChecks++;
        syncvaltottail++;

        for (i = connecthead; i >= 0; i = connectpoint2[i])
            {
            if (Player[i].syncvalhead == syncvaltottail)
                return;
            }
        }
    }


////////////////////////////////////////////////////////////////////////
//
// Demo Sync recording and testing
//
////////////////////////////////////////////////////////////////////////

extern FILE *DemoSyncFile;

void
demosync_record(void)
    {
    int i;
    BYTE sync_val;

    for (i = 0; SyncFunc[i]; i++)
        {
        sync_val = (*SyncFunc[i]) ();
        fwrite(&sync_val, sizeof(sync_val), 1, DemoSyncFile);
        }
    }

void
demosync_test(int cnt)
    {
    int i;
    BYTE sync_val;

    for (i = 0; SyncFunc[i]; i++)
        {
        fread(&sync_val, sizeof(sync_val), 1, DemoSyncFile);

        if (sync_val != (*SyncFunc[i]) ())
            {
            TerminateLevel();
            TerminateGame();
            printf("Demo out of sync - Sync Byte Number %d - Iteration %d.", i, cnt);
            exit(0);
            }
        }
    }



/*
getsyncbyte()
    {
    int i, j;
    char ch;
    SPRITEp spr;
    PLAYERp pp;
    USERp u;

    ch = (char) (randomseed & 255);

    for (i = connecthead; i >= 0; i = connectpoint2[i])
        {
        pp = Player + i;
        u = User[pp->SpriteP - sprite];
        ch ^= (pp->posx ^ pp->posy ^ pp->posz ^ pp->pang ^ pp->horiz ^ u->Health);
        }

    for (j = headspritestat[STAT_ENEMY]; j >= 0; j = nextspritestat[j])
        {
        spr = &sprite[j];
        ch ^= spr->x ^ spr->y ^ spr->z ^ spr->ang;
        }

    return (ch);
    }
*/
#endif



extern unsigned int MoveThingsCount;

////////////////////////////////////////////////////////////////////////
//
// Test-only hooks (see net.h). Used by the network tests, never by players.
//
////////////////////////////////////////////////////////////////////////

int TestQuitTics = 0;
int TestQuitReached = 0;
int TestNudgeTic = -1;

void TestSyncArg(void)
    {
    NumSyncBytes = 8;
    }

void TestQuitArg(int tics)
    {
    TestQuitTics = tics;
    }

void TestNudgeArg(int tic)
    {
    TestNudgeTic = tic;
    }

// Added to the game version that is exchanged and compared at the start of a
// level: players started with a different sync byte count or quit tic then
// print "CheckVersion(): player N has version ...". That is only a log line
// (the game goes on, and with different sync byte counts the packets are
// misread): the tests fail on it. -demosync* in a network game also sets
// NumSyncBytes = 8 and so also changes the version that is sent.
int TestVersionSalt(void)
    {
    return (NumSyncBytes - 1) * 1000003 + TestQuitTics * 37;
    }

// -testdump<name>: every machine writes its own record of every game tic to <name>, so that a test
// can compare all machines byte for byte (the game's own sync check compares on the master only, and
// only the low byte of each coordinate: code-facts section 8). One record of 17 bytes per tic:
//   game tic (MoveThingsCount, little endian, 4 bytes), the nine sync bytes (the same functions
//   getsyncstat() uses, computed here whatever NumSyncBytes is), and a 32 bit FNV-1a hash of the
//   whole simulation state that matters (random seed, every player's full position, angle, horizon,
//   health and bcnt, every sprite's full x, y, z, angle (not for the markers whose angle the drawing
//   code uses as scratch space: TestStateHash), picnum, statnum and sector, every sector's floor and
//   ceiling height and stat bits, the sector objects). Nothing goes on the wire and nothing in the game
//   changes; the file is flushed after every record so that a test can watch its growth (tics a
//   second) while the game runs. Without the argument none of this runs.
static char TestDumpName[260];
static FILE *TestDumpFile;
static int TestDumpFailed;

void TestDumpArg(const char *name)
    {
    strncpy(TestDumpName, name, sizeof(TestDumpName) - 1);
    TestDumpName[sizeof(TestDumpName) - 1] = 0;
    }

#define FNV_STEP(h, v) ((h) = ((h) ^ ((unsigned int)(v) & 255)) * 16777619u)
static void fnv_int(unsigned int *h, int v)
    {
    FNV_STEP(*h, v); FNV_STEP(*h, v >> 8); FNV_STEP(*h, v >> 16); FNV_STEP(*h, v >> 24);
    }

static unsigned int TestStateHash(void)
    {
    unsigned int h = 2166136261u;
    int i;
    PLAYERp pp;
    SECTOR_OBJECTp sop;

    fnv_int(&h, randomseed);
    TRAVERSE_CONNECT(i)
        {
        pp = Player + i;
        fnv_int(&h, pp->posx); fnv_int(&h, pp->posy); fnv_int(&h, pp->posz);
        fnv_int(&h, pp->pang); fnv_int(&h, pp->horiz); fnv_int(&h, pp->bcnt);
        fnv_int(&h, User[pp->PlayerSprite] ? User[pp->PlayerSprite]->Health : 0);
        }
    for (i = 0; i < MAXSPRITES; i++)
        {
        if (sprite[i].statnum >= MAXSTATUS)
            continue;
        fnv_int(&h, i);
        fnv_int(&h, sprite[i].x); fnv_int(&h, sprite[i].y); fnv_int(&h, sprite[i].z);
        // Not the angle of a ceiling/floor picture override marker (brief 04b): the drawing code,
        // FAF_DrawRooms() in draw.c, uses that sprite's ang (SPRITE_TAG4) and xvel (SPRITE_TAG5) as
        // scratch space to save the sector's ceiling or floor stat and picnum while it draws, so they
        // hold what the last frame drawn left there: the stat with the parallax bit after one frame,
        // without it after more (the restore clears it). How many frames a machine drew before a tic
        // differs from machine to machine, so the angle did too (the tic 1 difference of brief 04b).
        // Nothing but FAF_DrawRooms() reads these two fields of these sprites (they have no User,
        // and no blocking or hitscan bit in cstat); their other fields here are still hashed.
        if (sprite[i].statnum != STAT_CEILING_FLOOR_PIC_OVERRIDE)
            fnv_int(&h, sprite[i].ang);
        fnv_int(&h, sprite[i].picnum);
        fnv_int(&h, sprite[i].statnum); fnv_int(&h, sprite[i].sectnum);
        }
    for (i = 0; i < numsectors; i++)
        {
        fnv_int(&h, sector[i].floorz); fnv_int(&h, sector[i].ceilingz);
        // and the stat bits (brief 04b), which the game reads (a parallax ceiling or floor is sky to a
        // shot, player.c and weapon.c). The first frame drawn leaves the parallax bit cleared on the
        // sectors of the override markers above (FAF_DrawRooms() restores the stat without it), the
        // same on every machine that has drawn; one that never drew before a tic would differ here.
        fnv_int(&h, sector[i].ceilingstat); fnv_int(&h, sector[i].floorstat);
        }
    for (sop = SectorObject; sop < &SectorObject[MAX_SECTOR_OBJECTS]; sop++)
        {
        fnv_int(&h, sop->xmid); fnv_int(&h, sop->ymid); fnv_int(&h, sop->zmid);
        fnv_int(&h, sop->ang);
        }
    return h;
    }

// -teststate[<T>] (test-only, brief 04b; with -testdump<name>): this machine also writes <name>.state,
// a field by field text dump of the simulation state, for finding which field two machines disagree
// about. One line per object, "<when> <kind> <index> field=value ...", so that a plain diff of two
// machines' files names the object and a field comparison names the field. It is written when
// RunLevel starts (when=start, after InitRunLevel, before the first input), at the start of game tics
// 1 to 3 (the same moment as the -testdump record of that tic: before the tic is moved), and at the
// start of every tic T given (-teststate600 -teststate1200: up to 16; -teststate or -teststate0
// alone gives only the first ones). Fields ending in '@' hold code or data addresses (as offsets from
// a fixed symbol) and are equal only between machines running the same build. krandcount, numframes
// and movefifoend are this machine's own (not simulation state), as are the angle and xvel of the
// ceiling/floor picture override markers (TestStateHash). It is opt-in because it is slow: writing
// the first dump (about 1.3 MB for E1L1) delays a browser's first frame noticeably, and that alone
// changes the start of a game (it made the tic 1 case of brief 04b happen in most games).
#include "interp.h"
static int TestStateOn;
static int TestStateTics[16];
static int TestStateNum;
static FILE *TestStateFile;
static int TestStateFailed;

void TestStateArg(int tic)
    {
    TestStateOn = 1;
    if (tic > 0 && TestStateNum < (int)(sizeof(TestStateTics) / sizeof(TestStateTics[0])))
        TestStateTics[TestStateNum++] = tic;
    }

static const char *TestPtr(const void *p, char *buf)
    {
    const char *c = (const char *)p;
    if (!p)
        return "null";
    if (c >= (const char *)sprite && c < (const char *)&sprite[MAXSPRITES])
        sprintf(buf, "spr%d+%d", (int)((c - (const char *)sprite) / sizeof(SPRITE)), (int)((c - (const char *)sprite) % sizeof(SPRITE)));
    else if (c >= (const char *)sector && c < (const char *)&sector[MAXSECTORS])
        sprintf(buf, "sec%d+%d", (int)((c - (const char *)sector) / sizeof(SECTOR)), (int)((c - (const char *)sector) % sizeof(SECTOR)));
    else if (c >= (const char *)wall && c < (const char *)&wall[MAXWALLS])
        sprintf(buf, "wall%d+%d", (int)((c - (const char *)wall) / sizeof(WALL)), (int)((c - (const char *)wall) % sizeof(WALL)));
    else if (c >= (const char *)SectorObject && c < (const char *)&SectorObject[MAX_SECTOR_OBJECTS])
        sprintf(buf, "so%d+%d", (int)((c - (const char *)SectorObject) / sizeof(SECTOR_OBJECT)), (int)((c - (const char *)SectorObject) % sizeof(SECTOR_OBJECT)));
    else if (c >= (const char *)Player && c < (const char *)&Player[MAX_SW_PLAYERS_REG + 1])
        sprintf(buf, "player%d+%d", (int)((c - (const char *)Player) / sizeof(PLAYER)), (int)((c - (const char *)Player) % sizeof(PLAYER)));
    else
        sprintf(buf, "%lld@", (long long)(c - (const char *)&randomseed));
    return buf;
    }

static long long TestCode(const void *fn)
    {
    return fn ? (long long)((const char *)fn - (const char *)TestPtr) : 0;
    }

static void TestStateFull(const char *when)
    {
    extern int krandcount, PlayClock;
    extern int totalsynctics;
    extern short AnimCnt;
    extern ANIM Anim[];
    FILE *f;
    char b1[48], b2[48], b3[48], b4[48], b5[48], b6[48];
    int i, j, k;
    PLAYERp pp;
    USERp u;
    SECTOR_OBJECTp sop;

    if (!TestStateOn || !TestDumpName[0] || TestStateFailed)
        return;
    if (!TestStateFile)
        {
        char name[280];
        snprintf(name, sizeof(name), "%s.state", TestDumpName);
        TestStateFile = fopen(name, "w");
        if (!TestStateFile)
            {
            TestStateFailed = 1;
            buildprintf("TEST: cannot write the state dump %s\n", name);
            return;
            }
        }
    f = TestStateFile;
    fprintf(f, "%s global randomseed=%d krandcount=%d numframes=%d MoveThingsCount=%u movefifoplc=%d PlayClock=%d totalsynctics=%d MoveSkip2=%d MoveSkip4=%d MoveSkip8=%d numsectors=%d numwalls=%d AnimCnt=%d numinterp=%d sinterp=%d connecthead=%d myconnectindex=%d numplayers=%d\n",
        when, randomseed, krandcount, numframes, MoveThingsCount, movefifoplc, PlayClock, totalsynctics, MoveSkip2, MoveSkip4, MoveSkip8, numsectors, numwalls, AnimCnt, numinterpolations, short_numinterpolations, connecthead, myconnectindex, numplayers);
    TRAVERSE_CONNECT(i)
        {
        pp = Player + i;
        fprintf(f, "%s player %d posx=%d posy=%d posz=%d oposx=%d oposy=%d oposz=%d oang=%d ohoriz=%d lv_sectnum=%d lv_x=%d lv_y=%d lv_z=%d jump_count=%d jump_speed=%d down_speed=%d up_speed=%d z_speed=%d oz_speed=%d climb_ndx=%d hiz=%d loz=%d ceiling_dist=%d floor_dist=%d hi_sectp=%s lo_sectp=%s hi_sp=%s lo_sp=%s xvect=%d yvect=%d oxvect=%d oyvect=%d friction=%d slide_xvect=%d slide_yvect=%d slide_ang=%d slide_dec=%d drive_angvel=%d drive_oangvel=%d pang=%d cursectnum=%d lastcursectnum=%d turn180_target=%d horizbase=%d horiz=%d horizoff=%d hvel=%d tilt=%d tilt_dest=%d recoil_amt=%d recoil_speed=%d recoil_ndx=%d recoil_horizoff=%d oldposx=%d oldposy=%d oldposz=%d RevolveX=%d RevolveY=%d RevolveDeltaAng=%d RevolveAng=%d PlayerSprite=%d PlayerUnderSprite=%d pnum=%d LadderSector=%d LadderAngle=%d lx=%d ly=%d JumpDuration=%d WadeDepth=%d bob_amt=%d bob_ndx=%d bcnt=%d bob_z=%d movefifoend=%d Flags=%x Flags2=%x KeyPressFlags=%x DoPlayerAction=%lld@ sop_control=%s sop_riding=%s sop_remote=%s sop=%s WpnFlags=%x WpnNum=%d WpnAmmo0=%d WpnAmmo1=%d WpnAmmo2=%d Armor=%d MaxHealth=%d InventoryNum=%d DiveTics=%d Kills=%d FadeTics=%d FadeAmt=%d NightVision=%d Heads=%d HitBy=%d Reverb=%d IsDisconnected=%d input=%d,%d,%d,%d,%x\n",
            when, i, pp->posx, pp->posy, pp->posz, pp->oposx, pp->oposy, pp->oposz, pp->oang, pp->ohoriz, pp->lv_sectnum, pp->lv_x, pp->lv_y, pp->lv_z,
            pp->jump_count, pp->jump_speed, pp->down_speed, pp->up_speed, pp->z_speed, pp->oz_speed, pp->climb_ndx, pp->hiz, pp->loz, pp->ceiling_dist, pp->floor_dist,
            TestPtr(pp->hi_sectp, b1), TestPtr(pp->lo_sectp, b2), TestPtr(pp->hi_sp, b3), TestPtr(pp->lo_sp, b4),
            pp->xvect, pp->yvect, pp->oxvect, pp->oyvect, pp->friction, pp->slide_xvect, pp->slide_yvect, pp->slide_ang, pp->slide_dec, pp->drive_angvel, pp->drive_oangvel,
            pp->pang, pp->cursectnum, pp->lastcursectnum, pp->turn180_target, pp->horizbase, pp->horiz, pp->horizoff, pp->hvel, pp->tilt, pp->tilt_dest,
            pp->recoil_amt, pp->recoil_speed, pp->recoil_ndx, pp->recoil_horizoff, pp->oldposx, pp->oldposy, pp->oldposz, pp->RevolveX, pp->RevolveY, pp->RevolveDeltaAng, pp->RevolveAng,
            pp->PlayerSprite, pp->PlayerUnderSprite, pp->pnum, pp->LadderSector, pp->LadderAngle, pp->lx, pp->ly, pp->JumpDuration, pp->WadeDepth, pp->bob_amt, pp->bob_ndx, pp->bcnt, pp->bob_z,
            pp->movefifoend, pp->Flags, pp->Flags2, pp->KeyPressFlags, TestCode((const void *)pp->DoPlayerAction),
            TestPtr(pp->sop_control, b5), TestPtr(pp->sop_riding, b6), TestPtr(pp->sop_remote, b1), TestPtr(pp->sop, b2),
            pp->WpnFlags, pp->WpnNum, pp->WpnAmmo[0], pp->WpnAmmo[1], pp->WpnAmmo[2], pp->Armor, pp->MaxHealth, pp->InventoryNum, pp->DiveTics, pp->Kills, pp->FadeTics, pp->FadeAmt,
            pp->NightVision, pp->Heads, pp->HitBy, pp->Reverb, pp->IsDisconnected,
            pp->input.vel, pp->input.svel, pp->input.angvel, pp->input.aimvel, (unsigned)pp->input.bits);
        }
    for (i = 0; i < MAXSPRITES; i++)
        {
        SPRITEp sp = &sprite[i];
        if (sp->statnum >= MAXSTATUS)
            continue;
        fprintf(f, "%s spr %d x=%d y=%d z=%d cstat=%x picnum=%d shade=%d pal=%d clipdist=%d xrepeat=%d yrepeat=%d xoffset=%d yoffset=%d sectnum=%d statnum=%d ang=%d owner=%d xvel=%d yvel=%d zvel=%d lotag=%d hitag=%d extra=%d%s\n",
            when, i, sp->x, sp->y, sp->z, (unsigned short)sp->cstat, sp->picnum, sp->shade, sp->pal, sp->clipdist, sp->xrepeat, sp->yrepeat, sp->xoffset, sp->yoffset,
            sp->sectnum, sp->statnum, sp->ang, sp->owner, sp->xvel, sp->yvel, sp->zvel, sp->lotag, sp->hitag, sp->extra,
            // the drawing code's scratch fields on these markers (TestStateHash): this machine's own
            sp->statnum == STAT_CEILING_FLOOR_PIC_OVERRIDE ? " drawscratch=ang,xvel" : "");
        u = User[i];
        if (!u)
            continue;
        fprintf(f, "%s user %d State=%s Rot=%s StateStart=%s StateEnd=%s ActorActionFunc=%lld@ ActorActionSet=%s Personality=%s Attrib=%s sop_parent=%s ox=%d oy=%d oz=%d Flags=%x Flags2=%x Tics=%d RotNum=%d ID=%d Health=%d MaxHealth=%d LastDamage=%d PainThreshold=%d jump_speed=%d jump_grav=%d ceiling_dist=%d floor_dist=%d lo_step=%d hiz=%d loz=%d zclip=%d active_range=%d SpriteNum=%d Attach=%d SpriteP=%s PlayerP=%s Sibling=%d xchange=%d ychange=%d zchange=%d z_tgt=%d vel_tgt=%d vel_rate=%d speed=%d Counter=%d Counter2=%d Counter3=%d DamageTics=%d BladeDamageTics=%d WpnGoal=%d Radius=%u OverlapZ=%d flame=%d tgt_sp=%s scale_speed=%d scale_value=%d scale_tgt=%d DistCheck=%d Dist=%d TargetDist=%d WaitTics=%d track=%d point=%d track_dir=%d track_vel=%d slide_ang=%d slide_vel=%d slide_dec=%d wait_active_check=%d inactive_time=%d sx=%d sy=%d sz=%d sang=%d spal=%d ret=%d Flag1=%d LastWeaponNum=%d WeaponNum=%d bounce=%d ShellNum=%d FlagOwner=%d Vis=%d DidAlert=%d\n",
            when, i, TestPtr(u->State, b1), TestPtr(u->Rot, b2), TestPtr(u->StateStart, b3), TestPtr(u->StateEnd, b4),
            TestCode((const void *)u->ActorActionFunc), TestPtr(u->ActorActionSet, b5), TestPtr(u->Personality, b6), "-", "-",
            u->ox, u->oy, u->oz, u->Flags, u->Flags2, u->Tics, u->RotNum, u->ID, u->Health, u->MaxHealth, u->LastDamage, u->PainThreshold, u->jump_speed, u->jump_grav,
            u->ceiling_dist, u->floor_dist, u->lo_step, u->hiz, u->loz, u->zclip, u->active_range, u->SpriteNum, u->Attach, "-", "-", u->Sibling,
            u->xchange, u->ychange, u->zchange, u->z_tgt, u->vel_tgt, u->vel_rate, u->speed, u->Counter, u->Counter2, u->Counter3, u->DamageTics, u->BladeDamageTics,
            u->WpnGoal, u->Radius, u->OverlapZ, u->flame, "-", u->scale_speed, u->scale_value, u->scale_tgt, u->DistCheck, u->Dist, u->TargetDist, u->WaitTics,
            u->track, u->point, u->track_dir, u->track_vel, u->slide_ang, u->slide_vel, u->slide_dec, u->wait_active_check, u->inactive_time, u->sx, u->sy, u->sz, u->sang, u->spal,
            u->ret, u->Flag1, u->LastWeaponNum, u->WeaponNum, u->bounce, u->ShellNum, u->FlagOwner, u->Vis, u->DidAlert);
        fprintf(f, "%s userp %d Attrib=%s sop_parent=%s hi_sectp=%s lo_sectp=%s hi_sp=%s lo_sp=%s\n", when, i, TestPtr(u->Attrib, b1), TestPtr(u->sop_parent, b2),
            TestPtr(u->hi_sectp, b3), TestPtr(u->lo_sectp, b4), TestPtr(u->hi_sp, b5), TestPtr(u->lo_sp, b6));
        fprintf(f, "%s userq %d SpriteP=%s PlayerP=%s tgt_sp=%s WallP=%s WallCount=%d\n", when, i, TestPtr(u->SpriteP, b1), TestPtr(u->PlayerP, b2), TestPtr(u->tgt_sp, b3), TestPtr(u->WallP, b4), u->WallCount);
        }
    for (i = 0; i < MAXSTATUS; i++)
        {
        if (headspritestat[i] < 0)
            continue;
        fprintf(f, "%s statlist %d", when, i);
        for (j = headspritestat[i], k = 0; j >= 0 && k < MAXSPRITES; j = nextspritestat[j], k++)
            fprintf(f, " %d", j);
        fprintf(f, "\n");
        }
    fprintf(f, "%s freelist", when);
    for (j = headspritestat[MAXSTATUS], k = 0; j >= 0 && k < 64; j = nextspritestat[j], k++)
        fprintf(f, " %d", j);
    fprintf(f, "\n");
    for (i = 0; i < numsectors; i++)
        {
        SECTORp s = &sector[i];
        fprintf(f, "%s sec %d wallptr=%d wallnum=%d ceilingz=%d floorz=%d ceilingstat=%x floorstat=%x ceilingpicnum=%d ceilingheinum=%d ceilingshade=%d ceilingpal=%d ceilingxpanning=%d ceilingypanning=%d floorpicnum=%d floorheinum=%d floorshade=%d floorpal=%d floorxpanning=%d floorypanning=%d visibility=%d lotag=%d hitag=%d extra=%d sprites=",
            when, i, s->wallptr, s->wallnum, s->ceilingz, s->floorz, (unsigned short)s->ceilingstat, (unsigned short)s->floorstat, s->ceilingpicnum, s->ceilingheinum, s->ceilingshade, s->ceilingpal,
            s->ceilingxpanning, s->ceilingypanning, s->floorpicnum, s->floorheinum, s->floorshade, s->floorpal, s->floorxpanning, s->floorypanning, s->visibility, s->lotag, s->hitag, s->extra);
        for (j = headspritesect[i], k = 0; j >= 0 && k < MAXSPRITES; j = nextspritesect[j], k++)
            fprintf(f, "%s%d", k ? "," : "", j);
        if (SectUser[i])
            fprintf(f, " su=%d,%d,%d,%d,%d,%d,%d,%d,%d,%d", SectUser[i]->dist, SectUser[i]->flags, SectUser[i]->depth_fixed, SectUser[i]->stag, SectUser[i]->ang,
                SectUser[i]->height, SectUser[i]->speed, SectUser[i]->damage, SectUser[i]->number, SectUser[i]->flags2);
        fprintf(f, "\n");
        }
    for (i = 0; i < numwalls; i++)
        {
        WALLp w = &wall[i];
        fprintf(f, "%s wall %d x=%d y=%d point2=%d nextwall=%d nextsector=%d cstat=%x picnum=%d overpicnum=%d shade=%d pal=%d xrepeat=%d yrepeat=%d xpanning=%d ypanning=%d lotag=%d hitag=%d extra=%d\n",
            when, i, w->x, w->y, w->point2, w->nextwall, w->nextsector, (unsigned short)w->cstat, w->picnum, w->overpicnum, w->shade, w->pal, w->xrepeat, w->yrepeat,
            w->xpanning, w->ypanning, w->lotag, w->hitag, w->extra);
        }
    for (sop = SectorObject, i = 0; sop < &SectorObject[MAX_SECTOR_OBJECTS]; sop++, i++)
        {
        fprintf(f, "%s so %d xmid=%d ymid=%d zmid=%d vel=%d vel_tgt=%d zdelta=%d z_tgt=%d z_rate=%d bob_diff=%d target_dist=%d floor_loz=%d floor_hiz=%d flags=%x sectnum=%d mid_sector=%d num_sectors=%d num_walls=%d track=%d point=%d dir=%d ang=%d ang_moving=%d ang_tgt=%d ang_orig=%d last_ang=%d old_ang=%d spin_speed=%d spin_ang=%d bob_sine_ndx=%d wait_tics=%d controller=%s sp_child=%s\n",
            when, i, sop->xmid, sop->ymid, sop->zmid, sop->vel, sop->vel_tgt, sop->zdelta, sop->z_tgt, sop->z_rate, sop->bob_diff, sop->target_dist, sop->floor_loz, sop->floor_hiz, sop->flags,
            sop->sectnum, sop->mid_sector, sop->num_sectors, sop->num_walls, sop->track, sop->point, sop->dir, sop->ang, sop->ang_moving, sop->ang_tgt, sop->ang_orig, sop->last_ang, sop->old_ang,
            sop->spin_speed, sop->spin_ang, sop->bob_sine_ndx, sop->wait_tics, TestPtr(sop->controller, b1), TestPtr(sop->sp_child, b2));
        }
    for (i = 0; i < AnimCnt; i++)
        fprintf(f, "%s anim %d ptr=%s goal=%d vel=%d vel_adj=%d\n", when, i, TestPtr(Anim[i].ptr, b1), Anim[i].goal, Anim[i].vel, Anim[i].vel_adj);
    for (i = 0; i < numinterpolations; i++)
        fprintf(f, "%s interp %d ptr=%s old=%d\n", when, i, TestPtr(curipos[i], b1), oldipos[i]);
    for (i = 0; i < short_numinterpolations; i++)
        fprintf(f, "%s sinterp %d ptr=%s old=%d\n", when, i, TestPtr(short_curipos[i], b1), short_oldipos[i]);
    fprintf(f, "%s hash %08x\n", when, TestStateHash());
    fflush(f);
    }

// Called when RunLevel starts (game.c), after InitRunLevel: the state before the first input.
void TestStateStart(void)
    {
    TestStateFull("start");
    }

// -testslowstart<ms> (test-only, brief 04b): this machine waits <ms> milliseconds when RunLevel
// starts, before its first frame, with its clock running. Its first frame then makes every input
// that has fallen due, the others' inputs are already here, and it runs tic 1 straight after that
// single frame, while the other machines have drawn many: the uneven start of the tic 1 case,
// made certain (the tic1 scenario; on the master: a slave's tic 1 needs a round trip after its first
// frame). It changes nothing but when this machine starts.
static int TestSlowStartMs;

void TestSlowStartArg(int ms)
    {
    TestSlowStartMs = ms;
    }

void TestSlowStart(void)
    {
#ifndef __EMSCRIPTEN__
    unsigned int t0;
#endif

    if (TestSlowStartMs <= 0)
        return;
    buildprintf("TEST: waiting %d ms before the first frame\n", TestSlowStartMs);
    // what waitforeverybody() last queued may still be held by mmulti's send window; let it out
    // first, or the others would wait in theirs until this machine polls again after the wait
    mmulti_vnet_flush();
#ifdef __EMSCRIPTEN__
    // in the browser by yielding (ASYNCIFY): a busy wait would also stop other pages that share
    // the renderer process, the other players of a test among them
    emscripten_sleep(TestSlowStartMs);
#else
    t0 = getticks();
    while ((int)(getticks() - t0) < TestSlowStartMs)
        ;
#endif
    }

static void TestStateTic(void)
    {
    int i;
    char when[32];

    if (!TestStateOn || !TestDumpName[0])
        return;
    for (i = 0; i < TestStateNum; i++)
        if (TestStateTics[i] == (int)MoveThingsCount)
            break;
    if (MoveThingsCount > 3 && i == TestStateNum)
        return;
    sprintf(when, "t%u", MoveThingsCount);
    TestStateFull(when);
    }

static void TestDumpTic(void)
    {
    extern unsigned int MoveThingsCount;
    unsigned char rec[17];
    unsigned int t = MoveThingsCount, h;
    int i;

    if (!TestDumpName[0] || TestDumpFailed)
        return;
    if (!TestDumpFile)
        {
        TestDumpFile = fopen(TestDumpName, "wb");
        if (!TestDumpFile)
            {
            TestDumpFailed = 1;
            buildprintf("TEST: cannot write the sync dump %s\n", TestDumpName);
            return;
            }
        buildprintf("TEST: writing the sync dump %s (17 bytes a tic)\n", TestDumpName);
        }
    TestStateTic();
    rec[0] = t & 255; rec[1] = (t >> 8) & 255; rec[2] = (t >> 16) & 255; rec[3] = (t >> 24) & 255;
    for (i = 0; SyncFunc[i]; i++)
        rec[4 + i] = (*SyncFunc[i])();
    h = TestStateHash();
    rec[13] = h & 255; rec[14] = (h >> 8) & 255; rec[15] = (h >> 16) & 255; rec[16] = (h >> 24) & 255;
    fwrite(rec, 1, sizeof(rec), TestDumpFile);
    fflush(TestDumpFile);
    }


// -testlag<name>: input-to-tic timing (brief 04b). This machine writes 36 bytes (nine little endian
// 32 bit fields) for every game tic to the file <name>, all from this machine's own clock
// (CLOCK_MONOTONIC, microseconds since the first record). For the tic that domovethings() ran, with
// n the input fifo index it consumed:
//   0 tic             MoveThingsCount, as in -testdump
//   1 made            when this machine's own input n was made (faketimerhandler, after getinput)
//   2 ready           when every player's input n was on this machine (the last of the others'
//                     arrivals as getpackets() stored them, and the own input)
//   3 ran             when the tic was run (the record is written at the start of the tic)
//   4 sendwait        how long the packet that carried this tic's data for the next machine waited
//                     between sendpacket() and a datagram leaving: a slave's own input, or the
//                     master's combined packet (the longest over its slaves); 0xFFFFFFFF if unknown
//   5 fwdwait         the master only: from "ready" to the combined packet being handed to sendpacket();
//                     0xFFFFFFFF on a slave
//   6 otherminlag     (signed) the lag correction's view
//   7 bufferjitter    (signed)
//   8 clockcorr       (signed) the sum of every totalclock correction so far, in clock ticks
// and at -testquit the log says how many datagrams went to each peer. Input to tic is ran - made;
// ran - ready is the time a complete tic waits for the lockstep buffer. A tic's record is written 16
// tics after it ran (the last 16 at -testquit), when its packets have left. Nothing goes on the wire
// and nothing in the game changes; without the argument none of this runs.
int TestLagOn;
static char TestLagName[260];
static FILE *TestLagFile;
static unsigned long long TestLagBase;
static unsigned int TestLagMadeT[MOVEFIFOSIZ], TestLagSendWait[MOVEFIFOSIZ], TestLagFwdWait[MOVEFIFOSIZ];
static unsigned int TestLagArrive[MAX_SW_PLAYERS_REG][MOVEFIFOSIZ];
static int TestLagSeen[MAX_SW_PLAYERS_REG];
static int TestLagCurIdx = -1;
static int TestLagClockCorr;
// per peer output queue (mmulti's ocnt): when queued, which fifo index it belongs to, how far datagrams have carried it
#define TESTLAG_Q 512
static unsigned int TestLagQT[16][TESTLAG_Q];
static int TestLagQIdx[16][TESTLAG_Q];
static int TestLagQHW[16];
static unsigned int TestLagDgrams[16], TestLagDBytes[16], TestLagDFirst[16], TestLagDLast[16];
// what kind of datagram (brief 04b review N2): one that carries a new input or combined packet (sent
// by sendpacket() itself or by the flush after it, SendInputNow), or one paced by mmulti's window
// with only acknowledgements and resends (from getpacket()); and how many of the paced ones went in
// the same getpackets() pass as a new-data one that came after them (that one carries the same
// acknowledgements and every unacknowledged packet, so the paced one was redundant)
static unsigned int TestLagDFlushed[16], TestLagDPaced[16], TestLagDRedundant[16];
static int TestLagInFlush, TestLagPass, TestLagPacedPass[16];

#ifdef _WIN32
// kernel32's high resolution counter, declared as windows.h declares it (BOOL WINAPI, LARGE_INTEGER *)
// so that this file need not include windows.h. MSVC has no clock_gettime.
__declspec(dllimport) int __stdcall QueryPerformanceCounter(union _LARGE_INTEGER *);
__declspec(dllimport) int __stdcall QueryPerformanceFrequency(union _LARGE_INTEGER *);
#endif

static unsigned int TestLagNow(void)
    {
    unsigned long long t;
#ifdef _WIN32
    long long c = 0, fr = 0;
    QueryPerformanceCounter((union _LARGE_INTEGER *)&c);
    QueryPerformanceFrequency((union _LARGE_INTEGER *)&fr);
    t = fr > 0 ? (unsigned long long)(c / fr) * 1000000ull + (unsigned long long)(c % fr) * 1000000ull / (unsigned long long)fr : 0;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    t = (unsigned long long)ts.tv_sec * 1000000ull + ts.tv_nsec / 1000;
#endif
    if (!TestLagBase)
        TestLagBase = t;
    return (unsigned int)(t - TestLagBase);
    }

static void TestLagQueueHook(int other, int ocnt)
    {
    TestLagQT[other & 15][ocnt & (TESTLAG_Q - 1)] = TestLagNow();
    TestLagQIdx[other & 15][ocnt & (TESTLAG_Q - 1)] = TestLagCurIdx;
    }

static void TestLagSendHook(int other, int ocnt1, int nbytes)
    {
    unsigned int t = TestLagNow();
    int o = other & 15, i;

    if (!TestLagDgrams[o])
        TestLagDFirst[o] = t;
    TestLagDgrams[o]++;
    TestLagDBytes[o] += nbytes;
    TestLagDLast[o] = t;
    if (TestLagInFlush || TestLagCurIdx >= 0)       // carries a new input or combined packet
        {
        TestLagDFlushed[o]++;
        if (TestLagPacedPass[o] == TestLagPass)
            {
            TestLagDRedundant[o]++;
            TestLagPacedPass[o] = 0;
            }
        }
    else
        {
        TestLagDPaced[o]++;
        TestLagPacedPass[o] = TestLagPass;
        }
    for (i = TestLagQHW[o]; i < ocnt1; i++)
        {
        int idx = TestLagQIdx[o][i & (TESTLAG_Q - 1)];
        unsigned int w = t - TestLagQT[o][i & (TESTLAG_Q - 1)];
        if (idx >= 0 && (TestLagSendWait[idx & (MOVEFIFOSIZ - 1)] == 0xFFFFFFFFu || w > TestLagSendWait[idx & (MOVEFIFOSIZ - 1)]))
            TestLagSendWait[idx & (MOVEFIFOSIZ - 1)] = w;
        }
    if (ocnt1 > TestLagQHW[o])
        TestLagQHW[o] = ocnt1;
    }

// getpackets() begins (a new pass), and SendInputNow() flushes (on = 1) or has flushed (on = 0).
void TestLagPassStart(void)
    {
    TestLagPass++;
    }

void TestLagFlushing(int on)
    {
    TestLagInFlush = on;
    }

void TestLagArg(const char *name)
    {
    strncpy(TestLagName, name, sizeof(TestLagName) - 1);
    TestLagName[sizeof(TestLagName) - 1] = 0;
    TestLagOn = 1;
    mmulti_test_queuehook = TestLagQueueHook;
    mmulti_test_sendhook = TestLagSendHook;
    }

// This machine made its own input number idx (called just before movefifoend++).
void TestLagMade(int idx)
    {
    int k = idx & (MOVEFIFOSIZ - 1);
    TestLagMadeT[k] = TestLagNow();
    TestLagArrive[myconnectindex][k] = TestLagMadeT[k];
    TestLagSendWait[k] = 0xFFFFFFFFu;
    TestLagFwdWait[k] = 0xFFFFFFFFu;
    }

// Note for the next packet handed to mmulti which fifo index it carries (-1: none).
void TestLagTag(int idx)
    {
    TestLagCurIdx = idx;
    }

// Called after getpackets() stored a packet: stamp every input that has arrived since.
void TestLagScan(void)
    {
    int p, i;
    unsigned int t = 0;

    for (p = connecthead; p >= 0; p = connectpoint2[p])
        {
        if (p == myconnectindex)
            continue;
        if (Player[p].movefifoend < TestLagSeen[p])
            TestLagSeen[p] = 0;     // a new level: the fifos started again
        for (i = TestLagSeen[p]; i < Player[p].movefifoend; i++)
            {
            if (!t)
                t = TestLagNow();
            TestLagArrive[p][i & (MOVEFIFOSIZ - 1)] = t;
            }
        if (Player[p].movefifoend > TestLagSeen[p])
            TestLagSeen[p] = Player[p].movefifoend;
        }
    }

// The master is about to hand the combined packet for fifo index idx to sendpacket(): how long since
// that tic was complete (the own input made and every slave's arrived).
void TestLagForward(int idx)
    {
    int p, k = idx & (MOVEFIFOSIZ - 1);
    unsigned int ready = 0, t = TestLagNow();

    for (p = connecthead; p >= 0; p = connectpoint2[p])
        if (TestLagArrive[p][k] > ready)
            ready = TestLagArrive[p][k];
    TestLagFwdWait[k] = t - ready;
    TestLagSendWait[k] = 0xFFFFFFFFu;
    }

void TestLagCorrect(int clockticks)
    {
    TestLagClockCorr += clockticks;
    }

// The record of a tic is written TESTLAG_DEFER tics after the tic ran: the datagram that carries
// it, and on the master the combined packet, may leave only after the tic has run on this machine
// (the master runs a tic as soon as every input is in; before brief 04b it forwarded it at its next
// own input, and mmulti sent it at the next 25 ms window), and the record would then have to say
// "unknown" for exactly the waits it is there to measure.
#define TESTLAG_DEFER 16
static unsigned int TestLagPend[MOVEFIFOSIZ][5];    // tic, ready, ran, otherminlag, bufferjitter; [8] below
static int TestLagPendCorr[MOVEFIFOSIZ];
static int TestLagPendOn[MOVEFIFOSIZ];

static void TestLagWrite(int k)
    {
    unsigned int rec[9];

    if (!TestLagPendOn[k])
        return;
    TestLagPendOn[k] = 0;
    rec[0] = TestLagPend[k][0];
    rec[1] = TestLagMadeT[k];
    rec[2] = TestLagPend[k][1];
    rec[3] = TestLagPend[k][2];
    rec[4] = TestLagSendWait[k];
    rec[5] = (myconnectindex == connecthead) ? TestLagFwdWait[k] : 0xFFFFFFFFu;
    rec[6] = TestLagPend[k][3];
    rec[7] = TestLagPend[k][4];
    rec[8] = (unsigned int)TestLagPendCorr[k];
    fwrite(rec, 1, sizeof(rec), TestLagFile);
    fflush(TestLagFile);
    }

static void TestLagTic(void)
    {
    extern unsigned int MoveThingsCount;
    extern int otherminlag, bufferjitter;
    unsigned int ready = 0;
    int p, k = (movefifoplc - 1) & (MOVEFIFOSIZ - 1);

    if (!TestLagOn)
        return;
    if (!TestLagFile)
        {
        TestLagFile = fopen(TestLagName, "wb");
        if (!TestLagFile)
            {
            TestLagOn = 0;
            buildprintf("TEST: cannot write the lag record %s\n", TestLagName);
            return;
            }
        buildprintf("TEST: writing the lag record %s (36 bytes a tic)\n", TestLagName);
        }
    for (p = connecthead; p >= 0; p = connectpoint2[p])
        if (TestLagArrive[p][k] > ready)
            ready = TestLagArrive[p][k];
    TestLagPend[k][0] = MoveThingsCount;
    TestLagPend[k][1] = ready;
    TestLagPend[k][2] = TestLagNow();
    TestLagPend[k][3] = (unsigned int)otherminlag;
    TestLagPend[k][4] = (unsigned int)bufferjitter;
    TestLagPendCorr[k] = TestLagClockCorr;
    TestLagPendOn[k] = 1;
    TestLagWrite((movefifoplc - 1 - TESTLAG_DEFER) & (MOVEFIFOSIZ - 1));
    }

void TestLagReport(void)
    {
    int p, i;

    if (!TestLagOn)
        return;
    if (TestLagFile)        // the last tics, with what is known of them now
        for (i = TESTLAG_DEFER - 1; i >= 0; i--)
            TestLagWrite((movefifoplc - 1 - i) & (MOVEFIFOSIZ - 1));
    for (p = connecthead; p >= 0; p = connectpoint2[p])
        if (p != myconnectindex && TestLagDgrams[p & 15])
            buildprintf("TEST: lag: %u datagrams (%u bytes) to player %d in %u ms: %u with new data, %u paced (acks and resends only), %u of those just before one with new data in the same receive pass\n",
                TestLagDgrams[p & 15], TestLagDBytes[p & 15], p, (TestLagDLast[p & 15] - TestLagDFirst[p & 15]) / 1000,
                TestLagDFlushed[p & 15], TestLagDPaced[p & 15], TestLagDRedundant[p & 15]);
    }

void TestTicHook(void)
    {
    extern unsigned int MoveThingsCount;

    TestDumpTic();
    TestLagTic();

    if (TestNudgeTic >= 0 && (int)MoveThingsCount == TestNudgeTic)
        {
        buildprintf("TEST: nudging player %d at tic %d\n", myconnectindex, TestNudgeTic);
        Player[myconnectindex].posx += 8;
        }

    if (TestQuitTics > 0 && (int)MoveThingsCount >= TestQuitTics)
        TestQuitReached = 1;
    }

void TestQuitFinish(void)
    {
    unsigned int until;

    TestLagReport();

    buildprintf("TEST: quitting after %u game tics: %d sync checks, %d mismatches, %d sync bytes, player %d of %d\n",
        MoveThingsCount, SyncChecks, SyncMismatches, (int)NumSyncBytes, myconnectindex, CommPlayers);

    // a player that is a few tics behind still needs what we send: keep
    // acknowledging and resending for a moment before leaving
    until = getticks() + 1500;
    while (getticks() < until)
        {
        handleevents();
        flushpackets();
        }
    }
