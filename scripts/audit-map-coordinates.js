#!/usr/bin/env node
'use strict';
/* READ-ONLY map-coordinate audit for the imported-events-on-map defect (item 5). Writes nothing.
 *   railway run --service advantage-auction-platform node scripts/audit-map-coordinates.js */
const db = require('../src/db');
(async function () {
  const one = async (s) => (await db.query(s)).rows[0];
  const nativeA = await one("SELECT count(*)::int c, count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int geo FROM auctions WHERE state IN ('published','active') AND is_archived IS NOT TRUE");
  const evAll = await one("SELECT count(*)::int c, count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int geo FROM events WHERE status='published' AND (end_at IS NULL OR end_at>=now())");
  const evAuc = await one("SELECT count(*)::int c, count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int geo FROM events WHERE status='published' AND (end_at IS NULL OR end_at>=now()) AND sale_type='auction'");
  const evEs = await one("SELECT count(*)::int c, count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int geo FROM events WHERE status='published' AND (end_at IS NULL OR end_at>=now()) AND (sale_type IS DISTINCT FROM 'auction')");
  const evOnline = await one("SELECT count(*)::int c, count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int geo FROM events WHERE status='published' AND (end_at IS NULL OR end_at>=now()) AND event_format='online'");
  console.log('=== MAP COORDINATE AUDIT (public, active) ===');
  console.log('native auctions:', nativeA.c, '| with coords:', nativeA.geo);
  console.log('public events total:', evAll.c, '| with coords:', evAll.geo, '| missing:', evAll.c - evAll.geo);
  console.log('  event auctions:', evAuc.c, '| with coords:', evAuc.geo);
  console.log('  event estate sales:', evEs.c, '| with coords:', evEs.geo);
  console.log('  online events:', evOnline.c, '| with coords:', evOnline.geo, '(online expected to have no public pin)');
  await db.pool.end();
})().catch((e) => { console.error('audit failed:', e && e.message); process.exitCode = 1; });
