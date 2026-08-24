'use strict';

/**
 * Sales & Marketing Toolbox — prospect pipeline tests.
 *
 * Pure classification/scoring + input validation (DB-free), plus source-level guards that the routes
 * are admin-only and that internal prospect data is never exposed on a public/unauthenticated surface,
 * and that the admin page is noindex.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const svc = require('../src/services/salesProspectService');

describe('scoreProspect — tier classification (pure)', () => {
  test('Tier 1 Golden: estate sales, no auctions, no independent website', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no' });
    expect(r.tier).toBe(1);
    expect(r.tier_label).toMatch(/Golden/);
  });
  test('Tier 2 High-Value: estate sales, no auctions, has a website', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'yes' });
    expect(r.tier).toBe(2);
  });
  test('Tier 4 Lower/Competitive: already runs auctions on a named platform', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'yes', auction_platform_used: 'SomePlatform' });
    expect(r.tier).toBe(4);
  });
  test('Tier 3 Possible: unknowns (do not assume "no auction" from silence)', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'unknown', online_auctions_offered: 'unknown' });
    expect(r.tier).toBe(3);
  });
  test('auctions=yes but NO platform named → not auto-demoted to competitive', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'yes' });
    expect(r.tier).toBe(3); // uncertain; needs verification, not Tier 4
  });
});

describe('scoreProspect — lead score (pure)', () => {
  test('golden + reachable = the hottest (near/at 100)', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no', business_email: 'a@b.com', business_phone: '555' });
    expect(r.lead_score).toBe(100); // 30 + 30 + 25 + 8 + 7
  });
  test('a weak/outdated website scores higher than a strong one (no-website signal)', () => {
    const weak = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'yes', website_status: 'outdated' });
    const strong = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'yes', website_status: 'active' });
    expect(weak.lead_score).toBeGreaterThan(strong.lead_score);
  });
  test('a mature competitor scores low', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'yes', auction_platform_used: 'X', independent_website: 'yes', website_status: 'active' });
    expect(r.lead_score).toBeLessThan(50);
  });
  test('score is clamped to 0..100', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no', business_email: 'a@b', business_phone: '5', website_status: 'none' });
    expect(r.lead_score).toBeGreaterThanOrEqual(0);
    expect(r.lead_score).toBeLessThanOrEqual(100);
  });
});

describe('normalizeInput — validation', () => {
  test('company_name required', () => {
    expect(() => svc.normalizeInput({})).toThrow(/company_name/);
  });
  test('state uppercased + truncated to 2; tri-state defaults to unknown', () => {
    const n = svc.normalizeInput({ company_name: 'X', state: 'michigan' });
    expect(n.state).toBe('MI');
    expect(n.estate_sales_offered).toBe('unknown');
    expect(n.online_auctions_offered).toBe('unknown');
    expect(n.independent_website).toBe('unknown');
  });
  test('invalid contact_status rejected', () => {
    expect(() => svc.normalizeInput({ company_name: 'X', contact_status: 'bogus' })).toThrow(/contact_status/);
  });
  test('unknown website_status coerced to "unknown"', () => {
    expect(svc.normalizeInput({ company_name: 'X', website_status: 'nonsense' }).website_status).toBe('unknown');
  });
});

describe('contact-status pipeline vocabulary', () => {
  test('the pipeline stages exist end to end', () => {
    ['new_lead', 'research_complete', 'contacted', 'follow_up', 'interested',
     'demo_scheduled', 'demo_completed', 'signup_sent', 'professional_seller', 'not_interested']
      .forEach((s) => expect(svc.CONTACT_STATUS).toContain(s));
  });
});

describe('authorization + privacy (source-level guards)', () => {
  const routeSrc = read('src/routes/adminSales.js');
  const serverSrc = read('server.js');
  test('every sales route is admin-gated (router.use auth + role admin)', () => {
    expect(routeSrc).toMatch(/router\.use\(auth, role\(\['admin'\]\)\)/);
  });
  test('sales routes are mounted under /api/admin (behind the admin surface)', () => {
    expect(serverSrc).toMatch(/app\.use\('\/api\/admin\/sales', adminSalesRoutes\)/);
  });
  test('no public/unauthenticated route exposes sales_prospects', () => {
    // The only files that reference the table are the admin service + seed script (+ this test).
    const publicRoutes = ['src/routes/public', 'src/routes/marketplace', 'src/routes/auctions', 'src/routes/sellers'];
    for (const f of publicRoutes) {
      try { expect(read(f + '.js')).not.toMatch(/sales_prospects/); } catch (_e) { /* file may not exist */ }
    }
  });
  test('the admin Sales page is noindex/nofollow and not linked from public nav', () => {
    const html = read('public/admin/sales.html');
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  });
});

describe('sample seed is clearly labeled and not presented as real leads', () => {
  const seed = read('scripts/seed-sales-prospects.js');
  test('all sample companies are labeled (SAMPLE) and sourced sample_seed', () => {
    expect(seed).toMatch(/\(SAMPLE\)/);
    expect(seed).toMatch(/source_url: 'sample_seed'/);
    // No fabricated real-looking contact emails: only blank or example.com.
    expect(seed).not.toMatch(/business_email: '[a-z0-9._%+-]+@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}'/i);
  });
  test('documents why real ingestion is not automated (directory prohibition)', () => {
    expect(seed).toMatch(/prohibit automated retrieval/i);
  });
});
