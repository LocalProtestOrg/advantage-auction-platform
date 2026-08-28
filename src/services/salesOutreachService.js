'use strict';

/**
 * salesOutreachService — representative-based 1:1 prospect outreach.
 *
 * The sending identity is ALWAYS derived server-side from the prospect's assigned representative
 * (never from client input): technical From = the verified central sender, From display name =
 * "{Rep} — Advantage.Bid", Reply-To = the rep's approved @advantage.bid address, BCC = the central
 * company mailbox (owner oversight). A rep can only send for prospects assigned to them (Super Admins
 * may send for any); unassigned or unconfigured/disabled reps are blocked. Success marks the prospect
 * Contacted + logs activity; failure never falsely marks contact. The CRM is the authoritative record.
 */

const db = require('../db');
const emailService = require('./emailService');
const prospects = require('./salesProspectService');
const templates = require('./salesOutreachTemplates');

const APP_FROM_DISPLAY_SUFFIX = ' — Advantage.Bid';
const OUTREACH_BCC = process.env.OUTREACH_BCC || 'info@advantage.bid';
// Approved outreach identities must be on the verified sending domain (deliverability + anti-spoofing).
const APPROVED_EMAIL_DOMAIN = 'advantage.bid';
const DUP_WINDOW_SECONDS = 45;

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Rep outreach identities (Admin-managed) ─────────────────────────────────────────────────────────
async function getRepProfile(userId, runner = db) {
  if (!userId) return null;
  const { rows } = await runner.query(
    `SELECT p.user_id, p.display_name, p.outreach_email, p.outreach_enabled,
            u.staff_active, u.staff_role, u.email AS login_email
       FROM sales_rep_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`, [userId]);
  return rows[0] || null;
}
async function listRepProfiles(runner = db) {
  const { rows } = await runner.query(
    `SELECT p.user_id, p.display_name, p.outreach_email, p.outreach_enabled, p.updated_at,
            u.staff_active, u.staff_role, u.email AS login_email
       FROM sales_rep_profiles p JOIN users u ON u.id = p.user_id
      ORDER BY p.display_name ASC`);
  return rows;
}
// Admin-only: approve/update a rep's outreach identity. Validates the email is on the approved domain.
async function upsertRepProfile({ userId, displayName, outreachEmail, enabled }, actorId, runner = db) {
  const name = (displayName || '').trim();
  const email = (outreachEmail || '').trim().toLowerCase();
  if (!userId) throw err(400, 'USER_REQUIRED', 'A staff user is required.');
  if (!name) throw err(400, 'NAME_REQUIRED', 'A display name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(400, 'EMAIL_INVALID', 'A valid outreach email is required.');
  if (email.split('@')[1] !== APPROVED_EMAIL_DOMAIN) {
    throw err(400, 'EMAIL_NOT_APPROVED', `Outreach email must be an @${APPROVED_EMAIL_DOMAIN} address.`);
  }
  const u = (await runner.query('SELECT id FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) throw err(404, 'USER_NOT_FOUND', 'Staff user not found.');
  const { rows } = await runner.query(
    `INSERT INTO sales_rep_profiles (user_id, display_name, outreach_email, outreach_enabled, created_by_user_id)
     VALUES ($1,$2,$3,COALESCE($4,true),$5)
     ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name,
       outreach_email = EXCLUDED.outreach_email, outreach_enabled = EXCLUDED.outreach_enabled, updated_at = now()
     RETURNING *`,
    [userId, name, email, enabled === undefined ? true : !!enabled, actorId || null]);
  return rows[0];
}

/**
 * Resolve the sending identity for a prospect from its ASSIGNED representative (server-authoritative).
 * actingStaff = { id, is_super_admin }. Throws on: no assignment, not-your-prospect (non-admin),
 * rep has no approved profile, rep outreach disabled, or rep account inactive.
 * Returns { repUserId, displayName, replyTo, fromName }.
 */
async function resolveIdentity(prospect, actingStaff, runner = db) {
  const repUserId = prospect.assigned_rep_user_id;
  if (!repUserId) throw err(409, 'REP_REQUIRED', 'Assign a representative to this prospect before sending personalized outreach.');
  const isSelf = actingStaff && actingStaff.id === repUserId;
  const isAdmin = !!(actingStaff && actingStaff.is_super_admin);
  if (!isSelf && !isAdmin) throw err(403, 'NOT_YOUR_PROSPECT', 'This prospect is assigned to another representative.');
  const rep = await getRepProfile(repUserId, runner);
  if (!rep) throw err(409, 'REP_NOT_CONFIGURED', 'The assigned representative has no approved outreach email. Ask an admin to set one.');
  if (rep.staff_active === false) throw err(409, 'REP_INACTIVE', 'The assigned representative’s account is inactive.');
  if (!rep.outreach_enabled) throw err(409, 'REP_DISABLED', 'Outreach is disabled for the assigned representative.');
  return {
    repUserId,
    displayName: rep.display_name,
    replyTo: rep.outreach_email,
    fromName: rep.display_name + APP_FROM_DISPLAY_SUFFIX,
  };
}

function signatureText(identity) {
  return `\n\n--\n${identity.displayName}\nAdvantage.Bid\n${identity.replyTo}`;
}
function signatureHtml(identity) {
  return `<div style="margin-top:18px;padding-top:12px;border-top:1px solid #e6eaef;font-size:13px;color:#475569">
    <strong style="color:#0f172a">${escHtml(identity.displayName)}</strong><br>Advantage<span style="color:#2563eb">.Bid</span><br>
    <a href="mailto:${escHtml(identity.replyTo)}" style="color:#2563eb">${escHtml(identity.replyTo)}</a></div>`;
}
// Branded, escaped HTML body from the rep's (edited) plain-text message + controlled signature.
function renderHtml(message, identity) {
  const paras = String(message || '').split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 12px;font-size:14.5px;line-height:1.55;color:#111">${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border:1px solid #e6eaef;border-radius:12px;padding:22px">
      ${paras}
      ${signatureHtml(identity)}
    </div>
  </div></body></html>`;
}

// Composer view-model: identity (or requiresAssignment), recipient, template catalog, suggested render.
async function buildComposer(prospectId, actingStaff, runner = db) {
  const prospect = await prospects.getProspect(prospectId);
  if (!prospect) throw err(404, 'PROSPECT_NOT_FOUND', 'Prospect not found.');
  const out = {
    prospect_id: prospect.id, company_name: prospect.company_name,
    recipient_email: prospect.business_email || null,
    has_email: !!(prospect.business_email && prospect.business_email.trim()),
    templates: templates.catalog(), suggested_key: templates.suggestKey(prospect),
    bcc_company: OUTREACH_BCC,
  };
  try {
    const identity = await resolveIdentity(prospect, actingStaff, runner);
    out.identity = { display_name: identity.displayName, reply_to: identity.replyTo, from_name: identity.fromName };
    const rep = { display_name: identity.displayName };
    out.suggested = templates.render(out.suggested_key, prospect, rep);
  } catch (e) {
    out.requires = { code: e.code, message: e.message };  // e.g. REP_REQUIRED / REP_NOT_CONFIGURED
    out.suggested = templates.render(out.suggested_key, prospect, { display_name: '' });
  }
  return out;
}

// Render a specific template for the composer (rep may then edit).
async function renderForComposer(prospectId, key, actingStaff, runner = db) {
  const prospect = await prospects.getProspect(prospectId);
  if (!prospect) throw err(404, 'PROSPECT_NOT_FOUND', 'Prospect not found.');
  let repName = '';
  try { const id = await resolveIdentity(prospect, actingStaff, runner); repName = id.displayName; } catch (_) {}
  return templates.render(key, prospect, { display_name: repName }) ||
    err(400, 'TEMPLATE_UNKNOWN', 'Unknown template.');
}

async function recentDuplicate(prospectId, subject, runner = db) {
  const { rows } = await runner.query(
    `SELECT 1 FROM sales_outreach_emails
      WHERE prospect_id = $1 AND lower(subject) = lower($2) AND status IN ('sent','queued')
        AND created_at > now() - ($3 || ' seconds')::interval LIMIT 1`,
    [prospectId, subject || '', String(DUP_WINDOW_SECONDS)]);
  return rows.length > 0;
}

/**
 * Send one representative outreach email. Recipient comes from the prospect record (never client input).
 * On SES accept → logs 'sent', marks Contacted, appends activity, sets follow-up. On failure → logs
 * 'failed', NEVER marks contacted. Returns { status:'sent'|'failed', ... }. Throws 4xx for authz/validation.
 */
async function sendOutreach({ prospectId, actingStaff, templateKey, subject, message, followUpDays }, deps = {}) {
  const runner = deps.db || db;
  const send = deps.sendEmail || emailService.sendEmail;
  const prospect = await prospects.getProspect(prospectId);
  if (!prospect) throw err(404, 'PROSPECT_NOT_FOUND', 'Prospect not found.');
  const recipient = (prospect.business_email || '').trim();
  if (!recipient) throw err(400, 'NO_RECIPIENT', 'This prospect has no business email. Use the Call action instead.');
  const subj = (subject || '').trim();
  const body = (message || '').trim();
  if (!subj) throw err(400, 'SUBJECT_REQUIRED', 'A subject is required.');
  if (!body) throw err(400, 'MESSAGE_REQUIRED', 'A message is required.');

  const identity = await resolveIdentity(prospect, actingStaff, runner);   // authz + identity (throws)
  if (await recentDuplicate(prospectId, subj, runner)) {
    throw err(429, 'DUPLICATE_SEND', 'An identical message was just sent to this prospect. Please wait a moment.');
  }

  const html = renderHtml(body, identity);
  const text = body + signatureText(identity);
  const actorId = actingStaff && actingStaff.id;

  let result;
  try {
    result = await send({
      to: recipient, subject: subj, html, text,
      fromName: identity.fromName, replyTo: identity.replyTo, bcc: OUTREACH_BCC,
    });
  } catch (e) {
    await logEmail(runner, { prospectId, identity, actorId, recipient, subject: subj, templateKey,
      body: text, status: 'failed', error: (e && e.message) || 'send_failed' });
    return { status: 'failed', error: (e && e.message) || 'Send failed' };
  }
  if (result && result.skipped) {   // SMTP not configured — treat as a real failure, never mark contacted
    await logEmail(runner, { prospectId, identity, actorId, recipient, subject: subj, templateKey,
      body: text, status: 'failed', error: 'email_not_configured' });
    return { status: 'failed', error: 'Email delivery is not configured on the server.' };
  }

  // SES accepted the message. Record it + drive the CRM side-effects.
  const log = await logEmail(runner, { prospectId, identity, actorId, recipient, subject: subj, templateKey,
    body: text, status: 'sent', messageId: (result && result.messageId) || null });

  // Activity attributed to the REP who the email was sent as (section 20). This also bumps last_contact_at
  // and last_contacted_by to the rep.
  const label = templates.BY_KEY[templateKey] ? templates.BY_KEY[templateKey].label : 'Outreach';
  await prospects.addNote(prospectId, identity.repUserId, 'email', `Email sent: ${label} — "${subj}"`);
  // Advance to Contacted only from a pre-contact stage; keep further-along statuses.
  if (['new_lead', 'research_complete'].includes(prospect.contact_status)) {
    await runner.query(`UPDATE sales_prospects SET contact_status='contacted', updated_at=now() WHERE id=$1`, [prospectId]);
    await prospects.addNote(prospectId, identity.repUserId, 'status_change', 'Status → Contacted');
  }
  if (followUpDays && Number(followUpDays) > 0) {
    await runner.query(
      `UPDATE sales_prospects SET next_follow_up_at = now() + ($2 || ' days')::interval, updated_at=now() WHERE id=$1`,
      [prospectId, String(parseInt(followUpDays, 10))]);
  }
  return { status: 'sent', message_id: (result && result.messageId) || null, log };
}

async function logEmail(runner, o) {
  const { rows } = await runner.query(
    `INSERT INTO sales_outreach_emails
       (prospect_id, rep_user_id, sent_by_user_id, rep_display_name, from_email, from_name, reply_to_email,
        recipient_email, subject, template_key, body_snapshot, status, provider_message_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [o.prospectId, o.identity.repUserId, o.actorId || null, o.identity.displayName,
     null, o.identity.fromName, o.identity.replyTo, o.recipient, o.subject, o.templateKey || null,
     o.body, o.status, o.messageId || null, o.error || null]);
  return rows[0];
}

async function listOutreachForProspect(prospectId, runner = db) {
  const { rows } = await runner.query(
    `SELECT o.*, r.email AS rep_login_email FROM sales_outreach_emails o
       LEFT JOIN users r ON r.id = o.rep_user_id
      WHERE o.prospect_id = $1 ORDER BY o.created_at DESC`, [prospectId]);
  return rows;
}

module.exports = {
  getRepProfile, listRepProfiles, upsertRepProfile, resolveIdentity,
  buildComposer, renderForComposer, sendOutreach, listOutreachForProspect,
  recentDuplicate, renderHtml, signatureText, OUTREACH_BCC, APPROVED_EMAIL_DOMAIN, DUP_WINDOW_SECONDS,
};
