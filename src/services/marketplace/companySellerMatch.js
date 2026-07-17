'use strict';

/**
 * companySellerMatch — advisory matching engine for Marketplace Phase 2.
 *
 * Produces SUGGESTED company(org)->seller links for an admin to confirm. Admin
 * confirmation is the SOURCE OF TRUTH; this engine never writes a link.
 *
 * Design goal (owner requirement): matching is a set of CONFIGURABLE RULES, not
 * hardcoded assumptions. A rule declares its own confidence and whether it is
 * ELIGIBLE for future automatic linking. Whether an eligible rule actually
 * auto-links is controlled by env config — so a deterministic rule (exact Google
 * Place ID, verified domain, ...) can be turned on later WITHOUT touching this code
 * or the callers. Phase 2 default: every rule is advisory (auto-link OFF).
 *
 * Each rule reduces an org and a seller to a comparable key; a match is a non-null
 * key equality. Rules whose required identifiers are not captured yet (sellers have
 * no website/place-id today) simply yield no candidates — they lie dormant until
 * that data exists, then light up automatically.
 */

const db = require('../../db');
const { computeMatchKey } = require('../organizationMatchingService');

// ── helpers ───────────────────────────────────────────────────────────────────
function domainOf(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'http://' + url);
    return u.hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch (_) { return null; }
}

// ── rule registry ───────────────────────────────────────────────────────────────
// autoLinkEligible: whether the rule is deterministic enough to EVER auto-link.
// A rule can only auto-link when it is eligible AND enabled in config.
const RULES = [
  {
    key: 'google_place_id',
    label: 'Exact Google Place ID',
    confidence: 'exact',
    autoLinkEligible: true,
    orgKey:    (o) => o.google_place_id || null,
    sellerKey: (s) => s.google_place_id || null,   // dormant until sellers capture a place id
  },
  {
    key: 'verified_domain',
    label: 'Verified website domain',
    confidence: 'high',
    autoLinkEligible: true,
    orgKey:    (o) => domainOf(o.website_url),
    sellerKey: (s) => domainOf(s.website_url),      // dormant until sellers capture a website
  },
  {
    key: 'name_state',
    label: 'Normalized company name + state',
    confidence: 'medium',
    autoLinkEligible: false,                        // name similarity is NEVER auto-linked
    orgKey:    (o) => computeMatchKey(o.name, o.state),
    sellerKey: (s) => s.match_key || null,
  },
];

/**
 * Effective rule config, sourced from env so ops can enable auto-linking or disable a
 * rule without a deploy. Phase 2 defaults (unset) => all advisory.
 *   MARKETPLACE_AUTOLINK_RULES     — comma list of rule keys allowed to auto-link
 *   MARKETPLACE_DISABLED_MATCH_RULES — comma list of rule keys to skip entirely
 */
function ruleConfig(env = process.env) {
  const parse = (v) => new Set(String(v || '').split(',').map((x) => x.trim()).filter(Boolean));
  const autoOn = parse(env.MARKETPLACE_AUTOLINK_RULES);
  const off    = parse(env.MARKETPLACE_DISABLED_MATCH_RULES);
  return RULES.map((r) => ({
    key: r.key, label: r.label, confidence: r.confidence, autoLinkEligible: r.autoLinkEligible,
    orgKey: r.orgKey, sellerKey: r.sellerKey,
    enabled: !off.has(r.key),
    autoLink: r.autoLinkEligible && autoOn.has(r.key),  // eligible AND turned on
  }));
}

/**
 * Build the seller index used for matching. Includes a representative state (the seller's
 * most common auction address_state) so name+state matching has a state component. Fields
 * that sellers do not capture yet (website_url, google_place_id) are surfaced as null so the
 * corresponding rules stay dormant rather than mis-matching.
 */
async function buildSellerIndex(client = db) {
  const { rows } = await client.query(`
    SELECT sp.id, sp.display_name,
           (SELECT a.address_state FROM auctions a
              WHERE a.seller_id = sp.id AND a.address_state IS NOT NULL
              GROUP BY a.address_state ORDER BY count(*) DESC LIMIT 1) AS state
      FROM seller_profiles sp`);
  return rows.map((s) => ({
    id: s.id,
    display_name: s.display_name,
    state: s.state || null,
    match_key: s.display_name ? computeMatchKey(s.display_name, s.state || '') : null,
    website_url: null,       // not captured on seller_profiles yet (future)
    google_place_id: null,   // not captured on seller_profiles yet (future)
  }));
}

/** Run enabled rules for one org against the seller index. Returns suggestion objects. */
function suggestForOrg(org, sellerIndex, cfg) {
  const suggestions = [];
  for (const rule of cfg) {
    if (!rule.enabled) continue;
    const ok = rule.orgKey(org);
    if (!ok) continue;
    const matches = sellerIndex.filter((s) => { const sk = rule.sellerKey(s); return sk && sk === ok; });
    if (!matches.length) continue;
    // Ambiguous name matches (>1 seller shares the key) are surfaced but never auto-linkable.
    const ambiguous = matches.length > 1;
    for (const m of matches) {
      suggestions.push({
        rule: rule.key,
        label: rule.label,
        confidence: rule.confidence,
        ambiguous,
        // A suggestion is auto-linkable only if its rule is enabled for auto-link AND it is unambiguous.
        autoLinkable: !!rule.autoLink && !ambiguous,
        sellerProfileId: m.id,
        sellerName: m.display_name,
        evidence: { orgKey: ok, sellerKey: rule.sellerKey(m) },
      });
    }
  }
  // Strongest confidence first (exact > high > medium), unambiguous before ambiguous.
  const order = { exact: 0, high: 1, medium: 2 };
  return suggestions.sort((a, b) =>
    (order[a.confidence] - order[b.confidence]) || (a.ambiguous - b.ambiguous));
}

/**
 * Suggest links for marketplace listings. Returns [{ org, suggestions[] }] for every
 * unlinked bd_import org that has at least one candidate. Read-only.
 * @param {object} opts { orgId? } — restrict to a single org.
 */
async function suggestLinks(opts = {}, client = db) {
  const cfg = ruleConfig();
  const sellerIndex = await buildSellerIndex(client);
  const params = [];
  let where = `source = 'bd_import' AND linked_seller_profile_id IS NULL`;
  if (opts.orgId) { params.push(opts.orgId); where += ` AND id = $${params.length}`; }
  const { rows: orgs } = await client.query(
    `SELECT id, name, city, state, website_url, google_place_id FROM organizations WHERE ${where}`, params);
  const results = [];
  for (const org of orgs) {
    const suggestions = suggestForOrg(org, sellerIndex, cfg);
    if (suggestions.length) results.push({ org: { id: org.id, name: org.name, city: org.city, state: org.state }, suggestions });
  }
  return { config: cfg.map((r) => ({ key: r.key, confidence: r.confidence, enabled: r.enabled, autoLink: r.autoLink, autoLinkEligible: r.autoLinkEligible })), results };
}

module.exports = { RULES, ruleConfig, buildSellerIndex, suggestForOrg, suggestLinks, domainOf };
