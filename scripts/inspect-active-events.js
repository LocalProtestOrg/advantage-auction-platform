'use strict';
// Read-only: the active public events (health-monitor gate) with map-relevant fields. Privacy-safe:
// no individual name is printed — only org type + whether an organizer would be shown publicly.
require('dotenv').config();
const db = require('../src/db');
(async () => {
  // Discover the events table columns we care about (schema drift safe).
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='events'`)).rows.map(r => r.column_name);
  const has = (c) => cols.includes(c);
  const latCol = ['latitude', 'lat'].find(has);
  const lngCol = ['longitude', 'lng', 'lon'].find(has);
  const marketCol = ['market', 'category', 'market_slug'].find(has) || null;
  const orgIdCol = ['organization_id', 'org_id'].find(has) || null;
  console.log('events coord cols:', latCol, lngCol, '| market col:', marketCol, '| org col:', orgIdCol);

  const sql = `
    SELECT e.id, e.slug, e.title, e.sale_type, e.status, e.start_at, e.end_at,
           e.city, e.state, e.${latCol} AS lat, e.${lngCol} AS lng, e.source,
           ${marketCol ? 'e.' + marketCol + ' AS market,' : "NULL AS market,"}
           ${orgIdCol ? 'o.type AS org_type, o.slug AS org_slug' : "NULL AS org_type, NULL AS org_slug"}
      FROM events e
      ${orgIdCol ? 'LEFT JOIN organizations o ON o.id = e.' + orgIdCol : ''}
     WHERE e.status = 'published' AND (e.end_at IS NULL OR e.end_at >= now())
     ORDER BY e.sale_type, e.title`;
  const { rows } = await db.query(sql);
  console.log('active count:', rows.length);
  for (const r of rows) {
    console.log(JSON.stringify({
      id: r.id, title: r.title, sale_type: r.sale_type, status: r.status,
      start_at: r.start_at, end_at: r.end_at, city: r.city, state: r.state,
      lat: r.lat, lng: r.lng, has_coords: r.lat != null && r.lng != null,
      source: r.source, market: r.market, org_type: r.org_type,
      url: '/event.html?slug=' + r.slug,
    }));
  }
  await db.pool?.end?.().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
