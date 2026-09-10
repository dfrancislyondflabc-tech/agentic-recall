// test/public/read-tool-cannot-write.mjs — THE MARK THAT MAKES readOnlyHint TRUE HONEST.
//
// 2.0.0 splits the surface: `memory` carries nine read actions, `memory_write` the five writes. The
// schema alone already refuses a write action asked of the read tool — verify-stdio pins that. This
// is the SECOND layer, and it is the one the annotation actually rests on: the `memory` registration
// marks its request context `readOnlyTool`, and lib/safe-write.js refuses on that mark. So a write
// reached from the read path cannot complete even if some future code path inside a read action
// tries one.
//
// 🟥 WHY IT IS TESTED SEPARATELY FROM THE SCHEMA. A mutation that made safe-write ignore the mark
// SURVIVED the whole 285-check suite. Everything else still passed: the tools still split, the
// annotations still read true, the schema still refused. The enforcement — the only part that makes
// readOnlyHint a structural fact rather than a promise — was untested. A guard nobody exercised is
// how this project has shipped two defects already.
//
// The CONTROL is the whole test: the identical write must SUCCEED with the mark absent. Without
// that, this passes on a corpus path that was never writable in the first place.

import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

export async function readToolCannotWriteTests({ check, group }) {
  group('(rw) a read-tool request cannot write, whatever asks');

  const { writeNewMemoryFile, readOnly, readOnlyReason } = await import('../../lib/safe-write.js');
  const { beginMcpRequest, endMcpRequest } = await import('../../lib/config.js');

  const box = mkdtempSync(join(tmpdir(), 'rw-'));
  mkdirSync(box, { recursive: true });
  const body = '---\nname: probe\ndescription: probe\nmetadata:\n  type: reference\n---\nbody\n';

  // ---- CONTROL FIRST: with no mark, the write must actually land. If this fails, every
  // refusal below is meaningless — it would be refusing something that could never happen.
  endMcpRequest();
  const control = writeNewMemoryFile(join(box, 'control.md'), body);
  check('(rw) CONTROL — with no read-only mark, the write SUCCEEDS',
    control.written === true && existsSync(join(box, 'control.md')), JSON.stringify(control));
  check('(rw) CONTROL — ...and the bytes are really on disk',
    existsSync(join(box, 'control.md')) && readFileSync(join(box, 'control.md'), 'utf8').includes('body'), '');

  // ---- the guard
  beginMcpRequest({ readOnlyTool: true, action: 'search', queryId: 'test' });
  check('(rw) readOnly() reports true inside a read-tool request', readOnly() === true, '');
  const refused = writeNewMemoryFile(join(box, 'blocked.md'), body);
  check('(rw) 🟥 a write attempted from a read-tool request is REFUSED',
    refused.written === false, JSON.stringify(refused));
  check('(rw) ...and NOTHING was written to disk',
    !existsSync(join(box, 'blocked.md')), 'blocked.md exists — the refusal did not prevent the write');
  check('(rw) ...and the refusal names memory_write, not the env var',
    /memory_write/.test(refused.refused || ''), refused.refused || '');

  // ---- and the mark must not leak past the request
  endMcpRequest();
  check('(rw) readOnly() is false again once the request ends', readOnly() === false, '');
  const after = writeNewMemoryFile(join(box, 'after.md'), body);
  check('(rw) CONTROL — a write after the request ends SUCCEEDS (the mark did not latch)',
    after.written === true, JSON.stringify(after));

  // ---- the env switch still works on its own, and says so differently
  process.env.MEMORY_CURATED_READ_ONLY = '1';
  check('(rw) MEMORY_CURATED_READ_ONLY=1 still refuses on its own', readOnly() === true, '');
  check('(rw) ...and names the env var, because the two are fixed differently',
    /MEMORY_CURATED_READ_ONLY/.test(readOnlyReason()), readOnlyReason());
  delete process.env.MEMORY_CURATED_READ_ONLY;

  cleanupSandbox(box, { label: 'rw' });
}
