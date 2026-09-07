'use strict';

/**
 * ownerAlertService - operational SMS alerts to Advantage.Bid's owner for the three seller actions that
 * need immediate human attention:
 *   1. an auction is submitted for review              -> notifyOwnerAuctionSubmitted(auctionId)
 *   2. an estate sale is submitted for review          -> notifyOwnerEstateSaleSubmitted(eventId)
 *   3. a marketing package is successfully purchased    -> notifyOwnerMarketingPackagePurchased({...})
 *
 * Design:
 *   - BEST-EFFORT, NON-BLOCKING. Every public function swallows its own errors and returns a small result
 *     object; callers still `.catch(() => {})`. A provider/SMS failure must NEVER break a valid seller
 *     submission or a verified payment.
 *   - Deduplication is the CALLER's responsibility - each function is wired to an authoritative, already-
 *     deduped state transition (auction -> 'submitted', estate sale -> 'submitted', webhook pending -> paid).
 *     This service does not re-check; it just composes + sends.
 *   - Recipient routing is config-driven and role-ready: recipientsFor(alertType) resolves an optional
 *     per-team number first, then the primary owner number. Today all three route to the owner.
 *   - Reuses the existing Twilio transport (smsService.sendSMS). No competing SMS subsystem.
 *   - Security: the owner phone lives ONLY in config (OWNER_ALERT_PHONE_E164), never in code. Seller/event
 *     text is sanitized before composing. Admin links are fixed Advantage.Bid routes (no user-controlled
 *     URL); only an internal UUID is interpolated (encoded). Logs carry the alert type + outcome only -
 *     never the phone number, the message body, or seller PII.
 */

const crypto = require('crypto');
const db = require('../db');
const { sendSMS } = require('./smsService');

// The app host (admin lives here). Matches marketplaceOrderNotifier / estate-sale services.
const ADMIN_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

// E.164: leading '+', country digit 1-9, then 7-14 more digits.
const E164_RE = /^\+[1-9]\d{7,14}$/;
function isE164(n) { return typeof n === 'string' && E164_RE.test(n.trim()); }

// Parse a comma-separated recipient string → trimmed, VALIDATED (E.164), DEDUPED list. Malformed entries
// are dropped safely (never throws). Used for OWNER_ALERT_PHONE_E164S and any per-team multi override.
function parseRecipients(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(',')) {
    const n = part.trim();
    if (isE164(n) && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// Non-reversible recipient tag for per-recipient idempotency + audit. NEVER stores the phone number.
function recipientHash(n) { return crypto.createHash('sha256').update(String(n || '')).digest('hex').slice(0, 16); }
// Masked recipient for logs (last 4 only) — never the full number.
function maskRecipient(n) { const s = String(n || ''); return s.length >= 4 ? '…' + s.slice(-4) : '…'; }

// Alert type constants (also used as the per-team env routing keys).
const ALERT_TYPES = {
  AUCTION_SUBMITTED: 'auction_submitted',
  ESTATE_SALE_SUBMITTED: 'estate_sale_submitted',
  MARKETING_PACKAGE_PURCHASED: 'marketing_package_purchased',
  BUSINESS_LISTING_SUBMITTED: 'business_listing_submitted',
  PROFESSIONAL_AUCTION_PUBLISHED: 'professional_auction_published',
  OWNER_ALERT_TEST: 'owner_alert_test',
  // Admin-Action-Required families (Phase: unified Admin Action Required SMS).
  PROFESSIONAL_SELLER_VERIFICATION_PENDING: 'professional_seller_verification_pending',
  PAYOUT_RELEASE_PENDING: 'payout_release_pending',
  SETTLEMENT_EXCEPTION: 'settlement_exception',
  COMPLIANCE_ESCALATION: 'compliance_escalation',
};

// ── Recipient routing (role-ready) ────────────────────────────────────────────
// Future operational teams get their own optional number; each falls back to the primary owner number so
// nothing is ever silently dropped. Today all three types resolve to OWNER_ALERT_PHONE_E164.
const PER_TYPE_ENV = {
  [ALERT_TYPES.AUCTION_SUBMITTED]: 'OWNER_ALERT_PHONE_AUCTIONS',
  [ALERT_TYPES.ESTATE_SALE_SUBMITTED]: 'OWNER_ALERT_PHONE_ESTATE_SALES',
  [ALERT_TYPES.MARKETING_PACKAGE_PURCHASED]: 'OWNER_ALERT_PHONE_MARKETING',
  [ALERT_TYPES.BUSINESS_LISTING_SUBMITTED]: 'OWNER_ALERT_PHONE_LISTINGS',
  [ALERT_TYPES.PROFESSIONAL_AUCTION_PUBLISHED]: 'OWNER_ALERT_PHONE_AUCTIONS',
  // A controlled test always routes to the PRIMARY owner number (no per-team override).
  [ALERT_TYPES.OWNER_ALERT_TEST]: null,
  // Admin-Action-Required families route to ALL configured owner-alert recipients (no per-team split today).
  [ALERT_TYPES.PROFESSIONAL_SELLER_VERIFICATION_PENDING]: null,
  [ALERT_TYPES.PAYOUT_RELEASE_PENDING]: null,
  [ALERT_TYPES.SETTLEMENT_EXCEPTION]: null,
  [ALERT_TYPES.COMPLIANCE_ESCALATION]: null,
};

// Resolve the VALIDATED, DEDUPED recipient list for an alert type. Precedence:
//   1. a per-team override env for this type (may itself be a comma list), else
//   2. OWNER_ALERT_PHONE_E164S (comma-separated multi list — Owner + Joey + …), else
//   3. OWNER_ALERT_PHONE_E164 (the original single-recipient variable — backward compatible).
// Every operational alert is delivered independently to EACH number in this list.
function recipientsFor(alertType) {
  const perTypeEnv = PER_TYPE_ENV[alertType];
  const perType = perTypeEnv ? (process.env[perTypeEnv] || '') : '';
  if (perType && parseRecipients(perType).length) return parseRecipients(perType);
  const multi = process.env.OWNER_ALERT_PHONE_E164S || '';
  if (parseRecipients(multi).length) return parseRecipients(multi);
  return parseRecipients(process.env.OWNER_ALERT_PHONE_E164 || '');
}

function ownerAlertConfigured() {
  return recipientsFor(ALERT_TYPES.AUCTION_SUBMITTED).some(isE164);
}

// ── Composition helpers (pure) ─────────────────────────────────────────────────
// Strip control chars (incl. newlines/tabs), collapse whitespace, and cap length so untrusted seller/event
// text can never inject blank lines or bloat the SMS. Char-code filter avoids any hex/unicode escapes.
function sanitizeField(v, max = 80) {
  let s = String(v == null ? '' : v)
    .split('')
    .map((ch) => { const c = ch.charCodeAt(0); return (c < 32 || c === 127) ? ' ' : ch; })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = s.slice(0, max - 3).trimEnd() + '...';
  return s;
}

// Fixed Advantage.Bid admin routes. `id` (when present) is an internal UUID, URL-encoded. No user input
// is ever placed in the path or host.
function adminUrl(path, id, param = 'id') {
  const clean = '/' + String(path || '').replace(/^\/+/, '');
  return id ? `${ADMIN_BASE}${clean}?${param}=${encodeURIComponent(id)}` : `${ADMIN_BASE}${clean}`;
}

// Email is REQUIRED by the owner for fast account lookup; show an explicit placeholder if truly absent.
function emailLine(email) {
  const e = sanitizeField(email, 120);
  return `Email: ${e || '(not available)'}`;
}
function sellerLine(name) {
  const n = sanitizeField(name);
  return n ? `Seller: ${n}\n` : '';
}

function buildAuctionSubmittedMessage({ title, sellerName, sellerEmail, url }) {
  return `Advantage.Bid: Auction submitted for review.\n\n`
    + `${sanitizeField(title) || 'Untitled auction'}\n`
    + `${sellerLine(sellerName)}`
    + `${emailLine(sellerEmail)}\n\n`
    + `Review:\n${url}`;
}

function buildEstateSaleSubmittedMessage({ title, sellerName, sellerEmail, url }) {
  return `Advantage.Bid: Estate sale submitted for review.\n\n`
    + `${sanitizeField(title) || 'Untitled estate sale'}\n`
    + `${sellerLine(sellerName)}`
    + `${emailLine(sellerEmail)}\n\n`
    + `Review:\n${url}`;
}

function buildMarketingPackageMessage({ packageName, sellerName, sellerEmail, eventTitle, url }) {
  const ev = sanitizeField(eventTitle);
  return `Advantage.Bid: Marketing package purchased.\n\n`
    + `Package: ${sanitizeField(packageName) || 'Marketing package'}\n`
    + `${sellerLine(sellerName)}`
    + `${emailLine(sellerEmail)}\n`
    + `${ev ? `Event: ${ev}\n` : ''}`
    + `\nAdmin:\n${url}`;
}

function buildBusinessListingSubmittedMessage({ companyName, businessType, sellerEmail, url }) {
  const bt = sanitizeField(businessType);
  return `Advantage.Bid: Business listing submitted for review.\n\n`
    + `${sanitizeField(companyName) || 'Unnamed business'}\n`
    + `${bt ? `Type: ${bt}\n` : ''}`
    + `${emailLine(sellerEmail)}\n\n`
    + `Review:\n${url}`;
}

// ── Reusable ADMIN-ACTION-REQUIRED message + notifier ───────────────────────────
// Generic, concise, actionable composition for any workflow that enters a state where an Admin/Super Admin
// must act before the business process can proceed. Future workflows reuse notifyAdminActionRequired()
// instead of a bespoke Twilio implementation. Carries only context + account email + a direct admin URL.
function buildAdminActionMessage({ headline, context, email, actionLabel, url }) {
  const ctx = sanitizeField(context, 96);
  const em = sanitizeField(email, 120);
  return `Advantage.Bid: ${sanitizeField(headline, 64) || 'Admin action required'}.\n\n`
    + `${ctx ? ctx + '\n' : ''}`
    + `${em ? `Account: ${em}\n` : ''}`
    + `\n${actionLabel || 'Open'}:\n${url}`;
}

// Emit an Admin-Action-Required SMS to EVERY configured recipient with per-recipient durable idempotency.
// Alert on the AUTHORITATIVE transition INTO the action-required state; entityId should be stable for that
// specific requirement so retries/restarts never re-text, but a genuinely NEW later requirement (distinct
// entityId, e.g. a new payout row or a re-submission) legitimately alerts again. Never throws.
async function notifyAdminActionRequired({ actionType, entityType, entityId, headline, context, email, adminPath, adminId, adminParam, actionLabel }) {
  try {
    if (!actionType || !entityId) { console.warn('[owner-alert] admin-action missing actionType/entityId'); return { skipped: true, reason: 'bad_args' }; }
    if (!ownerAlertConfigured()) return sendOwnerAlert(actionType, '');
    const url = adminUrl(adminPath || '/admin/moderation.html', adminId, adminParam || 'id');
    const message = buildAdminActionMessage({ headline, context, email, actionLabel, url });
    return await sendOwnerAlertOnce({ alertType: actionType, entityType: entityType || 'admin_action', entityId, message });
  } catch (err) {
    console.error('[owner-alert] admin-action alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

// Informational (NOT an approval request): a verified/active Professional Seller auto-published an auction.
function buildProfessionalAuctionPublishedMessage({ companyName, title, state, lots, sellerEmail, url }) {
  const st = sanitizeField(state, 24);
  const n = (lots != null && !Number.isNaN(Number(lots))) ? Number(lots) : null;
  return `Advantage.Bid: Professional auction published.\n\n`
    + `${sanitizeField(title) || 'Untitled auction'}\n`
    + `${sellerLine(companyName)}`
    + `${emailLine(sellerEmail)}\n`
    + `${st ? `State: ${st}\n` : ''}`
    + `${n != null ? `Lots: ${n}\n` : ''}`
    + `\nReview:\n${url}`;
}

// A clearly-labeled controlled TEST message. Carries no seller/customer PII — only an optional short,
// sanitized operator note and the fixed admin URL. Used to verify the operational-alert pipe end-to-end
// WITHOUT creating any auction/estate-sale/marketing/financial record.
function buildTestMessage({ note } = {}) {
  const n = sanitizeField(note, 100);
  return `Advantage.Bid: Owner alert TEST.\n\n`
    + `This is a controlled test of operational SMS alerts. No action needed.\n`
    + `${n ? `Note: ${n}\n` : ''}`
    + `\nAdmin:\n${adminUrl('/admin/moderation.html')}`;
}

// ── Transport ──────────────────────────────────────────────────────────────────
// Sends one composed message to EVERY routed recipient, independently. Never throws. A failure to one
// recipient never prevents another. Logs alert type + masked recipient (last 4) + outcome only.
async function sendOwnerAlert(alertType, message) {
  const recipients = recipientsFor(alertType);
  if (!recipients.length) {
    console.warn(`[owner-alert] ${alertType} not sent - no valid owner-alert recipient configured`);
    return { attempted: 0, sent: 0, failed: 0, skipped: true, reason: 'not_configured' };
  }
  let sent = 0, failed = 0, provider_sid = null, provider_status = null, last_error = null;
  for (const to of recipients) {
    try {
      const r = await sendSMS({ to, message });
      sent++;
      if (!provider_sid && r) { provider_sid = r.sid || null; provider_status = r.status || null; }
      console.log(`[owner-alert] ${alertType} delivered to ${maskRecipient(to)}`);
    } catch (err) {
      failed++;
      last_error = (err && err.message ? err.message : 'send_failed').slice(0, 300);
      console.error(`[owner-alert] ${alertType} send failed for ${maskRecipient(to)}: ${err.message}`);
      if (process.env.SENTRY_DSN) { try { require('@sentry/node').captureException(err); } catch (_) { /* ignore */ } }
    }
  }
  return { attempted: recipients.length, sent, failed, skipped: false, provider_sid, provider_status, last_error };
}

// Idempotent send to ONE recipient (dedup on alert_type:entity:recipient_hash). Never throws.
async function sendToRecipientOnce(alertType, entityType, entityId, message, to) {
  const rhash = recipientHash(to);
  const dedupKey = `${alertType}:${entityId}:${rhash}`;
  let rowId = null;
  try {
    const ins = await db.query(
      `INSERT INTO owner_alert_log (alert_type, entity_type, entity_id, recipient_hash, dedup_key, status, first_attempt_at, attempts)
       VALUES ($1,$2,$3,$4,$5,'pending', now(), 0) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
      [alertType, entityType, String(entityId), rhash, dedupKey]);
    if (ins.rows[0]) { rowId = ins.rows[0].id; }
    else {
      const ex = (await db.query(`SELECT id, status FROM owner_alert_log WHERE dedup_key = $1`, [dedupKey])).rows[0];
      if (!ex) throw new Error('dedup row vanished');
      rowId = ex.id;
      if (ex.status === 'sent') return { sent: false, skipped: true, reason: 'already_sent' };
      if (ex.status === 'pending') return { sent: false, skipped: true, reason: 'in_flight' };
      await db.query(`UPDATE owner_alert_log SET status='pending', updated_at=now() WHERE id=$1`, [rowId]); // retry a prior failure
    }
  } catch (e) {
    // Dedup log unavailable → best-effort direct send to THIS recipient (do not block delivery).
    console.error('[owner-alert] dedup log unavailable for a recipient, direct send fallback:', e.message);
    try { const r = await sendSMS({ to, message }); console.log(`[owner-alert] ${alertType} delivered to ${maskRecipient(to)} (fallback)`); return { sent: true, provider_sid: r && r.sid, provider_status: r && r.status }; }
    catch (err) { return { sent: false, failed: true, last_error: (err.message || 'send_failed').slice(0, 300) }; }
  }
  try {
    const r = await sendSMS({ to, message });
    console.log(`[owner-alert] ${alertType} delivered to ${maskRecipient(to)}`);
    await db.query(`UPDATE owner_alert_log SET status='sent', provider_sid=$2, provider_status=$3, attempts=attempts+1, sent_at=now(), updated_at=now() WHERE id=$1`, [rowId, (r && r.sid) || null, (r && r.status) || null]).catch(() => {});
    return { sent: true, provider_sid: r && r.sid, provider_status: r && r.status };
  } catch (err) {
    const msg = (err && err.message ? err.message : 'send_failed').slice(0, 300);
    console.error(`[owner-alert] ${alertType} send failed for ${maskRecipient(to)}: ${err.message}`);
    if (process.env.SENTRY_DSN) { try { require('@sentry/node').captureException(err); } catch (_) { /* ignore */ } }
    await db.query(`UPDATE owner_alert_log SET status='failed', last_error=$2, attempts=attempts+1, updated_at=now() WHERE id=$1`, [rowId, msg]).catch(() => {});
    return { sent: false, failed: true, last_error: msg };
  }
}

// Durable, idempotent, MULTI-RECIPIENT send: delivers to every configured recipient, tracking delivery
// state PER RECIPIENT so one recipient's prior success/failure never suppresses another's. At most ONE
// successful SMS per (event, recipient) across retries/restarts/deploys. Best-effort; never throws.
async function sendOwnerAlertOnce({ alertType, entityType, entityId, message }) {
  const recipients = recipientsFor(alertType);
  if (!recipients.length) {
    console.warn(`[owner-alert] ${alertType} not sent - no valid owner-alert recipient configured`);
    return { attempted: 0, sent: 0, failed: 0, skipped: true, reason: 'not_configured' };
  }
  let sent = 0, failed = 0, skippedCount = 0, provider_sid = null, provider_status = null, last_error = null;
  for (const to of recipients) {
    const r = await sendToRecipientOnce(alertType, entityType, entityId, message, to);
    if (r.sent) { sent++; if (!provider_sid) { provider_sid = r.provider_sid || null; provider_status = r.provider_status || null; } }
    else if (r.skipped) { skippedCount++; }
    else { failed++; if (r.last_error) last_error = r.last_error; }
  }
  // Aggregate: 'skipped' true only when NOTHING was sent/failed (all recipients already handled).
  const allSkipped = sent === 0 && failed === 0 && skippedCount > 0;
  return { attempted: recipients.length, sent, failed, skipped: allSkipped, reason: allSkipped ? 'already_sent' : undefined, provider_sid, provider_status, last_error };
}

// ── Context loaders + public notify functions ──────────────────────────────────
// Each loads only the minimal, non-sensitive fields it needs, composes, and sends. All are best-effort:
// a lookup or send failure is logged and swallowed (they also return a result for testing/observability).

async function notifyOwnerAuctionSubmitted(auctionId) {
  try {
    if (!ownerAlertConfigured()) return sendOwnerAlert(ALERT_TYPES.AUCTION_SUBMITTED, '');
    const row = (await db.query(
      `SELECT a.title,
              COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name,
              u.email AS seller_email
         FROM auctions a
         LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
         LEFT JOIN users u ON u.id = sp.user_id
        WHERE a.id = $1`, [auctionId])).rows[0];
    if (!row) { console.warn(`[owner-alert] auction ${auctionId} not found - no alert`); return { skipped: true, reason: 'not_found' }; }
    const message = buildAuctionSubmittedMessage({
      title: row.title, sellerName: row.seller_name, sellerEmail: row.seller_email,
      url: adminUrl('/admin/moderation.html', auctionId, 'auctionId'),   // deep-links to the specific auction in the review console
    });
    return await sendOwnerAlertOnce({ alertType: ALERT_TYPES.AUCTION_SUBMITTED, entityType: 'auction', entityId: auctionId, message });
  } catch (err) {
    console.error('[owner-alert] auction-submitted alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

async function notifyOwnerEstateSaleSubmitted(eventId) {
  try {
    if (!ownerAlertConfigured()) return sendOwnerAlert(ALERT_TYPES.ESTATE_SALE_SUBMITTED, '');
    const row = (await db.query(
      `SELECT e.title,
              o.name AS org_name,
              u.email AS seller_email,
              u.full_name AS owner_name
         FROM events e
         JOIN organizations o ON o.id = e.organization_id
         LEFT JOIN organization_members m ON m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active'
         LEFT JOIN users u ON u.id = m.user_id
        WHERE e.id = $1
        LIMIT 1`, [eventId])).rows[0];
    if (!row) { console.warn(`[owner-alert] estate sale ${eventId} not found - no alert`); return { skipped: true, reason: 'not_found' }; }
    const message = buildEstateSaleSubmittedMessage({
      title: row.title, sellerName: row.org_name || row.owner_name, sellerEmail: row.seller_email,
      url: adminUrl('/admin/event-detail.html', eventId),
    });
    return await sendOwnerAlertOnce({ alertType: ALERT_TYPES.ESTATE_SALE_SUBMITTED, entityType: 'event', entityId: eventId, message });
  } catch (err) {
    console.error('[owner-alert] estate-sale-submitted alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

// Friendly package label from an authoritative product_type + amount. Package IDENTITY comes from the
// purchase record — NEVER inferred from price. Price is only appended for the owner's quick context, and
// ANY tier (incl. a future $499 package) is supported because the amount is read, never hard-coded.
function packageLabel(productType, amountCents) {
  const map = {
    estate_sale_promotion: 'Estate Sale Promotion',
    featured_placement: 'Featured Placement',
    premium_marketing: 'Premium Marketing',
    basic_listing: 'Basic Listing',
  };
  const name = map[String(productType || '').toLowerCase()] || (productType ? sanitizeField(productType, 48) : 'Marketing package');
  if (amountCents != null && Number.isFinite(Number(amountCents))) {
    const dollars = (Number(amountCents) / 100);
    return `${name} ($${dollars.toFixed(dollars % 1 === 0 ? 0 : 2)})`;
  }
  return name;
}

// A marketing package was SUCCESSFULLY purchased. `purchaseId` (a one_time_purchases id) makes the package
// identity + amount AUTHORITATIVE (never price-inferred) and provides a durable idempotency key. Falls back
// to an explicit packageName when a purchase row is not supplied.
async function notifyOwnerMarketingPackagePurchased({ userId, purchaseId, packageName, packageProductType, amountCents, eventTitle } = {}) {
  try {
    if (!ownerAlertConfigured()) return sendOwnerAlert(ALERT_TYPES.MARKETING_PACKAGE_PURCHASED, '');
    let sellerName = '', sellerEmail = '', productType = packageProductType || null, amt = (amountCents != null ? amountCents : null), eventId = null;
    if (purchaseId) {
      const p = (await db.query('SELECT user_id, product_type, amount_cents, event_id FROM one_time_purchases WHERE id = $1', [purchaseId])).rows[0];
      if (p) { userId = userId || p.user_id; productType = productType || p.product_type; if (amt == null) amt = p.amount_cents; eventId = p.event_id || null; }
    }
    if (userId) {
      const u = (await db.query('SELECT email, contact_email, full_name FROM users WHERE id = $1', [userId])).rows[0];
      if (u) { sellerName = u.full_name || ''; sellerEmail = u.contact_email || u.email || ''; }
    }
    const label = packageName || packageLabel(productType, amt);
    const message = buildMarketingPackageMessage({
      packageName: label, sellerName, sellerEmail, eventTitle,
      // Direct destination: the specific event if the purchase is linked, else the purchasing seller's account.
      url: eventId ? adminUrl('/admin/event-detail.html', eventId) : (sellerEmail ? adminUrl('/admin/users.html', sellerEmail, 'q') : adminUrl('/admin/users.html')),
    });
    // Idempotent per purchase when we have a durable purchase id; otherwise a per-user best-effort key.
    const entityId = purchaseId || `user:${userId || 'unknown'}`;
    return await sendOwnerAlertOnce({ alertType: ALERT_TYPES.MARKETING_PACKAGE_PURCHASED, entityType: purchaseId ? 'one_time_purchase' : 'user', entityId, message });
  } catch (err) {
    console.error('[owner-alert] marketing-package alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

async function notifyOwnerBusinessListingSubmitted({ companyName, businessType, ownerEmail, organizationId, submittedAt } = {}) {
  try {
    if (!ownerAlertConfigured()) return sendOwnerAlert(ALERT_TYPES.BUSINESS_LISTING_SUBMITTED, '');
    const message = buildBusinessListingSubmittedMessage({
      companyName, businessType, sellerEmail: ownerEmail,
      url: adminUrl('/admin/business-listings.html'),
    });
    // ADMIN ACTION REQUIRED: pending Approve & Publish. When we have the org id, use per-recipient durable
    // idempotency (entity = org:submittedAt) so retries never re-text but a genuine RE-submission
    // (changes_requested → submitted, new submitted_at) legitimately re-alerts. Falls back to a direct send
    // when no org id is supplied (backward compatible with existing callers/tests).
    if (organizationId) {
      const cycle = submittedAt ? new Date(submittedAt).getTime() : '';
      return await sendOwnerAlertOnce({ alertType: ALERT_TYPES.BUSINESS_LISTING_SUBMITTED, entityType: 'organization', entityId: `${organizationId}:${cycle}`, message });
    }
    return await sendOwnerAlert(ALERT_TYPES.BUSINESS_LISTING_SUBMITTED, message);
  } catch (err) {
    console.error('[owner-alert] business-listing alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

// Informational owner alert for an auto-published Professional auction. Best-effort; never throws.
// Deduplication is the caller's responsibility (fired once, only after the authoritative draft→published
// transition in publishAuction succeeds; a retry hits "already published" and never reaches this).
async function notifyOwnerProfessionalAuctionPublished(auctionId) {
  try {
    if (!ownerAlertConfigured()) return sendOwnerAlert(ALERT_TYPES.PROFESSIONAL_AUCTION_PUBLISHED, '');
    const row = (await db.query(
      `SELECT a.title, a.address_state AS state,
              COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS company_name,
              u.email AS seller_email,
              (SELECT COUNT(*)::int FROM lots l WHERE l.auction_id = a.id AND l.state <> 'withdrawn') AS lots
         FROM auctions a
         LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
         LEFT JOIN users u ON u.id = sp.user_id
        WHERE a.id = $1`, [auctionId])).rows[0];
    if (!row) { console.warn(`[owner-alert] pro-auction ${auctionId} not found - no alert`); return { skipped: true, reason: 'not_found' }; }
    const message = buildProfessionalAuctionPublishedMessage({
      companyName: row.company_name, title: row.title, state: row.state, lots: row.lots,
      sellerEmail: row.seller_email, url: adminUrl('/admin/moderation.html', auctionId, 'auctionId'),
    });
    return await sendOwnerAlertOnce({ alertType: ALERT_TYPES.PROFESSIONAL_AUCTION_PUBLISHED, entityType: 'auction', entityId: auctionId, message });
  } catch (err) {
    console.error('[owner-alert] professional-auction-published alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

// Controlled owner-alert self-test. Composes a clearly-labeled TEST message and sends it through the SAME
// transport + config gating as real alerts. If OWNER_ALERT_PHONE_E164 / Twilio are not configured it does
// NOT send — it returns a skipped result so callers can report "not configured" cleanly (no error thrown).
async function sendTestAlert({ note, testId } = {}) {
  try {
    if (!ownerAlertConfigured()) return sendOwnerAlert(ALERT_TYPES.OWNER_ALERT_TEST, '');
    // Audited + idempotent via owner_alert_log. Default key 'manual' guards accidental repeats; a caller
    // that genuinely wants a fresh test passes a unique testId.
    return await sendOwnerAlertOnce({ alertType: ALERT_TYPES.OWNER_ALERT_TEST, entityType: 'owner_alert', entityId: testId || 'manual', message: buildTestMessage({ note }) });
  } catch (err) {
    console.error('[owner-alert] test alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

module.exports = {
  ALERT_TYPES,
  isE164,
  parseRecipients,
  recipientHash,
  maskRecipient,
  recipientsFor,
  ownerAlertConfigured,
  buildTestMessage,
  buildAdminActionMessage,
  notifyAdminActionRequired,
  packageLabel,
  sendTestAlert,
  sendOwnerAlertOnce,
  sanitizeField,
  adminUrl,
  buildAuctionSubmittedMessage,
  buildEstateSaleSubmittedMessage,
  buildMarketingPackageMessage,
  buildBusinessListingSubmittedMessage,
  buildProfessionalAuctionPublishedMessage,
  sendOwnerAlert,
  notifyOwnerAuctionSubmitted,
  notifyOwnerEstateSaleSubmitted,
  notifyOwnerMarketingPackagePurchased,
  notifyOwnerBusinessListingSubmitted,
  notifyOwnerProfessionalAuctionPublished,
};
