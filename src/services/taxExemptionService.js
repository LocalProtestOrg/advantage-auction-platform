'use strict';

/**
 * taxExemptionService — buyer sales-tax exemption document workflow. REUSES the same secure document
 * infrastructure as seller verification (Cloudinary PRIVATE raw storage + validateDocumentUpload +
 * short-lived signed admin download URLs + audit log). Authoritative truth is the buyer_tax_exemptions
 * record; users.tax_exempt is a review-maintained mirror set ONLY on admin approval.
 *
 * IMPORTANT: uploading a certificate does NOT make a buyer tax-exempt. Only an admin approval does. This
 * service stores the structured fields (type / state / effective / expiration) that FUTURE per-jurisdiction
 * tax logic will evaluate; it does NOT enable sales tax and does NOT implement state eligibility rules.
 */
const crypto = require('crypto');
const db = require('../db/index');
const { writeAuditLog } = require('../lib/auditLog');
const cloudinaryService = require('./cloudinaryService');
const { v2: cloudinary } = require('cloudinary');
const { validateDocumentUpload, ALLOWED } = require('../lib/uploadValidation');

const MIME_TO_EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const SIGNED_URL_TTL_SECONDS = 300;
const EXEMPTION_TYPES = ['resale', 'state_exemption', 'streamlined_sst', 'mtc', 'other'];
const REVIEW_STATUSES = ['approved', 'rejected', 'more_info'];

class TaxExemptionError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ── Pure eligibility helpers (unit-testable; the seam future tax logic will call) ───────────────────
// An approved exemption applies to a sale only when: status=approved, the jurisdiction matches the taxing
// state (when both are known), and the sale date is within [effective, expiration]. Never assumes nationwide.
function exemptionApplies(exemption, { state = null, date = null } = {}) {
  if (!exemption || exemption.status !== 'approved') return false;
  if (state && exemption.jurisdiction_state
      && String(exemption.jurisdiction_state).toUpperCase() !== String(state).toUpperCase()) return false;
  if (date && exemption.effective_date && new Date(date) < new Date(exemption.effective_date)) return false;
  if (date && exemption.expiration_date && new Date(date) > new Date(exemption.expiration_date)) return false;
  return true;
}

// Sales tax for a buyer, honoring an approved applicable exemption → $0. Cents-safe. This is the ONLY place
// exemption affects tax; it is NOT wired into live invoicing (sales tax remains globally inactive at launch).
function salesTaxCents({ taxableCents, rateBps, exemption, state = null, date = null }) {
  const taxable = Math.max(0, Math.round(Number(taxableCents) || 0));
  const rate = Math.max(0, Number(rateBps) || 0);
  if (exemptionApplies(exemption, { state, date })) return 0;
  return Math.floor(taxable * rate / 10000 + 0.5);
}

// ── Buyer submission ────────────────────────────────────────────────────────────────────────────────
async function submitExemption(userId, { exemption_type, jurisdiction_state, certificate_number,
                                          effective_date, expiration_date, filename, contentType, dataBase64 }) {
  if (exemption_type && !EXEMPTION_TYPES.includes(exemption_type)) {
    throw new TaxExemptionError('INVALID_TYPE', `exemption_type must be one of: ${EXEMPTION_TYPES.join(', ')}`, 400);
  }
  if (!dataBase64 || typeof dataBase64 !== 'string') {
    throw new TaxExemptionError('FILE_REQUIRED', 'A sales-tax exemption certificate document is required', 400);
  }
  const b64 = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
  const buf = Buffer.from(b64, 'base64');
  let v;
  try { v = validateDocumentUpload({ filename, contentType, buffer: buf }); }
  catch (e) { throw new TaxExemptionError(e.code || 'INVALID_FILE', e.message || 'Invalid document file', e.status || 400); }

  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const up = await cloudinaryService.uploadBuffer(buf, {
    folder: 'tax-exemption-documents', resource_type: 'raw', type: 'private',
    allowed_formats: Object.keys(ALLOWED).concat(['jpeg']),
    public_id: `taxexempt-${userId}-${Date.now()}`, overwrite: false,
  });
  // Upsert the single active record per buyer. Re-submitting resets to 'under_review' and clears any prior
  // approval side-effects (users.tax_exempt is set false below so a resubmission is never silently exempt).
  const row = (await db.query(
    `INSERT INTO buyer_tax_exemptions
       (buyer_user_id, status, exemption_type, jurisdiction_state, certificate_number,
        storage_public_id, file_sha256, original_filename, content_type, byte_size, submitted_by, updated_at)
     VALUES ($1,'under_review',$2,$3,$4,$5,$6,$7,$8,$9,$1, now())
     ON CONFLICT (buyer_user_id) DO UPDATE SET
       status='under_review', exemption_type=EXCLUDED.exemption_type, jurisdiction_state=EXCLUDED.jurisdiction_state,
       certificate_number=EXCLUDED.certificate_number, storage_public_id=EXCLUDED.storage_public_id,
       file_sha256=EXCLUDED.file_sha256, original_filename=EXCLUDED.original_filename,
       content_type=EXCLUDED.content_type, byte_size=EXCLUDED.byte_size, submitted_by=EXCLUDED.submitted_by,
       reviewed_by=NULL, reviewed_at=NULL, updated_at=now()
     RETURNING id, status`,
    [userId, exemption_type || null, jurisdiction_state || null, certificate_number || null,
     up.public_id, sha, v.safeFilename, v.mime, buf.length])).rows[0];
  // A new/updated submission is NEVER auto-exempt.
  await db.query('UPDATE users SET tax_exempt = false WHERE id = $1', [userId]);
  await writeAuditLog({ event_type: 'buyer_tax_exemption_submitted', entity_type: 'buyer_tax_exemption',
    entity_id: row.id, actor_id: userId, metadata: { jurisdiction_state: jurisdiction_state || null, exemption_type: exemption_type || null } });
  return { id: row.id, status: row.status };
}

// Buyer-facing view — no storage id, no admin notes. 'not_submitted' when no record exists.
async function getForBuyer(userId) {
  const r = (await db.query(
    `SELECT id, status, exemption_type, jurisdiction_state, certificate_number,
            effective_date, expiration_date, original_filename, created_at, updated_at, reviewed_at
       FROM buyer_tax_exemptions WHERE buyer_user_id = $1`, [userId])).rows[0];
  const tax_exempt = (await db.query('SELECT tax_exempt FROM users WHERE id = $1', [userId])).rows[0];
  if (!r) return { status: 'not_submitted', tax_exempt: !!(tax_exempt && tax_exempt.tax_exempt) };
  return { ...r, tax_exempt: !!(tax_exempt && tax_exempt.tax_exempt) };
}

// Admin-facing full record (still no raw storage id in the body — the document is fetched via the signed URL).
async function getForAdmin(userId) {
  const r = (await db.query(
    `SELECT e.id, e.status, e.exemption_type, e.jurisdiction_state, e.certificate_number,
            e.effective_date, e.expiration_date, e.original_filename, e.content_type, e.byte_size,
            e.admin_notes, e.reviewed_by, e.reviewed_at, e.created_at, e.updated_at,
            (e.storage_public_id IS NOT NULL) AS has_document, u.tax_exempt
       FROM buyer_tax_exemptions e JOIN users u ON u.id = e.buyer_user_id
      WHERE e.buyer_user_id = $1`, [userId])).rows[0];
  return r || null;
}

// Admin review — authoritative. Sets the record status AND the users.tax_exempt mirror in ONE transaction,
// so the flag and the record never diverge. Approval requires the buyer to have submitted a record.
async function reviewExemption(buyerUserId, actorId, { status, admin_notes, effective_date, expiration_date, jurisdiction_state, exemption_type }) {
  if (!REVIEW_STATUSES.includes(status)) throw new TaxExemptionError('INVALID_STATUS', `status must be one of: ${REVIEW_STATUSES.join(', ')}`, 400);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT id FROM buyer_tax_exemptions WHERE buyer_user_id = $1 FOR UPDATE', [buyerUserId])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); throw new TaxExemptionError('NOT_FOUND', 'No tax-exemption request for this buyer', 404); }
    const row = (await client.query(
      `UPDATE buyer_tax_exemptions SET
         status=$2,
         admin_notes=COALESCE($3, admin_notes),
         effective_date=COALESCE($4, effective_date),
         expiration_date=COALESCE($5, expiration_date),
         jurisdiction_state=COALESCE($6, jurisdiction_state),
         exemption_type=COALESCE($7, exemption_type),
         reviewed_by=$8, reviewed_at=now(), updated_at=now()
       WHERE buyer_user_id=$1 RETURNING *`,
      [buyerUserId, status, admin_notes ?? null, effective_date ?? null, expiration_date ?? null,
       jurisdiction_state ?? null, exemption_type ?? null, actorId ?? null])).rows[0];
    // Authoritative mirror: exempt ONLY when approved.
    await client.query('UPDATE users SET tax_exempt = $2 WHERE id = $1', [buyerUserId, status === 'approved']);
    await client.query('COMMIT');
    await writeAuditLog({ event_type: 'buyer_tax_exemption_reviewed', entity_type: 'buyer_tax_exemption',
      entity_id: row.id, actor_id: actorId ?? null, metadata: { status, jurisdiction_state: row.jurisdiction_state, buyer_user_id: buyerUserId } });
    return { id: row.id, status: row.status, tax_exempt: status === 'approved' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// Admin-only short-lived signed download URL for the private certificate.
async function documentDownloadUrl(exemptionId) {
  const d = (await db.query('SELECT storage_public_id, original_filename, content_type FROM buyer_tax_exemptions WHERE id = $1', [exemptionId])).rows[0];
  if (!d || !d.storage_public_id) throw new TaxExemptionError('DOC_NOT_FOUND', 'Document not found', 404);
  const fmt = MIME_TO_EXT[d.content_type]
    || (d.original_filename && d.original_filename.includes('.') ? d.original_filename.split('.').pop().toLowerCase() : 'bin');
  const url = cloudinary.utils.private_download_url(d.storage_public_id, fmt, {
    resource_type: 'raw', type: 'private', expires_at: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS,
  });
  return { url, expires_in: SIGNED_URL_TTL_SECONDS };
}

// DB-backed applicability for a sale (future tax logic entry point). Returns the approved applicable record or null.
async function effectiveExemptionForSale(userId, { state = null, date = null } = {}) {
  const r = (await db.query(
    `SELECT status, jurisdiction_state, effective_date, expiration_date
       FROM buyer_tax_exemptions WHERE buyer_user_id = $1`, [userId])).rows[0];
  return exemptionApplies(r, { state, date }) ? r : null;
}

module.exports = {
  TaxExemptionError, EXEMPTION_TYPES, REVIEW_STATUSES,
  exemptionApplies, salesTaxCents,
  submitExemption, getForBuyer, getForAdmin, reviewExemption, documentDownloadUrl, effectiveExemptionForSale,
};
