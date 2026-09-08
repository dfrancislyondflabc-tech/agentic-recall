#!/usr/bin/env node
// packaging/install-hooks.mjs — OPT-IN: wire THIS install's capture into Claude Code's hooks.
//
//   node packaging/install-hooks.mjs              add the Stop + SessionEnd hooks
//   node packaging/install-hooks.mjs --uninstall  take them out again
//   node packaging/install-hooks.mjs --dry-run    print what would change, write nothing
//   node packaging/install-hooks.mjs --settings <path>   (tests; also MEMORY_CLAUDE_SETTINGS)
//
// WHY THIS EXISTS. Without a Stop hook the last exchange of a session is captured only by the
// timed walker, which defers an in-flight turn — so a chat that ends is remembered late, or on
// the hourly audit (MEM-67). With one, capture happens the moment the turn ends. The Windows
// 1.7.1 tester stopped short of installing hooks by hand and said so: editing someone's
// settings.json unasked is not a setup step.
//
// SO IT IS OPT-IN, AND IT IS THE ONLY THING HERE THAT TOUCHES A FILE OUTSIDE THIS FOLDER.
// SETUP.html shows the JSON and this command; neither launcher runs it. Three rules:
//   1. BACK UP FIRST — settings.json.bak-<stamp> beside the file, before any write.
//   2. NEVER TOUCH ANOTHER HOOK. Only entries whose command is exactly this install's are
//      added or removed; every other event, matcher and entry is copied through untouched.
//   3. REFUSE ON A FOREIGN CAPTURE HOOK. A settings.json that already runs auto-ingest from a
//      DIFFERENT install is a two-writer configuration, and this script cannot know which one
//      the user wants — so it stops and names the command instead of guessing. (That is also
//      what protects a developer's own dist/capture wiring from a zip's installer.)
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = platform() === 'win32';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const UNINSTALL = has('--uninstall');
const DRY = has('--dry-run');

// THE TWO PATHS THE HOOK RUNS. The bundled runtime when there is one (a portable install must
// not depend on a Node the machine may not have — that is the whole point of shipping one), and
// the released capture copy when there is one (a developer checkout freezes committed code in
// dist/capture; an installed zip IS frozen code, so it runs scripts/ directly).
const nodeBin = existsSync(join(ROOT, 'runtime', WIN ? 'node.exe' : 'node'))
  ? join(ROOT, 'runtime', WIN ? 'node.exe' : 'node')
  : process.execPath;
const released = join(ROOT, 'dist', 'capture', 'scripts', 'auto-ingest.js');
const script = existsSync(released) ? released : join(ROOT, 'scripts', 'auto-ingest.js');

// FORWARD SLASHES, DOUBLE QUOTES — the same shape SETUP-WINDOWS.cmd hands Claude for the MCP
// registration. A Windows path in a JSON string needs its backslashes doubled and a shell then
// eats one layer; forward slashes are accepted by CreateProcess and survive both.
const fwd = (p) => p.replace(/\\/g, '/');
const COMMAND = `"${fwd(nodeBin)}" "${fwd(script)}"`;

const SETTINGS = argOf('--settings') || process.env.MEMORY_CLAUDE_SETTINGS
  || join(homedir(), '.claude', 'settings.json');

// The shape Claude Code reads, and the shape this machine's own hooks already use:
// hooks.<Event>[] -> { hooks: [ { type, command, timeout, statusMessage, async } ] }
const ENTRIES = [
  { event: 'Stop', statusMessage: 'Capturing conversation to memory' },
  { event: 'SessionEnd', statusMessage: 'Ingesting conversation into memory' }
];
const entryFor = (statusMessage) => ({ type: 'command', command: COMMAND, timeout: 900, statusMessage, async: true });

// A CAPTURE HOOK, WHOEVER OWNS IT. Deliberately wider than "ours": the point of the refusal is
// to notice an install that is NOT this one, so the test is the script NAME, and ownership is
// decided by the full command.
const isCaptureHook = (cmd) => typeof cmd === 'string' && /auto-ingest\.m?js/.test(cmd);
const isOurs = (cmd) => typeof cmd === 'string' && fwd(cmd).includes(fwd(script));

function fail(msg, code = 2) { console.error(msg); process.exit(code); }

if (!existsSync(script)) {
  fail(`  Cannot find the capture script at ${script} — this install looks incomplete.`);
}
if (!existsSync(SETTINGS)) {
  fail(`  No Claude Code settings file at ${SETTINGS}.\n` +
       '  Run Claude Code once (it creates the file), then run this again.\n' +
       '  Hooks are a Claude CODE feature; Claude Desktop does not read this file.');
}

let raw, settings;
try { raw = readFileSync(SETTINGS, 'utf8'); settings = JSON.parse(raw); } catch (e) {
  fail(`  ${SETTINGS} is not readable JSON (${e.message}).\n` +
       '  Refusing to touch it — fix or restore the file first. Nothing was written.', 3);
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  fail(`  ${SETTINGS} does not contain a JSON object. Nothing was written.`, 3);
}

const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
const walk = () => {
  const out = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) out.push({ event, group: g, hook: h });
  }
  return out;
};

const foreign = walk().filter(({ hook }) => isCaptureHook(hook.command) && !isOurs(hook.command));
if (foreign.length) {
  console.error('  REFUSING: this settings file already runs a capture hook from a DIFFERENT install:');
  for (const f of foreign) console.error(`    ${f.event}: ${f.hook.command}`);
  console.error('  Two installs capturing the same conversations would write the same exchanges twice.');
  console.error(`  Remove those lines from ${SETTINGS} yourself, or keep them and skip this step.`);
  console.error('  Nothing was written.');
  process.exit(4);
}

const mine = walk().filter(({ hook }) => isOurs(hook.command));

if (UNINSTALL) {
  if (!mine.length) { console.log(`  Not installed — no hook in ${SETTINGS} runs ${script}. Nothing to do.`); process.exit(0); }
  if (DRY) { console.log(`  Would remove ${mine.length} hook(s) from ${SETTINGS}:`); for (const m of mine) console.log(`    ${m.event}`); process.exit(0); }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) if (g && Array.isArray(g.hooks)) g.hooks = g.hooks.filter((h) => !isOurs(h.command));
    // Prune only what THIS script emptied: a group with no hooks left, then an event with no groups.
    hooks[event] = groups.filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (!hooks[event].length) delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  write(`removed ${mine.length} hook(s)`);
  process.exit(0);
}

// INSTALL — idempotent by COMMAND, per event.
const missing = ENTRIES.filter(({ event }) => !mine.some((m) => m.event === event));
if (!missing.length) {
  console.log(`  Already installed — ${SETTINGS} already runs this install's capture on ${ENTRIES.map((e) => e.event).join(' and ')}.`);
  console.log(`    ${COMMAND}`);
  process.exit(0);
}
if (DRY) {
  console.log(`  Would add ${missing.length} hook(s) to ${SETTINGS}:`);
  for (const m of missing) console.log(`    ${m.event}: ${COMMAND}`);
  process.exit(0);
}
for (const { event, statusMessage } of missing) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  hooks[event].push({ hooks: [entryFor(statusMessage)] });
}
settings.hooks = hooks;
write(`added ${missing.length} hook(s)`);

function write(what) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '');
  const backup = `${SETTINGS}.bak-${stamp}`;
  copyFileSync(SETTINGS, backup);
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  // READ BACK WHAT WAS WRITTEN. A backup and a claim are not a verification: re-parse the file
  // and count the hooks that are actually in it now.
  let after;
  try { after = JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch (e) {
    copyFileSync(backup, SETTINGS);
    fail(`  The written file did not parse (${e.message}) — RESTORED from ${backup}.`, 5);
  }
  const cmds = [];
  for (const groups of Object.values(after.hooks || {})) for (const g of (groups || [])) for (const h of (g.hooks || [])) cmds.push(h.command);
  const nOurs = cmds.filter(isOurs).length;
  console.log(`  ${what} in ${SETTINGS}`);
  console.log(`  backup: ${backup}`);
  console.log(`  this install's capture hooks now present: ${nOurs}`);
  console.log(`  other hooks left untouched: ${cmds.filter((c) => !isOurs(c)).length}`);
  console.log('  Claude Code reads settings.json when a session starts — open a new session.');
}
