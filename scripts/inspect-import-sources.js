'use strict';
// Read-only: report every import source + a quick expired/active record breakdown.
// Usage: node scripts/inspect-import-sources.js
require('dotenv').config();
const db = require('../src/db');

(async () => {
  const host = (() => { try { return new URL(process.env.DATABASE_URL).host; } catch { return '(local)'; } })();
  console.log('DB host:', host);
  const { rows: sources } = await db.query(
    `SELECT id, key, name, kind, status, auto_publish, weekly_cap,
            COALESCE(jsonb_array_length(COALESCE((config->>'csvText')::text, '')::jsonb), NULL) AS ignore
       FROM import_sources ORDER BY name`).catch(async () => ({ rows: (await db.query(
    `SELECT id, key, name, kind, status, auto_publish, weekly_cap FROM import_sources ORDER BY name`)).rows }));
  for (const s of sources) {
    // per-source event stats via event_sources link
    const st = (await db.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE e.status='published' AND (e.end_at IS NULL OR e.end_at >= now()))::int active_pub,
              count(*) FILTER (WHERE e.end_at IS NOT NULL AND e.end_at < now())::int expired,
              count(*) FILTER (WHERE e.status='draft')::int draft
         FROM event_sources es JOIN events e ON e.id = es.event_id
        WHERE es.source_id = $1`, [s.id])).rows[0] || {};
    console.log(JSON.stringify({
      key: s.key, name: s.name, status: s.status, kind: s.kind,
      auto_publish: s.auto_publish, weekly_cap: s.weekly_cap,
      events_total: st.total || 0, events_active_public: st.active_pub || 0,
      events_expired: st.expired || 0, events_draft: st.draft || 0,
    }));
  }
  await db.pool?.end?.().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
