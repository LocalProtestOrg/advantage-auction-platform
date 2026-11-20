'use strict';
// Owner-approved storefront commission wording (2026-11-19), to be used exactly as written. It is the ONE place seller
// marketing may name the card processor or give an approximate processing figure; the wording guards remove exactly this
// sentence before checking a page, so every other mention is still refused.
const HEADLINE = 'One Simple Commission. No Hidden Processing Fees.';
const BODY = 'Pay just 5% on sales originating from your own embedded storefront or 9% on sales originating from the Advantage.Bid marketplace. Roughly 3% standard Stripe credit card processing is included. No monthly fees or listing fees.';
const withoutApproved = (html) => String(html).split(BODY).join('');
module.exports = { HEADLINE, BODY, withoutApproved };
