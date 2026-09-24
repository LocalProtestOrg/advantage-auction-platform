'use strict';

/**
 * memberFeedService — the ONE onboarding path for a member's external event feed.
 *
 * Member neutrality: any Professional Seller (any active member organization) is onboarded the same way,
 * and no member gets a dedicated connector, crawler exception or special identity. A member publishes
 * events through its member account; OPTIONALLY it may also authorize us to sync a feed it publishes
 * itself (RSS / iCal / JSON-LD). That authorization is recorded per feed and is required before the feed
 * is ever fetched (feedConnector.hasMemberConsent). Revoking stops syncing at the next run.
 *
 * Feeds live on the single generic 'member-feeds' import source — member-managed events stay separate
 * from generic external discovery (government / original-host sources).
 */

const db0 = require('../../db');

const SOURCE_KEY = 'member-feeds';
const FEED_TYPES = ['auto', 'rss', 'ical', 'jsonld'];

function validHttpsUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : null; } catch (_) { return null; }
}

/** Validate a registration request. Pure. Returns { ok, reason?, feed? }. */
function buildFeed({ url = null, site = null, type = 'auto', organizationId, organizerName, organizerWebsiteUrl = null, consent } = {}) {
  const feedUrl = url ? validHttpsUrl(url) : null;
  const siteUrl = site ? validHttpsUrl(site) : null;
  if (!feedUrl && !siteUrl) return { ok: false, reason: 'an https feed url (or the member\'s https site to discover feeds on) is required' };
  if (!FEED_TYPES.includes(type)) return { ok: false, reason: 'type must be one of ' + FEED_TYPES.join(', ') };
  if (!organizationId) return { ok: false, reason: 'the member organization that owns the feed is required' };
  const c = consent || {};
  if (!(typeof c.granted_by === 'string' && c.granted_by.trim()) || !c.granted_at || !(typeof c.evidence === 'string' && c.evidence.trim())) {
    return { ok: false, reason: 'the member\'s consent is required: who granted it, when, and the evidence (e.g. a signed form or written email)' };
  }
  if (Number.isNaN(Date.parse(c.granted_at))) return { ok: false, reason: 'consent.granted_at must be a date' };
  return { ok: true, feed: Object.assign(
    feedUrl ? { url: feedUrl } : { site: siteUrl },
    { type, organization_id: organizationId, organizer_name: organizerName || null,
      organizer_website_url: organizerWebsiteUrl ? validHttpsUrl(organizerWebsiteUrl) : null,
      consent: { granted_by: c.granted_by.trim().slice(0, 200), granted_at: new Date(c.granted_at).toISOString(), evidence: c.evidence.trim().slice(0, 500) } }) };
}

async function withSource(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const src = (await client.query(`SELECT id, status, config FROM import_sources WHERE key = $1 FOR UPDATE`, [SOURCE_KEY])).rows[0];
    if (!src) { await client.query('ROLLBACK'); return { ok: false, reason: 'the member-feeds source is not configured' }; }
    const out = await fn(client, src);
    await client.query(out.ok ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return { ok: false, reason: e.message }; }
  finally { client.release(); }
}

/** Register (or re-consent) a member feed. Idempotent on (organization, url/site). */
async function registerFeed(input, { db = db0, actorId = null } = {}) {
  const org = (await db.query(`SELECT id, name, status FROM organizations WHERE id = $1`, [input.organizationId])).rows[0];
  if (!org) return { ok: false, reason: 'unknown organization' };
  if (org.status !== 'active') return { ok: false, reason: 'organization is ' + org.status };
  const built = buildFeed(Object.assign({}, input, { organizerName: input.organizerName || org.name }));
  if (!built.ok) return built;
  return withSource(db, async (client, src) => {
    const config = src.config || {};
    const feeds = Array.isArray(config.feeds) ? config.feeds.slice() : [];
    const key = (f) => f.organization_id + '|' + (f.url || f.site);
    const i = feeds.findIndex((f) => key(f) === key(built.feed));
    if (i >= 0) feeds[i] = built.feed; else feeds.push(built.feed);
    await client.query(
      `UPDATE import_sources SET config = config || jsonb_build_object('feeds', $2::jsonb),
              status = CASE WHEN status = 'paused' THEN 'active' ELSE status END, updated_at = now()
        WHERE id = $1`, [src.id, JSON.stringify(feeds)]);
    await client.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('member_feed.registered', 'organization', $1, $2, $3::jsonb)`,
      [org.id, actorId, JSON.stringify({ feed: built.feed.url || built.feed.site, type: built.feed.type, consent: built.feed.consent, replaced: i >= 0 })]);
    return { ok: true, feed: built.feed, replaced: i >= 0 };
  });
}

/** Revoke a member feed: it is kept for the record but never fetched again. */
async function revokeFeed({ organizationId, url = null, site = null, reason = null }, { db = db0, actorId = null } = {}) {
  const target = url || site;
  if (!organizationId || !target) return { ok: false, reason: 'organizationId and the feed url/site are required' };
  return withSource(db, async (client, src) => {
    const feeds = Array.isArray((src.config || {}).feeds) ? src.config.feeds.slice() : [];
    const i = feeds.findIndex((f) => f.organization_id === organizationId && (f.url === target || f.site === target));
    if (i < 0) return { ok: false, reason: 'no such member feed' };
    feeds[i] = Object.assign({}, feeds[i], { revoked_at: new Date().toISOString(), revoked_reason: reason ? String(reason).slice(0, 300) : null });
    await client.query(`UPDATE import_sources SET config = config || jsonb_build_object('feeds', $2::jsonb), updated_at = now() WHERE id = $1`,
      [src.id, JSON.stringify(feeds)]);
    await client.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('member_feed.revoked', 'organization', $1, $2, $3::jsonb)`,
      [organizationId, actorId, JSON.stringify({ feed: target, reason })]);
    return { ok: true };
  });
}

async function listFeeds({ db = db0 } = {}) {
  const src = (await db.query(`SELECT status, config FROM import_sources WHERE key = $1`, [SOURCE_KEY])).rows[0];
  if (!src) return { source_status: null, feeds: [] };
  const feeds = Array.isArray((src.config || {}).feeds) ? src.config.feeds : [];
  return { source_status: src.status, feeds: feeds.map((f) => ({ url: f.url || null, site: f.site || null, type: f.type || 'auto',
    organization_id: f.organization_id || null, organizer_name: f.organizer_name || null,
    consent: f.consent || null, revoked_at: f.revoked_at || null,
    syncs: require('./connectors/feedConnector').hasMemberConsent(f) })) };
}

module.exports = { SOURCE_KEY, FEED_TYPES, buildFeed, registerFeed, revokeFeed, listFeeds };
