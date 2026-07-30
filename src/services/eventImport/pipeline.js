'use strict';

/**
 * pipeline — stage orchestration with per-record error isolation (§8, §11 of the plan). Pure interface;
 * no DB. Commit 4 ships the normalize + quality-gate stage and the runner; later commits add dedupe,
 * geocode, market-resolve, and writer stages by APPENDING to the stage list — no change here.
 *
 * A record flows through ordered stages. A stage returns the (possibly annotated) record; setting
 * `record.terminal = true` stops further stages (rejected/duplicate/unchanged/failed). Any thrown error
 * isolates to that one record (`outcome:'failed'`) — one bad record never aborts the run.
 *
 * outcomes: 'eligible' (passed normalize+validate; writer decides created/updated later) · terminal
 * 'rejected_quality' · 'failed'. Final created/updated/unchanged/duplicate/ambiguous come from later stages.
 */

const { applyFieldMap } = require('./normalize/fieldMap');
const { sanitizeCanonical, contentHash, imagesHash } = require('./normalize/canonical');
const { validate } = require('./validate');

/**
 * Normalize + quality-gate ONE connector record.
 * @param rawItem { sourceEventId, sourceUrl, sourceUpdatedAt, payload, images }
 * @param ctx     { fieldMap, defaults, now }
 */
function normalizeItem(rawItem, ctx) {
  ctx = ctx || {};
  rawItem = rawItem || {};
  try {
    const draft = applyFieldMap(rawItem.payload || {}, ctx.fieldMap || {});
    if (rawItem.images && draft.images === undefined) draft.images = rawItem.images;
    const merged = Object.assign({}, ctx.defaults || {}, draft);
    const canonical = sanitizeCanonical(merged);
    const v = validate(canonical, { now: ctx.now });
    return {
      sourceEventId: rawItem.sourceEventId != null ? String(rawItem.sourceEventId) : null,
      sourceUrl: rawItem.sourceUrl || canonical.external_url || null,
      sourceUpdatedAt: rawItem.sourceUpdatedAt || null,
      canonical,
      contentHash: contentHash(canonical),
      imagesHash: imagesHash(canonical),
      outcome: v.ok ? 'eligible' : v.outcome,
      reason: v.reason || null,
      terminal: !v.ok,
    };
  } catch (e) {
    return { sourceEventId: rawItem.sourceEventId != null ? String(rawItem.sourceEventId) : null,
      outcome: 'failed', reason: 'normalize_error', error: String(e && e.message), terminal: true };
  }
}

// A stage factory for the normalize step (so the pipeline is a list of stages).
function normalizeStage(ctx) {
  return async (rec) => Object.assign(rec, normalizeItem(rec.raw, ctx));
}

/**
 * Run each raw connector item through the ordered stages with per-record isolation.
 * @returns { items: [record...], summary: { total, byOutcome: {outcome:count} } }
 */
async function runStages(rawItems, stages, ctx) {
  const items = [];
  for (const raw of (rawItems || [])) {
    let rec = { raw, sourceEventId: raw && raw.sourceEventId != null ? String(raw.sourceEventId) : null, outcome: 'pending', terminal: false };
    try {
      for (const stage of (stages || [])) {
        rec = await stage(rec, ctx);
        if (!rec) { rec = { outcome: 'failed', reason: 'stage_returned_nothing', terminal: true }; break; }
        if (rec.terminal) break;
      }
    } catch (e) {
      rec = Object.assign(rec || {}, { outcome: 'failed', reason: 'stage_error', error: String(e && e.message), terminal: true });
    }
    items.push(rec);
  }
  const byOutcome = {};
  for (const r of items) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  return { items, summary: { total: items.length, byOutcome } };
}

module.exports = { normalizeItem, normalizeStage, runStages };
