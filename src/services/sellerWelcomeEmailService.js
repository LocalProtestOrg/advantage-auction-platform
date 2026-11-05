'use strict';

/**
 * Professional Seller welcome email: once per seller, delivered reliably (owner request 2026-11-05; migration 221).
 * The same outbox pattern as storefrontNotificationService (migration 204):
 *
 *   enqueue(client, {...})  INSIDE the enrollment transaction, only when a seller BECOMES a Professional Seller through
 *                           registration. UNIQUE (seller_profile_id) + ON CONFLICT DO NOTHING: a repeated form
 *                           submission, a retry or a double click can never queue a second welcome.
 *   deliverSoon(id)         right after the enrollment commits: one immediate attempt, so the seller has it in seconds.
 *   tick()                  the in-process sender: leases due rows (SKIP LOCKED), sends, records; back-off retries after a
 *                           temporary failure; after the last attempt the row is 'failed' and the owner is alerted.
 *   start()                 runs tick() on an interval.
 *
 * Delivery is at-least-once only in one rare case (the process dies after the email is handed to the mail service but
 * before 'sent' is recorded); otherwise exactly once. Each lease counts as an attempt, so nothing retries forever.
 * The row holds only the delivery address; the email contains only the company name the seller typed.
 */
const db = require('../db');
const emails = require('./professionalSellerEmails');

const MAX_ATTEMPTS = 6;
const BATCH = 20;
const LEASE_SEC = 300;
const INTERVAL_MS = 60000;
const backoffMinutes = (attempts) => Math.min(240, 2 ** attempts);   // 2, 4, 8, 16, 32 … minutes (capped at 4 hours)

/**
 * Queue the welcome for this seller profile (call inside the enrollment transaction). Returns the new row id, or null
 * when nothing was queued: already welcomed, a demo account, or no email address on the account.
 */
async function enqueue(client, { sellerProfileId, userId }) {
  // A savepoint keeps the welcome from ever failing the enrollment itself (for example before migration 221 is applied).
  await client.query('SAVEPOINT seller_welcome');
  let r;
  try {
    r = await client.query(
    `INSERT INTO seller_welcome_emails (seller_profile_id, user_id, recipient_email)
     SELECT $1, u.id, lower(u.email) FROM users u
      WHERE u.id = $2 AND u.email IS NOT NULL AND length(u.email) >= 3 AND COALESCE(u.is_demo, false) = false
     ON CONFLICT (seller_profile_id) DO NOTHING
     RETURNING id`, [sellerProfileId, userId]);
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT seller_welcome');
    console.error('[seller-welcome] could not queue the welcome email (enrollment continues):', e.message);
    return null;
  }
  await client.query('RELEASE SAVEPOINT seller_welcome');
  return r.rows[0] ? r.rows[0].id : null;
}

async function recordFailure(row, e, deps) {
  const final = row.attempts >= MAX_ATTEMPTS;
  await db.query(`UPDATE seller_welcome_emails SET status = $2, last_error = $3, locked_at = NULL,
      next_attempt_at = now() + ($4 || ' minutes')::interval WHERE id = $1`,
    [row.id, final ? 'failed' : 'pending', String(e.message || e).slice(0, 500), String(backoffMinutes(row.attempts))]);
  if (final) {
    try {
      const alerts = deps.ownerAlertService || require('./ownerAlertService');
      await alerts.notifyAdminActionRequired({ actionType: alerts.ALERT_TYPES.SELLER_WELCOME_EMAIL_FAILED || 'seller_welcome_email_failed', entityType: 'seller_profile', entityId: row.seller_profile_id,
        headline: 'A new Professional Seller welcome email could not be delivered', context: `${MAX_ATTEMPTS} attempts failed.`, adminPath: '/admin/users.html' });
    } catch (_e) { /* best-effort; the row stays 'failed' for review */ }
  }
  return final ? 'failed' : 'retry';
}

async function deliverOne(row, deps = {}) {
  const sp = (await db.query(
    `SELECT COALESCE(NULLIF(sp.display_name, ''), sp.metadata->>'business_name') AS company_name, COALESCE(u.is_demo, false) AS is_demo
       FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [row.seller_profile_id])).rows[0];
  if (!sp || sp.is_demo) {
    await db.query(`UPDATE seller_welcome_emails SET status = 'skipped', last_error = $2, locked_at = NULL WHERE id = $1`,
      [row.id, sp ? 'demo account' : 'seller not found']);
    return 'skipped';
  }
  const m = emails.buildWelcomeEmail({ companyName: sp.company_name });
  const mail = deps.emailService || require('./emailService');
  let r;
  try {
    r = await mail.sendEmail({ to: row.recipient_email, subject: m.subject, html: m.html, text: m.text });
  } catch (e) {
    return recordFailure(row, e, deps);
  }
  // No mail service configured (a test or local environment): nothing was sent, so it is never recorded as sent.
  if (r && r.skipped) {
    await db.query(`UPDATE seller_welcome_emails SET status = 'skipped', last_error = 'email service not configured', locked_at = NULL WHERE id = $1`, [row.id]);
    return 'skipped';
  }
  // Recorded outside the send's try: a database hiccup here never turns a delivered welcome back into 'pending'.
  await db.query(`UPDATE seller_welcome_emails SET status = 'sent', sent_at = now(), locked_at = NULL, provider_message_id = $2, last_error = NULL
    WHERE id = $1`, [row.id, (r && (r.messageId || r.MessageId)) || null]);
  return 'sent';
}

// Leases rows (all due rows, or just `onlyId`) so two processes never send the same welcome at the same time.
async function lease(onlyId) {
  return (await db.query(
    `UPDATE seller_welcome_emails SET status = 'processing', locked_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM seller_welcome_emails WHERE status = 'pending' AND next_attempt_at <= now()
                    AND ($1::uuid IS NULL OR id = $1::uuid)
                    ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING *`, [onlyId || null])).rows;
}

async function tick(deps = {}) {
  await db.query(`UPDATE seller_welcome_emails SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END, locked_at = NULL,
      last_error = COALESCE(last_error, 'delivery interrupted')
    WHERE status = 'processing' AND locked_at < now() - interval '${LEASE_SEC} seconds'`);
  const out = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  for (const row of await lease(null)) out[await deliverOne(row, deps)]++;
  return out;
}

/** One immediate attempt for a just-queued welcome (after the enrollment commits). Never throws. */
async function deliverNow(id, deps = {}) {
  try {
    const rows = await lease(id);
    return rows[0] ? await deliverOne(rows[0], deps) : 'not_due';
  } catch (e) { console.error('[seller-welcome] immediate delivery failed (the sender retries):', e.message); return 'error'; }
}
function deliverSoon(id) { if (id) setImmediate(() => { deliverNow(id); }); }

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => {
      // Before migration 221 the table does not exist: stop quietly instead of logging every minute.
      if (e && e.code === '42P01') { clearInterval(timer); timer = null; console.warn('[seller-welcome] sender idle: seller_welcome_emails not present'); return; }
      console.error('[seller-welcome] tick failed:', e.message);
    });
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { enqueue, deliverNow, deliverSoon, tick, start, MAX_ATTEMPTS, backoffMinutes };
