'use strict';

/**
 * marketingSeoService — A9 SEO/Content proving ground. Runs the agency loop on the cheapest, most
 * reversible channel to prove: Creator (A9) → independent QA (A2) → release decision → measurement — WITHOUT
 * publishing. Publication stays disabled (marketing.a9_publish_enabled=false); the loop can only reach a
 * "release_ready_draft" state, never live output. No junk public articles are created.
 */
const agents = require('../constants/marketingAgents');
const qa = require('./marketingQaService');
const cta = require('./marketingCtaService');
const marketingConfig = require('./marketingConfigService');

/**
 * Run the proving loop for a candidate content asset.
 * @param {object} p { topic, audience, intent, evidence[], sourceFields{}, draftText, claims[],
 *                      primaryCtaKey, secondaryCtaKey, exemptReason, producerAgent='A9', runner }
 * @returns {object} the loop result (state, review, cta, measurement) — never published.
 */
async function runProvingLoop(p = {}, runner) {
  const producer = String(p.producerAgent || 'A9').toUpperCase();
  if (!agents.agentCan(producer, 'draft_content')) {
    const e = new Error('Agent ' + producer + ' cannot draft content.'); e.code = 'FORBIDDEN'; throw e;
  }
  // Full-Circle CTA (must be route-verified + clean, or an explicit exemption).
  const ccArgs = { primaryKey: p.primaryCtaKey, secondaryKey: p.secondaryCtaKey || null, exemptReason: p.exemptReason || null };
  const cc = await cta.assignCtas(ccArgs, runner);

  // Independent A2 QA over the draft + its claim manifest (A9 authored it → A2 is independent).
  const review = qa.reviewAsset({
    asset: { text: p.draftText || '', producer_agent: producer, hero_item_id: p.heroItemId, item_ids: p.itemIds, partial_set: p.partialSet },
    claims: p.claims || [],
    sourceFields: p.sourceFields || {},
    reviewer: 'A2',
  });

  const publishEnabled = await marketingConfig.a9PublishEnabled();
  const fullCircleRequired = await marketingConfig.fullCircleRequired();
  const ctaOk = cc.ok && (cc.disposition === 'full_circle' || cc.disposition === 'exempt');

  let state;
  if (!review.released) state = 'returned_to_producer';           // QA blocked it
  else if (fullCircleRequired && !ctaOk) state = 'blocked_full_circle';
  else state = publishEnabled ? 'ready_to_publish' : 'release_ready_draft';  // proving mode → draft only

  return {
    topic: p.topic || null,
    audience: p.audience || null,
    intent: p.intent || null,
    producer,
    cta: cc,
    review,
    state,
    published: false,                                             // A9 never publishes in proving mode
    measurement: { primary_metric: 'organic_sessions', secondary_metrics: ['organic_ctr', 'assisted_conversions'] },
  };
}

module.exports = { runProvingLoop };
