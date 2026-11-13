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
// relay: the vnet relay for network games, as its WebSocket URL ('wss://relay.example.org/vnet',
//        or 'ws://127.0.0.1:PORT/vnet' for a local one). Empty (the default): none configured,
//        and the page says so when someone tries to host or join.
//        It is used by ?host=N and ?join=CODE in the page address, by the lobby's invite links
//        (?join=CODE on this page), and by the game's console (host, join) and menus (Host Online,
//        Join Online), which reload the page with those parameters. The page builds the game's
//        `-net -relay URL -host-room N | -room CODE` from it. It is taken only from this file,
//        never from the address (a crafted link must not send visitors through another relay).
//        WebTransport is tried first and derived from a wss:// URL; a ws:// URL uses WebSocket only.
//        The relay's -origins must name this page's host:port exactly (doco/browser/building.md).
//
// testMode: false (the default, and what a public site must keep). true lets a page address with ?test=1
//        use the test hooks and test-only parameters (?args=, ?files=, ?persist=, the relay knobs, ...;
//        see the top of jfsw.js). The browser tests serve a config.js with testMode: true. It is a setting
//        and not a link parameter so that a crafted link cannot give a visitor's game test arguments, which
//        can name another relay or change how it runs (brief 05 review). Deployment (brief 06): leave false.
window.JFSW_CONFIG = {
  testMode: false,
  relay: '',
  data: {
    url: 'swshare.grp',
    size: 26056769,
    crc32: '08a7fa1f',
    revalidate: false
  }
};
