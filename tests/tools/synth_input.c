// LD_PRELOAD shim that plays a scripted "player" into a native SDL2 program, so that
// a demo can be recorded (-dr) without a display or a person. It wraps SDL_PollEvent:
// after the real queue is empty it hands out keyboard events from a fixed,
// pseudo-random schedule (same schedule every run), and SDL_QUIT at the end.
//
//   cc -shared -fPIC -O2 -o synth_input.so synth_input.c -ldl
//   LD_PRELOAD=$PWD/synth_input.so SYNTH_SECONDS=150 SDL_VIDEODRIVER=dummy ./sw -level1 -drdemo1
//
// SYNTH_SECONDS (default 150): when to quit, measured from the first poll.
// SYNTH_SEED (default 1):      the schedule.
// SYNTH_START_MS (default 4000): when the "player" starts pressing keys (level load).
// SYNTH_FORWARD (default 80):  percent of the segments that walk forward.
// SYNTH_FIRE (default 50):     percent of the segments that hold the fire key.
// SYNTH_SPIN (default 0):      1 = always turn left (sweeps the view, so auto-aim finds enemies).
// SYNTH_USE (default 1):       0 = never press the use key (it also restarts a dead player).
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <SDL.h>

typedef int (*pollfn)(SDL_Event *);

#define MAXEV 20000
static struct { Uint32 ms; SDL_Scancode sc; int down; } ev[MAXEV];
static int nev, next;
static Uint32 t0;
static int started, quit_sent;
static unsigned rng;

static unsigned rnd(void) { rng = rng * 1664525u + 1013904223u; return rng >> 8; }

static void add(Uint32 ms, SDL_Scancode sc, int down)
{
	if (nev < MAXEV) { ev[nev].ms = ms; ev[nev].sc = sc; ev[nev].down = down; nev++; }
}

static int cmp(const void *a, const void *b)
{
	const Uint32 x = *(const Uint32 *)a, y = *(const Uint32 *)b;
	return x < y ? -1 : x > y;
}

static void build(void)
{
	// Keys of the game's default layout.
	static const SDL_Scancode weapons[] = { SDL_SCANCODE_1, SDL_SCANCODE_2, SDL_SCANCODE_3, SDL_SCANCODE_4, SDL_SCANCODE_5 };
	const char *e;
	Uint32 t, end, start;
	int seed, forward, fire, use, spin;

	e = getenv("SYNTH_SECONDS"); end = (e ? atoi(e) : 150) * 1000;
	e = getenv("SYNTH_SEED"); seed = e ? atoi(e) : 1;
	e = getenv("SYNTH_FORWARD"); forward = e ? atoi(e) : 80;
	e = getenv("SYNTH_FIRE"); fire = e ? atoi(e) : 50;
	e = getenv("SYNTH_SPIN"); spin = e ? atoi(e) : 0;
	e = getenv("SYNTH_USE"); use = e ? atoi(e) : 1;
	e = getenv("SYNTH_START_MS"); start = e ? atoi(e) : 4000;
	rng = 12345u * seed + 1;

	// Pistol first.
	add(start, SDL_SCANCODE_2, 1); add(start + 100, SDL_SCANCODE_2, 0);
	for (t = start + 500; t + 2000 < end; ) {
		Uint32 dur = 300 + rnd() % 1300;
		SDL_Scancode held[8]; int nh = 0, i;

		if (rnd() % 100 < forward) held[nh++] = SDL_SCANCODE_UP;
		switch (spin ? 0 : rnd() % 4) {
			case 0: held[nh++] = SDL_SCANCODE_LEFT; break;
			case 1: held[nh++] = SDL_SCANCODE_RIGHT; break;
			default: break;
		}
		if (rnd() % 100 < fire) held[nh++] = SDL_SCANCODE_LCTRL;     // fire
		if (rnd() % 10 < 2) held[nh++] = SDL_SCANCODE_PERIOD;    // strafe
		if (rnd() % 10 < 2) held[nh++] = SDL_SCANCODE_LSHIFT;    // run
		for (i = 0; i < nh; i++) { add(t, held[i], 1); add(t + dur, held[i], 0); }
		if (use && rnd() % 10 < 2) { add(t + 100, SDL_SCANCODE_SPACE, 1); add(t + 250, SDL_SCANCODE_SPACE, 0); }   // use
		if (rnd() % 10 < 1) {
			SDL_Scancode w = weapons[1 + rnd() % 4];
			add(t + 50, w, 1); add(t + 150, w, 0);
		}
		t += dur + 80;
	}
	// Stable order by time (the arrays are small).
	{
		int i, j;
		for (i = 1; i < nev; i++) {
			__typeof__(ev[0]) x = ev[i];
			for (j = i - 1; j >= 0 && ev[j].ms > x.ms; j--) ev[j + 1] = ev[j];
			ev[j + 1] = x;
		}
	}
	(void)cmp;
	(void)end;
}

// SYNTH_SHOTS=DIR: save a BMP of the window every 2 seconds into DIR (to see what the "player" does).
int SDL_UpdateWindowSurface(SDL_Window *w)
{
	static int (*real)(SDL_Window *);
	static Uint32 last;
	const char *dir = getenv("SYNTH_SHOTS");
	if (!real) real = (int (*)(SDL_Window *))dlsym(RTLD_NEXT, "SDL_UpdateWindowSurface");
	if (dir && started && SDL_GetTicks() - t0 >= last + 2000) {
		char name[512];
		last = SDL_GetTicks() - t0;
		snprintf(name, sizeof(name), "%s/shot%05u.bmp", dir, last);
		SDL_SaveBMP(SDL_GetWindowSurface(w), name);
	}
	return real(w);
}

int SDL_PollEvent(SDL_Event *out)
{
	static pollfn real;
	Uint32 now;
	const char *e;
	Uint32 endms;

	if (!real) real = (pollfn)dlsym(RTLD_NEXT, "SDL_PollEvent");
	if (real(out)) return 1;

	if (!started) { started = 1; t0 = SDL_GetTicks(); build(); }
	now = SDL_GetTicks() - t0;

	if (next < nev && ev[next].ms <= now) {
		memset(out, 0, sizeof(*out));
		out->type = ev[next].down ? SDL_KEYDOWN : SDL_KEYUP;
		out->key.state = ev[next].down ? SDL_PRESSED : SDL_RELEASED;
		out->key.keysym.scancode = ev[next].sc;
		out->key.keysym.sym = SDL_GetKeyFromScancode(ev[next].sc);
		next++;
		return 1;
	}

	e = getenv("SYNTH_SECONDS"); endms = (e ? atoi(e) : 150) * 1000;
	if (!quit_sent && now >= endms) {
		quit_sent = 1;
		memset(out, 0, sizeof(*out));
		out->type = SDL_QUIT;
		return 1;
	}
	return 0;
}
