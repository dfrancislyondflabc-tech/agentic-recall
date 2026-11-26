// MEM-116 — THE VECTOR CACHE IS ONE BINARY FILE, WRITTEN ONLY WHEN SOMETHING WAS ADDED.
//
// THE COST (2026-11-25, Daniel's Mac): `.vector-cache.json` = 190 MB of base64 vectors (90k). Every index build parsed it
// (+0.5–0.8 GB) and rewrote all of it at the end, even a build that embedded nothing. The capture timer rebuilds the
// staging index every few minutes while he works: a no-change rebuild measured 2.3 GB.
//
// This proves: a round trip returns every vector bit-identical under its key; the legacy JSON is read once and migrated
// to `.bin` and never written again; a build-style flush with nothing added writes nothing; a truncated `.bin` or another
// model's `.bin` starts empty (never wrong vectors); and — in child processes — loading the binary costs a fraction of
// loading the same vectors from the legacy JSON.
import { spawnSync } from 'node:child_process';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';   // repo rule: tests that spawn import the cleanup helper (spawnSync ends its own child)
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function child(env, body) {
  const src = `const VC = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'vector-cache.js')).href)});
    const C = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'config.js')).href)});
    const out = (v) => process.stdout.write('@@' + JSON.stringify(v) + '@@');
    const vec = (seed) => { const d = C.EMBEDDING.dim; const v = new Float32Array(d); let x = seed * 2654435761 % 4294967296;
      for (let i = 0; i < d; i++) { x = (x * 1103515245 + 12345) % 2147483648; v[i] = x / 2147483648 - 0.5; } return v; };
    ${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000, maxBuffer: 16 << 20 });
  const m = /@@([\s\S]*)@@/.exec(r.stdout || '');
  try { return m ? JSON.parse(m[1]) : { error: (r.stderr || '').slice(-300) }; } catch (_) { return { error: 'unparsable' }; }
}

export async function vectorCacheBinaryTests({ check, group }) {
  group('MEM-116 — the vector cache is one binary file, written only when something was added');
  const dir = mkdtempSync(join(tmpdir(), 'mem116-'));
  try {
    const cache = join(dir, '.vector-cache.json');
    const env = { MEMORY_VECTOR_CACHE: cache, MEMORY_LOG_LEVEL: 'warn' };

    // round trip
    const a = child(env, `const c = VC.loadCache(); for (let i = 0; i < 500; i++) VC.cacheSet(c, 'text ' + i, vec(i));
      const wrote = VC.flushCache(c); const d = VC.loadCache(); let same = d.vectors.size === 500;
      for (let i = 0; i < 500; i++) { const v = VC.cacheGet(d, 'text ' + i), w = vec(i); if (!v || v.length !== w.length || v.some((x, k) => x !== w[k])) same = false; }
      out({ wrote, size: d.vectors.size, same, bin: VC.binPath(), json: ${JSON.stringify(cache)} });`);
    check('round trip: 500 vectors back bit-identical under their keys, from the .bin', a.wrote === true && a.same === true && existsSync(a.bin) && !existsSync(cache), JSON.stringify(a));

    // nothing added -> nothing written
    const before = statSync(a.bin).mtimeMs;
    const b = child(env, `const c = VC.loadCache(); VC.cacheGet(c, 'text 3'); out({ wrote: VC.flushCache(c), size: c.vectors.size });`);
    check('a build that adds nothing writes nothing (the cache used to be rewritten whole on every build)', b.wrote === false && statSync(a.bin).mtimeMs === before, JSON.stringify(b));

    // migration from the legacy JSON
    const dir2 = mkdtempSync(join(dir, 'legacy-'));
    const legacy = join(dir2, '.vector-cache.json');
    const env2 = { MEMORY_VECTOR_CACHE: legacy, MEMORY_LOG_LEVEL: 'warn' };
    const mk = child(env2, `const vr = (await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'vec.js')).href)})).vecReplacer;
      const contract = VC.loadCache().contract; const vectors = {}; for (let i = 0; i < 50; i++) vectors[VC.textKey('old ' + i)] = vec(1000 + i);
      (await import('node:fs')).writeFileSync(${JSON.stringify(legacy)}, JSON.stringify({ contract, vectors }, vr)); out({ ok: true });`);
    const legacyBytes = readFileSync(legacy);
    const m = child(env2, `const c = VC.loadCache(); const got = VC.cacheGet(c, 'old 7'); const w = vec(1007);
      const wrote = VC.flushCache(c); const d = VC.loadCache();
      out({ mk: ${JSON.stringify(mk.ok === true)}, size: c.vectors.size, right: !!got && got.every((x, k) => x === w[k]), wrote, reloaded: d.vectors.size });`);
    check('legacy JSON: read, migrated to .bin on the first flush, and the JSON itself left untouched (older servers use it)',
      m.mk && m.size === 50 && m.right && m.wrote === true && m.reloaded === 50 && readFileSync(legacy).equals(legacyBytes), JSON.stringify(m));

    // a damaged .bin, another model's .bin
    const bin = a.bin;
    const good = readFileSync(bin);
    truncateSync(bin, good.length - 10);
    const t = child(env, `const c = VC.loadCache(); out({ size: c.vectors.size });`);
    check('a truncated .bin starts EMPTY (re-embed), never returns partial or shifted vectors', t.size === 0, JSON.stringify(t));
    // another model's cache: same layout, a different contract fingerprint in the header
    const other = Buffer.from(good); const at = other.indexOf('"contract":"') + 12;
    other[at] = other[at] === 0x30 ? 0x31 : 0x30;
    writeFileSync(bin, other);
    const o = child(env, `const c = VC.loadCache(); out({ size: c.vectors.size });`);
    writeFileSync(bin, good);
    check('a .bin from another embedding model is discarded, not used', o.size === 0, JSON.stringify(o));

    // memory: the same 30k vectors, legacy JSON vs .bin
    const dir3 = mkdtempSync(join(dir, 'mem-'));
    const big = join(dir3, '.vector-cache.json');
    const env3 = { MEMORY_VECTOR_CACHE: big, MEMORY_LOG_LEVEL: 'warn' };
    child(env3, `const vr = (await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'vec.js')).href)})).vecReplacer;
      const contract = VC.loadCache().contract; const vectors = {}; for (let i = 0; i < 30000; i++) vectors[VC.textKey('m ' + i)] = vec(i);
      (await import('node:fs')).writeFileSync(${JSON.stringify(big)}, JSON.stringify({ contract, vectors }, vr)); out({ ok: true });`);
    const fromJson = child(env3, `const b0 = process.memoryUsage().rss; const c = VC.loadCache(); const grew = process.memoryUsage().rss - b0; VC.flushCache(c); out({ n: c.vectors.size, mb: Math.round(grew / 1048576) });`);
    const fromBin = child(env3, `const b0 = process.memoryUsage().rss; const c = VC.loadCache(); const grew = process.memoryUsage().rss - b0; out({ n: c.vectors.size, mb: Math.round(grew / 1048576) });`);
    check(`loading 30k vectors from the .bin costs under half of loading them from the legacy JSON (${fromBin.mb} vs ${fromJson.mb} MB)`,
      fromJson.n === 30000 && fromBin.n === 30000 && fromBin.mb * 2 < fromJson.mb, JSON.stringify({ fromJson, fromBin }));
  } finally { cleanupSandbox(dir, { label: 'mem116' }); }
}
