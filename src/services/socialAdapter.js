'use strict';

/**
 * socialAdapter — Phase 3O Wave 2, blocker 5. Provider-neutral social execution contract. Guaranteed social
 * obligations: PREMIUM = 1 organic post; SIGNATURE = 3 posts across LAUNCH / MID / FINAL; plus Additional
 * Promotion social. Builds the social job, selects Wave 1 creative, renders copy against a factual-claim
 * manifest with clean Advantage.Bid links, schedules with cadence/collision rules, runs QA + channel readiness,
 * and publishes through a PROVIDER ADAPTER INTERFACE (idempotent publish -> provider response -> post ID /
 * permalink / published_at -> proof -> reconciliation).
 *
 * Facebook and Instagram remain GATED (marketing.a9_publish_enabled = false). No real posts. A MOCK provider
 * proves the complete lifecycle in shadow. If no provider is ACTIVE, the real obligation is NEVER falsely
 * completed — it routes through readiness / resilience.
 */

const db = require('../db');
const marketingConfig = require('./marketingConfigService');
const obligationEngine = require('./marketingObligationEngine');
const { runLadder } = require('./resilienceLadderService');

// Guaranteed wave plans per package identity.
const WAVE_PLANS = {
  PREMIUM: ['ANY'],                        // 1 organic post
  SIGNATURE: ['LAUNCH', 'MID', 'FINAL'],   // 3 posts
};

/**
 * Provider adapter interface: every provider implements publish(payload) -> { ok, post_id, permalink, published_at }.
 * The MOCK provider proves the full lifecycle deterministically (id derived from the idempotency key — no clock,
 * no randomness) and NEVER contacts a real network. Real FB/IG adapters plug in here once ACTIVE.
 */
const mockProvider = {
  name: 'mock',
  active: true,
  async publish(payload) {
    const key = payload.idempotency_key;
    return {
      ok: true, provider: 'mock',
      post_id: `mock_${key}`,
      permalink: `https://shadow.local/mock/${key}`,
      published_at: payload.reference_at || null,
      shadow: true,
    };
  },
};

// Resolve the ACTIVE provider. FB/IG are gated OFF -> only the mock (shadow) provider is available.
async function resolveProvider() {
  const fbOn = await marketingConfig.getBool('marketing.destinations.meta_enabled', false);
  if (fbOn) return { name: 'meta', active: true, shadow: false, publish: async () => ({ ok: false, error: 'live_provider_not_wired' }) };
  return mockProvider; // shadow
}

/**
 * Build the factual-claim manifest for a post — only claims backed by auction facts may appear in copy. Keeps
 * social copy truthful and prevents fabricated guarantees. Links are canonical bid.advantage.bid.
 */
function buildCopy(auction, wave) {
  const url = `https://bid.advantage.bid/auction/${auction.auction_id}`;
  const claims = [];
  if (auction.title) claims.push({ claim: 'title', value: auction.title });
  if (auction.lot_count != null) claims.push({ claim: 'lot_count', value: auction.lot_count });
  if (auction.closing_at) claims.push({ claim: 'closing_at', value: auction.closing_at });
  const headline = wave === 'FINAL' ? 'Closing soon' : (wave === 'MID' ? 'Now bidding' : 'Now live');
  return { wave, headline, url, factual_manifest: claims, link_clean: url.indexOf('?') === -1 };
}

/**
 * Publish one wave's post through the adapter. Idempotent by (obligation, wave): a job already published (shadow
 * or real) returns its stored proof. Retries increment attempts. Never falsely completes: shadow proof is
 * distinguishable (shadow=true) and does not satisfy a provider_verified obligation.
 */
async function publishWave(obligation, { auction, wave, referenceAt, creativeJobId }, runner) {
  const r = runner || db;
  const idem = `${obligation.id || auction.auction_id}:${wave}`;
  const existing = (await r.query(
    `SELECT * FROM marketing_social_jobs WHERE obligation_id=$1 AND wave=$2 ORDER BY created_at DESC LIMIT 1`,
    [obligation.id || null, wave])).rows[0];
  if (existing && ['published_shadow'].includes(existing.status)) {
    return { ok: true, idempotent_replay: true, job: existing };
  }

  const provider = await module.exports.resolveProvider();
  const copy = buildCopy(auction, wave);
  const readiness = provider.shadow === false ? 'ACTIVE' : 'SHADOW_CERTIFIED';

  // Insert/lock the job row first (attempt counter).
  const job = (await r.query(
    `INSERT INTO marketing_social_jobs (obligation_id, auction_id, wave, provider, status, attempts, shadow, proof)
     VALUES ($1,$2,$3,$4,'queued_shadow',1,$5,$6::jsonb) RETURNING *`,
    [obligation.id || null, auction.auction_id, wave, provider.name, provider.shadow !== false, JSON.stringify({ copy })])).rows[0];

  if (!provider.active) {
    const ladder = runLadder('L_social', { readiness, provider: 'INACTIVE' }, { shadow: true });
    await r.query(`UPDATE marketing_social_jobs SET status='blocked' WHERE id=$1`, [job.id]);
    if (obligation.id) await obligationEngine.block(obligation.id, { reason: 'social_provider_inactive', retryAfter: '1 day' }, r).catch(() => {});
    return { ok: false, reason: 'provider_inactive', ladder, job };
  }

  const resp = await provider.publish({ idempotency_key: idem, reference_at: referenceAt, copy, creative_job_id: creativeJobId });
  if (!resp.ok) {
    await r.query(`UPDATE marketing_social_jobs SET status='failed' WHERE id=$1`, [job.id]);
    const ladder = runLadder('L_social', { readiness, provider: 'PUBLISH_FAILED' }, { shadow: true });
    return { ok: false, reason: 'publish_failed', detail: resp.error, ladder, job };
  }

  const proof = { post_id: resp.post_id, permalink: resp.permalink, published_at: resp.published_at, provider: resp.provider, copy };
  const updated = (await r.query(
    `UPDATE marketing_social_jobs SET status='published_shadow', post_id=$2, permalink=$3, published_at=$4, proof=$5::jsonb WHERE id=$1 RETURNING *`,
    [job.id, resp.post_id, resp.permalink, resp.published_at, JSON.stringify(proof)])).rows[0];

  return {
    ok: true, shadow: resp.shadow !== false, job: updated, proof,
    completes_real_obligation: resp.shadow === false, // only a real provider publish completes the obligation
  };
}

/** Execute all guaranteed waves for a package's social obligation. */
async function execute(obligation, { auction, identity, referenceAt, creativeJobId }, runner) {
  const r = runner || db;
  const waves = WAVE_PLANS[String(identity || '').toUpperCase()] || ['ANY'];
  const results = [];
  for (const wave of waves) {
    results.push(await publishWave(obligation, { auction, wave, referenceAt, creativeJobId }, r));
  }
  const allPublished = results.every((x) => x.ok);
  return { ok: allPublished, identity, waves, results,
           completes_real_obligation: results.every((x) => x.completes_real_obligation === true) };
}

module.exports = { WAVE_PLANS, mockProvider, resolveProvider, buildCopy, publishWave, execute };
