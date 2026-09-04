'use strict';

/**
 * marketingQaService — the A2 Independent QA runtime. PURE evaluation (reviewAsset) + a thin DB persister.
 *
 * Severity model (3C): S1 factual · S2 policy · S3 implied · S4 compliance · S5 mechanical · S6 format.
 * Independence: A2 never reviews an asset it authored (producer must not be A2). Any S1–S4 → return to the
 * producer (NO release, and NO ordinary Owner-approval step follows a PASS). S5/S6 may be mechanically
 * corrected when genuinely deterministic. Claim-manifest verification checks every FACTUAL claim against
 * the authoritative source fields. Includes implied-claim hooks: caption bleed, category halo, superlative
 * proximity, value anchoring, hero substitution, set implication.
 */

const db = require('../db');
const brand = require('../lib/marketingBrandLanguage');

const SEVERITY = Object.freeze({ S1: 'factual', S2: 'policy', S3: 'implied', S4: 'compliance', S5: 'mechanical', S6: 'format' });
const BLOCKING = ['S1', 'S2', 'S3', 'S4'];       // any of these → no release
const rank = { S1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S6: 6 };

// ── Claim manifest: every FACTUAL claim must cite an authoritative source field that actually exists ──
function verifyClaimManifest(claims, sourceFields) {
  const src = sourceFields || {};
  const manifest = [];
  const findings = [];
  for (const c of (Array.isArray(claims) ? claims : [])) {
    const kind = String(c.claim_kind || 'factual');
    const sourceKey = c.source_field || (c.authoritative_source || '').split('.').pop();
    const supported = kind !== 'factual'
      || (c.authoritative_source && sourceKey && src[sourceKey] != null && String(src[sourceKey]).trim() !== '');
    manifest.push({ claim: c.claim_text, kind, source: c.authoritative_source || null, supported: !!supported });
    if (kind === 'factual' && !supported) {
      findings.push({ severity: 'S1', code: 'unsupported_factual_claim', detail: c.claim_text });
    }
    if (kind === 'implied') {
      findings.push({ severity: 'S3', code: 'implied_needs_judgment', detail: c.claim_text });
    }
  }
  return { manifest, findings };
}

// ── Implied-claim hooks (deterministic detectors over the asset text + source) ──────
const SUPERLATIVES = /\b(best|finest|rarest|one[- ]of[- ]a[- ]kind|museum[- ]quality|unrival+ed|priceless|world[- ]class)\b/i;
function hookSuperlativeProximity(text) {
  return SUPERLATIVES.test(text) ? [{ severity: 'S3', code: 'superlative_proximity', detail: 'Unsupported superlative near a product claim.' }] : [];
}
function hookValueAnchoring(text) {
  return /\b(worth|valued at|retail(s)? (for|at)|appraised at|\$\d[\d,]*\s*(value|retail))\b/i.test(text)
    ? [{ severity: 'S3', code: 'value_anchoring', detail: 'Value/worth anchoring requires an authoritative source.' }] : [];
}
function hookCaptionBleed(text, sourceFields) {
  // A named maker/material in the copy that is absent from THIS item's source fields = cross-lot bleed.
  const src = sourceFields || {};
  const out = [];
  const maker = (src.maker || src.maker_artist || '').toString().toLowerCase();
  const m = /\bby ([A-Z][a-zA-Z.&' -]{2,})/.exec(text || '');
  if (m && maker && text.toLowerCase().indexOf(maker) === -1) out.push({ severity: 'S3', code: 'caption_bleed', detail: 'Copy attributes a maker not in this item’s source.' });
  return out;
}
function hookCategoryHalo(text, sourceFields) {
  // A category-level superlative applied to a specific unsourced item.
  const src = sourceFields || {};
  return (SUPERLATIVES.test(text) && !(src.maker || src.maker_artist) && !src.material)
    ? [{ severity: 'S3', code: 'category_halo', detail: 'Category-level claim applied to an item lacking source attributes.' }] : [];
}
function hookHeroSubstitution(asset) {
  return (asset && asset.hero_item_id && asset.item_ids && asset.item_ids.indexOf(asset.hero_item_id) === -1)
    ? [{ severity: 'S3', code: 'hero_substitution', detail: 'Hero image is not part of the promoted set.' }] : [];
}
function hookSetImplication(text, asset) {
  const impliesWhole = /\b(complete set|full collection|entire (set|collection)|matching set)\b/i.test(text || '');
  return (impliesWhole && asset && asset.partial_set)
    ? [{ severity: 'S3', code: 'set_implication', detail: 'Implies a complete set when only part is offered.' }] : [];
}

// ── Policy / compliance / internal-economics-leak detectors ─────────────────────────
function detectPolicy(text) {
  const out = [];
  try { brand.assertNoBannedFeeClaim(text || ''); } catch (_) { out.push({ severity: 'S2', code: 'banned_fee_claim', detail: 'Combined "7% commission"-style fee claim.' }); }
  if (/\b(AI|artificial intelligence|GPT|LLM|OpenAI|ChatGPT|Claude)\b/.test(text || '')) out.push({ severity: 'S2', code: 'ai_terminology', detail: 'Public AI terminology is not permitted.' });
  // Internal-economics leak (never in seller/public-facing marketing).
  if (/\b(direct[- ]spend|growth pool|60\/40|internal margin|settlement shortfall|marketing ledger)\b/i.test(text || '')) out.push({ severity: 'S4', code: 'internal_economics_leak', detail: 'Internal economics must never appear in marketing.' });
  if (/\[\[UNFILLED_PLACEHOLDER\]\]|{{\s*\w+\s*}}/.test(text || '')) out.push({ severity: 'S1', code: 'unfilled_placeholder', detail: 'Unfilled fixed-language placeholder.' });
  return out;
}

/**
 * PURE review. asset = { text, producer_agent, hero_item_id, item_ids, partial_set }, claims[], sourceFields{}.
 * Returns { independent, severity, findings, disposition, claim_manifest }.
 */
function reviewAsset({ asset = {}, claims = [], sourceFields = {}, reviewer = 'A2' } = {}) {
  const independent = String(asset.producer_agent || '').toUpperCase() !== String(reviewer).toUpperCase();
  const text = asset.text || '';
  const cm = verifyClaimManifest(claims, sourceFields);
  let findings = [].concat(
    cm.findings,
    detectPolicy(text),
    hookSuperlativeProximity(text),
    hookValueAnchoring(text),
    hookCaptionBleed(text, sourceFields),
    hookCategoryHalo(text, sourceFields),
    hookHeroSubstitution(asset),
    hookSetImplication(text, asset),
  );
  // Independence failure is itself a blocking compliance finding.
  if (!independent) findings.push({ severity: 'S4', code: 'reviewer_not_independent', detail: 'QA agent authored this asset.' });

  const severities = findings.map((f) => f.severity);
  const highest = severities.sort((a, b) => rank[a] - rank[b])[0] || null;
  const hasBlocking = severities.some((s) => BLOCKING.indexOf(s) !== -1);
  const onlyMechanical = severities.length > 0 && !hasBlocking; // only S5/S6

  let disposition;
  if (hasBlocking) disposition = 'return_to_producer';       // NO release
  else if (onlyMechanical) disposition = 'mechanically_corrected';
  else disposition = 'release_ready';

  return { independent, severity: highest, findings, disposition, claim_manifest: cm.manifest, released: disposition === 'release_ready' };
}

// ── DB persister (writes to the existing marketing_qa_reviews) ──────────────────────
async function persistReview({ campaignId = null, assetId = null, producerAgent = null, review, runner = db }) {
  const outcome = review.disposition === 'release_ready' ? 'pass' : (review.disposition === 'mechanically_corrected' ? 'pass' : 'fail');
  await runner.query(
    `INSERT INTO marketing_qa_reviews (campaign_id, asset_id, review_type, outcome, findings, reviewer, severity, verdict, claim_manifest, disposition, producer_agent)
     VALUES ($1,$2,'deterministic',$3,$4,'A2',$5,$6,$7,$8,$9)`,
    [campaignId, assetId, outcome, JSON.stringify(review.findings), review.severity,
     JSON.stringify({ disposition: review.disposition, independent: review.independent }),
     JSON.stringify(review.claim_manifest), review.disposition, producerAgent]);
  return review;
}

module.exports = {
  SEVERITY, BLOCKING, verifyClaimManifest, reviewAsset, persistReview,
  hooks: { hookSuperlativeProximity, hookValueAnchoring, hookCaptionBleed, hookCategoryHalo, hookHeroSubstitution, hookSetImplication },
  detectPolicy,
};
