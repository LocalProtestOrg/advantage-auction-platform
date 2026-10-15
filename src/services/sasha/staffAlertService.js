'use strict';

/**
 * Immediate staff notifications for actionable Sasha messages (owner request 2026-10-15; migration 196).
 *
 * An actionable message is a hand-off to a person (web chat, email, phone) or a phone callback request. It is recorded
 * in the secure staff inbox (cs_handoffs) BEFORE any notification is attempted, so it is never lost when delivery fails.
 *
 *   - ONE notification per actionable message per recipient: cs_staff_alerts has a unique key
 *     (hand-off, kind, channel, recipient) and only the request that inserts the row sends.
 *   - Email (full, actionable detail + a link to the staff inbox) to every address in sasha.staff_alert_emails.
 *   - SMS (no customer details: kind, channel and the inbox reference only) to every number in sasha.staff_alert_sms.
 *   - Delivery log: status, attempts, provider message id and last error per recipient (cs_staff_alerts).
 *   - A failed delivery is retried by the worker (retryFailed) up to MAX_ATTEMPTS within 24 hours, then 'gave_up'.
 *   - Sends only in production (or with transports injected by tests); never for simulated / certification calls.
 * Recipients are Super Admin settings (platform_config), never hard-coded.
 */

const db = require('../../db');

const EMAIL_KEY = 'sasha.staff_alert_emails';
const SMS_KEY = 'sasha.staff_alert_sms';
const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/;
const US_E164 = /^\+1[2-9]\d{9}$/;
const REASONS = { customer_request: 'Customer asked for a person', dispute: 'Dispute', legal: 'Legal question', privacy: 'Privacy request',
  security: 'Security concern', fraud: 'Possible fraud', account_change: 'Account change', uncertain: 'Sasha could not answer', conflict: 'Conflicting information', other: 'Needs review' };

let injected = null; // tests: { email: async ({to,subject,text,html}) => ({id}), sms: async ({to,message}) => ({id}) }
function _setTransportsForTest(t) { injected = t; }

function transports() {
  if (injected) return injected;
  if (process.env.NODE_ENV !== 'production') return null;   // dev, test and the certification harness never notify
  return {
    email: async (m) => {
      const r = await require('../emailService').sendEmail({ ...m, fromName: 'Advantage.Bid Customer Service' });
      if (r && r.skipped) throw new Error('email delivery is not configured');
      return { id: (r && (r.sesMessageId || r.messageId)) || null };
    },
    sms: async (m) => { const r = await require('../smsService').sendSMS(m); return { id: r && r.sid } ; },
  };
}

function cleanEmails(list) { return [...new Set((Array.isArray(list) ? list : []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.length <= 254 && EMAIL_RE.test(e)))]; }
function cleanNumbers(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((n) => {
    const d = String(n || '').replace(/[^\d+]/g, '');
    const e = d.startsWith('+') ? d : (d.length === 10 ? '+1' + d : (d.length === 11 && d.startsWith('1') ? '+' + d : d));
    return e;
  }).filter((e) => US_E164.test(e)))];
}

async function recipients(runner = db) {
  const rows = (await runner.query(`SELECT key, value FROM platform_config WHERE key = ANY($1::text[])`, [[EMAIL_KEY, SMS_KEY]])).rows;
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { emails: cleanEmails(v[EMAIL_KEY]), sms: cleanNumbers(v[SMS_KEY]) };
}

/** Super Admin: replace the recipient lists (validated). Returns the stored lists. */
async function setRecipients({ emails, sms }, runner = db) {
  const out = {};
  if (emails !== undefined) {
    const e = cleanEmails(emails);
    if (Array.isArray(emails) && e.length !== emails.filter((x) => String(x || '').trim()).length) throw Object.assign(new Error('Every email must be a single valid address.'), { status: 400 });
    out.emails = e;
  }
  if (sms !== undefined) {
    const n = cleanNumbers(sms);
    if (Array.isArray(sms) && n.length !== sms.filter((x) => String(x || '').trim()).length) throw Object.assign(new Error('Every text-alert number must be a US mobile number.'), { status: 400 });
    out.sms = n;
  }
  if (out.emails && out.emails.length > 10 || out.sms && out.sms.length > 10) throw Object.assign(new Error('At most 10 recipients of each kind.'), { status: 400 });
  for (const [key, val] of [[EMAIL_KEY, out.emails], [SMS_KEY, out.sms]]) {
    if (!val) continue;
    await runner.query(`INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, 'sasha')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(val)]);
  }
  return recipients(runner);
}

const SITE = () => require('../../lib/publicUrls').publicBaseUrl().replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const channelLabel = (c) => ({ phone: 'phone call', chat: 'website chat', email: 'email' }[c] || c || 'message');

async function loadContext(handoffId) {
  const h = (await db.query(`SELECT h.*, c.ref, c.channel, c.subject, c.customer_name, c.customer_email, c.id AS conv_id,
      EXISTS (SELECT 1 FROM cs_calls k WHERE k.conversation_id = c.id AND k.is_simulated) AS simulated
    FROM cs_handoffs h JOIN cs_conversations c ON c.id = h.conversation_id WHERE h.id = $1`, [handoffId])).rows[0];
  if (!h) return null;
  const last = (await db.query(`SELECT body_text AS body FROM cs_messages WHERE conversation_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    [h.conv_id]).catch(() => ({ rows: [] }))).rows[0];
  return { ...h, last_customer_message: last ? last.body : null };
}

function buildEmail(ctx, kind) {
  const reason = REASONS[ctx.reason_code] || REASONS.other;
  const head = kind === 'callback' ? 'Callback requested' : 'A customer needs a person';
  const link = `${SITE()}/admin/sasha-inbox.html?c=${encodeURIComponent(ctx.conv_id)}`;
  const rows = [
    ['Reference', ctx.ref], ['Channel', channelLabel(ctx.channel)], ['Reason', reason],
    ['Customer', ctx.customer_name || '(not given)'], ['Email', ctx.customer_email || '(not given)'],
    ...(kind === 'callback' ? [['Call back on', ctx.callback_phone_e164 || '(no number)']] : []),
    ['Summary', clip(ctx.reason_text, 1000) || '(none)'],
    ...(ctx.last_customer_message ? [['Last customer message', clip(ctx.last_customer_message, 600)]] : []),
    ['Received', new Date(ctx.created_at || Date.now()).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET'],
  ];
  const subject = `[Advantage.Bid] ${head}: ${reason} (Ref ${ctx.ref})`;
  const text = `${head}.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen it in the staff inbox (sign-in required): ${link}\n\nOne notice is sent per message. Reply to the customer from the staff inbox, not from this email.`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px">` +
    `<h2 style="font-size:18px;margin:0 0 12px">${esc(head)}</h2><table style="border-collapse:collapse;font-size:14px">` +
    rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('') +
    `</table><p style="margin:16px 0"><a href="${esc(link)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">Open in the staff inbox</a></p>` +
    `<p style="color:#666;font-size:12px">One notice is sent per message. Reply to the customer from the staff inbox, not from this email.</p></div>`;
  return { subject, text, html };
}

/** SMS: no customer details — kind, channel and the inbox reference only. */
function buildSms(ctx, kind) {
  return `Advantage.Bid: ${kind === 'callback' ? 'callback requested' : 'a customer needs a person'} (${channelLabel(ctx.channel)}, Ref ${ctx.ref}). Details are in your email and the staff inbox.`;
}

async function deliver(row, ctx, t) {
  try {
    let r;
    if (row.channel === 'email') r = await t.email({ to: row.recipient, ...buildEmail(ctx, row.kind) });
    else r = await t.sms({ to: row.recipient, message: buildSms(ctx, row.kind) });
    await db.query(`UPDATE cs_staff_alerts SET status = 'sent', provider_message_id = $2, last_error = NULL, sent_at = now(), updated_at = now() WHERE id = $1`,
      [row.id, (r && r.id) ? String(r.id).slice(0, 200) : null]);
    return 'sent';
  } catch (e) {
    const giveUp = row.attempts >= MAX_ATTEMPTS;
    await db.query(`UPDATE cs_staff_alerts SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
      [row.id, giveUp ? 'gave_up' : 'failed', String((e && e.message) || e).slice(0, 500)]);
    console.error('[sasha-staff-alert] delivery failed', row.channel, giveUp ? '(giving up)' : '(will retry)', e && e.message);
    return giveUp ? 'gave_up' : 'failed';
  }
}

/**
 * Notify staff about one actionable message. Idempotent: a second call for the same hand-off and kind sends nothing.
 * Never throws (the message is already safe in the inbox). Returns a per-recipient outcome summary.
 */
async function notify(handoffId, { kind = 'handoff' } = {}) {
  try {
    const t = transports();
    if (!t) return { notified: false, reason: 'notifications send in production only' };
    const ctx = await loadContext(handoffId);
    if (!ctx) return { notified: false, reason: 'hand-off not found' };
    if (ctx.simulated) return { notified: false, reason: 'simulated call' };
    const rc = await recipients();
    const targets = [...rc.emails.map((r) => ['email', r]), ...rc.sms.map((r) => ['sms', r])];
    if (!targets.length) return { notified: false, reason: 'no staff alert recipients configured' };
    const out = { notified: true, sent: 0, failed: 0, duplicate: 0 };
    for (const [channel, recipient] of targets) {
      const row = (await db.query(`INSERT INTO cs_staff_alerts (handoff_id, conversation_id, kind, channel, recipient, status, attempts)
          VALUES ($1, $2, $3, $4, $5, 'sending', 1) ON CONFLICT (handoff_id, kind, channel, recipient) DO NOTHING RETURNING *`,
        [handoffId, ctx.conv_id, kind, channel, recipient])).rows[0];
      if (!row) { out.duplicate++; continue; }            // already notified (or being notified) for this message
      const r = await deliver(row, ctx, t);
      if (r === 'sent') out.sent++; else out.failed++;
    }
    return out;
  } catch (e) {
    console.error('[sasha-staff-alert] notify failed (the message is in the staff inbox):', e && e.message);
    return { notified: false, reason: 'error' };
  }
}

/** Worker: retry failed deliveries (and ones stuck mid-send after a restart), bounded. */
async function retryFailed({ limit = 20 } = {}) {
  const t = transports();
  if (!t) return { retried: 0 };
  const rows = (await db.query(`UPDATE cs_staff_alerts SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM cs_staff_alerts
                    WHERE (status = 'failed' OR (status IN ('pending', 'sending') AND updated_at < now() - interval '10 minutes'))
                      AND attempts < $1 AND created_at > now() - interval '24 hours'
                    ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [MAX_ATTEMPTS, limit])).rows;
  let sent = 0;
  for (const row of rows) {
    const ctx = await loadContext(row.handoff_id);
    if (!ctx) continue;
    if ((await deliver(row, ctx, t)) === 'sent') sent++;
  }
  await db.query(`UPDATE cs_staff_alerts SET status = 'gave_up', updated_at = now()
    WHERE status = 'failed' AND (attempts >= $1 OR created_at <= now() - interval '24 hours')`, [MAX_ATTEMPTS]);
  return { retried: rows.length, sent };
}

/**
 * Super Admin "send a test": a clearly-labelled test message in the staff inbox (no customer), notified through the
 * real path to every configured recipient, then marked resolved. Returns the per-recipient outcome.
 */
async function sendTest(actorId) {
  const conversations = require('./conversationService');
  const conv = await conversations.createConversation({ channel: 'chat', subject: 'Staff notification test - no action needed', customerName: 'Notification test (staff)' });
  await db.query(`UPDATE cs_conversations SET handoff_reason = 'Staff notification test' WHERE id = $1`, [conv.id]);
  const { handoffId } = await conversations.requestHandoff(conv.id, { reasonCode: 'other', reasonText: 'Test of staff notifications requested by a Super Admin. No customer is waiting.', createdBy: 'staff', notify: false });
  const result = await notify(handoffId, { kind: 'handoff' });
  await db.query(`UPDATE cs_handoffs SET status = 'resolved', resolved_at = now(), taken_by = $2 WHERE id = $1`, [handoffId, actorId || null]);
  await db.query(`UPDATE cs_conversations SET status = 'resolved', handoff_state = 'resolved', updated_at = now() WHERE id = $1`, [conv.id]);
  return { ref: conv.ref, ...result };
}

/** Delivery log for the admin page (recipients masked). */
async function recentDeliveries({ limit = 50 } = {}) {
  const { maskEmailForLog } = require('../../lib/logSafe');
  const rows = (await db.query(`SELECT a.id, a.kind, a.channel, a.recipient, a.status, a.attempts, a.last_error, a.created_at, a.sent_at, c.ref
      FROM cs_staff_alerts a LEFT JOIN cs_conversations c ON c.id = a.conversation_id ORDER BY a.created_at DESC LIMIT $1`, [Math.min(200, limit)])).rows;
  return rows.map((r) => ({ ...r, recipient: r.channel === 'email' ? maskEmailForLog(r.recipient) : '…' + String(r.recipient).slice(-4) }));
}

module.exports = { notify, retryFailed, sendTest, recipients, setRecipients, recentDeliveries, buildEmail, buildSms, cleanNumbers, cleanEmails,
  EMAIL_KEY, SMS_KEY, MAX_ATTEMPTS, _setTransportsForTest };
