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

const db = require('../db');
const { sendSMS } = require('./smsService');

// The app host (admin lives here). Matches marketplaceOrderNotifier / estate-sale services.
const ADMIN_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

// E.164: leading '+', country digit 1-9, then 7-14 more digits.
const E164_RE = /^\+[1-9]\d{7,14}$/;
function isE164(n) { return typeof n === 'string' && E164_RE.test(n.trim()); }

// Alert type constants (also used as the per-team env routing keys).
const ALERT_TYPES = {
  AUCTION_SUBMITTED: 'auction_submitted',
  ESTATE_SALE_SUBMITTED: 'estate_sale_submitted',
  MARKETING_PACKAGE_PURCHASED: 'marketing_package_purchased',
};

// ── Recipient routing (role-ready) ────────────────────────────────────────────
// Future operational teams get their own optional number; each falls back to the primary owner number so
// nothing is ever silently dropped. Today all three types resolve to OWNER_ALERT_PHONE_E164.
const PER_TYPE_ENV = {
  [ALERT_TYPES.AUCTION_SUBMITTED]: 'OWNER_ALERT_PHONE_AUCTIONS',
  [ALERT_TYPES.ESTATE_SALE_SUBMITTED]: 'OWNER_ALERT_PHONE_ESTATE_SALES',
  [ALERT_TYPES.MARKETING_PACKAGE_PURCHASED]: 'OWNER_ALERT_PHONE_MARKETING',
};

function recipientsFor(alertType) {
  const primary = (process.env.OWNER_ALERT_PHONE_E164 || '').trim();
  const perTypeEnv = PER_TYPE_ENV[alertType];
  const perType = perTypeEnv ? (process.env[perTypeEnv] || '').trim() : '';
  const chosen = perType || primary;
  return chosen ? [chosen] : [];
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
function adminUrl(path, id) {
  const clean = '/' + String(path || '').replace(/^\/+/, '');
  return id ? `${ADMIN_BASE}${clean}?id=${encodeURIComponent(id)}` : `${ADMIN_BASE}${clean}`;
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

// ── Transport ──────────────────────────────────────────────────────────────────
// Sends one composed message to every routed recipient. Never throws. Logs the alert type + outcome only.
async function sendOwnerAlert(alertType, message) {
  const recipients = recipientsFor(alertType).filter(isE164);
  if (!recipients.length) {
    console.warn(`[owner-alert] ${alertType} not sent - OWNER_ALERT_PHONE_E164 not configured (or invalid)`);
    return { attempted: 0, sent: 0, failed: 0, skipped: true, reason: 'not_configured' };
  }
  let sent = 0, failed = 0;
  for (const to of recipients) {
    try {
      await sendSMS({ to, message });
      sent++;
      console.log(`[owner-alert] ${alertType} delivered`);
    } catch (err) {
      failed++;
      console.error(`[owner-alert] ${alertType} send failed: ${err.message}`);
      if (process.env.SENTRY_DSN) { try { require('@sentry/node').captureException(err); } catch (_) { /* ignore */ } }
    }
  }
  return { attempted: recipients.length, sent, failed, skipped: false };
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
      url: adminUrl('/admin/moderation.html'),
    });
    return await sendOwnerAlert(ALERT_TYPES.AUCTION_SUBMITTED, message);
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
    return await sendOwnerAlert(ALERT_TYPES.ESTATE_SALE_SUBMITTED, message);
  } catch (err) {
    console.error('[owner-alert] estate-sale-submitted alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

async function notifyOwnerMarketingPackagePurchased({ userId, packageName, eventTitle } = {}) {
  try {
    if (!ownerAlertConfigured()) return sendOwnerAlert(ALERT_TYPES.MARKETING_PACKAGE_PURCHASED, '');
    let sellerName = '', sellerEmail = '';
    if (userId) {
      const u = (await db.query('SELECT email, contact_email, full_name FROM users WHERE id = $1', [userId])).rows[0];
      if (u) { sellerName = u.full_name || ''; sellerEmail = u.contact_email || u.email || ''; }
    }
    const message = buildMarketingPackageMessage({
      packageName, sellerName, sellerEmail, eventTitle,
      url: adminUrl('/admin/users.html'),
    });
    return await sendOwnerAlert(ALERT_TYPES.MARKETING_PACKAGE_PURCHASED, message);
  } catch (err) {
    console.error('[owner-alert] marketing-package alert error:', err.message);
    return { skipped: true, reason: 'error' };
  }
}

module.exports = {
  ALERT_TYPES,
  isE164,
  recipientsFor,
  ownerAlertConfigured,
  sanitizeField,
  adminUrl,
  buildAuctionSubmittedMessage,
  buildEstateSaleSubmittedMessage,
  buildMarketingPackageMessage,
  sendOwnerAlert,
  notifyOwnerAuctionSubmitted,
  notifyOwnerEstateSaleSubmitted,
  notifyOwnerMarketingPackagePurchased,
};
