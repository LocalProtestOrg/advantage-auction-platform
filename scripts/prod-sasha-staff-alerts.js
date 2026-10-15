#!/usr/bin/env node
/* prod-sasha-staff-alerts.js — PRODUCTION-guarded staff notification setup (owner request 2026-10-15). Same writes and
   audit events as the Super Admin routes POST /api/admin/sasha/staff-alerts and /staff-alerts/test (adminSasha.js).
   Usage:
     railway run node scripts/prod-sasha-staff-alerts.js set --emails a@x.com,b@y.com --sms +15551234567
     railway run node scripts/prod-sasha-staff-alerts.js test        (one labelled test notice through the real path)
     railway run node scripts/prod-sasha-staff-alerts.js status      (recipients masked + recent deliveries)
   Recipients are passed on the command line, never stored in this file. Uses the DIRECT endpoint. Verifies that
   only the two recipient settings change on "set". */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => { const i = rest.indexOf('--' + name); return i >= 0 ? String(rest[i + 1] || '') : undefined; };

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  if (!['set', 'test', 'status'].includes(cmd)) { console.error('REFUSE: command must be set, test or status.'); return 2; }
  process.env.DATABASE_URL = raw.replace('-pooler', '');
  const db = require('../src/db');
  const alerts = require('../src/services/sasha/staffAlertService');
  const auditService = require('../src/services/auditService');
  const { maskEmailForLog } = require('../src/lib/logSafe');
  const mask = (r) => ({ emails: r.emails.map(maskEmailForLog), sms: r.sms.map((n) => '…' + n.slice(-4)) });
  try {
    const admin = (await db.query(`SELECT id FROM users WHERE lower(email) = 'admin@advantage.bid' AND role = 'admin' LIMIT 1`)).rows[0];
    if (!admin) { console.error('REFUSE: admin account not found for the audit record.'); return 2; }
    if (cmd === 'status') {
      console.log('recipients:', JSON.stringify(mask(await alerts.recipients())));
      console.log('recent deliveries:', JSON.stringify(await alerts.recentDeliveries({ limit: 10 }), null, 1));
      return 0;
    }
    if (cmd === 'set') {
      const emails = arg('emails') !== undefined ? arg('emails').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const sms = arg('sms') !== undefined ? arg('sms').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const h = async () => (await db.query(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config
        WHERE key NOT IN ($1, $2)`, [alerts.EMAIL_KEY, alerts.SMS_KEY])).rows[0].h;
      const otherBefore = await h(); const before = await alerts.recipients();
      const after = await alerts.setRecipients({ emails, sms });
      await auditService.logEvent(db, { eventType: 'sasha.staff_alert_recipients_changed', entityType: 'platform_config', entityId: '00000000-0000-0000-0000-000000000000',
        actorId: admin.id, metadata: { before: mask(before), after: mask(after), via: 'owner-requested ops script 2026-10-15' } });
      const checks = { emails_stored: emails === undefined || after.emails.length === emails.length, sms_stored: sms === undefined || after.sms.length === sms.length,
        other_settings_unchanged: otherBefore === await h() };
      console.log('recipients:', JSON.stringify(mask(after)));
      console.log('Verify:', JSON.stringify(checks));
      const failed = Object.keys(checks).filter((k) => !checks[k]);
      console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
      return failed.length ? 1 : 0;
    }
    // test
    if (process.env.NODE_ENV !== 'production') { console.error('REFUSE: run with the production environment (railway run).'); return 2; }
    const out = await alerts.sendTest(admin.id);
    await auditService.logEvent(db, { eventType: 'sasha.staff_alert_test_sent', entityType: 'platform_config', entityId: '00000000-0000-0000-0000-000000000000',
      actorId: admin.id, metadata: { ref: out.ref, sent: out.sent || 0, failed: out.failed || 0, reason: out.reason || null, via: 'ops script' } });
    console.log('test:', JSON.stringify(out));
    console.log('deliveries:', JSON.stringify((await alerts.recentDeliveries({ limit: 10 })).filter((d) => d.ref === out.ref), null, 1));
    console.log('RESULT: ' + (out.notified && out.sent > 0 && !out.failed ? 'PASS' : 'FAIL'));
    return out.notified && !out.failed ? 0 : 1;
  } finally { await db.pool.end().catch(() => {}); }
})().then((code) => setTimeout(() => process.exit(code || 0), 500)).catch((e) => { console.error(e.message); process.exit(1); });
