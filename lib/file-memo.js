// lib/file-memo.js — read a derived JSON file once, but NOTICE when it changes.
//
// THE DEFECT CLASS THIS EXISTS TO CLOSE (found by cross-account validation,
// 2026-08-28, and it was the third instance):
//
//   let TABLE = null;
//   function table() { if (TABLE) return TABLE; TABLE = readAndParse(); return TABLE; }
//
// In a script that runs for two seconds this is free. In a SERVER it is a
// permanent decision made by whatever the file happened to be at the moment of
// the first call — including "absent". The live consequence, measured: the MCP
// server started 84 minutes before `lib/absence-floors.json` was written,
// cached `{corpora:{}}`, and spent the rest of its life judging every library
// corpus by the CURATED absence floor. Library questions whose answer was in
// the corpus came back refused, with the answer sitting in `bestWeak` under a
// note telling the caller not to trust it. No suite could see it, because
// every `npm test` is a fresh process that reads the file correctly.
//
// So: memoize on the file's IDENTITY (mtime + size), never on "have I read
// anything yet". Same pattern lib/probe-surface.js and lib/key-facts.js
// already use for their sidecars — this makes it the one implementation
// instead of the fourth hand-rolled copy.

import { readFileSync, statSync, existsSync } from 'node:fs';

/**
 * @param resolvePath  () => string|null   where the file lives (evaluated per call,
 *                                         so env-driven paths are honoured)
 * @param parse        (text) => value     parse+shape the contents
 * @param onAbsent     () => value         value to use when there is no file
 * @returns () => value                    cached until the file changes
 */
export function jsonFileMemo(resolvePath, parse, onAbsent) {
  let cache = null;   // { key, value }
  const read = () => {
    const path = resolvePath();
    if (!path || !existsSync(path)) {
      // ABSENT IS A STATE, NOT A RESULT. Keyed like any other so that the file
      // appearing later is picked up — the exact half D1 got wrong.
      if (cache && cache.key === 'absent') return cache.value;
      const value = onAbsent();
      cache = { key: 'absent', value };
      return value;
    }
    let key;
    try { const st = statSync(path); key = `${st.mtimeMs}:${st.size}`; }
    catch (_) { key = 'unstattable'; }
    if (cache && cache.key === key) return cache.value;
    let value;
    try { value = parse(readFileSync(path, 'utf8')); }
    catch (_) { value = onAbsent(); }
    cache = { key, value };
    return value;
  };
  read.forget = () => { cache = null; };   // for tests, and for an explicit reload
  return read;
}
