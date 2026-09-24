'use strict';

/**
 * companyIdentityService — one business, many records.
 *
 * The same company can appear as a BD directory shell (organization), a Railway member organization,
 * a sales prospect, an Event Partner authorization and a professional seller profile. Treating those
 * as unrelated is how a directory-listed company ends up with a cold Event Partner invitation. This
 * service groups records into companies using the SAME normalizers the Event Partner screen uses
 * (relationshipSegmentationService — imported, never forked).
 *
 * Linking rule (fail closed):
 *   STRONG signals link: bd_listing_id, google_place_id, corporate root domain (website or email),
 *   normalized 10-digit phone, exact normalized name.
 *   A WEAK resemblance (shared distinctive name words) never links. It is reported, and on apply it is
 *   written to company_identity_reviews for a person to decide.
 *   A merge that would join two DIFFERENT directory listings with different names, or two companies that
 *   already exist, is refused and reported as a conflict. Nothing ambiguous is merged automatically.
 *
 * The whole grouping is computed in memory from the current records (`snapshot`), so journey and
 * exclusion decisions work before the backfill is applied; `backfill({ apply })` persists the result.
 */

const db = require('../../db');
const auditService = require('../auditService');
const seg = require('../eventPartners/relationshipSegmentationService');

// Event Partner statuses at "invited or beyond": the company has entered the EP journey.
const EP_JOURNEY_STATUSES = ['invited', 'declined', 'expired', 'authorized', 'source_configured', 'collecting', 'paused', 'revoked'];
const PRO_SELLER_TYPES = ['auction_house', 'estate_sale_company', 'professional_liquidator'];

// ── signals ───────────────────────────────────────────────────────────────────────────────────

/**
 * Domains that host MANY businesses and therefore identify none of them: marketplaces, social
 * networks, site builders, internet-provider mailboxes, placeholder domains. A listing whose "website"
 * is a Facebook page or a marketplace storefront shares that domain with hundreds of unrelated firms.
 * (Free consumer mailboxes are already excluded by relationshipSegmentationService.GENERIC_EMAIL_DOMAINS.)
 */
const PLATFORM_DOMAINS = new Set([
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'linkedin.com', 'tiktok.com',
  'pinterest.com', 'yelp.com', 'google.com', 'goo.gl', 'business.site', 'blogspot.com', 'wordpress.com', 'wixsite.com',
  'wix.com', 'weebly.com', 'godaddysites.com', 'square.site', 'squarespace.com', 'myshopify.com', 'carrd.co', 'linktr.ee',
  'hibid.com', 'estatesales.net', 'estatesales.org', 'estatesale.com', 'auctionzip.com', 'liveauctioneers.com',
  'invaluable.com', 'proxibid.com', 'bidsquare.com', 'auctionninja.com', 'ebay.com', 'etsy.com', 'everythingbutthehouse.com',
  'maxsold.com', 'bidspotter.com', 'auctionmobility.com', 'handbid.com', 'advantage.bid', 'advantageauction.bid',
  'example.com', 'example.org', 'test.com',
  'swbell.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'roadrunner.com', 'rr.com', 'optonline.net',
  'frontier.com', 'frontiernet.net', 'windstream.net', 'centurylink.net', 'embarqmail.com', 'q.com', 'suddenlink.net',
  'mediacombb.net', 'netzero.net', 'juno.com', 'prodigy.net', 'pacbell.net', 'ameritech.net', 'hughes.net', 'twc.com',
  'googlemail.com', 'mac.com', 'proton.me', 'zoho.com', 'yandex.com',
]);
const isIdentityDomain = (d) => !!d && seg.isCorporateDomain(d) && !PLATFORM_DOMAINS.has(d);

/** Comparable identity for any record shape. Free mailbox and platform domains are never identity. */
function signalsOf({ name, website, email, phone, googlePlaceId = null, bdListingId = null }) {
  const base = seg.identityOf({ name, website, email, phone });
  const website_domain = isIdentityDomain(base.website_domain) ? base.website_domain : null;
  const email_domain = isIdentityDomain(base.email_domain) ? base.email_domain : null;
  return {
    normalized_name: base.normalized_name && base.normalized_name.length >= 4 ? base.normalized_name : null,
    name_tokens: base.name_tokens,
    website_domain,
    email_domain,
    normalized_phone: base.normalized_phone,
    google_place_id: googlePlaceId ? String(googlePlaceId).trim() || null : null,
    bd_listing_id: bdListingId != null && String(bdListingId).trim() ? String(bdListingId).trim() : null,
  };
}

/** Strong keys an entity exposes. Two entities sharing any key are the same company (subject to conflicts). */
function strongKeys(s) {
  const keys = [];
  if (s.bd_listing_id) keys.push(['bd_listing_id', 'bd:' + s.bd_listing_id]);
  if (s.google_place_id) keys.push(['google_place_id', 'gp:' + s.google_place_id]);
  // Website and corporate email domain share one namespace: info@smith.com and smith.com are one company.
  if (s.website_domain) keys.push(['root_domain', 'dom:' + s.website_domain]);
  if (s.email_domain && s.email_domain !== s.website_domain) keys.push(['corporate_email_domain', 'dom:' + s.email_domain]);
  if (s.normalized_phone) keys.push(['phone', 'ph:' + s.normalized_phone]);
  // An exact name is identity only when it carries a distinctive word ("Estate Sales LLC" does not).
  if (s.normalized_name && s.name_tokens && s.name_tokens.length) keys.push(['exact_name', 'nm:' + s.normalized_name]);
  return keys;
}

/** How two single records relate: { method } for a strong match, { weak: [...] } for a resemblance, or null. */
function compare(a, b) {
  const ka = new Map(strongKeys(a).map(([m, k]) => [k, m]));
  for (const [m, k] of strongKeys(b)) if (ka.has(k)) return { method: m };
  const cmp = seg.compareIdentity(a, b);
  return cmp.weak.length ? { weak: cmp.weak } : null;
}

// ── entities ──────────────────────────────────────────────────────────────────────────────────

/** Every record that can belong to a company, in one comparable shape. Read-only. */
async function loadEntities(runner = db) {
  const out = [];
  const orgs = (await runner.query(
    `SELECT o.id, o.name, o.website_url, o.contact_email, o.contact_phone, o.google_place_id, o.bd_listing_id,
            o.source, o.lifecycle_state, o.bd_sync_status, o.state, o.city, o.lat, o.lng, o.linked_seller_profile_id,
            o.bd_metadata, o.description, o.profile_data, o.crm_stage,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS has_owner
       FROM organizations o`)).rows;
  for (const o of orgs) {
    out.push({ key: 'organization:' + o.id, entity_type: 'organization', entity_id: String(o.id), label: o.name, row: o,
      signals: signalsOf({ name: o.name, website: o.website_url, email: o.contact_email, phone: o.contact_phone,
        googlePlaceId: o.google_place_id, bdListingId: o.bd_listing_id }) });
  }
  const prospects = (await runner.query(
    `SELECT id, company_name, business_email, business_phone, website, website_domain, google_place_id,
            assigned_rep_user_id, contact_status, online_auctions_offered, website_status, business_type, state, city
       FROM sales_prospects`)).rows;
  for (const p of prospects) {
    out.push({ key: 'sales_prospect:' + p.id, entity_type: 'sales_prospect', entity_id: String(p.id), label: p.company_name, row: p,
      signals: signalsOf({ name: p.company_name, website: p.website || p.website_domain, email: p.business_email,
        phone: p.business_phone, googlePlaceId: p.google_place_id }) });
  }
  const eps = (await runner.query(
    `SELECT id, organization_id, company_name, authorized_domain, invited_email, status FROM authorized_event_sources`)
    .catch(() => ({ rows: [] }))).rows;
  for (const a of eps) {
    out.push({ key: 'authorized_event_source:' + a.id, entity_type: 'authorized_event_source', entity_id: String(a.id), label: a.company_name, row: a,
      // The EP row is also tied to its organization directly (same company by construction).
      linkedOrganizationId: a.organization_id || null,
      signals: signalsOf({ name: a.company_name, website: a.authorized_domain, email: a.invited_email, phone: null }) });
  }
  const pros = (await runner.query(
    `SELECT sp.id, sp.display_name, sp.seller_type, sp.organization_id, u.email
       FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
      WHERE sp.seller_type = ANY($1) AND COALESCE(sp.is_demo, false) = false`, [PRO_SELLER_TYPES])).rows;
  for (const s of pros) {
    out.push({ key: 'seller_profile:' + s.id, entity_type: 'seller_profile', entity_id: String(s.id), label: s.display_name || s.email, row: s,
      linkedOrganizationId: s.organization_id || null,
      signals: signalsOf({ name: s.display_name, website: null, email: s.email, phone: null }) });
  }
  return out;
}

async function loadExistingLinks(runner = db) {
  const rows = (await runner.query(
    `SELECT l.company_id, l.entity_type, l.entity_id FROM company_identity_links l`).catch(() => ({ rows: [] }))).rows;
  const byKey = new Map();
  for (const r of rows) byKey.set(r.entity_type + ':' + r.entity_id, r.company_id);
  return byKey;
}

// ── clustering (pure) ─────────────────────────────────────────────────────────────────────────

/**
 * Group entities into companies. Pure: same input, same output.
 *   entities       from loadEntities()
 *   existingLinks  Map(entityKey -> companyId) already persisted
 * Returns { clusters: [{ id, members, companyId, joins }], ambiguous: [...], conflicts: [...] }.
 */
function buildClusters(entities, existingLinks = new Map()) {
  const parent = new Map();
  const find = (k) => { let r = k; while (parent.get(r) !== r) r = parent.get(r); let c = k; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
  const meta = new Map();   // root -> { bd: Set, names: Set, companies: Set }
  const byKey = new Map(entities.map((e) => [e.key, e]));
  for (const e of entities) {
    parent.set(e.key, e.key);
    const companies = new Set(); const c = existingLinks.get(e.key); if (c) companies.add(c);
    meta.set(e.key, { bd: new Set(e.signals.bd_listing_id ? [e.signals.bd_listing_id] : []),
      names: new Set(e.signals.normalized_name ? [e.signals.normalized_name] : []), companies });
  }
  const joins = [];
  const conflicts = [];

  const union = (a, b, method, forced = false) => {
    const ra = find(a); const rb = find(b);
    if (ra === rb) return true;
    const ma = meta.get(ra); const mb = meta.get(rb);
    if (!forced) {
      // Two different persisted companies: merging companies is an administrator decision.
      if (ma.companies.size && mb.companies.size && ![...ma.companies].some((x) => mb.companies.has(x))) {
        conflicts.push({ a, b, method, reason: 'both already belong to different companies' }); return false;
      }
      // Two different directory listings with different names are different businesses unless a person says otherwise.
      if (ma.bd.size && mb.bd.size && ![...ma.bd].some((x) => mb.bd.has(x)) && ![...ma.names].some((x) => mb.names.has(x))) {
        conflicts.push({ a, b, method, reason: 'distinct directory listings with different names share only ' + method }); return false;
      }
    }
    parent.set(rb, ra);
    meta.set(ra, { bd: new Set([...ma.bd, ...mb.bd]), names: new Set([...ma.names, ...mb.names]), companies: new Set([...ma.companies, ...mb.companies]) });
    joins.push({ a, b, method });
    return true;
  };

  // 1. Already-persisted companies stay together.
  const byCompany = new Map();
  for (const [k, c] of existingLinks) { if (!byKey.has(k)) continue; if (!byCompany.has(c)) byCompany.set(c, []); byCompany.get(c).push(k); }
  for (const keys of byCompany.values()) for (let i = 1; i < keys.length; i++) union(keys[0], keys[i], 'admin', true);

  // 2. Records that are the same company by construction (an EP row or seller profile naming its organization).
  for (const e of entities) {
    if (e.linkedOrganizationId && byKey.has('organization:' + e.linkedOrganizationId)) union('organization:' + e.linkedOrganizationId, e.key, 'admin', true);
  }

  // 3. Strong shared keys. Deterministic order: strongest identifiers first.
  const ORDER = ['bd_listing_id', 'google_place_id', 'root_domain', 'corporate_email_domain', 'phone', 'exact_name'];
  const index = new Map();
  for (const e of entities) for (const [method, k] of strongKeys(e.signals)) {
    if (!index.has(k)) index.set(k, { method, keys: [] });
    index.get(k).keys.push(e.key);
  }
  // A domain or phone carried by MORE than MAX_SHARED_NAMES differently-named records is a franchise
  // brand, a call centre or a hosting platform. It identifies none of them, so it never links.
  const sharedIdentifiers = [];
  const nameKey = (k) => { const e = byKey.get(k); return (e && (e.signals.normalized_name || e.label)) || k; };
  const buckets = [...index.entries()].filter(([k, v]) => {
    if (v.keys.length < 2) return false;
    if (/^(dom|ph):/.test(k)) {
      const names = new Set(v.keys.map(nameKey));
      if (names.size > MAX_SHARED_NAMES) { sharedIdentifiers.push({ key: k, records: v.keys.length, names: names.size }); return false; }
    }
    return true;
  }).sort((x, y) => ORDER.indexOf(x[1].method) - ORDER.indexOf(y[1].method) || (x[0] < y[0] ? -1 : 1));
  for (const [, v] of buckets) for (let i = 1; i < v.keys.length; i++) union(v.keys[0], v.keys[i], v.method);

  // Materialise clusters.
  const groups = new Map();
  for (const e of entities) { const r = find(e.key); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); }
  const clusters = [...groups.entries()].map(([root, members]) => {
    const companyIds = [...meta.get(root).companies];
    return { id: root, members, companyId: companyIds[0] || null };
  });

  // 4. Weak resemblances between DIFFERENT clusters, where one side is a directory/member organization
  //    (the records a relationship can hang off). Reported and reviewed, never merged.
  const clusterOf = new Map(); for (const c of clusters) for (const m of c.members) clusterOf.set(m.key, c.id);
  const orgs = entities.filter((e) => e.entity_type === 'organization');
  const others = entities.filter((e) => e.signals.name_tokens && e.signals.name_tokens.length);
  const tokenIndex = new Map();
  for (const e of others) for (const t of new Set(e.signals.name_tokens)) { if (!tokenIndex.has(t)) tokenIndex.set(t, []); tokenIndex.get(t).push(e); }
  const df = (t) => (tokenIndex.get(t) || []).length;
  const seen = new Set();
  const ambiguous = [];
  for (const o of orgs) {
    const cands = new Set();
    for (const t of new Set(o.signals.name_tokens || [])) if (df(t) <= COMMON_TOKEN_DF) for (const e of (tokenIndex.get(t) || [])) cands.add(e);
    for (const e of cands) {
      if (e.key === o.key || clusterOf.get(e.key) === clusterOf.get(o.key)) continue;
      const pair = [o.key, e.key].sort().join('|');
      if (seen.has(pair)) continue; seen.add(pair);
      const weak = weakResemblance(o.signals, e.signals, df);
      if (weak) ambiguous.push({ a: o.key, a_label: o.label, b: e.key, b_label: e.label, weak });
    }
  }
  return { clusters, ambiguous, conflicts, joins, sharedIdentifiers };
}

// Tokens used by more than COMMON_TOKEN_DF records ("liquidations", "treasures") are industry
// vocabulary, not identity; a resemblance needs a RARE distinctive word.
const COMMON_TOKEN_DF = 25;
const MAX_SHARED_NAMES = 3;

/**
 * A weak resemblance worth a human look, or null. Needs either one rare distinctive word (used by at
 * most 3 records) of 5+ letters, or two shared distinctive words that are not common vocabulary.
 * Pure given `df` (token -> number of records carrying it).
 */
function weakResemblance(a, b, df) {
  const ta = new Set(a.name_tokens || []);
  const shared = [...new Set(b.name_tokens || [])].filter((t) => ta.has(t) && df(t) <= COMMON_TOKEN_DF);
  if (!shared.length) return null;
  const rare = shared.filter((t) => t.length >= 5 && df(t) <= 3);
  if (rare.length) return ['rare_name_token:' + rare.join('+')];
  // Two shared words count only when neither is a brand carried by many records (franchise locations
  // such as "Caring Transitions of X" are distinct businesses sharing a brand, not one company).
  if (shared.length >= 2 && shared.every((t) => df(t) <= 6)) return ['name_tokens:' + shared.join('+')];
  return null;
}

// ── journey derivation (pure) ─────────────────────────────────────────────────────────────────

/**
 * The journey a company's records imply (handoff section 1):
 *   professional seller                     → none (customer)
 *   EP authorization at invited or beyond   → EVENT_PARTNER
 *   directory listing (bd_listing_id / bd_import) → CLAIMED_LISTING
 *   otherwise                               → none
 */
function deriveJourney(members) {
  const has = (t) => members.filter((m) => m.entity_type === t);
  const pros = has('seller_profile');
  if (pros.length) return { journey: null, reason: 'professional seller (customer)' };
  const ep = has('authorized_event_source').find((m) => EP_JOURNEY_STATUSES.includes(m.row.status));
  if (ep) return { journey: 'EVENT_PARTNER', reason: 'Event Partner authorization at status ' + ep.row.status };
  const listing = has('organization').find((m) => m.row.bd_listing_id || m.row.source === 'bd_import');
  if (listing) return { journey: 'CLAIMED_LISTING', reason: 'directory listing ' + (listing.row.bd_listing_id ? '(BD ' + listing.row.bd_listing_id + ')' : '(bd_import)') };
  return { journey: null, reason: 'no acquisition relationship' };
}

// ── snapshot: the in-memory company map every decision can use ────────────────────────────────

/**
 * Build the current company map. `activeJourneys` (persisted assignments) override derived ones.
 * Returns helpers to look up an entity's company, members and effective journey.
 */
async function snapshot(runner = db) {
  const entities = await loadEntities(runner);
  const existing = await loadExistingLinks(runner);
  const built = buildClusters(entities, existing);
  const assignments = (await runner.query(
    `SELECT company_id, journey, reason, assigned_at FROM acquisition_journey_assignments WHERE status = 'active'`)
    .catch(() => ({ rows: [] }))).rows;
  const assigned = new Map(assignments.map((a) => [a.company_id, a]));
  const byEntity = new Map();
  for (const c of built.clusters) {
    const derived = deriveJourney(c.members);
    const persisted = c.companyId ? assigned.get(c.companyId) : null;
    c.journey = persisted ? persisted.journey : derived.journey;
    c.journey_source = persisted ? 'assignment' : 'derived';
    c.journey_reason = persisted ? persisted.reason : derived.reason;
    for (const m of c.members) byEntity.set(m.key, c);
  }
  const ambiguousByKey = new Map();
  for (const a of built.ambiguous) {
    for (const k of [a.a, a.b]) { if (!ambiguousByKey.has(k)) ambiguousByKey.set(k, []); ambiguousByKey.get(k).push(a); }
  }
  return {
    entities, clusters: built.clusters, ambiguous: built.ambiguous, conflicts: built.conflicts,
    clusterFor: (entityType, entityId) => byEntity.get(entityType + ':' + entityId) || null,
    ambiguousFor: (entityType, entityId) => ambiguousByKey.get(entityType + ':' + entityId) || [],
    /** Company for an arbitrary record not (yet) in the database, e.g. an Event Partner prospect preview. */
    matchSignals(signals) {
      const hits = [];
      for (const e of entities) { const cmp = compare(signals, e.signals); if (cmp && cmp.method) hits.push({ entity: e, method: cmp.method }); }
      const clusters = [...new Set(hits.map((h) => byEntity.get(h.entity.key)))];
      return { clusters, hits };
    },
  };
}

// ── backfill: dry run by default ──────────────────────────────────────────────────────────────

function methodForFounder(e) {
  const s = e.signals;
  if (s.bd_listing_id) return 'bd_listing_id';
  if (s.google_place_id) return 'google_place_id';
  if (s.website_domain) return 'root_domain';
  if (s.email_domain) return 'corporate_email_domain';
  if (s.normalized_phone) return 'phone';
  if (s.normalized_name) return 'exact_name';
  return 'seed';
}

/**
 * Link every organization, sales prospect, Event Partner source and professional seller profile to a
 * company, and assign the implied journey where none is active. DRY RUN unless apply === true.
 * Returns a report: counts by entity type and journey, multi-record companies, journey collisions,
 * every ambiguous pair and every refused merge. Idempotent: persisted links are respected.
 */
async function backfill({ apply = false, actorId = null, runner = db } = {}) {
  const entities = await loadEntities(runner);
  const existing = await loadExistingLinks(runner);
  const { clusters, ambiguous, conflicts, joins, sharedIdentifiers } = buildClusters(entities, existing);
  const report = {
    dry_run: !apply,
    entities: entities.reduce((m, e) => { m[e.entity_type] = (m[e.entity_type] || 0) + 1; return m; }, {}),
    companies: clusters.length,
    multi_record_companies: clusters.filter((c) => c.members.length > 1).length,
    already_linked_entities: [...existing.keys()].length,
    journeys: {}, collisions: [], ambiguous_pairs: ambiguous.length, refused_merges: conflicts.length,
    ambiguous: ambiguous.map((a) => ({ a: a.a_label, a_key: a.a, b: a.b_label, b_key: a.b, weak: a.weak })),
    conflicts: conflicts.map((c) => ({ a: c.a, b: c.b, method: c.method, reason: c.reason })),
    shared_identifiers_ignored: sharedIdentifiers,
    join_methods: joins.reduce((m, j) => { m[j.method] = (m[j.method] || 0) + 1; return m; }, {}),
    written: { companies: 0, links: 0, journeys: 0, reviews: 0 },
  };
  for (const c of clusters) {
    const d = deriveJourney(c.members);
    const k = d.journey || 'NONE';
    report.journeys[k] = (report.journeys[k] || 0) + 1;
    // A directory listing that is ALSO in the Event Partner journey is the collision the Owner prohibited.
    const listing = c.members.find((m) => m.entity_type === 'organization' && (m.row.bd_listing_id || m.row.source === 'bd_import'));
    if (listing && d.journey === 'EVENT_PARTNER') {
      report.collisions.push({ company: listing.label, organization_id: listing.entity_id, reason: d.reason });
    }
  }
  if (!apply) return report;

  for (const c of clusters) {
    const client = await runner.connect();
    try {
      await client.query('BEGIN');
      let companyId = c.companyId;
      const founder = c.members.find((m) => m.entity_type === 'organization') || c.members[0];
      if (!companyId) {
        const s = founder.signals;
        companyId = (await client.query(
          `INSERT INTO company_identities (display_name, normalized_name, root_domain, corporate_email_domain, normalized_phone,
             google_place_id, bd_listing_id, primary_organization_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [founder.label || 'Unnamed company', s.normalized_name, s.website_domain, s.email_domain, s.normalized_phone,
           s.google_place_id, s.bd_listing_id, founder.entity_type === 'organization' ? founder.entity_id : null])).rows[0].id;
        report.written.companies += 1;
      }
      for (const m of c.members) {
        if (existing.has(m.key)) continue;
        const join = joins.find((j) => j.b === m.key || j.a === m.key);
        const method = m === founder ? methodForFounder(m) : (join ? join.method : methodForFounder(m));
        const r = await client.query(
          `INSERT INTO company_identity_links (company_id, entity_type, entity_id, match_method, confidence, linked_by)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (entity_type, entity_id) DO NOTHING`,
          [companyId, m.entity_type, m.entity_id, method, method === 'admin' ? 'admin' : 'strong', actorId]);
        report.written.links += r.rowCount;
      }
      const d = deriveJourney(c.members);
      if (d.journey) {
        const r = await client.query(
          `INSERT INTO acquisition_journey_assignments (company_id, journey, reason, assigned_by)
           SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM acquisition_journey_assignments WHERE company_id = $1 AND status = 'active')`,
          [companyId, d.journey, 'backfill: ' + d.reason, actorId]);
        report.written.journeys += r.rowCount;
      }
      await client.query('COMMIT');
      c.persistedCompanyId = companyId;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  // Ambiguous pairs become review items (never links).
  const companyOf = new Map(); for (const c of clusters) for (const m of c.members) companyOf.set(m.key, c.persistedCompanyId || c.companyId);
  for (const a of ambiguous) {
    const [type, id] = a.b.split(/:(.+)/);
    const r = await runner.query(
      `INSERT INTO company_identity_reviews (entity_type, entity_id, candidate_company_id, signals)
       VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (entity_type, entity_id, candidate_company_id) DO NOTHING`,
      [type, id, companyOf.get(a.a) || null, JSON.stringify({ weak: a.weak, resembles: a.a_label })]);
    report.written.reviews += r.rowCount;
  }
  await auditService.logEvent(runner, {
    eventType: 'company_identity.backfill_applied', entityType: 'company_identity', entityId: null, actorId,
    metadata: { written: report.written, journeys: report.journeys, collisions: report.collisions.length },
  }).catch(() => {});
  return report;
}

/**
 * The persisted company for one record, created on demand from the SAME deterministic, strong-only
 * grouping the backfill uses (never an ambiguous merge). Used when staff act on a company (contact
 * lock, journey change) before the full backfill has been applied. Returns the company id or null
 * when the record does not exist.
 */
async function ensureCompany(entityType, entityId, { actorId = null, runner = db } = {}) {
  const linked = (await runner.query(
    `SELECT company_id FROM company_identity_links WHERE entity_type = $1 AND entity_id = $2`, [entityType, String(entityId)])).rows[0];
  if (linked) return linked.company_id;
  const snap = await snapshot(runner);
  const cluster = snap.clusterFor(entityType, String(entityId));
  if (!cluster) return null;
  const client = await runner.connect();
  try {
    await client.query('BEGIN');
    let companyId = cluster.companyId;
    const founder = cluster.members.find((m) => m.entity_type === 'organization') || cluster.members[0];
    if (!companyId) {
      const s = founder.signals;
      companyId = (await client.query(
        `INSERT INTO company_identities (display_name, normalized_name, root_domain, corporate_email_domain, normalized_phone,
           google_place_id, bd_listing_id, primary_organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [founder.label || 'Unnamed company', s.normalized_name, s.website_domain, s.email_domain, s.normalized_phone,
         s.google_place_id, s.bd_listing_id, founder.entity_type === 'organization' ? founder.entity_id : null])).rows[0].id;
    }
    for (const m of cluster.members) {
      await client.query(
        `INSERT INTO company_identity_links (company_id, entity_type, entity_id, match_method, confidence, linked_by)
         VALUES ($1,$2,$3,$4,'strong',$5) ON CONFLICT (entity_type, entity_id) DO NOTHING`,
        [companyId, m.entity_type, m.entity_id, methodForFounder(m), actorId]);
    }
    const d = deriveJourney(cluster.members);
    if (d.journey) {
      await client.query(
        `INSERT INTO acquisition_journey_assignments (company_id, journey, reason, assigned_by)
         SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM acquisition_journey_assignments WHERE company_id = $1 AND status = 'active')`,
        [companyId, d.journey, 'on demand: ' + d.reason, actorId]);
    }
    await client.query('COMMIT');
    return companyId;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

module.exports = {
  ensureCompany,
  EP_JOURNEY_STATUSES, PRO_SELLER_TYPES, PLATFORM_DOMAINS, COMMON_TOKEN_DF, MAX_SHARED_NAMES, weakResemblance, isIdentityDomain,
  signalsOf, strongKeys, compare, loadEntities, buildClusters, deriveJourney, snapshot, backfill,
};
