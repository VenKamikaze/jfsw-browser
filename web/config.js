// Where the page gets the game data (brief 03). A person hosting the game edits this file.
// Read doco/browser/data-hosting.md before changing it.
//
//   url         The GRP to download: relative to the page, or a full URL. A full URL on another
//               origin needs CORS headers (Access-Control-Allow-Origin) on the server.
//               Only the shareware GRP may be offered for public download by default.
//   size        Expected size in bytes (0 = not declared). With it the progress bar is right even
//               when the server compresses the response, and a truncated or wrong file is
//               refused before anything else is looked at.
//   crc32       Expected CRC-32 as 8 hex digits ('' = not declared). The page always checks the
//               file against the table of GRPs the game knows (grptable.js) as well.
//   revalidate  false (default): once the file is stored in the browser, a reload makes no request
//               for it. true: each load asks the server "has it changed?" (If-None-Match /
//               If-Modified-Since); a 304 answer costs a few hundred bytes. The server must send
//               an ETag or Last-Modified, and on another origin must allow those request headers.
//
// Changing url, size or crc32 makes every browser download the file again on its next visit
// and forget the copy it had of the old url.
//
// ?data=<url> in the page address overrides url (and size and crc32 are then not checked).
//
// relay: the vnet relay for network games, as its WebSocket URL ('wss://host/vnet', or
//        'ws://127.0.0.1:PORT/vnet' for a local one). Empty (the default): none configured.
//        The game takes it as `-net -relay URL -host-room N | -room CODE`; the pages that
//        start a network game from the menus are brief 05, this field is what they will use.
//        WebTransport is tried first and derived from a wss:// URL; a ws:// URL uses WebSocket only.
window.JFSW_CONFIG = {
  relay: '',
  data: {
    url: 'swshare.grp',
    size: 26056769,
    crc32: '08a7fa1f',
    revalidate: false
  }
};
