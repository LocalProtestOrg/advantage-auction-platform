'use strict';

/**
 * authorizationStatement — the exact words a company agrees to, in ONE place.
 *
 * Why this is a module and not page copy: the confirmation page renders this text, and the stored
 * authorization evidence records the same version id and the same lines. If the wording ever changes,
 * a new version is added here and older records keep pointing at the words that were actually shown.
 * An evidence record that says "they agreed" without saying "to this text" is not evidence.
 *
 * Drafting rule from the Owner: claim no more than we need. The grant is narrow and specific —
 * publicly posted upcoming events, from one named website, displayed at no charge, revocable at any
 * time. It is NOT a content licence, NOT exclusivity, NOT a marketing-email permission, NOT an
 * agreement to sell on the platform, and NOT a transfer of any listing rights.
 */

const CURRENT_VERSION = '2026-09-11.v1';

/** The grant, as bullet lines. Rendered verbatim on the page and copied into the evidence record. */
const GRANT_LINES = Object.freeze([
  'Advantage.Bid may collect the upcoming estate sales and auctions that your company posts publicly on your own website.',
  'Advantage.Bid may display those events on Advantage.Bid at no charge to you, with your company named as the host.',
  'Each event page links back to your website so buyers can see your full listing.',
]);

/** What this explicitly does NOT do. Stated up front so nothing is implied by silence. */
const LIMIT_LINES = Object.freeze([
  'This does not create an account, and you are not asked for a password or payment.',
  'This does not sign you up for marketing email.',
  'This does not give Advantage.Bid any rights to sell your items or represent your company.',
  'You can withdraw this at any time and we stop collecting.',
]);

/** One-sentence summary used in list views, admin surfaces and the confirmation receipt. */
const SUMMARY = 'Authorizes Advantage.Bid to collect publicly posted upcoming events from the named '
  + 'company website and promote them on Advantage.Bid at no charge, revocable at any time.';

/**
 * The full statement for a given company + website, ready to render or to store as evidence.
 * @param {{companyName: string, domain: string}} ctx
 */
function build(ctx) {
  ctx = ctx || {};
  const company = String(ctx.companyName || '').trim() || 'your company';
  const domain = String(ctx.domain || '').trim();
  return {
    version: CURRENT_VERSION,
    company_name: company,
    authorized_domain: domain,
    headline: 'Authorize Free Event Promotion',
    lead: `You are authorizing Advantage.Bid to promote ${company}'s upcoming public events, free of charge.`,
    website_line: domain ? `Events will be collected from ${domain}.` : null,
    grant: GRANT_LINES.slice(),
    limits: LIMIT_LINES.slice(),
    summary: SUMMARY,
    confirm_label: 'Authorize Free Event Promotion',
  };
}

/**
 * The evidence snapshot stored with the authorization: the version plus the literal lines shown, so
 * the record can be reconstructed later without depending on this file staying unchanged.
 */
function evidenceSnapshot(ctx) {
  const s = build(ctx);
  return {
    statement_version: s.version,
    headline: s.headline,
    lead: s.lead,
    website_line: s.website_line,
    grant: s.grant,
    limits: s.limits,
    summary: s.summary,
  };
}

module.exports = { CURRENT_VERSION, GRANT_LINES, LIMIT_LINES, SUMMARY, build, evidenceSnapshot };
