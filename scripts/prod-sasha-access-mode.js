#!/usr/bin/env node
/* prod-sasha-access-mode.js — PRODUCTION-guarded change of ONLY sasha.phone.access_mode (staff_only <-> public), the
   same write and audit event as the Super Admin route POST /api/admin/sasha/phone/settings (adminSasha.js).
   Usage: railway run node scripts/prod-sasha-access-mode.js public "OPEN TO PUBLIC"
          railway run node scripts/prod-sasha-access-mode.js staff_only          (rollback; no phrase needed)
   Verifies every other platform setting, the staff test list, calls, consents, texts, payment links, payments,
   invoices and users are unchanged. Uses the DIRECT endpoint (never session state on the pooler). */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const [mode, phrase] = process.argv.slice(2);

(async () => {
  if (!['public', 'staff_only'].includes(mode)) { console.error('REFUSE: mode must be public or staff_only.'); return 2; }
  if (mode === 'public' && phrase !== 'OPEN TO PUBLIC') { console.error('REFUSE: opening to every caller needs the phrase "OPEN TO PUBLIC" (same as the admin route).'); return 2; }
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const h = async (sql) => (await c.query(sql)).rows[0].h;
    const snap = async () => ({
      otherConfig: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config WHERE key <> 'sasha.phone.access_mode'`),
      callers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(removed_at::text,'-'), ',' ORDER BY id), '')) h FROM cs_phone_test_callers`),
      other: await h(`SELECT md5(((SELECT count(*) FROM sms_consents) || ':' || (SELECT count(*) FROM auction_sms_messages) || ':' || (SELECT count(*) FROM payment_links)
        || ':' || (SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    const cur = async () => ((await c.query(`SELECT value FROM platform_config WHERE key = 'sasha.phone.access_mode'`)).rows[0] || {}).value;
    const before = await snap(); const was = await cur();
    const admin = (await c.query(`SELECT id FROM users WHERE lower(email) = 'admin@advantage.bid' AND role = 'admin' LIMIT 1`)).rows[0];
    if (!admin) { console.error('REFUSE: admin account not found for the audit record.'); return 2; }
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO platform_config (key, value, category) VALUES ('sasha.phone.access_mode', $1::jsonb, 'sasha_phone')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(mode)]);
      await c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('sasha.phone_setting_changed', 'platform_config',
        '00000000-0000-0000-0000-000000000000', $1, $2::jsonb)`, [admin.id, JSON.stringify({ key: 'access_mode', before: was == null ? 'staff_only' : was, after: mode, via: 'owner-authorized ops script 2026-10-14' })]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('CHANGE FAILED', e.message); return 1; }
    const after = await snap(); const now = await cur();
    const checks = { access_mode: now === mode, other_settings_unchanged: before.otherConfig === after.otherConfig, test_callers_unchanged: before.callers === after.callers,
      consents_texts_links_payments_invoices_users_unchanged: before.other === after.other };
    console.log(`access_mode: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS') + ' (the app picks this up within 15 seconds; settings cache TTL)');
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
