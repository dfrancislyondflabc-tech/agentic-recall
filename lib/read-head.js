// lib/read-head.js — THE FIRST N CHARACTERS OF A FILE, WITHOUT READING THE FILE (MEM-113).
//
// 🟥 `readFileSync(p, 'utf8').slice(0, n)` reads the WHOLE file to keep its head. On a transcript
// that is not a rounding error: Claude Code transcripts on Daniel's Mac reach 1.2 GB, and
// lib/capturable.js did exactly this for every transcript touched in the last 7 days, on EVERY
// staging search (via lib/capture-status.js), again whenever one grew. Measured 2026-11-25 on the
// real machine, one search: footprint 1,410 -> 5,134 MB from that one call, and macOS never took the
// pages back (the server sat at 4.2 GB afterwards). The decision only ever looked at 64 KB.
//
// IDENTICAL OUTPUT. A UTF-8 character is at most 4 bytes, so the first n characters always lie in
// the first 4n bytes: decode those and slice to n characters, and the result is exactly what the
// whole-file read returned (a multi-byte character cut at the 4n-byte edge is past character n).
import { openSync, readSync, closeSync } from 'node:fs';

export function readHead(path, chars) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.max(0, chars) * 4);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8').slice(0, chars);
  } finally { closeSync(fd); }
}

// ── EVERY LINE OF A FILE, WITHOUT HOLDING THE FILE (MEM-114) ─────────────────────────────────────
//
// 🟥 scripts/ingest-transcript.js read each transcript whole, TWICE (the turn walk and the title), as one string. Two
// costs. MEMORY: the live 460 MB transcript of a long session cost the capture process about a gigabyte on every tick.
// LOSS: V8 cannot make a string longer than 536,870,888 characters, so a transcript past ~512 MB THREW on read — the two
// largest on Daniel's Mac (752 MB and 1.2 GB) have been stamped at ~535 MB since September and nothing after that point
// was ever captured. This yields exactly what `readFileSync(path, 'utf8').split('\n')` yielded — byte 0x0A never occurs
// inside a multi-byte UTF-8 character, so splitting bytes first and decoding each line is the same split — holding one
// chunk and one line at a time. Closing early (a `return` inside a for…of) closes the file.
export function* fileLines(path, chunkBytes = 8 * 1024 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let pos = 0;
    let carry = null;
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      let i;
      while ((i = data.indexOf(10, start)) !== -1) { yield data.toString('utf8', start, i); start = i + 1; }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : null;   // a copy: `buf` is reused
    }
    yield carry ? carry.toString('utf8') : '';
  } finally { closeSync(fd); }
}
