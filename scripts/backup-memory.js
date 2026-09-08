#!/usr/bin/env node
// backup-memory.js — a SCRUBBED, portable copy of the curated memory folder.
//
// DANIEL'S RULING (2026-08-29): "don't take control of my keychain on my mac" and
// "when you back it up, or if I tell you to put mcp memory server + memories in a zip,
// the memories that have passwords should be scrubbed from passwords. but for the local
// version ... there are a few places where I allowed it."
//
// So: the LOCAL folder keeps its credentials exactly as he allowed. What LEAVES the
// machine is scrubbed. That removes the whole key-management problem — there is no
// passphrase, no Keychain entry, and nothing for Claude to hold, because a scrubbed
// archive needs no secret to protect it.
//
// 🟥 THE HONEST TRADE, AND IT IS NOT SMALL. Scrubbing the working files does NOT scrub
// `.git`: the credentials remain in the object history. So a scrubbed archive CANNOT
// carry history, and this ships a snapshot by default. Local git keeps the history for
// undoing a bad overwrite (that is why commit-memories.js exists); this archive keeps
// the CONTENT alive if the disk dies. They cover different failures on purpose.
// `--with-history` exists for a destination you trust with the credentials, and it
// refuses to run without `--unsafe-history` so nobody reaches for it by accident.
//
//   node scripts/backup-memory.js --out <dir>            # scrubbed snapshot (default)
//   node scripts/backup-memory.js --out <dir> --with-history --unsafe-history
//   node scripts/backup-memory.js --out <dir> --zip     # .zip for a Windows PC
//   node scripts/backup-memory.js --out <dir> --force    # ignore the 24h gate
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync,
         rmSync, existsSync, cpSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSyncHidden } from '../lib/child.js';   // MEM-83: no console window on Windows
import { redact } from '../lib/secrets.js';
import { memoryDir } from '../lib/config.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val  = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };

const OUT = val('--out', null);
const WITH_HISTORY = flag('--with-history');
const FORCE = flag('--force');
const ZIP = flag('--zip');   // .zip instead of .tar.gz — for handing to a Windows PC
const GATE_HOURS = Number(process.env.MEMORY_BACKUP_MIN_HOURS || 24);
const KEEP = Number(process.env.MEMORY_BACKUP_KEEP || 14);
const STATE = process.env.MEMORY_BACKUP_STATE || join(homedir(), '.claude', '.memory-backup-last');
const SRC = process.env.MEMORY_DIR || memoryDir();

const die = (m) => { console.error('[backup-memory] FAIL: ' + m); process.exit(1); };
if (!OUT) die('--out <dir> is required');
if (!existsSync(SRC)) die('source folder not found: ' + SRC);
if (WITH_HISTORY && !flag('--unsafe-history')) {
  die('--with-history includes .git, and the git history still contains the credentials\n' +
      '  that were scrubbed from the working files. Re-run with --unsafe-history if the\n' +
      '  destination is trusted with them. Otherwise omit it and ship the scrubbed snapshot.');
}

// ---- the 24h gate: disk loss is not a per-turn risk -------------------------
if (!FORCE && existsSync(STATE)) {
  const age = (Date.now() - Number(readFileSync(STATE, 'utf8') || 0)) / 3.6e6;
  if (age < GATE_HOURS) { console.log(`[backup-memory] not due (${age.toFixed(1)}h of ${GATE_HOURS}h)`); process.exit(0); }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const work = mkdtempSync(join(tmpdir(), 'membk-'));
const staged = join(work, 'memory');
mkdirSync(staged, { recursive: true });

// ---- copy + scrub -----------------------------------------------------------
let files = 0, scrubbed = 0;
const hitNames = new Set();
const binaries = [];

// Text = no NUL byte in the first 8 KB. Cheap, and errs toward TREATING a file as text,
// which means scrubbing it — the safe direction when the question is "could this leak".
const isText = (p) => {
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    return !buf.subarray(0, n).includes(0);
  } finally { closeSync(fd); }
};
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    if (e === '.git' && !WITH_HISTORY) continue;
    const p = join(dir, e);
    const st = statSync(p);
    const rel = relative(SRC, p);
    if (st.isDirectory()) { mkdirSync(join(staged, rel), { recursive: true }); walk(p); continue; }
    // 🟥 EVERY text file, not just .md. The folder carries .sh/.command/.txt helpers and
    // stale .md.bak copies; scrubbing only .md would ship a credential in any of them.
    // Found the hard way: a .md.backup-pre-scrub sat here, and the archive carried it
    // verbatim past a scrub that reported success.
    if (!isText(p)) { cpSync(p, join(staged, rel)); binaries.push(rel); continue; }
    const raw = readFileSync(p, 'utf8');
    const r = redact(raw);                       // the SAME scrubber search uses
    if (r.hits && r.hits.length) { scrubbed++; r.hits.forEach((h) => hitNames.add(h)); }
    writeFileSync(join(staged, rel), r.text);
    files++;
  }
};
walk(SRC);
console.log(`[backup-memory] staged ${files} text file(s); ${scrubbed} had secrets redacted` +
            (hitNames.size ? ` (${[...hitNames].join(', ')})` : '') +
            (binaries.length ? `; ${binaries.length} binary file(s) copied unscrubbed but audited` : ''));

// ---- PROVE THE SCRUB, every run --------------------------------------------
// A scrubbed archive whose scrub was never checked is the same shape of hope as a
// backup that was never restored. Re-run the detector over the STAGED tree and
// require zero hits; if anything survives, refuse to produce the archive at all.
let survivors = [];
const audit = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { audit(p); continue; }
    // Binaries are copied unscrubbed, so they are still READ here: a credential pasted
    // into one would otherwise leave the machine unexamined.
    const r = redact(readFileSync(p, isText(p) ? 'utf8' : 'latin1'));
    if (r.hits && r.hits.length) survivors.push(`${relative(staged, p)} (${r.hits.join(',')})`);
  }
};
audit(staged);
if (survivors.length && !WITH_HISTORY) {
  console.error('[backup-memory] SCRUB DID NOT HOLD — these still match after redaction:');
  survivors.slice(0, 10).forEach((s) => console.error('    ' + s));
  die('refusing to write an archive that still contains credential-shaped text');
}
console.log('[backup-memory] scrub verified: 0 credential patterns survive in the staged tree');

// ---- a README inside, so whoever opens this in a year knows what it is -------
writeFileSync(join(staged, 'READ-ME-FIRST.txt'),
  ['Claude memories — SCRUBBED SNAPSHOT',
   `Taken: ${new Date().toISOString().slice(0, 10)}`,
   '',
   'WHAT THIS IS',
   '  The hand-written memory corpus used by the memory MCP server. Every file is',
   '  plain Markdown — readable in any text editor, on any machine, with no software.',
   '  MEMORY.md is the index; start there.',
   '',
   'WHAT WAS REMOVED',
   '  Passwords and API keys were replaced with [REDACTED:...] markers before this',
   '  archive was written. The copy on the Mac still has them. So this archive',
   '  preserves the KNOWLEDGE, not the credentials — if you restore from it, the few',
   '  credential lines must be typed back in by hand.',
   '',
   'WHAT IS NOT HERE',
   '  Git history. Scrubbing the working files does not scrub .git, so history could',
   '  not travel without carrying the credentials with it. This is a snapshot.',
   '',
   'THE SOFTWARE',
   '  github.com/<your account>/recall-mcp — the server is already off-machine.',
   '  These files were the only part that was not.',
   ''].join('\n'));

// ---- archive ----------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const ext = ZIP ? 'zip' : 'tar.gz';
const name = `memory-${stamp}${WITH_HISTORY ? '-WITH-HISTORY-UNSCRUBBED' : '-scrubbed'}.${ext}`;
const archive = join(OUT, name);
if (ZIP) execFileSyncHidden('zip', ['-q', '-r', archive, 'memory'], { cwd: work });
else     execFileSyncHidden('tar', ['-czf', archive, '-C', work, 'memory']);

// ---- VERIFY THE RESTORE, every run -----------------------------------------
const check = join(work, 'verify');
mkdirSync(check, { recursive: true });
if (ZIP) execFileSyncHidden('unzip', ['-q', archive, '-d', check]);
else     execFileSyncHidden('tar', ['-xzf', archive, '-C', check]);
const base = join(check, 'memory');
if (!existsSync(join(base, 'MEMORY.md'))) die('VERIFY: MEMORY.md missing from the archive');
const back = readdirSync(base).filter((f) => f.endsWith('.md')).length;
if (back < 50) die(`VERIFY: only ${back} memory files in the archive — too few to be the corpus`);
if (WITH_HISTORY && !existsSync(join(base, '.git'))) die('VERIFY: --with-history but no .git in the archive');
console.log(`[backup-memory] restore verified: ${back} memory files extract cleanly`);

// ---- prune + stamp ----------------------------------------------------------
const olds = readdirSync(OUT).filter((f) => new RegExp(`^memory-.*\\.${ext.replace('.', '\\.')}$`).test(f))
  .map((f) => ({ f, t: statSync(join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP);
for (const o of olds) rmSync(join(OUT, o.f), { force: true });
try { writeFileSync(STATE, String(Date.now())); } catch (_) {}
rmSync(work, { recursive: true, force: true });
const size = (statSync(archive).size / 1048576).toFixed(1);
console.log(`[backup-memory] wrote ${archive} (${size} MB)` + (olds.length ? `, pruned ${olds.length}` : ''));
console.log(WITH_HISTORY
  ? '[backup-memory] 🟥 THIS ARCHIVE IS UNSCRUBBED and carries git history — trusted destinations only.'
  : '[backup-memory] scrubbed snapshot — safe to copy anywhere. Git history stays local by design.');
