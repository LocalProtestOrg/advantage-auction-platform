'use strict';

/**
 * uploadValidation — server-side validation for seller verification document uploads.
 * Pure + dependency-free so it is unit-testable and reusable.
 *
 * Defense in depth: an allowlist of safe document/image types, each cross-checked by
 * (1) file extension, (2) declared MIME, and (3) magic bytes sniffed from the actual
 * bytes. The client filename and content-type are NEVER trusted on their own — the
 * sniffed type is authoritative. Dangerous formats (.exe/.js/.html/.svg/.zip/...) are
 * rejected both by exclusion (not in the allowlist) and by an explicit deny list.
 */

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

// Allowed types — the task's preferred safe set. Each: canonical ext, canonical MIME,
// accepted MIME aliases, and a magic-byte matcher over the buffer.
const ALLOWED = {
  pdf:  { ext: 'pdf',  mime: 'application/pdf', mimes: ['application/pdf'], match: (b) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 }, // %PDF
  jpg:  { ext: 'jpg',  mime: 'image/jpeg', mimes: ['image/jpeg', 'image/jpg'], match: (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },                 // JPEG SOI
  png:  { ext: 'png',  mime: 'image/png',  mimes: ['image/png'], match: (b) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },             // \x89PNG
  webp: { ext: 'webp', mime: 'image/webp', mimes: ['image/webp'], match: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }, // RIFF....WEBP
};
// jpeg/jpg are the same type.
const EXT_ALIAS = { jpeg: 'jpg' };
// Explicit deny list (defense in depth; these are also simply not in ALLOWED).
const DENY_EXT = ['exe', 'js', 'mjs', 'html', 'htm', 'svg', 'zip', 'rar', 'bat', 'cmd', 'msi', 'sh', 'php', 'jar', 'com', 'scr', 'dll', 'gz', '7z', 'apk', 'dmg'];

function extFromName(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const base = filename.split(/[\\/]/).pop();           // strip any path
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase().trim();
}

// Never trust the original filename. Strip path, keep [A-Za-z0-9._-], collapse, cap length.
function sanitizeFilename(filename, fallbackExt) {
  let base = (filename && typeof filename === 'string') ? filename.split(/[\\/]/).pop() : '';
  base = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_{2,}/g, '_').replace(/^[._]+/, '').slice(0, 120);
  if (!base) base = 'document' + (fallbackExt ? ('.' + fallbackExt) : '');
  return base;
}

// Sniff the canonical type key ('pdf'|'jpg'|'png'|'webp') from the bytes, else null.
function sniffType(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  for (const key of Object.keys(ALLOWED)) {
    if (ALLOWED[key].match(buffer)) return key;
  }
  return null;
}

/**
 * Validate a verification-document upload.
 * @returns {{ ok: true, type, ext, mime, safeFilename }} on success
 * @throws  {Error & {code,status}} on rejection
 */
function validateDocumentUpload({ filename, contentType, buffer }) {
  const fail = (code, message, status = 400) => { const e = new Error(message); e.code = code; e.status = status; throw e; };

  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('FILE_REQUIRED', 'A document file is required');
  if (buffer.length > MAX_BYTES) fail('FILE_TOO_LARGE', 'Document exceeds the 15 MB limit', 413);

  const rawExt = extFromName(filename);
  const ext = EXT_ALIAS[rawExt] || rawExt;
  if (rawExt && DENY_EXT.includes(rawExt)) fail('UNSUPPORTED_TYPE', `File type ".${rawExt}" is not allowed. Allowed: PDF, JPG, PNG, WEBP.`);

  // Authoritative: sniff the real bytes.
  const sniffed = sniffType(buffer);
  if (!sniffed) fail('UNSUPPORTED_TYPE', 'File content is not a supported document type. Allowed: PDF, JPG, PNG, WEBP.');

  // Extension (when present) must agree with the sniffed type.
  if (ext && ext !== sniffed && !(sniffed === 'jpg' && ext === 'jpg')) {
    fail('TYPE_MISMATCH', `File extension ".${rawExt}" does not match its actual content (${sniffed}).`);
  }
  // Declared MIME (when present) must be in the sniffed type's allowed MIME set.
  if (contentType) {
    const ct = String(contentType).split(';')[0].trim().toLowerCase();
    if (!ALLOWED[sniffed].mimes.includes(ct)) {
      fail('TYPE_MISMATCH', `Declared content type "${ct}" does not match the file content (${sniffed}).`);
    }
  }

  return {
    ok: true,
    type: sniffed,
    ext: ALLOWED[sniffed].ext,
    mime: ALLOWED[sniffed].mime,           // canonical MIME (overrides client-declared)
    safeFilename: sanitizeFilename(filename, ALLOWED[sniffed].ext),
  };
}

module.exports = { MAX_BYTES, ALLOWED, DENY_EXT, extFromName, sanitizeFilename, sniffType, validateDocumentUpload };
