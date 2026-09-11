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

/**
 * Request context for the Conversions API, read from the request at emit time and NEVER stored: client IP and user
 * agent (match quality), the Pixel's first-party cookies _fbp / _fbc, the page URL, and the browser's eventID for the
 * same conversion (body.meta_event_id — shared with the Pixel so Meta counts the conversion once).
 */
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function readCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return null; } } }
  return null;
}
function ctxFromReq(req) {
  try {
    const b = (req && req.body) || {};
    const ip = String((req.headers['x-forwarded-for'] || req.ip || '')).split(',')[0].trim() || null;
    const eventId = typeof b.meta_event_id === 'string' && EVENT_ID_RE.test(b.meta_event_id) ? b.meta_event_id : null;
    return { eventId, meta: { clientIp: ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 400) || null, fbp: readCookie(req, '_fbp'), fbc: readCookie(req, '_fbc'), sourceUrl: String(req.headers.referer || '').slice(0, 500) || null } };
  } catch (_) { return { eventId: null, meta: {} }; }
}

async function record(key, { userId = null, visitorId = null, subjectType = null, subjectId = null, valueCents = null, market = null, idempotencyKey = null, occurredAt = null, eventId = null, meta: metaCtx = null, testEventCode = null } = {}, runner) {
  const r = runner || db;
  try {
    const def = defs.get(key); if (!def) return null;
    const idem = idempotencyKey || crypto.createHash('sha256').update([key, userId || '', visitorId || '', subjectType || '', subjectId || ''].join('|')).digest('hex');
    const snap = await attribution.snapshot({ userId, visitorId }, r).catch(() => ({ class: 'ATTRIBUTION_UNAVAILABLE' }));
    const adConsent = await consentAdvertising(r, { userId, visitorId });
    const dispatch = await dispatchDecisions({ key, userId, visitorId, adConsent }, r).catch(() => ({ meta_capi: { status: 'gated_off' }, google_ads: { status: 'gated_off' }, advertising_consent: adConsent }));
    const pev = typeof eventId === 'string' && EVENT_ID_RE.test(eventId) ? eventId : null;
    const ins = await r.query(`INSERT INTO marketing_conversion_events (conversion_key, user_id, visitor_id, subject_type, subject_id, value_cents, market, occurred_at, attribution, consent_state, provider_dispatch, idempotency_key, provider_event_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9::jsonb,$10::jsonb,$11::jsonb,$12,$13) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, occurred_at`,
      [key, userId, visitorId, subjectType, subjectId != null ? String(subjectId) : null, valueCents, market, occurredAt, JSON.stringify(snap), JSON.stringify({ advertising: adConsent }), JSON.stringify(dispatch), idem, pev]);
    if (!ins.rows[0]) return { deduped: true };
    const row = { id: ins.rows[0].id, occurred_at: ins.rows[0].occurred_at, conversion_key: key, user_id: userId, visitor_id: visitorId, value_cents: valueCents, provider_event_id: pev };
    if (dispatch.meta_capi.status === 'ready') sendMeta(r, row, adConsent, metaCtx || {}, testEventCode).catch(() => {});
    return { id: row.id, attribution: snap.class, dispatch: { meta_capi: dispatch.meta_capi.status, google_ads: dispatch.google_ads.status } };
  } catch (_) { return null; }
}

/**
 * Only reachable when the Owner gate is ON, the dataset identity is verified, the credential is present and advertising
 * consent is granted. Identifiers are hashed by the builder; the email is read here and never stored with the event.
 */
async function sendMeta(r, row, adConsent, ctx = {}, testEventCode = null) {
  const meta = require('./measurement/metaCapiService');
  let email = null, fbclid = null, fbclidAt = null;
  if (row.user_id) { try { email = ((await r.query('SELECT email FROM users WHERE id=$1', [row.user_id])).rows[0] || {}).email || null; } catch (_) { email = null; } }
  if (!ctx.fbc) {
    try {
      const c = (await r.query(`SELECT click_value, first_seen_at FROM marketing_click_ids WHERE click_type='fbclid' AND ((($1)::uuid IS NOT NULL AND user_id=$1) OR (($2)::text IS NOT NULL AND scope_id=$2)) AND last_seen_at > now() - interval '90 days' ORDER BY last_seen_at DESC LIMIT 1`, [row.user_id || null, row.visitor_id || null])).rows[0];
      if (c) { fbclid = c.click_value; fbclidAt = c.first_seen_at; }
    } catch (_) { /* no click id */ }
  }
  const ev = meta.buildEvent(row, { email, fbclid, fbclidCapturedAt: fbclidAt, fbc: ctx.fbc || null, fbp: ctx.fbp || null, clientIp: ctx.clientIp || null, userAgent: ctx.userAgent || null, sourceUrl: ctx.sourceUrl || null });
  if (!ev) return null;
  const out = await meta.send([ev], { advertisingConsent: adConsent, testEventCode });
  const status = out.sent ? 'sent' : (out.decision && out.decision.status !== 'ready' ? out.decision.status : 'failed');
  await r.query(`UPDATE marketing_conversion_events SET provider_dispatch = jsonb_set(provider_dispatch, '{meta_capi}', $2::jsonb) WHERE id=$1`,
    [row.id, JSON.stringify({ status, event_id: ev.event_id, http_status: out.status || null, events_received: out.events_received, fbtrace_id: out.fbtrace_id, test: out.test || false,
      matched_on: Object.keys(ev.user_data), error: out.error ? out.error.message : null, at: new Date().toISOString() })]);
  return Object.assign({ status, event_id: ev.event_id }, { events_received: out.events_received, fbtrace_id: out.fbtrace_id, test: out.test, error: out.error });
}

/** Fire-and-forget helper for routes: never awaits into the response path, never throws. */
function emit(key, opts) { record(key, opts).catch(() => {}); }

module.exports = { record, emit, dispatchDecisions, ctxFromReq, readCookie, sendMeta };
