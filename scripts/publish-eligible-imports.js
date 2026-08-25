#!/usr/bin/env node
/* publish-eligible-imports.js — one-time/idempotent backlog replenishment.
 *
 * Re-evaluates every IMPORTED, DRAFT event against the (now-fixed) publicationGate and publishes the
 * ones that qualify — restoring the public inventory that had drained because GSA/Federal-Surplus
 * auctions were stuck in draft (login-gated images) and previously-published events expired.
 *
 * SAFETY: only ever touches source='imported' AND status='draft'. Never native seller auctions, never
 * already-published or archived rows. The gate enforces future-dated + host-attributed + valid, so
 * expired/untrusted events are NOT published. Publishing = status='published', published_at=now().
 *   node scripts/publish-eligible-imports.js           # apply
 *   node scripts/publish-eligible-imports.js --dry     # report only, write nothing
 */
const { Pool } = require('pg');
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');

const DRY = process.argv.includes('--dry');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = await pool.connect();
  const out = { scanned: 0, published: { auction: 0, estate_sale: 0, other: 0 }, blocked: 0, blockReasons: {} };
  try {
    const rows = (await db.query(
      `SELECT id, sale_type, source, title, start_at, end_at, event_format, city, state, lat, lng,
              organizer_name, registration_url, bidding_url, organizer_website_url, external_url, cover_image_url
         FROM events
        WHERE source = 'imported' AND status = 'draft'`)).rows;
    out.scanned = rows.length;
    for (const e of rows) {
      const r = evaluatePublication(e, {});
      if (r.ready) {
        if (!DRY) {
          // Guarded: re-assert the row is still an imported draft at write time.
          await db.query(
            `UPDATE events SET status = 'published', published_at = now(), updated_at = now()
              WHERE id = $1 AND source = 'imported' AND status = 'draft'`, [e.id]);
        }
        const k = e.sale_type === 'auction' ? 'auction' : (e.sale_type === 'estate_sale' ? 'estate_sale' : 'other');
        out.published[k]++;
      } else {
        out.blocked++;
        for (const reason of r.reasons) out.blockReasons[reason] = (out.blockReasons[reason] || 0) + 1;
      }
    }
    console.log((DRY ? 'DRYRUN=' : 'PUBLISHED=') + JSON.stringify(out));
  } finally { db.release(); await pool.end(); }
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
