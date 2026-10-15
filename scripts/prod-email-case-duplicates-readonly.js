#!/usr/bin/env node
/* prod-email-case-duplicates-readonly.js — READ-ONLY: accounts whose emails differ only by letter case or surrounding
   spaces (security audit 2026-10-15, owner item 6). Nothing is merged or changed.
   Usage: railway run node scripts/prod-email-case-duplicates-readonly.js
   Prints counts and masked addresses only. Direct endpoint + BEGIN TRANSACTION READ ONLY (scripts/lib/prodReadOnly.js). */
const { withProdReadOnly } = require('./lib/prodReadOnly');
const { maskEmailForLog } = require('../src/lib/logSafe');
const PROD_EP = 'ep-proud-leaf-an8pzkib';

(async () => {
  if (!String(process.env.DATABASE_URL || '').includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); process.exit(2); }
  await withProdReadOnly(async (q) => {
    const total = (await q(`SELECT count(*)::int n, count(*) FILTER (WHERE email <> lower(btrim(email)))::int not_normalised FROM users`))[0];
    console.log('users:', total.n, '| emails not stored lower-case/trimmed:', total.not_normalised);
    const groups = await q(`SELECT lower(btrim(email)) k, count(*)::int n,
        json_agg(json_build_object('role', role, 'active', is_active, 'staff', staff_role IS NOT NULL, 'created', created_at::date,
          'last_login', last_login_at::date, 'has_password', password_hash IS NOT NULL) ORDER BY created_at) accounts
      FROM users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC`);
    console.log('case-variant duplicate groups:', groups.length);
    for (const g of groups) console.log(' ', maskEmailForLog(g.k), 'x' + g.n, JSON.stringify(g.accounts));
    const idx = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users' AND indexdef ILIKE '%email%'`);
    console.log('email indexes:', idx.map((i) => i.indexdef).join(' | '));
  });
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
