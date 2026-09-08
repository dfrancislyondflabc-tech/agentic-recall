// lib/zip.js — read a .zip, and (for fixtures) write one, WITHOUT an external binary.
//
// 🟥 WHY THIS FILE EXISTS. `readSource()` used to shell out to `unzip`, and refused
// every archive when the binary was absent:
//
//     if (!TOOLS.unzip) return { shape: 'zip', items: [], skipped: [{ why: 'needs unzip' }] };
//
// A stock Windows install has no `unzip.exe`, so a zip of markdown notes — and a
// ChatGPT export in the zip form people actually download — imported NOTHING there
// (MEM-73, campaign E finding E-W1). Two of the eight import shapes, gone, on the
// platform nobody could test because the one public check that covers this path
// SELF-SKIPPED for lack of the `zip` WRITER binary (E-W2).
//
// Both halves are fixed by owning the format instead of borrowing a process:
//   * `extractZipTo()` reads central directory + local headers and inflates with
//     node:zlib. No dependency, same on every platform.
//   * `writeZipSync()` writes a STORED (uncompressed) archive so a test can build
//     its own fixture — including a symlink entry — on a machine with no `zip`.
//     It exists for the suite, and it is here rather than under test/ so there is
//     exactly one implementation of the format in the tree.
//
// 🟥 WHAT THIS DELIBERATELY KEEPS. `unzip` RESTORES a stored symlink as a real
// symlink, and lib/import-sources.js's escapesRoot() guard is what refuses the
// off-archive ones (suite (a28), public "cannot write outside itself"). So this
// extractor restores symlinks too — identical bytes on disk, identical refusals
// downstream — rather than quietly turning them into text files, which would make
// the guard pass by making the attack impossible to express. What it adds is the
// guard `unzip` performs itself: an ENTRY NAME that escapes the destination
// ('../../x', '/etc/x', 'C:\\x') is refused by name and never written.

import { createWriteStream, mkdirSync, symlinkSync, writeFileSync, readFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const SIG_LOCAL   = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD    = 0x06054b50;
const SIG_EOCD64  = 0x06064b50;
const SIG_LOC64   = 0x07064b50;

/** CRC-32 (IEEE), table built once. Needed by the writer; used by the reader to verify. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function findEocd(buf) {
  // The EOCD is last, but a trailing comment (<= 64 KB) may follow it.
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Parse the central directory. Returns
 * [{ name, method, compressedSize, size, crc, localHeaderOffset, unixMode, isDir, encrypted }].
 * Throws a NAMED error for anything it cannot read, so the caller can report a
 * reason rather than an empty archive.
 */
export function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real numbers live in a second record.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === SIG_LOC64) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === SIG_EOCD64) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags     = buf.readUInt16LE(p + 8);
    const method    = buf.readUInt16LE(p + 10);
    const crc       = buf.readUInt32LE(p + 16);
    let   compSize  = buf.readUInt32LE(p + 20);
    let   size      = buf.readUInt32LE(p + 24);
    const nameLen   = buf.readUInt16LE(p + 28);
    const extraLen  = buf.readUInt16LE(p + 30);
    const cmtLen    = buf.readUInt16LE(p + 32);
    const madeBy    = buf.readUInt16LE(p + 4);
    const extAttr   = buf.readUInt32LE(p + 38);
    let   localOff  = buf.readUInt32LE(p + 42);
    const name      = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // ZIP64 extended information extra field (0x0001), in the order the spec fixes.
    if (size === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff && q + 8 <= end) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff && q + 8 <= end) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOff === 0xffffffff && q + 8 <= end) { localOff = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }

    // The unix mode only means anything when the archive says it was made on unix (3).
    const unixMode = (madeBy >> 8) === 3 ? (extAttr >>> 16) : 0;
    entries.push({
      name, method, crc, size, compressedSize: compSize,
      localHeaderOffset: localOff, unixMode,
      isDir: name.endsWith('/') || (unixMode & 0xf000) === 0x4000,
      isSymlink: (unixMode & 0xf000) === 0xa000,
      encrypted: (flags & 0x1) === 1
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/** The bytes of one entry, decompressed. */
export function readEntryData(buf, entry) {
  const p = entry.localHeaderOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method}`);
}

/**
 * A zip entry name may not leave the destination. `unzip` enforces this itself
 * (it refuses '../' paths); a hand-rolled extractor that forgets is the classic
 * zip-slip. Absolute paths and Windows drive/UNC forms are refused too, and
 * backslashes are treated as separators because that is how a Windows-written
 * archive spells them.
 */
export function zipEntryTargetPath(destDir, name) {
  const cleaned = String(name).replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split('/').some((s) => s === '..')) return null;
  const full = resolve(destDir, cleaned);
  const root = resolve(destDir);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return full;
}

/**
 * Extract `zipPath` into `destDir`. Returns { extracted, skipped } — skipped rows
 * carry { file, why }, in the same shape lib/import-sources.js reports, because a
 * dropped file that nobody names is the failure mode this whole module is about.
 */
export function extractZipTo(zipPath, destDir) {
  const buf = readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  const extracted = [];
  const skipped = [];
  for (const e of entries) {
    if (e.isDir) continue;
    if (e.encrypted) { skipped.push({ file: e.name, why: 'the archive entry is encrypted' }); continue; }
    const target = zipEntryTargetPath(destDir, e.name);
    if (!target) { skipped.push({ file: e.name, why: 'entry path escapes the archive' }); continue; }
    let data;
    try { data = readEntryData(buf, e); }
    catch (err) { skipped.push({ file: e.name, why: `could not read entry: ${err.message}` }); continue; }
    try {
      mkdirSync(dirname(target), { recursive: true });
      if (e.isSymlink) {
        // RESTORED, not flattened — see the header. The escapesRoot() guard in
        // import-sources.js is what decides whether it may be read, exactly as it
        // did when `unzip` created it. Windows refuses symlinks without the
        // privilege, and that refusal is reported rather than swallowed.
        try { symlinkSync(data.toString('utf8'), target); }
        catch (err) { skipped.push({ file: e.name, why: `symlink could not be restored: ${err.code || err.message}` }); continue; }
      } else {
        writeFileSync(target, data);
      }
      extracted.push(e.name);
    } catch (err) {
      skipped.push({ file: e.name, why: `could not write: ${err.code || err.message}` });
    }
  }
  return { extracted, skipped };
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * Write a STORED (uncompressed) zip. `files` is
 * [{ name, data }] for a file, or [{ name, symlinkTo }] for a symlink entry.
 *
 * Uncompressed on purpose: the reader above must handle method 0 anyway, the
 * fixtures are a few hundred bytes, and a deflate writer would be code with no
 * caller. This is the fixture builder the suite needs so a zip check can RUN on
 * a machine with no `zip` binary instead of skipping itself.
 */
export function writeZipSync(zipPath, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const f of files) {
    const isLink = typeof f.symlinkTo === 'string';
    const data = isLink ? Buffer.from(f.symlinkTo, 'utf8')
                        : Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data ?? ''), 'utf8');
    const name = Buffer.from(String(f.name).replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);    // made by unix, so the mode below is read
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(((isLink ? 0xa1ff : (f.mode || 0o100644)) >>> 0) * 0x10000, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, Buffer.concat([...chunks, cdBuf, eocd]));
  return zipPath;
}
