'use strict';

/**
 * creativeReference/campaignMessages — Phase 3P.2 copy rules (config: docs/marketing/phase3p2/config/campaign-messages.json
 * + phase3p1/config/approved-messages.json + notable-lot-contract.json + paid-growth-policy.json assisted service).
 *
 * The ONLY source of approved copy. A headline may come from the class's approved list, or be newly written copy that
 * passes the lexicon, not-approved, density and claim rules. Reference-only text (everything else visible in a
 * reference) is never copy. Claims go through the A2 claim manifest: a fact string must resolve to a production record
 * field. Two permanent reject lists: any assisted-service commission percentage / fixed price, and the fictional
 * REF-23 training facts.
 */
const MSG = require('../../../docs/marketing/phase3p2/config/campaign-messages.json');
const P1MSG = require('../../../docs/marketing/phase3p1/config/approved-messages.json');
const NOTABLE = require('../../../docs/marketing/phase3p2/config/notable-lot-contract.json');
const PAID = require('../../../docs/marketing/phase3p2/config/paid-growth-policy.json');

const SELLER_CLASSES = ['individual_seller_acquisition', 'professional_seller_acquisition'];
const BUYER_CLASSES = ['buyer_platform_growth'];
// Lexicons (config buyer_vs_seller): seller = capability/ease; buyer = discovery.
const SELLER_LEXICON = /\b(sell|seller|sellers|selling|list your|list items|consign|cash|your auction|create (your|an) (own )?(online )?auction|start your auction|run the sale|inventory)\b/i;
const BUYER_LEXICON = /\b(shop|shopping|bid today|browse|discover|finds|find|unique|updates|inbox)\b/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%$ ]+/g, ' ').replace(/\s+/g, ' ').trim();

function approvedFor(campaignClass) {
  const out = [];
  for (const m of MSG.approved_messages) {
    const scope = m.scope.toLowerCase();
    const sellerFacing = scope.includes('seller'); const buyerFacing = scope.includes('buyer');
    if (m.role === 'event_type' || (sellerFacing && SELLER_CLASSES.includes(campaignClass)) || (buyerFacing && BUYER_CLASSES.includes(campaignClass))) out.push({ text: m.text, role: m.role, source: m.source, kind: 'approved_message' });
    else if (m.text === 'You Can Do This.' && SELLER_CLASSES.includes(campaignClass)) out.push({ text: m.text, role: m.role, source: m.source, kind: 'approved_message' });
  }
  for (const m of MSG.approved_campaign_specific_messages) if (m.class.split(' ')[0] === campaignClass) out.push({ text: m.text, role: m.role, source: m.source, kind: 'approved_campaign_specific' });
  for (const m of P1MSG.messages) if (m.status === 'OWNER_APPROVED_MESSAGE' && m.scope === campaignClass && !out.some((x) => x.text === m.text)) out.push({ text: m.text, role: m.role, source: 'Owner 3P.1', kind: 'approved_message' });
  return out;
}
function isApproved(text, campaignClass) { return approvedFor(campaignClass).some((m) => norm(m.text) === norm(text)); }
function allApprovedTexts() { return [...MSG.approved_messages.map((m) => m.text), ...MSG.approved_campaign_specific_messages.map((m) => m.text)]; }

function notApprovedHits(text) {
  const t = norm(text); const hits = [];
  for (const n of MSG.not_approved) for (const piece of n.text.split('/').map((x) => norm(x)).filter(Boolean)) if (t.includes(piece)) hits.push({ text: piece, why: n.why });
  return hits;
}
// Assisted service: availability only. Any percentage, "from X%", "only X%", fixed price or fee level → reject.
const PRICE_RE = /(\d{1,3}\s?%|\bpercent\b|\$\s?\d|\b\d+\s?(usd|dollars)\b|\bcommission\b|\bflat fee\b|\bfee of\b)/i;
function assistedPricingHits(text) {
  const t = String(text || '');
  const hits = [];
  if (/assist|full[- ]service|run the sale|hands-on/i.test(t) && PRICE_RE.test(t)) hits.push({ rule: 'assisted_service_pricing', text: t, why: 'assisted-service pricing is custom after evaluation — no percentage or fixed price anywhere (Owner rule)' });
  if (/\b40\s?%/.test(t)) hits.push({ rule: 'assisted_service_pricing', text: t, why: 'the internal full-service estimate is never a public figure' });
  return hits;
}
function fictionalFactHits(text) {
  const t = norm(text);
  return (NOTABLE.training_example.facts || []).filter((f) => t.includes(norm(f).replace(/!$/, ''))).map((f) => ({ rule: 'fictional_training_fact', text: f, why: 'FICTIONAL_TRAINING_FACT_NEVER_PRODUCTION (REF-23)' }));
}

/**
 * Validate the copy of one brief. copy: {field: text}; roles: {field: role}; manifest: [{claim, value, source}] (A2).
 * Returns { pass, rejections[], notes[] }.
 */
function validateCopy({ campaignClass, copy = {}, roles = {}, manifest = [], factFields = [], market = null }) {
  const rejections = []; const notes = [];
  const texts = Object.entries(copy).filter(([, v]) => typeof v === 'string' && v.trim());
  for (const [field, text] of texts) {
    const role = roles[field] || field;
    for (const h of notApprovedHits(text)) rejections.push({ field, rule: 'not_approved', detail: h.text + ' — ' + h.why });
    for (const h of assistedPricingHits(text)) rejections.push({ field, rule: h.rule, detail: h.why });
    for (const h of fictionalFactHits(text)) rejections.push({ field, rule: h.rule, detail: h.text + ' — ' + h.why });
    if (BUYER_CLASSES.includes(campaignClass) && SELLER_LEXICON.test(text) && !isApproved(text, campaignClass)) rejections.push({ field, rule: 'lexicon', detail: 'seller language in buyer creative: "' + text + '"' });
    if (SELLER_CLASSES.includes(campaignClass) && /\bthe smarter way to shop\b/i.test(text)) rejections.push({ field, rule: 'lexicon', detail: 'buyer slogan in seller creative' });
    if (BUYER_CLASSES.includes(campaignClass) && /\bthe smarter way to sell\b/i.test(text)) rejections.push({ field, rule: 'lexicon', detail: 'seller slogan in buyer creative' });
    if (/\bthe smarter way to bid\b/i.test(text)) rejections.push({ field, rule: 'not_approved', detail: 'not an approved slogan' });
    if (role === 'headline' && /,.*\band\b.*,|•|•|;\s*\w+\s*;/.test(text)) rejections.push({ field, rule: 'benefit_list_headline', detail: 'a headline that lists benefits is two ideas' });
    if (role === 'headline') notes.push({ field, approved: isApproved(text, campaignClass) ? 'approved copy' : 'new copy (not presented as approved; passes rules)' });
  }
  // Assisted-service availability line only in the strategic markets where people can serve it.
  const avail = texts.filter(([, t]) => /assisted service|hands-on help/i.test(t));
  if (avail.length) {
    const markets = PAID.strategic_markets.assisted_service.available_in;
    if (!market || !markets.includes(market)) rejections.push({ field: avail[0][0], rule: 'assisted_market', detail: 'assisted-service availability copy only in ' + markets.join(' / ') });
  }
  // A2: every declared fact field must resolve to a manifest claim sourced from a production record.
  const claims = new Map((manifest || []).map((c) => [c.claim, c]));
  for (const f of factFields) {
    const c = claims.get(f.claim);
    if (!c) { rejections.push({ field: f.field, rule: 'claim_manifest', detail: 'fact "' + f.field + '" has no production claim (' + f.claim + ')' }); continue; }
    if (!c.source || !/\./.test(c.source)) rejections.push({ field: f.field, rule: 'claim_manifest', detail: 'claim ' + f.claim + ' has no record-field source' });
    if (f.value != null && String(c.value) !== String(f.value)) rejections.push({ field: f.field, rule: 'claim_manifest', detail: 'fact value does not equal the record value' });
  }
  return { pass: rejections.length === 0, rejections, notes };
}

const ASSISTED_COPY = PAID.strategic_markets.assisted_service.copy_allowed;
module.exports = { approvedFor, isApproved, allApprovedTexts, validateCopy, assistedPricingHits, fictionalFactHits, notApprovedHits, SELLER_LEXICON, BUYER_LEXICON, ASSISTED_COPY, SELLER_CLASSES, BUYER_CLASSES };
