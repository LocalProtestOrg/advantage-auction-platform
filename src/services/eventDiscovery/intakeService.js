'use strict';

/**
 * intakeService — a company sends its own events to Advantage.Bid (partner push, 2026-10-29). Host-independent:
 * the company's systems make an outgoing request, so a website host that refuses automated reading is irrelevant.
 *
 *   createKey / revokeKey / listKeys   per-company intake keys: 32 random bytes, shown ONCE, sha256 at rest.
 *   authenticate(rawKey)               → { key, authorization } or null (revoked / unknown / authorization not live).
 *   parseSubmission(body, contentType) → items (schema.org Event JSON or a list, an iCal file, or the simple shape).
 *   submit(...)                        → runs the items through the SAME engine as every source (normalize, dedupe,
 *                                        host attribution, publication gate), as an import run with trigger 'push'.
 *
 * Every pushed event must link to the company's authorized website (or a host recorded on the authorization),
 * so a key cannot be used to publish events for someone else. The authorization must be statement v2 or later
 * (v1 covered only collection from the website) or a member's own acceptance.
 */

const crypto = require('crypto');
const db0 = require('../../db');
const { runImport } = require('../eventImport');
const { IDENTITY_FIELD_MAP } = require('../eventImport/normalize/identityFieldMap');
const feed = require('../eventImport/connectors/feedConnector');
const statement = require('../eventPartners/authorizationStatement');
const discovery = require('./discoveryService');
const store = require('./channelStore');
const collect = require('./collect');

const LIMITS = Object.freeze({ maxEvents: 200, maxBodyBytes: 1024 * 1024, perMinute: 60, perDay: 1000 });
const LIVE = discovery.LIVE;

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function intakeOn(env = process.env) { return String(env.EVENT_INTAKE_ENABLED || '').toLowerCase() === 'true'; }

async function audit(db, eventType, entityId, actorId, metadata) {
  await db.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ($1,'authorized_event_source',$2,$3,$4::jsonb)`,
    [eventType, entityId, actorId || null, JSON.stringify(metadata || {})]);
}

function pushCovered(auth) { return auth.authorization_method === 'member_account' || statement.coversPush(auth.authorization_statement_version); }

/** Create a key for an authorization. Returns the raw key ONCE. */
async function createKey(db = db0, authorizationId, { actorId = null, label = null } = {}) {
  const auth = (await db.query(`SELECT * FROM authorized_event_sources WHERE id = $1`, [authorizationId])).rows[0];
  if (!auth || !LIVE.includes(auth.status)) throw err(409, 'NOT_AUTHORIZED', 'The company has not authorized event promotion.');
  if (!pushCovered(auth)) throw err(409, 'PUSH_NOT_COVERED', 'This authorization predates direct event submission; the company needs to accept the current statement.');
  const live = Number((await db.query(`SELECT count(*)::int n FROM partner_intake_keys WHERE authorization_id = $1 AND revoked_at IS NULL`, [authorizationId])).rows[0].n);
  if (live >= 5) throw err(409, 'TOO_MANY_KEYS', 'Revoke an unused key first (at most 5 active keys).');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  // Rejection sampling: no modulo bias.
  let body = '';
  while (body.length < 38) { for (const b of crypto.randomBytes(64)) { if (b < 228 && body.length < 38) body += alphabet[b % 57]; } }
  const prefix = 'abk_' + body.slice(0, 6);
  const raw = prefix + '_' + body.slice(6);
  const row = (await db.query(
    `INSERT INTO partner_intake_keys (authorization_id, organization_id, key_prefix, key_hash, label, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, key_prefix, label, created_at`, [authorizationId, auth.organization_id, prefix, sha256(raw), label ? String(label).slice(0, 80) : null, actorId])).rows[0];
  // The push channel records where pushed events come from (provenance + oversight). Access basis: the company sends it.
  const source = await discovery.ensureCompanySource(db, auth);
  await store.upsertDiscovered(db, { authorization_id: authorizationId, organization_id: auth.organization_id, import_source_id: source.id, kind: 'push_api',
    url: null, status: 'active', access_basis: 'company_push', access_evidence: { key_prefix: prefix, created_at: row.created_at }, preview: [] });
  await db.query(`UPDATE event_collection_channels SET status = 'active', confirmed_at = COALESCE(confirmed_at, now()), confirmed_by = COALESCE(confirmed_by, $2)
                    WHERE authorization_id = $1 AND kind = 'push_api' AND status <> 'retired'`, [authorizationId, actorId]);
  await audit(db, 'event_intake.key_created', authorizationId, actorId, { key_id: row.id, key_prefix: prefix });
  return { key: raw, id: row.id, key_prefix: prefix, label: row.label, created_at: row.created_at };
}

async function revokeKey(db = db0, authorizationId, keyId, { actorId = null } = {}) {
  const r = await db.query(`UPDATE partner_intake_keys SET revoked_at = now(), revoked_by = $3 WHERE id = $1 AND authorization_id = $2 AND revoked_at IS NULL RETURNING id, key_prefix`,
    [keyId, authorizationId, actorId]);
  if (!r.rows.length) throw err(404, 'NOT_FOUND', 'No such active key.');
  await audit(db, 'event_intake.key_revoked', authorizationId, actorId, { key_id: keyId, key_prefix: r.rows[0].key_prefix });
  return r.rows[0];
}

async function listKeys(db = db0, authorizationId) {
  return (await db.query(`SELECT id, key_prefix, label, created_at, last_used_at, use_count, revoked_at FROM partner_intake_keys WHERE authorization_id = $1 ORDER BY created_at DESC`,
    [authorizationId])).rows;
}

async function authenticate(db = db0, rawKey) {
  const k = String(rawKey || '').trim();
  if (!/^abk_[A-Za-z0-9]{6}_[A-Za-z0-9]{20,64}$/.test(k)) return null;
  const row = (await db.query(`SELECT * FROM partner_intake_keys WHERE key_hash = $1`, [sha256(k)])).rows[0];
  if (!row || row.revoked_at) return null;
  // Constant-time confirmation of the hash match (defence in depth; the lookup is by hash already).
  if (!crypto.timingSafeEqual(Buffer.from(row.key_hash, 'hex'), Buffer.from(sha256(k), 'hex'))) return null;
  const auth = (await db.query(`SELECT * FROM authorized_event_sources WHERE id = $1`, [row.authorization_id])).rows[0];
  if (!auth || !LIVE.includes(auth.status) || !pushCovered(auth)) return null;
  // Pausing or retiring the company's push channel, or disabling its source, stops pushes too.
  const ch = (await db.query(`SELECT id FROM event_collection_channels WHERE authorization_id = $1 AND kind = 'push_api' AND status = 'active' LIMIT 1`, [auth.id])).rows[0];
  if (!ch) return null;
  if (auth.import_source_id) {
    const src = (await db.query(`SELECT status FROM import_sources WHERE id = $1`, [auth.import_source_id])).rows[0];
    if (src && src.status === 'disabled') return null;
  }
  return { key: row, authorization: auth };
}

// ── submission formats ──────────────────────────────────────────────────────────────────────

const SIMPLE_FIELDS = ['title', 'start', 'end', 'url', 'description', 'venue', 'address', 'city', 'state', 'zip', 'sale_type', 'timezone', 'image', 'id'];

function fromSimple(e) {
  const images = [].concat(e.image || e.images || []).filter((u) => typeof u === 'string').slice(0, 20).map((url, position) => ({ url, position }));
  return { sourceEventId: String(e.id || e.url || ''), url: e.url || null, saleHints: e.sale_type || null,
    payload: { title: e.title, description: e.description || null, start_at: e.start || null, end_at: e.end || null, timezone: e.timezone || undefined,
      venue_name: e.venue || null, address: e.address || null, city: e.city || null, state: e.state || null, zip: e.zip || null, images,
      sale_type: ['auction', 'estate_sale'].includes(e.sale_type) ? e.sale_type : undefined } };
}

/** Parse a submission into items. Pure. Throws a 400 for anything it cannot read. */
function parseSubmission(body, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  if (typeof body === 'string' && (ct.includes('text/calendar') || /^\s*BEGIN:VCALENDAR/i.test(body))) {
    return [...feed._parsers.parseIcal(body, 'America/New_York')];
  }
  let j = body;
  if (typeof body === 'string') { try { j = JSON.parse(body); } catch (_) { throw err(400, 'INVALID_BODY', 'Send JSON (schema.org Event or the simple event shape) or an iCal file.'); } }
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.events) ? j.events : (j && j['@graph'] ? [j] : [j]));
  if (!list.length) throw err(400, 'NO_EVENTS', 'No events in the submission.');
  if (list.length > LIMITS.maxEvents) throw err(413, 'TOO_MANY_EVENTS', 'At most ' + LIMITS.maxEvents + ' events per submission.');
  const items = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') throw err(400, 'INVALID_EVENT', 'Each event must be an object.');
    if (e['@type'] || e['@graph'] || e['@context']) items.push(...feed._parsers.parseJsonLd(JSON.stringify(e)));
    else {
      const unknown = Object.keys(e).filter((k) => !SIMPLE_FIELDS.includes(k) && k !== 'images');
      if (unknown.length) throw err(400, 'UNKNOWN_FIELDS', 'Unknown field(s): ' + unknown.slice(0, 5).join(', '));
      if (typeof e.title !== 'string' || !e.title.trim()) throw err(400, 'TITLE_REQUIRED', 'Each event needs a title.');
      items.push(fromSimple(e));
    }
  }
  return items.filter((x) => x && x.payload && x.payload.title);
}

function allowedHosts(auth) {
  const hosts = new Set([auth.authorized_domain]);
  for (const h of ((auth.authorization_evidence || {}).recorded_hosts || [])) hosts.add(String(h).toLowerCase());
  return hosts;
}
function onAllowedHost(url, hosts, { exact = false } = {}) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return [...hosts].some((a) => h === a || (!exact && h.endsWith('.' + a)));
  } catch (_) { return false; }
}

/**
 * Submit events for the authenticated company. Each event must have its own https link on the company's site;
 * anything else is rejected per event (never published elsewhere's events under this company's name).
 * Returns { run, accepted, rejected[] }.
 */
async function submit(db = db0, { key, authorization }, body, contentType, { apply = true, withTransaction, now } = {}) {
  const items = parseSubmission(body, contentType);
  const hosts = allowedHosts(authorization);
  const accepted = []; const rejected = [];
  const exact = !!((authorization.authorization_evidence || {}).exact_host);   // a sub-site on a shared host: that host only
  items.forEach((it, i) => {
    collect.sanitizeItem(it);
    if (!it.url || !/^https:\/\//i.test(it.url)) rejected.push({ index: i, title: it.payload.title, reason: 'url_required', message: 'Each event needs an https link to its page on your website.' });
    else if (!onAllowedHost(it.url, hosts, { exact })) rejected.push({ index: i, title: it.payload.title, reason: 'url_offsite', message: 'The event link must be on ' + authorization.authorized_domain + '.' });
    else accepted.push(it);
  });
  const source = await discovery.ensureCompanySource(db, authorization);
  const pushChannel = (await db.query(`SELECT id FROM event_collection_channels WHERE authorization_id = $1 AND kind = 'push_api' AND status = 'active' LIMIT 1`, [authorization.id])).rows[0];
  const attribution = (source.config || {}).attribution || {};
  const connector = { key: 'push', fieldMap: IDENTITY_FIELD_MAP, async *fetch() {
    for (const it of accepted) {
      const payload = Object.assign({}, it.payload);
      // The organizer is the authorized company, always: a submission cannot name someone else as host.
      if (attribution.name) payload.organizer_name = attribution.name;
      if (attribution.url) payload.organizer_website_url = attribution.url;
      const st = payload.sale_type || feed._parsers.classifySaleType(payload.title, it.saleHints);
      if (st) payload.sale_type = st;
      if (!payload.external_url) payload.external_url = it.url;
      yield { sourceEventId: collect.stableId(it, 'push'), sourceUrl: it.url, payload, images: payload.images || [],
        memberOrganizationId: authorization.organization_id, channelId: pushChannel ? pushChannel.id : null };
    }
  } };
  let run = null;
  if (accepted.length) {
    run = await runImport({ sourceKey: source.key, apply, trigger: 'push', connector, db, withTransaction: withTransaction || require('../../utils/withTransaction').withTransaction,
      // Pushed events publish through the same publication gate only while platform collection is on; otherwise
      // they wait in the Review Queue as drafts.
      noAutoPublish: !(await discovery.collectionEnabled()), nowMs: now });
  }
  if (apply) {
    await db.query(`UPDATE partner_intake_keys SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`, [key.id]);
    if (pushChannel) await store.recordRead(db, pushChannel.id, { ok: true, items: accepted.length }).catch(() => {});
  }
  return { run: run ? { id: run.runId, status: run.status, counters: run.counters, items: run.items.map((x) => ({ sourceEventId: x.sourceEventId, eventId: x.eventId, outcome: x.outcome, reason: x.reason })) } : null,
    accepted: accepted.length, rejected };
}

/** Events this company has pushed (its own only). */
async function listOwn(db = db0, authorization) {
  return (await db.query(
    `SELECT e.id, e.title, e.status, e.sale_type, e.start_at, e.end_at, e.external_url FROM events e
       JOIN event_sources es ON es.event_id = e.id JOIN event_collection_channels c ON c.id = es.channel_id
      WHERE c.authorization_id = $1 AND c.kind = 'push_api' ORDER BY e.start_at DESC LIMIT 200`, [authorization.id])).rows;
}

/** Withdraw one pushed event: archived, never deleted (the record stays). */
async function withdraw(db = db0, authorization, eventId) {
  const r = await db.query(
    `UPDATE events e SET status = 'archived', updated_at = now() FROM event_sources es, event_collection_channels c
      WHERE e.id = $2 AND es.event_id = e.id AND c.id = es.channel_id AND c.authorization_id = $1 AND c.kind = 'push_api' RETURNING e.id`,
    [authorization.id, eventId]);
  if (!r.rows.length) throw err(404, 'NOT_FOUND', 'No such event submitted by your company.');
  await audit(db, 'event_intake.withdrawn', authorization.id, null, { event_id: eventId });
  return { id: eventId, status: 'archived' };
}

module.exports = { LIMITS, intakeOn, pushCovered, createKey, revokeKey, listKeys, authenticate, parseSubmission, submit, listOwn, withdraw, allowedHosts, onAllowedHost };
