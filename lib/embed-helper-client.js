// lib/embed-helper-client.js — ESM twin of the Email Backup app's lib/embed-helper/client.js (MEM-112, 2026-11-25).
// Talks to the ONE shared embedding helper (Harrier on the GPU), starting it when it is not running. The helper itself
// (helper.mjs, node-llama-cpp, the model) lives in ~/Library/Application Support/EmbedHelper, installed by the Email
// Backup app's scripts/install-embed-helper.sh — this package never ships a model.
//
// The helper lives OUTSIDE every app, in HELPER_DIR (~/Library/Application Support/EmbedHelper): helper.mjs, its
// node_modules (node-llama-cpp), models/harrier-oss-v1-0.6b-f16.gguf, and helper.json (port + token, 0600) while it
// runs. Installed by scripts/install-embed-helper.sh — never shipped in a distribution zip.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HELPER_DIR = process.env.EMBED_HELPER_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'EmbedHelper');
const INFO = path.join(HELPER_DIR, 'helper.json');
const LOCK = path.join(HELPER_DIR, 'start.lock');
const START_TIMEOUT_MS = 60000;
const MAX_PER_CALL = 64;

function installed() {
  return fs.existsSync(path.join(HELPER_DIR, 'helper.mjs')) &&
         fs.existsSync(path.join(HELPER_DIR, 'node_modules', 'node-llama-cpp')) &&
         fs.existsSync(path.join(HELPER_DIR, 'models', 'harrier-oss-v1-0.6b-f16.gguf'));
}
function whyNotInstalled() {
  if (installed()) return null;
  return `the shared embedding helper is not installed in ${HELPER_DIR} (run scripts/install-embed-helper.sh)`;
}

function readInfo() { try { return JSON.parse(fs.readFileSync(INFO, 'utf8')); } catch (_) { return null; } }

function request(info, method, urlPath, body, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: info.port, method, path: urlPath, timeout: timeoutMs,
      headers: { Authorization: `Bearer ${info.token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} if (res.statusCode === 200 && j) resolve(j); else reject(new Error(`embed helper HTTP ${res.statusCode}: ${(j && j.error) || buf.slice(0, 200)}`)); });
    });
    req.on('timeout', () => { req.destroy(new Error('embed helper timed out')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function alive(info) {
  if (!info || !info.port || !info.token) return false;
  try { process.kill(info.pid, 0); } catch (_) { return false; }
  try { const h = await request(info, 'GET', '/health', null, 3000); return !!(h && h.ok); }
  // EB-475: a LIVE process that is slow to answer is BUSY (a long batch, or a Mac under memory pressure), not dead.
  // Treating that timeout as dead started a new helper every ~35 s (7 at once, ~300 MB each). Only a dead pid or a
  // refused connection means "start one".
  catch (e) { return /timed out/i.test(String(e && e.message)); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the helper unless another process is already starting it (the lock file). Every app shares ONE helper.
async function ensure() {
  let info = readInfo();
  if (await alive(info)) return info;
  const why = whyNotInstalled();
  if (why) throw new Error(why);
  let haveLock = false;
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); haveLock = true; }
  catch (_) {
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > START_TIMEOUT_MS) { fs.rmSync(LOCK, { force: true }); fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); haveLock = true; } } catch (_) {}
  }
  try {
    if (haveLock) {
      const node = process.env.EMBED_HELPER_NODE || process.execPath;
      const logFd = fs.openSync(path.join(HELPER_DIR, 'helper.log'), 'a');
      const child = spawn(node, [path.join(HELPER_DIR, 'helper.mjs')], { cwd: HELPER_DIR, detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, EMBED_HELPER_DIR: HELPER_DIR } });
      child.unref();
      fs.closeSync(logFd);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < START_TIMEOUT_MS) {
      info = readInfo();
      if (await alive(info)) return info;
      await sleep(500);
    }
    throw new Error('embed helper did not start within 60 s (see ' + path.join(HELPER_DIR, 'helper.log') + ')');
  } finally { if (haveLock) { try { fs.rmSync(LOCK, { force: true }); } catch (_) {} } }
}

/**
 * Embed texts with the shared helper. kind 'query' gets the model's instruction (added by the helper); 'passage' is bare.
 * @returns {Promise<{vecs: Float32Array[], dim: number, model: string, queryPrefix: string}>}
 */
async function embed(texts, { kind = 'passage' } = {}) {
  const list = (texts || []).map((t) => String(t == null ? '' : t));
  if (!list.length) return { vecs: [], dim: 0, model: null, queryPrefix: null };
  let info = await ensure();
  const vecs = []; let meta = null;
  for (let i = 0; i < list.length; i += MAX_PER_CALL) {
    let r;
    try { r = await request(info, 'POST', '/embed', { texts: list.slice(i, i + MAX_PER_CALL), kind }); }
    catch (e) {                                   // the helper may have idled out between calls: start it once more
      info = await ensure();
      r = await request(info, 'POST', '/embed', { texts: list.slice(i, i + MAX_PER_CALL), kind });
    }
    meta = r;
    for (const v of r.vecs) vecs.push(Float32Array.from(v));
  }
  return { vecs, dim: meta.dim, model: meta.model, queryPrefix: meta.queryPrefix };
}

export { embed, ensure, installed, whyNotInstalled, HELPER_DIR, alive as _aliveForTest };
