// test/public/dream-writes-nowhere.mjs — DREAM MUST NOT TOUCH THE MEMORY FOLDER.
//
// 🟥 WHY THIS EXISTS, and it is not the reason you would guess. dream.js does NOT write into the
// memory folder — measured, and pinned here. The check exists because for one afternoon a reading
// session believed it did, and acted on that belief: dream's own header said `--apply` performs
// "stamp curatedHash, demote a superseded doc", which reads as two writes into memory files. The
// stamp actually goes to .dream-state.json under ownStoreDir(), and demotion is QUEUED for a human,
// never applied. `grep MEMORY_CURATED_READ_ONLY scripts/dream.js` returns nothing, which looked
// like the confirming evidence — a safety switch the file ignored — and was instead a switch it
// never needed.
//
// A comment describing a write the code does not make is worse than no comment: it is a bug report
// that reproduces only in the reader. The fix for that is not a better comment, it is a check —
// so the claim now rests on checksums rather than on prose that can drift again.
//
// WHAT IT ASSERTS: run `dream --apply --force` over a real fixture corpus and every memory file is
// BYTE-IDENTICAL afterwards. The CONTROL is what stops this passing on dream having done nothing
// at all: the run must report it stamped documents, and must have written its state file.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const fingerprint = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  .map((f) => `${f}:${createHash('sha1').update(readFileSync(join(dir, f))).digest('hex')}`).join('\n');

export async function dreamWritesNowhereTests({ check, group }) {
  group('(dream) --apply writes to the cache folder, never to your notes');

  const box = mkdtempSync(join(tmpdir(), 'dream-'));
  const mem = join(box, 'mem'), state = join(box, 'state'), home = join(box, 'home');
  for (const d of [mem, state, home]) mkdirSync(d, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(mem, `note-${i}.md`),
      `---\nname: note-${i}\ndescription: fixture ${i}\nmetadata:\n  type: reference\n---\n` +
      `Spoke tension is 100 kgf on the drive side, note ${i}.\n`);
  }

  const before = fingerprint(mem);
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'dream.js'), '--apply', '--force'], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home,
           MEMORY_DIR: mem, MEMORY_ROOT: state, MEMORY_OWN_STORE: join(state, 'store') }
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const after = fingerprint(mem);

  // CONTROLS FIRST — an assertion that "nothing changed" is trivially true if nothing ran.
  check('(dream) CONTROL — the run completed', r.status === 0, `exit ${r.status}: ${out.slice(-160)}`);
  check('(dream) CONTROL — it actually applied something (stamped N documents)',
    /applied: stamped [1-9]/.test(out), out.slice(-200));
  check('(dream) CONTROL — and wrote its own state file to the cache folder',
    existsSync(join(state, 'store', '.dream-state.json')), 'no .dream-state.json');

  check('(dream) 🟥 every memory file is BYTE-IDENTICAL after --apply',
    before === after, `before:\n${before}\nafter:\n${after}`);

  // Nothing dream wrote may live outside the state root.
  const strays = readdirSync(mem).filter((f) => !f.endsWith('.md'));
  check('(dream) ...and it left no new files in the memory folder', strays.length === 0, strays.join(', '));

  cleanupSandbox(box, { label: 'dream' });
}
