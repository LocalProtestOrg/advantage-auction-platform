'use strict';

/**
 * ownerNotifyService — owner security notices: a sensitive platform setting changed, a paid advertising authorization
 * was created or revoked, the paid emergency stop was used.
 *
 * Every notice goes to BOTH channels:
 *   email  each address in platform_config owner.notify_emails (migration 222; platform owner editable only)
 *   text   the existing owner alert numbers (ownerAlertService), short, with no customer data, linking to the admin page
 *
 * A notice is information, never approval: nothing waits for it, and a failed notice changes nothing that was decided.
 * Failures are logged and returned; this never throws.
 */

const db = require('../db');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const BASE = () => (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const noLongDash = (s) => String(s == null ? '' : s).replace(/[–—―]/g, '-');

async function recipients(runner = db) {
  try {
    const row = (await runner.query(`SELECT value FROM platform_config WHERE key = 'owner.notify_emails'`)).rows[0];
    const list = row && Array.isArray(row.value) ? row.value : [];
    return [...new Set(list.map((e) => String(e || '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
  } catch (e) {
    console.error('[owner-notify] could not read owner.notify_emails:', e.message);
    return [];
  }
}

function buildEmail({ subject, reason, recommendation, risk, adminPath, details }) {
  const link = BASE() + (adminPath || '/admin/');
  const lines = [
    noLongDash(reason),
    risk ? 'Risk: ' + noLongDash(risk) : '',
    recommendation ? 'Recommended: ' + noLongDash(recommendation) : '',
    ...(details || []).map((d) => noLongDash(d)),
    'Review: ' + link,
    'This notice is information only. Nothing waits for a reply, and no change is approved or undone by this message.',
  ].filter(Boolean);
  const text = lines.join('\n\n') + '\n\nAdvantage.Bid';
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:16px">
<h2 style="font-size:17px;margin:0 0 12px">${esc(noLongDash(subject))}</h2>
${lines.slice(0, -2).map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.5">${esc(l)}</p>`).join('\n')}
<p style="margin:16px 0"><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px">Open Admin</a></p>
<p style="margin:0;font-size:12px;color:#64748b">${esc(lines[lines.length - 1])}</p>
</body></html>`;
  return { subject: 'Advantage.Bid owner notice: ' + noLongDash(subject), text, html };
}

function buildSms({ subject, adminPath }) {
  const alerts = require('./ownerAlertService');
  return 'Advantage.Bid: ' + (alerts.sanitizeField(noLongDash(subject), 90) || 'Owner notice') + '.\n\nReview:\n' + alerts.adminUrl(adminPath || '/admin/');
}

/**
 * Send one owner notice. Returns { ok, email: {attempted, sent, failed}, sms: {attempted, sent, failed} }.
 * `ok` means at least one channel delivered; it is reporting, never authorization.
 */
async function notify({ subject, reason, recommendation = null, risk = null, adminPath = '/admin/', details = [] } = {}, deps = {}) {
  const runner = deps.runner || db;
  const result = { ok: false, email: { attempted: 0, sent: 0, failed: 0 }, sms: { attempted: 0, sent: 0, failed: 0 } };
  if (!subject) return result;

  try {
    const mail = deps.emailService || require('./emailService');
    const to = await recipients(runner);
    if (!to.length) console.warn('[owner-notify] no owner notice email address configured (owner.notify_emails)');
    const msg = buildEmail({ subject, reason: reason || subject, recommendation, risk, adminPath, details });
    for (const addr of to) {
      result.email.attempted++;
      try {
        const r = await mail.sendEmail({ to: addr, subject: msg.subject, text: msg.text, html: msg.html });
        if (r && r.skipped) { result.email.failed++; console.warn('[owner-notify] email not sent (mail not configured)'); }
        else result.email.sent++;
      } catch (e) { result.email.failed++; console.error('[owner-notify] email failed:', e.message); }
    }
  } catch (e) { console.error('[owner-notify] email channel error:', e.message); }

  try {
    const alerts = deps.ownerAlertService || require('./ownerAlertService');
    const r = await alerts.sendOwnerAlert(alerts.ALERT_TYPES.OWNER_SECURITY_NOTICE, buildSms({ subject, adminPath }));
    result.sms.attempted = (r && r.attempted) || 0;
    result.sms.sent = (r && r.sent) || 0;
    result.sms.failed = (r && r.failed) || 0;
    if (!result.sms.sent) console.warn('[owner-notify] text notice not delivered:', (r && (r.reason || r.last_error)) || 'unknown');
  } catch (e) { result.sms.failed++; console.error('[owner-notify] text channel error:', e.message); }

  result.ok = result.email.sent > 0 || result.sms.sent > 0;
  if (!result.ok) console.error('[owner-notify] NOTICE NOT DELIVERED on any channel:', noLongDash(subject));
  return result;
}

module.exports = { notify, recipients, buildEmail, buildSms };
