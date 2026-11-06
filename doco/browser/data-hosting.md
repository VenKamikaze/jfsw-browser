# Hosting the game data

The browser build does not contain the game. The page (`web/data.js`) downloads one file, the Shadow Warrior shareware data, from a URL you choose, checks it, and keeps it in the visitor's browser. This page says what to put on the server. Brief 06 (deployment) builds on it.

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

`scripts/build-wasm.sh` copies `web/config.js` into `build-wasm/` each time it runs, so edit the copy you deploy, or keep your own `config.js` and copy it after the build.

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

So gzip saves about **55 %** of the transfer (14.5 MB of 26 MB); Brotli a little more. Either on the fly or pre-compressed works (pre-compress for Brotli above quality 5 and serve the `.br` or `.gz` with `Content-Encoding`).

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

and, if you set `revalidate: true`, also `Access-Control-Allow-Headers: If-None-Match, If-Modified-Since` (and answer the `OPTIONS` preflight those headers cause) and `Access-Control-Expose-Headers: ETag, Last-Modified` so the page can read the validators. Without `revalidate` no preflight happens.

A browser reports a blocked cross-origin request exactly like a network failure, so the page's error message says both and, when the URL is cross-origin, adds the CORS hint.

## Example: Apache

Placeholders only (`game.example.org`, `/srv/http/games/sw`):

```apache
<VirtualHost *:443>
    ServerName game.example.org
    DocumentRoot /srv/http/games/sw          # index.html, config.js, jfsw.js, sw.js, sw.wasm, ... and swshare.grp

    <Directory /srv/http/games/sw>
        Require all granted

        # The GRP and the WebAssembly compress well.
        AddType application/octet-stream .grp
        AddType application/wasm .wasm
        AddOutputFilterByType DEFLATE application/octet-stream application/wasm text/html text/css text/javascript application/javascript

        # Cache: the page keeps its own copy of the GRP, so this matters for everything else and for other clients.
        <FilesMatch "\.(grp|wasm)$">
            Header set Cache-Control "public, max-age=86400"
        </FilesMatch>
        # Pages and scripts: always ask (they change with each deployment).
        <FilesMatch "\.(html|js|css)$">
            Header set Cache-Control "no-cache"
        </FilesMatch>
    </Directory>

    # Only when the GRP is served from a different host than the page, e.g. data.example.org:
    #   <Files "swshare.grp">
    #       Header set Access-Control-Allow-Origin "https://game.example.org"
    #       Header set Access-Control-Expose-Headers "ETag, Last-Modified"
    #   </Files>
</VirtualHost>
```

Needs `mod_deflate`, `mod_headers` and `mod_mime` (`a2enmod`, or `LoadModule` lines on Arch). For pre-compressed files, put `swshare.grp.gz` next to the GRP and use `mod_rewrite` or `MultiViews` with `AddEncoding gzip .gz`; on-the-fly gzip is simpler and the 0.7 s it costs per request is the price of one large file.

## Checking it

`curl -sI -H 'Accept-Encoding: gzip' https://game.example.org/swshare.grp` should show `200`, `Content-Type: application/octet-stream`, `Content-Encoding: gzip` and an `ETag`. To check the file you uploaded, download it with `curl -s --compressed -o check.grp https://game.example.org/swshare.grp` and run `python3 -c "import zlib,sys;print(hex(zlib.crc32(open(sys.argv[1],'rb').read())))" check.grp`: it must print `0x8a7fa1f`, and the file must be 26,056,769 bytes.
