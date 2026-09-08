#!/usr/bin/env node
// setup-page.mjs — generate SETUP.html for THIS machine, with the real paths filled in.
//
// Why generated and not a static page: the whole point is that the config must name
// the folder the user actually extracted to. A static page can only say
// "<your path here>", which is exactly the step people get wrong.
//
// Run by SETUP-WINDOWS.cmd / SETUP-MACOS.command using the BUNDLED node, so it also
// proves the bundled runtime executes before anything is wired into Claude.
import { writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSyncHidden } from '../lib/child.js';   // MEM-83: `tasklist.exe` must not flash a console at the person running setup
import { homedir, platform, arch } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = platform() === 'win32';
const nodeBin = join(ROOT, 'runtime', WIN ? 'node.exe' : 'node');
const entry = join(ROOT, 'index.js');
// WHICH memory folder? This page is generated on two very different machines and
// must be right on both: a friend's fresh unzip (no memories anywhere yet -> the
// bundled ./memories seed) and a machine that ALREADY has a Claude memory folder
// under ~/.claude/projects/<project>/memory. Naming the wrong one produces a page
// that looks correct and quietly points Claude at the wrong corpus.
//
// 🟥 MEM-66. Until 1.7.1 this was one line — `if (isPortable) memories = bundled;` —
// written for the friend's-fresh-unzip case, and on the Windows PC test it did the
// other thing: the machine had 400 real memories under ~/.claude/projects/… and the
// generated snippet pointed MEMORY_DIR at the 1-file bundled seed, so a user who
// followed SETUP.html verbatim got a corpus that could not see a single one of their
// own memories — while the install doc in the same zip told them their memories live
// in ~/.claude/projects/<project>/memory. The tester re-pointed it by hand.
//
// THE RULE, in precedence order, and the page states which branch it took:
//   (a) MEMORY_DIR in the environment wins — naming a folder is a deliberate act.
//       So is `memoryDir` in local-config.json (a dev install's per-machine setting;
//       it is gitignored, so no zip can carry one).
//   (b) otherwise DISCOVERY, which lib/config.js already performs for the server
//       itself: ~/.claude/projects/*/memory, most-populated first, newest as the
//       tie-break. A folder with at least one .md in it is the user's real corpus.
//   (c) otherwise the bundled seed — and the page SAYS it is the seed and how to
//       switch, instead of presenting it as the answer.
// ONE import of the server's own config, THREE questions: DEFAULT_MEMORY_DIR for the
// dev-install case, discoverProjectMemoryDirs() for (b), and libraryBaseDir() for the
// library folder. All must be the value the SERVER would pick, not one this page invents.
// 🟥 WINDOWS: import() of an ABSOLUTE PATH throws — it must be a file:// URL.
// A Mac accepts the bare path, so this only ever fails on the machine the zip is FOR.
let CFG = {};
try { CFG = await import(pathToFileURL(join(ROOT, 'lib', 'config.js')).href); } catch {}
// A PORTABLE bundle is self-contained by definition, and it is identified by the
// runtime/ folder it ships. It still decides the LIBRARY folder (a portable install has
// no local-config to read one from); it no longer decides the memory folder, because
// "self-contained" was never a reason to hide the memories the user already has.
const isPortable = existsSync(join(ROOT, 'runtime'));
const bundled = join(ROOT, 'memories');

// How many .md files, and how recently touched — the two questions that separate a real
// corpus from an empty folder Claude created and never wrote to. Both are cheap: a
// readdir and a stat per candidate, and there is one candidate per project.
function mdStats(dir) {
  let n = 0, newest = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      n++;
      try { const t = statSync(join(dir, f)).mtimeMs; if (t > newest) newest = t; } catch {}
    }
  } catch { return { n: 0, newest: 0 }; }
  return { n, newest };
}

// (b) — the same sweep lib/config.js does, ranked. Guarded: a machine with no
// ~/.claude at all returns [], which is exactly the friend's-fresh-unzip case.
let discovered = [];
try {
  const dirs = typeof CFG.discoverProjectMemoryDirs === 'function' ? CFG.discoverProjectMemoryDirs() : [];
  discovered = dirs
    .map((d) => ({ ...d, ...mdStats(d.dir) }))
    .filter((d) => d.n > 0)
    .sort((a, b) => (b.n - a.n) || (b.newest - a.newest));
} catch { discovered = []; }

let memories = null;
let memorySource = 'bundled';         // 'env' | 'local-config' | 'discovered' | 'bundled'
if (process.env.MEMORY_DIR) {
  memories = resolve(process.env.MEMORY_DIR);
  memorySource = 'env';
} else if (CFG.DEFAULT_MEMORY_DIR && resolve(CFG.DEFAULT_MEMORY_DIR) !== bundled
           && existsSync(CFG.DEFAULT_MEMORY_DIR)) {
  memories = resolve(CFG.DEFAULT_MEMORY_DIR);
  memorySource = 'local-config';
} else if (discovered.length) {
  memories = discovered[0].dir;
  memorySource = 'discovered';
} else {
  memories = bundled;
  memorySource = 'bundled';
}
if (!existsSync(memories)) mkdirSync(memories, { recursive: true });
let memoryCount = 0;
try { memoryCount = readdirSync(memories).filter((f) => f.endsWith('.md')).length; } catch {}

// 🟥 MEM-32 — THE LIBRARY FOLDER MUST BE NAMED, NOT LEFT TO THE DEFAULT.
//
// This snippet sets MEMORY_DIR, and lib/config.js reads an explicit MEMORY_DIR as
// "measure THIS corpus and nothing else": it drops every library root unless
// MEMORY_LIBRARY_DIR is ALSO named. So the config this page generated switched the
// library corpus off, and `import` with a category still answered ok:true — a fresh
// install imported a manual, was told it worked, and could never find it again.
// The 1.7.0 Windows box walked into exactly this.
//
// The value is the one the server itself would resolve (env > local-config
// `libraryDir` > ./memory-library beside the server), so naming it here changes WHERE
// nothing — it only stops the suppression. A portable bundle has no local-config to read
// a libraryDir from, so it is pinned to its own folder. (The MEMORY folder is chosen the
// other way round — see MEM-66 above: imported books arrive with the install, memories
// were already on the machine.)
let library = process.env.MEMORY_LIBRARY_DIR ? resolve(process.env.MEMORY_LIBRARY_DIR)
  : (!isPortable && typeof CFG.libraryBaseDir === 'function' ? CFG.libraryBaseDir()
    : join(ROOT, 'memory-library'));
if (!existsSync(library)) mkdirSync(library, { recursive: true });
let libraryCategories = [];
try { libraryCategories = readdirSync(library, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name); } catch {}

const configPath = WIN
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

// ---- 🟥 MEM-82 — CLAUDE DESKTOP WRITES ITS CONFIG BACK ON QUIT --------------------------------
//
// Measured on the Windows PC, 2026-09-06 (acceptance of 1.7.2, F5). The tester edited
// claude_desktop_config.json to 1.7.2 at 05:44Z with Claude Desktop RUNNING; the user quit from
// the tray at ~05:52Z; the relaunched connector came back as 1.6.3@1bb49da and the file on disk
// had reverted to its original 09-04 entry. Claude Desktop holds the config in memory and writes
// its cached copy back on exit, so an edit made while it runs is discarded — silently, with no
// error anywhere. That is also why 1.7.1 never became the live connector on that machine: two
// releases were installed, verified as files, and never actually loaded.
//
// The order is the whole fix, and it is not obvious enough to leave implicit:
//     QUIT Claude completely  ->  edit the config  ->  launch Claude  ->  verify serverVersion.
// The verify step is not decoration: it is the only way to tell "the edit stuck" from "the edit
// was reverted", which is exactly the distinction the tester lost two restarts to.
const QUIT_FIRST_SENTENCE = 'QUIT Claude Desktop completely BEFORE editing its config; edit; then launch; then verify serverVersion.';
const QUIT_HOW = WIN ? 'right-click the Claude icon in the system tray and choose Quit — closing the window only hides it'
  : 'press Cmd-Q in Claude, or Claude menu → Quit Claude — closing the window only hides it';

/**
 * Is Claude Desktop running right now? Best-effort and NEVER fatal: a false negative just means
 * the page shows the warning without naming the process, which is the state every other install
 * document is in already.
 *
 * The listing is injectable through MEMORY_SETUP_PROCESS_LIST so the suite can exercise both
 * branches on any machine — spawning a real Claude Desktop in a test is not a test.
 */
function claudeDesktopRunning() {
  const injected = process.env.MEMORY_SETUP_PROCESS_LIST;
  let listing = injected;
  if (listing === undefined) {
    try {
      const r = WIN
        ? spawnSyncHidden('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000 })
        : spawnSyncHidden('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 8000 });
      listing = String((r && r.stdout) || '');
    } catch { listing = ''; }
  }
  // WIN: the image name is Claude.exe. Mac: the executable is .../Claude.app/Contents/MacOS/Claude,
  // so match the path tail rather than a bare word — "Claude" alone also matches Claude Code's own
  // helpers and would warn a Claude Code user about a Desktop app they are not running.
  const re = WIN ? /(^|[\\/",\s])Claude\.exe\b/mi : /Claude\.app\/Contents\/MacOS\/Claude/;
  return re.test(String(listing || ''));
}
const desktopRunning = claudeDesktopRunning();

// The version the reader should see AFTER the relaunch. Stating the number turns "verify
// serverVersion" from an instruction nobody can act on into one with a pass/fail.
let expectVersion = '';
try {
  const V = await import(pathToFileURL(join(ROOT, 'lib', 'version.js')).href);
  expectVersion = typeof V.serverVersionString === 'function' ? V.serverVersionString() : '';
} catch { expectVersion = ''; }

// ---- the OPTIONAL capture hooks (Claude Code only) --------------------------------
// Without a Stop hook, the LAST exchange of a session is captured only by the timed walker,
// which defers an in-flight turn — so it lands minutes later, or on the hourly audit (MEM-67).
// With one it lands when the turn ends. The Windows 1.7.1 tester stopped short of editing
// settings.json by hand and was right to: this page SHOWS the change and the one command that
// makes it, and nothing here or in the launchers performs it. Shown only when the file exists,
// because hooks are a Claude CODE feature and Claude Desktop never reads it.
const hooksSettingsPath = join(homedir(), '.claude', 'settings.json');
const hooksAvailable = existsSync(hooksSettingsPath);
const fwdSlash = (p) => p.replace(/\\/g, '/');
const hookScript = existsSync(join(ROOT, 'dist', 'capture', 'scripts', 'auto-ingest.js'))
  ? join(ROOT, 'dist', 'capture', 'scripts', 'auto-ingest.js')
  : join(ROOT, 'scripts', 'auto-ingest.js');
// 🟥 AN ABSOLUTE NODE, NOT THE BARE WORD. The MCP snippet above may say "node" and let the
// client's PATH find it; a HOOK is spawned by Claude Code without a login shell, so on macOS
// /usr/local/bin need not be on its PATH and a bare `node` fails silently at the end of a turn.
// packaging/install-hooks.mjs resolves it the same way (bundled runtime, else the node running
// this file), and (a90) compares the two strings character for character — a page that shows one
// command while the installer writes another sends the reader to check the wrong line.
const hookNode = existsSync(nodeBin) ? nodeBin : process.execPath;
const hookCommand = `"${fwdSlash(hookNode)}" "${fwdSlash(hookScript)}"`;
const hookJson = JSON.stringify({
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 900, statusMessage: 'Capturing conversation to memory', async: true }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 900, statusMessage: 'Ingesting conversation into memory', async: true }] }]
  }
}, null, 2);
const installHooksCmd = `"${fwdSlash(hookNode)}" "${fwdSlash(join(ROOT, 'packaging', 'install-hooks.mjs'))}"`;

const snippet = {
  mcpServers: {
    memory: {
      command: existsSync(nodeBin) ? nodeBin : 'node',
      args: [entry],
      // BOTH, always. MEMORY_DIR alone suppresses the library corpus (MEM-32).
      env: { MEMORY_DIR: memories, MEMORY_LIBRARY_DIR: library },
    },
  },
};
const snippetJson = JSON.stringify(snippet, null, 2);

// ---- smoke test: does this machine actually run it? -------------------------
// I could not test Windows from the machine that built this zip, so the check runs
// HERE instead of being asserted there. A red badge with the real error beats a
// green claim that was never executed.
let smoke = { ok: false, detail: '', dims: 0, server: false };

// Test the SERVER'S OWN code path, not a lookalike. An earlier draft of this page
// embedded with all-MiniLM via a hand-rolled pipeline() call — which would have
// reached the network for a model this build does not even use, and proved nothing
// about the cache that actually ships. lib/embed.js reads EMBEDDING.model and
// modelCacheDir() from lib/config.js, so testing through it tests what will run.
try {
  const t0 = Date.now();
  const { embedQuery, embeddingsDisabledReason } = await import(pathToFileURL(join(ROOT, 'lib', 'embed.js')).href);
  const v = await embedQuery('hello world');
  const why = embeddingsDisabledReason();
  if (v && v.length) smoke = { ok: true, server: true, dims: v.length, detail: `${((Date.now() - t0) / 1000).toFixed(1)}s` };
  else smoke = { ok: false, server: true, dims: 0, detail: why || 'embedQuery returned nothing' };
} catch (e) {
  smoke = { ok: false, server: false, dims: 0, detail: String((e && e.message) || e).slice(0, 400) };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// WHICH BRANCH THIS PAGE TOOK, IN THE PAGE. A reader cannot check a precedence rule they
// cannot see, and the 1.7.1 failure (MEM-66) was invisible precisely because the page named
// a folder without saying why it was that one.
const otherProjects = discovered.slice(memorySource === 'discovered' ? 1 : 0);
const alsoFound = otherProjects.length
  ? ` Also found: ${otherProjects.map((d) => `${d.dir} (${d.n})`).join(', ')}.`
  : '';
const memoryChosen = {
  env: `Chosen because <code>MEMORY_DIR</code> is set in this shell's environment.`,
  'local-config': `Chosen from <code>memoryDir</code> in this install's <code>local-config.json</code>.`,
  discovered: `Found automatically: this is your existing Claude memory folder under ` +
    `<code>~/.claude/projects/</code>, the folder with the most memories in it.${esc(alsoFound)}`,
  bundled: `This is the <strong>bundled starter folder</strong> that came with the download — ` +
    `no existing Claude memory folder (<code>~/.claude/projects/&lt;project&gt;/memory</code>) ` +
    `with any <code>.md</code> files in it was found on this computer. That is normal on a new ` +
    `machine. If you know where your memories are, put that path in <code>MEMORY_DIR</code> instead.`
}[memorySource];

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Add the Memory server to Claude</title>
<style>
 :root{--bg:#faf9f7;--fg:#1a1a19;--mut:#6b6b68;--line:#e3e0da;--card:#fff;--acc:#c15f3c;--ok:#2f7d52;--bad:#b3261e;--warn:#a86432}
 @media(prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#eeece7;--mut:#a3a09a;--line:#33322f;--card:#232320;--acc:#e0805c}}
 *{box-sizing:border-box}
 body{margin:0;padding:40px 20px;background:var(--bg);color:var(--fg);
      font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
 .wrap{max-width:820px;margin:0 auto}
 h1{font-size:28px;margin:0 0 6px} h2{font-size:18px;margin:34px 0 10px}
 .sub{color:var(--mut);margin:0 0 26px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:14px 0}
 pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px;
     overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0}
 .btn{background:var(--acc);color:#fff;border:0;border-radius:7px;padding:9px 16px;
      font-size:14px;font-weight:600;cursor:pointer;margin-bottom:10px}
 .btn:active{transform:translateY(1px)}
 .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600}
 .ok{background:rgba(47,125,82,.14);color:var(--ok)} .bad{background:rgba(179,38,30,.14);color:var(--bad)}
 .warn{background:rgba(193,95,60,.16);color:var(--acc)}
 ol{padding-left:22px} li{margin:8px 0}
 code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:13px}
 .path{word-break:break-all;color:var(--mut);font:13px ui-monospace,Menlo,Consolas,monospace}
 .danger{border-color:var(--bad);border-width:2px}
 .shout{margin:0;color:var(--bad);font-weight:700}
</style></head><body><div class="wrap">
<h1>Add the Memory server to Claude</h1>
<p class="sub">Generated on this computer — the paths below are the real ones. ${esc(platform())}/${esc(arch())}, bundled Node ${esc(process.version)}.</p>

<div class="card">
  <strong>Does it run here?</strong>
  ${smoke.ok
    ? `<span class="badge ok">YES — embeddings working (${esc(smoke.dims)} dims, ${esc(smoke.detail)})</span>
       <p class="sub" style="margin:10px 0 0">The bundled runtime and the search model both work on this machine. Nothing else to install.</p>`
    : smoke.server
      ? `<span class="badge warn">PARTLY — it runs, but smart search is off</span>
         <p class="sub" style="margin:10px 0 0">The server itself loaded, so it will work and you can wire it into Claude.
         What failed is the embedding model, so search falls back to keyword-only — it still finds things,
         it is just less good at matching meaning. Reason:</p>
         <pre>${esc(smoke.detail)}</pre>`
      : `<span class="badge bad">NO — it failed here</span>
         <p class="sub" style="margin:10px 0 0">Do not wire this into Claude yet; it would fail silently. The error was:</p>
         <pre>${esc(smoke.detail)}</pre>`}
</div>

<h2>1. Copy this</h2>
<div class="card">
  <button class="btn" onclick="copyIt()">Copy the config</button>
  <span id="done" style="color:var(--ok);font-size:14px"></span>
  <pre id="snip">${esc(snippetJson)}</pre>
</div>

<h2>2. Quit Claude Desktop — before you edit anything</h2>
<div class="card danger">
  <p class="shout">${esc(QUIT_FIRST_SENTENCE)}</p>
  ${desktopRunning ? `<p class="shout" style="margin:10px 0 0">⚠ Claude Desktop is RUNNING on this computer right now
     (${esc(WIN ? 'Claude.exe' : 'Claude.app/Contents/MacOS/Claude')} is in the process list). Quit it before step 3.</p>` : ''}
  <p style="margin:10px 0 0">Claude Desktop keeps its config in memory and <strong>writes its own copy back
  over the file when it quits</strong>. Edit the file while Claude is running and your change is thrown
  away the moment the app exits — with no error, and a config on disk that looks like you never
  touched it. On a real machine this cost two restarts and left an old version live for a day.</p>
  <p class="sub" style="margin:10px 0 0">To quit properly: ${esc(QUIT_HOW)}.</p>
</div>

<h2>3. Paste it here</h2>
<div class="card">
  <p style="margin:0 0 8px">With Claude closed, open this file in a text editor:</p>
  <pre>${esc(configPath)}</pre>
  <p class="sub" style="margin:10px 0 0">
    If the file already exists and has <code>mcpServers</code>, add the <code>"memory"</code>
    block inside it — do not replace the whole file, or you will remove your other servers.
    If the file does not exist, create it and paste the whole thing.
  </p>
</div>

<h2>4. Launch Claude, then check the version</h2>
<div class="card">
  <p style="margin:0">Start Claude and ask it something like <em>“search my memory for …”</em>.
  Every answer the memory server returns carries a <code>serverVersion</code> field${expectVersion
    ? `, and it should read <code>${esc(expectVersion)}</code>` : ''}.</p>
  <p class="shout" style="margin:10px 0 0">If <code>serverVersion</code> is an older one, the edit was
  reverted — quit Claude completely and do steps 2 and 3 again. This check is the only way to tell
  a saved config from a discarded one.</p>
</div>

<h2>Where your memories go</h2>
<div class="card">
  <p style="margin:0 0 8px">Claude will read Markdown files from this folder:</p>
  <p class="path">${esc(memories)}</p>
  <p class="sub" style="margin:8px 0 0"><strong>${esc(memoryCount)}</strong> memory file${memoryCount === 1 ? '' : 's'} in there right now.</p>
  <p class="sub" style="margin:10px 0 0">${memoryChosen}</p>
  <p class="sub" style="margin:10px 0 0">
    <strong>To use a different folder</strong>, edit the <code>MEMORY_DIR</code> line in the
    config above and restart Claude. Nothing is copied or moved: the value is just the folder
    the server reads.
  </p>
  <p class="sub" style="margin:10px 0 0">
    If you were given a separate <code>memory-*-scrubbed.zip</code>, unzip it and copy the
    <code>.md</code> files in there into the folder above. <code>MEMORY.md</code> is the index.
  </p>
</div>

<h2>Books, manuals and other reference material</h2>
<div class="card">
  <p style="margin:0 0 8px">Imported books and manuals go in their own folder, one sub-folder per category:</p>
  <p class="path">${esc(library)}</p>
  <p class="sub" style="margin:8px 0 0">${libraryCategories.length
    ? `<strong>${esc(libraryCategories.length)}</strong> categor${libraryCategories.length === 1 ? 'y' : 'ies'} right now: ${esc(libraryCategories.join(', '))}.`
    : 'No categories yet — <code>import</code> creates one for you.'}</p>
  <p class="sub" style="margin:10px 0 0">
    <strong>Keep <code>MEMORY_LIBRARY_DIR</code> in the config above.</strong> The server reads an
    explicit <code>MEMORY_DIR</code> as “search this folder and nothing else”, so deleting the
    library line does not merely change a path — it switches reference material off, and importing
    a manual then reports success for a document nothing can find.
  </p>
</div>

${hooksAvailable ? `
<h2>Instant capture at the end of every turn (optional)</h2>
<div class="card">
  <p style="margin:0 0 8px">The server already captures conversations on its own, every five minutes.
  What it cannot do on its own is capture the <strong>last</strong> exchange of a chat you then walk
  away from — nothing tells it the turn is over, so that one waits for a later sweep.</p>
  <p class="sub" style="margin:0 0 10px">A Claude <strong>Code</strong> hook fixes that: it runs the
  capture the moment a turn ends. This is optional, and nothing on this page has changed anything —
  you have a settings file at <span class="path">${esc(hooksSettingsPath)}</span>, so here is what to add
  and the one command that adds it.</p>
  <button class="btn" onclick="copyHooks()">Copy the command</button>
  <span id="hdone" style="color:var(--ok);font-size:14px"></span>
  <pre id="hookcmd">${esc(installHooksCmd)}</pre>
  <p class="sub" style="margin:10px 0 0">It backs the file up first, adds only the two entries below,
  leaves every other hook alone, does nothing on a second run, and undoes itself with
  <code>--uninstall</code>. If a <em>different</em> copy of this server is already installed as a hook,
  it stops and tells you rather than capturing everything twice.</p>
  <p class="sub" style="margin:10px 0 6px">What it adds:</p>
  <pre>${esc(hookJson)}</pre>
  <p class="sub" style="margin:10px 0 0">Claude Code reads this file when a session starts, so open a
  new session afterwards.</p>
</div>` : ''}

<script>
function copyHooks(){
  var el = document.getElementById('hookcmd');
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(function(){
    document.getElementById('hdone').textContent = 'Copied — paste it in a terminal';
    setTimeout(function(){document.getElementById('hdone').textContent='';},2600);
  }, function(){
    document.getElementById('hdone').textContent = 'Select the line above and copy it';
  });
}
function copyIt(){
  var t = document.getElementById('snip').innerText;
  navigator.clipboard.writeText(t).then(function(){
    document.getElementById('done').textContent = 'Copied';
    setTimeout(function(){document.getElementById('done').textContent='';},2200);
  }, function(){
    var r=document.createRange(); r.selectNode(document.getElementById('snip'));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.getElementById('done').textContent = 'Press Ctrl/Cmd+C';
  });
}
</script>
</div></body></html>`;

// ROOT unless a caller names somewhere else. The override exists for the suite: this script's
// real output is two files, and a test that has to write them into the repository to read them
// is the leak class test/sandbox-env.js exists to prevent.
const OUT = process.env.MEMORY_SETUP_OUT ? resolve(process.env.MEMORY_SETUP_OUT) : ROOT;
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const outPath = join(OUT, 'SETUP.html');
writeFileSync(outPath, html);
writeFileSync(join(OUT, 'claude-config-snippet.json'), snippetJson + '\n');
console.log('  Wrote ' + outPath);
// 🟥 MEM-82 IN THE LAUNCHER WINDOW TOO. The console is the only output a user who never opens
// SETUP.html sees, and this is the one instruction whose ORDER decides whether the install takes
// effect at all. Printed before the folder lines so it is not the thing that scrolls away.
console.log('');
console.log('  *** ' + QUIT_FIRST_SENTENCE + ' ***');
console.log('      Claude Desktop rewrites its config from memory when it quits, so an edit made');
console.log('      while it is running is silently discarded. ' + QUIT_HOW + '.');
if (desktopRunning) {
  console.log('      WARNING: Claude Desktop is RUNNING right now ('
    + (WIN ? 'Claude.exe' : 'Claude.app/Contents/MacOS/Claude') + ' is in the process list) — quit it first.');
}
if (expectVersion) console.log('      After launching, check serverVersion reads ' + expectVersion + '.');
console.log('');
// SAY WHICH FOLDER, IN THE TERMINAL TOO. The launcher window is the only output a user
// who never opens SETUP.html sees, and MEM-66 was a wrong folder chosen silently.
console.log('  Memories: ' + memories + '  (' + memoryCount + ' .md, ' + {
  env: 'from MEMORY_DIR in the environment',
  'local-config': 'from local-config.json',
  discovered: 'found under ~/.claude/projects — your existing Claude memories',
  bundled: 'the bundled starter folder — no existing Claude memory folder found'
}[memorySource] + ')');
console.log('  Smoke test: ' + (smoke.ok ? 'PASS (' + smoke.dims + ' dims, ' + smoke.detail + ')'
  : (smoke.server ? 'DEGRADED — keyword-only: ' : 'FAIL — ') + smoke.detail.slice(0, 160)));
// Exit 0 when the server loads at all: a degraded install is still installable, and a
// non-zero exit would make the .cmd print a scary line for a working setup.
process.exit(smoke.server || smoke.ok ? 0 : 1);
