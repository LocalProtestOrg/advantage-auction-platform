#!/usr/bin/env node
/* prod-postdeploy-readonly-check.js — read-only production checks after a deploy (security audit 2026-10-15).
   Usage: railway run node scripts/prod-postdeploy-readonly-check.js [sinceIsoUtc]
   Each check runs in its own direct-endpoint BEGIN TRANSACTION READ ONLY ... ROLLBACK (scripts/lib/prodReadOnly.js),
   so one failing check cannot hide the others. Prints counts only, never personal data. */
const { withProdReadOnly } = require('./lib/prodReadOnly');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const since = process.argv[2] || new Date(Date.now() - 3600e3).toISOString();

const CHECKS = [
  ['sasha phone access_mode / enabled', `SELECT (SELECT value FROM platform_config WHERE key='sasha.phone.access_mode') access_mode,
    (SELECT value FROM platform_config WHERE key='sasha.phone.enabled') enabled`],
  ['real calls since (total / completed / failed / open >15m)', `SELECT count(*) total, count(*) FILTER (WHERE status='completed') completed,
    count(*) FILTER (WHERE status='failed') failed, count(*) FILTER (WHERE ended_at IS NULL AND started_at < now() - interval '15 minutes') stale
    FROM cs_calls WHERE NOT is_simulated AND started_at >= $1`, true],
  ['last real call (UTC) / end reason', `SELECT started_at, status, end_reason, duration_seconds FROM cs_calls WHERE NOT is_simulated ORDER BY started_at DESC LIMIT 1`],
  ['phone-call codes since (by status)', `SELECT coalesce(json_object_agg(status, n), '{}') s FROM (SELECT status, count(*) n FROM cs_phone_verifications WHERE created_at >= $1 GROUP BY status) x`, true],
  ['website phone codes since (by status)', `SELECT coalesce(json_object_agg(status, n), '{}') s FROM (SELECT status, count(*) n FROM account_phone_verifications WHERE created_at >= $1 GROUP BY status) x`, true],
  ['users registered since', `SELECT count(*) n FROM users WHERE created_at >= $1`, true],
  ['payments since (by status)', `SELECT coalesce(json_object_agg(status, n), '{}') s FROM (SELECT status, count(*) n FROM payments WHERE created_at >= $1 GROUP BY status) x`, true],
  ['lots charged per-lot AND in a paid combined invoice', `SELECT count(*) n FROM payments p JOIN buyer_auction_invoices i
    ON i.auction_id = p.auction_id AND i.buyer_user_id = p.buyer_user_id AND i.status = 'paid' AND i.payment_id IS DISTINCT FROM p.id
    WHERE p.lot_id IS NOT NULL AND p.status IN ('succeeded','paid') AND p.created_at >= $1`, true],
  ['auctions created since (by state)', `SELECT coalesce(json_object_agg(state, n), '{}') s FROM (SELECT state, count(*) n FROM auctions WHERE created_at >= $1 GROUP BY state) x`, true],
  ['live auctions (published / active, not archived)', `SELECT count(*) FILTER (WHERE state='published') published, count(*) FILTER (WHERE state='active') active
    FROM auctions WHERE NOT coalesce(is_archived,false)`],
  ['audit_log since (count / last)', `SELECT count(*) n, max(created_at) last FROM audit_log WHERE created_at >= $1`, true],
];

(async () => {
  if (!String(process.env.DATABASE_URL || '').includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); process.exit(2); }
  console.log('since', since);
  for (const [label, sql, useSince] of CHECKS) {
    try {
      const rows = await withProdReadOnly((q) => q(sql, useSince ? [since] : []));
      console.log(label.padEnd(58), JSON.stringify(rows[0] || null));
    } catch (e) { console.log(label.padEnd(58), 'ERR ' + e.message); }
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
