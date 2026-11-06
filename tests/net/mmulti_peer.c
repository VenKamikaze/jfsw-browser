// SPDX-License-Identifier: GPL-2.0-or-later
//
// One player of the mmulti transport test (tests/net/test-mmulti-vnet.sh).
// It links mmulti.c (and, for the relay, mmulti_vnet.c and vnet) without the
// game and uses only the mmulti.h API, in master/slave mode:
//
//   mmulti_peer COUNT TIMEOUT_SECONDS MMULTI-ARGUMENTS...
//   e.g.  mmulti_peer 150 60 -relay 127.0.0.1:47000 -host-room 3
//         mmulti_peer 150 60 -relay 127.0.0.1:47000 -room ABC234
//         mmulti_peer 150 60 -nm:3 -p47010           (plain UDP, the master)
//         mmulti_peer 150 60 -nm -p47011 127.0.0.1:47010
//
// After the start-up wait, the master sends COUNT numbered packets to every
// slave and every slave sends COUNT to the master (slaves only talk to the
// master in this mode). Each packet carries its sender, a sequence number, a
// length and a pattern. A receiver checks that every packet comes from the
// player it says it is from, with exactly the next sequence number (so: once,
// in order, none missing), and intact. When a peer has received all of
// another's packets it sends a final DONE packet, and each side stays up
// answering and resending until all DONEs are in (and a little longer).
//
// Output, the last line: "RESULT ok index=I numplayers=N connecthead=H
// chain=0>1>2 sent=S received=R" or "RESULT FAIL reason". Exit 0 only for ok.
// It is the vnet impairment (VNET_IMPAIR=...) of the environment that makes
// the network lossy.

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/time.h>

#include "mmulti.h"
#ifdef HARNESS_VNET
#include "mmulti_vnet.h"
#endif

// What mmulti.c wants from the engine.
void buildprintf(const char *fmt, ...)
{
	va_list va;
	va_start(va, fmt);
	vprintf(fmt, va);
	va_end(va);
	fflush(stdout);
}

#define MAXPAYLOAD 60
#define KIND_DATA 0
#define KIND_DONE 1

static long msnow(void)
{
	struct timeval tv;
	gettimeofday(&tv, NULL);
	return tv.tv_sec * 1000L + tv.tv_usec / 1000;
}

static unsigned char patternbyte(int sender, unsigned seq, int i)
{
	return (unsigned char)(sender * 31 + seq * 7 + i * 13 + (seq >> 8));
}

static int failure(const char *fmt, ...)
{
	va_list va;
	printf("RESULT FAIL ");
	va_start(va, fmt);
	vprintf(fmt, va);
	va_end(va);
	printf("\n");
	fflush(stdout);
	return 1;
}

int main(int argc, char **argv)
{
	int count, timeout, i, npeers = 0, peers[MAXMULTIPLAYERS];
	unsigned nextsend[MAXMULTIPLAYERS], expect[MAXMULTIPLAYERS];
	int done_sent[MAXMULTIPLAYERS], done_got[MAXMULTIPLAYERS];
	long start, lastsend = 0, finished = 0;
	unsigned long sent = 0, received = 0;
	unsigned char buf[512];
	char chain[128];
	int n, other, ismaster;

	if (argc < 4) { fprintf(stderr, "usage: mmulti_peer COUNT TIMEOUT mmulti-args...\n"); return 2; }
	count = atoi(argv[1]);
	timeout = atoi(argv[2]);
	setvbuf(stdout, NULL, _IOLBF, 0);

#ifdef HARNESS_VNET
	mmulti_vnet_setplayercap(8);
#endif
	if (!initmultiplayersparms(argc - 3, (char const * const *)argv + 3))
		return failure("initmultiplayersparms failed");

	start = msnow();
	while (initmultiplayerscycle()) {
		if (msnow() - start > 30000) return failure("start-up wait timed out");
		usleep(2000);
	}
#ifdef HARNESS_VNET
	if (mmulti_vnet_state() == MMULTI_VNET_FAILED)
		return failure("relay: %s", mmulti_vnet_errormsg());
#endif

	chain[0] = 0;
	for (i = connecthead; i >= 0; i = connectpoint2[i]) {
		char t[16];
		snprintf(t, sizeof(t), "%s%d", chain[0] ? ">" : "", i);
		strcat(chain, t);
	}
	printf("READY index=%d numplayers=%d connecthead=%d chain=%s\n", myconnectindex, numplayers, connecthead, chain);

	ismaster = (myconnectindex == connecthead);
	if (ismaster) {
		for (i = connectpoint2[connecthead]; i >= 0; i = connectpoint2[i]) peers[npeers++] = i;
	} else {
		peers[npeers++] = connecthead;
	}
	memset(nextsend, 0, sizeof(nextsend));
	memset(expect, 0, sizeof(expect));
	memset(done_sent, 0, sizeof(done_sent));
	memset(done_got, 0, sizeof(done_got));

	start = msnow();
	for (;;) {
		long now = msnow();
		int alldone = 1;

		if (now - start > timeout * 1000L) return failure("test timed out (sent %lu, received %lu)", sent, received);

		// Send: one packet per peer every 40 ms.
		if (now - lastsend >= 40) {
			lastsend = now;
			for (i = 0; i < npeers; i++) {
				int p = peers[i];
				unsigned char pk[7 + MAXPAYLOAD];
				unsigned seq = nextsend[p];
				int len = 1 + (int)((seq * 13) % MAXPAYLOAD), j;

				if (seq < (unsigned)count) {
					pk[0] = (unsigned char)myconnectindex;
					memcpy(pk + 1, &seq, 4);
					pk[5] = KIND_DATA;
					pk[6] = (unsigned char)len;
					for (j = 0; j < len; j++) pk[7 + j] = patternbyte(myconnectindex, seq, j);
					sendpacket(p, pk, 7 + len);
					nextsend[p]++;
					sent++;
				} else if (!done_sent[p] && expect[p] >= (unsigned)count) {
					// all of theirs are in: tell them
					pk[0] = (unsigned char)myconnectindex;
					seq = (unsigned)count;
					memcpy(pk + 1, &seq, 4);
					pk[5] = KIND_DONE;
					pk[6] = 0;
					sendpacket(p, pk, 7);
					done_sent[p] = 1;
				}
			}
		}

		// Receive.
		while ((n = getpacket(&other, buf)) > 0) {
			unsigned seq;
			int j, len, from = -1;

			for (i = 0; i < npeers; i++) if (peers[i] == other) from = other;
			if (from < 0) return failure("packet from player %d, who is not a peer", other);
			if (n < 7) return failure("short packet (%d bytes) from player %d", n, other);
			memcpy(&seq, buf + 1, 4);
			if (buf[0] != other) return failure("packet from player %d says it is from %d", other, buf[0]);
			if (seq != expect[other]) return failure("from player %d: expected packet %u, got %u (lost, duplicated or out of order)", other, expect[other], seq);
			if (buf[5] == KIND_DONE) {
				if (seq != (unsigned)count) return failure("DONE from player %d after %u packets, not %d", other, seq, count);
				done_got[other] = 1;
				continue;
			}
			len = buf[6];
			if (len != 1 + (int)((seq * 13) % MAXPAYLOAD) || n != 7 + len)
				return failure("from player %d: packet %u has the wrong length (%d bytes, field %d)", other, seq, n, len);
			for (j = 0; j < len; j++)
				if (buf[7 + j] != patternbyte(other, seq, j))
					return failure("from player %d: packet %u is damaged at byte %d", other, seq, j);
			expect[other]++;
			received++;
		}

		for (i = 0; i < npeers; i++)
			if (!(nextsend[peers[i]] >= (unsigned)count && done_sent[peers[i]] && done_got[peers[i]])) alldone = 0;
		if (alldone) {
			if (!finished) finished = now;
			// stay up for a while: the other side may still need our acks and DONE
			if (now - finished > 2000) break;
		}
		usleep(1000);
	}

	for (i = 0; i < npeers; i++)
		if (expect[peers[i]] != (unsigned)count) return failure("received %u packets from player %d, expected %d", expect[peers[i]], peers[i], count);

	printf("RESULT ok index=%d numplayers=%d connecthead=%d chain=%s sent=%lu received=%lu\n",
		myconnectindex, numplayers, connecthead, chain, sent, received);
	uninitmultiplayers();
	return 0;
}
