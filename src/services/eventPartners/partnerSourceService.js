'use strict';

/**
 * partnerSourceService — programmatic create/inspect/update/pause/resume/disable for PER-COMPANY
 * import sources, replacing the script-only, hardcoded-owner path (scripts/seed-connectors.js pins the
 * platform tenant UUID and its UPDATE branch never changes owner_organization_id).
 *
 * The central correctness point: a partner source sets `owner_organization_id` to THE COMPANY'S
 * organization, so every event it creates is owned by that company rather than by the platform tenant
 * (eventImport/index.js reads owner_organization_id → writer writes events.organization_id). The host
 * attribution is recorded separately on events.host_organization_id by hostAttributionService.
 *
 * Safety model — a source moves through three gates, and NOTHING collects until all three pass:
 *   1. AUTHORIZED   — a live authorized_event_sources row in an authorized state. No authorization,
 *                     no source. Creation is refused outright.
 *   2. VALIDATED    — the explicit safety checklist below (domain match, terms, robots, attribution,
 *                     media policy, publication policy). Recorded with who attested and when.
 *   3. GATE ON      — the Owner's platform gate event_partners.collection_enabled. Until it is true,
 *                     activate() refuses, so deploying this code collects nothing.
 *
 * Sources are created 'draft' and can only ever reach 'active' through activate(). Revocation
 * disables the source (authorizationService.revoke), and a disabled partner source is never revived
 * here — the company must authorize again.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const configService = require('../configService');
const authorization = require('./authorizationService');
const { getConnector } = require('../eventImport/connectors');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}

const q = (client) => (client || db);

// Connectors a partner source may use. A partner publishes its own feed; it never gets the
// government/aggregator connectors, and never a bespoke scraper.
const ALLOWED_CONNECTORS = Object.freeze(['feed']);
const ALLOWED_KINDS = Object.freeze(['rss', 'json', 'xml', 'partner']);

// Conservative defaults for a company we have just met. Deliberately far below the platform caps.
const DEFAULTS = Object.freeze({
  weekly_cap: 25,
  max_images_per_event: 40,
  rate_limit_per_min: 30,
  media_policy: 'link_only',   // never 'mirror' — we link to the company's images, we do not re-host
  auto_publish: false,         // the publication gate (real image, host identified) stays in charge
});

/** Stable, readable source key for a company: partner-<org-slug>[-n]. Unique in import_sources.key. */
async function buildSourceKey(client, orgSlug) {
  const base = 'partner-' + String(orgSlug || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  let key = base;
  for (let i = 2; i <= 50; i++) {
    const hit = (await client.query('SELECT 1 FROM import_sources WHERE key = $1', [key])).rows[0];
    if (!hit) return key;
    key = base + '-' + i;
  }
  throw err(409, 'KEY_EXHAUSTED', 'Could not allocate a unique source key.');
}

/**
 * The safety checklist. Returns { ok, checks[], failures[] } — never throws — so an admin surface can
 * show exactly which condition is unmet. Every check is a hard requirement.
 *
 * Note on robots/terms: Phase 1 records an explicit human attestation (who checked, when, and the URL
 * of the terms that were read). It does NOT fetch the company's site — the mission forbids beginning
 * collection, and an unattested source can never be activated either way.
 */
function validateSourceConfig(input) {
  input = input || {};
  const checks = []; const failures = [];
  const add = (key, ok, detail) => { checks.push({ key, ok: !!ok, detail: detail || null }); if (!ok) failures.push(key); };

  const authorizedDomain = input.authorizedDomain || null;
  const feedUrl = input.feedUrl || null;
  const feedDomain = authorization.normalizeDomain(feedUrl);

  // The feed must live on the domain the company actually authorized. This is the check that stops a
  // source being quietly repointed at a site nobody granted permission for.
  add('feed_on_authorized_domain',
    !!(authorizedDomain && feedDomain && (feedDomain === authorizedDomain || feedDomain.endsWith('.' + authorizedDomain))),
    feedDomain ? `feed host ${feedDomain} vs authorized ${authorizedDomain}` : 'feed URL missing or unparseable');

  add('feed_url_https', !!(feedUrl && /^https:\/\//i.test(String(feedUrl))), 'the feed must be served over HTTPS');

  add('connector_allowed', ALLOWED_CONNECTORS.indexOf(input.connector) !== -1,
    `connector must be one of: ${ALLOWED_CONNECTORS.join(', ')}`);
  add('kind_allowed', ALLOWED_KINDS.indexOf(input.kind) !== -1,
    `kind must be one of: ${ALLOWED_KINDS.join(', ')}`);

  // Terms + robots attestation: a named person, a timestamp and the URL that was read.
  add('terms_attested', !!(input.termsAttestedBy && input.termsAttestedUrl),
    'record who reviewed the company terms and the URL reviewed');
  add('robots_attested', input.robotsChecked === true && !!input.robotsCheckedBy,
    'record that robots.txt permits retrieval of the feed path, and who checked');

  // Attribution: every imported event must credit the company and link back to it.
  add('attribution_present', !!(input.attributionName && input.attributionUrl),
    'an attribution name and URL are required for every imported event');

  // Media + publication policy. link_only keeps us off the company's image hosting; auto_publish false
  // keeps the existing publication gate (real image, identified host) in charge of what goes public.
  add('media_policy_safe', ['link_only', 'none'].indexOf(input.mediaPolicy || DEFAULTS.media_policy) !== -1,
    'media_policy must be link_only or none (mirroring requires separate Owner approval)');
  add('auto_publish_off', input.autoPublish !== true,
    'auto_publish must stay off so the real-image publication gate applies');

  return { ok: failures.length === 0, checks, failures };
}

/**
 * Create the per-company import source for an AUTHORIZED company. Always 'draft'; never collects.
 * Idempotent per authorization: a second call returns the existing source rather than creating a
 * duplicate, so a retried admin action cannot fragment a company across two sources.
 */
async function createForAuthorization(authorizationId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');

  return withTransaction(async (client) => {
    const auth = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (authorization.AUTHORIZED_STATES.indexOf(auth.status) === -1) {
      throw err(409, 'NOT_AUTHORIZED', `A source may only be created for an authorized company (status: ${auth.status}).`);
    }
    if (auth.import_source_id) {
      const existing = (await client.query('SELECT * FROM import_sources WHERE id = $1', [auth.import_source_id])).rows[0];
      if (existing) return { source: existing, authorization: auth, created: false };
    }

    const org = (await client.query('SELECT id, slug, name FROM organizations WHERE id = $1', [auth.organization_id])).rows[0];
    if (!org) throw err(404, 'ORG_NOT_FOUND', 'Organization not found.');

    const kind = input.kind || 'rss';
    const connector = input.connector || 'feed';
    // Fail fast on an unknown connector rather than writing a source that can never run.
    try { getConnector(kind, connector); } catch (e) { throw err(400, 'UNKNOWN_CONNECTOR', 'Unknown connector for this source.'); }

    const key = input.key ? String(input.key).trim() : await buildSourceKey(client, org.slug);
    const config = {
      connector,
      feeds: input.feedUrl ? [input.feedUrl] : [],
      attribution: { name: input.attributionName || auth.company_name, url: input.attributionUrl || auth.authorized_source_url || ('https://' + auth.authorized_domain) },
      event_partner: { authorization_id: auth.id, authorized_domain: auth.authorized_domain },
      defaults: input.defaults || {},
    };

    const { rows } = await client.query(
      `INSERT INTO import_sources
         (key, kind, name, status, config, owner_organization_id, weekly_cap, max_images_per_event,
          rate_limit_per_min, auto_publish, media_policy, terms_attested_by, terms_attested_at, terms_attested_url)
       VALUES ($1,$2,$3,'draft',$4::jsonb,$5,$6,$7,$8,false,$9,$10,$11,$12)
       RETURNING *`,
      [key, kind, (input.name || org.name || auth.company_name).slice(0, 120), JSON.stringify(config),
       auth.organization_id,
       input.weeklyCap != null ? input.weeklyCap : DEFAULTS.weekly_cap,
       DEFAULTS.max_images_per_event, DEFAULTS.rate_limit_per_min,
       input.mediaPolicy || DEFAULTS.media_policy,
       // The attestation timestamp is only meaningful when someone actually attested.
       input.termsAttestedBy || null, input.termsAttestedBy ? new Date() : null,
       input.termsAttestedUrl || null]);
    const source = rows[0];

    const updatedAuth = (await client.query(
      'UPDATE authorized_event_sources SET import_source_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [auth.id, source.id])).rows[0];

    await auditService.logEvent(client, {
      eventType: 'event_partner.source_created', entityType: 'authorized_event_source', entityId: auth.id,
      actorId: input.actorId,
      metadata: {
        source_id: source.id, source_key: key, kind, connector,
        owner_organization_id: auth.organization_id, status: 'draft',
      },
    });
    return { source, authorization: updatedAuth, created: true };
  });
}

/**
 * Run the safety checklist against a source and record the outcome on the authorization. On pass the
 * authorization advances to 'source_configured'; the source itself stays 'draft' until activate().
 */
async function validateSource(authorizationId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');

  return withTransaction(async (client) => {
    const auth = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (!auth.import_source_id) throw err(409, 'NO_SOURCE', 'Create the company source before validating it.');
    const source = (await client.query('SELECT * FROM import_sources WHERE id = $1', [auth.import_source_id])).rows[0];
    if (!source) throw err(404, 'SOURCE_NOT_FOUND', 'Import source not found.');

    const cfg = source.config || {};
    const result = validateSourceConfig({
      authorizedDomain: auth.authorized_domain,
      feedUrl: (cfg.feeds && cfg.feeds[0]) || null,
      connector: cfg.connector,
      kind: source.kind,
      termsAttestedBy: source.terms_attested_by,
      termsAttestedUrl: source.terms_attested_url,
      robotsChecked: input.robotsChecked === true,
      robotsCheckedBy: input.robotsCheckedBy || input.actorId,
      attributionName: cfg.attribution && cfg.attribution.name,
      attributionUrl: cfg.attribution && cfg.attribution.url,
      mediaPolicy: source.media_policy,
      autoPublish: source.auto_publish,
    });

    const validation = {
      ok: result.ok, checks: result.checks, failures: result.failures,
      validated_by: input.actorId, validated_at: new Date().toISOString(),
      robots_checked_by: input.robotsCheckedBy || input.actorId,
      notes: input.notes || null,
    };
    await client.query(
      `UPDATE authorized_event_sources
          SET source_validation = $2::jsonb, source_validated_at = CASE WHEN $3 THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1`, [authorizationId, JSON.stringify(validation), result.ok]);

    let updated = (await client.query('SELECT * FROM authorized_event_sources WHERE id = $1', [authorizationId])).rows[0];
    if (result.ok && authorization.canTransition(updated.status, 'source_configured')) {
      updated = await authorization.transition(client, updated, 'source_configured', input.actorId, { via: 'validation_passed' });
    }
    await auditService.logEvent(client, {
      eventType: 'event_partner.source_validated', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId, metadata: { ok: result.ok, failures: result.failures, source_id: source.id },
    });
    return { validation, authorization: updated, source };
  });
}

/**
 * Turn collection on. Requires: authorization in 'source_configured' (so validation passed) AND the
 * Owner's platform gate. This is the ONLY path that can set a partner source to 'active'.
 */
async function activate(authorizationId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const gate = await configService.get(null, 'event_partners.collection_enabled');
  if (gate !== true) throw err(409, 'COLLECTION_DISABLED', 'Event Partner collection is disabled by platform policy.');

  return withTransaction(async (client) => {
    const auth = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (!auth.import_source_id) throw err(409, 'NO_SOURCE', 'There is no source to activate.');
    if (auth.status !== 'source_configured' && auth.status !== 'paused') {
      throw err(409, 'NOT_VALIDATED', `The source must pass validation before collecting (status: ${auth.status}).`);
    }
    if (!auth.source_validated_at) throw err(409, 'NOT_VALIDATED', 'This source has not passed safety validation.');

    await client.query("UPDATE import_sources SET status = 'active', updated_at = now() WHERE id = $1", [auth.import_source_id]);
    const updated = await authorization.transition(client, auth, 'collecting', input.actorId, { via: 'activate', source_id: auth.import_source_id });
    await auditService.logEvent(client, {
      eventType: 'event_partner.collection_started', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId, metadata: { source_id: auth.import_source_id },
    });
    return updated;
  });
}

/** Halt collection without withdrawing permission. Reversible by resume(). */
async function pause(authorizationId, input) {
  input = input || {};
  return withTransaction(async (client) => {
    const auth = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (auth.import_source_id) {
      await client.query("UPDATE import_sources SET status = 'paused', updated_at = now() WHERE id = $1", [auth.import_source_id]);
    }
    const updated = await authorization.transition(client, auth, 'paused', input.actorId, { via: 'pause', reason: input.reason || null });
    await auditService.logEvent(client, {
      eventType: 'event_partner.paused', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId || null, metadata: { reason: input.reason || null, source_id: auth.import_source_id || null },
    });
    return updated;
  });
}

/** Resume a paused partner. Re-checks the platform gate — a pause is not a way around it. */
async function resume(authorizationId, input) {
  input = input || {};
  return withTransaction(async (client) => {
    const auth = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (auth.status !== 'paused') throw err(409, 'NOT_PAUSED', `This authorization is not paused (status: ${auth.status}).`);

    // With a validated source we may return to collecting, but only if the Owner gate is on; otherwise
    // the partner returns to 'source_configured' and the source stays paused.
    const gate = await configService.get(null, 'event_partners.collection_enabled');
    const target = (auth.source_validated_at && auth.import_source_id && gate === true) ? 'collecting' : 'source_configured';
    if (target === 'collecting') {
      await client.query("UPDATE import_sources SET status = 'active', updated_at = now() WHERE id = $1", [auth.import_source_id]);
    }
    const updated = await authorization.transition(client, auth, target, input.actorId, { via: 'resume', gate_enabled: gate === true });
    await auditService.logEvent(client, {
      eventType: 'event_partner.resumed', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId || null, metadata: { to: target, source_id: auth.import_source_id || null },
    });
    return updated;
  });
}

/** Inspect one partner source: the source row plus its validation state. Never exposes secrets. */
async function inspect(authorizationId, client) {
  const auth = await authorization.getById(authorizationId, client);
  if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
  let source = null;
  if (auth.import_source_id) {
    const { rows } = await q(client).query(
      // auth_env_var holds the NAME of an env var; the value is never read or returned here.
      `SELECT id, key, kind, name, status, config, owner_organization_id, weekly_cap, daily_cap,
              max_images_per_event, rate_limit_per_min, auto_publish, media_policy,
              terms_attested_by, terms_attested_at, terms_attested_url, created_at, updated_at
         FROM import_sources WHERE id = $1`, [auth.import_source_id]);
    source = rows[0] || null;
  }
  return { authorization: auth, source, validation: auth.source_validation || null };
}

/**
 * Update the mutable configuration of a partner source. owner_organization_id, key and kind are
 * immutable: changing who owns a source would silently re-own its events. Any change to the feed
 * clears the validation and returns the partner to 'authorized', so a repointed source must be
 * re-validated before it can collect again.
 */
async function updateSource(authorizationId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');

  return withTransaction(async (client) => {
    const auth = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (!auth.import_source_id) throw err(409, 'NO_SOURCE', 'There is no source to update.');
    const source = (await client.query('SELECT * FROM import_sources WHERE id = $1 FOR UPDATE', [auth.import_source_id])).rows[0];
    if (!source) throw err(404, 'SOURCE_NOT_FOUND', 'Import source not found.');

    const cfg = Object.assign({}, source.config || {});
    let feedChanged = false;
    if (input.feedUrl !== undefined) {
      const next = input.feedUrl ? [String(input.feedUrl)] : [];
      feedChanged = JSON.stringify(next) !== JSON.stringify(cfg.feeds || []);
      cfg.feeds = next;
    }
    if (input.attributionName || input.attributionUrl) {
      cfg.attribution = Object.assign({}, cfg.attribution, {
        name: input.attributionName || (cfg.attribution && cfg.attribution.name),
        url: input.attributionUrl || (cfg.attribution && cfg.attribution.url),
      });
    }

    const sets = ['config = $2::jsonb']; const vals = [source.id, JSON.stringify(cfg)];
    const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (input.name) push('name', String(input.name).slice(0, 120));
    if (input.weeklyCap != null) push('weekly_cap', Math.min(Math.max(parseInt(input.weeklyCap, 10) || 0, 0), 75));
    if (input.mediaPolicy) {
      if (['link_only', 'none'].indexOf(input.mediaPolicy) === -1) throw err(400, 'INVALID_MEDIA_POLICY', 'Mirroring requires separate Owner approval.');
      push('media_policy', input.mediaPolicy);
    }
    if (input.termsAttestedBy) { push('terms_attested_by', input.termsAttestedBy); sets.push('terms_attested_at = now()'); }
    if (input.termsAttestedUrl) push('terms_attested_url', input.termsAttestedUrl);

    const updatedSource = (await client.query(
      `UPDATE import_sources SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals)).rows[0];

    // A repointed feed invalidates the safety decision that was made about the old one.
    let updatedAuth = auth;
    if (feedChanged) {
      await client.query(
        `UPDATE authorized_event_sources SET source_validated_at = NULL, source_validation = '{}'::jsonb, updated_at = now()
          WHERE id = $1`, [authorizationId]);
      await client.query("UPDATE import_sources SET status = 'draft', updated_at = now() WHERE id = $1", [source.id]);
      const fresh = (await client.query('SELECT * FROM authorized_event_sources WHERE id = $1', [authorizationId])).rows[0];
      updatedAuth = authorization.canTransition(fresh.status, 'authorized')
        ? await authorization.transition(client, fresh, 'authorized', input.actorId, { via: 'feed_changed_revalidation_required' })
        : fresh;
    }
    await auditService.logEvent(client, {
      eventType: 'event_partner.source_updated', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId, metadata: { source_id: source.id, feed_changed: feedChanged },
    });
    return { source: updatedSource, authorization: updatedAuth, revalidationRequired: feedChanged };
  });
}

module.exports = {
  ALLOWED_CONNECTORS, ALLOWED_KINDS, DEFAULTS,
  validateSourceConfig, createForAuthorization, validateSource, activate,
  pause, resume, inspect, updateSource, buildSourceKey,
};
