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
//   health and bcnt, every sprite's full x, y, z, angle, picnum, statnum and sector, every sector's
//   floor and ceiling height, the sector objects). Nothing goes on the wire and nothing in the game
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
        fnv_int(&h, sprite[i].ang); fnv_int(&h, sprite[i].picnum);
        fnv_int(&h, sprite[i].statnum); fnv_int(&h, sprite[i].sectnum);
        }
    for (i = 0; i < numsectors; i++)
        {
        fnv_int(&h, sector[i].floorz); fnv_int(&h, sector[i].ceilingz);
        }
    for (sop = SectorObject; sop < &SectorObject[MAX_SECTOR_OBJECTS]; sop++)
        {
        fnv_int(&h, sop->xmid); fnv_int(&h, sop->ymid); fnv_int(&h, sop->zmid);
        fnv_int(&h, sop->ang);
        }
    return h;
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
    rec[0] = t & 255; rec[1] = (t >> 8) & 255; rec[2] = (t >> 16) & 255; rec[3] = (t >> 24) & 255;
    for (i = 0; SyncFunc[i]; i++)
        rec[4 + i] = (*SyncFunc[i])();
    h = TestStateHash();
    rec[13] = h & 255; rec[14] = (h >> 8) & 255; rec[15] = (h >> 16) & 255; rec[16] = (h >> 24) & 255;
    fwrite(rec, 1, sizeof(rec), TestDumpFile);
    fflush(TestDumpFile);
    }

void TestTicHook(void)
    {
    extern unsigned int MoveThingsCount;

    TestDumpTic();

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
