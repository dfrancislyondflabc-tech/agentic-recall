// lib/doctor.js — `agentic-recall --doctor`: what does this configuration ACTUALLY resolve to?
//
// 🟥 WHY THIS EXISTS. Three problems were live on one machine for days while the server printed a
// warning about one of them at every single boot, into a stream nobody reads:
//
//   * the library corpus was switched off by MEMORY_DIR-without-MEMORY_LIBRARY_DIR — four
//     categories, invisible to every query, with `CONFIG:` on stderr each launch
//   * the memory connector was three releases behind, and nothing said so
//   * the connector was defined in TWO config files and only one had been edited, so the client
//     kept running the old one while the edited file looked correct
//
// None of that is exotic. It is what "configuring things is hard" looks like in practice: the facts
// are all knowable, each lives somewhere different, and no one command puts them side by side.
// So this is that command. It ANSWERS, it never repairs — the day this was written, something
// rewriting configuration on the author's behalf is precisely what caused two of the problems.
//
// Everything below is read-only and derived from the same functions the server itself uses, so it
// cannot drift into describing a different program.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  memoryDir, memoryRoots, CORPORA, rootsForCorpus, indexPathForCorpus, corpusSuppressedReason,
  libraryCorpora, handoffDirs, secretsConfigPath, modelCacheDir, ownStoreDir,
  queryLogPath, configWarning
} from './config.js';
import { serverVersionString, serverVersion } from './version.js';

const ok = (s) => `  ok    ${s}`;
const warn = (s) => `  ⚠     ${s}`;
const bad = (s) => `  🟥    ${s}`;
const plain = (s) => `        ${s}`;
const short = (p) => String(p ?? '').replace(homedir(), '~');

function docCount(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const n = (JSON.parse(raw).docs || []).length;
    return { n, mb: (statSync(path).size / 1048576).toFixed(1) };
  } catch { return null; }
}

/** Every place a client may define this server, and whether they agree. */
function configSurfaces() {
  const H = homedir();
  const files = [
    ['Claude Desktop', join(H, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
    ['Claude Desktop (Windows)', join(H, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')],
    ['Claude Code / CLI', join(H, '.claude.json')]
  ];
  const found = [];
  for (const [label, path] of files) {
    if (!existsSync(path)) continue;
    let servers = {};
    try { servers = JSON.parse(readFileSync(path, 'utf8')).mcpServers || {}; } catch { found.push({ label, path, unreadable: true }); continue; }
    // Which entries point at THIS package? Match the command/args, never the connector NAME —
    // the name is the user's to choose and says nothing about what it runs.
    for (const [name, cfg] of Object.entries(servers)) {
      const blob = JSON.stringify([cfg.command, cfg.args]);
      if (!/agentic-recall|memory-mcp|recall-mcp/i.test(blob)) continue;
      found.push({ label, path, name, command: cfg.command, args: cfg.args, env: cfg.env || {} });
    }
  }
  return found;
}

export function doctorReport() {
  const L = [];
  L.push(`agentic-recall doctor — ${serverVersionString()}`);
  L.push('');

  // ---- 1. where is this server DEFINED, and do the definitions agree? -----------------------
  L.push('CONFIG SURFACES');
  const surfaces = configSurfaces();
  if (!surfaces.length) L.push(plain('no client config naming this server was found (that is fine if a client launches it another way)'));
  for (const s of surfaces) {
    if (s.unreadable) { L.push(bad(`${s.label}: ${short(s.path)} — UNREADABLE`)); continue; }
    L.push(ok(`${s.label} :: connector "${s.name}" — ${s.command} ${JSON.stringify(s.args)}`));
    L.push(plain(`${short(s.path)}`));
    const keys = Object.keys(s.env).sort();
    L.push(plain(`env: ${keys.length ? keys.join(', ') : '(none)'}`));
  }
  // 🟥 THE DRIFT CHECK. Two files, one edited, the client running the other — that is the mistake
  // this section exists for, and it is invisible unless the two are put side by side.
  if (surfaces.length > 1) {
    const sig = (s) => JSON.stringify([s.command, s.args, Object.fromEntries(Object.entries(s.env).sort())]);
    const distinct = new Set(surfaces.filter((s) => !s.unreadable).map(sig));
    if (distinct.size > 1) {
      L.push(bad('THESE DEFINITIONS DISAGREE. A client reads ONE of them; editing the other changes nothing.'));
      for (const s of surfaces) if (!s.unreadable) L.push(plain(`${s.label}: ${s.command} ${JSON.stringify(s.args)} | env: ${Object.keys(s.env).sort().join(',') || '(none)'}`));
    } else {
      L.push(ok('all definitions agree'));
    }
  }
  L.push('');

  // ---- 2. is every corpus REACHABLE, and if not, which variable did it? ---------------------
  L.push('CORPORA');
  L.push(plain(`memory folder: ${short(memoryDir())}`));
  let names = [...CORPORA];
  try { names = [...CORPORA, ...libraryCorpora()]; } catch { /* library off */ }
  for (const name of names) {
    const reason = corpusSuppressedReason(name);
    const path = indexPathForCorpus(name);
    let roots = 0;
    try { roots = rootsForCorpus(name).length; } catch { /* ignore */ }
    if (reason) { L.push(bad(`${name.padEnd(10)} NOT SEARCHED — ${reason}`)); continue; }
    if (!path) { L.push(warn(`${name.padEnd(10)} switched off (its *_INDEX variable is 0)`)); continue; }
    const idx = docCount(path);
    if (!idx) L.push(warn(`${name.padEnd(10)} ${roots} root(s), NO INDEX YET — ${short(path)}`));
    else L.push(ok(`${name.padEnd(10)} ${roots} root(s), ${idx.n} document(s), ${idx.mb} MB — ${short(path)}`));
  }
  const hd = (() => { try { return handoffDirs(); } catch { return []; } })();
  if (hd.length) L.push(plain(`handoff roots: ${hd.length} — ${hd.map(short).join(', ')}`));
  const cw = configWarning();
  if (cw) L.push(bad(`${cw.variable}: ${cw.why} — ${cw.effect}`));
  L.push('');

  // ---- 3. every file the code OPENS at runtime ---------------------------------------------
  // 🟥 The capture pipeline died for twenty minutes because secrets-exclude.json was left behind
  // when the code was copied elsewhere. It fails CLOSED, correctly — and silently, from here.
  L.push('RUNTIME FILES');
  // 🟥 REQUIRED vs CREATED-ON-DEMAND, and the distinction is the whole value of this section.
  // The first version flagged the model cache, the store and the query log as MISSING on a fresh
  // install — all three are created on first use, so it screamed at a perfectly healthy install.
  // A diagnostic that cries wolf teaches you to ignore it, which is the same failure as one that
  // always says ok. Only secrets-exclude.json MUST pre-exist: it ships with the code, and the
  // server fails CLOSED without it (that is correct, and it is how capture broke for 20 minutes).
  const files = [
    ['secrets-exclude.json (redaction rules — fails CLOSED if missing)', (() => { try { return secretsConfigPath(); } catch { return null; } })(), true],
    ['embedding model cache', (() => { try { return modelCacheDir(); } catch { return null; } })(), false],
    ['capture store', (() => { try { return ownStoreDir(); } catch { return null; } })(), false],
    ['query log', (() => { try { return queryLogPath(); } catch { return null; } })(), false]
  ];
  for (const [label, path, required] of files) {
    if (!path) { L.push(plain(`${label}: not configured`)); continue; }
    if (existsSync(path)) { L.push(ok(`${label}: ${short(path)}`)); continue; }
    L.push(required
      ? bad(`${label}: MISSING at ${short(path)}`)
      : plain(`${label}: not created yet (normal before first use) — ${short(path)}`));
  }
  L.push('');

  // ---- 4. is the code you are running the code you think you are running? -------------------
  L.push('VERSION');
  L.push(plain(`running: ${serverVersionString()}`));
  L.push(plain(`package: ${serverVersion().packageVersion ?? '(unknown)'}`));
  L.push(plain('npm latest: run `npm view agentic-recall version` — not fetched here, doctor makes no network calls'));
  L.push('');
  L.push('doctor reads; it never writes. Nothing above was changed.');
  return L.join('\n');
}
