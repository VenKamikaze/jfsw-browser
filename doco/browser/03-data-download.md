# 03: Game data download from a URL

## Goal

The browser build gets its game data the way decision D8 describes. The page downloads the GRP before the game starts, shows progress, and caches it in IndexedDB, so a reload starts at once with no download and no re-checksum. A file picker covers people with their own copy. Every failure has a clear message. The server side is documented.

## Read first

- [`README.md`](README.md): D8, D11 (only the shareware GRP is offered for download by default), Q2 (the data source, and that it has **no CORS headers** and is a zip inside a zip).
- [`code-facts.md`](code-facts.md): §6 (the search path, `grpfiles.cache`, portable mode) and what brief 02 added (§13).
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

- The game re-checksums the GRP on every start today, because `/data/sw.grp` is written with a new mtime each time and `grpfiles.cache` is keyed by name, size and mtime (code-facts §6 and §13).
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

Status: **review** (branch `browser/03-data-download` in jfsw-browser; no engine change, so jfbuild, jfaudiolib and jfmact are untouched). Not tested: Firefox (not installed here), a real GPU or network, a person.

**What landed**

- `web/data.js` (new): CRC-32, download with progress and checks, the IndexedDB cache, the picked file. `web/grptable.js` (new): the table of known GRPs, a copy of `grpfiles[]` in `src/grpscan.c`. `web/config.js` (new): the one place a host edits (`url`, declared `size` and `crc32`, `revalidate`). `web/index.html`, `web/jfsw.js`, `web/jfsw.css`: progress, the data line ("Game data: Shareware Version, downloaded ... from ..., kept in this browser"), "Use your own copy of the game data...", "Download again", "Use the download instead", "Try again", the error text. `Makefile.emscripten` copies the three new files into `build-wasm/`.
- `doco/browser/data-hosting.md` (new): what to serve, MIME type, compression (measured), cache headers, CORS, Apache example. `building.md` and `code-facts.md` (new section 14) updated.
- Tests: `tests/web/data.js` (172 checks after the fix round, tests 1 to 9 of the brief plus revalidation and "Download again"), `tests/web/grptable.js` (8 checks, no browser), `tests/web/dataserver.js` (the test server: gzip, ETag, CORS, errors, dropped connections; records every request).

**How it works**

1. `jfsw.js` mounts `/persist` as before, then calls `JfswData.load()`. The URL is `?data=` or `config.js`'s `url`; the declared `size` and `crc32` apply only to the configured URL.
2. Cache lookup. A record is used with **no network request** when: its key is the same absolute URL, its config signature (schema, declared size, declared crc32) is the same as now, its stored bytes are as long as `size`, and its CRC32 and size are in the table as a game that can start (shareware or registered; the add-ons are refused for now). **Nothing is recomputed on a hit**: the CRC32 was checked when the record was stored.
3. Otherwise it downloads (`fetch` with `cache: 'no-store'`), computing the CRC32 chunk by chunk, then checks, in this order: HTTP status; truncation (the connection dropped, or fewer bytes than the declared size or a trustworthy `Content-Length`); too many bytes (aborted as soon as the declared size is passed); the declared `crc32`; the table (known; same size as a known GRP but another CRC32: "damaged"; starts with `KenSilverman` but shorter than a known GRP: "looks cut off"; anything else: "not a data file the game knows", with size and CRC32; an add-on: refused). Only a file that passes is stored and handed to the game.
4. A failed check ends in the state `needdata`: the message on the page names the URL (or the file), the problem and the numbers; "Try again" and the picker are offered; no `sw.grp` is written and `main` is never called, so the engine's "Failed to load PALETTE.DAT!" cannot be what a person sees.
5. **When the cache is revalidated or replaced:** (a) the configured URL, declared size or declared crc32 differs from what the record was stored under: downloaded again; (b) "Download again": downloaded again; (c) **opt-in** `revalidate: true` in `config.js` (or `?test=1&revalidate=1`): a conditional request (`If-None-Match` from the stored ETag, `If-Modified-Since` from `Last-Modified`); `304` keeps the copy, `200` replaces it, a network failure keeps it with a notice. Default: never, so a reload makes no request. Records for other URLs are deleted on every load. The picked file lives under its own key (`local`) and a `source` setting says which is in use; "Use the download instead" deletes the picked copy and switches back.
6. The file is written to `/data/sw.grp` and given a modification time equal to the record's stored time (`FS.utime`), so the game's own `grpfiles.cache` (in `/persist`) hits and the game does not print `Checksumming` on the second start.
7. `navigator.storage.persist()` is asked after the first successful store. Chrome decides by itself, silently (it grants for sites that are installed, bookmarked or visited often and refuses a new profile; headless Chromium here answered `false`); Firefox shows the person a permission prompt. I could only observe the Chromium answer. Without it the browser may evict the cached file under storage pressure; the page then just downloads it again.
8. **Quota / no IndexedDB:** a failed store (`QuotaExceededError` from `put()` or from the transaction) does not stop the game: the page says "The browser has no space left to keep the game data. The game will start, but the data will be downloaded again next time." If IndexedDB cannot be opened, "This browser would not let the page keep the game data (...), so it is downloaded each time." (and the existing note that saves and settings will not be kept).

**Numbers**

- **CRC32 time:** 95 to 116 ms for the 26,056,769 bytes in headless Chromium (slice-by-4, computed chunk by chunk as the download arrives, so it overlaps the network); 33 ms in Node. Done on the main thread; a worker was not worth it.
- **gzip on `swshare.grp`:** 26,056,769 bytes become 11,565,085 at level 6 (44.4 %, saves 55.6 %), 12,283,846 at level 1, 11,522,170 at level 9; Brotli quality 5 gives 10,956,970 (42.1 %). Full table in `data-hosting.md`.
- **Real-quota check:** `Storage.overrideQuotaForOrigin` through the DevTools protocol (1 MB) made Chromium itself refuse the store; the notice appeared and the game started. The `?test=1&idb=quota` hook throws the same `QuotaExceededError` inside the same `put()`.

**Test hooks (only with `?test=1`)**: `idb=quota` (the cache's `put()` throws a `QuotaExceededError` `DOMException`; the real one from the browser takes the same path, and the real-quota run above confirms it), `idb=off` (every `indexedDB.open` fails with an `InvalidStateError` error event, which is what an old Firefox private window did; it hits the game's IDBFS and the data cache alike), `revalidate=1|0`, `window.jfswDownloadLog` (every progress report), `window.jfswData`, `window.jfswDataError`.

**Tests** (Chromium; run in this order on the final tree)

- `node tests/web/grptable.js`: **8 passed, 0 failed** (the table in `web/grptable.js` equals the one parsed out of `src/grpscan.c`, and the comparison notices a changed CRC32, a changed size and a missing row; `config.js` declares a table entry; the page's CRC-32 equals the standard check value and zlib's for inputs of 0 to 65,537 bytes and the real GRP).
- `node tests/web/data.js`: **150 passed, 0 failed** (about 2 minutes). Sections: 1 first load (progress reported 15 to 700 times, strictly increasing, ends at the whole file; one request at the server; record in IndexedDB with size and CRC32; the game reaches the main menu); 2 cached second load (no request reaches the server, the page says the data is from the browser, the menu is reached, no `Checksumming`); 3 corrupt (one bit flipped), truncated (short file; connection dropped half way; short file with nothing declared), each: clear message, game not started, nothing handed to the game, nothing cached, and the right file loads afterwards; 4 unknown (random bytes of the right size and of another size, a text file, with and without a declared size): size and CRC32 in the message; 5 HTTP 404 and 500, a cross-origin server without CORS (the CORS hint appears; the same file loads when the server sends the header), nothing listening; 6 gzip (on the fly and pre-compressed with a compressed `Content-Length`), with a declared size (the percentage is of the declared size, ends at exactly 100, never past it) and without (no total claimed, indeterminate bar, megabytes only); 7 file picker (bad file refused, good file accepted and cached under its own key, reload starts without picking and with no request for any data URL, no `Checksumming`, switching back to the download); 8 quota (hook, and Chromium's real quota set to 1 MB over the DevTools protocol) and no IndexedDB; 9 config changes (new URL: downloaded again and the old record deleted; changed declared size: downloaded again and refused because the file no longer matches); 10 "Download again", `ETag` kept, no revalidation by default, opt-in revalidation (`If-None-Match`, 304, a changed ETag replaces the file); 11 the plain page has no test hooks.
- Brief 02's tests on the same tree (wasm rebuilt, native `./sw` rebuilt with `make veryclean && make -j4`): `smoke.js` **26 passed, 0 failed**; `persist.js` **15 passed, 0 failed**; `determinism.js` **20 passed, 1 failed**: the failure is the unchanged "no stall over 100 ms" check (this run: median 16.8 ms, p95 37, p99 77, max 187 ms, load 3.0 on 4 cores; software-rendered headless Chromium, needs real hardware as reported in brief 02). Native and wasm `.dms` files are still identical, both directions.

**Proof the tests can fail** (nothing in the repository changes; the damaged copy of the page code is served by the test server). `DATA_SABOTAGE=<name>` on the otherwise unchanged tests (150 checks):

| Sabotage | What is damaged | Result |
|---|---|---|
| `nocache` (test 2) | the cache lookup always misses | 142 passed, **8 failed**: "second load: NO request for the GRP reached the server" (the server saw the request), "the page says the data comes from the browser", "the game did NOT checksum the GRP again", and the same idea in the unchanged-config, ETag, "Download again" and revalidation checks |
| `nocrc` (test 3) | no CRC32 check: `verify()` accepts anything, and the table lookup knows every file | 121 passed, **29 failed**: corrupt, random and text files are accepted, handed to the game and cached |
| `nosize` (test 3, 5) | no size checks while downloading (truncation, too many bytes) | 147 passed, **3 failed**: "truncated (short file)", "text file (default config)" and "config change (declared size)" (without the size check, the table check still refuses these, but with a different message); the other truncation cases are caught by the table and by the dropped connection |
| `nocheck` (test 3) | both of the above | 111 passed, **39 failed**: the corrupt, truncated, random, text and picker-bad-file checks (the size and the CRC32 are the only defences) |
| `nopickcache` (test 7) | the picked file is not stored | **4 failed**, then the run stops (it cannot go on without the file): "the picked file is cached under its own key", "reload starts from the cached local copy without picking again", "no request for the GRP reached the server", "the page offers Click to start" |
| `nomtime` (§4) | no `FS.utime`: the file gets a new modification time on every load | **2 failed**: "second load: the game did NOT checksum the GRP again" (`Checksumming sw.grp` printed) and "picker, reload: the game did not checksum it again" |

(Counts are from the runs on the final tree; the sabotaged copy of `data.js` or `jfsw.js` is built in memory and served by the test server only.)

**Findings and corrections**

- The brief said to compute the CRC32 "off the main thread if it's slow enough to matter". It is not (about 100 ms, overlapped with the download), so it is on the main thread.
- The brief's test 4 (a GRP-sized file of random bytes) gets the message "the size of Shareware Version but its checksum is wrong ... damaged" rather than "not a data file", because the size is a known one; a random file of another size gets "not a data file the game knows". Both show size and CRC32, and both are tested.
- The declared size of the default config is enough to catch a truncated or wrong file before the table is consulted, so test 5's cross-origin and test 3's cases cover two checks each; the table check is exercised with `?data=` (which ignores the declared size).
- `code-facts.md` section 13 said brief 03 "can keep the mtime stable or ship the cache entry": the mtime is what was done (section 14 has the details); no engine change.
- The `Checksumming` line still appears once on the very first start, and again the first time a different GRP is used (the cache keeps one entry per name).
- `tests/web/data.js` takes about 2 minutes; the sabotage runs are the same script.

**Concerns**

- Firefox and a real network were not tried. Firefox-specific: storing a 26 MB `ArrayBuffer` in IndexedDB (fine in Chromium, needs checking), the persistent-storage prompt, `FS.utime`, the file picker's `accept=".grp"`, and what a private window does (older Firefox fails `indexedDB.open`; newer versions use memory-only storage with a small quota: both end in the same notices).
- A 26 MB file in IndexedDB costs the visitor 26 MB of disk; the page does not offer to delete it other than "Download again" (which replaces it) and the browser's own site-data controls.
- The whole file is held in memory a few times during a download (the destination buffer, the structured clone for IndexedDB, the Emscripten file). Peak was not measured; a phone with 1 GB of RAM may struggle (touch is out of scope here).
- If a host sets `size` in `config.js` wrongly (say, after replacing the file), every visitor sees an error: that is intended, and the message says what the page expected.
- The first click on "Use your own copy..." opens the OS file dialog; `<input type=file>` cannot be opened without a user gesture, which is why it is a visible control and not automatic.

**Fix round**

1. *A stored copy is trusted again only after its CRC32 is recomputed* (`intact()` in `web/data.js`, about 50 to 100 ms, on every hit, for downloaded and picked records and for the 304 path). A mismatch deletes the record, adds a notice ("The copy kept in this browser was damaged and has been discarded; downloading it again"), and falls back to a fresh download (for a picked file: to the download, and the notice says to pick the file again). Tests (section 12 of `data.js`): damage 4 KB of the stored bytes in IndexedDB keeping the stored crc, reload: downloaded again, the file on `/data/sw.grp` has CRC32 `08A7FA1F`, a fresh record; same for the picked record with the data URL answering 404: not used, nothing handed to the game, record deleted.
2. *Stalled downloads.* A timer aborts the fetch after 30 s without a byte (also while waiting for the response); `?test=1&stall=<ms>` shortens it. The error says the download stalled (or the server did not answer), with retry and picker. The picker is now usable during a download and cancels it (`AbortController`, a generation number ignores the cancelled load's answer). Tests: a server that sends 1 MB then goes quiet (`stall=2000`): clear error in time, "Try again" and the picker enabled, retry works against a good server; picking a file during a stuck download uses the file.
3. *`data-hosting.md` Apache section rewritten and checked with a real Apache 2.4.58* (`apt-get install apache2` worked from the Ubuntu mirror; run on port 48301 with its own config in a temp dir, since removed): `apache2 -t` Syntax OK; fixed the `DocumentRoot` comment, added `mod_filter`, found that `DeflateAlterEtag` is not allowed in `<Directory>` (vhost or server config only). Measured: by default `mod_deflate` sends `ETag: "...-gzip"` and a conditional request with it gets **200** (re-download every load with `revalidate: true`); with `DeflateAlterETag NoChange` the conditional request gets **304**, for gzip and for plain. The data-host CORS block uses `<Location>` (with `<Files>` the rewrite answers the preflight before the file is mapped and no CORS headers are sent) plus a `RewriteRule` answering `OPTIONS` with 204; both verified with `curl` (Allow-Origin, Allow-Headers, Expose-Headers on `OPTIONS` and `GET`); gzip sent 11,621,419 bytes. It sits in a `data.example.org` vhost now. The page and the game were not run against Apache.
4. Nits: a `?data=` visit no longer deletes the configured URL's record (`keepUrls`); the quota and no-IndexedDB notices say "picked again" for a picked file; `finish()` hides the data buttons and "Try again"; the plain-page test now loads `?idb=off&idb=quota&revalidate=1&stall=1&persist=0&args=...` without `?test=1` and checks the knobs do nothing (ready, no notices, cache used, a reload makes no request); the Outcome's garbled proof section is fixed. Test 9 now changes the URL through a served `config.js` (a `?data=` visit no longer purges).

*Tests after the fix round:* `data.js` **172 passed, 0 failed**; `grptable.js` 8/0; `persist.js` 15/0; `smoke.js` 26/0 on 3 of 4 runs (one run gave 25/1; I did not catch which check, the repeats were clean; nothing in the game path changed). `determinism.js` was not re-run (page code only; the game, its start and the native comparison are unchanged from the 20/1 above).
*New sabotage:* `trusthit` (`intact()` always true): 166 passed, **6 failed** (the damaged stored and picked copies are used; the picked one reaches the game). `nostall` (no stall timer): 164 passed, **2 failed** (the page stays at "1.0 MB of 24.8 MB (4%)", no error, no retry).

**Play-test steps (Arch Linux, pacman)**

```
sudo pacman -S --needed base-devel git unzip python nodejs npm
git clone --recurse-submodules -b claude https://github.com/VenKamikaze/jfsw-browser    # after this branch is merged; until then: -b browser/03-data-download
cd jfsw-browser
scripts/setup-emsdk.sh && scripts/build-wasm.sh && scripts/fetch-test-data.sh
mkdir -p /tmp/swsite && cp build-wasm/* /tmp/swsite/ && cp testdata/swshare.grp /tmp/swsite/
cd /tmp/swsite && python3 -m http.server 8000 --bind 127.0.0.1
```

Use Chromium (or Chrome) and Firefox in turn; for each, a fresh profile or a private window for step 1 (in Chrome DevTools, Application, Storage, "Clear site data" resets the page between steps; in Firefox, Settings, Privacy, Manage Data).

1. **First load.** Open `http://127.0.0.1:8000/`. You should see "Downloading the game data: x MB of 24.9 MB (n%)" with a bar moving to 100 %, then "Ready." and the line "Game data: Shareware Version, downloaded just now from 127.0.0.1:8000/swshare.grp (24.9 MB). It is kept in this browser." (Firefox may show a permission prompt about storing data persistently: allow it, then decline it in a second run, and say which you did.) Click "Click to start", get to the main menu.
2. **Reload.** Press F5. The page should be ready within a second with no bar, and the line should say "downloaded <date> ... kept in this browser". In the terminal running `http.server` no new `GET /swshare.grp` line may appear. Start the game: it should reach the menu faster than the first time (no 26 MB checksum; DevTools console shows `Scanning for GRP files...` without `Checksumming`).
3. **Download again.** On the start screen press "Download again": the bar runs again and `http.server` logs one more `GET /swshare.grp`.
4. **A bad URL.** Open `http://127.0.0.1:8000/?data=/nothere.grp`: the page says the URL answered 404, that the game has not been started, and offers "Try again" and "Use your own copy...". Then `?data=http://127.0.0.1:8001/swshare.grp` (nothing listening, or start a second `python3 -m http.server 8001 --bind 127.0.0.1` in another directory holding the GRP: it sends no CORS headers): the message must mention Access-Control-Allow-Origin and the network failure. Also try a cut-off or damaged file: `head -c 10000000 swshare.grp > /tmp/swsite/short.grp` and open `?data=/short.grp` ("looks cut off ... 10,000,000 bytes"); `cp swshare.grp bad.grp; printf 'X' | dd of=bad.grp bs=1 seek=1000000 conv=notrunc` then `?data=/bad.grp` ("damaged"). Nothing may be remembered after these (DevTools, Application, IndexedDB, `jfsw-data` shows no new row).
5. **File picker.** Open `http://127.0.0.1:8000/?data=/nothere.grp`, click "Use your own copy of the game data...", choose `testdata/swshare.grp` (a registered `sw.grp`, if you own it, also works). The page should say "your own copy"; click start and play. Reload that URL: it starts again with no picking and no request. Press "Use the download instead" (with `?data=` removed from the address, or with the real GRP on the server) to go back.
6. **Things only a person can see:** the layout on a narrow window; whether the picker button is usable by keyboard (Tab, Enter); the wording of each message; in Chrome, whether the Application tab shows Storage "Persistent: no"/"yes"; in a private window (Firefox) that the game still starts and the notice about the data being downloaded each time shows; with the DevTools network panel throttled to Slow 3G, that the bar and the megabytes move smoothly. In Chrome, DevTools, Application, Storage, set a small storage limit ("Simulate custom storage quota") and reload to see the quota notice for real.

Report anything that differs. To run the tests on your own machine: `npm i playwright && npx playwright install chromium`, then `node tests/web/data.js` (about 2 minutes) and `node tests/web/grptable.js`.

### Coordinator verification and merge

- Re-ran on `9617582` after a wasm rebuild: `grptable.js` 8/0, `data.js` 172/0, `persist.js` 15/0, `determinism.js` 20/1 (native and wasm `.dms` identical; the only failure is the known "no stall over 100 ms" check: median 16.8 ms, p99 98.4, max 392 ms, load 3.8; it needs real hardware, see 02).
- `smoke.js` ran five times: 26/0 twice, 25/1 three times (twice "a release asked for by the game does not open the menu", once "Down moves the menu cursor"). The same check fails at the same rate **on `claude` without this brief** (five runs: 26/0 twice, 25/1 three times, always "a release asked for by the game does not open the menu", always 54292 pixels), so it came from brief 02's fix round, not from 03. It is recorded in `PROMPT.md` §0 as the first thing for the next session: the repeatable pixel count suggests a real race in the page's Escape synthesis (`web/jfsw.js`, the `pointerlockchange` handler and the `exitPointerLock` wrapper), where a release the game asked for is sometimes taken for the player's Escape and opens the menu. That would be a bug a player sees, so it must be fixed, not the test loosened.
- Reviewed by an independent read-only reviewer (verdict: merge after fixes; three should-fix items and five nits, all addressed in the fix round; the Apache example was then checked on a real Apache 2.4.58). Merged into `claude` with `--no-ff`. Status: **done (play-test pending)**.
