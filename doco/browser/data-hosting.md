# Hosting the game data

The browser build does not contain the game. The page (`web/data.js`) downloads one file, the Shadow Warrior shareware data, from a URL you choose, checks it, and keeps it in the visitor's browser. This page says what to put on the server. The whole deployment (the page, Apache with TLS, the relay, desktop players) is in [`deploy.md`](deploy.md), which includes these settings.

Only the **shareware** GRP may be offered for public download by default (decision D11). Someone who owns the registered game can pick their own `sw.grp` in the page; it stays on their machine.

## What to serve

One file: the extracted shareware GRP, **26,056,769 bytes, CRC-32 `08A7FA1F`**, named anything you like (`swshare.grp` below).

`scripts/fetch-test-data.sh` produces a verified copy as `testdata/swshare.grp`. It downloads the official 3D Realms archive `3dsw12.zip`, takes `SWSW12.SHR` out of it and `sw.grp` out of that (a zip inside a zip), and checks the size and CRC-32. Copy that file to your server. Do not serve the zips: the page does not unpack them, and the public mirror (`image.dosgamesarchive.com`) sends no CORS headers, so a page on another origin cannot read it anyway.

The page accepts any file whose size and CRC-32 are in the table of `src/grpscan.c` (copied in `web/grptable.js`; `tests/web/grptable.js` keeps them equal). The registered, Mac and add-on GRPs are in that table; the add-ons are refused for now.

## Telling the page where it is: `config.js`

`config.js` sits next to `index.html`:

```js
window.JFSW_CONFIG = { data: { url: 'swshare.grp', size: 26056769, crc32: '08a7fa1f', revalidate: false } };
```

- `url`: relative to the page, or a full URL. The default is the page's own origin, which needs no CORS.
- `size`, `crc32`: what the file must be. Keep them: the progress bar needs `size` when the response is compressed, and a wrong or cut-off file is refused before anything is checked further. Use `0` and `''` to declare nothing.
- `revalidate`: see "Caching" below.

`?data=<url>` on the page address overrides `url` (the declared `size` and `crc32` are then ignored; the file must still be a known GRP).

**Players with different data** (`?data=`, "Use your own copy...", or another site's page) can still join one network game, but it will probably go out of sync: shareware and registered data differ in the maps, the items and even the number of deathmatch start spots the game picks from. Since brief 05b every player is told at each level start, on the game's screen and in a notice on the page ("Player 2 has different game data (Registered Version) from yours (Shareware Version): the game will probably go out of sync."); the game is not refused. Give every player the same file (the invite link keeps `?data=` for that).

The same file has two more fields (brief 05): `relay`, the vnet relay's WebSocket URL for network games (empty: none; see `building.md` §6.6), and `testMode`, which **must stay `false` on a public site**: with `true`, a link with `?test=1` could pass the game test arguments, among them another relay.

`scripts/build-wasm.sh` copies `web/config.js` into `build-wasm/` whenever `web/config.js` is newer than that copy (after a `git pull` that changes it, for example), so an edit in `build-wasm/` can be lost. Keep your own `config.js` outside the build and deploy that one ([`deploy.md`](deploy.md) §2).

**Changing `url`, `size` or `crc32` makes every visitor download the file again on their next visit**, and the browser forgets its copy from the old URL.

## MIME type

`application/octet-stream`. The page reads the bytes with `fetch`, so the type is not checked, but this avoids a server guessing `text/plain` and compressing or rewriting it.

## Compression

The GRP compresses well. Measured on `swshare.grp` (26,056,769 bytes):

| | bytes | of the original | time to compress |
|---|---|---|---|
| gzip -1 | 12,283,846 | 47.1 % | 0.3 s |
| gzip -6 (Apache's `mod_deflate` default) | 11,565,085 | 44.4 % | 0.7 s |
| gzip -9 | 11,522,170 | 44.2 % | 2.5 s |
| Brotli, quality 5 | 10,956,970 | 42.1 % | 1.2 s |
| Brotli, quality 9 | 10,835,397 | 41.6 % | 12 s |

So gzip saves about **55 %** of the transfer (14.5 MB of 26 MB); Brotli a little more. Either on the fly or pre-compressed works (pre-compress for Brotli above quality 5 and serve the `.br` or `.gz` with `Content-Encoding`). **If you turn on `revalidate`, check how your server treats the ETag of a compressed answer** (see the Apache example: by default `mod_deflate` changes it and every load downloads the file again).

What this does to the page's progress display: with `Content-Encoding`, `Content-Length` (if present) is the compressed size, while the browser hands the page the decompressed bytes. The page therefore takes the total from the declared `size` in `config.js`. If no size is declared and the response is encoded, it shows megabytes so far and an indeterminate bar rather than a wrong percentage. Both are tested (`tests/web/data.js`, test 6).

On a cross-origin server `Content-Encoding` is not readable by the page unless exposed; the page copes either way because it never needs it when `size` is declared.

## Caching

The page stores the file in the browser itself (IndexedDB, database `jfsw-data`), so the server's HTTP cache headers do not decide whether a returning visitor downloads again. The page asks `fetch` not to use the HTTP cache (`cache: 'no-store'`), so the browser does not keep a second 26 MB copy there. A returning visitor makes **no request for the file at all**, unless:

- `config.js`'s `url`, `size` or `crc32` changed, or
- the visitor presses "Download again", or
- `revalidate: true` is set in `config.js`. Then each load sends a conditional request (`If-None-Match` from the stored `ETag`, and `If-Modified-Since` from `Last-Modified`). A `304` answer costs a few hundred bytes and the stored copy is used; a `200` replaces it. If the server cannot be reached the stored copy is used.

If you do replace the file on the server and want visitors to get it, change the file's URL (e.g. `swshare-v2.grp`) and `config.js`, or turn `revalidate` on. For a file that never changes there is nothing to do.

Still send good cache headers: they matter to anyone who fetches the URL otherwise (a proxy, `curl`). A long `max-age` with an `ETag` is right: `Cache-Control: public, max-age=31536000, immutable` if the URL is versioned, else `max-age=86400` and an `ETag`. Always send `ETag` (Apache does for static files) if you enable `revalidate`.

## CORS

Needed only when `url` is on a different origin from the page (different scheme, host or port). The server must send:

```
Access-Control-Allow-Origin: https://game.example.org      (or *)
```

and, if you set `revalidate: true`, also `Access-Control-Allow-Headers: If-None-Match, If-Modified-Since` (and answer the `OPTIONS` preflight those headers cause with a 204 carrying the same headers) and `Access-Control-Expose-Headers: ETag, Last-Modified` so the page can read the validators. Without `revalidate` no preflight happens.

A browser reports a blocked cross-origin request exactly like a network failure, so the page's error message says both and, when the URL is cross-origin, adds the CORS hint.

## Example: Apache

Placeholders only (`game.example.org`, `data.example.org`, `/srv/http/games/sw`). Checked with Apache 2.4.58 (Ubuntu): `apache2 -t` says "Syntax OK" for the files below (with the `Listen`, `LoadModule` and `TypesConfig` lines a distribution supplies), and `curl` against it showed gzip (26,056,769 bytes sent as 11,621,419), an `ETag`, a `304` for a conditional request, and the CORS headers on both `GET` and the `OPTIONS` preflight. Other Apache versions were not tried. Brief 06 moved `.wasm` from the GRP's `max-age=86400` to `no-cache` (a redeploy must reach every browser on its next load) and checked the changed block again on the same Apache: `sw.wasm` and `sw.js` answer `no-cache`, the GRP `public, max-age=86400`, all gzip.

Modules: `mod_mime`, `mod_filter` (needed for `AddOutputFilterByType` in 2.4), `mod_deflate`, `mod_headers`, and `mod_rewrite` for the preflight (`a2enmod filter deflate headers rewrite`, or `LoadModule` lines on Arch).

```apache
<VirtualHost *:443>
    ServerName game.example.org
    DocumentRoot /srv/http/games/sw
    # index.html, config.js, jfsw.js, sw.js, sw.wasm, ... and swshare.grp

    # Important when config.js has revalidate: true. mod_deflate rewrites the ETag of a compressed
    # answer to "...-gzip" by default, which no longer matches the ETag the page stored, so Apache
    # answers 200 and sends all 26 MB again on every load. NoChange (2.4.58 and later; the directive
    # is allowed here and in the server config, not in <Directory>) keeps the ETag as it is. The
    # caveat: the compressed and the plain answer now share one ETag. On an older Apache, leave
    # revalidate off, or do not compress the GRP (remove application/octet-stream below), or serve a
    # pre-compressed swshare.grp.gz with "AddEncoding gzip .gz" and a rewrite to it.
    DeflateAlterETag NoChange

    <Directory /srv/http/games/sw>
        Require all granted
        AddType application/octet-stream .grp
        AddType application/wasm .wasm
        AddOutputFilterByType DEFLATE application/octet-stream application/wasm text/html text/css text/javascript application/javascript

        # The page keeps its own copy of the GRP, so this matters for other clients only.
        <FilesMatch "\.grp$">
            Header set Cache-Control "public, max-age=86400"
        </FilesMatch>
        # The page, its scripts and the wasm change with each deployment and must be of one build: always ask
        # (brief 06: a cached old sw.wasm next to a new sw.js does not start; deploy.md, "Builds must match").
        <FilesMatch "\.(html|js|css|wasm)$">
            Header set Cache-Control "no-cache"
        </FilesMatch>
    </Directory>
</VirtualHost>
```

**If the GRP is on another host** (set `url` in `config.js` to `https://data.example.org/swshare.grp`), give that host the same `AddType`, compression and `DeflateAlterETag` lines, and these CORS rules (the data host's vhost, not the game's):

```apache
<VirtualHost *:443>
    ServerName data.example.org
    DocumentRoot /srv/http/games/data

    <Location "/swshare.grp">
        Header always set Access-Control-Allow-Origin "https://game.example.org"
        Header always set Access-Control-Expose-Headers "ETag, Last-Modified"
        # Only needed with revalidate: true (the conditional headers make the browser send a preflight):
        Header always set Access-Control-Allow-Headers "If-None-Match, If-Modified-Since"
        Header always set Access-Control-Max-Age "86400"
    </Location>
    # Answer the preflight (OPTIONS) with 204 and the headers above. <Location>, not <Files>:
    # the rewrite answers before the file is mapped, and <Files> would not apply.
    RewriteEngine On
    RewriteCond %{REQUEST_METHOD} OPTIONS
    RewriteRule ^/swshare\.grp$ - [R=204,L]
</VirtualHost>
```

## Checking it

`curl -sI -H 'Accept-Encoding: gzip' https://game.example.org/swshare.grp` should show `200`, `Content-Type: application/octet-stream`, `Content-Encoding: gzip` and an `ETag`. To check the file you uploaded, download it with `curl -s --compressed -o check.grp https://game.example.org/swshare.grp` and run `python3 -c "import zlib,sys;print(hex(zlib.crc32(open(sys.argv[1],'rb').read())))" check.grp`: it must print `0x8a7fa1f`, and the file must be 26,056,769 bytes.
