'use strict';

/**
 * Verification document upload validation (Part B hardening).
 * Allowlist (PDF/JPG/PNG/WEBP) cross-checked by extension + declared MIME + sniffed
 * magic bytes; dangerous types rejected; filename sanitized; size capped.
 */
const { validateDocumentUpload, sniffType, sanitizeFilename, MAX_BYTES } = require('../src/lib/uploadValidation');

const PDF  = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50, 0x20)]);
const PNG  = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(50, 0)]);
const JPG  = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(50, 0)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(50, 0)]);
const EXE  = Buffer.concat([Buffer.from([0x4D, 0x5A]), Buffer.alloc(50, 0)]);   // MZ
const SVG  = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>x</script>');

describe('sniffType', () => {
  test('detects allowed types by magic bytes', () => {
    expect(sniffType(PDF)).toBe('pdf');
    expect(sniffType(PNG)).toBe('png');
    expect(sniffType(JPG)).toBe('jpg');
    expect(sniffType(WEBP)).toBe('webp');
  });
  test('returns null for non-allowed content', () => {
    expect(sniffType(EXE)).toBeNull();
    expect(sniffType(SVG)).toBeNull();
    expect(sniffType(HTML)).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });
});

describe('sanitizeFilename — never trust the original name', () => {
  test('strips path traversal + unsafe chars', () => {
    expect(sanitizeFilename('../../etc/pa ss<wd>.png')).toBe('pa_ss_wd_.png');
    expect(sanitizeFilename('C:\\evil\\shell.pdf')).toBe('shell.pdf');
  });
  test('falls back when empty', () => {
    expect(sanitizeFilename('', 'pdf')).toBe('document.pdf');
  });
  test('caps length', () => {
    expect(sanitizeFilename('a'.repeat(300) + '.png').length).toBeLessThanOrEqual(120);
  });
});

describe('validateDocumentUpload — accepts safe types', () => {
  test('PDF with matching name + MIME', () => {
    const r = validateDocumentUpload({ filename: 'id.pdf', contentType: 'application/pdf', buffer: PDF });
    expect(r).toMatchObject({ ok: true, type: 'pdf', ext: 'pdf', mime: 'application/pdf', safeFilename: 'id.pdf' });
  });
  test('JPG (jpeg alias) accepted', () => {
    expect(validateDocumentUpload({ filename: 'photo.jpeg', contentType: 'image/jpeg', buffer: JPG }).type).toBe('jpg');
  });
  test('PNG accepted', () => {
    expect(validateDocumentUpload({ filename: 'scan.png', contentType: 'image/png', buffer: PNG }).type).toBe('png');
  });
  test('WEBP accepted', () => {
    expect(validateDocumentUpload({ filename: 'img.webp', contentType: 'image/webp', buffer: WEBP }).type).toBe('webp');
  });
  test('canonical MIME overrides a client-declared alias; filename sanitized', () => {
    const r = validateDocumentUpload({ filename: '../My Passport!!.PDF', contentType: 'application/pdf', buffer: PDF });
    expect(r.mime).toBe('application/pdf');
    expect(r.safeFilename).toBe('My_Passport_.PDF');
  });
});

describe('validateDocumentUpload — rejects dangerous / mismatched', () => {
  const reject = (args, code) => {
    let err;
    try { validateDocumentUpload(args); } catch (e) { err = e; }
    expect(err).toBeDefined();
    if (code) expect(err.code).toBe(code);
  };
  test('executable (MZ) rejected', () => reject({ filename: 'malware.exe', contentType: 'application/octet-stream', buffer: EXE }));
  test('.js rejected by extension deny-list', () => reject({ filename: 'x.js', contentType: 'text/javascript', buffer: PDF }, 'UNSUPPORTED_TYPE'));
  test('.html rejected', () => reject({ filename: 'x.html', contentType: 'text/html', buffer: HTML }));
  test('.svg rejected', () => reject({ filename: 'x.svg', contentType: 'image/svg+xml', buffer: SVG }));
  test('.zip rejected', () => reject({ filename: 'x.zip', contentType: 'application/zip', buffer: Buffer.from('PK\x03\x04') }));
  test('extension/content mismatch rejected (png bytes named .pdf)', () => reject({ filename: 'fake.pdf', contentType: 'application/pdf', buffer: PNG }, 'TYPE_MISMATCH'));
  test('declared MIME mismatch rejected (pdf bytes declared image/png)', () => reject({ filename: 'real.pdf', contentType: 'image/png', buffer: PDF }, 'TYPE_MISMATCH'));
  test('empty file rejected', () => reject({ filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.alloc(0) }, 'FILE_REQUIRED'));
  test('oversize rejected', () => reject({ filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_BYTES + 10, 0x20)]) }, 'FILE_TOO_LARGE'));
});
