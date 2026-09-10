'use strict';

/**
 * conversionService — the first-party conversion ledger (marketing_conversion_events). record() NEVER throws and never
 * blocks the caller (fire-and-forget from routes). Each row carries the attribution snapshot at write time and its id
 * doubles as the provider dedup event_id. Provider dispatch (Meta CAPI / Google Ads) is decided per event by the
 * channel's own decide(): Owner gate → asset identity (never a client's asset, never an invented id) → credential
 * presence → advertising consent. Every gate is OFF in this phase, so each row records 'gated_off' and nothing leaves
 * the platform. First-party operational measurement is separate from third-party advertising signals.
 */
const crypto = require('crypto');
const db = require('../db');
const defs = require('../lib/conversionDefinitions');
const attribution = require('./attributionService');

async function consentAdvertising(r, { userId, visitorId }) {
  try {
    const scopes = [];
    if (userId) scopes.push(['user', String(userId)]);
    if (visitorId) scopes.push(['visitor', String(visitorId)]);
    for (const [t, id] of scopes) {
      const row = (await r.query(`SELECT state FROM consent_records WHERE scope_type=$1 AND scope_id=$2 AND category='advertising' ORDER BY created_at DESC LIMIT 1`, [t, id])).rows[0];
      if (row) return row.state === 'granted';
    }
  } catch (_) { /* unknown → not granted */ }
  return false;
}

// Provider configuration is read at most once a minute (gates change rarely; a stale read can only be more restrictive
// for up to a minute after the Owner turns a gate OFF — and send() re-reads the config itself before transmitting).
let cfgCache = null, cfgAt = 0;
async function providerConfig() {
  if (cfgCache && Date.now() - cfgAt < 60000) return cfgCache;
  const meta = require('./measurement/metaCapiService'); const google = require('./measurement/googleConversionsService');
  cfgCache = { meta: await meta.loadConfig().catch(() => ({ enabled: false })), google: await google.loadConfig().catch(() => ({ enabled: false })) };
  cfgAt = Date.now();
  return cfgCache;
}

async function dispatchDecisions({ key, userId, visitorId, adConsent }, r) {
  const meta = require('./measurement/metaCapiService'); const google = require('./measurement/googleConversionsService');
  const cfg = await providerConfig();
  const def = defs.get(key) || {};
  const m = def.meta_event ? meta.decide({ cfg: cfg.meta, tokenPresent: meta.tokenPresent(), advertisingConsent: adConsent }) : { status: 'not_mapped' };
  let g = { status: 'not_mapped' };
  if (def.google_action) {
    const click = cfg.google.enabled ? await google.latestClick({ userId, visitorId }, r).catch(() => null) : null;
    g = google.decide({ cfg: cfg.google, conversionKey: key, click, advertisingConsent: adConsent });
    if (g.status === 'ready') g = { status: 'ready_pending_connector', reason: 'upload connector is connected only after the Owner links the account' };
  }
  return { meta_capi: m, google_ads: g, advertising_consent: adConsent };
}

async function record(key, { userId = null, visitorId = null, subjectType = null, subjectId = null, valueCents = null, market = null, idempotencyKey = null, occurredAt = null } = {}, runner) {
  const r = runner || db;
  try {
    const def = defs.get(key); if (!def) return null;
    const idem = idempotencyKey || crypto.createHash('sha256').update([key, userId || '', visitorId || '', subjectType || '', subjectId || ''].join('|')).digest('hex');
    const snap = await attribution.snapshot({ userId, visitorId }, r).catch(() => ({ class: 'ATTRIBUTION_UNAVAILABLE' }));
    const adConsent = await consentAdvertising(r, { userId, visitorId });
    const dispatch = await dispatchDecisions({ key, userId, visitorId, adConsent }, r).catch(() => ({ meta_capi: { status: 'gated_off' }, google_ads: { status: 'gated_off' }, advertising_consent: adConsent }));
    const ins = await r.query(`INSERT INTO marketing_conversion_events (conversion_key, user_id, visitor_id, subject_type, subject_id, value_cents, market, occurred_at, attribution, consent_state, provider_dispatch, idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9::jsonb,$10::jsonb,$11::jsonb,$12) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, occurred_at`,
      [key, userId, visitorId, subjectType, subjectId != null ? String(subjectId) : null, valueCents, market, occurredAt, JSON.stringify(snap), JSON.stringify({ advertising: adConsent }), JSON.stringify(dispatch), idem]);
    if (!ins.rows[0]) return { deduped: true };
    const row = { id: ins.rows[0].id, occurred_at: ins.rows[0].occurred_at, conversion_key: key, user_id: userId, value_cents: valueCents };
    if (dispatch.meta_capi.status === 'ready') sendMeta(r, row, adConsent).catch(() => {});
    return { id: row.id, attribution: snap.class, dispatch: { meta_capi: dispatch.meta_capi.status, google_ads: dispatch.google_ads.status } };
  } catch (_) { return null; }
}

/** Only reachable when the Owner gate is ON, identity verified, credential present and consent granted. */
async function sendMeta(r, row, adConsent) {
  const meta = require('./measurement/metaCapiService');
  const ev = meta.buildEvent(row, {});
  if (!ev) return;
  const out = await meta.send([ev], { advertisingConsent: adConsent });
  await r.query(`UPDATE marketing_conversion_events SET provider_dispatch = jsonb_set(provider_dispatch, '{meta_capi}', $2::jsonb) WHERE id=$1`,
    [row.id, JSON.stringify({ status: out.sent ? 'sent' : (out.decision && out.decision.status !== 'ready' ? out.decision.status : 'failed'), http_status: out.status || null, at: new Date().toISOString() })]);
}

/** Fire-and-forget helper for routes: never awaits into the response path, never throws. */
function emit(key, opts) { record(key, opts).catch(() => {}); }

module.exports = { record, emit, dispatchDecisions };
