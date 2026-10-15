#!/usr/bin/env node
/* prod-marketplace-badge-ships.js — PRODUCTION-guarded change of ONLY platform_settings 'marketplace.badge.ships' to the
   approved wording "Shipping available" (owner approval 2026-10-14/15). Same write as the admin route
   PATCH /api/admin/config/platform (adminConfig.js), plus an audit_log entry. Verifies every other platform setting and
   all shipping eligibility (auctions.shipping_available, lots.shippable, seller capabilities) are unchanged.
   Uses the DIRECT endpoint (never session state on the pooler). Usage: railway run node scripts/prod-marketplace-badge-ships.js */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const KEY = 'marketplace.badge.ships'; const VALUE = 'Shipping available';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const h = async (sql) => (await c.query(sql)).rows[0].h;
    const snap = async () => ({
      otherSettings: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_settings WHERE key <> '${KEY}'`),
      shipping: await h(`SELECT md5(((SELECT coalesce(string_agg(id::text || ':' || coalesce(shipping_available::text,'-'), ',' ORDER BY id), '') FROM auctions) || '|' ||
        (SELECT coalesce(string_agg(id::text || ':' || coalesce(shippable::text,'-'), ',' ORDER BY id), '') FROM lots) || '|' ||
        (SELECT coalesce(string_agg(id::text || ':' || coalesce(capabilities::text,'-'), ',' ORDER BY id), '') FROM seller_profiles))) h`),
    });
    const cur = async () => ((await c.query(`SELECT value FROM platform_settings WHERE key = $1`, [KEY])).rows[0] || {}).value;
    const before = await snap(); const was = await cur();
    const admin = (await c.query(`SELECT id FROM users WHERE lower(email) = 'admin@advantage.bid' AND role = 'admin' LIMIT 1`)).rows[0];
    if (!admin) { console.error('REFUSE: admin account not found.'); return 2; }
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [KEY, JSON.stringify(VALUE), admin.id]);
      await c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('platform_setting_changed', 'platform_settings',
        '00000000-0000-0000-0000-000000000000', $1, $2::jsonb)`, [admin.id, JSON.stringify({ key: KEY, before: was == null ? null : was, after: VALUE, via: 'owner-approved ops script 2026-10-15' })]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('CHANGE FAILED', e.message); return 1; }
    const after = await snap(); const now = await cur();
    const checks = { badge: now === VALUE, other_settings_unchanged: before.otherSettings === after.otherSettings, shipping_eligibility_unchanged: before.shipping === after.shipping };
    console.log(`${KEY}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
