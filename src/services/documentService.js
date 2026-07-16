'use strict';

/**
 * documentService — reusable PDF/document infrastructure.
 *
 * Phase 2 foundation: a single place for (a) rendering branded PDFs with PDFKit,
 * (b) best-effort durable private storage on Cloudinary, (c) short-lived signed
 * download URLs, and (d) a `generated_documents` history row. Buyer invoice PDFs
 * use this today; seller settlement PDFs are intended to reuse the same helpers
 * (renderPdf + AAC header + storePrivatePdf + recordDocument) later WITHOUT
 * re-implementing any of it.
 *
 * Storage is best-effort: if Cloudinary is not configured (e.g. a bare staging
 * env) the PDF is still rendered and returned/streamed; only durable archival is
 * skipped. Nothing in the money path depends on storage succeeding.
 */

const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const db = require('../db');
const cloudinaryService = require('./cloudinaryService');
const { v2: cloudinary } = require('cloudinary');

const SIGNED_URL_TTL_SECONDS = 300; // signed links live 5 minutes

const BRAND = {
  name: 'Advantage.Bid',
  tagline: 'advantage.bid',
  navy: '#0f172a',
  blue: '#2563eb',
  slate: '#64748b',
  hair: '#e2e8f0',
  white: '#ffffff',
};

// Draw the Advantage.Bid logo lockup at (x, y): a blue rounded badge with a serif
// "A" (mirrors public/img/advantage-logo.svg + the favicon) followed by the
// "Advantage.Bid" wordmark. Native pdfkit vector — pdfkit cannot embed SVG and we
// deliberately avoid adding a rasterizer dependency. Returns the lockup width.
// If an official raster logo is ever provided, this is the single PDF swap point
// (replace the drawing below with doc.image(pngBuffer, x, y, {fit:[w, badge]})).
function drawBrandLockup(doc, x, y, { badge = 26, rightEdge = null } = {}) {
  doc.save();
  const wordSize = Math.round(badge * 0.65);
  doc.font('Helvetica-Bold').fontSize(wordSize);
  const totalW = badge + 8 + doc.widthOfString('Advantage.Bid');
  if (rightEdge != null) x = rightEdge - totalW;   // right-align within [.., rightEdge]

  doc.roundedRect(x, y, badge, badge, 6).fill(BRAND.blue);
  doc.fillColor(BRAND.white).font('Times-Bold').fontSize(badge * 0.66)
     .text('A', x, y + badge * 0.16, { width: badge, align: 'center' });

  const textX = x + badge + 8;
  doc.font('Helvetica-Bold').fontSize(wordSize);
  doc.fillColor(BRAND.navy).text('Advantage', textX, y + (badge - wordSize) / 2 + 1, { continued: true });
  doc.fillColor(BRAND.blue).text('.Bid', { continued: false });
  doc.restore();
  return totalW;
}

// Email-safe branded header (inline-styled badge + "Advantage.Bid" wordmark).
// Used by every transactional email so the brand is consistent with the PDF/HTML
// logo. Inline styles + inline-block spans render across email clients; border-radius
// simply degrades to a square badge in older clients (Outlook). No image dependency,
// so nothing to block or strip. If an official hosted raster logo is ever adopted,
// swap the inner spans for a single <img> here — one edit updates all emails.
function emailBrandHeader() {
  return (
    '<div style="padding:8px 0 12px">' +
      '<span style="display:inline-block;width:26px;height:26px;line-height:26px;background:#2563eb;' +
        'border-radius:6px;color:#ffffff;font-family:Georgia,\'Times New Roman\',serif;font-weight:bold;' +
        'font-size:17px;text-align:center;vertical-align:middle">A</span>' +
      '<span style="font-weight:800;font-size:18px;color:#0f172a;vertical-align:middle;margin-left:8px">' +
        'Advantage<span style="color:#2563eb">.Bid</span></span>' +
    '</div>'
  );
}

function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function money(cents) {
  if (cents == null) return '—';
  return '$' + (Number(cents) / 100).toFixed(2);
}

/**
 * Render a PDF. `drawFn(doc)` performs all drawing; this wrapper owns the
 * document lifecycle and resolves the complete byte buffer.
 * @returns {Promise<Buffer>}
 */
function renderPdf(drawFn, { size = 'LETTER', margin = 50 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size, margin });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      drawFn(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Draw the standard AAC document header (wordmark + tagline + a titled rule).
 * Reusable across invoices and future settlement documents for a consistent look.
 */
function drawBrandHeader(doc, { docTitle, docSubtitle } = {}) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.y;

  // Logo lockup (badge + "Advantage.Bid" wordmark) in place of the old text wordmark.
  drawBrandLockup(doc, left, top, { badge: 26 });
  doc.font('Helvetica').fontSize(9).fillColor(BRAND.slate)
     .text(BRAND.tagline, left, top + 30);

  if (docTitle) {
    // Right-aligned document title block on the same vertical band.
    doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND.navy)
       .text(docTitle, left, doc.page.margins.top, { width: right - left, align: 'right' });
    if (docSubtitle) {
      doc.font('Helvetica').fontSize(9).fillColor(BRAND.slate)
         .text(docSubtitle, left, doc.y, { width: right - left, align: 'right' });
    }
  }

  doc.moveDown(0.8);
  doc.fillColor(BRAND.blue).rect(left, doc.y, right - left, 2).fill();
  doc.fillColor('#000000');
  doc.moveDown(0.8);
}

/**
 * Fetch a remote image into a Buffer (no external deps). Returns null on any
 * problem so PDF rendering can fall back to a placeholder. Only http(s) URLs are
 * fetched; data: URIs and non-raster formats are caller-skipped.
 *
 * Follows HTTP 3xx redirects (Location header) up to `maxRedirects`, so image
 * URLs that 302 to a CDN (picsum, some Cloudinary/placeholder URLs) render
 * instead of silently falling back to "No image". Each hop keeps the timeout +
 * maxBytes safeguards; the final 200 response body is what's read.
 */
function fetchImageBuffer(url, { timeoutMs = 4000, maxBytes = 5_000_000, maxRedirects = 3 } = {}) {
  return new Promise((resolve) => {
    const visit = (currentUrl, redirectsLeft) => {
      try {
        if (!/^https?:\/\//i.test(currentUrl)) return resolve(null);
        const lib = currentUrl.toLowerCase().startsWith('https:') ? https : http;
        const req = lib.get(currentUrl, (res) => {
          const status = res.statusCode;
          // Follow 3xx redirects (301/302/303/307/308) up to the cap.
          if (status >= 300 && status < 400 && res.headers && res.headers.location) {
            res.resume(); // drain the redirect body
            if (redirectsLeft <= 0) return resolve(null);
            let next;
            try { next = new URL(res.headers.location, currentUrl).toString(); }
            catch (_e) { return resolve(null); }
            return visit(next, redirectsLeft - 1);
          }
          if (status !== 200) { res.resume(); return resolve(null); }
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > maxBytes) { req.destroy(); return resolve(null); }
            chunks.push(c);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
      } catch (_e) {
        resolve(null);
      }
    };
    visit(url, maxRedirects);
  });
}

/**
 * Best-effort private storage of a PDF buffer on Cloudinary.
 * @returns {Promise<{public_id: string|null, sha256: string, stored: boolean}>}
 */
async function storePrivatePdf({ folder, publicId, buffer }) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (!isCloudinaryConfigured()) {
    return { public_id: null, sha256, stored: false };
  }
  try {
    const result = await cloudinaryService.uploadBuffer(buffer, {
      folder,
      resource_type: 'raw',
      type: 'private',
      allowed_formats: ['pdf'],
      public_id: publicId,
      format: 'pdf',
      overwrite: true,
    });
    return { public_id: result.public_id, sha256, stored: true };
  } catch (err) {
    console.warn('[documentService] Cloudinary store failed (non-fatal):', err.message);
    return { public_id: null, sha256, stored: false };
  }
}

/** Short-lived signed download URL for a private raw PDF asset. */
function signedUrl(publicId, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return cloudinary.utils.private_download_url(publicId, 'pdf', {
    resource_type: 'raw',
    type: 'private',
    expires_at: expiresAt,
  });
}

/** Insert a generated_documents history row. Best-effort; never throws to caller. */
async function recordDocument(client, { docType, entityType, entityId, relatedUserId, fileName, publicId, sha256, byteSize }) {
  try {
    const { rows } = await (client || db).query(
      `INSERT INTO generated_documents
         (doc_type, entity_type, entity_id, related_user_id, file_name, pdf_public_id, pdf_sha256, byte_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [docType, entityType, entityId, relatedUserId, fileName, publicId, sha256, byteSize]
    );
    return rows[0];
  } catch (err) {
    console.warn('[documentService] recordDocument failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = {
  BRAND,
  SIGNED_URL_TTL_SECONDS,
  isCloudinaryConfigured,
  money,
  renderPdf,
  drawBrandHeader,
  drawBrandLockup,
  emailBrandHeader,
  fetchImageBuffer,
  storePrivatePdf,
  signedUrl,
  recordDocument,
};
