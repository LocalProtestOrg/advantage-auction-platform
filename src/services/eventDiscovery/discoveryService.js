'use strict';

/**
 * discoveryService — provider-neutral, consent-based event discovery (2026-10-29). Orchestrates, for ANY
 * authorized company (member or not; no company-specific code):
 *
 *   authorizeMember(...)      trust-ladder Path C: a member authorizes from its own dashboard (statement v2),
 *                             recorded on authorized_event_sources — the ONE authorization record.
 *   ensureCompanySource(...)  the company's own import source (connector 'discovery', owned by the company).
 *   runProbe(...)             a DRY-RUN discovery of the company's website; records the probe and its candidate
 *                             channels with a preview. Never writes events.
 *   confirmChannel(...)       a person confirms a channel after seeing its preview → active; the company source
 *                             becomes active once the platform collection gate is on.
 *   setChannelStatus(...)     pause / retire (audited).
 *   sellerStatus(...)         the plain-language status a seller sees, with supported alternatives.
 *   duePobes / runDueProbes   the worker's scheduled re-discovery (monthly, after authorization, after failure).
 *
 * Two permissions stay separate (design §4): the company's distribution authorization lives here; each channel's
 * access basis (the host's permission to read it) is recorded on the channel itself.
 */

const db0 = require('../../db');
const authorization = require('../eventPartners/authorizationService');
const statement = require('../eventPartners/authorizationStatement');
const configService = require('../configService');
const store = require('./channelStore');
const probe = require('./probe');
const classifier = require('../eventImport/blockClassifier');

const LIVE = Object.freeze(['authorized', 'source_configured', 'collecting', 'paused']);
const REPROBE_DAYS = 30;
const FAILURE_REPROBE_AFTER = 3;   // consecutive failed reads of an active channel → look again

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }
function discoveryOn(env = process.env) { return String(env.EVENT_DISCOVERY_ENABLED || '').toLowerCase() === 'true'; }

async function audit(db, eventType, entityType, entityId, actorId, metadata) {
  await db.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [eventType, entityType, entityId, actorId || null, JSON.stringify(metadata || {})]);
}

async function tx(db, fn) {
  if (typeof db.connect !== 'function') return fn(db);
  const client = await db.connect();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { if (client.release) client.release(); }
}

// Shared hosting / platform domains: a company may authorize its OWN sub-site there (exact host only), never the
// whole platform, and never a social or listing platform (whose terms govern, see platformRegistry).
const SHARED_HOSTS = Object.freeze(['wixsite.com', 'wix.com', 'wordpress.com', 'squarespace.com', 'blogspot.com', 'weebly.com', 'godaddysites.com',
  'myshopify.com', 'square.site', 'github.io', 'netlify.app', 'vercel.app', 'webflow.io', 'carrd.co', 'business.site', 'sites.google.com',
  'google.com', 'facebook.com', 'instagram.com', 'linktr.ee', 'eventbrite.com']);
function sharedHostOf(domain) { return SHARED_HOSTS.find((h) => domain === h || domain.endsWith('.' + h)) || null; }

/**
 * Does the requester demonstrably speak for this website? Trust-ladder Path A (email domain matches the site) or
 * Path C (the organization's own recorded website is this site). Otherwise an administrator confirms (Path D).
 */
function domainEvidence(domain, { orgWebsite, userEmail, contactEmail }) {
  const dec = (u) => { try { return require('../bdDirectoryService').cleanWebsite(u) || u; } catch (_) { return u; } };
  const siteHost = orgWebsite ? authorization.normalizeDomain(dec(orgWebsite)) : null;
  const emailDomain = (e) => (e && /@/.test(e) ? String(e).split('@').pop().toLowerCase().trim() : null);
  const matches = (h) => !!h && (h === domain || h.endsWith('.' + domain) || domain.endsWith('.' + h));
  if (matches(siteHost)) return { verified: true, via: 'organization_website', value: siteHost };
  if (matches(emailDomain(userEmail))) return { verified: true, via: 'requester_email_domain', value: emailDomain(userEmail) };
  if (matches(emailDomain(contactEmail))) return { verified: true, via: 'organization_contact_email_domain', value: emailDomain(contactEmail) };
  return { verified: false, via: 'needs_admin_review', value: null };
}

function normalizeWebsite(website) {
  const domain = authorization.normalizeDomain(website);
  if (!domain) return null;
  let url = String(website).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { const u = new URL(url); return { domain, url: u.protocol + '//' + u.host + '/' }; } catch (_) { return null; }
}

/**
 * Trust-ladder Path C: a member (owner or admin of its organization) authorizes event promotion from its own
 * dashboard. Idempotent: an existing live authorization for the same domain is returned (and its events page
 * updated); a different domain needs the previous one revoked first.
 */
async function authorizeMember(db = db0, { organizationId, userId, userEmail, role, website, eventsPageUrl = null, ip = null, userAgent = null } = {}) {
  if (!organizationId || !userId) throw err(401, 'AUTH_REQUIRED', 'Sign in to authorize.');
  if (!['owner', 'admin'].includes(role)) throw err(403, 'NOT_ORG_ADMIN', 'Only an owner or administrator of the company can authorize.');
  const site = normalizeWebsite(website);
  if (!site) throw err(400, 'WEBSITE_REQUIRED', 'Enter your company website address.');
  const shared = sharedHostOf(site.domain);
  if (shared && site.domain === shared) throw err(400, 'SHARED_HOST', 'Enter your own site address (for example yourcompany.' + shared + '), not the platform itself.');
  if (require('./platformRegistry').thirdPartyFor('https://' + site.domain)) throw err(400, 'LISTING_PLATFORM', 'That is a listing website, not your own. Enter your company website, or send us your events directly.');
  const page = eventsPageUrl ? normalizeWebsite(eventsPageUrl) && String(eventsPageUrl).trim() : null;
  if (eventsPageUrl && (!page || authorization.normalizeDomain(page) !== site.domain)) throw err(400, 'EVENTS_PAGE_OFFSITE', 'The events page must be on your website.');
  return tx(db, async (client) => {
    const org = (await client.query(`SELECT id, name, status, website_url, contact_email FROM organizations WHERE id = $1`, [organizationId])).rows[0];
    if (!org) throw err(404, 'ORG_NOT_FOUND', 'Organization not found.');
    const live = (await client.query(
      `SELECT * FROM authorized_event_sources WHERE organization_id = $1 AND (status = ANY($2) OR (status = 'prospective' AND authorization_method = 'member_account'))
        ORDER BY created_at DESC`, [organizationId, LIVE])).rows;
    const same = live.find((a) => a.authorized_domain === site.domain);
    if (same) {
      const r = (await client.query(`UPDATE authorized_event_sources SET events_page_url = COALESCE($2, events_page_url), updated_at = now() WHERE id = $1 RETURNING *`,
        [same.id, page])).rows[0];
      return { authorization: r, created: false };
    }
    if (live.length) throw err(409, 'OTHER_DOMAIN_AUTHORIZED', 'Your company already authorized ' + live[0].authorized_domain + '. Withdraw that first to use a different website.');
    const snapshot = statement.evidenceSnapshot({ companyName: org.name, domain: site.domain });
    const domainCheck = domainEvidence(site.domain, { orgWebsite: org.website_url, userEmail, contactEmail: org.contact_email });
    // Not demonstrably theirs: recorded, but waits for an administrator before anything is read or sent.
    const status = domainCheck.verified ? 'authorized' : 'prospective';
    const evidence = { statement: snapshot, method: 'member_account', user_id: userId, user_email: userEmail || null, role, domain_check: domainCheck,
      exact_host: !!shared,
      accepted_at: new Date().toISOString(), request: { ip_hash: ip ? require('crypto').createHash('sha256').update(String(ip)).digest('hex') : null, user_agent: userAgent ? String(userAgent).slice(0, 200) : null } };
    // An earlier non-live row for this company + domain (e.g. an invitation) is reused, never duplicated.
    const prior = (await client.query(
      `SELECT * FROM authorized_event_sources WHERE organization_id = $1 AND authorized_domain = $2 AND status IN ('prospective','invited') ORDER BY created_at DESC LIMIT 1`,
      [organizationId, site.domain])).rows[0];
    let row;
    if (prior) {
      row = (await client.query(
        `UPDATE authorized_event_sources SET status = $5, authorization_method = 'member_account', authorized_at = CASE WHEN $5 = 'authorized' THEN now() END,
            authorization_statement_version = $2, authorization_evidence = $3::jsonb, events_page_url = $4, updated_at = now()
          WHERE id = $1 RETURNING *`, [prior.id, snapshot.statement_version, JSON.stringify(evidence), page, status])).rows[0];
    } else {
      row = (await client.query(
        `INSERT INTO authorized_event_sources (organization_id, company_name, authorized_domain, authorized_source_url, status, authorization_method,
            authorized_at, authorization_statement_version, authorization_evidence, events_page_url, created_by)
         VALUES ($1,$2,$3,$4,$9,'member_account', CASE WHEN $9 = 'authorized' THEN now() END, $5, $6::jsonb, $7, $8) RETURNING *`,
        [organizationId, org.name, site.domain, site.url, snapshot.statement_version, JSON.stringify(evidence), page, userId, status])).rows[0];
    }
    await audit(client, status === 'authorized' ? 'event_partner.authorized' : 'event_partner.authorization_pending_review', 'authorized_event_source', row.id, userId,
      { method: 'member_account', organization_id: organizationId, domain: site.domain, statement_version: snapshot.statement_version, domain_check: domainCheck });
    return { authorization: row, created: true, pending_review: status !== 'authorized' };
  });
}

/** An administrator confirms that a pending member authorization's website belongs to that company (Path D). */
async function approveDomain(db = db0, authorizationId, { actorId, evidence } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (String(evidence || '').trim().length < 10) throw err(400, 'EVIDENCE_REQUIRED', 'Say how you confirmed the website belongs to the company (at least 10 characters).');
  return tx(db, async (client) => {
    const row = (await client.query(`SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE`, [authorizationId])).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Authorization not found.');
    if (row.status !== 'prospective' || row.authorization_method !== 'member_account') throw err(409, 'NOT_PENDING', 'This authorization is not waiting for review.');
    const ev = Object.assign({}, row.authorization_evidence || {}, { domain_check: { verified: true, via: 'admin_confirmed', value: String(evidence).trim().slice(0, 500), by: actorId, at: new Date().toISOString() } });
    const out = (await client.query(`UPDATE authorized_event_sources SET status = 'authorized', authorized_at = now(), authorization_evidence = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [authorizationId, JSON.stringify(ev)])).rows[0];
    await audit(client, 'event_partner.authorized', 'authorized_event_source', authorizationId, actorId, { method: 'member_account', via: 'admin_confirmed_domain', domain: row.authorized_domain });
    return out;
  });
}

/** The company's own import source for discovery. Created once; an older 'feed' partner source is upgraded. */
async function ensureCompanySource(db, auth) {
  if (auth.import_source_id) {
    const s = (await db.query(`SELECT * FROM import_sources WHERE id = $1`, [auth.import_source_id])).rows[0];
    if (s) {
      if ((s.config || {}).connector !== 'discovery') {
        await db.query(`UPDATE import_sources SET config = config || '{"connector":"discovery"}'::jsonb, kind = 'partner', updated_at = now() WHERE id = $1`, [s.id]);
      }
      return (await db.query(`SELECT * FROM import_sources WHERE id = $1`, [s.id])).rows[0];
    }
  }
  const org = (await db.query(`SELECT id, slug, name FROM organizations WHERE id = $1`, [auth.organization_id])).rows[0];
  if (!org) throw err(404, 'ORG_NOT_FOUND', 'Organization not found.');
  const base = 'partner-' + String(org.slug || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  let key = base;
  for (let i = 2; (await db.query(`SELECT 1 FROM import_sources WHERE key = $1`, [key])).rows.length; i++) key = base + '-' + i;
  const config = { connector: 'discovery', attribution: { name: auth.company_name || org.name, url: auth.authorized_source_url || ('https://' + auth.authorized_domain + '/') },
    event_partner: { authorization_id: auth.id, authorized_domain: auth.authorized_domain } };
  const s = (await db.query(
    `INSERT INTO import_sources (key, kind, name, status, config, owner_organization_id, weekly_cap, max_images_per_event, rate_limit_per_min, auto_publish, media_policy)
     VALUES ($1, 'partner', $2, 'draft', $3::jsonb, $4, 25, 40, 20, true, 'link_only') RETURNING *`,
    [key, (org.name || auth.company_name).slice(0, 120), JSON.stringify(config), auth.organization_id])).rows[0];
  await db.query(`UPDATE authorized_event_sources SET import_source_id = $2, updated_at = now() WHERE id = $1`, [auth.id, s.id]);
  await audit(db, 'event_partner.source_created', 'authorized_event_source', auth.id, null, { source_id: s.id, source_key: key, connector: 'discovery', owner_organization_id: auth.organization_id });
  return s;
}

/** Run a dry-run discovery probe for one authorization and record its findings. Never writes events. */
async function runProbe(db = db0, authorizationId, { trigger = 'admin', actorId = null, deps = {}, now = new Date() } = {}) {
  const auth = (await db.query(`SELECT * FROM authorized_event_sources WHERE id = $1`, [authorizationId])).rows[0];
  if (!auth) throw err(404, 'NOT_FOUND', 'Authorization not found.');
  if (!LIVE.includes(auth.status)) throw err(409, 'NOT_AUTHORIZED', 'Discovery runs only for a company that has authorized it.');
  const source = await ensureCompanySource(db, auth);
  const running = (await db.query(`SELECT id FROM event_discovery_probes WHERE authorization_id = $1 AND status = 'running' AND started_at > now() - interval '10 minutes' LIMIT 1`, [authorizationId])).rows[0];
  if (running) throw err(409, 'PROBE_RUNNING', 'A check of this website is already running.');
  const p = await store.startProbe(db, { authorizationId, organizationId: auth.organization_id, trigger });
  let result;
  try {
    const tz = ((await db.query(`SELECT timezone FROM event_collection_channels WHERE authorization_id = $1 AND timezone IS NOT NULL LIMIT 1`, [authorizationId])).rows[0] || {}).timezone || null;
    result = await probe.discover({ website: auth.authorized_source_url || ('https://' + auth.authorized_domain + '/'), eventsPageUrl: auth.events_page_url, timezone: tz, now, deps });
  } catch (e) { result = { outcome: 'error', error: String(e && e.message), candidates: [], blocks: [], requests: 0 }; }
  const channels = [];
  let finished;
  try {
    for (const c of result.candidates || []) {
      try {
        channels.push(await store.upsertDiscovered(db, { authorization_id: authorizationId, organization_id: auth.organization_id, import_source_id: source.id,
          kind: c.kind, url: c.url, sale_type_hint: c.sale_type_hint, timezone: c.timezone, status: 'previewed', access_basis: c.access_basis,
          access_evidence: c.access_evidence, config: c.config, profile: c.profile || null, preview: c.preview, score: c.score }));
      } catch (e) { result.error = (result.error ? result.error + '; ' : '') + 'candidate skipped: ' + String(e && e.message).slice(0, 120); }
    }
  } finally {
    // The probe row is always closed, so a failure can never leave it 'running' and suppress re-checks.
    finished = await store.finishProbe(db, p.id, { outcome: result.outcome, requests: result.requests, platform: result.platform,
      robots: result.robots, blocks: result.blocks, error: result.error,
      candidates: (result.candidates || []).map((c) => ({ kind: c.kind, url: c.url, score: c.score, upcoming: c.upcoming, sale_type_hint: c.sale_type_hint })) });
  }
  await audit(db, 'event_discovery.probed', 'authorized_event_source', authorizationId, actorId,
    { probe_id: p.id, trigger, outcome: result.outcome, candidates: channels.length, blocks: (result.blocks || []).map((b) => b.class), platform: result.platform || null });
  return { probe: finished, channels, result };
}

/** Is collection allowed platform-wide? (The Owner's existing Event Partner collection gate.) */
async function collectionEnabled() {
  try { return (await configService.get(null, 'event_partners.collection_enabled')) === true; } catch (_) { return false; }
}

/**
 * Bring the company's source and authorization in line with its channels: active channels + the platform gate on
 * → source active, authorization 'collecting'. The safety validation is recorded automatically (robots evaluated by
 * code before every request; each channel's access basis and its confirmation) — the Owner-approved replacement for
 * the human robots attestation.
 */
async function syncActivation(db, authorizationId, { actorId = null, gate } = {}) {
  const auth = (await db.query(`SELECT * FROM authorized_event_sources WHERE id = $1`, [authorizationId])).rows[0];
  if (!auth || !LIVE.includes(auth.status)) return { active: false, reason: 'not_authorized' };
  const source = await ensureCompanySource(db, auth);
  const active = (await db.query(`SELECT id, kind, access_basis, confirmed_by, confirmed_at FROM event_collection_channels WHERE authorization_id = $1 AND status = 'active'`, [authorizationId])).rows;
  const on = gate === undefined ? await collectionEnabled() : gate;
  if (!active.length) return { active: false, reason: 'no_active_channel', source_id: source.id };
  const validation = { automatic: true, robots: 'evaluated by code before every request', at: new Date().toISOString(),
    channels: active.map((c) => ({ id: c.id, kind: c.kind, access_basis: c.access_basis, confirmed_by: c.confirmed_by, confirmed_at: c.confirmed_at })) };
  await db.query(`UPDATE authorized_event_sources SET source_validated_at = COALESCE(source_validated_at, now()), source_validation = $2::jsonb, updated_at = now() WHERE id = $1`,
    [authorizationId, JSON.stringify(validation)]);
  let row = (await db.query(`SELECT * FROM authorized_event_sources WHERE id = $1`, [authorizationId])).rows[0];
  if (row.status === 'authorized') row = await authorization.transition(db, row, 'source_configured', actorId, { via: 'event_discovery' });
  if (!on) return { active: false, reason: 'collection_gate_off', source_id: source.id };
  if (source.status !== 'active') await db.query(`UPDATE import_sources SET status = 'active', updated_at = now() WHERE id = $1`, [source.id]);
  if (row.status === 'source_configured' || row.status === 'paused') row = await authorization.transition(db, row, 'collecting', actorId, { via: 'event_discovery', source_id: source.id });
  return { active: true, source_id: source.id };
}

async function confirmChannel(db = db0, channelId, { actorId, profile = null, saleTypeHint, timezone, gate } = {}) {
  const ch = await store.confirm(db, channelId, { actorId, profile, saleTypeHint, timezone });
  const activation = await syncActivation(db, ch.authorization_id, { actorId, gate });
  return { channel: ch, activation };
}

async function setChannelStatus(db = db0, channelId, status, { actorId, reason } = {}) {
  return store.setStatus(db, channelId, status, { actorId, reason });
}

/** Which authorizations are due a (re-)discovery probe. */
async function dueProbes(db = db0, { now = new Date(), limit = 10 } = {}) {
  return (await db.query(
    `SELECT a.id, a.organization_id, CASE WHEN p.started_at IS NULL THEN 'authorized'
              WHEN EXISTS (SELECT 1 FROM event_collection_channels c WHERE c.authorization_id = a.id AND c.status = 'active' AND c.consecutive_failures >= $3) THEN 'failure'
              ELSE 'scheduled' END AS trigger
       FROM authorized_event_sources a
       LEFT JOIN LATERAL (SELECT started_at FROM event_discovery_probes x WHERE x.authorization_id = a.id ORDER BY started_at DESC LIMIT 1) p ON true
      WHERE a.status = ANY($1)
        AND (p.started_at IS NULL OR p.started_at < $2::timestamptz - make_interval(days => ${REPROBE_DAYS})
             OR (p.started_at < $2::timestamptz - interval '1 day' AND EXISTS (SELECT 1 FROM event_collection_channels c
                   WHERE c.authorization_id = a.id AND c.status = 'active' AND c.consecutive_failures >= $3)))
      ORDER BY p.started_at NULLS FIRST LIMIT $4`, [LIVE, now.toISOString(), FAILURE_REPROBE_AFTER, limit])).rows;
}

async function runDueProbes(db = db0, { now = new Date(), deps = {}, limit = 5 } = {}) {
  const out = [];
  for (const d of await dueProbes(db, { now, limit })) {
    try { const r = await runProbe(db, d.id, { trigger: d.trigger, now, deps }); out.push({ authorization_id: d.id, outcome: r.result.outcome }); }
    catch (e) { out.push({ authorization_id: d.id, error: String(e && e.message) }); }
  }
  return out;
}

const SELLER_ALTERNATIVES = Object.freeze([
  { key: 'post', label: 'Post your events on Advantage.Bid', detail: 'Add each event from your dashboard. It always works.' },
  { key: 'send', label: 'Send us your events automatically', detail: 'Connect a tool you already use (your website, calendar or auction software) to the address we give you.' },
  { key: 'ask_host', label: 'Ask your website provider to allow us', detail: 'We give you a short, ready-to-send request.' },
]);

/** The seller-facing status, in plain language. Vendor-neutral by construction (blockClassifier seller text). */
async function sellerStatus(db = db0, organizationId) {
  const auth = (await db.query(`SELECT * FROM authorized_event_sources WHERE organization_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [organizationId, LIVE])).rows[0];
  if (!auth) {
    const pending = (await db.query(`SELECT * FROM authorized_event_sources WHERE organization_id = $1 AND status = 'prospective' AND authorization_method = 'member_account' ORDER BY created_at DESC LIMIT 1`,
      [organizationId])).rows[0];
    if (pending) {
      return { state: 'awaiting_review', authorization: { id: pending.id, website: pending.authorized_domain, events_page_url: pending.events_page_url },
        message: 'Thank you. We are confirming that ' + pending.authorized_domain + ' belongs to your company, usually within one business day. Then we will find your events automatically.' };
    }
    return { state: 'not_authorized', message: 'Authorize Advantage.Bid to promote your events, and tell us your website.' };
  }
  const channels = await store.listForAuthorization(db, auth.id);
  const last = await store.lastProbe(db, auth.id);
  const keys = (await db.query(`SELECT id, key_prefix, label, created_at, last_used_at, revoked_at FROM partner_intake_keys WHERE authorization_id = $1 ORDER BY created_at DESC`, [auth.id])).rows;
  const counts = (await db.query(
    `SELECT count(*) FILTER (WHERE e.status = 'published' AND COALESCE(e.end_at, e.start_at) >= now())::int public_upcoming,
            count(*) FILTER (WHERE e.status IN ('draft','submitted') AND COALESCE(e.end_at, e.start_at) >= now())::int in_review
       FROM events e WHERE e.host_organization_id = $1`, [organizationId])).rows[0];
  const base = { authorization: { id: auth.id, website: auth.authorized_domain, events_page_url: auth.events_page_url, authorized_at: auth.authorized_at,
      statement_version: auth.authorization_statement_version, push_covered: statement.coversPush(auth.authorization_statement_version) },
    channels: channels.map((c) => ({ id: c.id, kind: c.kind, status: c.status, url: c.url, sale_type: c.sale_type_hint, last_success_at: c.last_success_at, last_item_count: c.last_item_count })),
    intake_keys: keys, events: counts, last_check_at: last ? last.finished_at || last.started_at : null };
  const active = channels.filter((c) => c.status === 'active');
  if (active.length) {
    return Object.assign(base, { state: 'collecting', message: 'We\'re collecting your events automatically. ' + (counts.public_upcoming || 0) + ' upcoming event'
      + (counts.public_upcoming === 1 ? ' is' : 's are') + ' live on Advantage.Bid' + (counts.in_review ? ', and ' + counts.in_review + ' ' + (counts.in_review === 1 ? 'is' : 'are') + ' being checked' : '') + '.' });
  }
  if (channels.some((c) => c.status === 'previewed')) return Object.assign(base, { state: 'confirming', message: 'We found your events. Our team is confirming them before they go live.' });
  if (!last) return Object.assign(base, { state: 'checking', message: 'We\'re checking your website for upcoming events. This usually takes a few minutes.' });
  if (last.outcome === 'blocked') {
    const cls = ((last.blocks || [])[0] || {}).class;
    return Object.assign(base, { state: 'blocked', message: cls === 'terms_prohibit'
      ? 'The website you gave us is a listing site whose terms don\'t allow automated collection, so we can\'t read your events there.'
      : classifier.describe(cls === 'robots_disallow' ? 'other' : (cls || 'host_firewall_refusal'), 'seller'),
      alternatives: SELLER_ALTERNATIVES });
  }
  if (last.outcome === 'nothing_found') {
    return Object.assign(base, { state: 'nothing_found', message: 'We couldn\'t find any upcoming events on your website. If you list them on a separate page, tell us its address.',
      alternatives: SELLER_ALTERNATIVES });
  }
  return Object.assign(base, { state: 'checking', message: 'We couldn\'t finish checking your website. We\'ll try again automatically.' });
}

module.exports = { LIVE, REPROBE_DAYS, SELLER_ALTERNATIVES, SHARED_HOSTS, sharedHostOf, domainEvidence, approveDomain, discoveryOn, normalizeWebsite, authorizeMember, ensureCompanySource, runProbe,
  collectionEnabled, syncActivation, confirmChannel, setChannelStatus, dueProbes, runDueProbes, sellerStatus };
