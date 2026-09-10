'use strict';

/**
 * assistedServiceService — the assisted / full-service seller path (Phase 3P.2 Part H).
 *
 * Availability is platform config (marketing.assisted_service.markets): Houston Metro and NYC Tri-State / NYC Metro
 * are the initial strategic markets — priorities, not permanent restrictions. Pricing is CUSTOM, set after the sale is
 * evaluated: it is never published, never a fixed price or commission percentage in any creative, landing page, form,
 * ad or report. pricingViolations() is the claim check every surface runs.
 * Inquiries are stored in assisted_service_inquiries and recorded as the first-party conversion assisted_service_inquiry.
 */
const crypto = require('crypto');
const db = require('../db');

const PRICING_PATTERNS = [
  /\b\d{1,3}(?:\.\d+)?\s?%/,                               // any percentage ("40%", "35 %")
  /\b\d{1,3}\s?percent\b/i,
  /\bcommission\s+(?:of|is|at|rate)\b/i,
  /\b(?:from|only|just|as low as|starting at)\s+\$?\d/i,     // "from X", "only $X"
  /\bfull[-\s]service\s+for\s+\$?\d/i,
  /\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:flat|fee|per|\/)/i,        // "$499 flat", "$99 fee"
];
function pricingViolations(text) {
  const s = String(text || '');
  return PRICING_PATTERNS.filter((re) => re.test(s)).map((re) => re.source);
}

const COPY = {
  headline: 'Prefer Us to Run the Sale?',
  lead: 'Hands-on help available in Houston and the NYC area.',
  pricing: 'Pricing is custom and set after we evaluate your sale.',
};

async function markets(runner) {
  const r = runner || db;
  try {
    const row = (await r.query(`SELECT value FROM platform_config WHERE key='marketing.assisted_service.markets'`)).rows[0];
    const list = Array.isArray(row && row.value) ? row.value : [];
    return list.map((m) => ({ market: m.market, available: m.available !== false, capabilities: Array.isArray(m.capabilities) ? m.capabilities : [] }));
  } catch (_) { return []; }
}

// Strategic market resolution from a state (and, for NY/NJ/CT, the tri-state area). Unknown → null (still accepted:
// markets are priorities, not restrictions — the team decides after evaluation).
const NYC_STATES = new Set(['NY', 'NJ', 'CT']);
const HOUSTON_CITIES = /houston|katy|sugar land|the woodlands|pearland|cypress|spring|humble|kingwood|league city|pasadena|missouri city|conroe|friendswood|bellaire|west university|tomball|richmond|rosenberg|baytown|galveston|clear lake|memorial|river oaks/i;
function marketFor({ state = null, city = null } = {}) {
  const st = String(state || '').trim().toUpperCase().slice(0, 2);
  if (st === 'TX' && HOUSTON_CITIES.test(String(city || ''))) return 'Houston Metro';
  if (NYC_STATES.has(st)) return 'NYC Tri-State / NYC Metro';
  return null;
}

const clip = (v, n) => { if (v == null) return null; const s = String(v).replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ').trim(); return s ? s.slice(0, n) : null; };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function submit(body = {}, { ip = '', userId = null } = {}, runner) {
  const r = runner || db;
  const email = clip(body.email, 200);
  const phone = clip(body.phone, 40);
  if (!email && !phone) return { ok: false, code: 'CONTACT_REQUIRED', message: 'Please share an email address or a phone number so we can reach you.' };
  if (email && !EMAIL.test(email)) return { ok: false, code: 'INVALID_EMAIL', message: 'Please enter a valid email address.' };
  if (phone && phone.replace(/\D/g, '').length < 10) return { ok: false, code: 'INVALID_PHONE', message: 'Please enter a valid phone number.' };
  if (body.contact_consent !== true && body.contact_consent !== 'true' && body.contact_consent !== 'on') return { ok: false, code: 'CONSENT_REQUIRED', message: 'Please confirm we may contact you about your sale.' };
  const city = clip(body.city, 120); const state = clip(body.state, 2) ? clip(body.state, 2).toUpperCase() : null;
  const path = ['SELF_SERVICE', 'ASSISTED_FULL_SERVICE', 'UNSURE'].includes(body.seller_path) ? body.seller_path : 'ASSISTED_FULL_SERVICE';
  const market = marketFor({ state, city });
  const ipHash = ip ? crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32) : null;
  const ins = await r.query(
    `INSERT INTO assisted_service_inquiries (name, email, phone, city, state, market, seller_path, message, source_page, visitor_id, user_id, contact_consent, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING id, created_at`,
    [clip(body.name, 160), email, phone, city, state, market, path, clip(body.message, 2000), clip(body.source_page, 300), clip(body.visitor_id, 64), userId, ipHash]);
  const id = ins.rows[0].id;
  require('./conversionService').emit('assisted_service_inquiry', { userId, visitorId: clip(body.visitor_id, 64), subjectType: 'assisted_service_inquiry', subjectId: id, market });
  return { ok: true, id, market };
}

async function list({ status = null, limit = 100 } = {}, runner) {
  const r = runner || db;
  const q = await r.query(
    `SELECT id, created_at, name, email, phone, city, state, market, seller_path, message, source_page, status
       FROM assisted_service_inquiries WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2`, [status, Math.min(500, Math.max(1, Number(limit) || 100))]);
  return q.rows;
}

async function setStatus(id, status, runner) {
  if (!['new', 'contacted', 'evaluating', 'closed'].includes(status)) return null;
  const r = runner || db;
  const q = await r.query(`UPDATE assisted_service_inquiries SET status=$2 WHERE id=$1 RETURNING id, status`, [id, status]);
  return q.rows[0] || null;
}

module.exports = { pricingViolations, markets, marketFor, submit, list, setStatus, COPY, PRICING_PATTERNS };
