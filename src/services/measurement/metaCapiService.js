'use strict';

/**
 * metaCapiService — Meta Conversions API SOFTWARE FOUNDATION (Phase 3P.2). Not activated.
 *
 *   buildEvent(conversion, ctx)  → the exact server event Meta would receive: event_name from the shared conversion
 *                                  definitions, event_time, event_id = the first-party conversion id (the SAME id the
 *                                  browser pixel uses as eventID → provider-side deduplication), action_source,
 *                                  user_data with SHA-256-normalised identifiers and _fbc derived from a captured fbclid,
 *                                  custom_data (value/currency only where the definition carries a value).
 *   decide(ctx)                  → the dispatch decision. Order (first failing gate wins): GATED_OFF (Owner gate
 *                                  marketing.measurement.meta_capi_enabled) · NOT_CONFIGURED / identity failures
 *                                  (assetIdentityGuard — never a Lewis & Maese asset, never an invented id) ·
 *                                  TOKEN_ABSENT (presence check only — the value is never read into a response or log) ·
 *                                  NO_CONSENT (visitor/user advertising consent) · READY.
 *   send()                       → refuses unless decide() returns READY. In this phase the Owner gate is OFF, so
 *                                  nothing is ever transmitted.
 */
const crypto = require('crypto');
const defs = require('../../lib/conversionDefinitions');
const guard = require('./assetIdentityGuard');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

/** _fbc format per Meta: fb.1.<creation ms>.<fbclid> */
function fbcFrom(fbclid, capturedAt) {
  if (!fbclid) return null;
  const ms = capturedAt ? new Date(capturedAt).getTime() : Date.now();
  return 'fb.1.' + ms + '.' + String(fbclid).trim();
}

function buildEvent(conversion, { email = null, externalId = null, fbclid = null, fbclidCapturedAt = null, fbc = null, fbp = null, clientIp = null, userAgent = null, sourceUrl = null } = {}) {
  const def = defs.get(conversion.conversion_key);
  if (!def || !def.meta_event) return null;
  const user_data = {};
  if (email) user_data.em = [sha(email)];
  if (externalId || conversion.user_id) user_data.external_id = [sha(externalId || conversion.user_id)];
  // _fbc: the browser cookie when present (set by the Pixel), else derived from the first-party captured fbclid.
  const fbcVal = (typeof fbc === 'string' && /^fb\.\d\.\d+\./.test(fbc)) ? fbc : fbcFrom(fbclid, fbclidCapturedAt); if (fbcVal) user_data.fbc = fbcVal;
  if (typeof fbp === 'string' && /^fb\.\d\.\d+\./.test(fbp)) user_data.fbp = fbp;
  if (clientIp) user_data.client_ip_address = clientIp;
  if (userAgent) user_data.client_user_agent = userAgent;
  const ev = {
    event_name: def.meta_event,
    event_time: Math.floor(new Date(conversion.occurred_at || Date.now()).getTime() / 1000),
    // Dedup key: the browser Pixel's eventID for the same conversion when the browser also sent it (provider_event_id),
    // else the first-party conversion id (server-only conversion — nothing to deduplicate against).
    event_id: String(conversion.provider_event_id || conversion.id),
    action_source: 'website',
    user_data,
    custom_data: { conversion_key: conversion.conversion_key },
  };
  if (sourceUrl) ev.event_source_url = sourceUrl;
  if (def.value && conversion.value_cents != null) { ev.custom_data.value = Number(conversion.value_cents) / 100; ev.custom_data.currency = conversion.currency || 'USD'; }
  return ev;
}

/** Pure dispatch decision. `cfg` = { enabled, datasetId, identity }; tokenPresent = boolean presence check. */
function decide({ cfg = {}, tokenPresent = false, advertisingConsent = false } = {}) {
  if (cfg.enabled !== true) return { status: 'gated_off', reason: 'Owner gate marketing.measurement.meta_capi_enabled is OFF' };
  const id = guard.check('meta_dataset', cfg.datasetId, cfg.identity);
  if (!id.ok) return { status: id.reason === 'NOT_CONFIGURED' ? 'not_configured' : 'identity_blocked', reason: id.reason + ': ' + id.detail };
  if (!tokenPresent) return { status: 'token_absent', reason: 'no server credential present for the dataset' };
  if (!advertisingConsent) return { status: 'no_consent', reason: 'advertising consent not granted' };
  return { status: 'ready' };
}

async function cfgGet(k) { try { return await require('../configService').get(null, k); } catch (_) { return null; } }
async function loadConfig() {
  const enabled = await cfgGet('marketing.measurement.meta_capi_enabled');
  return { enabled: enabled === true || enabled === 'true', datasetId: await cfgGet('marketing.measurement.meta_dataset_id'), identity: await cfgGet('marketing.measurement.meta_dataset_identity') };
}
/** Presence check only — never returns, logs or echoes the value. */
const tokenPresent = () => Boolean(process.env.META_CAPI_ACCESS_TOKEN && String(process.env.META_CAPI_ACCESS_TOKEN).length > 20);

/**
 * Send server events. testEventCode (from Events Manager → Test events) marks them as TEST events: they appear only in
 * the Test Events view and are excluded from reporting and optimisation — used for labelled verification only.
 * Returns the receipt (events_received, fbtrace_id) — never the credential.
 */
async function send(events, { advertisingConsent = false, testEventCode = null, cfg: cfgIn = null } = {}) {
  const cfg = cfgIn || await loadConfig();
  const d = decide({ cfg, tokenPresent: tokenPresent(), advertisingConsent });
  if (d.status !== 'ready') return { sent: false, decision: d };
  const body = { data: events };
  if (testEventCode && /^[A-Za-z0-9]{4,32}$/.test(String(testEventCode))) body.test_event_code = String(testEventCode);
  const res = await fetch('https://graph.facebook.com/' + GRAPH_VERSION + '/' + encodeURIComponent(String(cfg.datasetId)) + '/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.META_CAPI_ACCESS_TOKEN },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await res.json(); } catch (_) { j = null; }
  const err = j && j.error ? { code: j.error.code, type: j.error.type, message: String(j.error.message || '').split(process.env.META_CAPI_ACCESS_TOKEN || '\u0000').join('[credential]').slice(0, 200) } : null;
  return { sent: res.ok && !err, status: res.status, decision: d, events_received: j && j.events_received != null ? j.events_received : null, fbtrace_id: j && j.fbtrace_id ? j.fbtrace_id : null, test: !!body.test_event_code, error: err };
}

module.exports = { buildEvent, decide, loadConfig, tokenPresent, send, fbcFrom, sha, GRAPH_VERSION };
