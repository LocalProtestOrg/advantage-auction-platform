'use strict';

/**
 * growthReservationService — the missing portfolio RESERVATION lifecycle for the Growth Pool. Extends the
 * CERTIFIED growth_pool / growth_pool_ledger / growth_monthly_authority (NO second pool). Atomic,
 * transactional (FOR UPDATE, no read-then-write race), idempotent. Available authority accounts for active
 * reservations. Spend cannot exceed its reservation. Failed/stopped experiments release unused reservation.
 * The monthly $1,000 additional-authority CEILING + Owner grants remain DB/server enforced. Package
 * direct-spend capacity (marketing_allocations) is a COMPLETELY SEPARATE system — untouched here.
 */
const db = require('../db');
const marketingConfig = require('./marketingConfigService');

const cents = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
const monthStart = (d) => { const dt = d ? new Date(d) : new Date(); return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)).toISOString().slice(0, 10); };

async function ensureMonth(client, m) {
  const monthly = await marketingConfig.growthMonthlyAdditionalAuthorityCents();
  await client.query(`INSERT INTO growth_monthly_authority (month, additional_authority_cents) VALUES ($1,$2) ON CONFLICT (month) DO NOTHING`, [m, monthly]);
  return (await client.query('SELECT * FROM growth_monthly_authority WHERE month = $1 FOR UPDATE', [m])).rows[0];
}
function availableAuthority(pool, auth) {
  const poolAvail = Math.max(0, cents(pool.balance_cents) - cents(pool.reserved_cents));
  const monthlyHeadroom = (cents(auth.additional_authority_cents) + cents(auth.owner_granted_cents)) - cents(auth.spent_beyond_pool_cents);
  return poolAvail + Math.max(0, monthlyHeadroom);
}

// Reserve authority for an experiment. Conditional/atomic: succeeds only while amount <= available authority.
async function growthReserve({ experimentId = null, amountCents, month, idempotencyKey }) {
  const amt = cents(amountCents); const m = monthStart(month);
  if (amt <= 0) return { ok: false, reason: 'amount_must_be_positive' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT id, amount_cents FROM growth_pool_reservations WHERE idempotency_key = $1', [idempotencyKey]);
    if (dup.rows[0]) { await client.query('COMMIT'); return { ok: true, idempotent: true, reservationId: dup.rows[0].id, amount_cents: dup.rows[0].amount_cents }; }
    const pool = (await client.query('SELECT * FROM growth_pool WHERE id = 1 FOR UPDATE')).rows[0];
    const auth = await ensureMonth(client, m);
    const available = availableAuthority(pool, auth);
    if (amt > available) { await client.query('ROLLBACK'); return { ok: false, reason: 'exceeds_available_authority', available_cents: available, escalate: true }; }
    await client.query('UPDATE growth_pool SET reserved_cents = reserved_cents + $1, updated_at = now() WHERE id = 1', [amt]);
    const res = await client.query(
      `INSERT INTO growth_pool_reservations (experiment_id, amount_cents, month, idempotency_key) VALUES ($1,$2,$3,$4) RETURNING id`,
      [experimentId, amt, m, idempotencyKey]);
    await client.query(
      `INSERT INTO growth_pool_ledger (entry_type, amount_cents, occurred_month, idempotency_key, metadata) VALUES ('RESERVATION',$1,$2,$3,$4)`,
      [amt, m, 'gres:' + idempotencyKey, JSON.stringify({ experiment_id: experimentId, reservation_id: res.rows[0].id })]);
    await client.query('COMMIT');
    return { ok: true, reservationId: res.rows[0].id, amount_cents: amt };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// Spend against a reservation. Cannot exceed the reservation's remaining. Draws pool first, then monthly authority.
async function growthSpend({ reservationId, amountCents, campaignId = null, marketId = null, idempotencyKey }) {
  const amt = cents(amountCents);
  if (amt <= 0) return { ok: false, reason: 'amount_must_be_positive' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dupe = await client.query(`SELECT id FROM growth_pool_ledger WHERE idempotency_key = $1`, ['gspend:' + idempotencyKey]);
    if (dupe.rows[0]) { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    const r = (await client.query('SELECT * FROM growth_pool_reservations WHERE id = $1 FOR UPDATE', [reservationId])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_reservation' }; }
    if (r.status === 'released') { await client.query('ROLLBACK'); return { ok: false, reason: 'reservation_released' }; }
    if (amt > (cents(r.amount_cents) - cents(r.spent_cents))) { await client.query('ROLLBACK'); return { ok: false, reason: 'exceeds_reservation' }; }
    const m = r.month;
    const pool = (await client.query('SELECT * FROM growth_pool WHERE id = 1 FOR UPDATE')).rows[0];
    const auth = await ensureMonth(client, m);
    const poolBackable = Math.max(0, cents(pool.balance_cents) - (cents(pool.reserved_cents) - (cents(r.amount_cents) - cents(r.spent_cents))));
    const fromPool = Math.min(poolBackable, amt);
    const beyond = amt - fromPool;
    // Release the spent slice of the reservation hold, then apply spend.
    await client.query('UPDATE growth_pool SET reserved_cents = reserved_cents - $1, balance_cents = balance_cents - $2, updated_at = now() WHERE id = 1', [amt, fromPool]);
    if (beyond > 0) await client.query('UPDATE growth_monthly_authority SET spent_beyond_pool_cents = spent_beyond_pool_cents + $2, updated_at = now() WHERE month = $1', [m, beyond]);
    const spent = cents(r.spent_cents) + amt;
    await client.query('UPDATE growth_pool_reservations SET spent_cents = $2, status = CASE WHEN $2 >= amount_cents THEN \'spent\' ELSE status END, updated_at = now() WHERE id = $1', [reservationId, spent]);
    await client.query(
      `INSERT INTO growth_pool_ledger (entry_type, amount_cents, campaign_id, market_id, occurred_month, idempotency_key, metadata) VALUES ('SPEND',$1,$2,$3,$4,$5,$6)`,
      [fromPool, campaignId, marketId, m, 'gspend:' + idempotencyKey, JSON.stringify({ reservation_id: reservationId })]);
    if (beyond > 0) await client.query(
      `INSERT INTO growth_pool_ledger (entry_type, amount_cents, campaign_id, market_id, occurred_month, idempotency_key, metadata) VALUES ('ADDITIONAL_AUTHORITY_SPEND',$1,$2,$3,$4,$5,$6)`,
      [beyond, campaignId, marketId, m, 'gspend-beyond:' + idempotencyKey, JSON.stringify({ reservation_id: reservationId })]);
    await client.query('COMMIT');
    return { ok: true, from_pool_cents: fromPool, beyond_pool_cents: beyond };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// Release the UNUSED remainder of a reservation (failed/stopped/cancelled experiment).
async function growthRelease({ reservationId, idempotencyKey }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dupe = await client.query(`SELECT id FROM growth_pool_ledger WHERE idempotency_key = $1`, ['grel:' + idempotencyKey]);
    if (dupe.rows[0]) { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    const r = (await client.query('SELECT * FROM growth_pool_reservations WHERE id = $1 FOR UPDATE', [reservationId])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_reservation' }; }
    if (r.status === 'released') { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    const unused = cents(r.amount_cents) - cents(r.spent_cents);
    await client.query('UPDATE growth_pool SET reserved_cents = reserved_cents - $1, updated_at = now() WHERE id = 1', [unused]);
    await client.query('UPDATE growth_pool_reservations SET status = \'released\', updated_at = now() WHERE id = $1', [reservationId]);
    await client.query(
      `INSERT INTO growth_pool_ledger (entry_type, amount_cents, occurred_month, idempotency_key, metadata) VALUES ('RESERVATION_RELEASE',$1,$2,$3,$4)`,
      [unused, r.month, 'grel:' + idempotencyKey, JSON.stringify({ reservation_id: reservationId })]);
    await client.query('COMMIT');
    return { ok: true, released_cents: unused };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function remainingAuthority({ month } = {}) {
  const m = monthStart(month);
  const pool = (await db.query('SELECT * FROM growth_pool WHERE id = 1')).rows[0] || { balance_cents: 0, reserved_cents: 0 };
  const auth = (await db.query('SELECT * FROM growth_monthly_authority WHERE month = $1', [m])).rows[0]
    || { additional_authority_cents: await marketingConfig.growthMonthlyAdditionalAuthorityCents(), owner_granted_cents: 0, spent_beyond_pool_cents: 0 };
  return { remaining_cents: availableAuthority(pool, auth), reserved_cents: cents(pool.reserved_cents), pool_balance_cents: cents(pool.balance_cents) };
}

module.exports = { growthReserve, growthSpend, growthRelease, remainingAuthority, _availableAuthority: availableAuthority };
