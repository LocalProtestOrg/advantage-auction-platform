#!/usr/bin/env node
/* rollback-100.js — reverse 100_event_import_fields.sql. DESTRUCTIVE (drops the columns/indexes it added).
 * Only drops columns THIS migration added (never pre-existing events/event_images columns). Every existing
 * serializer is an allowlist, so these columns are invisible to the app until read → rollback is inert.
 * Guarded: CONFIRM_ROLLBACK_100=YES; production also CONFIRM_ROLLBACK_100_PROD=YES + owner approval. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const EVENT_COLS = [
  'subtitle', 'sale_type', 'event_format', 'organizer_name', 'organizer_logo_url', 'organizer_website_url',
  'contact_name', 'contact_phone', 'contact_email', 'registration_url', 'bidding_url', 'sale_hours',
  'preview_start', 'preview_end', 'pickup_start', 'pickup_end', 'closing_schedule', 'shipping_available',
  'local_pickup_available', 'buyer_premium_bps', 'payment_methods', 'terms_text', 'tags', 'categories',
  'source_last_updated_at', 'content_hash', 'market_resolved_via', 'geocoding_status', 'geocoding_source',
  'location_fingerprint', 'geocoded_at',
];
const IMAGE_COLS = ['source_url', 'content_hash', 'public_id', 'width', 'height', 'alt_text'];
const SQL = `
BEGIN;
  DROP INDEX IF EXISTS uq_event_images_content;
  DROP INDEX IF EXISTS uq_event_images_position;
  ALTER TABLE events        ${EVENT_COLS.map((c) => 'DROP COLUMN IF EXISTS ' + c).join(', ')};
  ALTER TABLE event_images  ${IMAGE_COLS.map((c) => 'DROP COLUMN IF EXISTS ' + c).join(', ')};
  DELETE FROM schema_migrations WHERE filename = '100_event_import_fields.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_100 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_100=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_100_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_100_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 100 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='events' AND column_name='buyer_premium_bps'")).rows[0].c === 0;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
