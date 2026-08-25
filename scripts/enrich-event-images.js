#!/usr/bin/env node
/* enrich-event-images.js — best-effort image enrichment for imported auction events without a usable
 * image. Never fails ingestion; only ADDS images where a legitimately-public one is retrievable.
 *   node scripts/enrich-event-images.js         # apply
 *   node scripts/enrich-event-images.js --dry   # report only
 * Reports events examined / real images stored / remaining-on-placeholder + reasons.
 */
const { Pool } = require('pg');
const { enrichEvent } = require('../src/services/eventImport/imageEnrichment');

const DRY = process.argv.includes('--dry');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = await pool.connect();
  const out = { examined: 0, stored: 0, remaining_placeholder: 0, reasons: {} };
  try {
    // Published external auction events that currently have no usable stored image.
    const rows = (await db.query(
      `SELECT e.id, e.sale_type, e.external_url,
              (SELECT count(*)::int FROM event_images ei WHERE ei.event_id = e.id
                 AND coalesce(ei.url,'') NOT ILIKE '%ppms.gov%') AS usable_images
         FROM events e
        WHERE e.source = 'imported' AND e.sale_type = 'auction' AND e.status = 'published'`)).rows;
    for (const e of rows) {
      out.examined++;
      if (e.usable_images > 0) { out.reasons['already_has_image'] = (out.reasons['already_has_image'] || 0) + 1; continue; }
      const r = DRY
        ? { enriched: false, reason: require('../src/services/eventImport/imageEnrichment').candidateImageUrl(e) ? 'would_attempt' : 'no_public_image_available' }
        : await enrichEvent(e, { db });
      if (r.enriched) out.stored++;
      else { out.remaining_placeholder++; out.reasons[r.reason] = (out.reasons[r.reason] || 0) + 1; }
    }
    console.log((DRY ? 'DRYRUN=' : 'ENRICH=') + JSON.stringify(out));
  } finally { db.release(); await pool.end(); }
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
