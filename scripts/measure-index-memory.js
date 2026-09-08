#!/usr/bin/env node
// scripts/measure-index-memory.js — what an index actually costs to hold.
//
//   node scripts/measure-index-memory.js [curated|staging|handoff|<path>] ...
//
// READ-ONLY. It never writes an index, a cache, or anything else.
//
// WHY IT FORKS. Node reports memory for the whole process, so measuring three representations in
// one process measures the high-water mark of all three plus whatever the harness left behind.
// Each (index x representation) pair therefore gets a fresh child that does one thing and exits.
//
// 🟥 THE METHODOLOGY RULE, and the reason this file exists at all. The figure that started this
// work — "about 45 KB per chunk for a 3 KB vector" — was WRONG, by roughly 4.3x. It came from
// reading `heapUsed` immediately after `JSON.parse`, while the parse's own garbage was still
// live. The same object graph settles to a quarter of that a few seconds later.
//
// So: never sample straight after a parse. Sample after >= 6 s of 1 Hz global.gc(), and report
// the PEAK separately via process.resourceUsage().maxRSS. They answer different questions —
// "how much does holding this cost" versus "how much headroom does loading it need" — and this
// change improves them by very different amounts, so reporting one alone misleads.

import { spawnSyncHidden } from '../lib/child.js';   // MEM-83: no console window on Windows
import { existsSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { indexPathForCorpus } from '../lib/config.js';
import { toVec } from '../lib/vec.js';

const HERE = fileURLToPath(import.meta.url);
const MODES = ['plain', 'f32', 'base64'];

/** The child: load one index one way, hold it live, report. Never writes. */
async function child(path, mode) {
  const { readFileSync } = await import('node:fs');
  let vectors = 0;

  // 🟥 THE BASE64 ROW MUST PARSE A BASE64 FILE. A first version transcoded AFTER parsing the
  // plain-array file, which measured the conversion cost and completely missed the point: Stage 2's
  // win is that the file is a third the size and its vectors are one short string each instead of
  // 384 numeric literals. Measuring the transcode reported ~1150 ms for what is really ~80 ms, and
  // would have made Stage 2 look pointless. The parent transcodes to a tmp file first and hands us
  // that path, so what is timed here is the load a user would actually pay.
  const t0 = Date.now();
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const conv = (v) => {
    if (!v) return v;
    vectors++;
    if (mode === 'plain') return v;
    if (typeof v === 'string') {
      const back = Buffer.from(v, 'base64');
      // Copy out of Node's pooled buffer — a view would pin an 8 KB slab per vector.
      return new Float32Array(back.buffer.slice(back.byteOffset, back.byteOffset + back.byteLength));
    }
    return Float32Array.from(v);
  };
  for (const d of raw.docs || []) {
    if (d.summaryVec) d.summaryVec = conv(d.summaryVec);
    for (const c of d.chunks || []) if (c.vec) c.vec = conv(c.vec);
  }
  const parseMs = Date.now() - t0;

  // HOLD IT LIVE. Without this the whole graph is collectable and the numbers measure nothing.
  globalThis.__held = raw;

  // Settle: 1 Hz gc for 6 s, per the rule above.
  for (let i = 0; i < 6; i++) {
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 1000));
  }
  const mem = process.memoryUsage();
  process.stdout.write(JSON.stringify({
    ok: true, parseMs, vectors,
    docs: (raw.docs || []).length,
    // maxRSS is KILOBYTES on every platform Node supports. A first version divided by 1 MB and
    // reported every peak as 0 or 1, which is the kind of number that gets believed because it is
    // in a table.
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    settledRssMb: Math.round(mem.rss / 1048576),
    settledHeapMb: Math.round(mem.heapUsed / 1048576)
  }));
}

if (process.argv[2] === '--child') { await child(process.argv[3], process.argv[4]); process.exit(0); }

// ---- parent ----------------------------------------------------------------
const targets = (process.argv.slice(2).length ? process.argv.slice(2) : ['curated', 'staging', 'handoff'])
  .map((t) => ({ label: t, path: existsSync(t) ? t : indexPathForCorpus(t) }))
  .filter((t) => {
    if (t.path && existsSync(t.path)) return true;
    console.log(`  ${t.label}: no index on disk — skipped`);
    return false;
  });

console.log(`  ${'index'.padEnd(10)} ${'repr'.padEnd(8)} ${'file MB'.padStart(8)} ${'parse ms'.padStart(9)} ${'peak MB'.padStart(8)} ${'settled MB'.padStart(11)} ${'heap MB'.padStart(8)}`);
/**
 * Write a tmpdir copy of `src` whose vectors use `enc` ('array' | 'base64').
 *
 * 🟥 IT MUST ACCEPT EITHER ENCODING AS INPUT. An earlier version assumed plain arrays on disk and
 * called Float32Array.from(v) on whatever it found. Once the real indexes became base64 that turned
 * every vector into NaNs — and NaNs do not throw, they just make every cosine NaN. The measurement
 * would have run, produced a table, and been wrong. Normalising through toVec() first means the row
 * label describes what was actually measured.
 */
function reencode(src, enc) {
  const raw = JSON.parse(readFileSync(src, 'utf8'));
  const conv = (v) => {
    const f = toVec(v);
    if (!f) throw new Error('a vector on disk is in a shape this harness does not understand');
    return enc === 'base64'
      ? Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64')
      : Array.from(f);
  };
  for (const d of raw.docs || []) {
    if (d.summaryVec) d.summaryVec = conv(d.summaryVec);
    for (const c of d.chunks || []) if (c.vec) c.vec = conv(c.vec);
  }
  const out = join(tmpdir(), `vecmeasure-${enc}-${basename(src)}`);
  writeFileSync(out, JSON.stringify(raw));
  return out;
}

for (const t of targets) {
  for (const mode of MODES) {
    // The repo is never written to; every copy lives in tmpdir and is removed below. 'plain' and
    // 'f32' both load the ARRAY file (they differ only in what the child builds in memory);
    // 'base64' loads the base64 file, so its parse time is the one a user would really pay.
    const path = reencode(t.path, mode === 'base64' ? 'base64' : 'array');
    const fileMb = (statSync(path).size / 1048576).toFixed(1);
    const r = spawnSyncHidden(process.execPath, ['--expose-gc', HERE, '--child', path, mode],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try { rmSync(path, { force: true }); } catch { /* tmp */ }
    let out = null;
    try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    if (!out?.ok) {
      console.log(`  ${t.label.padEnd(10)} ${mode.padEnd(8)} FAILED — ${String(r.stderr || '').trim().split('\n').pop()?.slice(0, 70)}`);
      continue;
    }
    console.log(`  ${t.label.padEnd(10)} ${mode.padEnd(8)} ${fileMb.padStart(8)} ${String(out.parseMs).padStart(9)} ${String(out.peakRssMb).padStart(8)} ${String(out.settledRssMb).padStart(11)} ${String(out.settledHeapMb).padStart(8)}`);
  }
}
