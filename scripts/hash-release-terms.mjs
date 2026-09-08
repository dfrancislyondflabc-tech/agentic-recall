#!/usr/bin/env node
// scripts/hash-release-terms.mjs — turn deny terms into hashes for release-deny.json.
//
//   printf 'AcmeCorp\njane.doe\n' | node scripts/hash-release-terms.mjs
//
// Prints one sha256 per line, ready to paste into tokenHashesSha256. The point is that
// nobody — including this repo's own history — ever has to write the term down in order
// to detect it. Terms are lowercased first, matching the comparison the checker does.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
const terms = input.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
if (!terms.length) {
  console.error('no terms on stdin — one per line');
  process.exit(2);
}
for (const t of terms) {
  console.log(createHash('sha256').update(t.toLowerCase()).digest('hex'));
}
console.error(`${terms.length} term(s) hashed. Paste into release-deny.json -> tokenHashesSha256.`);
