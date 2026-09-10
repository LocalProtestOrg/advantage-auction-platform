'use strict';

/**
 * googleConversionsService — Google Ads offline/enhanced conversion SOFTWARE FOUNDATION (Phase 3P.2). Not activated.
 *
 *   buildUpload(conversion, click) → the ClickConversion Google Ads would receive for a first-party conversion:
 *                                    conversion_action (Owner-mapped resource name per conversion key — never invented),
 *                                    the captured gclid / gbraid / wbraid (exactly one), conversion_date_time,
 *                                    order_id = the first-party conversion id (dedup), value/currency where defined.
 *   decide(ctx)                    → GATED_OFF (marketing.measurement.google_conversions_enabled) · NOT_CONFIGURED /
 *                                    identity failures (customer id + identity record; never a client's account) ·
 *                                    NO_ACTION_MAPPING · NO_CLICK_ID · NO_CONSENT · READY.
 * There is no network call in this module: the Google Ads API upload is wired only after the Owner connects an
 * account (OAuth + developer token are provider-side Owner actions). Until then the ledger records the decision.
 */
const defs = require('../../lib/conversionDefinitions');
const guard = require('./assetIdentityGuard');

const CLICK_TYPES = ['gclid', 'gbraid', 'wbraid'];
const CLICK_WINDOW_DAYS = 90;

function fmtTime(d) {
  // Google Ads format: yyyy-mm-dd hh:mm:ss+00:00
  const x = new Date(d || Date.now()); const p = (n) => String(n).padStart(2, '0');
  return x.getUTCFullYear() + '-' + p(x.getUTCMonth() + 1) + '-' + p(x.getUTCDate()) + ' ' + p(x.getUTCHours()) + ':' + p(x.getUTCMinutes()) + ':' + p(x.getUTCSeconds()) + '+00:00';
}

function buildUpload(conversion, click, actions = {}) {
  const def = defs.get(conversion.conversion_key);
  if (!def || !def.google_action) return null;
  const action = actions[conversion.conversion_key];
  if (!click || !CLICK_TYPES.includes(click.click_type)) return null;
  const up = { conversion_action: action || null, conversion_date_time: fmtTime(conversion.occurred_at), order_id: String(conversion.id) };
  up[click.click_type] = click.click_value;
  if (def.value && conversion.value_cents != null) { up.conversion_value = Number(conversion.value_cents) / 100; up.currency_code = conversion.currency || 'USD'; }
  return up;
}

function decide({ cfg = {}, conversionKey, click = null, advertisingConsent = false } = {}) {
  if (cfg.enabled !== true) return { status: 'gated_off', reason: 'Owner gate marketing.measurement.google_conversions_enabled is OFF' };
  const id = guard.check('google_ads_customer', cfg.customerId, cfg.identity);
  if (!id.ok) return { status: id.reason === 'NOT_CONFIGURED' ? 'not_configured' : 'identity_blocked', reason: id.reason + ': ' + id.detail };
  const action = (cfg.actions || {})[conversionKey];
  if (!guard.isRealId(action)) return { status: 'no_action_mapping', reason: 'no Owner-mapped conversion action for ' + conversionKey };
  if (!click) return { status: 'no_click_id', reason: 'no gclid/gbraid/wbraid within ' + CLICK_WINDOW_DAYS + ' days' };
  if (!advertisingConsent) return { status: 'no_consent', reason: 'advertising consent not granted' };
  return { status: 'ready' };
}

async function cfgGet(k) { try { return await require('../configService').get(null, k); } catch (_) { return null; } }
async function loadConfig() {
  const enabled = await cfgGet('marketing.measurement.google_conversions_enabled');
  return { enabled: enabled === true || enabled === 'true', customerId: await cfgGet('marketing.measurement.google_ads_customer_id'),
    identity: await cfgGet('marketing.measurement.google_ads_customer_identity'), actions: (await cfgGet('marketing.measurement.google_conversion_actions')) || {} };
}

/** The most recent Google click id for a user/visitor inside the click window (raw values stay server-side). */
async function latestClick({ userId = null, visitorId = null } = {}, runner) {
  const r = runner || require('../../db');
  const q = await r.query(
    `SELECT click_type, click_value, first_seen_at FROM marketing_click_ids
      WHERE click_type = ANY($1) AND ((($2)::uuid IS NOT NULL AND user_id = $2) OR (($3)::text IS NOT NULL AND scope_id = $3))
        AND last_seen_at > now() - ($4 || ' days')::interval
      ORDER BY last_seen_at DESC LIMIT 1`, [CLICK_TYPES, userId, visitorId, String(CLICK_WINDOW_DAYS)]);
  return q.rows[0] || null;
}

module.exports = { buildUpload, decide, loadConfig, latestClick, fmtTime, CLICK_TYPES, CLICK_WINDOW_DAYS };
