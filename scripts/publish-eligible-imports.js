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
    // Images live in event_images (not a column on events). Count only PUBLICLY-USABLE images
    // (login-gated ppms.gov images do not count), matching the gate/govSurplusPlaceholder logic.
    const rows = (await db.query(
      `SELECT e.id, e.sale_type, e.source, e.title, e.start_at, e.end_at, e.event_format, e.city, e.state,
              e.lat, e.lng, e.organizer_name, e.registration_url, e.bidding_url, e.organizer_website_url,
              e.external_url,
              (SELECT count(*)::int FROM event_images ei
                 WHERE ei.event_id = e.id AND coalesce(ei.url,'') NOT ILIKE '%ppms.gov%') AS image_count
         FROM events e
        WHERE e.source = 'imported' AND e.status = 'draft'`)).rows;
    out.scanned = rows.length;
    for (const e of rows) {
      const r = evaluatePublication(e, {}); // e.image_count drives the image check
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
