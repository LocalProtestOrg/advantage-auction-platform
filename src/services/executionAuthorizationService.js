'use strict';

/**
 * executionAuthorizationService — the ONE authoritative gate that decides whether a marketing action may
 * execute. Production DECIDES; Desktop/agents may only REASON. Returns { authorized, reasons } with
 * machine-readable reasons. This gate will eventually front email/Google/Meta/onsite; in Phase 4G ONLY
 * onsite may be AUTHORIZED — email (A7), Google, and Meta are hard-refused via config.
 */
const db = require('../db');
const marketingConfig = require('./marketingConfigService');
const consentService = require('./consentService');

// Which channel a config flag gates. onsite has its own flag; the rest reuse existing gates (all false).
async function channelEnabled(channel) {
  if (channel === 'onsite') return marketingConfig.getBool('marketing.onsite.enabled', false);
  if (channel === 'a7_email' || channel === 'email') return marketingConfig.getBool('marketing.a7_send_enabled', false);
  if (channel === 'google_ads') return marketingConfig.getBool('marketing.destinations.google_ads_enabled', false);
  if (channel === 'meta') return marketingConfig.getBool('marketing.destinations.meta_enabled', false);
  return false;
}

// Consent category a channel requires.
function requiredConsent(channel) {
  if (channel === 'onsite') return 'personalization';
  if (channel === 'google_ads' || channel === 'meta') return 'advertising';
  return null;   // email uses permission_basis (Phase 4C), not banner consent
}

/**
 * @param {object} opts { channel, campaignClass, audienceKey, decisionId, scopeType, scopeId, pagePath,
 *   qaPassed, collision, consentState, runner }
 * @returns {object} { authorized:boolean, reasons:string[] }
 */
async function authorize(opts = {}, runner) {
  const r = runner || db;
  const reasons = [];
  const channel = opts.channel;

  // 1. Channel must be enabled (hard gate). Only onsite is enabled this phase.
  if (!(await channelEnabled(channel))) reasons.push('channel_disabled:' + channel);

  // 2. A decision record must exist for consequential actions.
  if (opts.decisionId) {
    const d = await r.query('SELECT 1 FROM marketing_decisions WHERE id = $1', [opts.decisionId]);
    if (!d.rowCount) reasons.push('no_decision_record');
  } else if (opts.requireDecision) {
    reasons.push('no_decision_record');
  }

  // 3. Consent (channel-appropriate). External retargeting requires advertising consent; onsite requires
  //    personalization consent when a specific visitor is targeted.
  const need = requiredConsent(channel);
  if (need) {
    let granted = false;
    if (opts.consentState && typeof opts.consentState === 'object') granted = opts.consentState[need] === true;
    else if (opts.scopeId) { const cur = await consentService.current(opts.scopeType || 'visitor', opts.scopeId, r); granted = consentService.allows(cur[need]); }
    if (!granted) reasons.push('consent_missing:' + need);
  }

  // 4. QA must have passed for a targeted send/treatment.
  if (opts.qaPassed === false) reasons.push('qa_failed');

  // 5. Collision: a provided collision result must not have blocked this action.
  if (opts.collision && opts.collision.blocked && opts.actionId
      && opts.collision.blocked.some((b) => b.id === opts.actionId)) {
    reasons.push('collision_blocked');
  }

  return { authorized: reasons.length === 0, reasons };
}

module.exports = { authorize, channelEnabled, requiredConsent };
