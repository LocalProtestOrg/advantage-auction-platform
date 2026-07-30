'use strict';

/**
 * Event Import Framework — Commit 1: source registry (097) + run ledger (098).
 * Validates the migration SQL is additive/idempotent, matches the plan's schema, and that the
 * apply/rollback scripts carry the house endpoint + confirmation guards. No DB is touched here.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const sql097 = read('db', 'migrations', '097_import_sources.sql');
const sql098 = read('db', 'migrations', '098_import_runs.sql');
const prod097 = read('scripts', 'prod-migrate-097.js');
const stg097 = read('scripts', 'stg-migrate-097.js');
const prod098 = read('scripts', 'prod-migrate-098.js');
const rb097 = read('scripts', 'rollback-097.js');
const rb098 = read('scripts', 'rollback-098.js');
const owner = read('scripts', 'verify-import-owner.js');

describe('097_import_sources.sql — additive, idempotent registry', () => {
  test('creates import_sources with IF NOT EXISTS; owner FK to organizations', () => {
    expect(sql097).toMatch(/CREATE TABLE IF NOT EXISTS import_sources/);
    expect(sql097).toMatch(/owner_organization_id\s+uuid\s+NOT NULL REFERENCES organizations\(id\)/);
    expect(sql097).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });
  test('compliance columns: media_policy default link_only + CHECK, kind CHECK, auth_env_var (name not secret)', () => {
    expect(sql097).toMatch(/media_policy[\s\S]*DEFAULT 'link_only'[\s\S]*CHECK \(media_policy IN \('none','link_only','mirror'\)\)/);
    expect(sql097).toMatch(/kind[\s\S]*CHECK \(kind IN \('csv','rest','rss','xml','json','partner','manual'\)\)/);
    expect(sql097).toMatch(/auth_env_var[\s\S]*never a secret/);
    expect(sql097).toMatch(/terms_attested_(by|at|url)/);
  });
  test('touches NO existing production table', () => {
    expect(sql097).not.toMatch(/ALTER TABLE (auctions|bids|payments|seller_profiles|events|organizations)\b/);
    expect(sql097).toContain('BEGIN;');
    expect(sql097).toContain('COMMIT;');
  });
});

describe('098_import_runs.sql — run ledger + per-record trail + weekly claim', () => {
  test('both tables IF NOT EXISTS with correct FKs', () => {
    expect(sql098).toMatch(/CREATE TABLE IF NOT EXISTS import_runs/);
    expect(sql098).toMatch(/source_id\s+uuid\s+NOT NULL REFERENCES import_sources\(id\)/);
    expect(sql098).toMatch(/CREATE TABLE IF NOT EXISTS import_run_items/);
    expect(sql098).toMatch(/run_id\s+uuid\s+NOT NULL REFERENCES import_runs\(id\)/);
    expect(sql098).toMatch(/event_id\s+uuid\s+REFERENCES events\(id\)/);
  });
  test('weekly run-claim = partial UNIQUE index on (source_id, scheduled_for) WHERE trigger=scheduled', () => {
    expect(sql098).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_import_runs_scheduled_claim[\s\S]*ON import_runs\(source_id, scheduled_for\) WHERE trigger = 'scheduled'/);
  });
  test('outcome + trigger + status CHECK enums per plan', () => {
    expect(sql098).toMatch(/outcome[\s\S]*CHECK \(outcome IN \('created','updated','unchanged','duplicate','ambiguous','rejected_quality','failed'\)\)/);
    expect(sql098).toMatch(/trigger[\s\S]*CHECK \(trigger IN \('scheduled','manual','backfill'\)\)/);
    expect(sql098).toMatch(/status[\s\S]*CHECK \(status IN \('running','completed','partial','failed'\)\)/);
  });
});

describe('apply scripts — endpoint-guarded + idempotent ledger', () => {
  test('prod scripts refuse staging / non-prod endpoints; stg scripts refuse prod', () => {
    for (const s of [prod097, prod098]) {
      expect(s).toContain("PROD_EP = 'ep-proud-leaf-an8pzkib'");
      expect(s).toMatch(/REFUSE: STAGING endpoint/);
      expect(s).toMatch(/REFUSE: not the PRODUCTION endpoint/);
    }
    expect(stg097).toMatch(/REFUSE: PRODUCTION endpoint/);
    expect(stg097).toMatch(/REFUSE: not the STAGING endpoint/);
  });
  test('records the ledger row and verifies before reporting PASS', () => {
    for (const s of [prod097, stg097, prod098]) {
      expect(s).toContain('INSERT INTO schema_migrations (filename)');
      expect(s).toMatch(/SKIP apply \(already recorded/); // idempotent re-run
      expect(s).toMatch(/RESULT: /);
    }
  });
});

describe('rollback scripts — guarded + FK-safe drop order', () => {
  test('098 drops items before runs; 097 drops sources; both delete their ledger row', () => {
    expect(rb098).toMatch(/DROP TABLE IF EXISTS import_run_items;[\s\S]*DROP TABLE IF EXISTS import_runs;/);
    expect(rb098).toContain("DELETE FROM schema_migrations WHERE filename = '098_import_runs.sql'");
    expect(rb097).toMatch(/DROP TABLE IF EXISTS import_sources;/);
    expect(rb097).not.toMatch(/DROP TABLE[^;]*CASCADE/); // plain drop → fails safely if 098 tables still reference it
  });
  test('destructive confirmation guards, prod double-confirm', () => {
    expect(rb097).toMatch(/CONFIRM_ROLLBACK_097 !== 'YES'/);
    expect(rb097).toMatch(/CONFIRM_ROLLBACK_097_PROD !== 'YES'/);
    expect(rb098).toMatch(/CONFIRM_ROLLBACK_098 !== 'YES'/);
    expect(rb098).toMatch(/CONFIRM_ROLLBACK_098_PROD !== 'YES'/);
  });
});

describe('owner verification — read-only, and NO owner UUID in application code', () => {
  test('verify-import-owner.js is read-only (no writes) and checks the approved org', () => {
    expect(owner).toContain('a9a2f8c6-5929-4335-a453-ffef96270e5c');
    expect(owner).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/); // read-only
    expect(owner).toMatch(/lifecycle_state === 'active_partner'/);
  });
  test('the canonical owner UUID is NOT hardcoded anywhere under src/ (runtime-resolved only)', () => {
    const hits = [];
    (function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else if (/\.(js|ts|sql)$/.test(name) && fs.readFileSync(full, 'utf8').includes('a9a2f8c6-5929-4335-a453-ffef96270e5c')) hits.push(full);
      }
    })(path.join(root, 'src'));
    expect(hits).toEqual([]);
  });
});
