'use strict';

/**
 * verificationService — admin-requested Verification Documents + risk foundation.
 * NOT required at signup; never gates the dashboard. Only blocks auction PUBLISH
 * when a seller is flagged verification_required_before_publication AND has no
 * approved verification. All documents are stored PRIVATE; admin-only visibility.
 */
const crypto = require('crypto');
const db = require('../db/index');
const { writeAuditLog } = require('../lib/auditLog');
const cloudinaryService = require('./cloudinaryService');
const { v2: cloudinary } = require('cloudinary');
const { sendEmail } = require('./emailService');

const CATEGORIES = [
  'government_id', 'passport', 'business_license', 'tax_document',
  'proof_of_ownership', 'receipt_invoice', 'estate_authority', 'probate_letter', 'other',
];
const RISK_LEVELS = ['low', 'medium', 'high'];
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB per document
const SIGNED_URL_TTL_SECONDS = 300;

class VerificationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const publicBase = () => process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || 'https://advantageauction.bid';

async function sellerProfileIdForUser(userId) {
  const r = await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId]);
  return r.rows[0] ? r.rows[0].id : null;
}

// ── Requests ─────────────────────────────────────────────────────────────────
async function createRequest(sellerProfileId, { categories, message }, actorId) {
  const sp = (await db.query('SELECT id FROM seller_profiles WHERE id = $1', [sellerProfileId])).rows[0];
  if (!sp) throw new VerificationError('SELLER_NOT_FOUND', 'Seller profile not found', 404);
  const cats = Array.isArray(categories) ? [...new Set(categories)] : [];
  if (!cats.length) throw new VerificationError('CATEGORIES_REQUIRED', 'At least one document category is required', 400);
  const bad = cats.filter((c) => !CATEGORIES.includes(c));
  if (bad.length) throw new VerificationError('INVALID_CATEGORY', `Invalid categories: ${bad.join(', ')}`, 400);

  const req = (await db.query(
    `INSERT INTO verification_requests (seller_profile_id, requested_by, status, message)
     VALUES ($1,$2,'open',$3) RETURNING *`, [sellerProfileId, actorId ?? null, message || null])).rows[0];
  for (const cat of cats) {
    await db.query(`INSERT INTO verification_request_categories (request_id, category) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.id, cat]);
  }
  await writeAuditLog({ event_type: 'verification_requested', entity_type: 'verification_request', entity_id: req.id, actor_id: actorId ?? null, metadata: { seller_profile_id: sellerProfileId, categories: cats } });
  await emailRequest(sellerProfileId, cats);
  return getRequest(req.id);
}

async function emailRequest(sellerProfileId, cats) {
  try {
    const r = await db.query('SELECT u.email FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1', [sellerProfileId]);
    const to = r.rows[0] && r.rows[0].email;
    if (!to) return;
    const link = `${publicBase()}/verify-documents.html`;
    const list = cats.map((c) => '<li>' + c.replace(/_/g, ' ') + '</li>').join('');
    await sendEmail({
      to,
      subject: 'Document verification requested for your Advantage Auction seller account',
      html: `<p>Advantage Auction has requested verification documents for your seller account.</p>
             <p>Requested documents:</p><ul>${list}</ul>
             <p><a href="${link}">Securely upload your documents</a></p>
             <p>Your documents are stored privately and reviewed only by Advantage staff.</p>`,
      text: `Advantage Auction has requested verification documents (${cats.join(', ')}). Upload securely at: ${link}`,
    });
  } catch (e) { /* best-effort */ }
}

async function getRequest(id) {
  const req = (await db.query('SELECT * FROM verification_requests WHERE id = $1', [id])).rows[0];
  if (!req) return null;
  req.categories = (await db.query('SELECT category FROM verification_request_categories WHERE request_id = $1 ORDER BY category', [id])).rows.map((r) => r.category);
  req.documents = (await db.query('SELECT id, category, original_filename, content_type, byte_size, status, review_note, uploaded_at, reviewed_at FROM verification_documents WHERE request_id = $1 ORDER BY uploaded_at', [id])).rows;
  return req;
}

async function listForSeller(sellerProfileId) {
  const rows = (await db.query('SELECT * FROM verification_requests WHERE seller_profile_id = $1 ORDER BY created_at DESC', [sellerProfileId])).rows;
  for (const r of rows) {
    r.categories = (await db.query('SELECT category FROM verification_request_categories WHERE request_id = $1 ORDER BY category', [r.id])).rows.map((x) => x.category);
  }
  return rows;
}

// Open requests for the seller-user (drives the seller banner). Admin-internal
// fields (admin_notes) are not included.
async function openRequestsForUser(userId) {
  const spId = await sellerProfileIdForUser(userId);
  if (!spId) return [];
  const rows = (await db.query(
    `SELECT id, status, message, created_at FROM verification_requests
      WHERE seller_profile_id = $1 AND status IN ('open','more_info','submitted') ORDER BY created_at DESC`, [spId])).rows;
  for (const r of rows) {
    r.categories = (await db.query('SELECT category FROM verification_request_categories WHERE request_id = $1 ORDER BY category', [r.id])).rows.map((x) => x.category);
  }
  return rows;
}

// ── Document upload (seller) ─────────────────────────────────────────────────
async function uploadDocument(requestId, userId, { category, filename, contentType, dataBase64 }) {
  const req = (await db.query('SELECT * FROM verification_requests WHERE id = $1', [requestId])).rows[0];
  if (!req) throw new VerificationError('REQUEST_NOT_FOUND', 'Verification request not found', 404);
  const spId = await sellerProfileIdForUser(userId);
  if (!spId || spId !== req.seller_profile_id) throw new VerificationError('FORBIDDEN', 'Not your verification request', 403);
  if (['approved', 'cancelled'].includes(req.status)) throw new VerificationError('REQUEST_CLOSED', `This request is ${req.status}`, 409);
  if (!CATEGORIES.includes(category)) throw new VerificationError('INVALID_CATEGORY', 'Invalid document category', 400);
  if (!dataBase64 || typeof dataBase64 !== 'string') throw new VerificationError('FILE_REQUIRED', 'A document file is required', 400);

  const b64 = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new VerificationError('FILE_REQUIRED', 'A document file is required', 400);
  if (buf.length > MAX_BYTES) throw new VerificationError('FILE_TOO_LARGE', 'Document exceeds the 15 MB limit', 413);

  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const up = await cloudinaryService.uploadBuffer(buf, {
    folder: 'verification-documents',
    resource_type: 'raw',
    type: 'private',
    // Override the service default (image-only) so documents (PDF + images) are accepted.
    allowed_formats: ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff'],
    public_id: `vdoc-${requestId}-${Date.now()}`,
    overwrite: false,
  });
  const fmt = (up.format || (filename && filename.includes('.') ? filename.split('.').pop() : 'bin'));
  const doc = (await db.query(
    `INSERT INTO verification_documents
       (request_id, seller_profile_id, category, storage_public_id, file_sha256,
        original_filename, content_type, byte_size, status, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9) RETURNING id, category, status, uploaded_at`,
    [requestId, spId, category, up.public_id, sha, filename || null, contentType || null, buf.length, userId])).rows[0];
  // store the resolved format alongside the public_id for later signed-url download
  doc._format = fmt;
  await db.query(`UPDATE verification_requests SET status='submitted', updated_at=now() WHERE id=$1 AND status IN ('open','more_info')`, [requestId]);
  await writeAuditLog({ event_type: 'verification_document_uploaded', entity_type: 'verification_document', entity_id: doc.id, actor_id: userId, metadata: { request_id: requestId, category, sha256: sha } });
  return { id: doc.id, category: doc.category, status: doc.status };
}

// ── Review (admin) ───────────────────────────────────────────────────────────
async function reviewDocument(docId, actorId, { status, note }) {
  if (!['approved', 'rejected', 'more_info'].includes(status)) throw new VerificationError('INVALID_STATUS', 'status must be approved | rejected | more_info', 400);
  const d = (await db.query(
    `UPDATE verification_documents SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now()
      WHERE id=$1 RETURNING *`, [docId, status, note || null, actorId ?? null])).rows[0];
  if (!d) throw new VerificationError('DOC_NOT_FOUND', 'Document not found', 404);
  await writeAuditLog({ event_type: 'verification_document_reviewed', entity_type: 'verification_document', entity_id: docId, actor_id: actorId ?? null, metadata: { status } });
  return { id: d.id, status: d.status };
}

async function reviewRequest(requestId, actorId, { status, adminNotes }) {
  if (!['approved', 'rejected', 'more_info', 'cancelled'].includes(status)) throw new VerificationError('INVALID_STATUS', 'status must be approved | rejected | more_info | cancelled', 400);
  const r = (await db.query(
    `UPDATE verification_requests SET status=$2, admin_notes=COALESCE($3, admin_notes), reviewed_by=$4, reviewed_at=now(), updated_at=now()
      WHERE id=$1 RETURNING *`, [requestId, status, adminNotes ?? null, actorId ?? null])).rows[0];
  if (!r) throw new VerificationError('REQUEST_NOT_FOUND', 'Verification request not found', 404);
  await writeAuditLog({ event_type: 'verification_request_reviewed', entity_type: 'verification_request', entity_id: requestId, actor_id: actorId ?? null, metadata: { status } });
  return getRequest(requestId);
}

// Admin-only short-lived signed download URL for a private document.
async function documentDownloadUrl(docId) {
  const d = (await db.query('SELECT storage_public_id, original_filename, content_type FROM verification_documents WHERE id = $1', [docId])).rows[0];
  if (!d) throw new VerificationError('DOC_NOT_FOUND', 'Document not found', 404);
  const fmt = (d.original_filename && d.original_filename.includes('.')) ? d.original_filename.split('.').pop() : 'bin';
  const url = cloudinary.utils.private_download_url(d.storage_public_id, fmt, {
    resource_type: 'raw', type: 'private', expires_at: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS,
  });
  return { url, expires_in: SIGNED_URL_TTL_SECONDS };
}

// ── Risk + publication gate ──────────────────────────────────────────────────
async function setRisk(sellerProfileId, actorId, { risk_level, risk_notes, verification_required_before_publication }) {
  const sp = (await db.query('SELECT id FROM seller_profiles WHERE id = $1', [sellerProfileId])).rows[0];
  if (!sp) throw new VerificationError('SELLER_NOT_FOUND', 'Seller profile not found', 404);
  if (risk_level !== undefined && !RISK_LEVELS.includes(risk_level)) throw new VerificationError('INVALID_RISK', 'risk_level must be low | medium | high', 400);
  const sets = []; const params = [sellerProfileId]; let i = 1;
  if (risk_level !== undefined) { params.push(risk_level); sets.push(`risk_level=$${++i}`); }
  if (risk_notes !== undefined) { params.push(risk_notes); sets.push(`risk_notes=$${++i}`); }
  if (verification_required_before_publication !== undefined) { params.push(!!verification_required_before_publication); sets.push(`verification_required_before_publication=$${++i}`); }
  if (!sets.length) throw new VerificationError('NO_FIELDS', 'Provide risk_level, risk_notes, or verification_required_before_publication', 400);
  const row = (await db.query(`UPDATE seller_profiles SET ${sets.join(', ')} WHERE id=$1 RETURNING id, risk_level, risk_notes, verification_required_before_publication`, params)).rows[0];
  await writeAuditLog({ event_type: 'seller_risk_updated', entity_type: 'seller_profile', entity_id: sellerProfileId, actor_id: actorId ?? null, metadata: { risk_level: row.risk_level, verification_required_before_publication: row.verification_required_before_publication } });
  return row;
}

async function hasApprovedVerification(sellerProfileId) {
  return (await db.query(`SELECT 1 FROM verification_requests WHERE seller_profile_id=$1 AND status='approved' LIMIT 1`, [sellerProfileId])).rowCount > 0;
}

// Returns { blocked, reason } — true ONLY when the seller is flagged
// verification_required_before_publication AND has no approved verification.
async function publicationGate(sellerProfileId) {
  const sp = (await db.query('SELECT verification_required_before_publication FROM seller_profiles WHERE id = $1', [sellerProfileId])).rows[0];
  if (!sp || !sp.verification_required_before_publication) return { blocked: false, reason: 'not_required' };
  if (await hasApprovedVerification(sellerProfileId)) return { blocked: false, reason: 'verified' };
  return { blocked: true, reason: 'verification_required' };
}

// ── Fraud foundation: passive duplicate warnings (admin-surfaced, never blocks) ─
async function duplicateWarnings(sellerProfileId) {
  const warnings = [];
  const id = (await db.query(
    `SELECT si.phone, si.legal_name, si.address_line1, si.postal_code, u.email
       FROM seller_profiles sp
       LEFT JOIN seller_identity si ON si.seller_profile_id = sp.id
       JOIN users u ON u.id = sp.user_id
      WHERE sp.id = $1`, [sellerProfileId])).rows[0];
  if (!id) return warnings;

  if (id.phone) {
    const r = await db.query(
      `SELECT seller_profile_id FROM seller_identity WHERE phone = $1 AND seller_profile_id <> $2`, [id.phone, sellerProfileId]);
    if (r.rowCount) warnings.push({ type: 'same_phone', value: id.phone, matches: r.rows.map((x) => x.seller_profile_id) });
  }
  if (id.email) {
    const r = await db.query(`SELECT id FROM users WHERE lower(email) = lower($1) AND id <> (SELECT user_id FROM seller_profiles WHERE id = $2)`, [id.email, sellerProfileId]);
    if (r.rowCount) warnings.push({ type: 'same_email', value: id.email, matches: r.rows.map((x) => x.id) });
  }
  if (id.legal_name && id.address_line1) {
    const r = await db.query(
      `SELECT seller_profile_id FROM seller_identity
        WHERE lower(legal_name)=lower($1) AND lower(address_line1)=lower($2)
          AND coalesce(postal_code,'')=coalesce($3,'') AND seller_profile_id <> $4`,
      [id.legal_name, id.address_line1, id.postal_code, sellerProfileId]);
    if (r.rowCount) warnings.push({ type: 'same_name_address', value: `${id.legal_name} / ${id.address_line1}`, matches: r.rows.map((x) => x.seller_profile_id) });
  }
  return warnings;
}

module.exports = {
  VerificationError, CATEGORIES, RISK_LEVELS,
  sellerProfileIdForUser,
  createRequest, getRequest, listForSeller, openRequestsForUser,
  uploadDocument, reviewDocument, reviewRequest, documentDownloadUrl,
  setRisk, hasApprovedVerification, publicationGate, duplicateWarnings,
};
