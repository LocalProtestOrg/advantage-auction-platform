'use strict';

/**
 * socialReadinessService — A9 / Meta organic-publishing readiness, evaluated PER DESTINATION and independently,
 * so one broken state Page never marks every other market unready. It reports the authorization gates
 * (marketing.a9_publish_enabled, marketing.destinations.meta_enabled) separately from per-destination
 * configuration (provider account ID present, token env var present, IG→Page link present) and an overall
 * derived status. It never exposes a token — only a boolean of whether the referenced env var is present.
 */

const db = require('../db');
const marketingConfig = require('./marketingConfigService');
const destinations = require('./socialDestinationService');

// Evaluate ONE destination's configuration completeness (independent of the global gates).
function evaluateDestination(dest) {
  const checks = {};
  const set = (k, ok, detail) => { checks[k] = { status: ok ? 'PASS' : 'FAIL', detail: detail || null }; };
  set('account_id', !!dest.provider_account_id,
    dest.platform === 'instagram' ? 'Instagram Business Account ID' : 'Facebook Page ID');
  const credName = dest.credential_ref || null;
  set('credential', !!(credName && process.env[credName]), credName ? `env ${credName}` : 'no credential_ref');
  if (dest.platform === 'instagram') set('linked_page', !!dest.linked_facebook_page_id, 'IG must publish through a linked FB Page');
  set('active_flag', !!dest.active, dest.active ? 'active' : 'inactive (admin toggle)');
  const configured = checks.account_id.status === 'PASS' && checks.credential.status === 'PASS'
    && (dest.platform !== 'instagram' || checks.linked_page.status === 'PASS');
  // Derived per-destination status (independent of the global publish gates).
  const status = !configured ? (checks.account_id.status === 'FAIL' && checks.credential.status === 'FAIL' ? 'not_configured' : 'incomplete')
    : (dest.active ? 'ready' : 'incomplete');
  return { status, configured, checks };
}

/**
 * Full readiness snapshot: the two global gates + every destination evaluated independently. Persists each
 * destination's derived readiness_status so the resolver and Admin stay consistent. No secrets returned.
 */
async function evaluate(runner) {
  const r = runner || db;
  const a9 = await marketingConfig.getBool('marketing.a9_publish_enabled', false);
  const metaEnabled = await marketingConfig.getBool('marketing.destinations.meta_enabled', false);
  const rows = await destinations.list(r);
  const dests = [];
  for (const d of rows) {
    const ev = evaluateDestination(d);
    // Preserve the admin Verify result (identity_check) across re-evaluation: the derived checks are
    // recomputed every time, but the last provider identity lookup is a durable fact, not a derived check.
    const prior = (d.readiness_detail && typeof d.readiness_detail === 'object') ? d.readiness_detail : {};
    const detail = prior.identity_check ? { ...ev.checks, identity_check: prior.identity_check } : { ...ev.checks };
    if (ev.status !== d.readiness_status) await destinations.setReadiness(d.id, ev.status, detail, r).catch(() => {});
    dests.push({ ...destinations.toAdminView({ ...d, readiness_status: ev.status, readiness_detail: detail }), evaluation: ev.checks });
  }
  const anyReadyNational = dests.some((d) => d.scope === 'national' && d.readiness_status === 'ready');
  return {
    gates: {
      a9_publish_enabled: a9,                       // publish authorization (OFF)
      meta_provider_enabled: metaEnabled,           // Meta provider authorization (OFF)
      publish_authorized: a9 && metaEnabled,        // BOTH required to publish
    },
    can_publish_when_authorized: anyReadyNational,  // is at least the national destination ready to go live?
    destinations: dests,
    note: 'READY per destination = configured + active. Publishing additionally requires BOTH global gates ON (A9 + Meta). Gates are OFF.',
  };
}

module.exports = { evaluate, evaluateDestination };
