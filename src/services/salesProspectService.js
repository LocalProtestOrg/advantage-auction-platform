'use strict';

/**
 * salesProspectService — internal outbound sales prospect pipeline (Sales & Marketing Toolbox).
 *
 * Prospects are EXTERNAL estate-sale companies a rep is researching/recruiting — distinct from the
 * on-platform `organizations` Partner CRM. All access is admin-gated at the route layer; nothing here
 * is ever exposed publicly.
 *
 * The scoring/tiering is a PURE function (unit-tested) so classification is deterministic and testable
 * independent of the DB.
 */
const db = require('../db');

const TRISTATE = ['yes', 'no', 'unknown'];
const WEBSITE_STATUS = ['none', 'social_only', 'directory_only', 'basic', 'outdated', 'active', 'unknown'];
const CONTACT_STATUS = [
  'new_lead', 'research_complete', 'contacted', 'follow_up', 'interested',
  'demo_scheduled', 'demo_completed', 'signup_sent', 'professional_seller', 'not_interested',
];
const CONTACT_STATUS_LABEL = {
  new_lead: 'New Lead', research_complete: 'Research Complete', contacted: 'Contacted',
  follow_up: 'Follow-Up', interested: 'Interested', demo_scheduled: 'Demo Scheduled',
  demo_completed: 'Demo Completed', signup_sent: 'Signup Sent',
  professional_seller: 'Professional Seller', not_interested: 'Not Interested',
};
const TIER_LABEL = { 1: 'Tier 1: Golden', 2: 'Tier 2: High-Value', 3: 'Tier 3: Possible', 4: 'Lower / Competitive' };
const ACTIVITY_TYPES = ['note', 'call', 'email', 'sms', 'demo', 'status_change'];

const tri = (v) => (TRISTATE.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'unknown');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * PURE prospect classification. Returns { tier, tier_label, lead_score } from the qualification signals.
 *
 * Tier rules (owner-approved priority order):
 *   • Tier 1 (Golden):     estate sales = yes, online auctions = no, independent website = no.
 *   • Tier 2 (High-Value): estate sales = yes, online auctions = no, has a website (weak site scores higher).
 *   • Lower/Competitive:   online auctions = yes AND a platform is named (mature auction operation).
 *   • Tier 3 (Possible):   everything else (incl. unknowns) — could still benefit; verify before contacting.
 *
 * lead_score (0–100) ranks hotness within a tier: highest for active estate-sale companies with no
 * auction, no website, and reachable contact info.
 */
function scoreProspect(p = {}) {
  const estate = tri(p.estate_sales_offered);
  const auction = tri(p.online_auctions_offered);
  const indieSite = tri(p.independent_website);
  const status = WEBSITE_STATUS.includes(String(p.website_status || '').toLowerCase())
    ? String(p.website_status).toLowerCase() : 'unknown';
  const hasEmail = !!(p.business_email && String(p.business_email).trim());
  const hasPhone = !!(p.business_phone && String(p.business_phone).trim());
  const hasPlatform = !!(p.auction_platform_used && String(p.auction_platform_used).trim());

  // ── lead score ────────────────────────────────────────────────────────────
  let score = 0;
  if (estate === 'yes') score += 30; else if (estate === 'unknown') score += 10;
  if (auction === 'no') score += 30; else if (auction === 'unknown') score += 12; // 'yes' → 0
  if (indieSite === 'no') score += 25;
  else if (['outdated', 'basic', 'social_only', 'directory_only', 'none'].includes(status)) score += 15; // weak web presence
  else if (indieSite === 'yes') score += 5;
  if (hasEmail) score += 8;
  if (hasPhone) score += 7;
  const lead_score = clamp(Math.round(score), 0, 100);

  // ── tier ──────────────────────────────────────────────────────────────────
  let tier;
  if (estate === 'yes' && auction === 'no' && indieSite === 'no') {
    tier = 1;
  } else if (estate === 'yes' && auction === 'no' && indieSite === 'yes') {
    tier = 2;
  } else if (auction === 'yes' && hasPlatform) {
    tier = 4; // mature auction operation already tied to a platform
  } else {
    tier = 3;
  }
  return { tier, tier_label: TIER_LABEL[tier], lead_score };
}

// Normalize + validate an incoming prospect payload (create/update). Throws on hard invalids.
function normalizeInput(body = {}) {
  const out = {};
  const name = (body.company_name || '').trim();
  if (!name) { const e = new Error('company_name is required'); e.status = 400; throw e; }
  out.company_name = name;
  out.city = (body.city || '').trim() || null;
  out.state = (body.state || '').trim().toUpperCase().slice(0, 2) || null;
  out.zip = (body.zip || '').trim() || null;
  out.service_area = (body.service_area || '').trim() || null;
  out.business_phone = (body.business_phone || '').trim() || null;
  out.business_email = (body.business_email || '').trim() || null;
  out.website = (body.website || '').trim() || null;
  out.website_status = WEBSITE_STATUS.includes(String(body.website_status || '').toLowerCase())
    ? String(body.website_status).toLowerCase() : 'unknown';
  out.social_url = (body.social_url || '').trim() || null;
  out.source_url = (body.source_url || '').trim() || null;
  out.estate_sales_offered = tri(body.estate_sales_offered);
  out.online_auctions_offered = tri(body.online_auctions_offered);
  out.auction_platform_used = (body.auction_platform_used || '').trim() || null;
  out.independent_website = tri(body.independent_website);
  if (body.contact_status !== undefined) {
    if (!CONTACT_STATUS.includes(body.contact_status)) { const e = new Error('invalid contact_status'); e.status = 400; throw e; }
    out.contact_status = body.contact_status;
  }
  out.assigned_rep_user_id = body.assigned_rep_user_id || null;
  out.next_follow_up_at = body.next_follow_up_at || null;
  out.source = (body.source || '').trim() || null;
  return out;
}

async function createProspect(body, actorId) {
  const n = normalizeInput(body);
  const s = scoreProspect(n);
  const { rows } = await db.query(
    `INSERT INTO sales_prospects
       (company_name, city, state, zip, service_area, business_phone, business_email, website,
        website_status, social_url, source_url, estate_sales_offered, online_auctions_offered,
        auction_platform_used, independent_website, prospect_tier, lead_score, contact_status,
        assigned_rep_user_id, next_follow_up_at, source, created_by_user_id, last_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18,'new_lead'),$19,$20,COALESCE($21,'manual'),$22, now())
     RETURNING *`,
    [n.company_name, n.city, n.state, n.zip, n.service_area, n.business_phone, n.business_email, n.website,
     n.website_status, n.social_url, n.source_url, n.estate_sales_offered, n.online_auctions_offered,
     n.auction_platform_used, n.independent_website, s.tier, s.lead_score, n.contact_status || null,
     n.assigned_rep_user_id, n.next_follow_up_at, n.source, actorId || null]);
  return decorate(rows[0]);
}

async function updateProspect(id, body, actorId) {
  const existing = (await db.query('SELECT * FROM sales_prospects WHERE id = $1', [id])).rows[0];
  if (!existing) { const e = new Error('Prospect not found'); e.status = 404; throw e; }
  const merged = { ...existing, ...normalizeInput({ ...existing, ...body }) };
  const s = scoreProspect(merged);
  const statusChanged = body.contact_status !== undefined && body.contact_status !== existing.contact_status;
  const { rows } = await db.query(
    `UPDATE sales_prospects SET
       company_name=$2, city=$3, state=$4, zip=$5, service_area=$6, business_phone=$7, business_email=$8,
       website=$9, website_status=$10, social_url=$11, source_url=$12, estate_sales_offered=$13,
       online_auctions_offered=$14, auction_platform_used=$15, independent_website=$16,
       prospect_tier=$17, lead_score=$18, contact_status=$19, assigned_rep_user_id=$20,
       next_follow_up_at=$21, last_verified_at=now(), updated_at=now()
     WHERE id=$1 RETURNING *`,
    [id, merged.company_name, merged.city, merged.state, merged.zip, merged.service_area,
     merged.business_phone, merged.business_email, merged.website, merged.website_status, merged.social_url,
     merged.source_url, merged.estate_sales_offered, merged.online_auctions_offered, merged.auction_platform_used,
     merged.independent_website, s.tier, s.lead_score, merged.contact_status, merged.assigned_rep_user_id,
     merged.next_follow_up_at]);
  if (statusChanged) {
    await addNote(id, actorId, 'status_change', `Status → ${CONTACT_STATUS_LABEL[merged.contact_status] || merged.contact_status}`);
  }
  return decorate(rows[0]);
}

// Record a contact attempt / note. Bumps last_contact_at for real contact channels.
async function addNote(prospectId, actorId, activityType, body) {
  const type = ACTIVITY_TYPES.includes(activityType) ? activityType : 'note';
  const { rows } = await db.query(
    `INSERT INTO sales_prospect_notes (prospect_id, author_user_id, activity_type, body)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [prospectId, actorId || null, type, (body || '').trim() || null]);
  if (['call', 'email', 'sms', 'demo'].includes(type)) {
    await db.query('UPDATE sales_prospects SET last_contact_at = now(), updated_at = now() WHERE id = $1', [prospectId]);
  }
  return rows[0];
}

async function listNotes(prospectId) {
  const { rows } = await db.query(
    `SELECT n.*, u.email AS author_email FROM sales_prospect_notes n
       LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.prospect_id = $1 ORDER BY n.created_at DESC`, [prospectId]);
  return rows;
}

// Filtered list. Supports the geographic + pipeline filters the toolbox exposes.
async function listProspects(q = {}) {
  const w = []; const p = [];
  const add = (cond, val) => { p.push(val); w.push(cond.replace('$?', '$' + p.length)); };
  if (q.state) add('state = $?', String(q.state).toUpperCase());
  if (q.city) add('city ILIKE $?', `%${q.city}%`);
  if (q.tier) add('prospect_tier = $?', parseInt(q.tier, 10));
  if (q.contact_status) add('contact_status = $?', q.contact_status);
  if (q.assigned_rep_user_id) add('assigned_rep_user_id = $?', q.assigned_rep_user_id);
  if (q.no_website === 'true') w.push("independent_website = 'no'");
  if (q.no_auctions === 'true') w.push("online_auctions_offered = 'no'");
  if (q.has_email === 'true') w.push("business_email IS NOT NULL AND business_email <> ''");
  if (q.has_phone === 'true') w.push("business_phone IS NOT NULL AND business_phone <> ''");
  if (q.min_score) add('lead_score >= $?', parseInt(q.min_score, 10));
  if (q.search) add('company_name ILIKE $?', `%${q.search}%`);
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  p.push(clamp(parseInt(q.limit, 10) || 200, 1, 1000));
  const { rows } = await db.query(
    `SELECT sp.*, u.email AS assigned_rep_email
       FROM sales_prospects sp LEFT JOIN users u ON u.id = sp.assigned_rep_user_id
       ${where}
      ORDER BY sp.prospect_tier ASC NULLS LAST, sp.lead_score DESC NULLS LAST, sp.created_at DESC
      LIMIT $${p.length}`, p);
  return rows.map(decorate);
}

async function getProspect(id) {
  const { rows } = await db.query(
    `SELECT sp.*, u.email AS assigned_rep_email FROM sales_prospects sp
       LEFT JOIN users u ON u.id = sp.assigned_rep_user_id WHERE sp.id = $1`, [id]);
  return rows[0] ? decorate(rows[0]) : null;
}

// Funnel + inventory stats for the toolbox dashboard.
async function stats() {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                                                              AS total,
      COUNT(*) FILTER (WHERE prospect_tier = 1)::int                             AS tier1,
      COUNT(*) FILTER (WHERE prospect_tier = 2)::int                             AS tier2,
      COUNT(*) FILTER (WHERE prospect_tier = 3)::int                             AS tier3,
      COUNT(*) FILTER (WHERE prospect_tier = 4)::int                             AS tier4,
      COUNT(*) FILTER (WHERE independent_website = 'no')::int                    AS no_website,
      COUNT(*) FILTER (WHERE online_auctions_offered = 'no')::int               AS no_auctions,
      COUNT(*) FILTER (WHERE business_email IS NOT NULL AND business_email <> '')::int AS has_email,
      COUNT(*) FILTER (WHERE business_phone IS NOT NULL AND business_phone <> '')::int AS has_phone,
      COUNT(*) FILTER (WHERE website IS NOT NULL AND website <> '')::int         AS has_website,
      COUNT(*) FILTER (WHERE contact_status NOT IN ('new_lead','research_complete'))::int AS contacted,
      COUNT(*) FILTER (WHERE contact_status = 'interested')::int                 AS interested,
      COUNT(*) FILTER (WHERE contact_status IN ('demo_scheduled','demo_completed'))::int AS demos,
      COUNT(*) FILTER (WHERE contact_status = 'signup_sent')::int               AS signup_sent,
      COUNT(*) FILTER (WHERE contact_status = 'professional_seller')::int        AS conversions
    FROM sales_prospects`);
  return rows[0];
}

// Attach display-friendly labels (never renames stored values).
function decorate(row) {
  if (!row) return row;
  return {
    ...row,
    tier_label: row.prospect_tier ? TIER_LABEL[row.prospect_tier] : null,
    contact_status_label: CONTACT_STATUS_LABEL[row.contact_status] || row.contact_status,
  };
}

module.exports = {
  TRISTATE, WEBSITE_STATUS, CONTACT_STATUS, CONTACT_STATUS_LABEL, TIER_LABEL, ACTIVITY_TYPES,
  scoreProspect, normalizeInput,
  createProspect, updateProspect, getProspect, listProspects, addNote, listNotes, stats,
};
