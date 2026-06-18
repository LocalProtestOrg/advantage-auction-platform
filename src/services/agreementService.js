'use strict';

/**
 * agreementService — Phase B lifecycle: send → review → sign → PDF, plus
 * resend / reissue(supersede) / revoke / expiry. Server-authoritative.
 * Frozen-render model: variables resolve ONCE at send; review/sign always use
 * the frozen rendered_body. Signing requires authenticated seller match.
 */
const crypto = require('crypto');
const db = require('../db/index');
const { writeAuditLog } = require('../lib/auditLog');
const templateService = require('./agreementTemplateService');
const termsService = require('./sellerTermsService');
const identityService = require('./sellerIdentityService');
const { resolveAndRender } = require('./agreementVariableService');
const pdfService = require('./agreementPdfService');
const cloudinaryService = require('./cloudinaryService');
const { sendEmail } = require('./emailService');

const DEFAULT_EXPIRES_DAYS = 14;
const DEFAULT_INTENT = 'I intend to sign and agree to be legally bound by this agreement.';

class AgreementError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message); this.code = code; this.status = status; Object.assign(this, extra);
  }
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newRawToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const publicBase = () => process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || 'https://advantageauction.bid';

async function emailLink(agreement, rawToken) {
  try {
    const r = await db.query('SELECT u.email FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1', [agreement.seller_profile_id]);
    const to = r.rows[0] && r.rows[0].email;
    if (!to) return;
    const link = `${publicBase()}/sign-agreement.html?token=${rawToken}`;
    const exp = agreement.token_expires_at ? new Date(agreement.token_expires_at).toDateString() : '';
    await sendEmail({
      to,
      subject: 'Action required: review and sign your seller agreement',
      html: `<p>Your Advantage Auction seller agreement is ready to review and sign.</p>
             <p><a href="${link}">Review &amp; sign your agreement</a></p>
             <p>This link expires on ${exp}.</p>`,
      text: `Review and sign your seller agreement: ${link}\nThis link expires on ${exp}.`,
    });
  } catch (e) { /* best-effort — email is not the system of record */ }
}

async function pickTemplate(templateId, sellerType) {
  if (templateId) return templateService.getTemplate(templateId);
  const r = await db.query(
    `SELECT id FROM agreement_templates
      WHERE agreement_type = $1 AND is_active = true AND current_version_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`,
    [sellerType || 'private']
  );
  return r.rows[0] ? templateService.getTemplate(r.rows[0].id) : null;
}

async function sendAgreement({ sellerProfileId, templateId, overrides, expiresInDays, actorId }) {
  const sp = await db.query('SELECT id, user_id, seller_type FROM seller_profiles WHERE id = $1', [sellerProfileId]);
  if (!sp.rows[0]) throw new AgreementError('SELLER_NOT_FOUND', 'Seller profile not found', 404);

  const template = await pickTemplate(templateId, sp.rows[0].seller_type);
  if (!template || !template.current_version) {
    throw new AgreementError('TEMPLATE_NOT_FOUND', 'No active template with a current version for this seller type', 422);
  }
  const version = template.current_version;

  const sellerTerms = (await termsService.getCurrentTerms(sellerProfileId)) || {};
  const sellerIdentity = (await identityService.getIdentity(sellerProfileId)) || {};
  const out = resolveAndRender({
    bodyMarkdown: version.body_markdown, variableSchema: version.variable_schema,
    termsDefaults: version.effective_terms_defaults, sellerTerms, sellerIdentity, overrides: overrides || {},
  });
  if (out.missingRequired.length) {
    throw new AgreementError('MISSING_REQUIRED', `Unresolved required variables: ${out.missingRequired.join(', ')}`, 422, { missingRequired: out.missingRequired });
  }

  const days = (Number.isFinite(expiresInDays) && expiresInDays > 0) ? Math.floor(expiresInDays) : DEFAULT_EXPIRES_DAYS;
  const rawToken = newRawToken();
  const ins = await db.query(
    `INSERT INTO agreements
       (template_version_id, seller_profile_id, seller_user_id, status,
        party_snapshot, resolved_variables, rendered_body,
        sent_at, expires_at, access_token_hash, token_expires_at, pdf_status, created_by)
     VALUES ($1,$2,$3,'sent',$4::jsonb,$5::jsonb,$6,
             now(), now() + ($7 * interval '1 day'), $8, now() + ($7 * interval '1 day'), 'pending', $9)
     RETURNING *`,
    [version.id, sellerProfileId, sp.rows[0].user_id, JSON.stringify(sellerIdentity || {}),
     JSON.stringify(out.resolved), out.renderedBody, days, hashToken(rawToken), actorId ?? null]
  );
  const agreement = ins.rows[0];
  await writeAuditLog({
    event_type: 'agreement_sent', entity_type: 'agreement', entity_id: agreement.id, actor_id: actorId ?? null,
    metadata: { seller_profile_id: sellerProfileId, template_id: template.id, template_version_id: version.id, expires_at: agreement.expires_at },
  });
  await emailLink(agreement, rawToken);
  return { agreement, rawToken };
}

async function maybeExpire(agreement) {
  if (agreement && ['sent', 'viewed'].includes(agreement.status) && agreement.expires_at && new Date(agreement.expires_at) < new Date()) {
    const u = await db.query(`UPDATE agreements SET status='expired', updated_at=now() WHERE id=$1 AND status IN ('sent','viewed') RETURNING *`, [agreement.id]);
    if (u.rows[0]) {
      await writeAuditLog({ event_type: 'agreement_expired', entity_type: 'agreement', entity_id: agreement.id, metadata: { expires_at: agreement.expires_at } });
      return u.rows[0];
    }
  }
  return agreement;
}

async function getById(id) {
  const r = await db.query('SELECT * FROM agreements WHERE id = $1', [id]);
  return r.rows[0] ? maybeExpire(r.rows[0]) : null;
}

async function getByToken(rawToken) {
  if (!rawToken) return null;
  const r = await db.query('SELECT * FROM agreements WHERE access_token_hash = $1', [hashToken(rawToken)]);
  return r.rows[0] ? maybeExpire(r.rows[0]) : null;
}

async function markViewed(agreement) {
  if (agreement && agreement.status === 'sent') {
    const u = await db.query(`UPDATE agreements SET status='viewed', viewed_at=now(), updated_at=now() WHERE id=$1 AND status='sent' RETURNING *`, [agreement.id]);
    if (u.rows[0]) {
      await writeAuditLog({ event_type: 'agreement_viewed', entity_type: 'agreement', entity_id: agreement.id, actor_id: agreement.seller_user_id, metadata: {} });
      return u.rows[0];
    }
  }
  return agreement;
}

async function listForSeller(sellerUserId) {
  const r = await db.query(
    `SELECT a.*, tv.version_int, t.name AS template_name, t.agreement_type
       FROM agreements a
       JOIN agreement_template_versions tv ON tv.id = a.template_version_id
       JOIN agreement_templates t ON t.id = tv.template_id
      WHERE a.seller_user_id = $1 ORDER BY a.created_at DESC`,
    [sellerUserId]
  );
  return r.rows;
}

async function listAll({ sellerProfileId } = {}) {
  const params = []; let where = '';
  if (sellerProfileId) { params.push(sellerProfileId); where = 'WHERE a.seller_profile_id = $1'; }
  const r = await db.query(
    `SELECT a.*, t.name AS template_name, t.agreement_type
       FROM agreements a
       JOIN agreement_template_versions tv ON tv.id = a.template_version_id
       JOIN agreement_templates t ON t.id = tv.template_id
       ${where} ORDER BY a.created_at DESC`,
    params
  );
  return r.rows;
}

async function getSignatures(agreementId) {
  const r = await db.query('SELECT * FROM agreement_signatures WHERE agreement_id = $1 ORDER BY created_at', [agreementId]);
  return r.rows;
}

async function signAgreement(agreementId, { userId, typedName, drawnImageData, consent, intent, intentStatement, ip, userAgent }) {
  let agreement = await getById(agreementId);
  if (!agreement) throw new AgreementError('NOT_FOUND', 'Agreement not found', 404);
  if (agreement.seller_user_id !== userId) throw new AgreementError('FORBIDDEN', 'Not your agreement', 403);
  if (!['sent', 'viewed'].includes(agreement.status)) throw new AgreementError('INVALID_STATE', `Cannot sign an agreement in status '${agreement.status}'`, 409);
  if (!typedName || !String(typedName).trim()) throw new AgreementError('TYPED_NAME_REQUIRED', 'Typed signature name is required', 400);
  if (consent !== true || intent !== true) throw new AgreementError('CONSENT_REQUIRED', 'Consent and intent to sign are required', 400);

  const contentHash = sha256(agreement.rendered_body || '');
  let drawnUrl = null;
  if (drawnImageData && /^data:image\/png;base64,/.test(drawnImageData)) {
    try {
      const buf = Buffer.from(drawnImageData.split(',')[1], 'base64');
      const up = await cloudinaryService.uploadBuffer(buf, { folder: 'agreement-signatures', resource_type: 'image', public_id: `sig-${agreementId}`, overwrite: true });
      drawnUrl = up.secure_url;
    } catch (e) { /* drawn signature is optional */ }
  }
  const method = drawnUrl ? 'drawn' : 'typed';

  const sig = await db.query(
    `INSERT INTO agreement_signatures
       (agreement_id, signer_user_id, signer_role, method, typed_name, drawn_image_url,
        consent_acknowledged, intent_statement, content_sha256, signed_at, ip_address, user_agent)
     VALUES ($1,$2,'seller',$3,$4,$5,$6,$7,$8, now(), $9, $10) RETURNING *`,
    [agreementId, userId, method, String(typedName).trim(), drawnUrl, true, intentStatement || DEFAULT_INTENT, contentHash, ip || null, userAgent || null]
  );
  agreement = (await db.query(`UPDATE agreements SET status='signed', signed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [agreementId])).rows[0];
  await writeAuditLog({ event_type: 'agreement_signed', entity_type: 'agreement', entity_id: agreementId, actor_id: userId, metadata: { method, content_sha256: contentHash, ip_address: ip, user_agent: userAgent } });

  // PDF — non-blocking to the legal act. Stored PRIVATE; delivered via signed URLs.
  try {
    const { public_id, sha256: pdfHash, buffer } = await pdfService.generateAndStore(agreement, sig.rows[0]);
    agreement = (await db.query(`UPDATE agreements SET signed_pdf_public_id=$1, signed_pdf_sha256=$2, pdf_status='stored', updated_at=now() WHERE id=$3 RETURNING *`, [public_id, pdfHash, agreementId])).rows[0];
    await writeAuditLog({ event_type: 'agreement_pdf_stored', entity_type: 'agreement', entity_id: agreementId, metadata: { signed_pdf_sha256: pdfHash } });
    // Email the signed PDF to the seller (req 5). Best-effort, idempotent.
    await emailSignedPdf(agreement, buffer);
  } catch (e) {
    await db.query(`UPDATE agreements SET pdf_status='failed', updated_at=now() WHERE id=$1`, [agreementId]);
    console.error('[agreements] PDF generation failed for', agreementId, '-', e.message);
  }
  return { agreement, signature: sig.rows[0] };
}

// Email the signed PDF as an attachment. Idempotent via signed_pdf_emailed_at
// (only the first successful send stamps + audits). Best-effort: email is not the
// system of record, so failures never fail the signing.
async function emailSignedPdf(agreement, buffer) {
  try {
    if (!buffer || agreement.signed_pdf_emailed_at) return;
    const r = await db.query('SELECT u.email FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1', [agreement.seller_profile_id]);
    const to = r.rows[0] && r.rows[0].email;
    if (!to) return;
    await sendEmail({
      to,
      subject: 'Your signed Advantage Auction seller agreement',
      html: `<p>Thank you. Your Advantage Auction seller agreement has been signed.</p>
             <p>A copy of the signed agreement is attached as a PDF for your records. You can also download it any time from your account.</p>`,
      text: 'Your Advantage Auction seller agreement has been signed. A copy is attached as a PDF for your records. You can also download it any time from your account.',
      attachments: [{ filename: `advantage-seller-agreement-${agreement.id}.pdf`, content: buffer, contentType: 'application/pdf' }],
    });
    const u = await db.query(`UPDATE agreements SET signed_pdf_emailed_at=now(), updated_at=now() WHERE id=$1 AND signed_pdf_emailed_at IS NULL RETURNING id`, [agreement.id]);
    if (u.rowCount) await writeAuditLog({ event_type: 'agreement_pdf_emailed', entity_type: 'agreement', entity_id: agreement.id, metadata: { to } });
  } catch (e) {
    console.error('[agreements] signed PDF email failed for', agreement.id, '-', e.message);
  }
}

// ── Onboarding / dashboard gate ──────────────────────────────────────────────
// A seller has dashboard access when: an admin has waived the gate, OR they hold
// a current signed agreement, OR they are grandfathered (already have a non-draft
// auction). Otherwise access is blocked and we surface any pending signable
// agreement so the client can route them to sign it.
async function dashboardAccess(sellerProfileId) {
  const sp = (await db.query('SELECT id, agreement_waived_at FROM seller_profiles WHERE id = $1', [sellerProfileId])).rows[0];
  if (!sp) return { access: false, reason: 'seller_not_found', agreement_id: null };
  if (sp.agreement_waived_at) return { access: true, reason: 'waived', agreement_id: null };
  const signed = (await db.query(
    `SELECT id FROM agreements WHERE seller_profile_id = $1 AND status IN ('signed','countersigned')
      ORDER BY signed_at DESC NULLS LAST LIMIT 1`, [sellerProfileId])).rows[0];
  if (signed) return { access: true, reason: 'signed', agreement_id: signed.id };
  const gf = (await db.query(`SELECT 1 FROM auctions WHERE seller_id = $1 AND state <> 'draft' LIMIT 1`, [sellerProfileId])).rowCount;
  if (gf) return { access: true, reason: 'grandfathered', agreement_id: null };
  const pending = (await db.query(
    `SELECT id FROM agreements WHERE seller_profile_id = $1 AND status IN ('sent','viewed')
      ORDER BY created_at DESC LIMIT 1`, [sellerProfileId])).rows[0];
  return { access: false, reason: 'agreement_required', agreement_id: pending ? pending.id : null };
}

// Auto-send the current Seller Agreement to a seller who has none yet. Idempotent
// and side-effect-safe: skips waived sellers and sellers who already have a live or
// signed agreement. Never throws (onboarding/registration must not crash). Resolves
// the template's required variables from platform defaults (effective_terms_defaults)
// + the seller's account identity, so no admin is needed.
async function autoSendAgreement(sellerProfileId, actorId = null) {
  try {
    const sp = (await db.query(
      `SELECT sp.id, sp.seller_type, sp.agreement_waived_at, u.email, u.full_name
         FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [sellerProfileId])).rows[0];
    if (!sp) return { status: 'no_seller' };
    if (sp.agreement_waived_at) return { status: 'waived' };
    const existing = (await db.query(
      `SELECT id FROM agreements WHERE seller_profile_id = $1
         AND status IN ('draft','sent','viewed','signed','countersigned') ORDER BY created_at DESC LIMIT 1`, [sellerProfileId])).rows[0];
    if (existing) return { status: 'exists', agreement_id: existing.id };

    const tpl = (await db.query(
      `SELECT id FROM agreement_templates
        WHERE agreement_type = $1 AND is_active = true AND current_version_id IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`, [sp.seller_type || 'private'])).rows[0];
    if (!tpl) {
      await writeAuditLog({ event_type: 'seller_agreement_autosend_no_template', entity_type: 'seller_profile', entity_id: sellerProfileId, actor_id: actorId,
        metadata: { seller_type: sp.seller_type, alert: 'No active agreement template for this seller_type. Staff must author/activate one or send manually.' } });
      console.error('[onboarding] ALERT no active agreement template for seller_type=' + (sp.seller_type || 'private') + ' (seller ' + sellerProfileId + '); cannot auto-send.');
      return { status: 'missing_template' };
    }
    const who = (sp.full_name && sp.full_name.trim()) ? sp.full_name.trim() : sp.email;
    const overrides = {
      effective_date: new Date().toISOString().slice(0, 10),
      seller_type: sp.seller_type || 'private',
      legal_name: who, signatory_name: who,
    };
    try {
      const { agreement } = await sendAgreement({ sellerProfileId, overrides, actorId });
      await writeAuditLog({ event_type: 'seller_agreement_autosent', entity_type: 'agreement', entity_id: agreement.id, actor_id: actorId, metadata: { seller_profile_id: sellerProfileId } });
      return { status: 'sent', agreement_id: agreement.id };
    } catch (e) {
      await writeAuditLog({ event_type: 'seller_agreement_autosend_failed', entity_type: 'seller_profile', entity_id: sellerProfileId, actor_id: actorId,
        metadata: { code: e.code, message: e.message, alert: 'Auto-send failed (likely unresolved required variables). Staff should review and send manually.' } });
      console.error('[onboarding] auto-send failed for seller ' + sellerProfileId + ': ' + e.message);
      return { status: 'failed', code: e.code };
    }
  } catch (e) {
    console.error('[onboarding] autoSendAgreement error for seller ' + sellerProfileId + ': ' + e.message);
    return { status: 'error' };
  }
}

async function getOnboardingStatus(userId) {
  const sp = (await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId])).rows[0];
  if (!sp) return { is_seller: false, dashboard_access: true, required: false, reason: 'not_a_seller', agreement_id: null };
  let g = await dashboardAccess(sp.id);
  // Auto-send on first check: a seller who is blocked with no agreement yet (not
  // waived, not grandfathered) gets the current agreement created+sent now, so they
  // are never waiting on an admin. Idempotent; recompute after.
  let autosend = null;
  if (!g.access && g.reason === 'agreement_required' && !g.agreement_id) {
    autosend = await autoSendAgreement(sp.id, null);
    g = await dashboardAccess(sp.id);
  }
  const reason = (autosend && autosend.status === 'missing_template' && !g.access) ? 'missing_template' : g.reason;
  return {
    is_seller: true, seller_profile_id: sp.id,
    dashboard_access: g.access, required: !g.access,
    signed: g.reason === 'signed', waived: g.reason === 'waived', grandfathered: g.reason === 'grandfathered',
    reason, agreement_id: g.agreement_id,
  };
}

// Admin override: waive (or un-waive) the agreement gate for a seller.
async function waiveSellerGate(sellerProfileId, actorId, waive = true) {
  const sp = (await db.query('SELECT id FROM seller_profiles WHERE id = $1', [sellerProfileId])).rows[0];
  if (!sp) throw new AgreementError('SELLER_NOT_FOUND', 'Seller profile not found', 404);
  const u = await db.query(
    `UPDATE seller_profiles
        SET agreement_waived_at = CASE WHEN $2 THEN now() ELSE NULL END,
            agreement_waived_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END
      WHERE id = $1 RETURNING id, agreement_waived_at, agreement_waived_by`,
    [sellerProfileId, waive, actorId ?? null]);
  await writeAuditLog({
    event_type: waive ? 'seller_agreement_waived' : 'seller_agreement_unwaived',
    entity_type: 'seller_profile', entity_id: sellerProfileId, actor_id: actorId ?? null, metadata: {},
  });
  return u.rows[0];
}

async function resend(id, actorId) {
  const agreement = await getById(id);
  if (!agreement) throw new AgreementError('NOT_FOUND', 'Agreement not found', 404);
  if (!['sent', 'viewed'].includes(agreement.status)) throw new AgreementError('INVALID_STATE', `Cannot resend an agreement in status '${agreement.status}'`, 409);
  const rawToken = newRawToken();
  const u = await db.query(`UPDATE agreements SET access_token_hash=$1, token_expires_at=expires_at, updated_at=now() WHERE id=$2 RETURNING *`, [hashToken(rawToken), id]);
  await writeAuditLog({ event_type: 'agreement_resent', entity_type: 'agreement', entity_id: id, actor_id: actorId ?? null, metadata: {} });
  await emailLink(u.rows[0], rawToken);
  return { agreement: u.rows[0], rawToken };
}

async function reissue(id, { templateId, overrides, expiresInDays }, actorId) {
  const prior = await getById(id);
  if (!prior) throw new AgreementError('NOT_FOUND', 'Agreement not found', 404);
  if (['superseded', 'revoked'].includes(prior.status)) throw new AgreementError('INVALID_STATE', `Cannot reissue an agreement in status '${prior.status}'`, 409);
  const { agreement, rawToken } = await sendAgreement({ sellerProfileId: prior.seller_profile_id, templateId, overrides, expiresInDays, actorId });
  await db.query(`UPDATE agreements SET status='superseded', superseded_by_agreement_id=$1, access_token_hash=NULL, updated_at=now() WHERE id=$2`, [agreement.id, id]);
  await writeAuditLog({ event_type: 'agreement_superseded', entity_type: 'agreement', entity_id: id, actor_id: actorId ?? null, metadata: { superseded_by: agreement.id } });
  return { agreement, rawToken, superseded: id };
}

async function revoke(id, { reason }, actorId) {
  const agreement = await getById(id);
  if (!agreement) throw new AgreementError('NOT_FOUND', 'Agreement not found', 404);
  if (!['draft', 'sent', 'viewed'].includes(agreement.status)) throw new AgreementError('INVALID_STATE', `Cannot revoke an agreement in status '${agreement.status}'`, 409);
  const u = await db.query(`UPDATE agreements SET status='revoked', revoked_at=now(), revoke_reason=$1, access_token_hash=NULL, updated_at=now() WHERE id=$2 RETURNING *`, [reason || null, id]);
  await writeAuditLog({ event_type: 'agreement_revoked', entity_type: 'agreement', entity_id: id, actor_id: actorId ?? null, metadata: { reason: reason || null } });
  return u.rows[0];
}

async function expireOverdue() {
  const r = await db.query(`UPDATE agreements SET status='expired', updated_at=now() WHERE status IN ('sent','viewed') AND expires_at < now() RETURNING id`);
  for (const row of r.rows) await writeAuditLog({ event_type: 'agreement_expired', entity_type: 'agreement', entity_id: row.id, metadata: { via: 'sweep' } });
  return r.rows.length;
}

module.exports = {
  AgreementError, hashToken,
  sendAgreement, getById, getByToken, markViewed, listForSeller, listAll, getSignatures,
  signAgreement, resend, reissue, revoke, expireOverdue,
  emailSignedPdf, dashboardAccess, getOnboardingStatus, waiveSellerGate, autoSendAgreement,
};
