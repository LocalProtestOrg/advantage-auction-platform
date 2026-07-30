'use strict';

/**
 * Event Import Framework — Commit 2: provenance (099) + canonical event fields (100).
 * Validates additive/idempotent SQL, FKs, uniqueness, endpoint-guarded scripts, and — critically —
 * that rollback-100 drops ONLY columns 100 added (never a pre-existing events/event_images column).
 * No DB is touched here.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const sql099 = read('db', 'migrations', '099_event_sources.sql');
const sql100 = read('db', 'migrations', '100_event_import_fields.sql');
const prod099 = read('scripts', 'prod-migrate-099.js');
const stg100 = read('scripts', 'stg-migrate-100.js');
const rb099 = read('scripts', 'rollback-099.js');
const rb100 = read('scripts', 'rollback-100.js');

// Pre-existing columns (verified live 2026-07-30). Rollback must never drop any of these.
const EVENTS_PREEXISTING = ['id', 'slug', 'organization_id', 'source', 'market_slug', 'category_slug', 'title',
  'description', 'venue_name', 'address', 'city', 'state', 'zip', 'lat', 'lng', 'start_at', 'end_at', 'timezone',
  'is_recurring', 'recurrence_type', 'recurrence_rule', 'recurrence_parent_id', 'external_url', 'status',
  'submitted_at', 'published_at', 'reviewed_by', 'review_reason', 'is_featured', 'promo_tier', 'promo_starts_at',
  'promo_ends_at', 'attribution_source', 'attribution_url', 'created_at', 'updated_at'];
const IMAGES_PREEXISTING = ['id', 'event_id', 'url', 'position', 'is_cover', 'created_at'];

const stripComments = (s) => s.replace(/--[^\n]*/g, '');       // -- line comments (may contain ';')
const addedCols = (rawSql, table) => {
  const sql = stripComments(rawSql);
  const start = sql.indexOf('ALTER TABLE ' + table + '\n') !== -1 ? sql.indexOf('ALTER TABLE ' + table + '\n') : sql.indexOf('ALTER TABLE ' + table);
  const seg = sql.slice(start, sql.indexOf(';', start));
  return [...seg.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]);
};

describe('099_event_sources.sql — provenance backbone', () => {
  test('new table with FKs to events + import_sources; idempotent', () => {
    expect(sql099).toMatch(/CREATE TABLE IF NOT EXISTS event_sources/);
    expect(sql099).toMatch(/event_id\s+uuid\s+NOT NULL REFERENCES events\(id\)/);
    expect(sql099).toMatch(/source_id\s+uuid\s+NOT NULL REFERENCES import_sources\(id\)/);
  });
  test('idempotent upsert target + change-detection columns + sync_status CHECK', () => {
    expect(sql099).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_event_sources_source_event ON event_sources\(source_id, source_event_id\)/);
    expect(sql099).toMatch(/content_hash/);
    expect(sql099).toMatch(/images_hash/);
    expect(sql099).toMatch(/sync_status[\s\S]*CHECK \(sync_status IN \('active','removed'\)\)/);
  });
});

describe('100_event_import_fields.sql — additive canonical fields', () => {
  test('ADD COLUMN IF NOT EXISTS only; never DROP/ALTER TYPE existing columns', () => {
    expect(sql100).not.toMatch(/DROP COLUMN/);
    expect(sql100).not.toMatch(/ALTER COLUMN/);
    expect(sql100).not.toMatch(/\bTYPE\b/);
    expect(sql100).toMatch(/buyer_premium_bps\s+integer/); // matches auctions
  });
  test('does not widen events.source or touch category_slug primacy', () => {
    expect(sql100).not.toMatch(/source[\s\S]{0,40}CHECK/); // source enum untouched
    expect(sql100).not.toMatch(/DROP.*category_slug|ALTER.*category_slug/);
    expect(sql100).toMatch(/categories\s+text\[\]/); // secondary categories added alongside
  });
  test('image dedup + stable-position unique indexes', () => {
    expect(sql100).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_event_images_content\s+ON event_images\(event_id, content_hash\) WHERE content_hash IS NOT NULL/);
    expect(sql100).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_event_images_position ON event_images\(event_id, position\)/);
  });
  test('adds the expected 31 event + 6 image columns, none pre-existing', () => {
    const ev = addedCols(sql100, 'events');
    const img = addedCols(sql100, 'event_images');
    expect(ev.length).toBe(31);
    expect(img.length).toBe(6);
    expect(ev.filter((c) => EVENTS_PREEXISTING.includes(c))).toEqual([]);   // no collision
    expect(img.filter((c) => IMAGES_PREEXISTING.includes(c))).toEqual([]);
  });
});

describe('rollback-100 symmetry — drops ONLY what 100 added', () => {
  const evAdded = addedCols(sql100, 'events');
  const imgAdded = addedCols(sql100, 'event_images');
  const evDropped = rb100.match(/const EVENT_COLS = \[([\s\S]*?)\]/)[1].match(/'(\w+)'/g).map((s) => s.replace(/'/g, ''));
  const imgDropped = rb100.match(/const IMAGE_COLS = \[([\s\S]*?)\]/)[1].match(/'(\w+)'/g).map((s) => s.replace(/'/g, ''));
  test('every dropped column was added by 100 (no pre-existing column is dropped)', () => {
    expect(evDropped.sort()).toEqual(evAdded.slice().sort());
    expect(imgDropped.sort()).toEqual(imgAdded.slice().sort());
    expect(evDropped.filter((c) => EVENTS_PREEXISTING.includes(c))).toEqual([]);
    expect(imgDropped.filter((c) => IMAGES_PREEXISTING.includes(c))).toEqual([]);
  });
  test('drops the two unique indexes it created', () => {
    expect(rb100).toMatch(/DROP INDEX IF EXISTS uq_event_images_content/);
    expect(rb100).toMatch(/DROP INDEX IF EXISTS uq_event_images_position/);
  });
});

describe('scripts — endpoint + confirmation guards', () => {
  test('099 prod guarded; 100 stg guarded', () => {
    expect(prod099).toMatch(/REFUSE: not the PRODUCTION endpoint/);
    expect(stg100).toMatch(/REFUSE: not the STAGING endpoint/);
    expect(prod099).toContain('INSERT INTO schema_migrations (filename)');
  });
  test('rollbacks require confirmation, prod double-confirm', () => {
    expect(rb099).toMatch(/CONFIRM_ROLLBACK_099 !== 'YES'/);
    expect(rb099).toMatch(/CONFIRM_ROLLBACK_099_PROD !== 'YES'/);
    expect(rb100).toMatch(/CONFIRM_ROLLBACK_100 !== 'YES'/);
    expect(rb100).toMatch(/CONFIRM_ROLLBACK_100_PROD !== 'YES'/);
  });
});
