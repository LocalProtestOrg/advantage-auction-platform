#!/usr/bin/env node
/* fp-reserve-first8.js — reserve the Owner-approved first 8 Founding Auction Partner PROSPECTS (2026-10-05).

   Dry run by default; --apply to write. PRODUCTION endpoint only.
   - 7 new companies: a Sales CRM prospect via salesProspectService.createProspect (the Toolbox create path), using ONLY
     verified values from docs/marketing/founding-partner-prospects-2026-10-05.csv. Missing values stay empty. Status is
     'research_complete' (never 'contacted'). Contact names (when the research has them) go into one research note.
   - Every company is then placed under Founding Partner protection with foundingPartnerService.designate (prospect
     only: no seller, no fee applied, no start date, no agreement).
   - Gold Coast Tag & Estate Sales uses its existing Seaford directory organization and is then excluded from the
     Claimed Listing Pilot 1 draft with sequenceService.excludeMember ("Moved to Founding Auction Partner").
   Fails closed per company: an identifier already belonging to another company, or a lookalike identity, stops that
   company and is reported. No email, call, Sasha message, account, seller, fee or switch is created or changed. */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const APPLY = process.argv.includes('--apply');
const ACTOR_EMAIL = 'admin@advantage.bid';
const COHORT = '832ab658-e70f-4a92-b796-bf31b3d21683';
const GOLD_COAST_ORG = '44b97531-ebf4-48d8-b25c-7024745f095c';
const SRC = 'founding_partner_research_2026-10-05';
const REASON = 'Owner-approved first Founding Auction Partner prospect group (2026-10-05). Prospect only: not contacted, no agreement, no fee applied.';

// Verified values only (founding-partner-prospects-2026-10-05.csv). null = not found by research; never guessed.
const NEW = [
  { key: 1, market: 'houston', company_name: 'Blue Family Estate Sales', city: 'Houston', state: 'TX', website: 'https://bluefamilyestatesales.com',
    business_phone: '(832) 701-5576', business_email: 'john@bluefamilyestatesales.com', online: 'no', site: 'yes',
    note: 'Contact: John (first name only, per company website). Source: https://bluefamilyestatesales.com', source_url: 'https://bluefamilyestatesales.com' },
  { key: 2, market: 'houston', company_name: 'Ashbury Lane Estate Services, LLC', city: 'Katy', state: 'TX', website: 'http://www.ashburylaneestates.com',
    business_phone: '(713) 478-1481', business_email: 'paulette@ashburylaneestates.com', online: 'unknown', site: 'yes',
    note: 'Contact: Paulette Roccasalva, President (company website). Website says online auctions are an expanding service; no platform or auction seen.', source_url: 'http://www.ashburylaneestates.com' },
  { key: 3, market: 'houston', company_name: 'Margie Beegle Sales', city: 'Houston', state: 'TX', website: 'https://www.margiebeeglesales.com',
    business_phone: '(713) 478-3293', business_email: null, online: 'no', site: 'yes',
    note: 'Contact name and email NOT verified (website blocked research). Do not guess.', source_url: 'https://www.estatesales.net/companies/TX/Houston' },
  { key: 4, market: 'houston', company_name: 'Mike & Clark Estate Liquidators', city: 'Stafford', state: 'TX', website: null,
    business_phone: '(281) 802-7327', business_email: null, online: 'unknown', site: 'no', website_status: 'directory_only',
    note: 'Contacts: Clark Koehn; Chris Koehn (principals, EstateSales.org). Alternate phone (Chris): (832) 647-0676. Recurring store sales at 3202 S Main, Stafford. No own website; no email verified. EstateSales.org ticks "online auctions" but none seen.',
    source_url: 'https://estatesales.org/estate-sale-companies/mike-and-clark-estate-sale-10941' },
  { key: 6, market: 'ny_tristate', company_name: 'Tag Sales By Mona', city: 'Baldwin', state: 'NY', website: 'https://www.tagsalesbymona.com',
    business_phone: '(516) 378-6613', business_email: 'tagsalesbymona@gmail.com', online: 'no', site: 'yes',
    note: 'Contact: Mona (first name only, company website). Also trades as "Junkbuster" (cleanouts). EstateSales.org lists the base as Garden City.', source_url: 'https://www.tagsalesbymona.com' },
  { key: 7, market: 'ny_tristate', company_name: 'Zach & Alix Company', city: null, state: 'NY', service_area: 'Westchester County NY and Connecticut', website: 'http://www.zachandalix.com',
    business_phone: '(914) 282-9582', business_email: null, online: 'no', site: 'yes',
    note: 'Contact: Lisa Miller, owner/operator (company website bio). Base town not stated on the website (Westchester County). No email verified.', source_url: 'http://www.zachandalix.com' },
  { key: 8, market: 'ny_tristate', company_name: 'GoldCoast Estate Liquidators LLC', city: 'Bridgeport', state: 'CT', service_area: 'Fairfield, New Haven and Litchfield counties CT; Westchester NY', website: 'https://goldcoastestateliquidators.com',
    business_phone: '(203) 981-7498', business_email: null, online: 'no', site: 'yes',
    note: 'Contact: Marc (first name only, customer reviews on company website). No email verified. DIFFERENT company from Gold Coast Tag & Estate Sales (Seaford NY).', source_url: 'https://goldcoastestateliquidators.com/' },
];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const deny = () => { throw new Error('network blocked'); };
  require('https').request = deny; require('http').request = deny; globalThis.fetch = async () => deny();

  const db = require('../src/db');
  const sales = require('../src/services/salesProspectService');
  const identity = require('../src/services/acquisition/companyIdentityService');
  const fp = require('../src/services/acquisition/foundingPartnerService');
  const sequences = require('../src/services/claimedListings/sequenceService');

  const actor = (await db.query(`SELECT id FROM users WHERE lower(email) = $1 AND role = 'admin'`, [ACTOR_EMAIL])).rows[0];
  if (!actor) { console.error('REFUSE: acting admin not found'); return 2; }
  console.log((APPLY ? 'APPLY' : 'DRY RUN') + ' as ' + ACTOR_EMAIL);
  const out = [];

  // ── 7 new companies ──
  for (const c of NEW) {
    const r = { key: c.key, company: c.company_name };
    try {
      const body = { company_name: c.company_name, city: c.city, state: c.state, service_area: c.service_area || null, business_phone: c.business_phone,
        business_email: c.business_email, website: c.website, website_status: c.website_status || (c.website ? 'active' : 'none'), source_url: c.source_url,
        estate_sales_offered: 'yes', online_auctions_offered: c.online, independent_website: c.site, business_type: 'estate_sale_company',
        contact_status: 'research_complete', source: SRC };
      const n = sales.normalizeInput(body); const k = sales.dedupKeys(n);
      const dup = await sales.findDuplicate(k, n);
      if (dup) { r.status = 'SKIPPED_EXISTING_PROSPECT'; r.detail = dup.id + ' ' + dup.company_name; out.push(r); continue; }
      // Strong identifier already belonging to another company (domain, email domain, phone, exact name) → fail closed.
      const snap = await identity.snapshot();
      const sig = identity.signalsOf({ name: n.company_name, website: n.website, email: n.business_email, phone: n.business_phone });
      const m = snap.matchSignals(sig);
      if (m.clusters.length) { r.status = 'HELD_IDENTITY_MATCH'; r.detail = m.hits.map((h) => h.entity.key + ' ' + h.entity.label + ' via ' + h.method); out.push(r); continue; }
      if (!APPLY) { r.status = 'WOULD_CREATE_AND_PROTECT'; r.keys = k; out.push(r); continue; }
      const p = await sales.createProspect(body, actor.id);
      r.prospect_id = p.id;
      if (c.note) await sales.addNote(p.id, actor.id, 'note', 'Founding Partner research (2026-10-05, not a contact): ' + c.note);
      try {
        const rec = await fp.designate({ entityType: 'sales_prospect', entityId: p.id, market: c.market, reason: REASON, actorId: actor.id, isSuperAdmin: true });
        r.founding_partner_id = rec.id; r.company_id = rec.company_id; r.status = 'PROTECTED'; if (rec.lock_note) r.lock_note = rec.lock_note;
      } catch (e) { r.status = 'PROSPECT_CREATED_PROTECTION_REFUSED'; r.detail = (e.code || '') + ': ' + e.message; }
    } catch (e) { r.status = 'ERROR'; r.detail = (e.code || '') + ': ' + e.message; }
    out.push(r);
  }

  // ── Gold Coast Tag & Estate Sales (existing directory organization) ──
  const g = { key: 5, company: 'Gold Coast Tag & Estate Sales', organization_id: GOLD_COAST_ORG };
  try {
    const org = (await db.query(`SELECT id, name, city, state, bd_listing_id FROM organizations WHERE id = $1`, [GOLD_COAST_ORG])).rows[0];
    if (!org || org.bd_listing_id !== '221' || org.city !== 'Seaford') throw new Error('organization does not match the expected Seaford listing 221');
    const snap = await identity.snapshot();
    const concern = fp.identityConcern(snap, 'organization', GOLD_COAST_ORG);
    if (concern) { g.status = 'HELD_' + concern.code; g.detail = concern.message; }
    else if (!APPLY) g.status = 'WOULD_PROTECT_AND_EXCLUDE_FROM_PILOT1';
    else {
      const rec = await fp.designate({ entityType: 'organization', entityId: GOLD_COAST_ORG, market: 'ny_tristate', reason: REASON, actorId: actor.id, isSuperAdmin: true });
      g.founding_partner_id = rec.id; g.company_id = rec.company_id; if (rec.lock_note) g.lock_note = rec.lock_note;
      const ex = await sequences.excludeMember(COHORT, GOLD_COAST_ORG, { actorId: actor.id, reason: 'Moved to Founding Auction Partner' });
      g.cohort_member_status = ex.status; g.status = 'PROTECTED_AND_EXCLUDED';
    }
  } catch (e) { g.status = 'ERROR'; g.detail = (e.code || '') + ': ' + e.message; }
  out.push(g);

  out.sort((a, b) => a.key - b.key);
  for (const r of out) console.log(JSON.stringify(r));
  await db.pool.end();
  return out.some((r) => /ERROR/.test(r.status)) ? 1 : 0;
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
