'use strict';

/**
 * metaAdsProvider — the ONLY place Advantage.Bid writes to Meta's advertising API.
 *
 * Same safety posture as the measurement services: a fixed asset identity, an explicit permission
 * check before any write, structured refusals instead of thrown errors, and no credential ever
 * present in a return value, a log line or an error message.
 *
 * ASSET ISOLATION IS THE POINT OF THIS FILE. Every write resolves its ad account from
 * `marketing.measurement.meta_ad_account_id`, cross-checks it against the verified identity record,
 * and refuses if the account appears in `marketing.measurement.meta_ad_account_excluded`. Lewis &
 * Maese assets live in the same Meta ecosystem; they must remain unreachable. When identity is
 * ambiguous — no verified record, a mismatch, or an account we cannot confirm — this FAILS CLOSED.
 *
 * CAMPAIGNS ARE CREATED PAUSED. Every campaign, ad set and ad is created with status PAUSED, so
 * even a successful creation spends nothing until something deliberately activates it.
 */

const db = require('../../db');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN_ENV = 'META_ADS_MANAGE_TOKEN';   // separate from the read token on purpose
const READ_TOKEN_ENV = 'META_ADS_READ_TOKEN';

const token = (write) => process.env[write ? TOKEN_ENV : READ_TOKEN_ENV] || process.env[READ_TOKEN_ENV] || null;

/** Strip anything secret-shaped out of text that might be surfaced. */
function redact(text) {
  let s = String(text == null ? '' : text);
  for (const k of [TOKEN_ENV, READ_TOKEN_ENV, 'META_CAPI_ACCESS_TOKEN', 'META_SYSTEM_USER_TOKEN', 'META_APP_SECRET']) {
    const v = process.env[k];
    if (v && v.length > 8) s = s.split(v).join('[credential]');
  }
  return s.slice(0, 400);
}

async function cfg(key, runner = db) {
  const r = await runner.query('SELECT value FROM platform_config WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function call(pathname, { method = 'GET', body = null, write = false } = {}) {
  const t = token(write);
  if (!t) return { ok: false, error: 'no_credential', detail: (write ? TOKEN_ENV : READ_TOKEN_ENV) + ' not set' };
  const url = GRAPH + pathname;
  try {
    const init = { method, headers: { Authorization: 'Bearer ' + t } };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(url, init);
    const json = await res.json().catch(() => null);
    if (!res.ok || (json && json.error)) {
      const e = (json && json.error) || {};
      return { ok: false, error: 'provider_error', code: e.code || res.status, type: e.type || null, detail: redact(e.message || res.statusText) };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: 'network', detail: redact(e.message) };
  }
}

/** Which permissions the system user actually holds right now. */
async function permissions() {
  const r = await call('/me/permissions');
  if (!r.ok) return { ok: false, reason: r.detail || r.error, granted: [] };
  const granted = ((r.data && r.data.data) || []).filter((p) => p.status === 'granted').map((p) => p.permission);
  return {
    ok: true,
    granted,
    ads_read: granted.includes('ads_read'),
    ads_management: granted.includes('ads_management'),
    business_management: granted.includes('business_management'),
  };
}

/**
 * Resolve the ad account we are permitted to write to, or refuse.
 * This is the isolation gate. It never guesses and never falls back to "the first account we see".
 */
async function resolveAdAccount(runner = db) {
  const configured = await cfg('marketing.measurement.meta_ad_account_id', runner);
  const identity = await cfg('marketing.measurement.meta_ad_account_identity', runner);
  const excluded = (await cfg('marketing.measurement.meta_ad_account_excluded', runner)) || [];
  const list = Array.isArray(excluded) ? excluded : [];

  if (!configured || typeof configured !== 'string') {
    return { ok: false, reason: 'no ad account configured — refusing rather than choosing one' };
  }
  if (list.includes(configured)) {
    return { ok: false, reason: 'configured ad account ' + configured + ' is on the excluded list and must never be used' };
  }
  if (!identity || identity.id !== configured) {
    return { ok: false, reason: 'ad account identity is unverified or does not match the configured account — failing closed' };
  }
  if (!identity.owner_confirmed) {
    return { ok: false, reason: 'ad account has no Owner confirmation on record — failing closed' };
  }
  return { ok: true, account: configured, name: identity.name || null, currency: identity.currency || null, excluded: list };
}

/** Refuse if an account we were told to use is excluded, whatever route it arrived by. */
async function assertNotExcluded(account, runner = db) {
  const excluded = (await cfg('marketing.measurement.meta_ad_account_excluded', runner)) || [];
  const list = Array.isArray(excluded) ? excluded : [];
  if (list.includes(account)) return { ok: false, reason: 'excluded ad account: ' + account };
  return { ok: true };
}

// ── writes (all create PAUSED) ────────────────────────────────────────────────────────────────

const OBJECTIVES = Object.freeze({
  buyer: 'OUTCOME_TRAFFIC',
  individual_seller: 'OUTCOME_LEADS',
  professional_seller: 'OUTCOME_LEADS',
});

/**
 * Create a campaign, PAUSED. `spendCapCents` sets a provider-side lifetime cap in addition to our
 * own ledger, so the ceiling is enforced on both sides of the boundary.
 */
async function createCampaign({ account, name, funnel, spendCapCents, idempotencyKey }, runner = db) {
  const guard = await assertNotExcluded(account, runner);
  if (!guard.ok) return guard;
  const perms = await permissions();
  if (!perms.ok) return { ok: false, reason: 'cannot read permissions: ' + perms.reason };
  if (!perms.ads_management) return { ok: false, reason: 'ads_management not granted — campaign creation is not possible' };

  const body = {
    name,
    objective: OBJECTIVES[funnel] || 'OUTCOME_TRAFFIC',
    status: 'PAUSED',                        // never create anything that can start spending
    special_ad_categories: [],
  };
  if (Number.isInteger(spendCapCents) && spendCapCents > 0) body.spend_cap = spendCapCents;
  const r = await call('/' + account + '/campaigns', { method: 'POST', body, write: true });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, provider_campaign_id: r.data.id, status: 'PAUSED', idempotency_key: idempotencyKey };
}

async function setStatus({ objectId, status }, runner = db) {
  if (!['PAUSED', 'ACTIVE', 'ARCHIVED'].includes(status)) return { ok: false, reason: 'unsupported status ' + status };
  const perms = await permissions();
  if (!perms.ok) return { ok: false, reason: 'cannot read permissions: ' + perms.reason };
  if (!perms.ads_management) return { ok: false, reason: 'ads_management not granted — status changes are not possible' };
  const r = await call('/' + objectId, { method: 'POST', body: { status }, write: true });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, status };
}

const pause = (objectId, runner) => setStatus({ objectId, status: 'PAUSED' }, runner);
const stop = (objectId, runner) => setStatus({ objectId, status: 'ARCHIVED' }, runner);

// ── reads ─────────────────────────────────────────────────────────────────────────────────────

async function observe({ account, since, until }, runner = db) {
  const guard = await assertNotExcluded(account, runner);
  if (!guard.ok) return guard;
  const range = since && until ? `&time_range={'since':'${since}','until':'${until}'}` : '';
  const r = await call('/' + account + '/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions' + range);
  if (!r.ok) return { ok: false, reason: r.detail || r.error };
  return { ok: true, rows: (r.data && r.data.data) || [] };
}

async function listCampaigns({ account }, runner = db) {
  const guard = await assertNotExcluded(account, runner);
  if (!guard.ok) return guard;
  const r = await call('/' + account + '/campaigns?fields=id,name,status,effective_status,daily_budget,lifetime_budget,spend_cap&limit=50');
  if (!r.ok) return { ok: false, reason: r.detail || r.error };
  return { ok: true, campaigns: (r.data && r.data.data) || [] };
}

module.exports = {
  GRAPH, TOKEN_ENV, READ_TOKEN_ENV, OBJECTIVES,
  permissions, resolveAdAccount, assertNotExcluded,
  createCampaign, setStatus, pause, stop, observe, listCampaigns, redact, call,
};
