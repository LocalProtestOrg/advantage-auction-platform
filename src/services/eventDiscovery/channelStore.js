'use strict';

/**
 * channelStore — persistence for event discovery (migration 208): collection channels, discovery probes.
 * Every state change that a person makes (confirm, pause, retire) is audited. Callers pass `db` (a pool or a
 * transaction client with .query) so the same functions run inside the engine, routes and scripts.
 */

const db0 = require('../../db');

const CHANNEL_KINDS = Object.freeze(['ical', 'rss', 'jsonld', 'microdata', 'linked_pages', 'platform_endpoint', 'html_profile', 'push_api', 'push_calendar']);
const ACCESS_BASES = Object.freeze(['robots_and_terms_permit', 'host_written_permission', 'platform_partnership', 'company_push']);

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }

async function audit(db, eventType, entityId, actorId, metadata) {
  await db.query(
    `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ($1, 'event_collection_channel', $2, $3, $4::jsonb)`,
    [eventType, entityId, actorId || null, JSON.stringify(metadata || {})]);
}

/**
 * Insert or refresh a channel found by a probe. Never downgrades a channel a person already decided on:
 * an active / paused / retired channel keeps its status; only its probe facts are refreshed.
 */
async function upsertDiscovered(db, ch) {
  if (!CHANNEL_KINDS.includes(ch.kind)) throw err(400, 'BAD_KIND', 'unknown channel kind ' + ch.kind);
  if (!ACCESS_BASES.includes(ch.access_basis)) throw err(400, 'BAD_ACCESS_BASIS', 'unknown access basis');
  const r = await db.query(
    `INSERT INTO event_collection_channels (authorization_id, organization_id, import_source_id, kind, url, sale_type_hint, timezone,
        status, access_basis, access_evidence, block_class, block_evidence, config, profile, preview, score, last_probe_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16, now())
     ON CONFLICT (authorization_id, kind, COALESCE(url, '')) DO UPDATE SET
        preview = EXCLUDED.preview, score = EXCLUDED.score, last_probe_at = now(), access_evidence = EXCLUDED.access_evidence,
        block_class = CASE WHEN event_collection_channels.status IN ('active','paused','retired') THEN event_collection_channels.block_class ELSE EXCLUDED.block_class END,
        block_evidence = CASE WHEN event_collection_channels.status IN ('active','paused','retired') THEN event_collection_channels.block_evidence ELSE EXCLUDED.block_evidence END,
        status = CASE WHEN event_collection_channels.status IN ('active','paused','retired') THEN event_collection_channels.status ELSE EXCLUDED.status END,
        sale_type_hint = COALESCE(event_collection_channels.sale_type_hint, EXCLUDED.sale_type_hint),
        timezone = COALESCE(event_collection_channels.timezone, EXCLUDED.timezone),
        config = event_collection_channels.config || EXCLUDED.config,
        profile = COALESCE(event_collection_channels.profile, EXCLUDED.profile),
        updated_at = now()
     RETURNING *`,
    [ch.authorization_id, ch.organization_id, ch.import_source_id || null, ch.kind, ch.url || null, ch.sale_type_hint || null, ch.timezone || null,
      ch.status || 'previewed', ch.access_basis, JSON.stringify(ch.access_evidence || {}), ch.block_class || null,
      ch.block_evidence ? JSON.stringify(ch.block_evidence) : null, JSON.stringify(ch.config || {}),
      ch.profile ? JSON.stringify(ch.profile) : null, JSON.stringify(ch.preview || []), ch.score == null ? null : ch.score]);
  return r.rows[0];
}

async function listForAuthorization(db, authorizationId) {
  return (await db.query(`SELECT * FROM event_collection_channels WHERE authorization_id = $1 ORDER BY status = 'active' DESC, score DESC NULLS LAST, created_at`, [authorizationId])).rows;
}

async function activeForSource(db, importSourceId) {
  return (await db.query(`SELECT * FROM event_collection_channels WHERE import_source_id = $1 AND status = 'active' ORDER BY kind, created_at`, [importSourceId])).rows;
}

async function get(db, id) { return (await db.query(`SELECT * FROM event_collection_channels WHERE id = $1`, [id])).rows[0] || null; }

/**
 * A person confirms a channel after seeing its preview: it becomes active, attached to the company's import
 * source. HTML profiles are confirmed with their profile; their events stay in review until trusted.
 */
async function confirm(db, id, { actorId, profile = null, saleTypeHint, timezone } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const ch = await get(db, id);
  if (!ch) throw err(404, 'NOT_FOUND', 'Channel not found.');
  if (ch.status === 'retired') throw err(409, 'RETIRED', 'A retired channel cannot be reactivated; run discovery again.');
  if (ch.status === 'blocked') throw err(409, 'BLOCKED', 'This channel is blocked by its host and cannot be collected.');
  if (ch.kind === 'html_profile' && !(profile || ch.profile)) throw err(400, 'PROFILE_REQUIRED', 'An HTML channel needs a confirmed extraction profile.');
  const auth = (await db.query(`SELECT id, status, import_source_id FROM authorized_event_sources WHERE id = $1`, [ch.authorization_id])).rows[0];
  if (!auth || ['revoked', 'declined', 'expired', 'prospective', 'invited'].includes(auth.status)) {
    throw err(409, 'NOT_AUTHORIZED', 'The company has not authorized collection.');
  }
  const r = await db.query(
    `UPDATE event_collection_channels SET status = 'active', confirmed_by = $2, confirmed_at = now(), paused_reason = NULL,
        import_source_id = COALESCE(import_source_id, $3), profile = COALESCE($4::jsonb, profile),
        sale_type_hint = COALESCE($5, sale_type_hint), timezone = COALESCE($6, timezone), consecutive_failures = 0, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, actorId, auth.import_source_id || null, profile ? JSON.stringify(profile) : null, saleTypeHint || null, timezone || null]);
  await audit(db, 'event_channel.confirmed', id, actorId, { kind: ch.kind, url: ch.url, from: ch.status, authorization_id: ch.authorization_id });
  return r.rows[0];
}

async function setStatus(db, id, status, { actorId = null, reason = null, auto = false } = {}) {
  if (!['paused', 'retired'].includes(status)) throw err(400, 'BAD_STATUS', 'Only pause or retire.');
  if (!auto && !actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const ch = await get(db, id);
  if (!ch) throw err(404, 'NOT_FOUND', 'Channel not found.');
  if (ch.status === status) return ch;
  const r = await db.query(`UPDATE event_collection_channels SET status = $2, paused_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status, reason ? String(reason).slice(0, 300) : null]);
  await audit(db, auto ? 'event_channel.suspended_automatically' : 'event_channel.' + status, id, actorId, { kind: ch.kind, from: ch.status, reason });
  return r.rows[0];
}

/** Fold one read of a channel into its health. Pure-ish: one UPDATE. */
async function recordRead(db, id, { ok, items = 0, error = null, blockClass = null, blockEvidence = null }) {
  await db.query(
    `UPDATE event_collection_channels SET last_read_at = now(),
        last_success_at = CASE WHEN $2 THEN now() ELSE last_success_at END,
        last_item_count = CASE WHEN $2 THEN $3 ELSE last_item_count END,
        consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures + 1 END,
        last_error = CASE WHEN $2 THEN NULL ELSE $4 END,
        block_class = CASE WHEN $2 THEN NULL ELSE COALESCE($5, block_class) END,
        block_evidence = CASE WHEN $2 THEN NULL ELSE COALESCE($6::jsonb, block_evidence) END,
        updated_at = now()
      WHERE id = $1`,
    [id, !!ok, items, error ? String(error).slice(0, 400) : null, blockClass, blockEvidence ? JSON.stringify(blockEvidence) : null]);
}

async function startProbe(db, { authorizationId, organizationId, trigger }) {
  return (await db.query(`INSERT INTO event_discovery_probes (authorization_id, organization_id, trigger) VALUES ($1,$2,$3) RETURNING *`,
    [authorizationId, organizationId, trigger])).rows[0];
}

async function finishProbe(db, id, p) {
  return (await db.query(
    `UPDATE event_discovery_probes SET status = $2, outcome = $3, requests = $4, platform = $5, robots = $6::jsonb, blocks = $7::jsonb,
        candidates = $8::jsonb, error = $9, finished_at = now() WHERE id = $1 RETURNING *`,
    [id, p.error && !p.outcome ? 'failed' : 'completed', p.outcome || 'error', p.requests || 0, p.platform || null,
      JSON.stringify(p.robots || null), JSON.stringify(p.blocks || []), JSON.stringify(p.candidates || []), p.error || null])).rows[0];
}

async function lastProbe(db, authorizationId) {
  return (await db.query(`SELECT * FROM event_discovery_probes WHERE authorization_id = $1 ORDER BY started_at DESC LIMIT 1`, [authorizationId])).rows[0] || null;
}

/** Events published through a channel after review (the HTML trust ramp counts these). */
async function reviewedPublishedCount(db, channelId) {
  return Number((await db.query(
    `SELECT count(DISTINCT e.id)::int n FROM events e JOIN event_sources es ON es.event_id = e.id
      WHERE es.channel_id = $1 AND e.status = 'published' AND e.reviewed_by IS NOT NULL`, [channelId])).rows[0].n);
}

module.exports = { CHANNEL_KINDS, ACCESS_BASES, upsertDiscovered, listForAuthorization, activeForSource, get, confirm, setStatus, recordRead,
  startProbe, finishProbe, lastProbe, reviewedPublishedCount, db0 };
