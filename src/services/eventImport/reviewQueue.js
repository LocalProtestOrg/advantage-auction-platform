'use strict';

/**
 * reviewQueue — the governance layer for imported events (Commit 10 of the Event Import
 * Framework, §7 of docs/event-import-framework-plan.md). An administrator reviews imported
 * DRAFT events before they are published; nothing publishes without an explicit approval
 * (auto_publish is a separate source-level concern handled by the engine, not here).
 *
 * Design mirrors writer.js: read helpers use db.query; every MUTATION takes a pg client so
 * the caller runs it inside withTransaction (all-or-nothing), and every mutation is audited.
 * Railway is the canonical source of truth — no BD record is ever created here. Approval
 * reuses writer.publishImported (draft → published, quota-bypassing). Rejection moves the
 * draft to the existing 'rejected' status (migration 076 CHECK), never deleting the record
 * or its provenance/audit trail.
 */

const db = require('../../db');
const { writeAuditLog } = require('../../lib/auditLog');
const writer = require('./writer');

// A "pending" review item = an imported event still in draft (never published/rejected).
const PENDING = `e.source = 'imported' AND e.status = 'draft'`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build the shared WHERE clause for the pending queue from filter/search inputs.
 * Returns { sql, params } where sql begins with the PENDING predicate. `startIndex`
 * lets callers append these params after their own positional params.
 *
 * Filters: sourceId (import_sources.id — matched via event_sources), market (market_slug),
 * q (free-text over title/city/state/organizer_name).
 */
function buildPendingWhere(filters = {}, startIndex = 0) {
  const params = [];
  const clauses = [PENDING];
  const p = () => `$${startIndex + params.length}`; // 1-based after we push

  if (filters.sourceId && isUuid(filters.sourceId)) {
    params.push(filters.sourceId);
    clauses.push(`EXISTS (SELECT 1 FROM event_sources es WHERE es.event_id = e.id AND es.source_id = $${startIndex + params.length})`);
  }
  if (filters.market && typeof filters.market === 'string') {
    params.push(filters.market);
    clauses.push(`e.market_slug = $${startIndex + params.length}`);
  }
  const q = (filters.q || '').trim();
  if (q) {
    params.push('%' + q + '%');
    const i = startIndex + params.length;
    clauses.push(`(e.title ILIKE $${i} OR e.city ILIKE $${i} OR e.state ILIKE $${i} OR e.organizer_name ILIKE $${i})`);
  }
  return { sql: clauses.join(' AND '), params };
}

// Advisory company-match: does the imported organizer already exist as a directory
// organization? Exact (case-insensitive name equality) / Possible (substring either way) /
// None. Purely informational for the reviewer — the writer always assigns imported events
// to the source's canonical owner org, so this NEVER reassigns ownership. % and _ in the
// organizer name are escaped so they can't broaden the ILIKE match.
const COMPANY_MATCH_SQL = `
  CASE
    WHEN e.organizer_name IS NULL OR btrim(e.organizer_name) = '' THEN 'none'
    WHEN EXISTS (SELECT 1 FROM organizations o2 WHERE lower(o2.name) = lower(e.organizer_name)) THEN 'exact'
    WHEN EXISTS (SELECT 1 FROM organizations o2
                  WHERE o2.name ILIKE '%' || replace(replace(e.organizer_name,'%','\\%'),'_','\\_') || '%'
                     OR replace(replace(e.organizer_name,'%','\\%'),'_','\\_') ILIKE '%' || o2.name || '%') THEN 'possible'
    ELSE 'none'
  END`;

// Latest provenance row for an event (an event can have >1 source; pick most recent).
const LATEST_SOURCE = `
  LEFT JOIN LATERAL (
    SELECT es.source_id, es.source_url, es.source_event_id, es.first_imported_at, es.last_synced_at, es.sync_status
      FROM event_sources es WHERE es.event_id = e.id
     ORDER BY es.first_imported_at DESC NULLS LAST LIMIT 1
  ) prov ON true`;

// Latest run-item for an event (the import that produced/updated it).
const LATEST_ITEM = `
  LEFT JOIN LATERAL (
    SELECT ri.run_id, ri.outcome, ri.match_via, ri.market_via, ri.reason, ri.created_at AS imported_item_at
      FROM import_run_items ri WHERE ri.event_id = e.id
     ORDER BY ri.created_at DESC NULLS LAST LIMIT 1
  ) item ON true`;

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * list — a page of pending imported events with lightweight review metadata.
 * @returns {Promise<{ items, total, page, limit, pages }>}
 */
async function list(opts = {}) {
  const page = clampInt(opts.page, 1, 1, 100000);
  const limit = clampInt(opts.limit, 25, 1, 100);
  const offset = (page - 1) * limit;
  const { sql: whereSql, params } = buildPendingWhere(opts, 0);

  const total = parseInt((await db.query(
    `SELECT count(*)::int AS n FROM events e WHERE ${whereSql}`, params)).rows[0].n, 10);

  const rows = (await db.query(
    `SELECT e.id, e.slug, e.title, e.city, e.state, e.market_slug, e.market_resolved_via,
            e.organizer_name, e.start_at, e.end_at, e.created_at, e.updated_at,
            (SELECT count(*)::int FROM event_images ei WHERE ei.event_id = e.id) AS image_count,
            ${COMPANY_MATCH_SQL} AS company_match_status,
            prov.source_id, prov.source_url, prov.first_imported_at, prov.sync_status,
            s.key AS source_key, s.name AS source_name, s.kind AS source_kind,
            s.media_policy, s.auto_publish,
            item.run_id, item.outcome, item.match_via, item.reason
       FROM events e
       ${LATEST_SOURCE}
       LEFT JOIN import_sources s ON s.id = prov.source_id
       ${LATEST_ITEM}
      WHERE ${whereSql}
      ORDER BY e.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset])).rows;

  return {
    items: rows.map(serializeListItem),
    total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
  };
}

function serializeListItem(r) {
  return {
    id: r.id, slug: r.slug, title: r.title,
    city: r.city, state: r.state, market: r.market_slug, market_resolved_via: r.market_resolved_via,
    organizer: r.organizer_name || null,
    start_at: r.start_at, end_at: r.end_at,
    image_count: r.image_count,
    imported_at: r.first_imported_at || null,
    company_match_status: r.company_match_status || 'none',
    source: r.source_id ? { id: r.source_id, key: r.source_key, name: r.source_name, kind: r.source_kind } : null,
    source_platform: r.source_name || r.source_kind || null,
    media_policy: r.media_policy || null,
    auto_publish_eligible: r.auto_publish === true,
    import: { run_id: r.run_id || null, outcome: r.outcome || null, match_via: r.match_via || null, duplicate_reason: r.reason || null },
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

/**
 * detail — a single pending (or already-decided) imported event with FULL review metadata:
 * the event content, every source-attribution row, import run metadata, company-match, and
 * possible directory matches. Read-only. Returns null if the id isn't an imported event.
 */
async function detail(eventId) {
  if (!isUuid(eventId)) return null;
  const ev = (await db.query(
    `SELECT e.*, ${COMPANY_MATCH_SQL} AS company_match_status,
            item.run_id, item.outcome, item.match_via, item.market_via, item.reason, item.imported_item_at,
            s.id AS source_id, s.key AS source_key, s.name AS source_name, s.kind AS source_kind,
            s.media_policy, s.auto_publish, s.status AS source_status,
            s.terms_attested_by, s.terms_attested_at, s.terms_attested_url,
            r.trigger AS run_trigger, r.started_at AS run_started_at, r.status AS run_status
       FROM events e
       ${LATEST_ITEM}
       LEFT JOIN import_runs r ON r.id = item.run_id
       LEFT JOIN LATERAL (
         SELECT es.source_id FROM event_sources es WHERE es.event_id = e.id
          ORDER BY es.first_imported_at DESC NULLS LAST LIMIT 1
       ) prov ON true
       LEFT JOIN import_sources s ON s.id = prov.source_id
      WHERE e.id = $1 AND e.source = 'imported' LIMIT 1`, [eventId])).rows[0];
  if (!ev) return null;

  const images = (await db.query(
    `SELECT url, position, is_cover, source_url, alt_text FROM event_images WHERE event_id = $1 ORDER BY position ASC`,
    [eventId])).rows;

  // Every provenance row (source attribution) — the audit-safe view (no raw_payload dump).
  const sources = (await db.query(
    `SELECT es.source_id, s.key AS source_key, s.name AS source_name, s.kind AS source_kind,
            es.source_event_id, es.source_url, es.source_updated_at,
            es.first_imported_at, es.last_synced_at, es.sync_status, es.content_hash, es.images_hash
       FROM event_sources es LEFT JOIN import_sources s ON s.id = es.source_id
      WHERE es.event_id = $1 ORDER BY es.first_imported_at DESC NULLS LAST`, [eventId])).rows;

  // Advisory: candidate directory organizations for this organizer (never auto-linked).
  let companyMatches = [];
  if (ev.organizer_name && ev.organizer_name.trim()) {
    companyMatches = (await db.query(
      `SELECT o.id, o.name, o.slug,
              (lower(o.name) = lower($1)) AS exact
         FROM organizations o
        WHERE lower(o.name) = lower($1)
           OR o.name ILIKE '%' || replace(replace($1,'%','\\%'),'_','\\_') || '%'
        ORDER BY (lower(o.name) = lower($1)) DESC, o.name ASC LIMIT 5`, [ev.organizer_name])).rows;
  }

  return {
    id: ev.id, slug: ev.slug, status: ev.status, is_pending: ev.status === 'draft',
    title: ev.title, subtitle: ev.subtitle, description: ev.description,
    category: ev.category_slug, market: ev.market_slug, market_resolved_via: ev.market_resolved_via,
    venue_name: ev.venue_name, address: ev.address, city: ev.city, state: ev.state, zip: ev.zip,
    lat: ev.lat, lng: ev.lng, timezone: ev.timezone,
    start_at: ev.start_at, end_at: ev.end_at,
    sale_type: ev.sale_type, event_format: ev.event_format,
    external_url: ev.external_url, registration_url: ev.registration_url, bidding_url: ev.bidding_url,
    organizer: {
      name: ev.organizer_name || null, website_url: ev.organizer_website_url || null, logo_url: ev.organizer_logo_url || null,
      contact_name: ev.contact_name || null, contact_phone: ev.contact_phone || null, contact_email: ev.contact_email || null,
    },
    organization_id: ev.organization_id,
    company_match: { status: ev.company_match_status || 'none', candidates: companyMatches },
    images: images.map((i) => ({ url: i.url, position: i.position, is_cover: i.is_cover, source_url: i.source_url, alt_text: i.alt_text })),
    attribution: sources.map((s) => ({
      source_id: s.source_id, source_key: s.source_key, source_name: s.source_name, source_platform: s.source_name || s.source_kind || null,
      source_event_id: s.source_event_id, source_url: s.source_url, source_updated_at: s.source_updated_at,
      first_imported_at: s.first_imported_at, last_synced_at: s.last_synced_at, sync_status: s.sync_status,
      content_hash: s.content_hash, images_hash: s.images_hash,
    })),
    import: {
      run_id: ev.run_id || null, run_trigger: ev.run_trigger || null, run_status: ev.run_status || null,
      run_started_at: ev.run_started_at || null, imported_at: ev.imported_item_at || null,
      outcome: ev.outcome || null, match_via: ev.match_via || null, market_via: ev.market_via || null,
      duplicate_reason: ev.reason || null,
    },
    source: ev.source_id ? {
      id: ev.source_id, key: ev.source_key, name: ev.source_name, kind: ev.source_kind, status: ev.source_status,
      media_policy: ev.media_policy || null, auto_publish_eligible: ev.auto_publish === true,
      terms_attested_by: ev.terms_attested_by || null, terms_attested_at: ev.terms_attested_at || null, terms_attested_url: ev.terms_attested_url || null,
    } : null,
    created_at: ev.created_at, updated_at: ev.updated_at,
  };
}

// ── Mutations (transactional — caller supplies the pg client) ─────────────────

/**
 * approveOne — publish a single pending imported event (draft → published) and audit the
 * approval, attributed to the acting admin. Idempotent/safe: if the event is missing or no
 * longer pending it returns { ok:false, reason } without mutating anything.
 */
async function approveOne(client, eventId, actorId, note) {
  const cur = (await client.query(
    `SELECT id, status FROM events WHERE id = $1 AND source = 'imported' FOR UPDATE`, [eventId])).rows[0];
  if (!cur) return { id: eventId, ok: false, reason: 'not_found' };
  if (cur.status !== 'draft') return { id: eventId, ok: false, reason: 'not_pending', status: cur.status };

  const published = await writer.publishImported(client, eventId, { actorId });
  if (!published) return { id: eventId, ok: false, reason: 'not_pending' };
  await writeAuditLog({
    client, event_type: 'event.import.approved', entity_type: 'event', entity_id: eventId,
    actor_id: actorId || null, metadata: { actor: 'admin_review_queue', note: note || null },
  });
  return { id: eventId, ok: true, status: 'published' };
}

/**
 * rejectOne — move a single pending imported event to 'rejected' (never published, never
 * shown publicly, provenance + audit preserved) and audit the rejection with the reason.
 */
async function rejectOne(client, eventId, actorId, reason) {
  const cur = (await client.query(
    `SELECT id, status FROM events WHERE id = $1 AND source = 'imported' FOR UPDATE`, [eventId])).rows[0];
  if (!cur) return { id: eventId, ok: false, reason: 'not_found' };
  if (cur.status !== 'draft') return { id: eventId, ok: false, reason: 'not_pending', status: cur.status };

  const { rows } = await client.query(
    `UPDATE events SET status = 'rejected', updated_at = now()
      WHERE id = $1 AND source = 'imported' AND status = 'draft' RETURNING id`, [eventId]);
  if (!rows.length) return { id: eventId, ok: false, reason: 'not_pending' };
  await writeAuditLog({
    client, event_type: 'event.import.rejected', entity_type: 'event', entity_id: eventId,
    actor_id: actorId || null, metadata: { actor: 'admin_review_queue', reason: reason || null },
  });
  return { id: eventId, ok: true, status: 'rejected' };
}

/**
 * lockPendingIds — SELECT ... FOR UPDATE the pending ids matching `filters`. Used by
 * approve-all so the expectedCount guard is evaluated against a row-locked snapshot (no
 * other writer can change the set between the count check and the approvals).
 */
async function lockPendingIds(client, filters = {}) {
  const { sql: whereSql, params } = buildPendingWhere(filters, 0);
  const { rows } = await client.query(
    `SELECT e.id FROM events e WHERE ${whereSql} ORDER BY e.created_at ASC FOR UPDATE`, params);
  return rows.map((r) => r.id);
}

class CountMismatchError extends Error {
  constructor(expected, actual) {
    super(`Approve-all count mismatch: expected ${expected}, found ${actual}. The queue changed — refresh and retry.`);
    this.name = 'CountMismatchError'; this.code = 'APPROVE_ALL_COUNT_MISMATCH';
    this.expected = expected; this.actual = actual;
  }
}

module.exports = {
  list, detail, approveOne, rejectOne, lockPendingIds,
  buildPendingWhere, CountMismatchError, isUuid, PENDING,
};
