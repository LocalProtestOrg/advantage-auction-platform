'use strict';

/**
 * Seller-facing agreements API — mounted at /api/agreements.
 *   GET  /by-token/:token   public capability VIEW (marks viewed)
 *   GET  /mine              authenticated seller's own agreements
 *   GET  /:id               authenticated owner (or admin) single view
 *   POST /:id/sign          authenticated seller match — sign (typed/drawn)
 *   GET  /:id/pdf           authenticated owner/admin — redirect to signed PDF
 * Signing requires authentication (decision 6); viewing via token does not.
 */
const express = require('express');
const router  = express.Router();
const auth        = require('../middleware/authMiddleware');
const idempotency = require('../middleware/idempotency');
const db          = require('../db/index');
const agreements  = require('../services/agreementService');
const pdfService  = require('../services/agreementPdfService');

function handleErr(res, err, next) {
  if (err && err.status && err.code) {
    const body = { success: false, code: err.code, message: err.message };
    if (err.missingRequired) body.missingRequired = err.missingRequired;
    return res.status(err.status).json(body);
  }
  return next(err);
}
async function withTemplate(a) {
  if (!a) return a;
  const r = await db.query(
    'SELECT t.name, t.agreement_type FROM agreement_template_versions tv JOIN agreement_templates t ON t.id = tv.template_id WHERE tv.id = $1',
    [a.template_version_id]
  );
  return { ...a, template_name: r.rows[0] && r.rows[0].name, agreement_type: r.rows[0] && r.rows[0].agreement_type };
}
function viewPayload(a) {
  if (!a) return null;
  return {
    id: a.id, status: a.status, template_name: a.template_name, agreement_type: a.agreement_type,
    rendered_body: a.rendered_body, resolved_variables: a.resolved_variables, party_snapshot: a.party_snapshot,
    sent_at: a.sent_at, viewed_at: a.viewed_at, signed_at: a.signed_at, expires_at: a.expires_at,
    pdf_available: a.pdf_status === 'stored',
  };
}

// PUBLIC capability view via token (unauthenticated allowed). Marks viewed.
router.get('/by-token/:token', async (req, res, next) => {
  try {
    let a = await agreements.getByToken(req.params.token);
    if (!a) return res.status(404).json({ success: false, message: 'Agreement link not found or no longer valid' });
    a = await agreements.markViewed(a);
    a = await withTemplate(a);
    return res.json({ success: true, data: viewPayload(a) });
  } catch (err) { handleErr(res, err, next); }
});

// Authenticated seller's own list.
router.get('/mine', auth, async (req, res, next) => {
  try { return res.json({ success: true, data: (await agreements.listForSeller(req.user.id)).map(viewPayload) }); }
  catch (err) { handleErr(res, err, next); }
});

// Authenticated single (owner or admin).
router.get('/:id', auth, async (req, res, next) => {
  try {
    let a = await agreements.getById(req.params.id);
    if (!a) return res.status(404).json({ success: false, message: 'Not found' });
    if (a.seller_user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Forbidden' });
    a = await withTemplate(a);
    const data = viewPayload(a);
    if (req.user.role === 'admin') data.signatures = await agreements.getSignatures(a.id);
    return res.json({ success: true, data });
  } catch (err) { handleErr(res, err, next); }
});

// Sign — authenticated seller match (server-enforced in the service).
router.post('/:id/sign', auth, idempotency, async (req, res, next) => {
  try {
    const { typed_name, drawn_image_data, consent_acknowledged, intent_acknowledged, intent_statement } = req.body || {};
    const result = await agreements.signAgreement(req.params.id, {
      userId: req.user.id, typedName: typed_name, drawnImageData: drawn_image_data,
      consent: consent_acknowledged === true, intent: intent_acknowledged === true, intentStatement: intent_statement,
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    return res.json({ success: true, data: { id: result.agreement.id, status: result.agreement.status, pdf_status: result.agreement.pdf_status } });
  } catch (err) { handleErr(res, err, next); }
});

// Download signed PDF — owner or admin. Redirects to the stored Cloudinary URL.
router.get('/:id/pdf', auth, async (req, res, next) => {
  try {
    const a = await agreements.getById(req.params.id);
    if (!a) return res.status(404).json({ success: false, message: 'Not found' });
    if (a.seller_user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Forbidden' });
    if (a.pdf_status !== 'stored' || !a.signed_pdf_public_id) return res.status(409).json({ success: false, message: 'Signed PDF not available yet' });
    // Return a short-lived signed URL (no permanent public access). Bearer auth
    // can't ride a browser navigation, so the client fetches this then opens the url.
    return res.json({ success: true, url: pdfService.signedDownloadUrl(a.signed_pdf_public_id), expires_in: pdfService.SIGNED_URL_TTL_SECONDS });
  } catch (err) { handleErr(res, err, next); }
});

module.exports = router;
