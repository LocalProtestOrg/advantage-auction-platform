'use strict';

/**
 * marketingCtaService — Full-Circle CTA registry + route_verified gate. An asset may only use a CTA whose
 * route is verified and whose link is CLEAN (no AI/tracking params). Every applicable external asset gets a
 * primary CTA + a secondary seller-acquisition CTA, or a documented exemption (disposition recorded).
 */
const db = require('../db');

// AI-origin / tracking contamination that must never appear in a public Advantage.Bid link.
const DIRTY = /utm_source=chatgpt|chatgpt\.com|openai|claude\.ai|[?&](gclid|fbclid|utm_[a-z]+)=/i;
function isCleanLink(href) { return !DIRTY.test(String(href || '')); }

async function listVerifiedCtas(runner = db) {
  return (await runner.query(`SELECT * FROM marketing_ctas WHERE is_active = true AND route_verified = true ORDER BY kind, cta_key`)).rows;
}

// Mark a CTA's route verified/unverified (call AFTER confirming the route actually resolves).
async function setRouteVerified(ctaKey, verified, runner = db) {
  await runner.query(
    `UPDATE marketing_ctas SET route_verified = $2, verified_at = CASE WHEN $2 THEN now() ELSE verified_at END WHERE cta_key = $1`,
    [ctaKey, !!verified]);
}

/**
 * Full-Circle disposition for an asset. Returns a full_circle assignment (primary + optional secondary
 * seller-acquisition CTA), an exemption, or a failure reason. Refuses unverified routes or dirty links.
 */
async function assignCtas({ primaryKey, secondaryKey = null, exemptReason = null } = {}, runner = db) {
  if (exemptReason) return { ok: true, disposition: 'exempt', reason: exemptReason };
  const ctas = await listVerifiedCtas(runner);
  const primary = ctas.find((c) => c.cta_key === primaryKey && c.kind === 'primary');
  if (!primary) return { ok: false, disposition: 'blocked', reason: 'primary_not_route_verified' };
  const secondary = secondaryKey ? ctas.find((c) => c.cta_key === secondaryKey && c.kind === 'secondary_seller_acquisition') : null;
  if (secondaryKey && !secondary) return { ok: false, disposition: 'blocked', reason: 'secondary_not_route_verified' };
  if (!isCleanLink(primary.href) || (secondary && !isCleanLink(secondary.href))) return { ok: false, disposition: 'blocked', reason: 'dirty_link' };
  return { ok: true, disposition: 'full_circle', primary: { key: primary.cta_key, href: primary.href, label: primary.label }, secondary: secondary ? { key: secondary.cta_key, href: secondary.href, label: secondary.label } : null };
}

module.exports = { DIRTY, isCleanLink, listVerifiedCtas, setRouteVerified, assignCtas };
