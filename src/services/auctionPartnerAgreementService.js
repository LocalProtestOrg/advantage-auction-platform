'use strict';

/**
 * auctionPartnerAgreementService — invitation + acceptance path for the Advantage.Bid Auction Partner Program.
 *
 * Customer-facing name: "Advantage.Bid Auction Partner Program". Internal records stay founding_partners /
 * FOUNDING_PARTNER (unchanged); that name never appears on a customer surface.
 *
 * Reuses the existing agreement system end to end:
 *   - The addendum is an agreement TEMPLATE (fixed id, agreement_type 'custom', is_active = false so it is never
 *     auto-selected for an ordinary seller) whose immutable versions are published from the ONE source file
 *     docs/legal/auction-partner-program-addendum.md. A content change publishes a new version; every agreement
 *     pins the version it rendered, so a signature always proves the exact text accepted. The email/PDF copy is
 *     rendered from the same file.
 *   - Acceptance = the existing authenticated signing flow (sign-agreement.html → POST /api/agreements/:id/sign):
 *     typed signature, review / consent / intent acknowledgments, server timestamp, IP, user agent, content SHA-256,
 *     signed PDF, audit events.
 *   - The base Seller Agreement and the professional application / business verification are the existing ones
 *     (POST /api/sellers/apply-professional auto-sends the Seller Agreement and requires business verification).
 *
 * Eligibility is INVITATION ONLY and fails closed:
 *   - An invitation is an HMAC-signed, expiring token bound to ONE founding_partners record (a staff-reserved
 *     prospect). It is issued and revoked by a Super Admin (audited). No public path creates Program eligibility.
 *   - The first professional seller to accept an invitation is bound to that record; anyone else is refused.
 *   - Accepting or signing NEVER applies the 0% fee. Staff activate the partner (foundingPartnerService.activate),
 *     which requires a signed addendum, and the Term dates come from that signature. Until then, and after the Term
 *     ends without the return fee restored, publishing the partner's auction is refused (no wrong-terms freeze).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');

const PROGRAM_NAME = 'Advantage.Bid Auction Partner Program';
const ADDENDUM_NAME = 'Advantage.Bid Auction Partner Program Addendum';
const TEMPLATE_ID = 'a9000000-0000-4000-8000-0000000000a1';
const SOURCE_FILE = path.join(__dirname, '..', '..', 'docs', 'legal', 'auction-partner-program-addendum.md');
const INVITE_DAYS = 30;
const SITE = process.env.PUBLIC_SITE_URL || 'https://bid.advantage.bid';
const VARIABLE_SCHEMA = [
  { key: 'legal_name', type: 'string', source: 'identity', required: true },
  { key: 'signatory_name', type: 'string', source: 'identity', required: true },
  { key: 'effective_date', type: 'date', source: 'manual', required: true },
];
const PRO_TYPES = ['auction_house', 'estate_sale_company', 'professional_liquidator'];

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ── the addendum text (one source) ────────────────────────────────────────────────────────────

function loadBody(file = SOURCE_FILE) {
  const md = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const a = md.indexOf('<!-- BEGIN ADDENDUM BODY -->'); const b = md.indexOf('<!-- END ADDENDUM BODY -->');
  if (a === -1 || b === -1 || b <= a) throw new Error('addendum body markers not found');
  return md.slice(a + '<!-- BEGIN ADDENDUM BODY -->'.length, b).trim();
}

/** Body with the per-partner variables shown as readable blanks (public preview and the email copy). */
function previewBody(body = loadBody()) {
  const labels = { legal_name: '[Auction Partner legal name]', signatory_name: '[Name of person signing]', effective_date: '[Date issued]' };
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => labels[k] || m);
}

/**
 * Make sure the addendum template exists and its current version is exactly the source text. Idempotent; publishes a
 * new immutable version (audited) only when the text changed. Returns { templateId, versionId, versionInt }.
 */
async function ensureTemplate({ actorId = null, runner = db } = {}) {
  const body = loadBody();
  const templates = require('./agreementTemplateService');
  let tpl = (await runner.query('SELECT id, current_version_id FROM agreement_templates WHERE id = $1', [TEMPLATE_ID])).rows[0];
  if (!tpl) {
    await runner.query(
      `INSERT INTO agreement_templates (id, agreement_type, name, description, is_active, created_by)
       VALUES ($1, 'custom', $2, $3, false, $4) ON CONFLICT (id) DO NOTHING`,
      [TEMPLATE_ID, ADDENDUM_NAME, 'Invitation-only addendum to the Seller Agreement. Never auto-sent (inactive by design).', actorId]);
    await writeAuditLog({ event_type: 'agreement_template_created', entity_type: 'agreement_template', entity_id: TEMPLATE_ID, actor_id: actorId,
      metadata: { agreement_type: 'custom', name: ADDENDUM_NAME, via: 'auction_partner_program' } });
    tpl = { id: TEMPLATE_ID, current_version_id: null };
  }
  let cur = tpl.current_version_id
    ? (await runner.query('SELECT id, version_int, body_markdown FROM agreement_template_versions WHERE id = $1', [tpl.current_version_id])).rows[0] : null;
  if (!cur || sha256(cur.body_markdown) !== sha256(body)) {
    cur = await templates.publishVersion(TEMPLATE_ID, { body_markdown: body, variable_schema: VARIABLE_SCHEMA, effective_terms_defaults: {}, created_by: actorId });
  }
  return { templateId: TEMPLATE_ID, versionId: cur.id, versionInt: cur.version_int };
}

// ── invitations (HMAC, expiring, bound to one record) ─────────────────────────────────────────

function secret() {
  const base = process.env.AUCTION_PARTNER_INVITE_SECRET || process.env.JWT_SECRET;
  if (!base) throw err(503, 'INVITES_UNAVAILABLE', 'Invitations are not available right now.');
  return crypto.createHmac('sha256', String(base)).update('advantage.bid/auction-partner-invite/v1').digest();
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + b64(crypto.createHmac('sha256', secret()).update(body).digest());
}

/** PURE-ish: verify signature and expiry. Returns the payload or null. */
function readToken(token, now = Date.now()) {
  const t = String(token || '');
  const dot = t.indexOf('.');
  if (dot < 1 || t.length > 600) return null;
  const body = t.slice(0, dot); const sig = t.slice(dot + 1);
  const expect = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(sig); const e = Buffer.from(expect);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!p || p.v !== 1 || !p.f || !p.i || !p.e) return null;
  if (Number(p.e) * 1000 < now) return null;
  return p;
}

/** Issue an invitation link for a reserved prospect. Super Admin (route enforces). Audited. Sends nothing. */
async function issueInvite(foundingPartnerId, { actorId, days = INVITE_DAYS, runner = db } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const fp = (await runner.query(`SELECT id, status, seller_profile_id, display_name FROM founding_partners WHERE id = $1`, [foundingPartnerId])).rows[0];
  if (!fp) throw err(404, 'NOT_FOUND', 'Record not found.');
  if (fp.status !== 'prospect') throw err(409, 'NOT_A_PROSPECT', 'Invitations are only for reserved prospects (this record is ' + fp.status + ').');
  await ensureTemplate({ actorId, runner });                    // the version the partner will see exists before the link does
  const now = Math.floor(Date.now() / 1000);
  const d = Math.min(Math.max(Number(days) || INVITE_DAYS, 1), 90);
  const payload = { v: 1, f: fp.id, i: now, e: now + d * 86400, n: crypto.randomBytes(6).toString('hex') };
  const token = signToken(payload);
  await writeAuditLog({ event_type: 'founding_partner.invite_issued', entity_type: 'founding_partner', entity_id: fp.id, actor_id: actorId,
    metadata: { nonce: payload.n, expires_at: new Date(payload.e * 1000).toISOString() } });
  return { url: SITE + '/auction-partner.html?invite=' + encodeURIComponent(token), expires_at: new Date(payload.e * 1000).toISOString() };
}

/** Revoke every invitation issued so far for a record (later invitations work). Audited. */
async function revokeInvites(foundingPartnerId, { actorId, runner = db } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  // Written directly (not through the best-effort audit helper): a revocation that silently failed would leave links
  // working. resolveInvite refuses every invitation issued at or before this row.
  await runner.query(
    `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('founding_partner.invites_revoked', 'founding_partner', $1, $2, $3::jsonb)`,
    [foundingPartnerId, actorId, JSON.stringify({ revoked_before: new Date().toISOString() })]);
  return { revoked: true };
}

/** Resolve an invitation to its record, failing closed. Returns { fp, payload } or throws a generic 404. */
async function resolveInvite(token, runner = db) {
  const invalid = () => err(404, 'INVITE_INVALID', 'This invitation link is not valid or has expired. Please contact Advantage.Bid for a new link.');
  const p = readToken(token);
  if (!p) throw invalid();
  const fp = (await runner.query(
    `SELECT id, status, seller_profile_id, display_name, market FROM founding_partners WHERE id = $1`, [p.f])).rows[0];
  if (!fp || fp.status !== 'prospect') throw invalid();
  const revoked = (await runner.query(
    `SELECT 1 FROM audit_log WHERE entity_type = 'founding_partner' AND entity_id = $1 AND event_type = 'founding_partner.invites_revoked'
        AND created_at >= to_timestamp($2) LIMIT 1`, [fp.id, p.i])).rowCount > 0;
  if (revoked) throw invalid();
  return { fp, payload: p };
}

/** Public (unauthenticated) view of an invitation: program, company, both agreements' text. No internal names. */
async function publicView(token, runner = db) {
  const { fp, payload } = await resolveInvite(token, runner);
  const tpl = await ensureTemplate({ runner });
  const agreementService = require('./agreementService');
  let sellerAgreement = null;
  try {
    const baseId = await agreementService.resolveBaseTemplateId('estate_sale_company');
    if (baseId) {
      const t = (await runner.query(
        `SELECT t.name, v.version_int, v.body_markdown FROM agreement_templates t JOIN agreement_template_versions v ON v.id = t.current_version_id WHERE t.id = $1`, [baseId])).rows[0];
      if (t) sellerAgreement = { name: t.name, version: t.version_int, body: t.body_markdown.replace(/\{\{\s*(\w+)\s*\}\}/g, '[$1]') };
    }
  } catch (_) { sellerAgreement = null; }
  return {
    program: PROGRAM_NAME, company: fp.display_name, invitation_expires_at: new Date(payload.e * 1000).toISOString(),
    addendum: { name: ADDENDUM_NAME, version: tpl.versionInt, body: previewBody() },
    seller_agreement: sellerAgreement,
  };
}

const ADDENDUM_LIVE = ['sent', 'viewed', 'signed', 'countersigned'];

/** The seller's addendum agreement (latest live one), or null. */
async function addendumFor(sellerProfileId, runner = db) {
  return (await runner.query(
    `SELECT a.* FROM agreements a JOIN agreement_template_versions v ON v.id = a.template_version_id
      WHERE a.seller_profile_id = $1 AND v.template_id = $2 AND a.status = ANY($3) ORDER BY a.created_at DESC LIMIT 1`,
    [sellerProfileId, TEMPLATE_ID, ADDENDUM_LIVE])).rows[0] || null;
}

/** The base Seller Agreement state for a seller (never the addendum). */
async function sellerAgreementFor(sellerProfileId, runner = db) {
  return (await runner.query(
    `SELECT a.id, a.status FROM agreements a JOIN agreement_template_versions v ON v.id = a.template_version_id
      WHERE a.seller_profile_id = $1 AND v.template_id <> $2 AND a.status IN ('sent','viewed','signed','countersigned')
      ORDER BY (a.status IN ('signed','countersigned')) DESC, a.created_at DESC LIMIT 1`, [sellerProfileId, TEMPLATE_ID])).rows[0] || null;
}

/**
 * Accept an invitation as the signed-in user (step before signing). Requires a professional seller profile (the
 * page creates one through the existing professional application first). Binds the invitation's record to this
 * seller (first come, fail closed), makes sure the Seller Agreement and the addendum exist for signing, and returns
 * the next steps. Idempotent. Never changes a fee.
 */
async function accept(token, { userId, runner = db } = {}) {
  if (!userId) throw err(401, 'LOGIN_REQUIRED', 'Please sign in to continue.');
  const { fp, payload } = await resolveInvite(token, runner);
  const sp = (await runner.query(
    `SELECT sp.id, sp.seller_type, sp.display_name, u.full_name, u.email FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.user_id = $1`, [userId])).rows[0];
  if (!sp || !PRO_TYPES.includes(sp.seller_type)) {
    throw err(409, 'PROFESSIONAL_PROFILE_REQUIRED', 'Set up your professional seller account first, then continue with the Auction Partner terms.');
  }
  if (fp.seller_profile_id && fp.seller_profile_id !== sp.id) {
    throw err(409, 'INVITE_ALREADY_CLAIMED', 'This invitation has already been accepted by another account. Please contact Advantage.Bid.');
  }
  const elsewhere = (await runner.query(
    `SELECT id FROM founding_partners WHERE seller_profile_id = $1 AND status <> 'ended' AND id <> $2 LIMIT 1`, [sp.id, fp.id])).rows[0];
  if (elsewhere) throw err(409, 'SELLER_ALREADY_IN_PROGRAM', 'This seller account is already linked to another Auction Partner invitation. Please contact Advantage.Bid.');
  if (!fp.seller_profile_id) {
    const claimed = await runner.query(
      `UPDATE founding_partners SET seller_profile_id = $2, updated_at = now() WHERE id = $1 AND seller_profile_id IS NULL AND status = 'prospect' RETURNING id`,
      [fp.id, sp.id]);
    if (!claimed.rowCount) throw err(409, 'INVITE_ALREADY_CLAIMED', 'This invitation has already been accepted by another account. Please contact Advantage.Bid.');
    await writeAuditLog({ event_type: 'founding_partner.invite_accepted', entity_type: 'founding_partner', entity_id: fp.id, actor_id: userId,
      metadata: { seller_profile_id: sp.id, invite_nonce: payload.n } });
  }
  const agreementService = require('./agreementService');
  await agreementService.autoSendAgreement(sp.id, userId);              // the base Seller Agreement (idempotent)
  let addendum = await addendumFor(sp.id, runner);
  if (!addendum) {
    const tpl = await ensureTemplate({ runner });
    const who = (sp.full_name && sp.full_name.trim()) || sp.email;
    const { agreement } = await agreementService.sendAgreement({
      sellerProfileId: sp.id, templateId: tpl.templateId, sendEmail: false, actorId: userId, expiresInDays: 30,
      overrides: { legal_name: sp.display_name || who, signatory_name: who, effective_date: new Date().toISOString().slice(0, 10) },
    });
    addendum = agreement;
    await writeAuditLog({ event_type: 'founding_partner.addendum_issued', entity_type: 'founding_partner', entity_id: fp.id, actor_id: userId,
      metadata: { agreement_id: agreement.id, template_version_id: agreement.template_version_id } });
  }
  return statusFor(sp.id, runner);
}

/** Checklist for the signed-in seller: Seller Agreement, addendum, verification, activation. */
async function statusFor(sellerProfileId, runner = db) {
  const base = await sellerAgreementFor(sellerProfileId, runner);
  const add = await addendumFor(sellerProfileId, runner);
  const fp = (await runner.query(`SELECT status, fee_applied_at FROM founding_partners WHERE seller_profile_id = $1 AND status <> 'ended' LIMIT 1`, [sellerProfileId])).rows[0] || null;
  let verification = 'not_requested';
  try {
    const v = (await runner.query(`SELECT status FROM verification_requests WHERE seller_profile_id = $1 ORDER BY created_at DESC LIMIT 1`, [sellerProfileId])).rows[0];
    if (v) verification = v.status;
  } catch (_) { verification = 'unknown'; }
  const signed = (a) => !!a && ['signed', 'countersigned'].includes(a.status);
  return {
    program: PROGRAM_NAME,
    seller_agreement: base ? { agreement_id: base.id, status: base.status, signed: signed(base) } : { agreement_id: null, status: 'pending', signed: false },
    addendum: add ? { agreement_id: add.id, status: add.status, signed: signed(add) } : { agreement_id: null, status: 'not_issued', signed: false },
    verification,
    program_active: !!(fp && fp.status === 'active' && fp.fee_applied_at),
  };
}

/** Is this agreement the Auction Partner addendum? */
async function isAddendum(agreement, runner = db) {
  if (!agreement || !agreement.template_version_id) return false;
  const r = (await runner.query('SELECT template_id FROM agreement_template_versions WHERE id = $1', [agreement.template_version_id])).rows[0];
  return !!r && r.template_id === TEMPLATE_ID;
}

/** After the addendum is signed: audit against the record and tell the Owner to review and activate. Never throws. */
async function onAddendumSigned(agreement, runner = db) {
  try {
    const fp = (await runner.query(`SELECT id, display_name FROM founding_partners WHERE seller_profile_id = $1 AND status <> 'ended' LIMIT 1`, [agreement.seller_profile_id])).rows[0];
    await writeAuditLog({ event_type: 'founding_partner.addendum_signed', entity_type: 'founding_partner', entity_id: fp ? fp.id : agreement.id,
      actor_id: agreement.seller_user_id, metadata: { agreement_id: agreement.id, seller_profile_id: agreement.seller_profile_id, linked_record: !!fp } });
    const oa = require('./ownerAlertService');
    await oa.notifyAdminActionRequired({
      actionType: (oa.ALERT_TYPES && oa.ALERT_TYPES.AUCTION_PARTNER_SIGNED) || 'auction_partner_signed',
      entityType: 'agreement', entityId: agreement.id,
      headline: 'Auction Partner addendum signed',
      context: (fp ? fp.display_name : 'A seller') + ' signed the Auction Partner Program Addendum. Review verification, then activate the partner terms.',
      adminPath: '/admin/founding-partners.html', actionLabel: 'Review',
    });
  } catch (e) { console.error('[auction-partner] post-sign hook failed:', e.message); }
}

/**
 * Publish guard. Returns null, or { code, message } when publishing this seller's auction now would freeze the wrong
 * economics: the addendum is signed but staff have not activated the partner terms yet, or the Term has ended while
 * the 0% fee is still applied.
 */
async function publishGuard(sellerProfileId, runner = db) {
  if (!sellerProfileId) return null;
  const fp = (await runner.query(
    `SELECT id, status, fee_applied_at, fee_restored_at, intro_end_date FROM founding_partners WHERE seller_profile_id = $1 AND status <> 'ended' LIMIT 1`,
    [sellerProfileId])).rows[0];
  if (!fp) return null;
  if (fp.status === 'active' && fp.fee_applied_at && !fp.fee_restored_at && fp.intro_end_date) {
    const end = new Date(fp.intro_end_date instanceof Date ? fp.intro_end_date.toISOString().slice(0, 10) + 'T23:59:59Z' : String(fp.intro_end_date).slice(0, 10) + 'T23:59:59Z');
    if (Date.now() > end.getTime()) {
      return { code: 'AUCTION_PARTNER_TERM_ENDED', message: 'This seller\'s Auction Partner term has ended. Restore the return platform fee on the Founding Partners page before publishing.' };
    }
  }
  if (fp.status === 'prospect') {
    const add = await addendumFor(sellerProfileId, runner);
    if (add && ['signed', 'countersigned'].includes(add.status)) {
      return { code: 'AUCTION_PARTNER_ACTIVATION_PENDING', message: 'This seller signed the Auction Partner Program Addendum, but the partner terms are not activated yet. Activate the partner on the Founding Partners page before publishing, so the auction freezes the agreed terms.' };
    }
  }
  return null;
}

/** The signed addendum that supports activation (date it was signed), or null. */
async function signedAddendum(sellerProfileId, runner = db) {
  return (await runner.query(
    `SELECT a.id, a.signed_at FROM agreements a JOIN agreement_template_versions v ON v.id = a.template_version_id
      WHERE a.seller_profile_id = $1 AND v.template_id = $2 AND a.status IN ('signed','countersigned') ORDER BY a.signed_at DESC LIMIT 1`,
    [sellerProfileId, TEMPLATE_ID])).rows[0] || null;
}

/** Term dates from a signature date: start = signed date, last day = the day before the first anniversary. Pure. */
function termFor(signedAt) {
  const d = new Date(signedAt);
  const start = d.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 1);
  return { start_date: start, intro_end_date: end.toISOString().slice(0, 10) };
}

module.exports = {
  PROGRAM_NAME, ADDENDUM_NAME, TEMPLATE_ID, SOURCE_FILE, INVITE_DAYS,
  loadBody, previewBody, ensureTemplate, signToken, readToken, issueInvite, revokeInvites, resolveInvite, publicView,
  accept, statusFor, addendumFor, isAddendum, onAddendumSigned, publishGuard, signedAddendum, termFor,
};
