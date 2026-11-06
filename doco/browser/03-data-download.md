# 03: Game data download from a URL

## Goal

The browser build gets its game data the way decision D8 describes. The page downloads the GRP before the game starts, shows progress, and caches it in IndexedDB, so a reload starts at once with no download and no re-checksum. A file picker covers people with their own copy. Every failure has a clear message. The server side is documented.

## Read first

- [`README.md`](README.md): D8, D11 (only the shareware GRP is offered for download by default), Q2 (the data source, and that it has **no CORS headers** and is a zip inside a zip).
- [`code-facts.md`](code-facts.md): §6 (the search path, `grpfiles.cache`, portable mode) and what brief 02 added (§12 and later).
- The Outcome of [02](02-emscripten-port.md): how `web/jfsw.js` starts the game today. The GRP is fetched from `?data=` (default: `swshare.grp` next to the page) into `/data/sw.grp` (on the search path, not persisted), with no cache. The game's directory is `/persist` on IDBFS, in portable mode (`user_profiles_disabled`), and holds `sw.cfg`, saves and `grpfiles.cache`. This brief replaces the uncached fetch.
- `src/grpscan.c`: the known GRPs (name, CRC32, size) and how `grpfiles.cache` is keyed (name, size, mtime).

## In scope

### 1. Configuration

- The data URL comes from the page config: one small, documented place a person hosting the game edits (e.g. a `<script>` block or a `config.js` next to the page). `?data=<url>` overrides it (D8).
- The default is the **shareware** GRP served from the page's own origin (D11). The config can declare the expected size (and, optionally, CRC32) of the file, so the page can check it.

### 2. Download with progress

- A progress bar showing bytes and percentage, with a sensible display when the total is unknown or the response is compressed. With `Content-Encoding: gzip` the `Content-Length` is the compressed size, so use the declared size from the config where there is one.
- The download is checked before it's used and before it's cached:
  - its size matches the config's declared size, if any;
  - it is a GRP the game knows: the CRC32 and size match an entry of `src/grpscan.c`'s table. Compute the CRC32 in JavaScript, off the main thread if it's slow enough to matter, and say how long it takes. Keep the table in one place and check it against `grpscan.c` in a test, so the two can't drift.
- A truncated or wrong file is never cached and never handed to the game.

### 3. IndexedDB cache

- A cache of its own (not inside the game's IDBFS folder), keyed by URL, holding the file plus what's needed to trust it: size, ETag or Last-Modified if the server sent them, the CRC32, and when it was stored.
- **A second load with a cached file makes no network request for it** (the test checks this). Decide, and document, when the cache is revalidated or replaced:
  - when the configured URL or declared size changes;
  - by a visible "download again" control.
  - Whether a cheap conditional request (`If-None-Match`) is worth adding is your call; if you add one, the no-network test must still hold for the default config, so make it opt-in.
- Old entries for URLs no longer configured are removed.
- Ask for persistent storage (`navigator.storage.persist()`) and say in the Outcome what Chrome and Firefox do with the request.
- **Quota:** if storing fails (`QuotaExceededError` or similar), the game still starts from the downloaded copy, with a notice that it will be downloaded again next time.

### 4. No re-checksum on reload

- The game re-checksums the GRP on every start today, because `/data/sw.grp` is written with a new mtime each time and `grpfiles.cache` is keyed by name, size and mtime (code-facts §6 and §12).
- Give the file a stable mtime (e.g. the cache entry's stored time, through `FS.utime`) so the game's persisted `grpfiles.cache` hits. The test checks that the game doesn't print `Checksumming` on the second load. No engine change should be needed; if one is, keep it small, under `__EMSCRIPTEN__`.

### 5. File picker

- "Use your own copy": an `<input type=file>` that accepts a `.grp`. It is checked the same way (a known CRC32 and size) and cached under a key of its own, so a reload uses it again. A registered `sw.grp` works too; it is the person's own copy, used locally, which D11 allows.
- It is offered on the start screen and in the error messages below, and the page shows which data it's using (shareware or registered, downloaded or local), with a way to switch back.

### 6. Clear errors

Each of these gets a plain message on the page that names the problem and the URL, and offers the file picker and a retry:

- HTTP errors (404, 403, 500…);
- a CORS block or a network failure. The two can't be told apart in JavaScript, so say both, and add the CORS hint when the URL is cross-origin;
- a truncated download;
- a file that isn't a known GRP (with the size and CRC32 found);
- a quota failure (§3, not fatal);
- IndexedDB unavailable, e.g. a private window where it fails: the game still starts, uncached, with a notice.

The game must never be started on a bad file. The "Failed to load PALETTE.DAT!" message the engine gives for a missing GRP (`bugs.md` L5) must not be what a person sees.

### 7. Server-side documentation

`doco/browser/data-hosting.md`:
- what to serve: the extracted `swshare.grp`. `scripts/fetch-test-data.sh` produces a verified copy. The public mirror's zip-inside-a-zip isn't usable directly, and the mirror sends no CORS headers;
- the MIME type (`application/octet-stream`);
- compression: gzip or Brotli on the fly, or pre-compressed, and its effect on progress (§2). Measure how much gzip saves on `swshare.grp`;
- cache headers (long `max-age` plus an ETag, or a versioned URL);
- CORS headers when the data is on another origin;
- example Apache configuration (`mod_deflate`, `mod_headers`), with placeholder host names and paths only (`game.example.org`, `/srv/http/games/sw`).
- Brief 06 builds on this, so keep it focused on the data file.

## Out of scope

- A native downloader (D8). Offering registered data for download (D11). Unpacking zips in the browser (document serving the extracted GRP instead). The add-on GRPs (later).
- Any change to the game's simulation.

## Tests

Playwright with local HTTP servers (Chromium and Playwright are preinstalled; never run `playwright install`; `--trace off` for any test runner). Use brief 02's `tests/web/` helpers. Each test uses a fresh browser profile unless it tests the cache.

1. **First load:** the GRP is downloaded, progress events are seen (more than one, increasing), the game reaches the main menu (02's non-blank canvas check), and the file is in the cache.
2. **Cached second load:** reload; **no request for the GRP** reaches the server (count requests at the server, not only in the page), the game reaches the menu, and the game's output has no `Checksumming` line.
3. **Corrupt file** (one byte flipped) and **truncated file**: a clear error, the game doesn't start, and nothing is cached. Afterwards the correct file loads normally.
4. **Unknown file** (a GRP-sized file of random bytes, and a small text file): a clear error with the size and CRC32.
5. **HTTP 404** and **a cross-origin server without CORS headers** (a second local server on another port): a clear error with the CORS hint for the second.
6. **Compressed response** (`Content-Encoding: gzip` from the test server): the download works and the progress display is sensible.
7. **File picker:** with no data URL reachable, pick `testdata/swshare.grp` (`setInputFiles`); the game starts; reload, and it starts from the cache without picking again.
8. **Quota and no IndexedDB:** simulate both through a `?test=1` hook; the game still starts, with the notice. Say how the simulation works, and why it is close enough to the real failure.
9. **Config change:** change the configured URL (or declared size); the next load downloads again and removes the old entry.
- The table check (§2) as a quick test that `grpscan.c` and the page agree.
- **Prove the important tests can fail:** for 2, a build that ignores the cache; for 3, a loader without the CRC check; for 7, a loader that doesn't cache picked files. Show each fails, then revert.
- Brief 02's smoke, persistence and determinism tests still pass with the new loader.

## Acceptance criteria

1. Tests 1 to 9 pass, and brief 02's web tests still pass.
2. The second load starts with no download and no re-checksum.
3. Every error case gives a clear message and never starts the game on a bad file.
4. `data-hosting.md` lets a person host the data correctly.
5. The play-test steps in the Outcome let a person try first load, reload, a bad URL and the file picker in Chrome and Firefox.

## Dependencies

02 (merged into `claude`).

## Notes

- **Git:** `browser/03-data-download` in jfsw-browser, from `claude`. This brief should need no engine change. If it needs one (in jfbuild, under `__EMSCRIPTEN__`), use a same-named branch in the fork, per "Working across repos". Push after each commit. Never merge, never touch `claude` or `master`, never open a PR, never force-push.
- Keep the page code plain (no framework, no bundler), like 02's.
- Dev knobs and test hooks only with `?test=1`.

## Outcome

_Not started._
