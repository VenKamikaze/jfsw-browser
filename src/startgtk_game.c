//-------------------------------------------------------------------------
/*
 Copyright (C) 2007-2021 Jonathon Fowler <jf@jonof.id.au>

 This file is part of JFShadowWarrior

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

#include "compat.h"

#include <gtk/gtk.h>

#include "baselayer.h"
#include "build.h"
#include "startwin.h"
#include "netlobby.h"

#define TAB_CONFIG 0
#define TAB_GAME 1
#define TAB_MESSAGES 2

static struct soundQuality_t {
    int frequency;
    int samplesize;
    int channels;
} soundQualities[] = {
    { 44100, 16, 2 },
    { 22050, 16, 2 },
    { 11025, 16, 2 },
    { 0, 0, 0 },    // May be overwritten by custom sound settings.
    { 0, 0, 0 },
};

static GtkWindow *startwin;
static struct {
    GtkWidget *startbutton;
    GtkWidget *cancelbutton;

    GtkWidget *tabs;
    GtkWidget *configbox;
    GtkWidget *alwaysshowcheck;

    GtkWidget *messagestext;

    GtkWidget *vmode3dcombo;
    GtkListStore *vmode3dlist;
    GtkWidget *fullscreencheck;
    GtkWidget *displaycombo;
    GtkListStore *displaylist;

    GtkWidget *usemousecheck;
    GtkWidget *usejoystickcheck;
    GtkWidget *soundqualitycombo;
    GtkListStore *soundqualitylist;

    GtkWidget *singleplayerbutton;
    GtkWidget *joinmultibutton;
    GtkWidget *hostmultibutton;
    GtkWidget *hostfield;
    GtkWidget *numplayersspin;
    GtkAdjustment *numplayersadjustment;
    GtkWidget *hostfieldlabel;
    GtkWidget *onlinecheck;     // brief 05: through the relay (room code, -host-room)
    GtkWidget *relayfield;

    GtkWidget *gametable;
    GtkListStore *gamelist;

    GtkWidget *chooseimportbutton;
    GtkWidget *importinfobutton;

    GtkWindow *importstatuswindow;
    GtkWidget *importstatustext;
    GtkWidget *importstatuscancelbutton;
} controls;

static gboolean startwinloop = FALSE;
static struct startwin_settings *settings;
static gboolean quiteventonclose = FALSE;
static gboolean ignoresignals = FALSE;
static int retval = -1;
static gboolean lobbymode = FALSE;     // brief 05: the Start button is "Start now" in a relay game's wait
static int lobbystart = 0;
static int teststartnow = 0;           // JFSW_TEST_STARTWIN startnow=K (test only)


extern int gtkenabled;

// -- SUPPORT FUNCTIONS -------------------------------------------------------

static GObject * get_and_connect_signal(GtkBuilder *builder, const char *name, const char *signal_name, GCallback handler)
{
    GObject *object;

    object = gtk_builder_get_object(builder, name);
    if (!object) {
        buildprintf("gtk_builder_get_object: %s not found\n", name);
        return 0;
    }
    g_signal_connect(object, signal_name, handler, NULL);
    return object;
}

static void foreach_gtk_widget_set_sensitive(GtkWidget *widget, gpointer data)
{
    gtk_widget_set_sensitive(widget, (gboolean)(intptr_t)data);
}

static void populate_video_modes(gboolean firsttime)
{
    int i, mode3d = -1;
    int xdim = 0, ydim = 0, bitspp = 0, display = 0, fullsc = 0;
    char modestr[64];
    int cd[] = { 32, 24, 16, 15, 8, 0 };
    GtkTreeIter iter;

    if (firsttime) {
        getvalidmodes();
        xdim = settings->xdim3d;
        ydim = settings->ydim3d;
        bitspp = settings->bpp3d;
        fullsc = settings->fullscreen;
        display = min(displaycnt-1, max(0, settings->display));

        gtk_list_store_clear(controls.displaylist);
        for (i = 0; i < displaycnt; i++) {
            snprintf(modestr, sizeof(modestr), "Display %d \xe2\x80\x93 %s", i, getdisplayname(i));
            gtk_list_store_insert_with_values(controls.displaylist, &iter, -1, 0, modestr, 1, i, -1);
        }
        if (displaycnt < 2) gtk_widget_set_visible(controls.displaycombo, FALSE);
    } else {
        // Read back the current resolution information selected in the combobox.
        fullsc = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.fullscreencheck));
        if (gtk_combo_box_get_active_iter(GTK_COMBO_BOX(controls.displaycombo), &iter)) {
            gtk_tree_model_get(GTK_TREE_MODEL(controls.displaylist), &iter, 1 /*index*/, &display, -1);
        }
        if (gtk_combo_box_get_active_iter(GTK_COMBO_BOX(controls.vmode3dcombo), &iter)) {
            gtk_tree_model_get(GTK_TREE_MODEL(controls.vmode3dlist), &iter, 1 /*index*/, &mode3d, -1);
        }
        if (mode3d >= 0) {
            xdim = validmode[mode3d].xdim;
            ydim = validmode[mode3d].ydim;
            bitspp = validmode[mode3d].bpp;
        }
    }

    // Find an ideal match.
    mode3d = checkvideomode(&xdim, &ydim, bitspp, SETGAMEMODE_FULLSCREEN(display, fullsc), 1);
    for (i=0; mode3d < 0 && cd[i]; i++) {
        mode3d = checkvideomode(&xdim, &ydim, cd[i], SETGAMEMODE_FULLSCREEN(display, fullsc), 1);
    }
    if (mode3d < 0) mode3d = 0;
    fullsc = validmode[mode3d].fs;
    display = validmode[mode3d].display;

    // Repopulate the list.
    ignoresignals = TRUE;
    gtk_list_store_clear(controls.vmode3dlist);
    for (i = 0; i < validmodecnt; i++) {
        if (validmode[i].fs != fullsc) continue;
        if (validmode[i].display != display) continue;

        sprintf(modestr, "%d \xc3\x97 %d %d-bpp",
                validmode[i].xdim, validmode[i].ydim, validmode[i].bpp);
        gtk_list_store_insert_with_values(controls.vmode3dlist,
            &iter, -1,
            0, modestr, 1, i, -1);
        if (i == mode3d) {
            gtk_combo_box_set_active_iter(GTK_COMBO_BOX(controls.vmode3dcombo), &iter);
        }
    }

    for (gboolean valid = gtk_tree_model_get_iter_first(GTK_TREE_MODEL(controls.displaylist), &iter);
            (fullsc || firsttime) && valid; valid = gtk_tree_model_iter_next(GTK_TREE_MODEL(controls.displaylist), &iter)) {
        gint index;
        gtk_tree_model_get(GTK_TREE_MODEL(controls.displaylist), &iter, 1, &index, -1);
        if (index == validmode[mode3d].display) {
            gtk_combo_box_set_active_iter(GTK_COMBO_BOX(controls.displaycombo), &iter);
            break;
        }
    }
    gtk_widget_set_sensitive(controls.displaycombo, validmode[mode3d].fs);
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.fullscreencheck), validmode[mode3d].fs);
    ignoresignals = FALSE;
}

static void populate_sound_quality(gboolean firsttime)
{
    int i, curidx = -1;
    char modestr[64];
    GtkTreeIter iter;

    if (firsttime) {
        for (i = 0; soundQualities[i].frequency > 0; i++) {
            if (soundQualities[i].frequency == settings->samplerate &&
                soundQualities[i].samplesize == settings->bitspersample &&
                soundQualities[i].channels == settings->channels) {
                curidx = i;
                break;
            }
        }
        if (curidx < 0) {
            soundQualities[i].frequency = settings->samplerate;
            soundQualities[i].samplesize = settings->bitspersample;
            soundQualities[i].channels = settings->channels;
        }
    }

    gtk_list_store_clear(controls.soundqualitylist);
    for (i = 0; soundQualities[i].frequency > 0; i++) {
        sprintf(modestr, "%d kHz, %d-bit, %s",
            soundQualities[i].frequency / 1000,
            soundQualities[i].samplesize,
            soundQualities[i].channels == 1 ? "Mono" : "Stereo");
        gtk_list_store_insert_with_values(controls.soundqualitylist,
            &iter, -1,
            0, modestr, 1, i, -1);
        if (i == curidx) {
            gtk_combo_box_set_active_iter(GTK_COMBO_BOX(controls.soundqualitycombo), &iter);
        }
    }
}

static void populate_game_list(gboolean firsttime)
{
    struct grpfile const *fg;
    GtkTreeIter iter;
    GtkTreeSelection *sel;

    (void)firsttime;

    gtk_list_store_clear(controls.gamelist);

    for (fg = GroupsFound(); fg; fg = fg->next) {
        if (!fg->ref) continue;
        gtk_list_store_insert_with_values(controls.gamelist,
            &iter, -1,
            0, fg->ref->name, 1, fg->name, 2, fg, -1);
        if (fg == settings->selectedgrp) {
            sel = gtk_tree_view_get_selection(GTK_TREE_VIEW(controls.gametable));
            gtk_tree_selection_select_iter(sel, &iter);
        }
    }
}

static void set_settings(struct startwin_settings *thesettings)
{
    settings = thesettings;
}

static void setup_config_mode(void)
{
    if (!settings->selectedgrp) {
        gtk_notebook_set_current_page(GTK_NOTEBOOK(controls.tabs), TAB_GAME);
    } else {
        gtk_notebook_set_current_page(GTK_NOTEBOOK(controls.tabs), TAB_CONFIG);
    }

    // Enable all the controls on the Configuration page.
    gtk_container_foreach(GTK_CONTAINER(controls.configbox),
            foreach_gtk_widget_set_sensitive, (gpointer)TRUE);
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.alwaysshowcheck), settings->forcesetup);
    gtk_widget_set_sensitive(controls.alwaysshowcheck, TRUE);

    gtk_widget_set_sensitive(controls.vmode3dcombo, TRUE);
    gtk_widget_set_sensitive(controls.fullscreencheck, TRUE);
    gtk_widget_set_sensitive(controls.displaycombo, TRUE);
    populate_video_modes(TRUE);

    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.usemousecheck), settings->usemouse);
    gtk_widget_set_sensitive(controls.usemousecheck, TRUE);
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.usejoystickcheck), settings->usejoy);
    gtk_widget_set_sensitive(controls.usejoystickcheck, TRUE);

    populate_sound_quality(TRUE);
    gtk_widget_set_sensitive(controls.soundqualitycombo, TRUE);

    if (!settings->netoverride) {
        gtk_widget_set_sensitive(controls.singleplayerbutton, TRUE);
        gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.singleplayerbutton), TRUE);

        gtk_widget_set_sensitive(controls.joinmultibutton, TRUE);
        gtk_widget_set_sensitive(controls.hostfield, FALSE);

        gtk_widget_set_sensitive(controls.hostmultibutton, TRUE);
        gtk_widget_set_sensitive(controls.numplayersspin, FALSE);
        gtk_spin_button_set_range(GTK_SPIN_BUTTON(controls.numplayersspin), 2, MAXPLAYERS);
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(controls.numplayersspin), 2.0);

        gtk_entry_set_text(GTK_ENTRY(controls.relayfield), NetRelay);
        gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.onlinecheck), NetRelay[0] != 0);
        gtk_widget_set_sensitive(controls.onlinecheck, FALSE);
        gtk_widget_set_sensitive(controls.relayfield, FALSE);
    } else {
        gtk_widget_set_sensitive(controls.singleplayerbutton, FALSE);
        gtk_widget_set_sensitive(controls.joinmultibutton, FALSE);
        gtk_widget_set_sensitive(controls.hostfield, FALSE);
        gtk_widget_set_sensitive(controls.hostmultibutton, FALSE);
        gtk_widget_set_sensitive(controls.numplayersspin, FALSE);
        gtk_widget_set_sensitive(controls.onlinecheck, FALSE);
        gtk_widget_set_sensitive(controls.relayfield, FALSE);
    }

    populate_game_list(TRUE);
    gtk_widget_set_sensitive(controls.gametable, TRUE);
    gtk_widget_set_sensitive(controls.chooseimportbutton, TRUE);
    gtk_widget_set_sensitive(controls.importinfobutton, TRUE);

    gtk_widget_set_sensitive(controls.cancelbutton, TRUE);
    gtk_widget_set_sensitive(controls.startbutton, TRUE);
}

static void setup_messages_mode(gboolean allowcancel)
{
    gtk_notebook_set_current_page(GTK_NOTEBOOK(controls.tabs), TAB_MESSAGES);

    // Disable all the controls on the Configuration page.
    gtk_container_foreach(GTK_CONTAINER(controls.configbox),
            foreach_gtk_widget_set_sensitive, (gpointer)FALSE);
    gtk_widget_set_sensitive(controls.alwaysshowcheck, FALSE);

    gtk_widget_set_sensitive(controls.gametable, FALSE);
    gtk_widget_set_sensitive(controls.chooseimportbutton, FALSE);
    gtk_widget_set_sensitive(controls.importinfobutton, FALSE);

    gtk_widget_set_sensitive(controls.cancelbutton, allowcancel);
    gtk_widget_set_sensitive(controls.startbutton, FALSE);
}

// -- EVENT CALLBACKS AND CREATION STUFF --------------------------------------

static void on_fullscreencheck_toggled(GtkToggleButton *togglebutton, gpointer user_data)
{
    (void)togglebutton; (void)user_data;

    if (!ignoresignals) populate_video_modes(FALSE);
}

static void on_displaycombo_changed(GtkComboBox *combobox, gpointer user_data)
{
    (void)combobox; (void)user_data;

    if (!ignoresignals) populate_video_modes(FALSE);
}

static void on_multiplayerradio_toggled(GtkRadioButton *radiobutton, gpointer user_data)
{
    (void)radiobutton; (void)user_data;
    //gboolean singleactive = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.singleplayerbutton));
    gboolean joinmultiactive = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.joinmultibutton));
    gboolean hostmultiactive = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.hostmultibutton));

    gtk_widget_set_sensitive(controls.hostfield, joinmultiactive);
    gtk_widget_set_sensitive(controls.numplayersspin, hostmultiactive);
    gtk_widget_set_sensitive(controls.onlinecheck, joinmultiactive || hostmultiactive);
    gtk_widget_set_sensitive(controls.relayfield, joinmultiactive || hostmultiactive);
}

static void on_onlinecheck_toggled(GtkToggleButton *togglebutton, gpointer user_data)
{
    (void)user_data;
    // the join field holds a room code for an online game, a host address otherwise
    gtk_label_set_text_with_mnemonic(GTK_LABEL(controls.hostfieldlabel),
        gtk_toggle_button_get_active(togglebutton) ? "Room co_de:" : "Host a_ddress:");
}

static void on_cancelbutton_clicked(GtkButton *button, gpointer user_data)
{
    (void)button; (void)user_data;
    startwinloop = FALSE;   // Break the loop.
    retval = STARTWIN_CANCEL;
    quitevent = quitevent || quiteventonclose;
}

static void on_startbutton_clicked(GtkButton *button, gpointer user_data)
{
    int mode = -1;
    GtkTreeIter iter;
    GtkTreeSelection *sel;

    (void)button; (void)user_data;

    if (lobbymode) {
        // brief 05: Start now, during a relay game's wait (netlobby.c polls it)
        lobbystart = 1;
        return;
    }

    if (gtk_combo_box_get_active_iter(GTK_COMBO_BOX(controls.vmode3dcombo), &iter)) {
        gtk_tree_model_get(GTK_TREE_MODEL(controls.vmode3dlist), &iter, 1 /*index*/, &mode, -1);
    }
    if (mode >= 0) {
        settings->xdim3d = validmode[mode].xdim;
        settings->ydim3d = validmode[mode].ydim;
        settings->bpp3d = validmode[mode].bpp;
        settings->fullscreen = validmode[mode].fs;
        settings->display = validmode[mode].display;
    }

    settings->usemouse = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.usemousecheck));
    settings->usejoy = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.usejoystickcheck));

    mode = -1;
    if (gtk_combo_box_get_active_iter(GTK_COMBO_BOX(controls.soundqualitycombo), &iter)) {
        gtk_tree_model_get(GTK_TREE_MODEL(controls.soundqualitylist), &iter, 1 /*index*/, &mode, -1);
    }
    if (mode >= 0) {
        settings->samplerate = soundQualities[mode].frequency;
        settings->bitspersample = soundQualities[mode].samplesize;
        settings->channels = soundQualities[mode].channels;
    }

    settings->numplayers = 0;
    settings->joinhost = NULL;
    settings->hostroom = 0;
    settings->joinroom = NULL;
    if (gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.singleplayerbutton))) {
        settings->numplayers = 1;
    } else if (gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.onlinecheck))) {
        // brief 05: through the relay; NetStartwinArgs() (netlobby.c) makes the -net arguments
        const char *why = NULL;
        const char *code = gtk_entry_get_text(GTK_ENTRY(controls.hostfield));
        int joining = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.joinmultibutton));
        if (!gtk_entry_get_text(GTK_ENTRY(controls.relayfield))[0]) {
            why = "An online game needs the relay's address (HOST:PORT, for example relay.example.org:7777).";
        } else if (joining && !NetIsRoomCode(code, NULL)) {
            why = code[0] ? "That is not a room code: a room code is 6 letters and digits (no 0, 1, I or O), as the host's lobby shows it."
                          : "Type the room code of the game to join (6 letters and digits, from the host).";
        }
        if (why) {
            // say so and stay in the window, rather than start something else
            GtkWidget *dialog = gtk_message_dialog_new(startwin, GTK_DIALOG_DESTROY_WITH_PARENT,
                GTK_MESSAGE_ERROR, GTK_BUTTONS_CLOSE, "%s", why);
            buildprintf("Startup window: %s\n", why);
            fflush(stdout);
            if (!getenv("JFSW_TEST_STARTWIN")) gtk_dialog_run(GTK_DIALOG(dialog));
            gtk_widget_destroy(dialog);
            settings->numplayers = 0;
            return;
        }
        snprintf(NetRelay, sizeof(NetRelay), "%s", gtk_entry_get_text(GTK_ENTRY(controls.relayfield)));
        if (gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.joinmultibutton))) {
            settings->joinroom = strdup(gtk_entry_get_text(GTK_ENTRY(controls.hostfield)));
        } else {
            settings->hostroom = gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(controls.numplayersspin));
        }
    } else if (gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.joinmultibutton))) {
        settings->numplayers = 2;
        settings->joinhost = strdup(gtk_entry_get_text(GTK_ENTRY(controls.hostfield)));
    } else if (gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.hostmultibutton))) {
        settings->numplayers = gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(controls.numplayersspin));
    }

    // Get the chosen game entry.
    settings->selectedgrp = NULL;
    sel = gtk_tree_view_get_selection(GTK_TREE_VIEW(controls.gametable));
    if (gtk_tree_selection_get_selected(sel, NULL, &iter)) {
        gtk_tree_model_get(GTK_TREE_MODEL(controls.gamelist), &iter, 2 /*data*/, &settings->selectedgrp, -1);
    }

    settings->forcesetup = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(controls.alwaysshowcheck));

    startwinloop = FALSE;   // Break the loop.
    retval = STARTWIN_RUN;
}

static gboolean on_startgtk_delete_event(GtkWidget *widget, GdkEvent *event, gpointer user_data)
{
    (void)widget; (void)event; (void)user_data;
    startwinloop = FALSE;   // Break the loop.
    retval = STARTWIN_CANCEL;
    quitevent = quitevent || quiteventonclose;
    return TRUE;    // FALSE would let the event go through. We want the game to decide when to close.
}

static void on_importstatus_cancelbutton_clicked(GtkButton *button, gpointer user_data)
{
    (void)button;
    g_cancellable_cancel((GCancellable *)user_data);
}

static int set_importstatus_text(void *text)
{
    // Called in the main thread via g_main_context_invoke in the import thread.
    gtk_label_set_text(GTK_LABEL(controls.importstatustext), text);
    free(text);
    return 0;
}

static void importmeta_progress(void *data, const char *path)
{
    // Called in the import thread.
    (void)data;
    g_main_context_invoke(NULL, set_importstatus_text, (gpointer)strdup(path));
}

static int importmeta_cancelled(void *data)
{
    // Called in the import thread.
    return g_cancellable_is_cancelled((GCancellable *)data);
}

static void import_thread_func(GTask *task, gpointer source_object, gpointer task_data, GCancellable *cancellable)
{
    char *filename = (char *)task_data;
    struct importgroupsmeta meta = {
        (void *)cancellable,
        importmeta_progress,
        importmeta_cancelled
    };
    (void)source_object;
    g_task_return_int(task, ImportGroupsFromPath(filename, &meta));
}

static void on_chooseimportbutton_clicked(GtkButton *button, gpointer user_data)
{
    GtkWidget *dialog;
    char *filename = NULL;

    (void)button; (void)user_data;

    dialog = gtk_file_chooser_dialog_new("Import game data", startwin,
        GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER,
        "_Cancel", GTK_RESPONSE_CANCEL,
        "_Import", GTK_RESPONSE_ACCEPT,
        NULL);
    gtk_file_chooser_set_local_only(GTK_FILE_CHOOSER(dialog), TRUE);

    GtkWidget *content = gtk_dialog_get_content_area(GTK_DIALOG(dialog));
    GtkWidget *label = gtk_label_new("Select a folder to search.");
    gtk_widget_show(label);
    gtk_widget_set_margin_top(label, 7);
    gtk_widget_set_margin_bottom(label, 7);
    gtk_container_add(GTK_CONTAINER(content), label);
    gtk_box_reorder_child(GTK_BOX(content), label, 0);

    if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT) {
        GtkFileChooser *chooser = GTK_FILE_CHOOSER(dialog);
        filename = gtk_file_chooser_get_filename(chooser);
    }
    gtk_widget_destroy(dialog);

    if (filename) {
        GTask *task = NULL;
        GError *err = NULL;
        GCancellable *cancellable = NULL;
        gulong clickhandlerid;
        int rv;

        cancellable = g_cancellable_new();
        task = g_task_new(NULL, cancellable, NULL, NULL);
        g_task_set_check_cancellable(task, FALSE);

        // Pass the filename as task data.
        g_task_set_task_data(task, (gpointer)filename, NULL);

        // Connect the import status cancel button passing the GCancellable* as user data.
        clickhandlerid = g_signal_connect(controls.importstatuscancelbutton, "clicked",
            G_CALLBACK(on_importstatus_cancelbutton_clicked), (gpointer)cancellable);

        // Show the status window, run the import thread, and while it's running, pump the Gtk queue.
        gtk_widget_show(GTK_WIDGET(controls.importstatuswindow));
        g_task_run_in_thread(task, import_thread_func);
        while (!g_task_get_completed(task)) gtk_main_iteration();

        // Get the return value from the import thread, then hide the status window.
        rv = g_task_propagate_int(task, &err);
        if (rv > 0) populate_game_list(FALSE);
        gtk_widget_hide(GTK_WIDGET(controls.importstatuswindow));

        // Disconnect the cancel button and clean up.
        g_signal_handler_disconnect(controls.importstatuscancelbutton, clickhandlerid);
        if (err) g_error_free(err);
        g_object_unref(cancellable);
        g_object_unref(task);

        g_free(filename);
    }
}

static void on_importinfobutton_clicked(GtkButton *button, gpointer user_data)
{
    GtkWidget *dialog;
    const char *sharewareurl = "https://www.jonof.id.au/files/jfsw/swsw12.zip";

    (void)button; (void)user_data;

    dialog = gtk_message_dialog_new(startwin, GTK_DIALOG_DESTROY_WITH_PARENT,
        GTK_MESSAGE_INFO, GTK_BUTTONS_CLOSE,
        "JFShadowWarrior can scan locations of your choosing for Shadow Warrior game data");
    gtk_message_dialog_format_secondary_markup(GTK_MESSAGE_DIALOG(dialog),
        "Click the 'Choose a location...' button, then locate a folder to scan.\n\n"
        "Common locations to check include:\n"
        " • CD/DVD drives\n"
        " • Steam library directories\n\n"
        "To play the Shareware version, download the shareware data (swsw12.zip), unzip the file, "
            "then select the folder where SW.GRP is found with the 'Choose a location...' option.");
    gtk_dialog_add_button(GTK_DIALOG(dialog), "Download Shareware", 1);
    if (gtk_dialog_run(GTK_DIALOG(dialog)) == 1) {
        g_app_info_launch_default_for_uri(sharewareurl, NULL, NULL);
    }
    gtk_widget_destroy(dialog);
}

static GtkWindow *create_window(void)
{
    GtkBuilder *builder = NULL;
    GError *error = NULL;
    GtkWidget *window = NULL;
    GtkImage *appicon = NULL;

    builder = gtk_builder_new();
    if (!builder) {
        goto fail;
    }
    if (!gtk_builder_add_from_resource(builder, "/startgtk.glade", &error)) {
        buildprintf("gtk_builder_add_from_resource error: %s\n", error->message);
        goto fail;
    }

    // Get the window widget.
    window = GTK_WIDGET(get_and_connect_signal(builder, "startgtk",
        "delete-event", G_CALLBACK(on_startgtk_delete_event)));
    if (!window) {
        goto fail;
    }

    // Set the appicon image.
    appicon = GTK_IMAGE(gtk_builder_get_object(builder, "appicon"));
    if (appicon) {
        gtk_image_set_from_resource(appicon, "/appicon.png");
    }

    // Get the window widgets we need and wire them up as appropriate.
    controls.startbutton = GTK_WIDGET(get_and_connect_signal(builder, "startbutton",
        "clicked", G_CALLBACK(on_startbutton_clicked)));
    controls.cancelbutton = GTK_WIDGET(get_and_connect_signal(builder, "cancelbutton",
        "clicked", G_CALLBACK(on_cancelbutton_clicked)));

    controls.tabs = GTK_WIDGET(gtk_builder_get_object(builder, "tabs"));
    controls.configbox = GTK_WIDGET(gtk_builder_get_object(builder, "configbox"));
    controls.alwaysshowcheck = GTK_WIDGET(gtk_builder_get_object(builder, "alwaysshowcheck"));

    controls.messagestext = GTK_WIDGET(gtk_builder_get_object(builder, "messagestext"));

    controls.vmode3dcombo = GTK_WIDGET(gtk_builder_get_object(builder, "vmode3dcombo"));
    controls.vmode3dlist = GTK_LIST_STORE(gtk_builder_get_object(builder, "vmode3dlist"));
    controls.fullscreencheck = GTK_WIDGET(get_and_connect_signal(builder, "fullscreencheck",
        "toggled", G_CALLBACK(on_fullscreencheck_toggled)));
    controls.displaycombo = GTK_WIDGET(get_and_connect_signal(builder, "displaycombo",
        "changed", G_CALLBACK(on_displaycombo_changed)));
    controls.displaylist = GTK_LIST_STORE(gtk_builder_get_object(builder, "displaylist"));

    controls.usemousecheck = GTK_WIDGET(gtk_builder_get_object(builder, "usemousecheck"));
    controls.usejoystickcheck = GTK_WIDGET(gtk_builder_get_object(builder, "usejoystickcheck"));
    controls.soundqualitycombo = GTK_WIDGET(gtk_builder_get_object(builder, "soundqualitycombo"));
    controls.soundqualitylist = GTK_LIST_STORE(gtk_builder_get_object(builder, "soundqualitylist"));

    controls.singleplayerbutton = GTK_WIDGET(get_and_connect_signal(builder, "singleplayerbutton",
        "toggled", G_CALLBACK(on_multiplayerradio_toggled)));
    controls.joinmultibutton = GTK_WIDGET(get_and_connect_signal(builder, "joinmultibutton",
        "toggled", G_CALLBACK(on_multiplayerradio_toggled)));
    controls.hostmultibutton = GTK_WIDGET(get_and_connect_signal(builder, "hostmultibutton",
        "toggled", G_CALLBACK(on_multiplayerradio_toggled)));
    controls.hostfield = GTK_WIDGET(gtk_builder_get_object(builder, "hostfield"));
    controls.numplayersspin = GTK_WIDGET(gtk_builder_get_object(builder, "numplayersspin"));
    controls.numplayersadjustment = GTK_ADJUSTMENT(gtk_builder_get_object(builder, "numplayersadjustment"));
    controls.hostfieldlabel = GTK_WIDGET(gtk_builder_get_object(builder, "hostfieldlabel"));
    controls.onlinecheck = GTK_WIDGET(get_and_connect_signal(builder, "onlinecheck",
        "toggled", G_CALLBACK(on_onlinecheck_toggled)));
    controls.relayfield = GTK_WIDGET(gtk_builder_get_object(builder, "relayfield"));

    controls.gametable = GTK_WIDGET(gtk_builder_get_object(builder, "gametable"));
    controls.gamelist = GTK_LIST_STORE(gtk_builder_get_object(builder, "gamelist"));

    controls.chooseimportbutton = GTK_WIDGET(get_and_connect_signal(builder, "chooseimportbutton",
        "clicked", G_CALLBACK(on_chooseimportbutton_clicked)));
    controls.importinfobutton = GTK_WIDGET(get_and_connect_signal(builder, "importinfobutton",
        "clicked", G_CALLBACK(on_importinfobutton_clicked)));

    controls.importstatuswindow = GTK_WINDOW(gtk_builder_get_object(builder, "importstatuswindow"));
    controls.importstatustext = GTK_WIDGET(gtk_builder_get_object(builder, "importstatustext"));
    controls.importstatuscancelbutton = GTK_WIDGET(gtk_builder_get_object(builder, "importstatuscancelbutton"));

    g_object_unref(G_OBJECT(builder));

    return GTK_WINDOW(window);

fail:
    if (window) {
        gtk_widget_destroy(window);
    }
    if (builder) {
        g_object_unref(G_OBJECT(builder));
    }
    return 0;
}




// -- BUILD ENTRY POINTS ------------------------------------------------------

int startwin_open(void)
{
    if (!gtkenabled) return 0;
    if (startwin) return 1;

    startwin = create_window();
    if (!startwin) {
        return -1;
    }

    quiteventonclose = TRUE;
    setup_messages_mode(TRUE);
    gtk_widget_show_all(GTK_WIDGET(startwin));
    return 0;
}

int startwin_close(void)
{
    if (!gtkenabled) return 0;
    if (!startwin) return 1;

    quiteventonclose = FALSE;
    gtk_widget_destroy(GTK_WIDGET(startwin));
    startwin = NULL;

    while (gtk_events_pending()) {
        gtk_main_iteration();
    }

    return 0;
}

static gboolean startwin_puts_inner(gpointer str)
{
    GtkTextBuffer *textbuffer;
    GtkTextIter enditer;
    GtkTextMark *mark;
    const char *aptr, *bptr;

    textbuffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(controls.messagestext));

    gtk_text_buffer_get_end_iter(textbuffer, &enditer);
    for (aptr = bptr = (const char *)str; *aptr != 0; ) {
        switch (*bptr) {
            case '\b':
                if (bptr > aptr) {
                    // Insert any normal characters seen so far.
                    gtk_text_buffer_insert(textbuffer, &enditer, (const gchar *)aptr, (gint)(bptr-aptr)-1);
                }
                gtk_text_buffer_backspace(textbuffer, &enditer, FALSE, TRUE);
                aptr = ++bptr;
                break;
            case 0:
                if (bptr > aptr) {
                    gtk_text_buffer_insert(textbuffer, &enditer, (const gchar *)aptr, (gint)(bptr-aptr));
                }
                aptr = bptr;
                break;
            default:
                bptr++;
                break;
        }
    }

    mark = gtk_text_buffer_create_mark(textbuffer, NULL, &enditer, 1);
    gtk_text_view_scroll_to_mark(GTK_TEXT_VIEW(controls.messagestext), mark, 0.0, FALSE, 0.0, 1.0);
    gtk_text_buffer_delete_mark(textbuffer, mark);

    free(str);
    return FALSE;
}

int startwin_puts(const char *str)
{
    // Called in either the main thread or the import thread via buildprintf.
    if (!gtkenabled || !str) return 0;
    if (!startwin) return 1;

    g_main_context_invoke(NULL, startwin_puts_inner, (gpointer)strdup(str));

    return 0;
}

int startwin_settitle(const char *title)
{
    if (!gtkenabled) return 0;

    if (startwin) {
        gtk_window_set_title(startwin, title);
    }

    return 0;
}

int startwin_idle(void *s)
{
    (void)s;
    return 0;
}

// Test only (brief 05, tests/net/test-startwin.sh): JFSW_TEST_STARTWIN="host=N relay=ADDR" or
// "room=CODE relay=ADDR", optionally "startnow=K": fill in the window's network choices as a
// person would and press Start (and, in the wait, press Start now once K players are in). The
// rest is the window's own code: the toggles, the Start handler, the lobby button.
static void testchoices(void)
{
    const char *env = getenv("JFSW_TEST_STARTWIN");
    char buf[256], *tok, *save = NULL;

    if (!env || !*env) return;
    snprintf(buf, sizeof(buf), "%s", env);
    for (tok = strtok_r(buf, " ,", &save); tok; tok = strtok_r(NULL, " ,", &save)) {
        if (!strncmp(tok, "host=", 5)) {
            gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.hostmultibutton), TRUE);
            gtk_spin_button_set_value(GTK_SPIN_BUTTON(controls.numplayersspin), atoi(tok + 5));
        } else if (!strncmp(tok, "room=", 5)) {
            gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.joinmultibutton), TRUE);
            gtk_entry_set_text(GTK_ENTRY(controls.hostfield), tok + 5);
        } else if (!strncmp(tok, "relay=", 6)) {
            gtk_entry_set_text(GTK_ENTRY(controls.relayfield), tok + 6);
        } else if (!strncmp(tok, "startnow=", 9)) {
            teststartnow = atoi(tok + 9);
        }
    }
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(controls.onlinecheck), TRUE);
    buildprintf("TEST: startup window: %s\n", env);
    gtk_button_clicked(GTK_BUTTON(controls.startbutton));
}

void startwin_netlobby(int joined, int slots, int canstart)
{
    char label[64];
    static int lastj = -1, lasts = -1, lastc = -1;

    if (!gtkenabled || !startwin) return;
    if (joined == lastj && slots == lasts && canstart == lastc) return;
    lastj = joined; lasts = slots; lastc = canstart;

    if (!joined && !slots) {
        lobbymode = FALSE;
        gtk_button_set_label(GTK_BUTTON(controls.startbutton), "_Start");
        gtk_widget_set_sensitive(controls.startbutton, FALSE);
        return;
    }
    lobbymode = TRUE;
    if (canstart) {
        snprintf(label, sizeof(label), "_Start now (%d of %d in)", joined, slots);
    } else {
        snprintf(label, sizeof(label), "%d of %d players in", joined, slots);
    }
    gtk_button_set_label(GTK_BUTTON(controls.startbutton), label);
    gtk_widget_set_sensitive(controls.startbutton, canstart && joined >= 2);
    if (canstart && teststartnow && joined >= teststartnow) {
        teststartnow = 0;
        buildprintf("TEST: startup window: pressing Start now with %d of %d in\n", joined, slots);
        gtk_button_clicked(GTK_BUTTON(controls.startbutton));
    }
}

int startwin_netlobby_poll(void)
{
    int r = lobbystart;
    lobbystart = 0;
    return r;
}

int startwin_run(struct startwin_settings *settings)
{
    if (!gtkenabled || !startwin) return STARTWIN_RUN;

    set_settings(settings);
    setup_config_mode();
    startwinloop = TRUE;
    testchoices();
    while (startwinloop) {
        gtk_main_iteration_do(TRUE);
    }
    setup_messages_mode(settings->numplayers > 1);
    set_settings(NULL);

    return retval;
}

