#!/usr/bin/env node
/* claimed-listing-about-replacements.js — prepares SHORT FACTUAL replacements for the imported "About"
   texts on unclaimed directory listings (blueprint G7 / Owner decision O4). READ-ONLY by default.

   The imported texts were written by us and some state business terms we never verified ("no upfront
   fees", "fair commission rates"). The replacement states only what is known from the record:

     "{Name} is an estate sale company in {City}, {ST}. This listing was created from public business
      information. The business can claim it to add details."

   Nothing is invented: type comes from the directory category, location from the record; missing data is
   left out rather than guessed. Pilot listings (ELIGIBLE, strategic markets first) are listed first.

   --apply --confirm=REPLACE-ABOUT-TEXTS writes the Railway copy (organizations.description) for the listed
   organizations ONLY while they are still unclaimed; the directory (BD) copy is changed by the BD agent
   from docs/marketing/claimed-listing/bd-agent-handoff.md. Do not apply without the Owner's O4 approval.

   Usage: node scripts/claimed-listing-about-replacements.js [--pilot-only] [--out=file.json] */
const fs = require('fs');
const db = require('../src/db');
const listingContext = require('../src/services/claimedListings/listingContext');
const eligibility = require('../src/services/claimedListings/eligibilityService');
const scoring = require('../src/services/claimedListings/scoringService');

const arg = (k) => { const a = process.argv.find((x) => x === '--' + k || x.startsWith('--' + k + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : null; };
const TYPE = { 4: 'an estate sale company', 3: 'an auction house', 5: 'an appraiser' };
// Business terms and claims we never verified. Their presence is why a text should be replaced first.
const UNVERIFIED = /no upfront fee|upfront fees|commission|lowest|best|#\s?1|number one|guarantee|top[- ]rated|award[- ]winning|licensed|insured|bonded|since \d{4}|\d+\s*years/i;

function factual(o) {
  const type = TYPE[o.bd_metadata && o.bd_metadata.profession_id] || 'a business';
  const st = listingContext.usStateCode(o.state);
  const where = o.city && st ? ' in ' + o.city.trim() + ', ' + st : st ? ' in ' + listingContext.US_STATES[st].replace(/\b\w/g, (c) => c.toUpperCase()) : '';
  return o.name.trim() + ' is ' + type + where + '. This listing was created from public business information. The business can claim it to add details.';
}

(async () => {
  const ctx = await listingContext.load(db);
  const rows = [];
  for (const e of ctx.listings) {
    const o = e.row;
    if (o.has_owner) continue;   // a claimed listing's text belongs to its owner
    const d = eligibility.decide(e, ctx);
    const s = scoring.scoreListing(e, ctx);
    const current = String(o.description || '');
    rows.push({ organization_id: o.id, bd_listing_id: o.bd_listing_id, company: o.name, city: o.city, state: o.state,
      pilot_candidate: d.decision === eligibility.DECISIONS.ELIGIBLE && !!s.factors.strategic_market.value,
      eligibility: d.decision, tier: s.tier, market: s.factors.strategic_market.value,
      current_length: current.length, current_has_unverified_claims: UNVERIFIED.test(current),
      unverified_phrases: (current.match(new RegExp(UNVERIFIED.source, 'gi')) || []).slice(0, 5),
      replacement: factual(o) });
  }
  rows.sort((a, b) => Number(b.pilot_candidate) - Number(a.pilot_candidate) || Number(b.current_has_unverified_claims) - Number(a.current_has_unverified_claims) || a.company.localeCompare(b.company));
  const list = arg('pilot-only') ? rows.filter((r) => r.pilot_candidate) : rows;
  const report = { generated_at: new Date().toISOString(), listings: list.length, pilot_candidates: rows.filter((r) => r.pilot_candidate).length,
    with_unverified_claims: rows.filter((r) => r.current_has_unverified_claims).length, rows: list };
  if (typeof arg('out') === 'string') fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
  for (const r of list.slice(0, 15)) console.log((r.pilot_candidate ? 'PILOT ' : '      ') + (r.current_has_unverified_claims ? '! ' : '  ') + r.company + ' :: ' + r.replacement);

  if (arg('apply') === true) {
    if (arg('confirm') !== 'REPLACE-ABOUT-TEXTS') { console.error('REFUSE: --apply requires --confirm=REPLACE-ABOUT-TEXTS (Owner decision O4)'); process.exitCode = 2; return; }
    let n = 0;
    for (const r of list) {
      const u = await db.query(
        `UPDATE organizations SET description = $2, updated_at = now()
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = organizations.id AND m.role = 'owner' AND m.status = 'active')`,
        [r.organization_id, r.replacement]);
      n += u.rowCount;
    }
    console.log('APPLIED to ' + n + ' unclaimed Railway listings.');
  }
})().then(() => db.pool.end()).catch((e) => { console.error(e.message); process.exitCode = 1; });
