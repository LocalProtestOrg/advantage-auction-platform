'use strict';

/**
 * runImport — the Event Import Framework engine (§7, §8, §9 of the plan). Wires the stages:
 *   connector.fetch → normalize+validate → dedupe → market resolve → geocode → writer → run ledger.
 *
 * apply defaults to FALSE (dry run): it writes NOTHING — no events, no provenance, no run ledger, no
 * market_candidates, no geocoder calls — it only reads and returns what WOULD happen. apply=true persists
 * inside per-record transactions, enforces the create cap (weekly_cap ∧ global 75), and records the run.
 * Caps count CREATES only; updates/unchanged are free. A truncated run sets capped + remaining_available.
 */

const pipeline = require('./pipeline');
const dedupe = require('./dedupe');
const marketResolver = require('./marketResolver');
const geocode = require('./geocode');
const writer = require('./writer');
const runLog = require('./runLog');
const { getConnector } = require('./connectors');

const GLOBAL_CREATE_CAP = 75;

function writerCtx(rec, raw, geo, mr, src, dd) {
  return {
    canonical: rec.canonical, geo: geo || {},
    market: { marketSlug: mr.marketSlug, via: mr.via },
    orgId: src.owner_organization_id,
    provenance: { sourceId: src.id, sourceEventId: rec.sourceEventId, sourceUrl: rec.sourceUrl,
      sourceUpdatedAt: rec.sourceUpdatedAt, rawPayload: raw && raw.payload },
    contentHash: rec.contentHash, imagesHash: rec.imagesHash,
    attribution: { source: src.name || src.key, url: rec.sourceUrl },
    actorId: null, imagesChanged: dd.imagesChanged,
  };
}

async function runImport(opts) {
  opts = opts || {};
  const apply = !!opts.apply;
  const db = opts.db || require('../../db');
  const withTransaction = opts.withTransaction || (db && db.withTransaction);
  const trigger = opts.trigger || 'manual';
  const nowIso = opts.now || (() => new Date().toISOString());

  const src = (await db.query('SELECT * FROM import_sources WHERE key = $1', [opts.sourceKey])).rows[0];
  if (!src) throw new Error('Unknown import source: ' + opts.sourceKey);
  const config = src.config || {};
  const fieldMap = config.field_map || opts.fieldMap || {};
  const defaults = config.defaults || {};
  const connector = opts.connector || getConnector(src.kind);
  const cap = Math.min(src.weekly_cap || GLOBAL_CREATE_CAP, GLOBAL_CREATE_CAP);

  let run = null;
  if (apply) {
    run = await runLog.startRun(db, { sourceId: src.id, trigger, scheduledFor: opts.scheduledFor });
    if (!run) return { claimed: false, reason: 'run_claim_lost' };
  }

  const counters = { fetched: 0, eligible: 0, created: 0, updated: 0, skipped_duplicate: 0, skipped_quality: 0, skipped_ambiguous: 0, images_queued: 0, failed: 0 };
  const items = [];
  let created = 0, capped = false;

  try {
    for await (const raw of connector.fetch({ config, limit: opts.limit, signal: opts.signal })) {
      counters.fetched++;
      const rec = pipeline.normalizeItem(raw, { fieldMap, defaults, now: opts.nowMs });
      let outcome = rec.outcome, eventId = null, matchVia = null, marketVia = null, reason = rec.reason, error = rec.error;

      if (rec.outcome === 'eligible') {
        counters.eligible++;
        const dd = await dedupe.dedupe(db, rec, { sourceId: src.id });
        const mr = await marketResolver.resolveWithDb(db,
          { lat: rec.canonical.lat, lng: rec.canonical.lng, zip: rec.canonical.zip, city: rec.canonical.city, state: rec.canonical.state },
          { record: apply });
        marketVia = mr.via; matchVia = dd.matchVia || null;

        if (dd.outcome === 'ambiguous') { outcome = 'ambiguous'; reason = dd.reason; }
        else if (dd.outcome === 'unchanged') { outcome = 'unchanged'; eventId = dd.eventId; }
        else if (dd.outcome === 'update') {
          outcome = 'updated'; eventId = dd.eventId;
          if (apply) {
            const geo = await geocode.geocodeEvent(rec.canonical, dd.existing || {}, { geocodeFn: opts.geocodeFn, now: nowIso, sleep: opts.sleep, bucket: opts.bucket });
            await withTransaction(async (client) => { await writer.updateImported(client, dd.eventId, writerCtx(rec, raw, geo, mr, src, dd)); });
            counters.images_queued += (rec.canonical.images || []).length;
          }
        } else { // create (possibly possible_duplicate)
          if (created >= cap) { capped = true; break; } // truncate — do not process past the cap
          outcome = 'created';
          if (apply) {
            const geo = await geocode.geocodeEvent(rec.canonical, {}, { geocodeFn: opts.geocodeFn, now: nowIso, sleep: opts.sleep, bucket: opts.bucket });
            await withTransaction(async (client) => {
              eventId = await writer.createImported(client, writerCtx(rec, raw, geo, mr, src, dd));
              if (src.auto_publish) await writer.publishImported(client, eventId, writerCtx(rec, raw, geo, mr, src, dd));
            });
            counters.images_queued += (rec.canonical.images || []).length;
          }
          created++;
        }
      }

      const ck = runLog.counterFor(outcome);
      if (ck) counters[ck] = (counters[ck] || 0) + 1;
      items.push({ sourceEventId: rec.sourceEventId, eventId, outcome, matchVia, marketVia, reason, error, possibleDuplicate: false });
      if (apply && run) await runLog.recordItem(db, run.id, { sourceEventId: rec.sourceEventId, eventId, outcome, matchVia, marketVia, reason, error, rawExcerpt: raw && raw.payload });
    }
  } catch (e) {
    if (apply && run) await runLog.finishRun(db, run.id, { status: 'failed', counters, capped, lastError: String(e && e.message) }).catch(() => {});
    throw e;
  }

  const status = counters.failed > 0 ? 'partial' : 'completed';
  if (apply && run) await runLog.finishRun(db, run.id, { status, counters, capped, remainingAvailable: capped ? 0 : Math.max(0, cap - created) });

  return { applied: apply, claimed: apply ? true : undefined, runId: run && run.id, status, capped, remainingAvailable: Math.max(0, cap - created), counters, items };
}

module.exports = { runImport };
