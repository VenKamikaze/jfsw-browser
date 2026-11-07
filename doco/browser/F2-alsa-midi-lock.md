# F2: Native crash in the ALSA MIDI music driver

## Goal

Native Linux builds no longer corrupt memory and crash when music plays through jfaudiolib's ALSA MIDI driver. The fix can go upstream to JonoF unchanged. Headless test runs never play music through the desktop's real devices.

## What is known

- Reported by the user (7 Nov 2026) on Arch Linux, running `scripts/run-headless.sh --timeout 10 -level1`:
  - **At shutdown:** a segmentation fault in `snd_seq_close()` → `free()` (after `ALSADrv: could not drain output: err -22` and `err -14`).
  - **A second or two into play:** many `ALSADrv: could not drain output: err -22`, then glibc's `corrupted size vs. prev_size`, then an abort.
- **Why the music driver ran:** `SDL_AUDIODRIVER=dummy` silences SDL, but not jfaudiolib's music drivers. With autodetect, FluidSynth is tried first; it failed for lack of a soundfont, and the ALSA sequencer was used.
- **The cloud container can't reproduce it:** there is no ALSA sequencer there, so music is always "No Sound".

## Cause

`jfaudiolib/src/midi.c` brackets its main-thread calls (`MIDI_SetVolume`, `MIDI_AllNotesOff`, `MIDI_Reset`, and others) with `SoundDriver_MIDI_Lock()`/`Unlock()`. It relies on the driver to keep them from running at the same time as the playback thread, which runs the MIDI service routine and sends note and tempo events. In `driver_alsa.c` those lock functions were **empty**. The driver's `SetTempo` and its queue start and stop also use the handle from both threads.

ALSA sequencer handles are not thread-safe, so the two threads corrupted the handle's output buffer. The symptoms were the drain errors (`-EINVAL`, `-EFAULT`), then heap corruption detected in `free()`.

## Upstream check (6-7 Nov 2026)

- `jonof/jfaudiolib` `master` (`96cb69e`) is 4 commits ahead of the pin (`68be97f`). None of them touches `driver_alsa.c`, `midi.c` or `music.c`.
- Of the unmerged pull requests, #6 reorders the music drivers (FluidSynth before ALSA), #12 touches the mixers and #13 the SDL driver. None fixes this.

## Fix

- **Fix branch:** `fix/alsa-midi-lock` in the jfaudiolib fork, from the pinned `68be97f`. It is one commit, `3bb2352`, with a commit message written for upstream. It applies cleanly to upstream `master` (`96cb69e`, checked with a cherry-pick).
- **What it does:** a recursive `pthread` mutex in `driver_alsa.c`.
  - `ALSADrv_MIDI_Lock()`/`Unlock()` take it.
  - The playback thread holds it while it runs the service routine, and releases it while it sleeps.
  - `SetTempo`, the queue start in `StartPlayback` and the queue stop in `HaltPlayback` take it too.
- **Why recursive:** both sides re-enter it. `MIDI_Reset` locks and calls `MIDI_AllNotesOff`, which locks; the service routine changes the tempo.
- **No deadlock:** `HaltPlayback` joins the thread without holding the lock, and no caller in the MIDI layer holds the lock across `HaltPlayback`.
- **Integration:**
  - `fix/alsa-midi-lock` is merged into the fork's `claude` (`ff1b31d`), and the submodule points there.
  - The integration branch is `browser/F2-alsa-midi-lock` in jfsw-browser.
- **No music in headless runs:** `scripts/run-headless.sh` sets `MusicDevice = 1` ("no music") in the work directory's `sw.cfg`: created if missing, changed if present, left alone with `--music`.

## Tests

- **Native build:** `driver_alsa.c` compiles cleanly with `-W -Wall -Wextra`. The fix can't be exercised in the container, which has no ALSA sequencer: **the user verifies it on Arch** (steps below).
- **`tests/run-headless.sh`** has new cases for the music setting:
  - a new `sw.cfg` gets `MusicDevice = 1`;
  - an existing one is changed, and the rest of it is kept;
  - `--music` keeps the work directory's own setting.
- Results: 21 passed with the change, and 19 passed, 2 failed against the previous script.
- A real headless run makes no music-driver attempt at all, and `--music` brings the ALSA attempt back.

## Outcome

**Coordinator verification (7 Nov 2026), on `browser/F2-alsa-midi-lock` with jfaudiolib at `ff1b31d`:** `make veryclean && make -j4` green (14 warnings, as before; `driver_alsa.c` built with `HAVE_ALSA`); `tests/run-headless.sh` 21/0; `make test GAME_RUNS=1` 5 PASS, 0 FAILED (every network game now runs with the created `sw.cfg`); `tests/web/determinism.js` 20/1 (native and wasm `.dms` identical; the only failure is the known "no stall over 100 ms" check, max 142 ms). Not reviewed by a separate reviewer (the user chose a quick fix to save tokens). Merged into `claude` with `--no-ff`. Status: **done**.

**Play-tested by the user (7 Nov 2026, Arch Linux, ALSA sequencer):** ten `run-headless.sh --music --timeout 20 -level1` runs, all `Music driver is ALSA` and exit 124, with no drain errors, corruption or crashes (before the fix it crashed within a few runs). A normal game ran too, silent because no soundfont was installed: the FluidSynth driver (tried first) looks for `*.sf2` in `.`, `/usr/share/soundfonts/` and `/usr/share/sounds/sf2/`, and the ALSA driver sends MIDI to sequencer client 128, which makes no sound unless it is a synth. On Arch, `pacman -S soundfont-fluid` (installs `/usr/share/soundfonts/FluidR3_GM.sf2`) or `MusicParams = "soundfont=/path/to/file.sf2"` in `sw.cfg` gives FluidSynth music. That is configuration, not a bug.

**Play-test on Arch Linux** (the user):

1. Get the branch (or `claude`, once merged) and rebuild from clean, because the submodule moved (`bugs.md` L9):

   ```bash
   git fetch origin && git checkout browser/F2-alsa-midi-lock && git submodule update --init
   ```

   ```bash
   make veryclean && make -j4
   ```

2. **With music** (this is the case that crashed): run it several times, and also play a level normally (`./sw`) with music on. Without the fix it crashed within a few runs.

   ```bash
   for i in 1 2 3 4 5 6 7 8 9 10; do scripts/run-headless.sh --music --timeout 20 -level1 2>&1 | grep -E 'drain output|corrupted|Segmentation|Aborted|Music driver'; echo "run $i: exit ${PIPESTATUS[0]}"; done
   ```

   Expect `Music driver is ALSA`, exit status 124 (stopped by the timeout), and no `drain output`, `corrupted`, `Segmentation` or `Aborted` lines.
3. **Without music** (the new default): `scripts/run-headless.sh --timeout 10 -level1` should print no `MUSIC_Init: trying` lines.
