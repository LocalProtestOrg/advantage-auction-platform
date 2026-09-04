'use strict';

/**
 * marketingLedgerService — the internal marketing money layer (Concept B). Append-only ledger + a
 * DB-enforced per-job ceiling + the Growth Pool. NONE of this is seller-facing and NONE of it carries a
 * seller identity — it is Advantage.Bid's own money, structurally separate from the seller package charge.
 *
 * Guarantees:
 *   • direct reserved + spent can NEVER exceed direct_max_cents (conditional UPDATE + DB CHECK backstop).
 *   • idempotency keys make every op retry-safe (a repeat writes no second ledger row / no double spend).
 *   • unused direct capacity becomes a Growth Pool contribution EXACTLY once (unused_swept guard).
 *   • Growth spend beyond the accumulated pool is capped by the monthly autonomous authority + owner grants.
 */

const db = require('../db');
const policy = require('../lib/marketingPolicy');
const marketingConfig = require('./marketingConfigService');

const cents = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
const monthStart = (d) => { const dt = d ? new Date(d) : new Date(); return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)).toISOString().slice(0, 10); };

// Insert a ledger row idempotently. Returns true if inserted, false if the key already existed.
async function insertLedger(client, row) {
  const r = await client.query(
    `INSERT INTO marketing_ledger (marketing_job_id, entry_type, amount_cents, reservation_id, idempotency_key, campaign_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [row.jobId, row.entryType, cents(row.amountCents), row.reservationId || null, row.idempotencyKey, row.campaignId || null, row.metadata ? JSON.stringify(row.metadata) : null]);
  return r.rowCount > 0;
}
async function insertGrowthLedger(client, row) {
  const r = await client.query(
    `INSERT INTO growth_pool_ledger (entry_type, amount_cents, marketing_job_id, market_id, campaign_id, occurred_month, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [row.entryType, cents(row.amountCents), row.jobId || null, row.marketId || null, row.campaignId || null, monthStart(row.month), row.idempotencyKey, row.metadata ? JSON.stringify(row.metadata) : null]);
  return r.rowCount > 0;
}

/**
 * Freeze the allocation for a marketing job (at package confirmation) and seed the ledgers. Idempotent:
 * re-running does nothing once the allocation row exists. Contributes the growth BASE to the pool once.
 * @returns the frozen allocation.
 */
async function freezeAllocation({ marketingJobId, auctionId, packagePriceCents, bps }) {
  const rateBps = bps != null ? cents(bps) : await marketingConfig.directSpendMaxBps();
  const alloc = policy.allocate(packagePriceCents, rateBps);
  policy.assertAllocationInvariant(alloc);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM marketing_allocations WHERE marketing_job_id = $1 FOR UPDATE', [marketingJobId]);
    if (existing.rows[0]) { await client.query('COMMIT'); return existing.rows[0]; } // already frozen — immutable
    const ins = await client.query(
      `INSERT INTO marketing_allocations (marketing_job_id, auction_id, package_price_cents, direct_max_cents, growth_base_cents, allocation_model_version)
       VALUES ($1,$2,$3,$4,$5,'v1') RETURNING *`,
      [marketingJobId, auctionId || null, alloc.package_price_cents, alloc.direct_max_cents, alloc.growth_base_cents]);
    // Snapshot onto marketing_jobs (immutable after freeze — enforced by only writing when frozen_at is null).
    await client.query(
      `UPDATE marketing_jobs
          SET package_price_cents = $2, direct_max_cents = $3, growth_allocation_cents = $4,
              allocation_model_version = 'v1', allocation_frozen_at = now()
        WHERE id = $1 AND allocation_frozen_at IS NULL`,
      [marketingJobId, alloc.package_price_cents, alloc.direct_max_cents, alloc.growth_base_cents]);
    await insertLedger(client, { jobId: marketingJobId, entryType: 'ALLOCATION', amountCents: alloc.direct_max_cents, idempotencyKey: 'alloc:' + marketingJobId });
    // Growth BASE contribution (the remainder) — once, keyed by job.
    if (alloc.growth_base_cents > 0 && await insertGrowthLedger(client, { entryType: 'BASE_CONTRIBUTION', amountCents: alloc.growth_base_cents, jobId: marketingJobId, idempotencyKey: 'growth-base:' + marketingJobId })) {
      await client.query('UPDATE growth_pool SET balance_cents = balance_cents + $1, updated_at = now() WHERE id = 1', [alloc.growth_base_cents]);
    }
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/**
 * Reserve internal direct-marketing money for a job. CONDITIONAL (not read-then-write): the UPDATE only
 * succeeds while reserved+spent+amount <= direct_max, so concurrent reservations can never overspend.
 * Idempotent by idempotencyKey. Returns { ok, reservationId } or { ok:false, reason }.
 */
async function reserve({ marketingJobId, amountCents, idempotencyKey, campaignId }) {
  const amt = cents(amountCents);
  if (amt <= 0) return { ok: false, reason: 'amount_must_be_positive' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Idempotency: a repeat returns the original reservation, no double reserve.
    const dup = await client.query(`SELECT reservation_id FROM marketing_ledger WHERE idempotency_key = $1`, [idempotencyKey]);
    if (dup.rows[0]) { await client.query('COMMIT'); return { ok: true, reservationId: dup.rows[0].reservation_id, idempotent: true }; }
    const upd = await client.query(
      `UPDATE marketing_allocations
          SET direct_reserved_cents = direct_reserved_cents + $2
        WHERE marketing_job_id = $1 AND direct_reserved_cents + direct_spent_cents + $2 <= direct_max_cents
        RETURNING direct_reserved_cents`,
      [marketingJobId, amt]);
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'ceiling_exceeded' }; }
    const reservationId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await insertLedger(client, { jobId: marketingJobId, entryType: 'RESERVATION', amountCents: amt, reservationId, idempotencyKey, campaignId });
    await client.query('COMMIT');
    return { ok: true, reservationId };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/** Convert (part of) a reservation into actual spend. No external spend may occur without this committed. */
async function spend({ marketingJobId, reservationId, amountCents, idempotencyKey, campaignId }) {
  const amt = cents(amountCents);
  if (amt <= 0) return { ok: false, reason: 'amount_must_be_positive' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT id FROM marketing_ledger WHERE idempotency_key = $1`, [idempotencyKey]);
    if (dup.rows[0]) { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    const upd = await client.query(
      `UPDATE marketing_allocations
          SET direct_reserved_cents = direct_reserved_cents - $2, direct_spent_cents = direct_spent_cents + $2
        WHERE marketing_job_id = $1 AND direct_reserved_cents >= $2
        RETURNING direct_spent_cents`,
      [marketingJobId, amt]);
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_reservation' }; }
    await insertLedger(client, { jobId: marketingJobId, entryType: 'SPEND', amountCents: amt, reservationId, idempotencyKey, campaignId });
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/** Release a reservation (frees capacity). Does NOT auto-sweep to Growth — that happens at completion. */
async function release({ marketingJobId, reservationId, amountCents, idempotencyKey }) {
  const amt = cents(amountCents);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT id FROM marketing_ledger WHERE idempotency_key = $1`, [idempotencyKey]);
    if (dup.rows[0]) { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    const upd = await client.query(
      `UPDATE marketing_allocations SET direct_reserved_cents = direct_reserved_cents - $2
        WHERE marketing_job_id = $1 AND direct_reserved_cents >= $2 RETURNING direct_reserved_cents`,
      [marketingJobId, amt]);
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'insufficient_reserved' }; }
    await insertLedger(client, { jobId: marketingJobId, entryType: 'RELEASE', amountCents: amt, reservationId, idempotencyKey });
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/**
 * Complete a campaign's direct spend: sweep UNUSED direct capacity (direct_max − spent) into the Growth
 * Pool EXACTLY once (unused_swept guard). Idempotent.
 */
async function sweepUnusedToGrowth({ marketingJobId }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query('SELECT * FROM marketing_allocations WHERE marketing_job_id = $1 FOR UPDATE', [marketingJobId])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_allocation' }; }
    if (a.unused_swept) { await client.query('COMMIT'); return { ok: true, alreadySwept: true, contributed_cents: 0 }; }
    const unused = policy.unusedDirectCapacityCents(a.direct_max_cents, a.direct_spent_cents) - cents(a.direct_reserved_cents);
    const contribute = Math.max(0, unused);
    await client.query('UPDATE marketing_allocations SET unused_swept = true WHERE marketing_job_id = $1', [marketingJobId]);
    if (contribute > 0) {
      await insertGrowthLedger(client, { entryType: 'UNUSED_CAPACITY_CONTRIBUTION', amountCents: contribute, jobId: marketingJobId, idempotencyKey: 'growth-unused:' + marketingJobId });
      await client.query('UPDATE growth_pool SET balance_cents = balance_cents + $1, updated_at = now() WHERE id = 1', [contribute]);
    }
    await client.query('COMMIT');
    return { ok: true, contributed_cents: contribute };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/**
 * Spend from the Growth Pool. Uses the accumulated balance first; may spend beyond it up to the monthly
 * autonomous authority + owner grants. If the request needs more than that, REFUSE and escalate.
 */
async function growthSpend({ amountCents, campaignId, marketId, idempotencyKey, month }) {
  const amt = cents(amountCents);
  if (amt <= 0) return { ok: false, reason: 'amount_must_be_positive' };
  const m = monthStart(month);
  const monthlyAuthority = await marketingConfig.growthMonthlyAdditionalAuthorityCents();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT id FROM growth_pool_ledger WHERE idempotency_key = $1`, [idempotencyKey]);
    if (dup.rows[0]) { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    const pool = (await client.query('SELECT balance_cents, COALESCE(reserved_cents,0) AS reserved_cents FROM growth_pool WHERE id = 1 FOR UPDATE')).rows[0];
    // Non-reserved (free) pool balance — funds held by active portfolio reservations are NOT spendable here.
    const balance = Math.max(0, cents(pool.balance_cents) - cents(pool.reserved_cents));
    const fromPool = Math.min(balance, amt);
    const beyond = amt - fromPool;
    // Ensure a monthly authority row (snapshot the config ceiling for the month).
    await client.query(
      `INSERT INTO growth_monthly_authority (month, additional_authority_cents) VALUES ($1,$2)
       ON CONFLICT (month) DO NOTHING`, [m, monthlyAuthority]);
    const auth = (await client.query('SELECT * FROM growth_monthly_authority WHERE month = $1 FOR UPDATE', [m])).rows[0];
    const remainingBeyond = (cents(auth.additional_authority_cents) + cents(auth.owner_granted_cents)) - cents(auth.spent_beyond_pool_cents);
    if (beyond > remainingBeyond) { await client.query('ROLLBACK'); return { ok: false, reason: 'exceeds_monthly_authority', escalate: true, remaining_beyond_cents: remainingBeyond }; }
    if (fromPool > 0) {
      await client.query('UPDATE growth_pool SET balance_cents = balance_cents - $1, updated_at = now() WHERE id = 1', [fromPool]);
      await insertGrowthLedger(client, { entryType: 'SPEND', amountCents: fromPool, campaignId, marketId, month: m, idempotencyKey });
    }
    if (beyond > 0) {
      await client.query('UPDATE growth_monthly_authority SET spent_beyond_pool_cents = spent_beyond_pool_cents + $2, updated_at = now() WHERE month = $1', [m, beyond]);
      await insertGrowthLedger(client, { entryType: 'ADDITIONAL_AUTHORITY_SPEND', amountCents: beyond, campaignId, marketId, month: m, idempotencyKey: idempotencyKey + ':beyond' });
    }
    await client.query('COMMIT');
    return { ok: true, from_pool_cents: fromPool, beyond_pool_cents: beyond };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/** Record an Owner/Super-Admin-approved additional authority grant for a month (separately recorded). */
async function ownerGrant({ amountCents, month, idempotencyKey, actorId }) {
  const amt = cents(amountCents); const m = monthStart(month);
  const monthlyAuthority = await marketingConfig.growthMonthlyAdditionalAuthorityCents();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT id FROM growth_pool_ledger WHERE idempotency_key = $1`, [idempotencyKey]);
    if (dup.rows[0]) { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    await client.query(`INSERT INTO growth_monthly_authority (month, additional_authority_cents) VALUES ($1,$2) ON CONFLICT (month) DO NOTHING`, [m, monthlyAuthority]);
    await client.query('UPDATE growth_monthly_authority SET owner_granted_cents = owner_granted_cents + $2, updated_at = now() WHERE month = $1', [m, amt]);
    await insertGrowthLedger(client, { entryType: 'OWNER_GRANT', amountCents: amt, month: m, idempotencyKey, metadata: { actorId } });
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/** Growth Pool report (direct figures; internal only). */
async function growthReport({ month } = {}) {
  const m = monthStart(month);
  const pool = (await db.query('SELECT balance_cents FROM growth_pool WHERE id = 1')).rows[0] || { balance_cents: 0 };
  const sums = (await db.query(
    `SELECT entry_type, COALESCE(SUM(amount_cents),0)::bigint AS total FROM growth_pool_ledger GROUP BY entry_type`)).rows
    .reduce((o, r) => { o[r.entry_type] = Number(r.total); return o; }, {});
  const auth = (await db.query('SELECT * FROM growth_monthly_authority WHERE month = $1', [m])).rows[0]
    || { additional_authority_cents: await marketingConfig.growthMonthlyAdditionalAuthorityCents(), owner_granted_cents: 0, spent_beyond_pool_cents: 0 };
  return {
    available_balance_cents: Number(pool.balance_cents),
    base_contributions_cents: sums.BASE_CONTRIBUTION || 0,
    unused_capacity_contributions_cents: sums.UNUSED_CAPACITY_CONTRIBUTION || 0,
    growth_pool_spend_cents: sums.SPEND || 0,
    releases_cents: sums.RELEASE || 0,
    additional_authority_spend_cents: sums.ADDITIONAL_AUTHORITY_SPEND || 0,
    owner_authorized_additions_cents: Number(auth.owner_granted_cents),
    monthly_additional_authority_cents: Number(auth.additional_authority_cents),
    remaining_monthly_authority_cents: (Number(auth.additional_authority_cents) + Number(auth.owner_granted_cents)) - Number(auth.spent_beyond_pool_cents),
  };
}

module.exports = { freezeAllocation, reserve, spend, release, sweepUnusedToGrowth, growthSpend, ownerGrant, growthReport, _monthStart: monthStart };
