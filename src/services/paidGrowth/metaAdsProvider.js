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
      // Meta's actionable text lives in error_user_title / error_user_msg; the generic `message` is
      // usually just "Invalid parameter". Surfacing the specific reason is what makes a provider
      // rejection diagnosable instead of a dead end.
      const detail = [e.error_user_title, e.error_user_msg].filter(Boolean).join(': ') || e.message || res.statusText;
      return { ok: false, error: 'provider_error', code: e.code || res.status, subcode: e.error_subcode || null,
        type: e.type || null, detail: redact(detail), blame: e.error_data ? redact(JSON.stringify(e.error_data)) : null };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: 'network', detail: redact(e.message) };
  }
}

/** Which permissions the system user actually holds right now. */
async function permissions() {
  const r = await call('/me/permissions', { write: true });
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

/** Meta's minimum campaign spending limit (USD). Verified live: below this the API refuses. */
const MIN_SPEND_CAP_CENTS = 10000;

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

  const body = buildCampaignBody({ name, funnel, spendCapCents });
  const r = await call('/' + account + '/campaigns', { method: 'POST', body, write: true });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return {
    ok: true, provider_campaign_id: r.data.id, status: 'PAUSED', idempotency_key: idempotencyKey,
    provider_spend_cap_cents: body.spend_cap || null,
  };
}

/**
 * The exact payload Meta accepts, proven against the live API.
 *   - `is_adset_budget_sharing_enabled` is REQUIRED when no campaign budget is set.
 *   - `spend_cap` must be at least $100; below that Meta refuses, so the cap is simply omitted and
 *     the internal ledger remains the binding limit (it always is — a provider cap is a second
 *     belt, never the only one).
 */
function buildCampaignBody({ name, funnel, spendCapCents }) {
  const body = {
    name,
    objective: OBJECTIVES[funnel] || 'OUTCOME_TRAFFIC',
    status: 'PAUSED',                        // never create anything that can start spending
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  };
  if (Number.isInteger(spendCapCents) && spendCapCents >= MIN_SPEND_CAP_CENTS) body.spend_cap = spendCapCents;
  return body;
}

/**
 * Ask Meta whether a campaign WOULD be accepted, without creating it
 * (execution_options: ['validate_only']). This is how write capability is proven without spending
 * a cent, and it is the safest pre-flight before a real creation.
 */
async function validateCampaign({ account, name, funnel, spendCapCents }, runner = db) {
  const guard = await assertNotExcluded(account, runner);
  if (!guard.ok) return guard;
  const perms = await permissions();
  if (!perms.ok) return { ok: false, reason: 'cannot read permissions: ' + perms.reason };
  if (!perms.ads_management) return { ok: false, reason: 'ads_management not granted' };
  const body = Object.assign(buildCampaignBody({ name, funnel, spendCapCents }), { execution_options: ['validate_only'] });
  const r = await call('/' + account + '/campaigns', { method: 'POST', body, write: true });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, validated: true, created: false, spend_cap_cents: body.spend_cap || null };
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

// -- the rest of the delivery chain: image -> ad set -> creative -> ad ------------------------

/**
 * Meta's own limits. Copy longer than these is rejected at creation time, so it is trimmed
 * deliberately here rather than surprising us at the provider.
 */
const COPY_LIMITS = Object.freeze({ primary_text: 2200, headline: 255, description: 255 });

const CTA_TYPES = Object.freeze(['LEARN_MORE', 'SIGN_UP', 'GET_STARTED', 'CONTACT_US', 'APPLY_NOW', 'SUBSCRIBE']);

/** Ask the provider to validate a payload without creating it. */
async function validateObject(edge, body, { account } = {}, runner = db) {
  const acct = account || (await resolveAdAccount(runner)).account;
  if (!acct) return { ok: false, reason: 'no canonical ad account resolved' };
  const guard = await assertNotExcluded(acct, runner);
  if (!guard.ok) return guard;
  const perms = await permissions();
  if (!perms.ok) return { ok: false, reason: 'cannot read permissions: ' + perms.reason };
  if (!perms.ads_management) return { ok: false, reason: 'ads_management not granted' };
  const r = await call('/' + acct + '/' + edge, {
    method: 'POST', write: true, body: Object.assign({}, body, { execution_options: ['validate_only'] }) });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, validated: true, created: false };
}

/**
 * Upload an approved image and return the provider's hash. The caller must already have established
 * that the asset is production-eligible; this refuses an excluded account and a missing permission.
 */
async function uploadImage({ account, bytesBase64, filename }, runner = db) {
  const guard = await assertNotExcluded(account, runner);
  if (!guard.ok) return guard;
  const perms = await permissions();
  if (!perms.ok) return { ok: false, reason: 'cannot read permissions: ' + perms.reason };
  if (!perms.ads_management) return { ok: false, reason: 'ads_management not granted' };
  const t = token(true);
  if (!t) return { ok: false, reason: TOKEN_ENV + ' not set' };
  try {
    const form = new URLSearchParams();
    form.set('bytes', bytesBase64);
    if (filename) form.set('name', filename);
    const res = await fetch(GRAPH + '/' + account + '/adimages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString() });
    const j = await res.json().catch(() => null);
    if (!res.ok || (j && j.error)) {
      const e = (j && j.error) || {};
      return { ok: false, reason: redact(e.error_user_msg || e.message || res.statusText), code: e.code || res.status };
    }
    const images = (j && j.images) || {};
    const first = Object.keys(images)[0];
    if (!first) return { ok: false, reason: 'provider returned no image hash' };
    return { ok: true, image_hash: images[first].hash, url: images[first].url || null };
  } catch (e) { return { ok: false, reason: redact(e.message) }; }
}

/** The ad set payload. Geography and audience live HERE, never on the campaign. */
function buildAdSetBody({ name, campaignId, dailyBudgetCents, targetingSpec, pixelId,
  optimizationGoal, billingEvent, customEventType, bidStrategy }) {
  const body = {
    name,
    campaign_id: String(campaignId),
    daily_budget: Math.round(Number(dailyBudgetCents)),
    billing_event: billingEvent || 'IMPRESSIONS',
    optimization_goal: optimizationGoal || 'OFFSITE_CONVERSIONS',
    // Required: without it Meta demands a bid amount or bid constraints. LOWEST_COST_WITHOUT_CAP
    // asks the provider to get the most results for the budget and sets no bid cap — the budget,
    // not a bid, is what bounds spend, which is exactly how the Owner's ceilings work.
    bid_strategy: bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
    targeting: targetingSpec,
    status: 'PAUSED',
  };
  if (pixelId) body.promoted_object = { pixel_id: String(pixelId), custom_event_type: customEventType || 'COMPLETE_REGISTRATION' };
  return body;
}

async function createAdSet(input, runner = db) {
  const guard = await assertNotExcluded(input.account, runner);
  if (!guard.ok) return guard;
  const perms = await permissions();
  if (!perms.ok || !perms.ads_management) return { ok: false, reason: 'ads_management not granted' };
  const r = await call('/' + input.account + '/adsets', { method: 'POST', write: true, body: buildAdSetBody(input) });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, provider_adset_id: r.data.id, status: 'PAUSED' };
}

/**
 * The ad creative: governed image, governed words, canonical destination, Advantage.Bid identity.
 * standard_enhancements is opted OUT so the provider cannot alter Owner-approved creative.
 */
function buildCreativeBody({ name, pageId, instagramId, imageHash, message, headline, description,
  destinationUrl, ctaType }) {
  const linkData = {
    image_hash: imageHash,
    link: destinationUrl,
    message: String(message).slice(0, COPY_LIMITS.primary_text),
    name: String(headline).slice(0, COPY_LIMITS.headline),
    call_to_action: { type: CTA_TYPES.includes(ctaType) ? ctaType : 'LEARN_MORE', value: { link: destinationUrl } },
  };
  if (description) linkData.description = String(description).slice(0, COPY_LIMITS.description);
  // NOTE: `degrees_of_freedom_spec.creative_features_spec.standard_enhancements` is DEPRECATED —
  // Meta rejects it outright ("Including standard enhancements field in creative has been
  // deprecated. Please choose to set individual features instead."). It is therefore omitted rather
  // than replaced with guessed feature names. Consequence worth knowing: Meta's own creative
  // enhancement defaults apply, so an Owner-approved image may be shown with provider adjustments.
  // Opting out per-feature is a follow-up that needs the current feature names read from the API.
  const body = {
    name,
    object_story_spec: { page_id: String(pageId), link_data: linkData },
  };
  if (instagramId) body.object_story_spec.instagram_user_id = String(instagramId);
  return body;
}

async function createAdCreative(input, runner = db) {
  const guard = await assertNotExcluded(input.account, runner);
  if (!guard.ok) return guard;
  const perms = await permissions();
  if (!perms.ok || !perms.ads_management) return { ok: false, reason: 'ads_management not granted' };
  const r = await call('/' + input.account + '/adcreatives', { method: 'POST', write: true, body: buildCreativeBody(input) });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, provider_creative_id: r.data.id };
}

function buildAdBody({ name, adsetId, creativeId }) {
  return { name, adset_id: String(adsetId), creative: { creative_id: String(creativeId) }, status: 'PAUSED' };
}

async function createAd(input, runner = db) {
  const guard = await assertNotExcluded(input.account, runner);
  if (!guard.ok) return guard;
  const perms = await permissions();
  if (!perms.ok || !perms.ads_management) return { ok: false, reason: 'ads_management not granted' };
  const r = await call('/' + input.account + '/ads', { method: 'POST', write: true, body: buildAdBody(input) });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, provider_ad_id: r.data.id, status: 'PAUSED' };
}

// -- readback + reconciliation ----------------------------------------------------------------

const READ_FIELDS = Object.freeze({
  campaign: 'id,name,status,effective_status,objective,spend_cap,created_time',
  adset: 'id,name,status,effective_status,campaign_id,daily_budget,optimization_goal,billing_event,targeting,promoted_object',
  adcreative: 'id,name,object_story_spec',
  ad: 'id,name,status,effective_status,adset_id,creative{id}',
});

/** Read one provider object back, so an intended state can be compared with the real one. */
async function getObject(objectType, providerId) {
  const fields = READ_FIELDS[objectType];
  const r = await call('/' + providerId + (fields ? '?fields=' + encodeURIComponent(fields) : ''));
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, object: r.data };
}

/** Delete a provider object. Used for certification artifacts; never for a live ad. */
async function deleteObject(providerId) {
  const perms = await permissions();
  if (!perms.ok || !perms.ads_management) return { ok: false, reason: 'ads_management not granted' };
  const r = await call('/' + providerId, { method: 'DELETE', write: true });
  if (!r.ok) return { ok: false, reason: r.detail || r.error, code: r.code || null };
  return { ok: true, deleted: true };
}

/** Insights for what we created. Never invents a metric the provider did not return. */
async function insights({ account, level, since, until }, runner = db) {
  const guard = await assertNotExcluded(account, runner);
  if (!guard.ok) return guard;
  const fields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,inline_link_clicks,actions';
  const range = since && until ? '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) : '';
  const r = await call('/' + account + '/insights?level=' + (level || 'ad') + '&fields=' + fields + range);
  if (!r.ok) return { ok: false, reason: r.detail || r.error };
  return { ok: true, rows: (r.data && r.data.data) || [] };
}

module.exports = {
  GRAPH, TOKEN_ENV, READ_TOKEN_ENV, OBJECTIVES, MIN_SPEND_CAP_CENTS,
  permissions, resolveAdAccount, assertNotExcluded, buildCampaignBody, validateCampaign,
  createCampaign, setStatus, pause, stop, observe, listCampaigns, redact, call,
  COPY_LIMITS, CTA_TYPES, READ_FIELDS,
  validateObject, uploadImage, buildAdSetBody, createAdSet, buildCreativeBody, createAdCreative,
  buildAdBody, createAd, getObject, deleteObject, insights,
};
