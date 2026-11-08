#!/usr/bin/env node
/* prod-engage-ad-kill-switch.js: PRODUCTION-guarded. Engages the paid-advertising emergency stop
   (platform setting marketing.paid.global_kill = true) as part of the controlled baseline deployment
   (owner decision 2026-11-08). Dry run by default; --apply to engage.

   It ONLY turns the kill switch on, through the same audited path the Emergency Stop button uses
   (configService.setPlatformConfig as a safety stop: audit row with old and new value, owner notice).
   Unlike the button, it makes NO call to Meta: the historical campaigns (Sept 2026, ended) and every campaign record
   stay exactly as they are. While the switch is on, nothing can be created, built or activated. Clearing it is the
   platform owner's decision (Admin, Marketing Agency, Clear Kill Switch); this script never clears it.

   Usage: railway run node scripts/prod-engage-ad-kill-switch.js [--apply] */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const APPLY = process.argv.includes('--apply');
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const db = require('../src/db');
  const configService = require('../src/services/configService');
  const read = async () => {
    const rows = (await db.query(`SELECT key, value FROM platform_config WHERE key IN ('marketing.paid.global_kill', 'marketing.paid.execution_enabled',
      'marketing.destinations.meta_ads_enabled', 'marketing.paid_growth.mode')`)).rows;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  };
  const campaigns = async () => (await db.query(`SELECT md5(coalesce(string_agg(id::text || ':' || state || ':' || coalesce(provider_campaign_id, ''), ',' ORDER BY id), '')) h,
    count(*)::int n FROM marketing_paid_campaigns`)).rows[0];
  try {
    const before = await read();
    const camp = await campaigns();
    console.log('Current:', JSON.stringify(before), '| campaign records:', camp.n);
    if (before['marketing.paid.global_kill'] === true) { console.log('NO-OP: the kill switch is already engaged.'); return 0; }
    if (!APPLY) { console.log('DRY RUN: would set marketing.paid.global_kill = true (audited, owner notified). No Meta call.'); return 0; }
    await configService.setPlatformConfig('marketing.paid.global_kill', true, {
      safetyStop: true, system: 'baseline deployment 2026-11 (owner decision 2026-11-08)',
      source: 'scripts/prod-engage-ad-kill-switch.js', adminPath: '/admin/marketing-agency.html' });
    const after = await read();
    const campAfter = await campaigns();
    const ok = after['marketing.paid.global_kill'] === true && campAfter.h === camp.h && campAfter.n === camp.n;
    console.log('After:', JSON.stringify(after));
    console.log('campaign records unchanged:', campAfter.h === camp.h && campAfter.n === camp.n);
    console.log('RESULT: ' + (ok ? 'PASS (kill switch engaged)' : 'FAIL'));
    return ok ? 0 : 1;
  } finally { await db.pool.end().catch(() => {}); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e.message); process.exit(1); });
