# emscripten-ports

Orphan branch. Library archives that Emscripten 6.0.13 would otherwise download
from GitHub, which some networks (the cloud container) block with HTTP 403.
`scripts/setup-emsdk.sh --with-ports` (on `claude` and the feature branches)
fetches this branch, checks each archive's SHA-512 against `tools/ports/<name>.py`
in the pinned emsdk, and seeds Emscripten's cache with it.

| File | Port | URL Emscripten fetches |
|---|---|---|
| release-2.32.10.zip | sdl2 | https://github.com/libsdl-org/SDL/archive/release-2.32.10.zip |
| libogg-1.3.5.zip | ogg | https://github.com/xiph/ogg/releases/download/v1.3.5/libogg-1.3.5.zip |
| libvorbis-1.3.7.zip | vorbis | https://github.com/xiph/vorbis/releases/download/v1.3.7/libvorbis-1.3.7.zip |

Library archives only; never game data. If the emsdk pin changes, refresh them.
