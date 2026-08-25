#!/usr/bin/env node
/* refresh-external-auctions.js — re-run all active AUTHORIZED external-auction sources through the real
 * pipeline (recurring-safe / idempotent), then re-host any third-party hotlinks into managed storage.
 *   railway run node scripts/refresh-external-auctions.js
 * Sources: gsa-auctions, txauction-gov, lmauction-lewis-maese (estate CSV sources are NOT auctions). */
const { runImport } = require('../src/services/eventImport');
const { withTransaction } = require('../src/utils/withTransaction');
const { enrichEvent } = require('../src/services/eventImport/imageEnrichment');
const { Pool } = require('pg');
const { activeEventSql } = require('../src/lib/marketplaceVisibility');

const AUCTION_SOURCES = ['gsa-auctions', 'txauction-gov', 'lmauction-lewis-maese'];

(async () => {
  for (const key of AUCTION_SOURCES) {
    try {
      const r = await runImport({ sourceKey: key, apply: true, trigger: 'manual', withTransaction });
      console.log('IMPORT ' + key + '=' + JSON.stringify(r && r.counters ? r.counters : r));
    } catch (e) { console.log('IMPORT ' + key + '_ERR=' + e.message); }
  }

  // Re-host hotlinks (best-effort) for published auction events lacking a managed image.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = await pool.connect();
  try {
    const rows = (await db.query(
      `SELECT e.id, e.sale_type, e.external_url
         FROM events e
        WHERE e.source='imported' AND e.sale_type='auction' AND e.status IN ('draft','published')
          AND NOT EXISTS (SELECT 1 FROM event_images ei WHERE ei.event_id=e.id AND ei.url ILIKE '%res.cloudinary.com%')`)).rows;
    let stored = 0, none = 0;
    for (const e of rows) { const r = await enrichEvent(e, { db }); if (r.enriched) stored++; else none++; }
    console.log('ENRICH stored=' + stored + ' none=' + none + ' examined=' + rows.length);

    const active = (await db.query(
      `SELECT count(*)::int n FROM events e WHERE ${activeEventSql('e')} AND e.sale_type='auction'`)).rows[0].n;
    const withMgd = (await db.query(
      `SELECT count(*)::int n FROM events e WHERE ${activeEventSql('e')} AND e.sale_type='auction'
         AND EXISTS (SELECT 1 FROM event_images ei WHERE ei.event_id=e.id AND ei.url ILIKE '%res.cloudinary.com%')`)).rows[0].n;
    console.log('ACTIVE_AUCTIONS=' + active + ' WITH_MANAGED_IMAGE=' + withMgd);
  } finally { db.release(); await pool.end(); }
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
