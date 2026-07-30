'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const sql = read('db', 'migrations', '101_market_resolution.sql');
const prod = read('scripts', 'prod-migrate-101.js');
const rb = read('scripts', 'rollback-101.js');

describe('101_market_resolution.sql — additive + idempotent', () => {
  test('seeds national inactive, sort_order last, ON CONFLICT DO NOTHING', () => {
    expect(sql).toMatch(/INSERT INTO event_markets \(slug, name, is_active, sort_order\)\s*VALUES \('national', 'Nationwide', false, 9999\)\s*ON CONFLICT \(slug\) DO NOTHING/);
  });
  test('backfills houston + nyc centers only when NULL (non-destructive re-run)', () => {
    expect(sql).toMatch(/UPDATE event_markets SET center_lat = 29\.7604[\s\S]*WHERE slug = 'houston'\s+AND center_lat IS NULL/);
    expect(sql).toMatch(/WHERE slug = 'nyc_tristate' AND center_lat IS NULL/);
  });
  test('creates resolution-rule + discovery-queue tables (IF NOT EXISTS) with proper constraints', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS event_market_zips/);
    expect(sql).toMatch(/market_slug text\s+NOT NULL REFERENCES event_markets\(slug\)/);
    expect(sql).toMatch(/CHECK \(zip_prefix IS NOT NULL OR \(city IS NOT NULL AND state IS NOT NULL\)\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS market_candidates/);
    expect(sql).toMatch(/candidate_key\s+text\s+NOT NULL UNIQUE/);
  });
  test('touches no auction/bid/payment/seller/event-row table', () => {
    expect(sql).not.toMatch(/ALTER TABLE (auctions|bids|payments|seller_profiles|events|event_images)\b/);
  });
});

describe('101 scripts — guards + reversibility', () => {
  test('prod-migrate guarded + verifies national/backfill/tables', () => {
    expect(prod).toMatch(/REFUSE: not the PRODUCTION endpoint/);
    expect(prod).toMatch(/slug='national' AND is_active=false/);
    expect(prod).toMatch(/center_lat IS NOT NULL/);
  });
  test('rollback drops both tables, removes national, reverts backfill, guarded', () => {
    expect(rb).toMatch(/DROP TABLE IF EXISTS event_market_zips/);
    expect(rb).toMatch(/DROP TABLE IF EXISTS market_candidates/);
    expect(rb).toMatch(/DELETE FROM event_markets WHERE slug = 'national'/);
    expect(rb).toMatch(/SET center_lat = NULL[\s\S]*WHERE slug IN \('houston','nyc_tristate'\)/);
    expect(rb).toMatch(/CONFIRM_ROLLBACK_101 !== 'YES'/);
    expect(rb).toMatch(/CONFIRM_ROLLBACK_101_PROD !== 'YES'/);
  });
});
