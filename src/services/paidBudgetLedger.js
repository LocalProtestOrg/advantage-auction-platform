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
 * Remaining authority is measured against actual spend PLUS each open campaign's unspent
 * commitment (see below), so neither an un-ingested commitment nor a provider overshoot can hide.
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
 *
 * EXPOSURE IS COUNTED PER CAMPAIGN, NEVER TWICE (migration 163). A campaign authorized for $135 that
 * has spent $40 consumes $40 of ACTUAL spend plus $95 of UNSPENT authorization — $135, not $175 and
 * not $40. The month's exposure is every actual dollar spent in the month (including spend from a
 * provider campaign we did not authorize) plus each open campaign's unspent authorization. The old
 * max(committed, actual) at month level let one campaign's overshoot hide behind another campaign's
 * unspent commitment; this does not.
 *
 * A NEW RESERVATION ALSO REQUIRES FRESH PROVIDER SPEND. The ledger never authorizes against an
 * internal "$0 actual" that nobody has checked: reserve() refuses unless a successful provider spend
 * read is on record within the decision freshness window and that read did not report a budget risk
 * or a ceiling breach. The caller (paidSpendGovernance.ensureFreshSpend) re-reads the provider first.
 *
 * MARKETS SHARE THE ONE CEILING. A reservation belongs to a market; the market must be launch-
 * authorized by the Owner, and an optional market allocation is a split of the SAME global authority.
 * There is no per-market ceiling anywhere, so adding a geography can never add money.
 */

const db = require('../db');
const configService = require('./configService');

const DEFAULT_CEILING_USD = 1000;

/** First day of the month that `d` falls in, as YYYY-MM-DD. */
function monthKey(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' (an account-timezone calendar day) → the first of its month. Pure. */
function monthKeyForDay(day) {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(day || ''));
  if (!m) throw new Error('not a calendar day: ' + day);
  return m[1] + '-' + m[2] + '-01';
}

/** The calendar day it is in `timeZone` at instant `now`, as 'YYYY-MM-DD'. Pure. */
function dayInZone(now = new Date(), timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now instanceof Date ? now : new Date(now));
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

async function accountTimeZone() {
  const tz = await configService.get(null, 'marketing.paid.pacing.timezone').catch(() => null);
  return typeof tz === 'string' && tz ? tz : 'America/New_York';
}

/** The current month in the ad account's reporting timezone — the month Meta attributes spend to. */
async function currentMonthKey(now = new Date()) {
  return monthKeyForDay(dayInZone(now, await accountTimeZone()));
}

/**
 * Month exposure from ledger entries. Pure, so the accounting can be proven by tests.
 *   entries: [{ campaign_key, kind: 'commit'|'release'|'actual', month: 'YYYY-MM-01', amount_cents }]
 *   includeOpen: count open campaigns' unspent authorization (true for the current month; a past
 *                month's exposure is simply what was spent in it).
 */
function exposureFromEntries(entries, month, { includeOpen = true } = {}) {
  const per = new Map();
  let actualMonth = 0;
  const monthOf = (m) => (m instanceof Date ? m.toISOString().slice(0, 10) : String(m).slice(0, 10));
  for (const e of entries || []) {
    const key = e.campaign_key || '(unassigned)';
    const c = per.get(key) || { campaign_key: key, authorized_cents: 0, lifetime_actual_cents: 0, month_actual_cents: 0 };
    const amt = Number(e.amount_cents) || 0;
    if (e.kind === 'commit') c.authorized_cents += amt;
    else if (e.kind === 'release') c.authorized_cents -= amt;
    else if (e.kind === 'actual') {
      c.lifetime_actual_cents += amt;
      if (monthOf(e.month) === month) { c.month_actual_cents += amt; actualMonth += amt; }
    }
    per.set(key, c);
  }
  let unspent = 0;
  const campaigns = [];
  for (const c of per.values()) {
    c.unspent_cents = includeOpen ? Math.max(0, c.authorized_cents - c.lifetime_actual_cents) : 0;
    unspent += c.unspent_cents;
    campaigns.push(c);
  }
  return { month, actual_cents: actualMonth, unspent_exposure_cents: unspent, exposure_cents: actualMonth + unspent, campaigns };
}

async function ledgerEntries(runner) {
  return (await runner.query(
    `SELECT campaign_key, kind, month::text AS month, COALESCE(sum(amount_cents),0)::bigint AS amount_cents
       FROM marketing_paid_budget_ledger GROUP BY campaign_key, kind, month`)).rows;
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
async function status(month = null, runner = db) {
  const c = await ceilings();
  const current = await currentMonthKey();
  month = month || current;
  const row = (await runner.query(
    'SELECT ceiling_cents, committed_cents, actual_cents FROM marketing_paid_budget_months WHERE month = $1',
    [month])).rows[0] || { ceiling_cents: c.monthly_cents, committed_cents: 0, actual_cents: 0 };
  // Per-campaign exposure: actual spend once, plus each open campaign's UNSPENT authorization once.
  const x = exposureFromEntries(await ledgerEntries(runner), month, { includeOpen: month >= current });
  const ceiling = Number(row.ceiling_cents);
  return {
    month,
    ceiling_cents: ceiling,
    committed_cents: Number(row.committed_cents),
    actual_cents: x.actual_cents,
    unspent_exposure_cents: x.unspent_exposure_cents,
    consumed_cents: x.exposure_cents,
    remaining_cents: Math.max(0, ceiling - x.exposure_cents),
    campaign_ceiling_cents: c.campaign_cents,
    // A pacing PLAN for configured provider daily budgets. Not a hard provider-side daily limit.
    daily_ceiling_cents: c.daily_cents,
    campaigns: x.campaigns,
  };
}

/**
 * Reserve authority for a campaign. Returns { ok, reservation|reason }.
 * Never throws for an ordinary refusal — a refusal is an answer, not an error.
 */
async function reserve({ month = null, campaignKey, amountCents, idempotencyKey, note = null, marketKey = null } = {}) {
  if (!campaignKey) return { ok: false, reason: 'campaign_key required' };
  if (!idempotencyKey) return { ok: false, reason: 'idempotency_key required' };
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive whole number of cents' };

  const c = await ceilings();
  if (amount > c.campaign_cents) {
    return { ok: false, reason: `campaign budget $${(amount / 100).toFixed(2)} exceeds the per-campaign ceiling $${(c.campaign_cents / 100).toFixed(2)}` };
  }

  month = month || await currentMonthKey();

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
    // Fresh provider spend is a precondition, checked with the month locked.
    const fresh = await freshnessCheck(client);
    if (!fresh.ok) { await client.query('ROLLBACK'); return { ok: false, reason: fresh.reason }; }

    // The market must be Owner-authorized. Markets share this ONE ceiling.
    const mk = await marketCheck(client, { campaignKey, marketKey, amount, month });
    if (!mk.ok) { await client.query('ROLLBACK'); return { ok: false, reason: mk.reason }; }

    const x = exposureFromEntries(await ledgerEntries(client), month, { includeOpen: true });
    const remaining = ceiling - x.exposure_cents;
    if (amount > remaining) {
      await client.query('ROLLBACK');
      return { ok: false, reason: `only $${(Math.max(0, remaining) / 100).toFixed(2)} of the $${(ceiling / 100).toFixed(2)} monthly authority remains uncommitted; $${(amount / 100).toFixed(2)} requested` };
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
async function release({ month = null, campaignKey, amountCents, idempotencyKey, note = null } = {}) {
  const amount = Number(amountCents);
  if (!idempotencyKey) return { ok: false, reason: 'idempotency_key required' };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive whole number of cents' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Authority goes back to the month it was committed in, not the month it happens to be released
    // in — otherwise a campaign stopped after a month boundary would release nothing.
    if (!month) {
      const committed = campaignKey ? (await client.query(
        `SELECT month::text AS month FROM marketing_paid_budget_ledger WHERE campaign_key = $1 AND kind = 'commit'
          ORDER BY created_at DESC LIMIT 1`, [campaignKey])).rows[0] : null;
      month = committed ? committed.month : await currentMonthKey();
    }
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

const BLOCKING_STATES = Object.freeze(['CEILING_BREACH', 'BUDGET_RISK', 'STALE_PROVIDER_DATA']);

/**
 * Is there a successful provider spend read recent enough to decide on, and did it report the
 * budget as safe? Read inside the reservation transaction. No network: the caller refreshes first.
 */
async function freshnessCheck(client, now = new Date()) {
  const maxAge = Number(await configService.get(null, 'marketing.paid.spend_sync.decision_max_age_minutes').catch(() => null)) || 15;
  const last = (await client.query(
    `SELECT finished_at, reconciliation_state FROM marketing_paid_spend_syncs
      WHERE ok = true ORDER BY finished_at DESC LIMIT 1`)).rows[0];
  if (!last) return { ok: false, reason: 'no provider spend reading on record — refusing to authorize against an unchecked $0' };
  const ageMin = (now.getTime() - new Date(last.finished_at).getTime()) / 60000;
  if (ageMin > maxAge) return { ok: false, reason: `provider spend was last read ${Math.round(ageMin)} min ago (decisions need ≤ ${maxAge} min)` };
  if (BLOCKING_STATES.includes(last.reconciliation_state)) {
    return { ok: false, reason: 'spend reconciliation is ' + last.reconciliation_state + ' — no new authority until it clears' };
  }
  return { ok: true };
}

/**
 * The reservation's market must exist, be ACTIVE and launch-authorized by the Owner. An allocation,
 * if one is set, is a split of the global ceiling — it can only make a market SMALLER than the global
 * remaining authority, never bigger.
 */
async function marketCheck(client, { campaignKey, marketKey, amount, month }) {
  let key = marketKey;
  if (!key) {
    const c = (await client.query('SELECT market_key FROM marketing_paid_campaigns WHERE campaign_key = $1', [campaignKey])).rows[0];
    key = c && c.market_key;
  }
  if (!key) return { ok: false, reason: 'campaign ' + campaignKey + ' has no market — every paid dollar must belong to a market' };
  const m = (await client.query(
    'SELECT market_key, status, launch_authorized, geo_validation, allocation_cents FROM marketing_paid_markets WHERE market_key = $1', [key])).rows[0];
  if (!m) return { ok: false, reason: 'unknown market ' + key };
  if (m.status !== 'ACTIVE' || m.launch_authorized !== true) {
    return { ok: false, reason: 'market ' + key + ' is ' + m.status + (m.launch_authorized ? '' : ' and not launch-authorized by the Owner') };
  }
  if (m.geo_validation !== 'VALID') return { ok: false, reason: 'market ' + key + ' geography is not provider-validated' };
  if (m.allocation_cents != null) {
    const keys = (await client.query('SELECT campaign_key FROM marketing_paid_campaigns WHERE market_key = $1', [key])).rows.map((r) => r.campaign_key);
    const entries = (await ledgerEntries(client)).filter((e) => keys.includes(e.campaign_key));
    const used = exposureFromEntries(entries, month, { includeOpen: true }).exposure_cents;
    if (used + amount > Number(m.allocation_cents)) {
      return { ok: false, reason: `market ${key} allocation $${(m.allocation_cents / 100).toFixed(2)} would be exceeded ($${(used / 100).toFixed(2)} exposed + $${(amount / 100).toFixed(2)} requested)` };
    }
  }
  return { ok: true, market_key: key };
}

/**
 * Plan the ledger entries that make recorded actual spend equal the provider's figures. Pure.
 *
 *   providerDays: [{ provider_campaign_id, campaign_key, fact_date: 'YYYY-MM-DD', spend_cents }]
 *   recorded:     [{ provider_campaign_id, fact_date, amount_cents, campaign_key }]  (sums so far)
 *   window:       { since, until } — a recorded day inside the window that the provider no longer
 *                 reports is restated to zero; days outside the window are never touched.
 *
 * Each entry is a DELTA keyed on (campaign, day, recorded → target). Replaying the same provider
 * figures produces nothing; a restated day produces exactly one correcting entry.
 */
function planActualAdjustments(providerDays, recorded, { since = null, until = null } = {}) {
  const dayOf = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const k = (cid, d) => cid + '|' + dayOf(d);
  const target = new Map();
  const campaignOf = new Map();
  for (const p of providerDays || []) {
    const key = k(p.provider_campaign_id, p.fact_date);
    target.set(key, (target.get(key) || 0) + (Math.round(Number(p.spend_cents)) || 0));
    if (p.campaign_key) campaignOf.set(p.provider_campaign_id, p.campaign_key);
  }
  const have = new Map();
  for (const r of recorded || []) {
    const key = k(r.provider_campaign_id, r.fact_date);
    have.set(key, (have.get(key) || 0) + (Number(r.amount_cents) || 0));
    if (!campaignOf.has(r.provider_campaign_id) && r.campaign_key) campaignOf.set(r.provider_campaign_id, r.campaign_key);
  }
  const inWindow = (d) => (!since || d >= since) && (!until || d <= until);
  const keys = new Set([...target.keys(), ...[...have.keys()].filter((x) => inWindow(x.split('|')[1]))]);
  const out = [];
  for (const key of [...keys].sort()) {
    const [cid, day] = key.split('|');
    const want = target.get(key) || 0;
    const got = have.get(key) || 0;
    if (want === got) continue;
    out.push({ provider_campaign_id: cid, campaign_key: campaignOf.get(cid) || ('unmapped:' + cid), fact_date: day,
      month: monthKeyForDay(day), recorded_cents: got, target_cents: want, delta_cents: want - got,
      idempotency_key: 'actual:meta:' + cid + ':' + day + ':' + got + '->' + want });
  }
  return out;
}

/**
 * Bring recorded actual spend in line with the provider, atomically. Every affected month row is
 * locked in a fixed order (so two syncs cannot deadlock), the recorded state is re-read UNDER the
 * lock, and only the differences are written. A concurrent duplicate hits the UNIQUE key and rolls
 * back instead of double counting. Actual spend is observed truth, so this NEVER refuses on the
 * ceiling — it records what happened and lets status() report the consequence.
 */
async function syncActualDays({ providerDays = [], window, syncId = null } = {}) {
  if (!window || !window.since || !window.until) return { ok: false, reason: 'a provider window is required' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const c = await ceilings();
    const months = [...new Set([
      ...providerDays.map((p) => monthKeyForDay(p.fact_date)),
      monthKeyForDay(window.since), monthKeyForDay(window.until),
    ])].sort();
    for (const m of months) {
      await client.query(`INSERT INTO marketing_paid_budget_months (month, ceiling_cents) VALUES ($1,$2) ON CONFLICT (month) DO NOTHING`, [m, c.monthly_cents]);
      await client.query('SELECT 1 FROM marketing_paid_budget_months WHERE month = $1 FOR UPDATE', [m]);
    }
    const recorded = (await client.query(
      `SELECT provider_campaign_id, fact_date::text AS fact_date, campaign_key, sum(amount_cents)::bigint AS amount_cents
         FROM marketing_paid_budget_ledger
        WHERE kind = 'actual' AND provider_campaign_id IS NOT NULL
          AND fact_date BETWEEN $1::date AND $2::date
        GROUP BY provider_campaign_id, fact_date, campaign_key`, [window.since, window.until])).rows;
    const plan = planActualAdjustments(providerDays, recorded, window);
    for (const a of plan) {
      await client.query(
        `INSERT INTO marketing_paid_budget_ledger (month, campaign_key, kind, amount_cents, idempotency_key, note, provider_campaign_id, fact_date, sync_id)
         VALUES ($1,$2,'actual',$3,$4,$5,$6,$7,$8)`,
        [a.month, a.campaign_key, a.delta_cents, a.idempotency_key,
          'provider spend ' + a.fact_date + ': $' + (a.recorded_cents / 100).toFixed(2) + ' -> $' + (a.target_cents / 100).toFixed(2),
          a.provider_campaign_id, a.fact_date, syncId]);
      await client.query('UPDATE marketing_paid_budget_months SET actual_cents = actual_cents + $2, updated_at = now() WHERE month = $1', [a.month, a.delta_cents]);
    }
    await client.query('COMMIT');
    return { ok: true, entries: plan.length, adjustments: plan };
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

module.exports = {
  monthKey, monthKeyForDay, dayInZone, accountTimeZone, currentMonthKey, ceilings, status, reserve, release,
  recordActual, syncActualDays, planActualAdjustments, exposureFromEntries, freshnessCheck, marketCheck,
  BLOCKING_STATES, DEFAULT_CEILING_USD,
};
