#include "grpscan.h"

struct startwin_settings {
    int fullscreen, display;
    int xdim3d, ydim3d, bpp3d;
    int forcesetup;
    int usemouse, usejoy;
    int samplerate, bitspersample, channels;

    struct grpfile const *selectedgrp;

    int numplayers;
    char *joinhost;
    int netoverride;

    // Brief 05: an online game through the relay (NetRelay, netlobby.h): host a game of
    // hostroom players (> 1), or join the room joinroom (strdup'd; the caller frees it).
    int hostroom;
    char *joinroom;
};

// Brief 05 (GTK startup window): while a relay game waits for its players the window shows
// who is in, and for the host a Start now button (canstart). joined 0: the wait is over.
// startwin_netlobby_poll() is 1 once Start now was pressed since the last call.
void startwin_netlobby(int joined, int slots, int canstart);
int startwin_netlobby_poll(void);
