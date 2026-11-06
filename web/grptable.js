// The GRP files the game knows: a copy of the grpfiles[] table in src/grpscan.c (name, CRC-32, size, kind).
// tests/web/grptable.js checks the two against each other, so they cannot drift apart.
//   game: REG, SHARE, WD, TD as in grpscan.c; addon: the entry needs a registered GRP too.
// The page starts the game only with REG and SHARE entries (the add-ons are for later).
window.JFSW_GRPS = [
  { name: 'Registered Version', crc: '7545319f', size: 47536148, game: 'REG', addon: false, file: 'sw.grp' },
  { name: 'Shareware Version', crc: '08a7fa1f', size: 26056769, game: 'SHARE', addon: false, file: 'swshare.grp' },
  { name: 'Mac Demo Version', crc: '4227f535', size: 26056769, game: 'SHARE', addon: false, file: 'swmacshare.grp' },
  { name: 'Mac Registered Version', crc: 'd54a99c9', size: 47536148, game: 'REG', addon: false, file: 'swmac.grp' },
  { name: 'Wanton Destruction (Addon)', crc: 'a9aaa7b7', size: 48698128, game: 'WD', addon: false, file: 'wt.grp' },
  { name: 'Twin Dragon (Addon, v1.2)', crc: 'a1a65be8', size: 12499012, game: 'TD', addon: true, file: 'tdragon12.grp' },
];
