'use strict';

/**
 * agreementPdfService — render a signed agreement to PDF (PDFKit) and store it
 * durably on Cloudinary as a raw asset. Returns the secure URL + a SHA-256 of
 * the exact bytes. Generation is non-blocking to the signing act (the signature
 * row + content hash are the legal anchor); callers handle failure via pdf_status.
 */
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const cloudinaryService = require('./cloudinaryService');
const { v2: cloudinary } = require('cloudinary');

const SIGNED_URL_TTL_SECONDS = 300; // signed PDF links live 5 minutes

// Pure, testable metadata stamp for any printable/downloadable agreement copy.
// Guards against a seller later claiming an outdated printed copy is current:
// version + effective date + generated timestamp/timezone + who it was prepared for
// + a statement that the platform's current active version controls future acceptances.
// `now` is injectable for deterministic tests. Timestamp rendered in UTC (unambiguous).
function agreementStampLines(agreement, now) {
  const a = agreement || {};
  const ps = a.party_snapshot || {};
  const rv = a.resolved_variables || {};
  const versionNum = (a.version_int != null) ? a.version_int : (a.version != null ? a.version : null);
  const version = versionNum != null ? ('v' + versionNum) : 'current version';
  const effective = rv.effective_date || a.effective_date || null;
  const sellerName = [ps.legal_name, ps.company_name].filter(Boolean).join(' / ') || null;
  const gen = (now instanceof Date) ? now : new Date();
  const generatedUtc = gen.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [];
  lines.push('Agreement version: ' + version);
  if (effective) lines.push('Effective date: ' + effective);
  lines.push('Copy generated: ' + generatedUtc + ' (timezone: UTC)');
  if (sellerName) lines.push('Prepared for: ' + sellerName);
  lines.push('This is a review copy. Terms may be updated from time to time; the platform’s current active agreement version controls all future acceptances.');
  return lines;
}

// ── Markdown → PDF rendering ────────────────────────────────────────────────
// The agreement body is authored in lightweight markdown (#/## headings, **bold**,
// --- rules, - bullets). PDFKit's text() prints strings literally, so without this
// the raw symbols would appear in the signed/downloaded document. parseInlineBold and
// parseAgreementMarkdown are pure + unit-tested; renderAgreementBody applies them to a doc.
function parseInlineBold(text) {
  const out = [];
  for (const part of String(text == null ? '' : text).split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    out.push(m ? { text: m[1], bold: true } : { text: part, bold: false });
  }
  return out.length ? out : [{ text: '', bold: false }];
}

function parseAgreementMarkdown(md) {
  const blocks = [];
  for (const raw of String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (/^\s*---\s*$/.test(line)) blocks.push({ type: 'hr' });
    else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) blocks.push({ type: 'bullet', text: m[1] });
    else if ((m = line.match(/^>\s?(.*)$/))) blocks.push({ type: 'para', text: m[1] });
    else if (line.trim() === '') blocks.push({ type: 'space' });
    else blocks.push({ type: 'para', text: line });
  }
  return blocks;
}

function renderInline(doc, text, baseBold) {
  const runs = parseInlineBold(text);
  runs.forEach((r, i) => {
    doc.font(r.bold || baseBold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(r.text, { continued: i < runs.length - 1 });
  });
  doc.font('Helvetica');
}

function renderAgreementBody(doc, md) {
  const HEADING_SIZE = { 1: 15, 2: 12, 3: 11, 4: 10 };
  for (const b of parseAgreementMarkdown(md)) {
    if (b.type === 'hr') {
      doc.moveDown(0.4);
      const y = doc.y;
      doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor('#cccccc').stroke().strokeColor('#000000');
      doc.moveDown(0.4);
    } else if (b.type === 'space') {
      doc.moveDown(0.45);
    } else if (b.type === 'heading') {
      doc.moveDown(b.level <= 2 ? 0.5 : 0.3);
      doc.fontSize(HEADING_SIZE[b.level] || 11).fillColor('#111111');
      renderInline(doc, b.text, true);
      doc.fillColor('#000000').fontSize(10);
      doc.moveDown(0.15);
    } else if (b.type === 'bullet') {
      doc.fontSize(10).fillColor('#000000').font('Helvetica').text('•  ', { continued: true });
      renderInline(doc, b.text, false);
    } else {
      doc.fontSize(10).fillColor('#000000');
      renderInline(doc, b.text, false);
      doc.moveDown(0.3);
    }
  }
}

function buildPdfBuffer(agreement, signature) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text('Seller Agreement', { align: 'center' });
    doc.moveDown(0.4);
    const ps = agreement.party_snapshot || {};
    const partyLine = [ps.legal_name, ps.company_name].filter(Boolean).join(' · ');
    if (partyLine) { doc.fontSize(9).font('Helvetica').fillColor('#555555').text(partyLine, { align: 'center' }); doc.fillColor('#000000'); }
    doc.moveDown(1);

    renderAgreementBody(doc, agreement.rendered_body || '');
    doc.moveDown(2);

    doc.fontSize(11).font('Helvetica-Bold').text('Electronic Signature');
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
    doc.moveDown(0.4).fontSize(9).font('Helvetica');
    const line = (l) => doc.text(l);
    const _v = (agreement.version_int != null) ? agreement.version_int : agreement.version;
    if (_v != null) line(`Agreement version: v${_v}`);
    line(`Signed by (typed): ${signature.typed_name || ''}`);
    if (signature.drawn_image_url) line(`Drawn signature on file: ${signature.drawn_image_url}`);
    line(`Signer role: ${signature.signer_role || 'seller'}`);
    line(`Signed at (UTC): ${signature.signed_at ? new Date(signature.signed_at).toISOString() : ''}`);
    line(`IP address: ${signature.ip_address || ''}`);
    line(`User agent: ${signature.user_agent || ''}`);
    line(`Consent acknowledged: ${signature.consent_acknowledged ? 'yes' : 'no'}`);
    line(`Intent: ${signature.intent_statement || ''}`);
    line(`Content SHA-256: ${signature.content_sha256 || ''}`);

    doc.end();
  });
}

// Unsigned copy: same body render, signature block replaced by a clear notice.
// Generated on demand (req 6); never stored (no signature, no legal weight).
function buildUnsignedPdfBuffer(agreement) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text('Seller Agreement (Unsigned Copy)', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#b45309').text('DRAFT - UNSIGNED COPY. This copy is for review only and is not executed.', { align: 'center' });
    doc.fillColor('#000000').moveDown(0.6);
    const ps = agreement.party_snapshot || {};
    const partyLine = [ps.legal_name, ps.company_name].filter(Boolean).join(' / ');
    if (partyLine) { doc.fontSize(9).font('Helvetica').fillColor('#555555').text(partyLine, { align: 'center' }); doc.fillColor('#000000'); }
    doc.moveDown(0.6);

    // Version / effective date / generated timestamp+timezone / seller / update notice.
    doc.fontSize(8).font('Helvetica').fillColor('#374151');
    agreementStampLines(agreement).forEach((l) => doc.text(l, { align: 'left' }));
    doc.fillColor('#000000').moveDown(1);

    renderAgreementBody(doc, agreement.rendered_body || '');
    doc.moveDown(2);
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555')
      .text('No signature is recorded on this copy. Sign electronically through the Advantage.Bid platform to execute this agreement.', { align: 'left' });
    doc.end();
  });
}

async function generateAndStore(agreement, signature) {
  const buffer = await buildPdfBuffer(agreement, signature);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  // Stored PRIVATE (not publicly retrievable) — signed agreements hold legal/PII
  // data. Delivery is via short-lived signed URLs (signedDownloadUrl), never a
  // permanent public URL.
  const result = await cloudinaryService.uploadBuffer(buffer, {
    folder: 'agreements',
    resource_type: 'raw',
    type: 'private',
    allowed_formats: ['pdf'],
    public_id: `agreement-${agreement.id}`,
    format: 'pdf',
    overwrite: true,
  });
  // Return the buffer too so callers (e.g. the signed-PDF email) can reuse the
  // exact bytes without re-rendering.
  return { sha256, public_id: result.public_id, buffer };
}

// Generate a short-lived signed download URL for a private raw PDF asset.
// The signature embeds an expiry; the URL is unusable after SIGNED_URL_TTL_SECONDS.
function signedDownloadUrl(publicId, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return cloudinary.utils.private_download_url(publicId, 'pdf', {
    resource_type: 'raw',
    type: 'private',
    expires_at: expiresAt,
  });
}

module.exports = { buildPdfBuffer, buildUnsignedPdfBuffer, generateAndStore, signedDownloadUrl, agreementStampLines, parseAgreementMarkdown, parseInlineBold, SIGNED_URL_TTL_SECONDS };
