#!/usr/bin/env node
/* sasha-phone-normalization-report.js — READ-ONLY dry run for Phone Sasha caller verification.
   Classifies every users.phone with src/lib/phoneNumber.normalizeUsPhone and reports:
     - counts by status (ok / empty / extension / international / invalid) and by reason
     - duplicate normalized numbers shared by more than one account (these can never identify a caller by phone)
     - accounts whose phone is usable for a verification code (ok AND not shared)
   Nothing is written: the transaction is READ ONLY. Numbers are masked (last 2 digits only); no names or emails.

     railway run node scripts/sasha-phone-normalization-report.js */
const { normalizeUsPhone } = require('../src/lib/phoneNumber');

(async () => {
  process.env.DATABASE_URL = (process.env.DATABASE_URL || '').replace('-pooler', '');
  const db = require('../src/db');
  const c = await db.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const rows = (await c.query(`SELECT u.id, u.phone, u.role, u.is_demo, COALESCE(u.is_active, true) AS active,
        (u.staff_role IS NOT NULL) AS staff, EXISTS (SELECT 1 FROM seller_profiles sp WHERE sp.user_id = u.id) AS seller FROM users u`)).rows;
    const byStatus = {}; const byReason = {}; const byE164 = new Map(); const samples = {};
    for (const r of rows) {
      const n = normalizeUsPhone(r.phone);
      byStatus[n.status] = (byStatus[n.status] || 0) + 1;
      if (n.status !== 'ok' && n.status !== 'empty') {
        byReason[n.reason] = (byReason[n.reason] || 0) + 1;
        const masked = String(r.phone).replace(/\d(?=(?:\D*\d){2})/g, '•');
        (samples[n.status] = samples[n.status] || []).length < 5 && samples[n.status].push(masked);
      }
      if (n.e164) { if (!byE164.has(n.e164)) byE164.set(n.e164, []); byE164.get(n.e164).push(r); }
    }
    const dupGroups = [...byE164.values()].filter((g) => g.length > 1);
    const usable = [...byE164.values()].filter((g) => g.length === 1).map((g) => g[0]);
    const out = {
      total_users: rows.length,
      by_status: byStatus,
      not_normalizable_by_reason: byReason,
      masked_samples_not_normalizable: samples,
      duplicate_numbers: {
        groups: dupGroups.length,
        accounts_in_groups: dupGroups.reduce((s, g) => s + g.length, 0),
        group_sizes: dupGroups.map((g) => g.length).sort((a, b) => b - a),
        groups_mixing_demo_or_staff: dupGroups.filter((g) => g.some((r) => r.is_demo || r.staff || r.role === 'admin')).length,
        groups_with_a_seller: dupGroups.filter((g) => g.some((r) => r.seller)).length,
      },
      usable_for_verification_code: {
        accounts: usable.length,
        real_active_non_staff: usable.filter((r) => r.active && !r.is_demo && !r.staff && r.role !== 'admin').length,
        sellers: usable.filter((r) => r.seller).length,
      },
    };
    console.log(JSON.stringify(out, null, 2));
    await c.query('ROLLBACK');
  } finally { c.release(); await db.pool.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
