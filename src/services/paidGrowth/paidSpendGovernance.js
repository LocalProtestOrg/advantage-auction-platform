'use strict';

/**
 * paidSpendGovernance — the Owner's monthly authority, measured against what the provider has
 * ACTUALLY spent, re-read often enough to make decisions on.
 *
 * WHY THIS EXISTS. The first live Meta experiment spent $83.50 while the internal ledger still read
 * $0.00: cost facts were imported a day late and never reached the budget ledger at all. Separately,
 * "$50/day" had been presented as a limit. It is not one — a Meta ad-set daily budget is a pacing
 * TARGET, and four $12.50 ad sets spent $57.69 before lunch on day two. At $50 every day a 30-day
 * month would be $1,500, which the Owner's $1,000 monthly authority forbids.
 *
 * THE MODEL, in the order the Director must reason:
 *
 *   MONTHLY CEILING            the Owner's autonomous authority ($1,000). The primary constraint.
 *   ACTUAL SPEND               what the provider says it spent this month (account timezone).
 *   UNSPENT AUTHORIZATION      each open campaign's authorization minus its lifetime spend. Money
 *                              that MAY still be spent — a maximum exposure, not money spent.
 *   TOTAL EXPOSURE             actual + unspent. Each dollar is counted exactly once.
 *   UNCOMMITTED AUTHORITY      ceiling − exposure: the only money a NEW campaign may be given.
 *   SAFE DAILY PACING TARGET   (ceiling − actual) ÷ days remaining: the average the whole account
 *                              may spend per day from here and still end the month under the ceiling.
 *   RECOMMENDED DAILY BUDGETS  the pacing target × a safety factor, because a provider may spend
 *                              more than the configured daily budget on any single day.
 *
 * WHAT IS HARD AND WHAT IS NOT.
 *   Hard:  the ledger (a reservation beyond uncommitted authority is refused under a row lock),
 *          the provider campaign spend cap (the provider stops the campaign at its authorization),
 *          and the automatic pause on a CEILING_BREACH.
 *   Soft:  provider daily budgets. They are pacing targets and are never described as limits.
 *
 * FRESHNESS. Live spend is re-read on a schedule while anything is running, and ANY decision that
 * could add paid delivery re-reads it first (ensureFreshSpend). If the provider cannot be read, the
 * decision fails closed — the system never authorizes against an unchecked "$0 actual".
 */

const db = require('../../db');
const configService = require('../configService');
const ledger = require('../paidBudgetLedger');
const meta = require('./metaAdsProvider');

// ── configuration ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  timezone: 'America/New_York',
  safety_factor: 0.75,
  provider_max_daily_overdelivery: 1.75,
  interval_minutes: 60,
  max_age_minutes: 120,
  decision_max_age_minutes: 15,
  tolerance_cents: 100,
  auto_pause_on_breach: true,
  review_window_minutes: 10,
});

async function settings() {
  const get = (k) => configService.get(null, k).catch(() => null);
  const num = (v, d, { min = 0, max = Infinity } = {}) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : d;
  };
  const [tz, sf, od, iv, age, dage, tol, ap, rw, monthly] = await Promise.all([
    get('marketing.paid.pacing.timezone'), get('marketing.paid.pacing.daily_budget_safety_factor'),
    get('marketing.paid.pacing.provider_max_daily_overdelivery'), get('marketing.paid.spend_sync.interval_minutes'),
    get('marketing.paid.spend_sync.max_age_minutes'), get('marketing.paid.spend_sync.decision_max_age_minutes'),
    get('marketing.paid.spend_sync.tolerance_cents'), get('marketing.paid.auto_pause_on_breach'),
    get('marketing.paid.attribution.review_window_minutes'), ledger.ceilings(),
  ]);
  return {
    timezone: typeof tz === 'string' && tz ? tz : DEFAULTS.timezone,
    // A safety factor above 1 would plan budgets ABOVE the safe pace — never allowed.
    safety_factor: num(sf, DEFAULTS.safety_factor, { min: 0.1, max: 1 }),
    provider_max_daily_overdelivery: num(od, DEFAULTS.provider_max_daily_overdelivery, { min: 1, max: 5 }),
    interval_minutes: num(iv, DEFAULTS.interval_minutes, { min: 5, max: 1440 }),
    max_age_minutes: num(age, DEFAULTS.max_age_minutes, { min: 5, max: 2880 }),
    decision_max_age_minutes: num(dage, DEFAULTS.decision_max_age_minutes, { min: 1, max: 240 }),
    tolerance_cents: num(tol, DEFAULTS.tolerance_cents, { min: 0, max: 10000 }),
    auto_pause_on_breach: !(ap === false || ap === 'false'),
    review_window_minutes: num(rw, DEFAULTS.review_window_minutes, { min: 0, max: 240 }),
    ceilings: monthly,
  };
}

// ── pure calculations ─────────────────────────────────────────────────────────────────────────

/** Calendar facts about the month containing `now`, in the account timezone. Pure. */
function monthContext(now = new Date(), timeZone = DEFAULTS.timezone) {
  const today = ledger.dayInZone(now, timeZone);
  const [y, m, d] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    timezone: timeZone,
    today,
    month: y + '-' + pad(m) + '-01',
    month_start: y + '-' + pad(m) + '-01',
    month_end: y + '-' + pad(m) + '-' + pad(daysInMonth),
    days_in_month: daysInMonth,
    current_day: d,
    // Today is still spendable, so it counts as a remaining day.
    days_remaining: daysInMonth - d + 1,
  };
}

/** Shift a 'YYYY-MM-DD' by whole days. Pure. */
function addDays(day, n) {
  const t = new Date(day + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * The money position. Pure; every figure is derived once, and no dollar is counted twice.
 *
 *   campaigns: [{ campaign_key, authorized_cents, lifetime_actual_cents, month_actual_cents }]
 *   unmappedMonthActualCents: provider spend this month from campaigns we did not authorize
 */
function computePosition({ ctx, ceilingCents, campaigns = [], unmappedMonthActualCents = 0,
  todaySpendCents = 0, yesterdaySpendCents = 0, configuredDailyBudgetCents = 0,
  safetyFactor = DEFAULTS.safety_factor, overdelivery = DEFAULTS.provider_max_daily_overdelivery } = {}) {
  const sum = (f) => campaigns.reduce((a, c) => a + f(c), 0);
  const actual = sum((c) => Number(c.month_actual_cents) || 0) + (Number(unmappedMonthActualCents) || 0);
  // Unspent authorization: what an open campaign may still spend. Never negative — a campaign that
  // overshot its cap contributes its overshoot through ACTUAL, not through a negative remainder.
  const unspent = sum((c) => Math.max(0, (Number(c.authorized_cents) || 0) - (Number(c.lifetime_actual_cents) || 0)));
  const exposure = actual + unspent;
  const remainingMonthly = Math.max(0, ceilingCents - actual);
  const uncommitted = Math.max(0, ceilingCents - exposure);
  const days = Math.max(1, ctx.days_remaining);
  const safeDaily = Math.floor(remainingMonthly / days);
  const recommendedDailyBudget = Math.floor(safeDaily * safetyFactor);

  // Projection: at the faster of the configured budgets and yesterday's actual pace, but never past
  // the unspent authorization — the provider spend caps stop every campaign there.
  const rate = Math.max(Number(configuredDailyBudgetCents) || 0, Number(yesterdaySpendCents) || 0);
  const restOfToday = Math.max(0, rate - (Number(todaySpendCents) || 0));
  const futureCapacity = configuredDailyBudgetCents > 0 ? rate * Math.max(0, days - 1) + restOfToday : 0;
  const projectedSpend = actual + Math.min(unspent, futureCapacity);

  return {
    month: ctx.month,
    month_start: ctx.month_start,
    month_end: ctx.month_end,
    days_in_month: ctx.days_in_month,
    current_day: ctx.current_day,
    days_remaining: ctx.days_remaining,
    monthly_ceiling_cents: ceilingCents,
    actual_spend_cents: actual,
    unmapped_actual_cents: Number(unmappedMonthActualCents) || 0,
    authorized_unspent_cents: unspent,
    total_exposure_cents: exposure,
    remaining_monthly_authority_cents: remainingMonthly,
    uncommitted_authority_cents: uncommitted,
    average_spend_to_date_cents: Math.round(actual / Math.max(1, ctx.current_day)),
    safe_daily_pacing_target_cents: safeDaily,
    safety_factor: safetyFactor,
    recommended_max_daily_budget_cents: recommendedDailyBudget,
    configured_daily_budget_cents: Number(configuredDailyBudgetCents) || 0,
    provider_max_daily_overdelivery: overdelivery,
    worst_case_single_day_cents: Math.round((Number(configuredDailyBudgetCents) || 0) * overdelivery),
    today_spend_cents: Number(todaySpendCents) || 0,
    yesterday_spend_cents: Number(yesterdaySpendCents) || 0,
    projected_month_end_spend_cents: projectedSpend,
    // Worst case: every open campaign spends to its cap this month.
    projected_month_end_exposure_cents: exposure,
  };
}

const STATE_ORDER = Object.freeze(['CEILING_BREACH', 'BUDGET_RISK', 'STALE_PROVIDER_DATA',
  'PROVIDER_AHEAD', 'INTERNAL_AHEAD', 'IMPORT_LAG', 'IN_SYNC']);

/**
 * Classify the reconciliation. Pure. Returns the most severe state plus every flag behind it, so the
 * Owner sees the whole picture rather than the first problem.
 */
function classify({ position, providerMonthCents = null, internalMonthCents = null, campaignDrift = [],
  campaignOverAuthorization = [], lastSuccessAt = null, now = new Date(), toleranceCents = 100,
  maxAgeMinutes = 120, intervalMinutes = 60, anyActive = false } = {}) {
  const flags = [];
  const tol = Number(toleranceCents) || 0;
  const p = position || {};

  if (p.actual_spend_cents > p.monthly_ceiling_cents) flags.push({ state: 'CEILING_BREACH', code: 'MONTH_ACTUAL_OVER_CEILING', detail: 'actual spend is above the monthly ceiling' });
  for (const c of campaignOverAuthorization) {
    flags.push({ state: 'CEILING_BREACH', code: 'CAMPAIGN_OVER_AUTHORIZATION', detail: c.campaign_key + ' spent $' + (c.lifetime_actual_cents / 100).toFixed(2) + ' of a $' + (c.authorized_cents / 100).toFixed(2) + ' authorization' });
  }
  if (p.total_exposure_cents > p.monthly_ceiling_cents + tol) flags.push({ state: 'BUDGET_RISK', code: 'EXPOSURE_OVER_CEILING', detail: 'spent plus authorized-but-unspent exceeds the monthly ceiling' });
  if (p.projected_month_end_spend_cents > p.monthly_ceiling_cents) flags.push({ state: 'BUDGET_RISK', code: 'PROJECTED_OVER_CEILING', detail: 'current pace projects past the monthly ceiling' });
  if (p.unmapped_actual_cents > tol) flags.push({ state: 'BUDGET_RISK', code: 'UNAUTHORIZED_PROVIDER_SPEND', detail: '$' + (p.unmapped_actual_cents / 100).toFixed(2) + ' was spent by provider campaigns Advantage.Bid did not authorize' });
  if (p.configured_daily_budget_cents > 0 && p.today_spend_cents > p.configured_daily_budget_cents * p.provider_max_daily_overdelivery + tol) {
    flags.push({ state: 'BUDGET_RISK', code: 'PACE_ABOVE_PROVIDER_MAXIMUM', detail: "today's spend is above even the provider's documented single-day maximum for the configured budgets" });
  }
  // Warnings that do not change the state on their own.
  if (p.today_spend_cents > p.safe_daily_pacing_target_cents && p.safe_daily_pacing_target_cents > 0) flags.push({ state: null, code: 'PACE_ABOVE_SAFE_TARGET', detail: "today's spend is above the safe daily pacing target" });
  if (p.configured_daily_budget_cents > p.recommended_max_daily_budget_cents) flags.push({ state: null, code: 'NOMINAL_BUDGETS_ABOVE_RECOMMENDED', detail: 'configured daily budgets exceed the recommended maximum for the remaining month' });

  const ageMin = lastSuccessAt ? (new Date(now).getTime() - new Date(lastSuccessAt).getTime()) / 60000 : Infinity;
  if (ageMin > maxAgeMinutes) flags.push({ state: 'STALE_PROVIDER_DATA', code: 'PROVIDER_SPEND_STALE', detail: lastSuccessAt ? 'provider spend last read ' + Math.round(ageMin) + ' min ago' : 'provider spend has never been read' });
  else if (anyActive && ageMin > intervalMinutes + 10) flags.push({ state: 'IMPORT_LAG', code: 'SYNC_OVERDUE', detail: 'provider spend last read ' + Math.round(ageMin) + ' min ago' });

  if (providerMonthCents != null && internalMonthCents != null) {
    if (providerMonthCents > internalMonthCents + tol) flags.push({ state: 'PROVIDER_AHEAD', code: 'PROVIDER_MONTH_AHEAD', detail: 'provider reports $' + (providerMonthCents / 100).toFixed(2) + ', ledger holds $' + (internalMonthCents / 100).toFixed(2) });
    else if (internalMonthCents > providerMonthCents + tol) flags.push({ state: 'INTERNAL_AHEAD', code: 'INTERNAL_MONTH_AHEAD', detail: 'ledger holds $' + (internalMonthCents / 100).toFixed(2) + ', provider reports $' + (providerMonthCents / 100).toFixed(2) });
  }
  for (const d of campaignDrift) {
    if (Math.abs(d.provider_cents - d.internal_cents) <= tol) continue;
    flags.push({ state: d.provider_cents > d.internal_cents ? 'PROVIDER_AHEAD' : 'INTERNAL_AHEAD', code: 'CAMPAIGN_DRIFT',
      detail: d.campaign_key + ': provider $' + (d.provider_cents / 100).toFixed(2) + ' vs ledger $' + (d.internal_cents / 100).toFixed(2) });
  }

  const states = new Set(flags.map((f) => f.state).filter(Boolean));
  const state = STATE_ORDER.find((s) => states.has(s)) || 'IN_SYNC';
  return { state, flags };
}

/**
 * Is an attribution touch a real, countable paid landing visit? Pure.
 * Provider ad review crawls every destination in the minutes after activation — with a click id and
 * a provider referrer — so those look like paid clicks. They are not people.
 */
function classifyTouch(t, { activatedAt = null, reviewWindowMinutes = DEFAULTS.review_window_minutes } = {}) {
  if (t.user_agent_class === 'crawler') return 'crawler';
  if (activatedAt && new Date(t.touched_at).getTime() < new Date(activatedAt).getTime() + reviewWindowMinutes * 60000) return 'provider_review_window';
  if (!t.click_type && !t.referrer_host) return 'no_click_id';
  return 'visit';
}

/**
 * One row per campaign the ledger knows about (authorized, spent, or both), enriched with the
 * provider's own figures where the campaign exists there. Pure.
 *
 * The LEDGER is the base: a campaign whose authority is reserved but which has not reached the
 * provider yet still carries unspent exposure. Spend recorded against provider campaigns we never
 * authorized ('unmapped:…') is returned separately as unmapped month spend.
 */
function campaignRows({ ledgerCampaigns = [], providerCampaigns = [] } = {}) {
  const rows = new Map();
  let unmappedMonthCents = 0;
  for (const l of ledgerCampaigns) {
    if (!l.campaign_key || l.campaign_key.startsWith('unmapped:') || l.campaign_key === '(unassigned)') {
      unmappedMonthCents += Number(l.month_actual_cents) || 0;
      continue;
    }
    rows.set(l.campaign_key, { campaign_key: l.campaign_key, provider_campaign_id: null, state: null, market_key: null, funnel: null,
      authorized_cents: Number(l.authorized_cents) || 0, ledger_lifetime_cents: Number(l.lifetime_actual_cents) || 0,
      month_actual_cents: Number(l.month_actual_cents) || 0, provider_lifetime_cents: null });
  }
  for (const p of providerCampaigns) {
    const r = rows.get(p.campaign_key) || { campaign_key: p.campaign_key, authorized_cents: 0, ledger_lifetime_cents: 0, month_actual_cents: 0 };
    Object.assign(r, { provider_campaign_id: p.provider_campaign_id ? String(p.provider_campaign_id) : null, state: p.state || null,
      market_key: p.market_key || null, funnel: p.funnel || null,
      provider_lifetime_cents: p.provider_lifetime_cents == null ? null : Number(p.provider_lifetime_cents), adsets: p.adsets });
    rows.set(p.campaign_key, r);
  }
  for (const r of rows.values()) {
    // Conservative: whichever of provider and ledger is higher is what has been spent.
    r.lifetime_actual_cents = Math.max(r.ledger_lifetime_cents, r.provider_lifetime_cents || 0);
  }
  return { rows: [...rows.values()], unmappedMonthCents };
}

// ── provider reads (GET only) ─────────────────────────────────────────────────────────────────

async function providerGet(pathname) {
  const r = await meta.call(pathname);
  if (!r.ok) return { ok: false, reason: r.detail || r.error };
  return { ok: true, data: r.data };
}

async function providerPaged(pathname) {
  const rows = [];
  let next = pathname;
  for (let i = 0; next && i < 20; i += 1) {
    const r = await providerGet(next);
    if (!r.ok) return r;
    rows.push(...((r.data && r.data.data) || []));
    const n = r.data && r.data.paging && r.data.paging.next;
    next = n ? n.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '').replace(/access_token=[^&]+&?/, '') : null;
  }
  return { ok: true, rows };
}

async function readProvider(account, ctx) {
  const range = encodeURIComponent(JSON.stringify({ since: ctx.month_start, until: ctx.today }));
  const [lifetime, month, adsets] = await Promise.all([
    providerPaged('/' + account + '/insights?level=campaign&date_preset=maximum&fields=campaign_id,campaign_name,spend&limit=100'),
    providerGet('/' + account + '/insights?level=account&fields=spend&time_range=' + range),
    providerPaged('/' + account + '/adsets?fields=id,name,campaign_id,daily_budget,effective_status&limit=100'),
  ]);
  if (!lifetime.ok) return { ok: false, reason: 'campaign lifetime spend: ' + lifetime.reason };
  if (!month.ok) return { ok: false, reason: 'account month spend: ' + month.reason };
  if (!adsets.ok) return { ok: false, reason: 'ad set budgets: ' + adsets.reason };
  const monthRow = ((month.data && month.data.data) || [])[0];
  return {
    ok: true,
    campaign_lifetime: lifetime.rows.map((x) => ({ provider_campaign_id: String(x.campaign_id), name: x.campaign_name || null, spend_cents: Math.round(Number(x.spend || 0) * 100) })),
    month_cents: monthRow ? Math.round(Number(monthRow.spend || 0) * 100) : 0,
    adsets: adsets.rows.map((a) => ({ id: String(a.id), campaign_id: String(a.campaign_id), name: a.name || null,
      daily_budget_cents: a.daily_budget != null ? Number(a.daily_budget) : null, effective_status: a.effective_status || null })),
  };
}

// ── sync ──────────────────────────────────────────────────────────────────────────────────────

async function campaignMap(runner) {
  const rows = (await runner.query(
    `SELECT campaign_key, provider_campaign_id, state, activated_at, market_key, funnel, budget_cents
       FROM marketing_paid_campaigns WHERE provider_campaign_id IS NOT NULL`)).rows;
  const objs = (await runner.query(
    `SELECT provider_id, campaign_key FROM marketing_provider_objects
      WHERE object_type = 'campaign' AND certification_artifact = false AND provider_id IS NOT NULL`)).rows;
  const byId = new Map();
  for (const o of objs) byId.set(String(o.provider_id), { campaign_key: o.campaign_key });
  for (const r of rows) byId.set(String(r.provider_campaign_id), r);
  return { byId, campaigns: rows };
}

/** Update each experiment arm from provider facts and first-party outcomes. Never invents a number. */
async function updateArms({ reviewWindowMinutes }, runner = db) {
  const arms = (await runner.query(
    `SELECT a.id, a.provider_adset_id, e.campaign_key, e.funnel, s.strategy_key, c.activated_at
       FROM marketing_audience_experiment_arms a
       JOIN marketing_audience_experiments e ON e.id = a.experiment_id
       JOIN marketing_audience_strategies s ON s.id = a.strategy_id
       LEFT JOIN marketing_paid_campaigns c ON c.campaign_key = e.campaign_key
      WHERE a.provider_adset_id IS NOT NULL`)).rows;
  let updated = 0;
  for (const a of arms) {
    const f = (await runner.query(
      `SELECT COALESCE(sum(spend_cents),0)::bigint spend, COALESCE(sum(impressions),0)::bigint impressions,
              COALESCE(sum(COALESCE(link_clicks, clicks)),0)::bigint clicks
         FROM marketing_paid_cost_facts WHERE provider = 'meta_ads' AND adset_id = $1`, [a.provider_adset_id])).rows[0];
    const touches = (await runner.query(
      `SELECT id, visitor_id, touched_at, click_type, referrer_host, user_agent_class
         FROM marketing_attribution_touches WHERE utm_campaign = $1 AND utm_term = $2`, [a.campaign_key, a.strategy_key])).rows;
    const real = touches.filter((t) => classifyTouch(t, { activatedAt: a.activated_at, reviewWindowMinutes }) === 'visit');
    const visitors = new Set(real.map((t) => t.visitor_id)).size;
    const touchIds = touches.map((t) => String(t.id));
    const regKeys = a.funnel === 'professional_seller' ? ['seller_registered', 'seller_inquiry'] : ['seller_registered'];
    const qualKeys = a.funnel === 'professional_seller' ? ['seller_inquiry', 'auction_published'] : ['auction_draft_created', 'auction_published'];
    const conv = touchIds.length ? (await runner.query(
      `SELECT conversion_key, count(*)::int n FROM marketing_conversion_events
        WHERE is_internal = false AND attribution->'last_touch'->>'id' = ANY($1::text[]) GROUP BY 1`, [touchIds])).rows : [];
    const count = (keys) => conv.filter((c) => keys.includes(c.conversion_key)).reduce((t, c) => t + c.n, 0);
    await runner.query(
      `UPDATE marketing_audience_experiment_arms
          SET spend_cents = $2, impressions = $3, clicks = $4, landing_visits = $5, registrations = $6,
              qualified_conversions = $7, last_observed_at = now()
        WHERE id = $1`,
      [a.id, Number(f.spend), Number(f.impressions), Number(f.clicks), visitors, count(regKeys), count(qualKeys)]);
    updated += 1;
  }
  return updated;
}

async function recordSync(row, runner = db) {
  const r = await runner.query(
    `INSERT INTO marketing_paid_spend_syncs (provider, account_ref, trigger, started_at, finished_at, ok, window_since, window_until,
       month, provider_month_cents, internal_month_cents, provider_campaigns, ledger_entries, arms_updated,
       reconciliation_state, flags, actions, error)
     VALUES ('meta',$1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15::jsonb,$16) RETURNING id, finished_at`,
    [row.account_ref || null, row.trigger, row.started_at, row.ok, row.window_since || null, row.window_until || null,
      row.month || null, row.provider_month_cents == null ? null : row.provider_month_cents,
      row.internal_month_cents == null ? null : row.internal_month_cents, JSON.stringify(row.provider_campaigns || []),
      row.ledger_entries || 0, row.arms_updated || 0, row.reconciliation_state || null,
      JSON.stringify(row.flags || []), JSON.stringify(row.actions || []), row.error ? String(meta.redact(row.error)).slice(0, 500) : null]);
  return r.rows[0];
}

async function lastSuccessfulSync(runner = db) {
  // Calendar dates come back as text: a JS Date would shift them by the server's UTC offset.
  return (await runner.query(
    `SELECT id, provider, account_ref, trigger, started_at, finished_at, ok, window_since::text AS window_since,
            window_until::text AS window_until, month::text AS month, provider_month_cents, internal_month_cents,
            provider_campaigns, ledger_entries, arms_updated, reconciliation_state, flags, actions
       FROM marketing_paid_spend_syncs WHERE ok = true ORDER BY finished_at DESC LIMIT 1`)).rows[0] || null;
}

let inFlight = null;

/**
 * Read provider spend and bring the ledger, the arms and the reconciliation up to date.
 * Concurrent callers in the same process share one run; across processes the ledger's row locks and
 * idempotency keys make overlapping runs harmless.
 */
function syncSpend(opts = {}) {
  if (!inFlight) inFlight = runSync(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runSync({ trigger = 'manual', now = new Date(), runner = db, allowSafetyActions = true } = {}) {
  const startedAt = new Date();
  const s = await settings();
  const ctx = monthContext(now, s.timezone);
  const fail = async (reason, extra = {}) => {
    const row = await recordSync({ trigger, started_at: startedAt, ok: false, month: ctx.month, error: reason, reconciliation_state: 'STALE_PROVIDER_DATA', ...extra }, runner).catch(() => null);
    return { ok: false, reason, sync_id: row && row.id };
  };

  const acct = await meta.resolveAdAccount(runner);
  if (!acct.ok) return fail('ad account: ' + acct.reason);
  const account = acct.account;

  // Window: the whole current month, plus the last three days so a provider restatement across a
  // month boundary is still corrected, plus any gap since the last good read.
  const last = await lastSuccessfulSync(runner);
  let since = ctx.month_start < addDays(ctx.today, -3) ? ctx.month_start : addDays(ctx.today, -3);
  if (last && last.window_until) {
    const lastUntil = String(last.window_until instanceof Date ? last.window_until.toISOString() : last.window_until).slice(0, 10);
    const gapStart = addDays(lastUntil, -3);
    if (gapStart < since && gapStart >= addDays(ctx.today, -93)) since = gapStart;
  }
  const window = { since, until: ctx.today };

  const pulled = await require('../measurement/paidCostIngestionService').pullMeta({ since: window.since, until: window.until }, runner);
  if (!pulled.pulled) return fail('provider daily spend: ' + (pulled.detail || pulled.reason), { account_ref: account, window_since: window.since, window_until: window.until });

  const prov = await readProvider(account, ctx);
  if (!prov.ok) return fail(prov.reason, { account_ref: account, window_since: window.since, window_until: window.until });

  const map = await campaignMap(runner);
  const days = (await runner.query(
    `SELECT campaign_id, fact_date::text AS fact_date, COALESCE(sum(spend_cents),0)::bigint AS spend_cents
       FROM marketing_paid_cost_facts
      WHERE provider = 'meta_ads' AND (account_ref = $1 OR account_ref IS NULL) AND fact_date BETWEEN $2::date AND $3::date
      GROUP BY campaign_id, fact_date`, [account, window.since, window.until])).rows;
  const providerDays = days.map((d) => ({
    provider_campaign_id: String(d.campaign_id), fact_date: d.fact_date, spend_cents: Number(d.spend_cents),
    campaign_key: (map.byId.get(String(d.campaign_id)) || {}).campaign_key || null,
  }));

  const synced = await ledger.syncActualDays({ providerDays, window });
  if (!synced.ok) return fail(synced.reason, { account_ref: account, window_since: window.since, window_until: window.until });

  const armsUpdated = await updateArms({ reviewWindowMinutes: s.review_window_minutes }, runner).catch(() => 0);

  // Position from the ledger (now equal to the provider) plus the provider's own live figures.
  const st = await ledger.status(ctx.month, runner);
  const lifetimeById = new Map(prov.campaign_lifetime.map((c) => [c.provider_campaign_id, c.spend_cents]));
  const { rows: campaigns, unmappedMonthCents: unmappedMonth } = campaignRows({
    ledgerCampaigns: st.campaigns,
    providerCampaigns: map.campaigns.map((c) => ({ ...c, provider_lifetime_cents: lifetimeById.get(String(c.provider_campaign_id)) || 0 })),
  });
  const drift = campaigns.filter((c) => c.provider_campaign_id)
    .map((c) => ({ campaign_key: c.campaign_key, provider_cents: c.provider_lifetime_cents, internal_cents: c.ledger_lifetime_cents }));
  const over = campaigns.filter((c) => c.authorized_cents > 0 && c.lifetime_actual_cents > c.authorized_cents + s.tolerance_cents);

  const mappedIds = new Set(map.campaigns.map((c) => String(c.provider_campaign_id)));
  const activeCampaignIds = new Set(map.campaigns.filter((c) => c.state === 'ACTIVE').map((c) => String(c.provider_campaign_id)));
  const configuredDaily = prov.adsets
    .filter((a) => a.effective_status === 'ACTIVE' && activeCampaignIds.has(a.campaign_id))
    .reduce((t, a) => t + (a.daily_budget_cents || 0), 0);
  // Any delivering ad set outside our campaigns is still real money on this account.
  const foreignDaily = prov.adsets.filter((a) => a.effective_status === 'ACTIVE' && !mappedIds.has(a.campaign_id))
    .reduce((t, a) => t + (a.daily_budget_cents || 0), 0);

  const dayTotal = async (day) => Number((await runner.query(
    `SELECT COALESCE(sum(spend_cents),0)::bigint s FROM marketing_paid_cost_facts
      WHERE provider = 'meta_ads' AND (account_ref = $1 OR account_ref IS NULL) AND fact_date = $2::date`, [account, day])).rows[0].s);
  const position = computePosition({ ctx, ceilingCents: st.ceiling_cents, campaigns, unmappedMonthActualCents: unmappedMonth,
    todaySpendCents: await dayTotal(ctx.today), yesterdaySpendCents: await dayTotal(addDays(ctx.today, -1)),
    configuredDailyBudgetCents: configuredDaily + foreignDaily, safetyFactor: s.safety_factor, overdelivery: s.provider_max_daily_overdelivery });

  const verdict = classify({ position, providerMonthCents: prov.month_cents, internalMonthCents: st.actual_cents,
    campaignDrift: drift, campaignOverAuthorization: over, lastSuccessAt: new Date(), now: new Date(),
    toleranceCents: s.tolerance_cents, maxAgeMinutes: s.max_age_minutes, intervalMinutes: s.interval_minutes,
    anyActive: activeCampaignIds.size > 0 });

  const actions = allowSafetyActions ? await safetyActions(verdict, position, s) : [];

  const row = await recordSync({ trigger, started_at: startedAt, ok: true, account_ref: account, window_since: window.since,
    window_until: window.until, month: ctx.month, provider_month_cents: prov.month_cents, internal_month_cents: st.actual_cents,
    provider_campaigns: campaigns.map((c) => ({ ...c, adsets: prov.adsets.filter((a) => a.campaign_id === String(c.provider_campaign_id)) })),
    ledger_entries: synced.entries, arms_updated: armsUpdated, reconciliation_state: verdict.state, flags: verdict.flags, actions }, runner);

  return { ok: true, sync_id: row.id, finished_at: row.finished_at, trigger, window, ledger_entries: synced.entries,
    arms_updated: armsUpdated, provider_month_cents: prov.month_cents, internal_month_cents: st.actual_cents,
    reconciliation: verdict, position, campaigns, actions };
}

/**
 * Safety wins. A CEILING_BREACH pauses every campaign through the existing emergency stop (which also
 * engages the global kill, so nothing new can start). A BUDGET_RISK blocks new authority (ledger) and
 * alerts the Owner; existing campaigns stay bounded by their provider spend caps.
 */
async function safetyActions(verdict, position, s) {
  const actions = [];
  const alert = async (headline) => {
    try {
      await require('../ownerAlertService').notifyAdminActionRequired({
        actionType: 'paid_spend_' + verdict.state.toLowerCase(), entityType: 'paid_spend',
        entityId: verdict.state + ':' + position.month + ':' + ledger.dayInZone(new Date(), s.timezone),
        headline, context: verdict.flags.filter((f) => f.state).map((f) => f.code).join(', ').slice(0, 120),
        adminPath: '/admin/marketing-agency.html', actionLabel: 'Review paid spend' });
      actions.push({ action: 'owner_alerted', state: verdict.state });
    } catch (_) { /* alerts are best effort; the state itself is recorded */ }
  };
  if (verdict.state === 'CEILING_BREACH') {
    if (s.auto_pause_on_breach) {
      const out = await require('./paidExecutionService').emergencyKill({ reason: 'automatic: paid spend ceiling breach' })
        .catch((e) => ({ ok: false, reason: e.message }));
      actions.push({ action: 'paused_all_delivery', ok: out.ok !== false, detail: out.paused || out.reason || null });
    }
    await alert('Paid ad spend breached an Owner ceiling' + (s.auto_pause_on_breach ? ' — all paid delivery paused' : ''));
  } else if (verdict.state === 'BUDGET_RISK') {
    await alert('Paid ad spend budget risk — no new paid authority until reviewed');
  }
  return actions;
}

/**
 * Make sure the spend figures are fresh enough to decide on. Re-reads the provider when they are not,
 * and fails closed when the provider cannot be read.
 */
async function ensureFreshSpend({ maxAgeMinutes = null, trigger = 'decision' } = {}) {
  const s = await settings();
  const limit = maxAgeMinutes == null ? s.decision_max_age_minutes : maxAgeMinutes;
  const last = await lastSuccessfulSync();
  if (last && (Date.now() - new Date(last.finished_at).getTime()) / 60000 <= limit) {
    return { ok: !ledger.BLOCKING_STATES.includes(last.reconciliation_state), fresh: true, refreshed: false, sync: last,
      reason: ledger.BLOCKING_STATES.includes(last.reconciliation_state) ? 'spend reconciliation is ' + last.reconciliation_state : null };
  }
  const r = await syncSpend({ trigger });
  if (!r.ok) return { ok: false, fresh: false, refreshed: false, reason: 'provider spend could not be read — failing closed: ' + r.reason };
  const blocked = ledger.BLOCKING_STATES.includes(r.reconciliation.state);
  return { ok: !blocked, fresh: true, refreshed: true, sync: r, reason: blocked ? 'spend reconciliation is ' + r.reconciliation.state : null };
}

/** The market a campaign belongs to must be launch-authorized and provider-validated. */
async function assertMarketLaunchable({ campaignKey = null, marketKey = null } = {}, runner = db) {
  let key = marketKey;
  if (!key && campaignKey) key = ((await runner.query('SELECT market_key FROM marketing_paid_campaigns WHERE campaign_key = $1', [campaignKey])).rows[0] || {}).market_key;
  if (!key) return { ok: false, reason: 'no market recorded for ' + (campaignKey || 'this request') };
  const m = (await runner.query('SELECT status, launch_authorized, geo_validation FROM marketing_paid_markets WHERE market_key = $1', [key])).rows[0];
  if (!m) return { ok: false, reason: 'unknown market ' + key };
  if (m.status !== 'ACTIVE' || !m.launch_authorized) return { ok: false, reason: 'market ' + key + ' is ' + m.status + ' and not launch-authorized — no paid delivery may be created or activated there' };
  if (m.geo_validation !== 'VALID') return { ok: false, reason: 'market ' + key + ' geography is not provider-validated' };
  return { ok: true, market_key: key };
}

/**
 * The gate before ANY action that could add paid delivery: activation, a budget increase, a new
 * campaign, a new market. Fresh spend, a safe reconciliation, a launchable market, and (for new
 * money) enough uncommitted authority.
 */
async function assertNewSpendAllowed({ amountCents = 0, campaignKey = null, marketKey = null, action = 'spend' } = {}) {
  const fresh = await ensureFreshSpend({ trigger: action });
  if (!fresh.ok) return { ok: false, reason: fresh.reason };
  const mk = await assertMarketLaunchable({ campaignKey, marketKey });
  if (!mk.ok) return mk;
  if (amountCents > 0) {
    const st = await ledger.status();
    if (amountCents > st.remaining_cents) {
      return { ok: false, reason: `$${(amountCents / 100).toFixed(2)} requested but only $${(st.remaining_cents / 100).toFixed(2)} of monthly authority is uncommitted` };
    }
  }
  return { ok: true, market_key: mk.market_key };
}

/** Everything the Owner control centre needs, from the last good read. Read-only. */
async function overview() {
  const s = await settings();
  const ctx = monthContext(new Date(), s.timezone);
  const last = await lastSuccessfulSync();
  const lastAttempt = (await db.query(
    `SELECT id, ok, finished_at, error, trigger FROM marketing_paid_spend_syncs ORDER BY finished_at DESC LIMIT 1`)).rows[0] || null;
  const st = await ledger.status(ctx.month);
  const markets = (await db.query(
    `SELECT market_key, name, status, launch_authorized, geo_validation, geo_spec, geo_validated_at, allocation_cents, plan
       FROM marketing_paid_markets ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, market_key`)).rows;

  const snapshot = last ? (last.provider_campaigns || []) : [];
  const { rows: campaigns, unmappedMonthCents } = campaignRows({
    ledgerCampaigns: st.campaigns,
    providerCampaigns: snapshot.filter((c) => c.provider_campaign_id),
  });
  const configured = snapshot.filter((c) => c.state === 'ACTIVE')
    .reduce((t, c) => t + (c.adsets || []).filter((a) => a.effective_status === 'ACTIVE').reduce((u, a) => u + (a.daily_budget_cents || 0), 0), 0);
  const dayTotal = async (day) => Number((await db.query(
    `SELECT COALESCE(sum(spend_cents),0)::bigint s FROM marketing_paid_cost_facts WHERE provider = 'meta_ads' AND fact_date = $1::date`, [day])).rows[0].s);

  const position = computePosition({ ctx, ceilingCents: st.ceiling_cents, campaigns, unmappedMonthActualCents: unmappedMonthCents,
    todaySpendCents: await dayTotal(ctx.today), yesterdaySpendCents: await dayTotal(addDays(ctx.today, -1)),
    configuredDailyBudgetCents: configured, safetyFactor: s.safety_factor, overdelivery: s.provider_max_daily_overdelivery });

  let reconciliation = classify({ position,
    providerMonthCents: last && last.month === ctx.month ? Number(last.provider_month_cents) : null,
    internalMonthCents: st.actual_cents, lastSuccessAt: last ? last.finished_at : null, now: new Date(),
    toleranceCents: s.tolerance_cents, maxAgeMinutes: s.max_age_minutes, intervalMinutes: s.interval_minutes,
    anyActive: campaigns.some((c) => c.state === 'ACTIVE'),
    campaignDrift: campaigns.filter((c) => c.provider_campaign_id && c.provider_lifetime_cents != null)
      .map((c) => ({ campaign_key: c.campaign_key, provider_cents: c.provider_lifetime_cents, internal_cents: c.ledger_lifetime_cents })),
    campaignOverAuthorization: campaigns.filter((c) => c.authorized_cents > 0 && c.lifetime_actual_cents > c.authorized_cents + s.tolerance_cents) });
  // A breach recorded by a sync is never softened by a later recomputation.
  if (last && last.reconciliation_state === 'CEILING_BREACH' && reconciliation.state !== 'CEILING_BREACH') {
    reconciliation = { state: 'CEILING_BREACH', flags: [...(last.flags || []), ...reconciliation.flags] };
  }

  return {
    settings: { timezone: s.timezone, safety_factor: s.safety_factor, provider_max_daily_overdelivery: s.provider_max_daily_overdelivery,
      interval_minutes: s.interval_minutes, max_age_minutes: s.max_age_minutes, decision_max_age_minutes: s.decision_max_age_minutes,
      tolerance_cents: s.tolerance_cents, auto_pause_on_breach: s.auto_pause_on_breach,
      nominal_daily_budget_plan_cents: s.ceilings.daily_cents, campaign_ceiling_cents: s.ceilings.campaign_cents },
    month: ctx,
    position,
    reconciliation,
    last_sync: last ? { id: last.id, finished_at: last.finished_at, trigger: last.trigger, reconciliation_state: last.reconciliation_state,
      provider_month_cents: last.provider_month_cents == null ? null : Number(last.provider_month_cents),
      internal_month_cents: last.internal_month_cents == null ? null : Number(last.internal_month_cents),
      ledger_entries: last.ledger_entries, actions: last.actions } : null,
    last_attempt: lastAttempt,
    campaigns: campaigns.map((c) => ({ campaign_key: c.campaign_key, funnel: c.funnel, market_key: c.market_key, state: c.state,
      spent_cents: c.lifetime_actual_cents, authorized_cents: c.authorized_cents,
      unspent_cents: Math.max(0, c.authorized_cents - c.lifetime_actual_cents),
      provider_lifetime_cents: c.provider_lifetime_cents, ledger_lifetime_cents: c.ledger_lifetime_cents,
      configured_daily_budget_cents: (c.adsets || []).filter((a) => a.effective_status === 'ACTIVE').reduce((u, a) => u + (a.daily_budget_cents || 0), 0) })),
    markets,
  };
}

module.exports = {
  DEFAULTS, STATE_ORDER, settings, monthContext, addDays, computePosition, classify, classifyTouch, campaignRows,
  readProvider, updateArms, syncSpend, lastSuccessfulSync, ensureFreshSpend, assertMarketLaunchable,
  assertNewSpendAllowed, overview, safetyActions,
};
