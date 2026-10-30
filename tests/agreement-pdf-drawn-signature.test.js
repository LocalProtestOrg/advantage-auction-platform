'use strict';

// The signed PDF shows the drawn signature itself (the PNG the seller submitted). The image is untrusted browser
// input: only a verified PNG is embedded, and a malformed one can never crash the process or block the PDF.
const zlib = require('zlib');
const pdf = require('../src/services/agreementPdfService');

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 4)); for (let y = 0; y < h; y++) raw[y * (1 + w * 4)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const AGREEMENT = { id: 'a1', version_int: 3, rendered_body: '# Title\n\n## 6. Fees\n\n**Bold** text', party_snapshot: { legal_name: 'Pat' } };
const SIG = { typed_name: 'Pat', signer_role: 'seller', signed_at: new Date('2026-10-30T12:00:00Z'), consent_acknowledged: true, intent_statement: 'I intend', content_sha256: 'abc' };

test('a verified drawn signature is embedded as an image', async () => {
  const withImage = await pdf.buildPdfBuffer(AGREEMENT, { ...SIG, drawn_image_png: png(40, 20) });
  const without = await pdf.buildPdfBuffer(AGREEMENT, SIG);
  expect(withImage.slice(0, 5).toString()).toBe('%PDF-');
  expect(withImage.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  expect(without.toString('latin1')).not.toMatch(/\/Subtype\s*\/Image/);
});

test.each([
  ['not a PNG', Buffer.from('not a png at all, just text that is long enough to pass the size check........')],
  ['a PNG whose image data does not inflate', (() => { const b = png(10, 10); b[b.length - 20] ^= 0xff; return b; })()],
  ['a truncated PNG', png(10, 10).slice(0, 50)],
  ['an oversized PNG', png(3000, 2000)],
])('%s is skipped and the PDF is still produced', async (_label, buf) => {
  expect(pdf.safePng(buf)).toBeNull();
  const out = await pdf.buildPdfBuffer(AGREEMENT, { ...SIG, drawn_image_png: buf });
  expect(out.slice(0, 5).toString()).toBe('%PDF-');
  expect(out.toString('latin1')).not.toMatch(/\/Subtype\s*\/Image/);
});
