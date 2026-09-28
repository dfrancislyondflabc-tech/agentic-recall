// test/public/vanish-back-is-not-news.mjs — A "VANISHED" MEMORY THAT IS BACK IS NOT MISSING (MEM-100)
//
// Measured 2026-09-28: .vanish-report.jsonl recorded two exchanges gone at 2026-09-27T01:58 (rewritten while an index build ran);
// both were on disk and indexed again minutes later, yet every staging answer said captureHealth "degraded" for the next 7 days.
// lastVanish() now checks the row's names against the store: back → dropped; all back → not news; still missing → reported.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lastVanish } from '../../lib/ingest-health.js';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

export async function vanishBackIsNotNews({ check, group }) {
  group('a "vanished" memory that is back on disk is not reported as missing (MEM-100)');
  const dir = mkdtempSync(join(tmpdir(), 'recall-vanish-'));
  try {
    const store = join(dir, 'store'); mkdirSync(store, { recursive: true });
    const log = join(dir, 'vanish.jsonl');
    const at = new Date(Date.now() - 3600_000).toISOString();
    const row = (names, vanished = names.length) => writeFileSync(log, JSON.stringify({ at, index: 'x', vanished, names, previousDocs: 10, currentDocs: 8 }) + '\n');
    writeFileSync(join(store, 'x-aaaa-1.md'), 'a'); writeFileSync(join(store, 'x-aaaa-2.md'), 'b');

    row(['x-aaaa-1', 'x-aaaa-2']);
    check('both names back on disk → nothing to report (it said "degraded" for 7 days)', lastVanish({ log, store }) === null, JSON.stringify(lastVanish({ log, store })));

    row(['x-aaaa-1', 'x-bbbb-9']);
    const one = lastVanish({ log, store });
    check('one back, one still missing → only the missing one is reported', one && one.vanished === 1 && JSON.stringify(one.names) === '["x-bbbb-9"]' && one.backSince === 1, JSON.stringify(one));

    row(['x-aaaa-1'], 3);
    const unnamed = lastVanish({ log, store });
    check('a row that counted more files than it named keeps the unnamed ones (cannot be checked)', unnamed && unnamed.vanished === 2, JSON.stringify(unnamed));

    row(['x-cccc-1', 'x-cccc-2']);
    check('CONTROL: names really gone are still reported, all of them', (lastVanish({ log, store }) || {}).vanished === 2);
  } finally {
    cleanupSandbox(dir);
  }
}
