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
  name: 'ADVANTAGE AUCTION',
  tagline: 'advantage.bid',
  navy: '#0f172a',
  blue: '#2563eb',
  slate: '#64748b',
  hair: '#e2e8f0',
};

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

  doc.fillColor(BRAND.navy).font('Helvetica-Bold').fontSize(20)
     .text(BRAND.name, left, doc.y);
  doc.font('Helvetica').fontSize(9).fillColor(BRAND.slate)
     .text(BRAND.tagline);

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
 */
function fetchImageBuffer(url, { timeoutMs = 4000, maxBytes = 5_000_000 } = {}) {
  return new Promise((resolve) => {
    try {
      if (!/^https?:\/\//i.test(url)) return resolve(null);
      const lib = url.toLowerCase().startsWith('https:') ? https : http;
      const req = lib.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
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
  fetchImageBuffer,
  storePrivatePdf,
  signedUrl,
  recordDocument,
};
