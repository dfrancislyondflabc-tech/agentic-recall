// lib/local-config.js — this machine's settings, kept OUT of this machine's code.
//
// Some values are irreducibly personal: where your memories live, which email domain is
// "us", which addresses are your own. They are not defaults anyone else could inherit, and
// they were previously written straight into lib/config.js and scripts/ingest-transcript.js
// as string literals — which is how a shareable build came to name one person's home
// directory, employer and personal address.
//
// They could not simply become env vars, because the capture pipeline runs from Stop and
// SessionEnd hooks that inherit no environment: four call sites would have gone silently
// wrong, and silently wrong capture is the one failure this project cannot have. So they
// live in a FILE the code reads, which every entry point sees for free.
//
//   local-config.json   (gitignored, never shipped, never indexed)
//   {
//     "memoryDir":        "/absolute/path/to/your/memories",
//     "keepEmailDomains": ["your-org.com"],
//     "keepEmails":       ["you@example.com"]
//   }
//
// PRECEDENCE: environment variable > local-config.json > generic default. Env still wins
// so the test suite and one-off runs can override without touching the file.
//
// Absent file = generic defaults. That is the correct behaviour for a fresh install: no
// memory directory assumption beyond ./memories, and NO email domain treated as internal,
// which redacts MORE rather than less. A privacy default that guesses wrong should guess
// toward silence.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.MEMORY_ROOT ? resolve(process.env.MEMORY_ROOT) : dirname(dirname(fileURLToPath(import.meta.url)));   // see lib/config.js MEMORY_ROOT
export const LOCAL_CONFIG_PATH = join(ROOT, 'local-config.json');

let CACHE = null;
export function localConfig() {
  if (CACHE) return CACHE;
  CACHE = {};
  try {
    if (existsSync(LOCAL_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) CACHE = raw;
    }
  } catch {
    // A malformed local-config is a local mistake, not a reason to stop working. Every
    // consumer has a generic fallback, and for the privacy-shaped values that fallback is
    // the SAFE direction (redact more), so failing soft here cannot leak anything.
    CACHE = {};
  }
  return CACHE;
}

/** A string setting: env wins, then local-config.json, then the supplied default. */
export function localString(envName, key, fallback = '') {
  const env = process.env[envName];
  if (env !== undefined && env !== '') return env;
  const v = localConfig()[key];
  return typeof v === 'string' && v ? v : fallback;
}

/** A list setting. Env is delimiter-separated; the file may use an array or a string. */
export function localList(envName, key, fallback = []) {
  const env = process.env[envName];
  if (env !== undefined && env !== '') return env.split(/[,:;]/).map((s) => s.trim()).filter(Boolean);
  const v = localConfig()[key];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string' && v) return v.split(/[,:;]/).map((s) => s.trim()).filter(Boolean);
  return fallback;
}
