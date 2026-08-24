#!/usr/bin/env node
/* seed-sales-prospects.js — insert CLEARLY-LABELED SAMPLE prospects so the Sales Toolbox is
 * demonstrable (tiers, filters, scoring). These are ILLUSTRATIVE placeholders, NOT real verified
 * businesses — every one is marked source='sample_seed' and its name ends with "(SAMPLE)".
 *
 * Real prospect ingestion is intentionally NOT automated here: the major estate-sale directories
 * (EstateSales.NET/.org/.com, BidSquare) prohibit automated retrieval (documented in the discovery
 * source audit). Real leads must come from an owner-authorized data source or manual entry.
 *
 * Idempotent: skips any sample whose company_name already exists. Safe to run on any environment.
 * Usage: railway run node scripts/seed-sales-prospects.js
 */
const { Pool } = require('pg');
const svc = require('../src/services/salesProspectService');

// Illustrative only. Contact fields deliberately use "Not publicly found" / blank or example.com so
// nothing here can be mistaken for a real, contactable business.
const SAMPLES = [
  { company_name: 'Heritage Estate Liquidations (SAMPLE)', city: 'Grand Rapids', state: 'MI',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no',
    website_status: 'social_only', social_url: 'https://facebook.com/example', business_phone: '',
    business_email: '', source_url: 'sample_seed' },
  { company_name: 'Lakeside Tag Sales (SAMPLE)', city: 'Ann Arbor', state: 'MI',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no',
    website_status: 'none', business_phone: '', business_email: '', source_url: 'sample_seed' },
  { company_name: 'Garden State Estate Services (SAMPLE)', city: 'Montclair', state: 'NJ',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no',
    website_status: 'directory_only', business_phone: '', business_email: '', source_url: 'sample_seed' },
  { company_name: 'Bluebonnet Estate Sales (SAMPLE)', city: 'Austin', state: 'TX',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'yes',
    website_status: 'outdated', website: 'https://example.com', business_phone: '', business_email: '',
    source_url: 'sample_seed' },
  { company_name: 'Cascade Downsizing & Estates (SAMPLE)', city: 'Portland', state: 'OR',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'yes',
    website_status: 'basic', website: 'https://example.com', business_phone: '', business_email: '',
    source_url: 'sample_seed' },
  { company_name: 'Sunshine Estate Sales (SAMPLE)', city: 'Tampa', state: 'FL',
    estate_sales_offered: 'yes', online_auctions_offered: 'unknown', independent_website: 'yes',
    website_status: 'active', website: 'https://example.com', business_phone: '', business_email: '',
    source_url: 'sample_seed' },
  { company_name: 'Metro Estate & Auction Group (SAMPLE)', city: 'Denver', state: 'CO',
    estate_sales_offered: 'yes', online_auctions_offered: 'yes', auction_platform_used: 'ExistingPlatform',
    independent_website: 'yes', website_status: 'active', website: 'https://example.com',
    source_url: 'sample_seed' },
  { company_name: 'Coastal Estate Clearances (SAMPLE)', city: 'Charleston', state: 'SC',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no',
    website_status: 'social_only', business_phone: '', business_email: '', source_url: 'sample_seed' },
  { company_name: 'Prairie Home Estate Sales (SAMPLE)', city: 'Omaha', state: 'NE',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no',
    website_status: 'none', business_phone: '', business_email: '', source_url: 'sample_seed' },
  { company_name: 'Old Dominion Estate Services (SAMPLE)', city: 'Richmond', state: 'VA',
    estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'yes',
    website_status: 'outdated', website: 'https://example.com', business_phone: '', business_email: '',
    source_url: 'sample_seed' },
];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('DATABASE_URL not set'); process.exit(2); }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = require('../src/db'); // uses the same pool config
  let inserted = 0, skipped = 0;
  for (const s of SAMPLES) {
    const exists = await pool.query('SELECT 1 FROM sales_prospects WHERE company_name = $1', [s.company_name]);
    if (exists.rowCount) { skipped++; continue; }
    const score = svc.scoreProspect(s);
    await pool.query(
      `INSERT INTO sales_prospects
         (company_name, city, state, website, website_status, social_url, business_phone, business_email,
          estate_sales_offered, online_auctions_offered, auction_platform_used, independent_website,
          prospect_tier, lead_score, contact_status, source, source_url, last_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'new_lead','sample_seed',$15, now())`,
      [s.company_name, s.city, s.state, s.website || null, s.website_status || 'unknown', s.social_url || null,
       s.business_phone || null, s.business_email || null, s.estate_sales_offered, s.online_auctions_offered,
       s.auction_platform_used || null, s.independent_website, score.tier, score.lead_score, s.source_url || 'sample_seed']);
    inserted++;
    console.log(`  + ${s.company_name} -> ${score.tier_label} (score ${score.lead_score})`);
  }
  console.log(`Done. Inserted ${inserted}, skipped ${skipped} (already present). All marked source='sample_seed'.`);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
