'use strict';

/**
 * salesProspectService — internal outbound sales prospect CRM (Sales & Marketing Toolbox).
 *
 * Prospects are EXTERNAL estate-sale / auction companies a rep is researching/recruiting — distinct from
 * the on-platform `organizations` Partner CRM. All access is admin/permission-gated at the route layer;
 * nothing here is ever exposed publicly.
 *
 * CRITICAL SEPARATION (migration 116, sections 25/26): RESEARCH data (company/contact/classification) is
 * separate from SALES-ACTIVITY data (contact_status, assigned_rep, follow-up, contacted-by, notes). The
 * import/refresh path (`importProspects`) writes ONLY research columns and NEVER overwrites a rep's CRM work.
 *
 * The scoring/tiering/priority is a PURE function (unit-tested) so classification is deterministic.
 */
const db = require('../db');

const TRISTATE = ['yes', 'no', 'unknown'];
const WEBSITE_STATUS = ['none', 'social_only', 'directory_only', 'basic', 'outdated', 'active', 'unknown'];
const CONTACT_STATUS = [
  'new_lead', 'research_complete', 'contacted', 'follow_up', 'interested',
  'demo_scheduled', 'demo_completed', 'signup_sent', 'professional_seller', 'not_interested',
  'no_response', 'bad_contact_info', 'do_not_contact',
];
const CONTACT_STATUS_LABEL = {
  new_lead: 'New', research_complete: 'Research Complete', contacted: 'Contacted',
  follow_up: 'Follow-Up Needed', interested: 'Interested', demo_scheduled: 'Demo Requested',
  demo_completed: 'Demo Completed', signup_sent: 'Signup Sent',
  professional_seller: 'Became Professional Seller', not_interested: 'Not Interested',
  no_response: 'No Response', bad_contact_info: 'Bad Contact Info', do_not_contact: 'Do Not Contact',
};
const TIER_LABEL = { 1: 'Tier 1: Golden', 2: 'Tier 2: High-Value', 3: 'Tier 3: Possible', 4: 'Lower / Competitive' };
const ACTIVITY_TYPES = ['note', 'call', 'email', 'sms', 'demo', 'status_change'];
const BUSINESS_TYPES = ['estate_sale_company', 'auction_house', 'other'];
const BUSINESS_TYPE_LABEL = { estate_sale_company: 'Estate Sale Company', auction_house: 'Auction House', other: 'Other Professional Seller' };
const LEAD_PRIORITY = ['hot', 'warm', 'standard'];
const LEAD_PRIORITY_LABEL = { hot: 'Hot', warm: 'Warm', standard: 'Standard' };
const OPPORTUNITY_TYPE_LABEL = {
  both: 'Website + Online Auction', website: 'Website Opportunity',
  online_auction: 'Online Auction Opportunity', general: 'General Professional Seller',
};
// Statuses that mean "the rep has engaged" (used for the not-contacted / pipeline math).
const ENGAGED_STATUSES = CONTACT_STATUS.filter((s) => !['new_lead', 'research_complete'].includes(s));

const tri = (v) => (TRISTATE.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'unknown');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const normStatus = (v) => (WEBSITE_STATUS.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'unknown');

// ── Dedup key derivation (never fabricates data; only normalizes what's present) ────────────────────
function normalizeName(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return s || null;
}
function extractDomain(website) {
  if (!website) return null;
  let s = String(website).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  return s && s.includes('.') ? s : null;
}
function normalizePhone(phone) {
  let d = String(phone || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length >= 10 ? d : (d.length ? d : null);
}
function dedupKeys(p) {
  return {
    normalized_name: normalizeName(p.company_name),
    website_domain: extractDomain(p.website),
    normalized_phone: normalizePhone(p.business_phone),
    google_place_id: (p.google_place_id && String(p.google_place_id).trim()) || null,
  };
}

/**
 * PURE prospect classification → { tier, tier_label, lead_score, lead_priority, opportunity_type }.
 *
 * Tier (owner-approved order): Tier1 estate=yes & auction=no & indieSite=no; Tier2 estate=yes & auction=no
 * & has site; Tier4 auction=yes & named platform; Tier3 everything else.
 * lead_priority (Hot/Warm/Standard) is the simple, rep-facing priority (section 13).
 * opportunity_type describes the pitch angle (Website / Online Auction / Both / General).
 */
function scoreProspect(p = {}) {
  const estate = tri(p.estate_sales_offered);
  const auction = tri(p.online_auctions_offered);
  const indieSite = tri(p.independent_website);
  const status = normStatus(p.website_status);
  const hasEmail = !!(p.business_email && String(p.business_email).trim());
  const hasPhone = !!(p.business_phone && String(p.business_phone).trim());
  const hasPlatform = !!(p.auction_platform_used && String(p.auction_platform_used).trim());
  const actionable = hasEmail || hasPhone;
  const bizType = BUSINESS_TYPES.includes(p.business_type) ? p.business_type : null;

  // ── lead score (0–100) ──────────────────────────────────────────────────────
  let score = 0;
  if (estate === 'yes') score += 30; else if (estate === 'unknown') score += 10;
  if (auction === 'no') score += 30; else if (auction === 'unknown') score += 12;
  if (indieSite === 'no') score += 25;
  else if (['outdated', 'basic', 'social_only', 'directory_only', 'none'].includes(status)) score += 15;
  else if (indieSite === 'yes') score += 5;
  if (hasEmail) score += 8;
  if (hasPhone) score += 7;
  const lead_score = clamp(Math.round(score), 0, 100);

  // ── tier ────────────────────────────────────────────────────────────────────
  let tier;
  if (estate === 'yes' && auction === 'no' && indieSite === 'no') tier = 1;
  else if (estate === 'yes' && auction === 'no' && indieSite === 'yes') tier = 2;
  else if (auction === 'yes' && hasPlatform) tier = 4;
  else tier = 3;

  // ── opportunity type ────────────────────────────────────────────────────────
  const weakWeb = indieSite === 'no' || ['none', 'social_only', 'directory_only', 'basic', 'outdated'].includes(status);
  const noAuction = auction === 'no';
  let opportunity_type;
  if (weakWeb && noAuction) opportunity_type = 'both';
  else if (weakWeb) opportunity_type = 'website';
  else if (noAuction) opportunity_type = 'online_auction';
  else opportunity_type = 'general';

  // ── lead priority (Hot / Warm / Standard) ───────────────────────────────────
  const strongFit = estate === 'yes' || bizType === 'estate_sale_company' || bizType === 'auction_house';
  let lead_priority;
  if (actionable && strongFit && (noAuction || (weakWeb && auction !== 'yes'))) lead_priority = 'hot';
  else if (actionable && strongFit && auction !== 'yes') lead_priority = 'warm';
  else lead_priority = 'standard';

  return { tier, tier_label: TIER_LABEL[tier], lead_score, lead_priority, opportunity_type };
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
  out.website_status = normStatus(body.website_status);
  out.social_url = (body.social_url || '').trim() || null;
  out.source_url = (body.source_url || '').trim() || null;
  out.contact_source = (body.contact_source || '').trim() || null;
  out.estate_sales_offered = tri(body.estate_sales_offered);
  out.online_auctions_offered = tri(body.online_auctions_offered);
  out.auction_platform_used = (body.auction_platform_used || '').trim() || null;
  out.independent_website = tri(body.independent_website);
  out.business_type = BUSINESS_TYPES.includes(body.business_type) ? body.business_type : null;
  if (body.contact_status !== undefined) {
    if (!CONTACT_STATUS.includes(body.contact_status)) { const e = new Error('invalid contact_status'); e.status = 400; throw e; }
    out.contact_status = body.contact_status;
  }
  if (body.lead_priority !== undefined && body.lead_priority !== null && body.lead_priority !== '') {
    if (!LEAD_PRIORITY.includes(body.lead_priority)) { const e = new Error('invalid lead_priority'); e.status = 400; throw e; }
    out.lead_priority = body.lead_priority;   // manual override → priority_locked
  }
  out.assigned_rep_user_id = body.assigned_rep_user_id || null;
  out.next_follow_up_at = body.next_follow_up_at || null;
  out.source = (body.source || '').trim() || null;
  return out;
}

async function createProspect(body, actorId) {
  const n = normalizeInput(body);
  const s = scoreProspect(n);
  const k = dedupKeys(n);
  const manualPriority = n.lead_priority ? n.lead_priority : null;
  const { rows } = await db.query(
    `INSERT INTO sales_prospects
       (company_name, city, state, zip, service_area, business_phone, business_email, website,
        website_status, social_url, source_url, contact_source, estate_sales_offered, online_auctions_offered,
        auction_platform_used, independent_website, business_type, opportunity_type, prospect_tier, lead_score,
        lead_priority, priority_locked, normalized_name, website_domain, normalized_phone,
        contact_status, assigned_rep_user_id, next_follow_up_at, source, created_by_user_id, last_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             COALESCE($21,$22),$23,$24,$25,$26,COALESCE($27,'new_lead'),$28,$29,COALESCE($30,'manual'),$31, now())
     RETURNING *`,
    [n.company_name, n.city, n.state, n.zip, n.service_area, n.business_phone, n.business_email, n.website,
     n.website_status, n.social_url, n.source_url, n.contact_source, n.estate_sales_offered, n.online_auctions_offered,
     n.auction_platform_used, n.independent_website, n.business_type, s.opportunity_type, s.tier, s.lead_score,
     manualPriority, s.lead_priority, !!manualPriority, k.normalized_name, k.website_domain, k.normalized_phone,
     n.contact_status || null, n.assigned_rep_user_id, n.next_follow_up_at, n.source, actorId || null]);
  return decorate(rows[0]);
}

async function updateProspect(id, body, actorId) {
  const existing = (await db.query('SELECT * FROM sales_prospects WHERE id = $1', [id])).rows[0];
  if (!existing) { const e = new Error('Prospect not found'); e.status = 404; throw e; }
  const merged = { ...existing, ...normalizeInput({ ...existing, ...body }) };
  const s = scoreProspect(merged);
  const k = dedupKeys(merged);
  const statusChanged = body.contact_status !== undefined && body.contact_status !== existing.contact_status;
  // Manual priority override: if the caller explicitly set lead_priority, lock it; otherwise keep an
  // existing lock, else use the derived priority.
  const manualSet = body.lead_priority !== undefined && body.lead_priority !== null && body.lead_priority !== '';
  const priorityLocked = manualSet ? true : !!existing.priority_locked;
  const leadPriority = manualSet ? body.lead_priority : (existing.priority_locked ? existing.lead_priority : s.lead_priority);
  const { rows } = await db.query(
    `UPDATE sales_prospects SET
       company_name=$2, city=$3, state=$4, zip=$5, service_area=$6, business_phone=$7, business_email=$8,
       website=$9, website_status=$10, social_url=$11, source_url=$12, contact_source=$13, estate_sales_offered=$14,
       online_auctions_offered=$15, auction_platform_used=$16, independent_website=$17, business_type=$18,
       opportunity_type=$19, prospect_tier=$20, lead_score=$21, lead_priority=$22, priority_locked=$23,
       normalized_name=$24, website_domain=$25, normalized_phone=$26, contact_status=$27,
       assigned_rep_user_id=$28, next_follow_up_at=$29, last_verified_at=now(), updated_at=now()
     WHERE id=$1 RETURNING *`,
    [id, merged.company_name, merged.city, merged.state, merged.zip, merged.service_area,
     merged.business_phone, merged.business_email, merged.website, merged.website_status, merged.social_url,
     merged.source_url, merged.contact_source, merged.estate_sales_offered, merged.online_auctions_offered,
     merged.auction_platform_used, merged.independent_website, merged.business_type, s.opportunity_type,
     s.tier, s.lead_score, leadPriority, priorityLocked, k.normalized_name, k.website_domain, k.normalized_phone,
     merged.contact_status, merged.assigned_rep_user_id, merged.next_follow_up_at]);
  if (statusChanged) {
    await addNote(id, actorId, 'status_change', `Status → ${CONTACT_STATUS_LABEL[merged.contact_status] || merged.contact_status}`);
  }
  return decorate(rows[0]);
}

// Quick "Contacted" action — records contacted status + timestamp + which rep, and logs an activity.
// Never deletes the prospect or its history. Idempotent-friendly.
async function markContacted(id, actorId, note) {
  const existing = (await db.query('SELECT id, contact_status FROM sales_prospects WHERE id=$1', [id])).rows[0];
  if (!existing) { const e = new Error('Prospect not found'); e.status = 404; throw e; }
  // Only advance status from a pre-contact stage; otherwise keep the further-along status.
  const advance = ['new_lead', 'research_complete'].includes(existing.contact_status);
  const { rows } = await db.query(
    `UPDATE sales_prospects
        SET contact_status = CASE WHEN $3 THEN 'contacted' ELSE contact_status END,
            last_contact_at = now(), last_contacted_by_user_id = $2, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, actorId || null, advance]);
  await addNote(id, actorId, 'call', note && String(note).trim() ? String(note).trim() : 'Marked contacted');
  if (advance) await addNote(id, actorId, 'status_change', 'Status → Contacted');
  return decorate(rows[0]);
}

// Record a note/contact attempt. Bumps last_contact_at (+ contacted-by) for real contact channels.
async function addNote(prospectId, actorId, activityType, body) {
  const type = ACTIVITY_TYPES.includes(activityType) ? activityType : 'note';
  const { rows } = await db.query(
    `INSERT INTO sales_prospect_notes (prospect_id, author_user_id, activity_type, body)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [prospectId, actorId || null, type, (body || '').trim() || null]);
  if (['call', 'email', 'sms', 'demo'].includes(type)) {
    await db.query('UPDATE sales_prospects SET last_contact_at = now(), last_contacted_by_user_id = COALESCE($2, last_contacted_by_user_id), updated_at = now() WHERE id = $1', [prospectId, actorId || null]);
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

// ── Research IMPORT / refresh — writes ONLY research columns; NEVER touches CRM activity ──────────────
// Dedup by website_domain → normalized_phone → (normalized_name + city + state). Returns a summary.
function normalizeResearch(rec = {}) {
  const n = normalizeInput({ company_name: rec.company_name || rec.name, city: rec.city, state: rec.state, zip: rec.zip,
    service_area: rec.service_area, business_phone: rec.business_phone || rec.phone, business_email: rec.business_email || rec.email,
    website: rec.website, website_status: rec.website_status, social_url: rec.social_url, source_url: rec.source_url,
    contact_source: rec.contact_source, estate_sales_offered: rec.estate_sales_offered, online_auctions_offered: rec.online_auctions_offered,
    auction_platform_used: rec.auction_platform_used, independent_website: rec.independent_website, business_type: rec.business_type });
  n.google_place_id = (rec.google_place_id && String(rec.google_place_id).trim()) || null;
  return n;
}
async function findDuplicate(k, n) {
  const clauses = []; const params = [];
  // Google Place ID is the strongest signal — check it first.
  if (k.google_place_id) { params.push(k.google_place_id); clauses.push(`google_place_id = $${params.length}`); }
  if (k.website_domain) { params.push(k.website_domain); clauses.push(`website_domain = $${params.length}`); }
  if (k.normalized_phone) { params.push(k.normalized_phone); clauses.push(`normalized_phone = $${params.length}`); }
  if (k.normalized_name) {
    params.push(k.normalized_name); const a = params.length;
    params.push(n.city || ''); const b = params.length;
    params.push(n.state || ''); const c = params.length;
    clauses.push(`(normalized_name = $${a} AND COALESCE(city,'') = $${b} AND COALESCE(state,'') = $${c})`);
  }
  if (!clauses.length) return null;
  const { rows } = await db.query(`SELECT * FROM sales_prospects WHERE ${clauses.join(' OR ')} ORDER BY created_at ASC LIMIT 1`, params);
  return rows[0] || null;
}
async function importProspects(records, opts = {}) {
  const source = (opts.source || 'import').trim();
  const requireContact = opts.requireContact !== false;
  const res = { received: (records || []).length, inserted: 0, updated: 0, skipped_duplicate: 0, skipped_no_contact: 0, rejected: 0 };
  for (const rec of (records || [])) {
    try {
      const n = normalizeResearch(rec);
      const actionable = !!(n.business_phone || n.business_email);
      if (requireContact && !actionable) { res.skipped_no_contact++; continue; }
      const k = dedupKeys(n);
      const s = scoreProspect(n);
      const existing = await findDuplicate(k, n);
      if (existing) {
        // RESEARCH-ONLY refresh: enrich research fields; DO NOT touch contact_status / assigned_rep /
        // last_contact_at / last_contacted_by / next_follow_up_at / notes / priority when locked.
        await db.query(
          `UPDATE sales_prospects SET
             city=COALESCE($2,city), state=COALESCE($3,state), zip=COALESCE($4,zip),
             service_area=COALESCE($5,service_area),
             business_phone=COALESCE($6,business_phone), business_email=COALESCE($7,business_email),
             website=COALESCE($8,website), website_status=$9, social_url=COALESCE($10,social_url),
             source_url=COALESCE($11,source_url), contact_source=COALESCE($12,contact_source),
             estate_sales_offered=$13, online_auctions_offered=$14, auction_platform_used=COALESCE($15,auction_platform_used),
             independent_website=$16, business_type=COALESCE($17,business_type), opportunity_type=$18,
             prospect_tier=$19, lead_score=$20,
             lead_priority = CASE WHEN priority_locked THEN lead_priority ELSE $21 END,
             normalized_name=COALESCE($22,normalized_name), website_domain=COALESCE($23,website_domain),
             normalized_phone=COALESCE($24,normalized_phone), google_place_id=COALESCE($26,google_place_id),
             source=COALESCE(source,$25), last_verified_at=now(), updated_at=now()
           WHERE id=$1`,
          [existing.id, n.city, n.state, n.zip, n.service_area, n.business_phone, n.business_email, n.website,
           n.website_status, n.social_url, n.source_url, n.contact_source, n.estate_sales_offered, n.online_auctions_offered,
           n.auction_platform_used, n.independent_website, n.business_type, s.opportunity_type, s.tier, s.lead_score,
           s.lead_priority, k.normalized_name, k.website_domain, k.normalized_phone, source, k.google_place_id]);
        res.updated++;
      } else {
        await db.query(
          `INSERT INTO sales_prospects
             (company_name, city, state, zip, service_area, business_phone, business_email, website,
              website_status, social_url, source_url, contact_source, estate_sales_offered, online_auctions_offered,
              auction_platform_used, independent_website, business_type, opportunity_type, prospect_tier, lead_score,
              lead_priority, normalized_name, website_domain, normalized_phone, contact_status, source, google_place_id, last_verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'new_lead',$25,$26, now())`,
          [n.company_name, n.city, n.state, n.zip, n.service_area, n.business_phone, n.business_email, n.website,
           n.website_status, n.social_url, n.source_url, n.contact_source, n.estate_sales_offered, n.online_auctions_offered,
           n.auction_platform_used, n.independent_website, n.business_type, s.opportunity_type, s.tier, s.lead_score,
           s.lead_priority, k.normalized_name, k.website_domain, k.normalized_phone, source, k.google_place_id]);
        res.inserted++;
      }
    } catch (e) { res.rejected++; }
  }
  return res;
}

// Filtered work-queue list. Supports geo + pipeline + CRM filters.
async function listProspects(q = {}) {
  const w = []; const p = [];
  const add = (cond, val) => { p.push(val); w.push(cond.replace('$?', '$' + p.length)); };
  if (q.state) add('state = $?', String(q.state).toUpperCase());
  if (q.city) add('city ILIKE $?', `%${q.city}%`);
  if (q.tier) add('prospect_tier = $?', parseInt(q.tier, 10));
  if (q.business_type) add('business_type = $?', q.business_type);
  if (q.lead_priority) add('lead_priority = $?', q.lead_priority);
  if (q.website_status) add('website_status = $?', q.website_status);
  if (q.source) add('source = $?', q.source);
  if (q.contact_status) add('contact_status = $?', q.contact_status);
  if (q.assigned_rep_user_id) {
    if (q.assigned_rep_user_id === 'unassigned') w.push('assigned_rep_user_id IS NULL');
    else add('assigned_rep_user_id = $?', q.assigned_rep_user_id);
  }
  if (q.no_website === 'true') w.push("(independent_website = 'no' OR website_status IN ('none','social_only','directory_only'))");
  if (q.social_only === 'true') w.push("website_status = 'social_only'");
  if (q.no_auctions === 'true') w.push("online_auctions_offered = 'no'");
  if (q.online_auctions === 'true') w.push("online_auctions_offered = 'yes'");
  if (q.has_email === 'true') w.push("business_email IS NOT NULL AND business_email <> ''");
  if (q.has_phone === 'true') w.push("business_phone IS NOT NULL AND business_phone <> ''");
  if (q.actionable === 'true') w.push('is_actionable = true');
  if (q.not_contacted === 'true') w.push("contact_status IN ('new_lead','research_complete')");
  if (q.hot === 'true') w.push("lead_priority = 'hot'");
  if (q.interested === 'true') w.push("contact_status = 'interested'");
  if (q.converted === 'true') w.push("contact_status = 'professional_seller'");
  if (q.exclude_dnc === 'true') w.push("contact_status <> 'do_not_contact'");
  // Follow-up buckets (relative to now)
  if (q.follow_up === 'due_today') w.push("next_follow_up_at IS NOT NULL AND next_follow_up_at::date = now()::date");
  if (q.follow_up === 'overdue') w.push("next_follow_up_at IS NOT NULL AND next_follow_up_at < now()");
  if (q.follow_up === 'upcoming') w.push("next_follow_up_at IS NOT NULL AND next_follow_up_at::date > now()::date");
  if (q.follow_up === 'due') w.push("next_follow_up_at IS NOT NULL AND next_follow_up_at::date <= now()::date");
  if (q.min_score) add('lead_score >= $?', parseInt(q.min_score, 10));
  if (q.search) {
    p.push(`%${q.search}%`);
    const i = '$' + p.length;
    w.push(`(company_name ILIKE ${i} OR city ILIKE ${i} OR business_phone ILIKE ${i} OR business_email ILIKE ${i})`);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  p.push(clamp(parseInt(q.limit, 10) || 200, 1, 2000));
  const { rows } = await db.query(
    `SELECT sp.*, u.email AS assigned_rep_email
       FROM sales_prospects sp LEFT JOIN users u ON u.id = sp.assigned_rep_user_id
       ${where}
      ORDER BY (sp.lead_priority = 'hot') DESC, sp.prospect_tier ASC NULLS LAST, sp.lead_score DESC NULLS LAST, sp.created_at DESC
      LIMIT $${p.length}`, p);
  return rows.map(decorate);
}

async function getProspect(id) {
  const { rows } = await db.query(
    `SELECT sp.*, u.email AS assigned_rep_email, c.email AS last_contacted_by_email FROM sales_prospects sp
       LEFT JOIN users u ON u.id = sp.assigned_rep_user_id
       LEFT JOIN users c ON c.id = sp.last_contacted_by_user_id
      WHERE sp.id = $1`, [id]);
  return rows[0] ? decorate(rows[0]) : null;
}

// Pipeline summary for the Sales dashboard (actual data; each field maps to a work-queue filter).
async function stats() {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                                                              AS total,
      COUNT(*) FILTER (WHERE is_actionable)::int                                 AS actionable,
      COUNT(*) FILTER (WHERE lead_priority = 'hot')::int                         AS hot,
      COUNT(*) FILTER (WHERE lead_priority = 'warm')::int                        AS warm,
      COUNT(*) FILTER (WHERE lead_priority = 'standard')::int                    AS standard,
      COUNT(*) FILTER (WHERE prospect_tier = 1)::int                             AS tier1,
      COUNT(*) FILTER (WHERE prospect_tier = 2)::int                             AS tier2,
      COUNT(*) FILTER (WHERE business_type = 'estate_sale_company')::int         AS estate_companies,
      COUNT(*) FILTER (WHERE business_type = 'auction_house')::int               AS auction_houses,
      COUNT(*) FILTER (WHERE independent_website = 'no' OR website_status IN ('none','social_only','directory_only'))::int AS no_website,
      COUNT(*) FILTER (WHERE website_status = 'social_only')::int                AS social_only,
      COUNT(*) FILTER (WHERE online_auctions_offered = 'no')::int               AS no_auctions,
      COUNT(*) FILTER (WHERE business_email IS NOT NULL AND business_email <> '')::int AS has_email,
      COUNT(*) FILTER (WHERE business_phone IS NOT NULL AND business_phone <> '')::int AS has_phone,
      COUNT(*) FILTER (WHERE contact_status IN ('new_lead','research_complete'))::int AS not_contacted,
      COUNT(*) FILTER (WHERE next_follow_up_at IS NOT NULL AND next_follow_up_at::date <= now()::date)::int AS follow_ups_due,
      COUNT(*) FILTER (WHERE contact_status = 'interested')::int                 AS interested,
      COUNT(*) FILTER (WHERE contact_status = 'demo_scheduled')::int             AS demo_requested,
      COUNT(*) FILTER (WHERE contact_status = 'signup_sent')::int               AS signup_sent,
      COUNT(*) FILTER (WHERE contact_status = 'professional_seller')::int        AS converted
    FROM sales_prospects`);
  return rows[0];
}

// Sales reps available for assignment (staff who can work the CRM). Never exposes non-staff members.
async function listReps() {
  const { rows } = await db.query(
    `SELECT id, email, role, staff_role
       FROM users
      WHERE role = 'admin' OR staff_role IN ('super_admin','marketing')
      ORDER BY (staff_role = 'marketing') DESC, email ASC`);
  return rows.map((r) => ({ id: r.id, email: r.email, staff_role: r.staff_role || (r.role === 'admin' ? 'admin' : null), name: r.email }));
}

// Attach display-friendly labels (never renames stored values).
function decorate(row) {
  if (!row) return row;
  return {
    ...row,
    tier_label: row.prospect_tier ? TIER_LABEL[row.prospect_tier] : null,
    contact_status_label: CONTACT_STATUS_LABEL[row.contact_status] || row.contact_status,
    lead_priority_label: LEAD_PRIORITY_LABEL[row.lead_priority] || row.lead_priority,
    business_type_label: BUSINESS_TYPE_LABEL[row.business_type] || null,
    opportunity_type_label: OPPORTUNITY_TYPE_LABEL[row.opportunity_type] || null,
  };
}

module.exports = {
  TRISTATE, WEBSITE_STATUS, CONTACT_STATUS, CONTACT_STATUS_LABEL, TIER_LABEL, ACTIVITY_TYPES,
  BUSINESS_TYPES, BUSINESS_TYPE_LABEL, LEAD_PRIORITY, LEAD_PRIORITY_LABEL, OPPORTUNITY_TYPE_LABEL, ENGAGED_STATUSES,
  scoreProspect, normalizeInput, normalizeName, extractDomain, normalizePhone, dedupKeys,
  createProspect, updateProspect, markContacted, getProspect, listProspects, addNote, listNotes, stats, listReps,
  importProspects, findDuplicate,
};
