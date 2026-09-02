'use strict';

/**
 * Auction Compliance Review (decision-support) — engine + rules + flags + admin review + integration.
 * Behavioral unit tests for the matching engine (pure, no DB) + source/schema assertions for the flag
 * model, scan behavior, publication integration (non-blocking), admin-only security, and public
 * data-boundary (no compliance internals on public/widget surfaces).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

const c = require('../src/services/complianceService');
const mkRules = (arr) => arr.map((r) => ({ id: r.id || r.code, jurisdiction: null, match_terms: [], reason: 'Possible.', severity: 'medium', category: 'x', ...r, _match: c.compileMatcher(r) }));

// ── Matching engine (behavioral) ────────────────────────────────────────────────
describe('compliance matching engine', () => {
  const rules = mkRules([
    { code: 'firearms', severity: 'high', match_terms: ['rifle', 'shotgun', 'glock', 'ar-15'] },
    { code: 'alcohol', match_terms: ['whiskey', 'wine bottle'] },
    { code: 'ammunition', severity: 'high', match_terms: ['ammunition', 'ammo'] },
    { code: 'nj_hazmat', match_terms: ['fireworks'], jurisdiction: 'NJ' },
  ]);
  const hit = (lot, st) => c.evaluateLot(lot, rules, st).map((h) => h.rule.code);

  test('flags a relevant lot (word/phrase match)', () => {
    expect(hit({ title: 'Winchester rifle', description: 'antique' }, 'PA')).toContain('firearms');
    expect(hit({ title: 'Rare whiskey', description: '' }, 'PA')).toContain('alcohol');
    expect(hit({ title: 'Box of ammo' }, 'PA')).toContain('ammunition');
    expect(hit({ title: 'AR-15 parts kit' }, 'PA')).toContain('firearms'); // hyphenated term
  });
  test('does NOT false-positive on ambiguous unrelated words (shot/barrel/case/vintage)', () => {
    expect(hit({ title: 'Vintage shot glass set', description: 'oak barrel finish, in a display case' }, 'PA')).toEqual([]);
    expect(hit({ title: 'Antique medicine cabinet' }, 'PA')).toEqual([]);
    expect(hit({ title: 'Wine rack (no bottles)', description: 'holds 12' }, 'PA')).toEqual([]); // "wine rack" != "wine bottle"
  });
  test('jurisdiction rules apply only where the auction location matches', () => {
    expect(hit({ title: 'fireworks assortment' }, 'PA')).toEqual([]);   // NJ rule skipped in PA
    expect(hit({ title: 'fireworks assortment' }, 'NJ')).toContain('nj_hazmat');
    expect(hit({ title: 'fireworks assortment' }, null)).toEqual([]);   // unknown jurisdiction → NJ rule not applied indiscriminately
  });
  test('multiple applicable rules all fire; escapeRegex neutralizes specials', () => {
    expect(hit({ title: 'whiskey and a rifle' }, 'PA').sort()).toEqual(['alcohol', 'firearms']);
    expect(c.escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });
});

// ── Rule + flag data model (migration) ──────────────────────────────────────────
describe('migration 123 — rule + flag model', () => {
  const mig = read('db', 'migrations', '123_auction_compliance.sql');
  test('creates compliance_rules with source/jurisdiction/version metadata for future real rules', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS compliance_rules/);
    ['jurisdiction', 'match_terms', 'source_agency', 'source_citation', 'source_url', 'effective_date', 'version', 'active']
      .forEach((col) => expect(mig).toContain(col));
    expect(mig).toMatch(/severity .*CHECK \(severity IN \('low','medium','high'\)\)/);
  });
  test('creates compliance_flags with idempotent UNIQUE(lot_id, rule_id) + review fields + cascade', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS compliance_flags/);
    expect(mig).toMatch(/UNIQUE \(lot_id, rule_id\)/);
    expect(mig).toMatch(/CHECK \(status IN \('open','reviewed_allowed','cleared','auto_cleared','action_taken'\)\)/);
    expect(mig).toMatch(/auction_id .*REFERENCES auctions\(id\) ON DELETE CASCADE/);
    ['reviewed_by', 'reviewed_at', 'admin_notes', 'action'].forEach((col) => expect(mig).toContain(col));
  });
  test('seeds >=10 conservative illustrative rules — "Possible ..." + NO legal conclusions', () => {
    const seeded = (mig.match(/'Possible [^']+'/g) || []).length;
    expect(seeded).toBeGreaterThanOrEqual(10);
    expect(mig).not.toMatch(/illegal in|prohibited in|cannot be sold in|is illegal/i);
    expect(mig).toMatch(/screening rule/i);
  });
  test('a PROD-guarded migration script exists', () => {
    const m = read('scripts', 'prod-migrate-123.js');
    expect(m).toMatch(/ep-proud-leaf-an8pzkib/);   // prod endpoint guard
    expect(m).toMatch(/REFUSE: STAGING/);
  });
});

// ── Scan behavior (source) ──────────────────────────────────────────────────────
describe('scanAuction', () => {
  const src = read('src', 'services', 'complianceService.js');
  test('is best-effort (never throws) and has a fire-and-forget non-blocking variant', () => {
    expect(src).toMatch(/async function scanAuction\(auctionId\) \{\s*try \{/);
    expect(src).toMatch(/function scanAuctionSafe\(auctionId\) \{ scanAuction\(auctionId\)\.catch/);
    expect(src).toMatch(/return \{ ok: false, reason: 'error'/);
  });
  test('is idempotent (ON CONFLICT DO NOTHING) and auto-clears open non-matching flags (history preserved)', () => {
    expect(src).toMatch(/ON CONFLICT \(lot_id, rule_id\) DO NOTHING/);
    expect(src).toMatch(/SET status='auto_cleared'.*WHERE lot_id=\$1 AND status='open'/s);
  });
  test('scans only lot title/description/category (no unrelated private user data)', () => {
    expect(src).toMatch(/\[lot\.title, lot\.description, lot\.category\]/); // evaluateLot reads only these
    const scanBody = src.slice(src.indexOf('async function scanAuction(auctionId)'), src.indexOf('function scanAuctionSafe'));
    expect(scanBody).toMatch(/SELECT id, title, description, category FROM lots/);
    expect(scanBody).not.toMatch(/\bemail\b|\bphone\b|password/);
  });
});

// ── Publication integration (non-blocking) ──────────────────────────────────────
describe('publication integration', () => {
  const auc = read('src', 'services', 'auctionService.js');
  const adm = read('src', 'routes', 'admin.js');
  test('pro auto-publish + individual submit both trigger a NON-blocking scan (fire-and-forget)', () => {
    // both branches of sellerSubmitAuction call scanAuctionSafe (not awaited → cannot block/fail publication)
    expect((auc.match(/scanAuctionSafe\(auctionId\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(auc).not.toMatch(/await require\('\.\/complianceService'\)\.scanAuction\b/); // never awaited in the publish path
  });
  test('admin publish also triggers a scan (best-effort)', () => {
    expect(adm).toMatch(/require\('\.\.\/services\/complianceService'\)\.scanAuctionSafe\(auctionId\)/);
  });
  test('pro auto-publish itself is unchanged (still publishes via publishAuction) — no regression', () => {
    expect(auc).toMatch(/if \(elig\.eligible\) \{[\s\S]*?await publishAuction\(auctionId, userId\)/);
  });
  test('compliance does NOT add a second owner SMS', () => {
    expect(read('src', 'services', 'complianceService.js')).not.toMatch(/ownerAlert|notifyOwner|sendSMS/);
  });
});

// ── Admin security + moderation ─────────────────────────────────────────────────
describe('admin compliance route (admin-only) + moderation', () => {
  const route = read('src', 'routes', 'adminCompliance.js');
  const svc = read('src', 'services', 'complianceService.js');
  test('every endpoint is admin-role gated', () => {
    expect(route).toMatch(/router\.use\(authMiddleware, roleMiddleware\(\['admin'\]\)\)/);
    ['/auctions', '/flags/:flagId/review', '/lots/:lotId/withdraw', '/auctions/:auctionId/unpublish', '/auctions/:auctionId/rescan']
      .forEach((p) => expect(route).toContain(p));
  });
  test('review + moderation use the acting admin id (server) and are audited', () => {
    expect(route).toMatch(/reviewFlag\(req\.user\.id/);
    expect(route).toMatch(/withdrawLot\(req\.user\.id/);
    expect(route).toMatch(/unpublishAuction\(req\.user\.id/);
    expect(svc).toMatch(/writeAuditLog\(\{ event_type: 'compliance\.flag_reviewed'/);
    expect(svc).toMatch(/writeAuditLog\(\{ event_type: 'compliance\.lot_withdrawn'/);
    expect(svc).toMatch(/writeAuditLog\(\{ event_type: 'compliance\.auction_unpublished'/);
  });
  test('moderation reuses the existing lot/auction state model (no parallel lifecycle)', () => {
    expect(svc).toMatch(/UPDATE lots SET state='withdrawn'/);
    expect(svc).toMatch(/UPDATE auctions SET state='draft'/);
  });
  test('mounted at /api/admin/compliance + admin nav link', () => {
    expect(read('server.js')).toMatch(/app\.use\('\/api\/admin\/compliance', require\('\.\/src\/routes\/adminCompliance'\)\)/);
    expect(read('public', 'widgets', 'shared', 'admin-nav.js')).toMatch(/\/admin\/compliance\.html/);
  });
});

// ── Public/private data boundary (compliance is internal only) ──────────────────
describe('no compliance leakage on public/seller/widget surfaces', () => {
  test('public + widget feeds never reference compliance tables/fields', () => {
    ['src/routes/public.js', 'src/routes/publicWidget.js', 'src/services/widgetService.js', 'public/embed/auctions.html']
      .forEach((f) => expect(read(...f.split('/'))).not.toMatch(/compliance_flag|compliance_rule|complianceService/i));
  });
  test('admin compliance page carries the decision-support disclaimer (not a legal claim)', () => {
    const page = read('public', 'admin', 'compliance.html');
    expect(page).toMatch(/not legal advice|review suggested|decision support/i);
    expect(page).not.toMatch(/is illegal|prohibited in [A-Z]{2}/);
  });
});
