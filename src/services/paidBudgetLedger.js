'use strict';

/**
 * paidBudgetLedger — the Owner's monthly authority, enforced as money rather than as a plan.
 *
 * The previous architecture checked ceilings while PLANNING. That cannot stop overspend: a plan is
 * not a commitment, and by the time money moves the check is long past. This ledger separates the
 * two things that actually matter:
 *
 *   COMMITTED — authority handed to a campaign at creation. Reserved before the provider is called,
 *               released if creation fails or the campaign stops early.
 *   ACTUAL    — what the provider reports having spent, ingested afterwards.
 *
 * Remaining authority is measured against the HIGHER of the two, so neither an un-ingested
 * commitment nor a provider overshoot can hide.
 *
 * WHY IT IS RACE-SAFE. Every reservation takes `SELECT ... FOR UPDATE` on the month row, so two
 * concurrent campaign creations serialize instead of both reading the same remaining authority.
 * The database additionally holds `committed_cents <= ceiling_cents` as a CHECK constraint, so even
 * a bug in this file cannot write past the ceiling — the transaction aborts.
 *
 * WHY RETRIES ARE SAFE. Every entry carries a UNIQUE idempotency_key. A retried creation re-uses
 * its key, hits the conflict, and returns the ORIGINAL reservation instead of committing twice.
 *
 * $1,000/month is a CEILING, not a target. Nothing here encourages spending it; it only makes
 * exceeding it impossible.
 */

const db = require('../db');
const configService = require('./configService');

const DEFAULT_CEILING_USD = 1000;

/** First day of the month that `d` falls in, as YYYY-MM-DD. */
function monthKey(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

const usdToCents = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : fallback;
};

async function ceilings() {
  const [monthly, campaign, daily] = await Promise.all([
    configService.get(null, 'marketing.paid_growth.monthly_ceiling_usd'),
    configService.get(null, 'marketing.paid_growth.campaign_ceiling_usd'),
    configService.get(null, 'marketing.paid_growth.daily_ceiling_usd'),
  ]);
  const monthlyCents = usdToCents(monthly, DEFAULT_CEILING_USD * 100);
  return {
    monthly_cents: monthlyCents,
    // A campaign may never exceed the month that contains it, whatever the campaign key says.
    campaign_cents: Math.min(usdToCents(campaign, 40000), monthlyCents),
    daily_cents: Math.min(usdToCents(daily, 5000), monthlyCents),
  };
}

/** Current authority position for a month. Read-only. */
async function status(month = monthKey(), runner = db) {
  const c = await ceilings();
  const row = (await runner.query(
    'SELECT ceiling_cents, committed_cents, actual_cents FROM marketing_paid_budget_months WHERE month = $1',
    [month])).rows[0] || { ceiling_cents: c.monthly_cents, committed_cents: 0, actual_cents: 0 };
  // Authority is consumed by whichever is larger: what we promised, or what was actually spent.
  const consumed = Math.max(Number(row.committed_cents), Number(row.actual_cents));
  return {
    month,
    ceiling_cents: Number(row.ceiling_cents),
    committed_cents: Number(row.committed_cents),
    actual_cents: Number(row.actual_cents),
    consumed_cents: consumed,
    remaining_cents: Math.max(0, Number(row.ceiling_cents) - consumed),
    campaign_ceiling_cents: c.campaign_cents,
    daily_ceiling_cents: c.daily_cents,
  };
}

/**
 * Reserve authority for a campaign. Returns { ok, reservation|reason }.
 * Never throws for an ordinary refusal — a refusal is an answer, not an error.
 */
async function reserve({ month = monthKey(), campaignKey, amountCents, idempotencyKey, note = null } = {}) {
  if (!campaignKey) return { ok: false, reason: 'campaign_key required' };
  if (!idempotencyKey) return { ok: false, reason: 'idempotency_key required' };
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive whole number of cents' };

  const c = await ceilings();
  if (amount > c.campaign_cents) {
    return { ok: false, reason: `campaign budget $${(amount / 100).toFixed(2)} exceeds the per-campaign ceiling $${(c.campaign_cents / 100).toFixed(2)}` };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // A retry of the same creation must not commit twice.
    const prior = (await client.query(
      'SELECT id, amount_cents, month FROM marketing_paid_budget_ledger WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
    if (prior) {
      await client.query('COMMIT');
      return { ok: true, replayed: true, reservation: { id: prior.id, amount_cents: Number(prior.amount_cents), month: prior.month, idempotency_key: idempotencyKey } };
    }

    // Serialization point. Everything below happens with the month row locked.
    await client.query(
      `INSERT INTO marketing_paid_budget_months (month, ceiling_cents) VALUES ($1, $2)
       ON CONFLICT (month) DO NOTHING`, [month, c.monthly_cents]);
    const m = (await client.query(
      'SELECT ceiling_cents, committed_cents, actual_cents FROM marketing_paid_budget_months WHERE month = $1 FOR UPDATE',
      [month])).rows[0];

    // The ceiling can be lowered by the Owner between months; always honour the current one.
    let ceiling = Number(m.ceiling_cents);
    if (ceiling !== c.monthly_cents) {
      await client.query('UPDATE marketing_paid_budget_months SET ceiling_cents = $2, updated_at = now() WHERE month = $1', [month, c.monthly_cents]);
      ceiling = c.monthly_cents;
    }
    const consumed = Math.max(Number(m.committed_cents), Number(m.actual_cents));
    const remaining = ceiling - consumed;
    if (amount > remaining) {
      await client.query('ROLLBACK');
      return { ok: false, reason: `only $${(remaining / 100).toFixed(2)} of the $${(ceiling / 100).toFixed(2)} monthly authority remains; $${(amount / 100).toFixed(2)} requested` };
    }

    const ins = await client.query(
      `INSERT INTO marketing_paid_budget_ledger (month, campaign_key, kind, amount_cents, idempotency_key, note)
       VALUES ($1,$2,'commit',$3,$4,$5) RETURNING id`, [month, campaignKey, amount, idempotencyKey, note]);
    // The CHECK constraint committed_cents <= ceiling_cents is the last line of defence here.
    await client.query(
      'UPDATE marketing_paid_budget_months SET committed_cents = committed_cents + $2, updated_at = now() WHERE month = $1',
      [month, amount]);
    await client.query('COMMIT');
    return { ok: true, replayed: false, reservation: { id: ins.rows[0].id, amount_cents: amount, month, idempotency_key: idempotencyKey } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // A ceiling violation surfacing from the CHECK constraint is a refusal, not a crash.
    if (/chk_mpbm_within_ceiling/.test(e.message)) return { ok: false, reason: 'monthly ceiling would be exceeded' };
    return { ok: false, reason: 'ledger error: ' + e.message };
  } finally {
    client.release();
  }
}

/** Give authority back — creation failed, or a campaign stopped without spending it all. */
async function release({ month = monthKey(), campaignKey, amountCents, idempotencyKey, note = null } = {}) {
  const amount = Number(amountCents);
  if (!idempotencyKey) return { ok: false, reason: 'idempotency_key required' };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive whole number of cents' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prior = (await client.query('SELECT id FROM marketing_paid_budget_ledger WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
    if (prior) { await client.query('COMMIT'); return { ok: true, replayed: true }; }
    const m = (await client.query(
      'SELECT committed_cents FROM marketing_paid_budget_months WHERE month = $1 FOR UPDATE', [month])).rows[0];
    if (!m) { await client.query('ROLLBACK'); return { ok: false, reason: 'no authority recorded for ' + month }; }
    // Never release more than was committed.
    const give = Math.min(amount, Number(m.committed_cents));
    await client.query(
      `INSERT INTO marketing_paid_budget_ledger (month, campaign_key, kind, amount_cents, idempotency_key, note)
       VALUES ($1,$2,'release',$3,$4,$5)`, [month, campaignKey, give, idempotencyKey, note]);
    await client.query(
      'UPDATE marketing_paid_budget_months SET committed_cents = committed_cents - $2, updated_at = now() WHERE month = $1',
      [month, give]);
    await client.query('COMMIT');
    return { ok: true, released_cents: give };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, reason: 'ledger error: ' + e.message };
  } finally { client.release(); }
}

/**
 * Record provider-reported spend. Actual spend is observed, not controlled — so this NEVER refuses.
 * If actual exceeds the ceiling the ledger records the truth and `status()` reports zero remaining,
 * which is what should stop the next campaign.
 */
async function recordActual({ month = monthKey(), campaignKey, amountCents, idempotencyKey, note = null } = {}) {
  const amount = Number(amountCents);
  if (!idempotencyKey) return { ok: false, reason: 'idempotency_key required' };
  if (!Number.isInteger(amount) || amount < 0) return { ok: false, reason: 'amount must be a whole number of cents' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prior = (await client.query('SELECT id FROM marketing_paid_budget_ledger WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
    if (prior) { await client.query('COMMIT'); return { ok: true, replayed: true }; }
    const c = await ceilings();
    await client.query(
      `INSERT INTO marketing_paid_budget_months (month, ceiling_cents) VALUES ($1,$2) ON CONFLICT (month) DO NOTHING`,
      [month, c.monthly_cents]);
    await client.query('SELECT 1 FROM marketing_paid_budget_months WHERE month = $1 FOR UPDATE', [month]);
    await client.query(
      `INSERT INTO marketing_paid_budget_ledger (month, campaign_key, kind, amount_cents, idempotency_key, note)
       VALUES ($1,$2,'actual',$3,$4,$5)`, [month, campaignKey, amount, idempotencyKey, note]);
    await client.query(
      'UPDATE marketing_paid_budget_months SET actual_cents = actual_cents + $2, updated_at = now() WHERE month = $1',
      [month, amount]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, reason: 'ledger error: ' + e.message };
  } finally { client.release(); }
}

module.exports = { monthKey, ceilings, status, reserve, release, recordActual, DEFAULT_CEILING_USD };
