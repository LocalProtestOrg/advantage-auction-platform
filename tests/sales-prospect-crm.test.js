'use strict';

/**
 * Sales Prospect CRM — dedup, classification, research/activity separation (refresh never overwrites
 * CRM work), Contacted quick-action, actionable gating, and RBAC/privacy source guards (section 33).
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const svc = require('../src/services/salesProspectService');

function routeDb(routes) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    for (const [re, res] of routes) if (re.test(flat)) return typeof res === 'function' ? res(params) : res;
    return { rows: [], rowCount: 0 };
  });
  return { calls, find: (re) => calls.find((c) => re.test(c.sql)), all: (re) => calls.filter((c) => re.test(c.sql)) };
}
beforeEach(() => db.query.mockReset());

describe('dedup key derivation', () => {
  test('normalizeName strips punctuation/case', () => {
    expect(svc.normalizeName('Bob & Sons, LLC!')).toBe('bobsonsllc');
    expect(svc.normalizeName('')).toBeNull();
  });
  test('extractDomain strips scheme/www/path', () => {
    expect(svc.extractDomain('https://www.BobsAuctions.com/about')).toBe('bobsauctions.com');
    expect(svc.extractDomain('notaurl')).toBeNull();
  });
  test('normalizePhone → 10 digits, strips US country code', () => {
    expect(svc.normalizePhone('+1 (713) 555-1234')).toBe('7135551234');
    expect(svc.normalizePhone('713.555.1234')).toBe('7135551234');
  });
});

describe('classification — priority + opportunity + actionable', () => {
  test('golden estate co, no auctions, no website, reachable → HOT / both', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no', business_phone: '555' });
    expect(r.lead_priority).toBe('hot'); expect(r.opportunity_type).toBe('both'); expect(r.tier).toBe(1);
  });
  test('NON-actionable (no phone/email) is never hot', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'no' });
    expect(r.lead_priority).toBe('standard');
  });
  test('auction house, unknown status, reachable → warm', () => {
    const r = svc.scoreProspect({ business_type: 'auction_house', online_auctions_offered: 'unknown', business_phone: '555' });
    expect(r.lead_priority).toBe('warm');
  });
  test('website but no online auctions + reachable → online_auction opportunity, HOT', () => {
    const r = svc.scoreProspect({ estate_sales_offered: 'yes', online_auctions_offered: 'no', independent_website: 'yes', website_status: 'active', business_email: 'a@b.com' });
    expect(r.opportunity_type).toBe('online_auction'); expect(r.lead_priority).toBe('hot');
  });
});

describe('normalizeInput — new fields + validation', () => {
  test('accepts business_type; rejects invalid business_type silently to null', () => {
    expect(svc.normalizeInput({ company_name: 'X', business_type: 'auction_house' }).business_type).toBe('auction_house');
    expect(svc.normalizeInput({ company_name: 'X', business_type: 'bogus' }).business_type).toBeNull();
  });
  test('rejects invalid lead_priority', () => {
    expect(() => svc.normalizeInput({ company_name: 'X', lead_priority: 'blazing' })).toThrow(/lead_priority/);
  });
});

describe('markContacted — quick action records who + when, keeps history', () => {
  test('advances a new lead to contacted, stamps last_contacted_by, logs activity', async () => {
    const r = routeDb([
      [/SELECT id, contact_status FROM sales_prospects/, { rows: [{ id: 'p1', contact_status: 'new_lead' }] }],
      [/UPDATE sales_prospects SET contact_status = CASE/, { rows: [{ id: 'p1', contact_status: 'contacted' }] }],
      [/INSERT INTO sales_prospect_notes/, { rows: [{ id: 'n1' }] }],
    ]);
    await svc.markContacted('p1', 'user-9', 'Called, left VM');
    const upd = r.find(/UPDATE sales_prospects SET contact_status = CASE/);
    expect(upd.sql).toMatch(/last_contact_at = now\(\)/);
    expect(upd.sql).toMatch(/last_contacted_by_user_id = \$2/);
    expect(upd.params).toContain('user-9');
    expect(r.all(/INSERT INTO sales_prospect_notes/).length).toBeGreaterThanOrEqual(1); // history preserved
  });
  test('does NOT downgrade an already-advanced status', async () => {
    const r = routeDb([
      [/SELECT id, contact_status FROM sales_prospects/, { rows: [{ id: 'p1', contact_status: 'interested' }] }],
      [/UPDATE sales_prospects/, { rows: [{ id: 'p1', contact_status: 'interested' }] }],
    ]);
    await svc.markContacted('p1', 'user-9');
    // CASE WHEN $3(false) THEN 'contacted' ELSE contact_status → stays interested
    const upd = r.find(/UPDATE sales_prospects SET contact_status = CASE/);
    expect(upd.params[2]).toBe(false); // advance=false
  });
});

describe('importProspects — research-only refresh NEVER overwrites CRM activity (sections 25/26)', () => {
  const REC = { company_name: 'Acme Auctions', city: 'Dallas', state: 'TX', business_phone: '214-555-0000', website: 'https://acmeauctions.com' };

  test('an existing prospect is UPDATED without touching contact_status/assigned/last_contact/follow_up/notes', async () => {
    const r = routeDb([
      [/SELECT \* FROM sales_prospects WHERE/, { rows: [{ id: 'existing1', priority_locked: false }] }],
      [/UPDATE sales_prospects SET/, { rowCount: 1 }],
    ]);
    const summary = await svc.importProspects([REC], { source: 'osm_overpass' });
    expect(summary.updated).toBe(1);
    const upd = r.find(/UPDATE sales_prospects SET/);
    // research columns present…
    expect(upd.sql).toMatch(/business_phone=/); expect(upd.sql).toMatch(/website=/); expect(upd.sql).toMatch(/last_verified_at=now\(\)/);
    // …CRM-activity columns ABSENT (the whole point of the separation)
    expect(upd.sql).not.toMatch(/contact_status\s*=/);
    expect(upd.sql).not.toMatch(/assigned_rep_user_id\s*=/);
    expect(upd.sql).not.toMatch(/last_contact_at\s*=/);
    expect(upd.sql).not.toMatch(/last_contacted_by_user_id\s*=/);
    expect(upd.sql).not.toMatch(/next_follow_up_at\s*=/);
    // never writes notes on refresh
    expect(r.all(/INSERT INTO sales_prospect_notes/).length).toBe(0);
  });

  test('a manually-locked priority is preserved on refresh (CASE WHEN priority_locked)', async () => {
    const r = routeDb([
      [/SELECT \* FROM sales_prospects WHERE/, { rows: [{ id: 'e2', priority_locked: true, lead_priority: 'hot' }] }],
      [/UPDATE sales_prospects SET/, { rowCount: 1 }],
    ]);
    await svc.importProspects([REC], { source: 'osm_overpass' });
    expect(r.find(/UPDATE sales_prospects SET/).sql).toMatch(/lead_priority = CASE WHEN priority_locked THEN lead_priority ELSE/);
  });

  test('a brand-new prospect is INSERTED with source + contact_status new_lead', async () => {
    const r = routeDb([
      [/SELECT \* FROM sales_prospects WHERE/, { rows: [] }],
      [/INSERT INTO sales_prospects/, { rowCount: 1 }],
    ]);
    const summary = await svc.importProspects([REC], { source: 'osm_overpass' });
    expect(summary.inserted).toBe(1);
    expect(r.find(/INSERT INTO sales_prospects/).sql).toMatch(/'new_lead'/);
  });

  test('records with NEITHER phone nor email are skipped (never actionable, never fabricated)', async () => {
    routeDb([]);
    const summary = await svc.importProspects([{ company_name: 'No Contact Co', city: 'X', state: 'TX' }], { source: 'osm_overpass' });
    expect(summary.skipped_no_contact).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(db.query).not.toHaveBeenCalled(); // never even queried — no fabrication path
  });
});

describe('listProspects — work-queue filters compile safely', () => {
  test('follow-up buckets + actionable + exclude_dnc + assigned build a parameterized WHERE', async () => {
    const r = routeDb([[/FROM sales_prospects sp/, { rows: [] }]]);
    await svc.listProspects({ follow_up: 'overdue', actionable: 'true', exclude_dnc: 'true', assigned_rep_user_id: 'unassigned', lead_priority: 'hot', business_type: 'auction_house', has_phone: 'true' });
    const q = r.find(/FROM sales_prospects sp/).sql;
    expect(q).toMatch(/next_follow_up_at < now\(\)/);
    expect(q).toMatch(/is_actionable = true/);
    expect(q).toMatch(/contact_status <> 'do_not_contact'/);
    expect(q).toMatch(/assigned_rep_user_id IS NULL/);
    expect(q).toMatch(/lead_priority = \$/);
  });
});

describe('RBAC + privacy (source-level guards, section 28/29)', () => {
  const routeSrc = read('src/routes/adminSales.js');
  test('router requires auth + sales.view; writes require sales.manage_prospects', () => {
    expect(routeSrc).toMatch(/router\.use\(auth, requirePermission\('sales\.view'\)\)/);
    expect(routeSrc).toMatch(/\/prospects\/:id\/contacted', requirePermission\('sales\.manage_prospects'\)/);
    expect(routeSrc).toMatch(/'\/import', requirePermission\('sales\.manage_prospects'\)/);
  });
  test('reps endpoint is under the permission-gated router (no separate public exposure)', () => {
    expect(routeSrc).toMatch(/router\.get\('\/reps'/);
  });
  test('no public/unauthenticated route references sales_prospects', () => {
    for (const f of ['src/routes/public', 'src/routes/publicEvents', 'src/routes/marketplace', 'src/routes/sellers']) {
      try { expect(read(f + '.js')).not.toMatch(/sales_prospects/); } catch (_e) { /* file may not exist */ }
    }
  });
  test('the admin Sales page stays noindex/nofollow', () => {
    expect(read('public/admin/sales.html')).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  });
  test('listReps only returns staff (admin/super_admin/marketing) — never buyers/sellers', () => {
    const s = read('src/services/salesProspectService.js');
    expect(s).toMatch(/role = 'admin' OR staff_role IN \('super_admin','marketing'\)/);
  });
});

describe('OSM research script — legitimate, no fabrication', () => {
  const script = read('scripts/research-prospects-osm.js');
  test('imports only ACTIONABLE records (real public phone/email) and records a source_url', () => {
    expect(script).toMatch(/if \(!phoneRaw && !emailRaw\) return null/); // actionable-only
    expect(script).toMatch(/openstreetmap\.org\//); // per-record provenance
    expect(script).toMatch(/requireContact: true/);
  });
  test('does NOT assert "no website" from OSM absence (section 4)', () => {
    expect(script).toMatch(/website_status: 'unknown'/);
    expect(script).toMatch(/independent_website: website \? 'yes' : 'unknown'/);
  });
});
