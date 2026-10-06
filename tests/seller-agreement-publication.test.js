'use strict';

/**
 * Seller Agreement v2 (2026-10-06): publication language matches the platform operating model.
 * Individual sellers: Advantage reviews, approves and publishes. Verified professional sellers publish their own
 * auctions, subject to the Agreement, verification, marketplace policies, prohibited-item rules and platform controls.
 * Advantage keeps every moderation right. No fee, payout, tax, Storefront or entity wording changed, and versions are
 * never overwritten.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function agreementBody() {   // same extraction as the publish/seed scripts
  const md = read('docs/seller-agreement-v1-content.md');
  let body = md.slice(md.indexOf('\n', md.indexOf('## Agreement body')) + 1);
  const end = body.indexOf('### Authoring notes');
  if (end !== -1) body = body.slice(0, end);
  return body.replace(/\n+---\s*$/, '').trim();
}
const body = agreementBody();
const section = (n) => { const m = body.match(new RegExp('(?:^|\\n)' + n.replace('.', '\\.') + ' [\\s\\S]*?(?=\\n\\d+\\.\\d+ |\\n## |$)')); return m ? m[0] : ''; };

describe('publication model', () => {
  test('no clause says Advantage controls or performs publication of every auction', () => {
    expect(body).not.toMatch(/Advantage, not the Seller, controls publication/);
    expect(body).not.toMatch(/Advantage publishes auctions;/);
    expect(body).not.toMatch(/No auction or lot becomes public without Advantage's human review/);
    expect(body).not.toMatch(/already approved and live/);
  });
  test('§1.3: individual sellers are reviewed and published by Advantage; verified professionals publish their own, subject to the rules', () => {
    const s = section('1.3');
    expect(s).toMatch(/Individual sellers\.\*\* Advantage reviews and approves each auction an individual Seller submits before it goes live, and Advantage publishes it\./);
    expect(s).toMatch(/whose business Advantage has verified, may create and publish its own auctions through the Platform using the tools Advantage makes available to professional sellers/);
    expect(s).toMatch(/subject to this Agreement, business verification, the Platform's marketplace policies, the prohibited and restricted item rules in Section 4, and the Platform's controls/);
  });
  test('§1.3 keeps every moderation right, before or after going live, and does not change the parties\' roles', () => {
    const s = section('1.3');
    for (const w of ['review', 'moderate', 'decline', 'edit', 'reschedule', 'restrict', 'suspend', 'withdraw']) expect(s).toMatch(new RegExp('\\b' + w + '\\b'));
    expect(s).toMatch(/before or after it goes live, in its reasonable discretion/);
    expect(s).toMatch(/does not change the roles described in Section 1\.2 or the Seller's representations and responsibilities/);
    expect(body).toMatch(/acts solely as the Seller's selling agent/);                    // §1.2 unchanged
  });
  test('§2.4, §2.5, §6.8 follow the same model; verification still gates a professional\'s publication', () => {
    expect(section('2.4')).toMatch(/An individual Seller's auctions and lots become public only after Advantage's human review and approval; a verified professional Seller may publish its own auctions as described in Section 1\.3\./);
    expect(section('2.4')).toMatch(/Advantage may suspend or limit the Seller's privileges at any time for risk, noncompliance, or suspected fraud/);
    expect(section('2.5')).toMatch(/may decline to publish, prevent the Seller from publishing, or pause the affected auction/);
    expect(section('6.8')).toMatch(/a professional Seller cannot publish an auction, and its first sale cannot become publicly sellable, until Advantage has verified and approved the Seller's business/);
  });
  test('the Auction Partner Addendum and the Seller Agreement agree: the professional seller publishes', () => {
    const add = read('docs/legal/auction-partner-program-addendum.md');
    expect(add).toMatch(/an auction that you publish through Advantage\.Bid during the Term/);
    expect(add).not.toMatch(/Advantage\.Bid (publishes|published|continues to review and publish)/);
    expect(section('1.3')).toMatch(/may create and publish its own auctions/);
  });
});

describe('nothing else changed', () => {
  test('fees, payout, tax, Storefront and the contracting entity read exactly as before', () => {
    expect(body).toMatch(/^# Advantage\.Bid Seller Consignment and Auction Services Agreement\n\n\*\*Advantage Auction Company, LLC d\/b\/a Advantage\.Bid\*\*/);
    expect(body).toMatch(/currently charges a 0% seller commission/);
    expect(body).toMatch(/may charge buyers an 18% Buyer's Premium/);
    expect(body).toMatch(/responsible for a payment processing fee of 3%/);
    expect(body).toMatch(/Advantage\.Bid platform\/software fee of 4% of the hammer price/);
    expect(body).toMatch(/credit-card\/payment-processing fee of 3% of the hammer price/);
    expect(body).toMatch(/flat seller fee of \*\*11% of the item selling price\*\*/);
    expect(body).toMatch(/Advantage processes seller payouts on a weekly cycle, every \*\*Thursday\*\*/);
    expect(body).toMatch(/7\.4 Taxes are calculated after auction close in accordance with applicable law\./);
    expect(body).toMatch(/governed by the laws of the State of Michigan/);
  });
  test('the public seller FAQ no longer says sellers never publish', () => {
    const faq = read('public/seller-faq.html');
    expect(faq).not.toMatch(/sellers do not publish directly/);
    expect(faq).toMatch(/Verified Professional Sellers publish their own qualifying auctions/);
  });
});

describe('versioning protects signed agreements', () => {
  test('the new-version script inserts a new version and never updates or overwrites an existing one', () => {
    const s = read('scripts/prod-publish-seller-agreement-version.js');
    expect(s).toMatch(/INSERT INTO agreement_template_versions/);
    expect(s).not.toMatch(/UPDATE agreement_template_versions|ON CONFLICT/);
    expect(s).not.toMatch(/UPDATE agreements|UPDATE agreement_signatures|UPDATE seller_profiles/);
    expect(s).toMatch(/previous_version_text_unchanged/);
    expect(s).toMatch(/issued_and_signed_agreements_unchanged/);
  });
  test('the old seed script refuses to overwrite once a version exists', () => {
    expect(read('scripts/prod-seed-agreement-template.js')).toMatch(/REFUSE: the Seller Agreement template already has a version/);
  });
  test('the body still renders with no unexpected placeholders', () => {
    const vars = [...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    expect([...new Set(vars)].sort()).toEqual(['effective_date', 'legal_name', 'seller_address', 'seller_phone', 'seller_type', 'signatory_name']);
  });
});
