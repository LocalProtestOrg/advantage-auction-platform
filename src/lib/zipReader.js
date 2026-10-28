'use strict';

/**
 * zipReader — a small, bounded, in-memory ZIP reader for seller uploads (Excel .xlsx workbooks and photo ZIPs).
 *
 * Deliberately minimal and defensive (no third-party archive library):
 *   - Reads the central directory only; supports "stored" (0) and "deflate" (8) entries. Anything else, encrypted
 *     entries and ZIP64 archives are refused.
 *   - Every decompression is capped (zlib maxOutputLength), each entry's declared size, the total uncompressed size,
 *     the entry count and the compression ratio are limited, and the CRC is checked: a "ZIP bomb" fails fast.
 *   - Nothing is ever written to disk, so entry paths are only names (never used as file system paths).
 * Pure (no DB, no network).
 */

const zlib = require('zlib');

function zipErr(code, message) { const e = new Error(message); e.status = 422; e.code = code; return e; }

const DEFAULTS = { maxEntries: 1000, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 300 * 1024 * 1024, maxRatio: 200 };

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** List the entries of a ZIP buffer (names, sizes, offsets). Throws 422 ZIP_INVALID / ZIP_UNSUPPORTED / ZIP_TOO_LARGE. */
function listEntries(buf, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw zipErr('ZIP_INVALID', 'This file is not a valid ZIP archive.');
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw zipErr('ZIP_INVALID', 'This file is not a valid ZIP archive.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw zipErr('ZIP_UNSUPPORTED', 'Very large (ZIP64) archives are not supported. Split the photos into smaller ZIP files.');
  if (count > o.maxEntries) throw zipErr('ZIP_TOO_LARGE', `This ZIP has ${count} files; the limit is ${o.maxEntries}. Split it into smaller ZIP files.`);
  if (cdOffset + cdSize > eocd) throw zipErr('ZIP_INVALID', 'This ZIP archive is damaged.');
  const entries = [];
  let p = cdOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw zipErr('ZIP_INVALID', 'This ZIP archive is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    const isDir = name.endsWith('/');
    if (isDir) continue;
    if (flags & 0x1) throw zipErr('ZIP_UNSUPPORTED', 'Password-protected ZIP files are not supported.');
    if (method !== 0 && method !== 8) throw zipErr('ZIP_UNSUPPORTED', `"${name.slice(0, 80)}" uses an unsupported compression method. Re-create the ZIP with standard settings.`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw zipErr('ZIP_UNSUPPORTED', 'Very large (ZIP64) archives are not supported.');
    total += size;
    if (total > o.maxTotalBytes) throw zipErr('ZIP_TOO_LARGE', 'The files in this ZIP are too large in total. Split them into smaller ZIP files.');
    if (compressedSize > 0 && size / compressedSize > o.maxRatio) throw zipErr('ZIP_UNSUPPORTED', 'This ZIP archive is not supported (unusual compression).');
    entries.push({ name, method, crc, compressedSize, size, localOffset });
  }
  return entries;
}

/** Decompress one entry (from listEntries). Throws 422 if it is larger than maxEntryBytes or fails its CRC check. */
function readEntry(buf, entry, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (entry.size > o.maxEntryBytes) throw zipErr('ZIP_ENTRY_TOO_LARGE', `"${entry.name.slice(0, 80)}" is larger than ${Math.round(o.maxEntryBytes / 1048576)} MB.`);
  const lh = entry.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw zipErr('ZIP_INVALID', 'This ZIP archive is damaged.');
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) throw zipErr('ZIP_INVALID', 'This ZIP archive is damaged.');
  const raw = buf.slice(start, end);
  let out;
  if (entry.method === 0) out = Buffer.from(raw);
  else {
    try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(entry.size, o.maxEntryBytes)) }); }
    catch (e) { throw zipErr('ZIP_INVALID', `"${entry.name.slice(0, 80)}" could not be read from the ZIP.`); }
  }
  if (out.length !== entry.size || (zlib.crc32 && (zlib.crc32(out) >>> 0) !== (entry.crc >>> 0))) {
    throw zipErr('ZIP_INVALID', `"${entry.name.slice(0, 80)}" is damaged inside the ZIP.`);
  }
  return out;
}

module.exports = { listEntries, readEntry, DEFAULTS };
