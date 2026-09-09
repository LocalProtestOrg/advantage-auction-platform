'use strict';

/**
 * socialInsightsService — the OBSERVE → MEASURE → INGEST stage of the organic social loop.
 *
 * Bounded, idempotent, read-only ingestion of Meta post/account performance for posts WE published
 * (marketing_social_jobs.status='published', shadow=false). Uses read_insights / pages_read_engagement /
 * instagram_basic / instagram_manage_insights through metaGraphProvider's GET-only surface.
 *
 *   • Ladder: h1 → h24 → h72 → d7 → d14 after publish (socialMetricCatalog.POLL_LADDER). One snapshot per
 *     (job, window) — UNIQUE, so a replayed tick never double-writes.
 *   • Provider IDs, timestamps, destination/market, obligation/creative/copy linkage are retained on the job +
 *     snapshot. Metrics keep explicit availability — a missing/unsupported metric is NEVER written as 0.
 *   • Errors: bounded retry with backoff (15m·2^n, ≤ MAX_ERRORS_PER_WINDOW) then the window is recorded as
 *     'error' and the ladder advances — a dead metric never blocks later windows.
 *   • Normalization: available numeric values become marketing_performance_facts rows (MEASURED, source
 *     meta_insights) on the job's obligation — the SAME structure sellers' allowlisted reports and the
 *     Director already consume. No parallel analytics platform.
 *   • Gate: marketing.social.insights_enabled (FALSE by default). Structurally inert anyway until a REAL
 *     publish exists, which itself requires A9 + Meta publishing gates.
 *
 * Nothing here writes to Meta.
 */

const db = require('../db');
const marketingConfig = require('./marketingConfigService');
const destinations = require('./socialDestinationService');
const metaGraphProvider = require('./metaGraphProvider');
const engagement = require('./socialEngagementService');
const catalog = require('../lib/socialMetricCatalog');

const INSIGHTS_GATE = 'marketing.social.insights_enabled';

async function enabled() { return marketingConfig.getBool(INSIGHTS_GATE, false); }

/** The next ladder window for a job given its published_at and the windows already captured. */
function nextWindow(publishedAt, capturedKeys = [], now = new Date()) {
  const base = new Date(publishedAt).getTime();
  for (const w of catalog.POLL_LADDER) {
    if (capturedKeys.includes(w.key)) continue;
    return { key: w.key, dueAt: new Date(base + w.afterMs), overdue: now.getTime() >= base + w.afterMs };
  }
  return null; // ladder complete
}

// Resolve the provider bound to the job's destination (by destination_id, else the platform's national row).
async function providerForJob(job, r, providerFactory) {
  let dest = job.destination_id ? await destinations.getById(job.destination_id, r) : null;
  if (!dest) { const res = await destinations.resolveDestination({ platform: job.platform || 'facebook', stateCode: job.state_code }, r); dest = res.destination; }
  if (!dest) return { provider: null, destination: null };
  return { provider: (providerFactory || metaGraphProvider.buildProvider)(dest), destination: dest };
}

// Persist normalized MEASURED facts for the available metrics (obligation-linked; shadow never reaches here).
async function normalizeToFacts(r, job, windowKey, metrics) {
  if (!job.obligation_id) return 0;
  const ob = (await r.query(`SELECT purchase_kind, purchase_id, feature_key FROM marketing_obligations WHERE id=$1`, [job.obligation_id])).rows[0];
  let n = 0;
  for (const [key, m] of Object.entries(metrics || {})) {
    if (!m || m.availability !== 'available' || typeof m.value !== 'number') continue;
    await r.query(
      `INSERT INTO marketing_performance_facts (purchase_kind, purchase_id, obligation_id, metric, classification, value_numeric, source)
       VALUES ($1,$2,$3,$4,'MEASURED',$5,$6)`,
      [ob ? ob.purchase_kind : null, ob ? ob.purchase_id : null, job.obligation_id,
       `social_${job.platform || 'facebook'}_${key}_${windowKey}`, m.value, 'meta_insights']);
    n++;
  }
  return n;
}

/**
 * Ingest ONE due job: fetch metrics for its next window, write the snapshot (idempotent), normalize facts,
 * refresh comments (observe-only), and schedule the next window or bounded retry.
 */
async function ingestJob(job, { runner, providerFactory, now = new Date() } = {}) {
  const r = runner || db;
  const captured = (await r.query(`SELECT window_key FROM marketing_social_metric_snapshots WHERE social_job_id=$1`, [job.id])).rows.map((x) => x.window_key);
  const win = nextWindow(job.published_at, captured, now);
  if (!win) {
    await r.query(`UPDATE marketing_social_jobs SET insights_status='complete', next_insights_poll_at=NULL, last_insights_at=now() WHERE id=$1`, [job.id]);
    return { ok: true, job_id: job.id, done: true };
  }
  const { provider, destination } = await providerForJob(job, r, providerFactory);
  if (!provider || !provider.active) {
    // No usable credential/destination: represent honestly, retry later with backoff (never fabricate).
    return await recordError(r, job, win, 'provider_inactive', now);
  }
  const cat = catalog.postCatalog(job.platform || 'facebook');
  const res = await provider.fetchPostMetrics(job.post_id, cat);
  if (!res.ok && res.provider_status === 'error') return await recordError(r, job, win, res.error || 'provider_error', now);

  // Snapshot (idempotent per window).
  const ins = await r.query(
    `INSERT INTO marketing_social_metric_snapshots (social_job_id, platform, provider_post_id, destination_id, window_key, observed_at, metrics, provider_status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT (social_job_id, window_key) DO NOTHING RETURNING id`,
    [job.id, job.platform || 'facebook', job.post_id, destination ? destination.id : (job.destination_id || null), win.key, now.toISOString(),
     JSON.stringify(res.metrics || {}), res.provider_status || 'ok', res.error || null]);
  const wrote = ins.rows.length > 0;
  let facts = 0;
  if (wrote) facts = await normalizeToFacts(r, job, win.key, res.metrics);

  // Observe comments (read-only; classification only; never replies). Failure here never blocks metrics.
  let comments = { ok: false, ingested: 0, availability: 'skipped' };
  try { comments = await engagement.pollCommentsForJob(job, { provider, destination, runner: r }); } catch (e) { comments = { ok: false, ingested: 0, availability: 'error', error: e.message }; }

  const following = nextWindow(job.published_at, captured.concat([win.key]), now);
  const anyAvailable = Object.values(res.metrics || {}).some((m) => m && m.availability === 'available');
  const status = following ? 'partial' : (anyAvailable ? 'complete' : 'unavailable');
  await r.query(
    `UPDATE marketing_social_jobs SET insights_status=$2, next_insights_poll_at=$3, insights_poll_count=insights_poll_count+1, insights_error_count=0, last_insights_at=$4 WHERE id=$1`,
    [job.id, status, following ? following.dueAt.toISOString() : null, now.toISOString()]);
  return { ok: true, job_id: job.id, window: win.key, wrote, facts, provider_status: res.provider_status, comments, next: following ? following.key : null };
}

async function recordError(r, job, win, message, now) {
  const errors = Number(job.insights_error_count || 0) + 1;
  if (errors >= catalog.MAX_ERRORS_PER_WINDOW) {
    // Record the window honestly as an error and advance the ladder so later windows still get captured.
    await r.query(
      `INSERT INTO marketing_social_metric_snapshots (social_job_id, platform, provider_post_id, destination_id, window_key, observed_at, metrics, provider_status, error)
       VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,'error',$7) ON CONFLICT (social_job_id, window_key) DO NOTHING`,
      [job.id, job.platform || 'facebook', job.post_id, job.destination_id || null, win.key, now.toISOString(), String(message).slice(0, 300)]);
    const captured = (await r.query(`SELECT window_key FROM marketing_social_metric_snapshots WHERE social_job_id=$1`, [job.id])).rows.map((x) => x.window_key);
    const following = nextWindow(job.published_at, captured, now);
    await r.query(`UPDATE marketing_social_jobs SET insights_status=$2, next_insights_poll_at=$3, insights_error_count=0, last_insights_at=$4 WHERE id=$1`,
      [job.id, following ? 'error' : 'error', following ? following.dueAt.toISOString() : null, now.toISOString()]);
    return { ok: false, job_id: job.id, window: win.key, gave_up: true, error: message, next: following ? following.key : null };
  }
  const backoff = catalog.ERROR_BACKOFF_BASE_MS * Math.pow(2, errors - 1);
  await r.query(`UPDATE marketing_social_jobs SET insights_status='error', next_insights_poll_at=$2, insights_error_count=$3 WHERE id=$1`,
    [job.id, new Date(now.getTime() + backoff).toISOString(), errors]);
  return { ok: false, job_id: job.id, window: win.key, retry_in_ms: backoff, error: message };
}

/** Claim + ingest a bounded batch of due REAL posts. Inert when the gate is OFF or nothing is due. */
async function runOnce({ max = 10, runner, providerFactory, now = new Date() } = {}) {
  const r = runner || db;
  if (!(await enabled())) return { ran: false, reason: 'insights_disabled', processed: 0, results: [] };
  const due = (await r.query(
    `SELECT * FROM marketing_social_jobs
      WHERE status='published' AND shadow=false AND post_id IS NOT NULL AND next_insights_poll_at IS NOT NULL AND next_insights_poll_at <= $1
      ORDER BY next_insights_poll_at ASC LIMIT $2`, [now.toISOString(), max])).rows;
  const results = [];
  for (const job of due) {
    try { results.push(await ingestJob(job, { runner: r, providerFactory, now })); }
    catch (e) { results.push({ ok: false, job_id: job.id, error: e.message }); try { await recordError(r, job, nextWindow(job.published_at, [], now) || { key: 'manual' }, e.message, now); } catch (_) { /* keep going */ } }
  }
  return { ran: true, processed: results.length, results };
}

/**
 * Daily account snapshot for every CONFIGURED destination (account id + credential present; IG additionally
 * linked to a Page). Read-only intelligence deliberately does NOT depend on the destination's `active` flag —
 * that flag authorizes PUBLISH routing, which is a separate Owner decision. Idempotent per day.
 */
async function snapshotAccounts({ runner, providerFactory, now = new Date() } = {}) {
  const r = runner || db;
  if (!(await enabled())) return { ran: false, reason: 'insights_disabled', results: [] };
  const day = now.toISOString().slice(0, 10);
  const { evaluateDestination } = require('./socialReadinessService');
  const dests = (await destinations.list(r)).filter((d) => d.provider_account_id && evaluateDestination(d).configured);
  const results = [];
  for (const d of dests) {
    const exists = (await r.query(`SELECT 1 FROM marketing_social_account_snapshots WHERE destination_id=$1 AND day=$2`, [d.id, day])).rows.length > 0;
    if (exists) { results.push({ destination_id: d.id, skipped: 'already_captured' }); continue; }
    const provider = (providerFactory || metaGraphProvider.buildProvider)(d);
    if (!provider.active) { results.push({ destination_id: d.id, skipped: provider.reason }); continue; }
    const res = await provider.fetchAccountMetrics(catalog.accountCatalog(d.platform));
    await r.query(
      `INSERT INTO marketing_social_account_snapshots (destination_id, platform, provider_account_id, day, metrics, provider_status, error, observed_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT (destination_id, day) DO NOTHING`,
      [d.id, d.platform, d.provider_account_id, day, JSON.stringify(res.metrics || {}), res.provider_status || 'ok', res.error || null, now.toISOString()]);
    results.push({ destination_id: d.id, platform: d.platform, provider_status: res.provider_status });
  }
  return { ran: true, day, results };
}

/**
 * Pull a post's next window forward (bounded: at most once per 15 minutes) — used by the webhook receiver when
 * engagement arrives, so a poll happens sooner without unbounded churn.
 */
async function requestRefresh(providerPostId, { runner, now = new Date() } = {}) {
  const r = runner || db;
  const res = await r.query(
    `UPDATE marketing_social_jobs SET next_insights_poll_at=$2
      WHERE post_id=$1 AND status='published' AND shadow=false
        AND (last_insights_at IS NULL OR last_insights_at < $3)
        AND (next_insights_poll_at IS NULL OR next_insights_poll_at > $2)
      RETURNING id`,
    [providerPostId, now.toISOString(), new Date(now.getTime() - 15 * 60 * 1000).toISOString()]);
  return { refreshed: res.rows.length };
}

/** Operator-facing status (no secrets). */
async function status(runner) {
  const r = runner || db;
  const on = await enabled();
  const jobs = (await r.query(
    `SELECT count(*) FILTER (WHERE status='published' AND shadow=false)::int real_published,
            count(*) FILTER (WHERE status='published' AND shadow=false AND next_insights_poll_at IS NOT NULL)::int polling,
            count(*) FILTER (WHERE insights_status='complete')::int complete,
            count(*) FILTER (WHERE insights_status='error')::int in_error,
            max(last_insights_at) last_ingested_at
       FROM marketing_social_jobs`)).rows[0] || {};
  const snaps = (await r.query(`SELECT count(*)::int n FROM marketing_social_metric_snapshots`)).rows[0] || { n: 0 };
  const acct = (await r.query(`SELECT count(*)::int n, max(day) last_day FROM marketing_social_account_snapshots`)).rows[0] || { n: 0 };
  return { gate: { key: INSIGHTS_GATE, enabled: on }, ladder: catalog.POLL_LADDER.map((w) => w.key),
           posts: jobs, post_snapshots: snaps.n, account_snapshots: acct.n, last_account_day: acct.last_day || null,
           note: 'Read-only ingestion. Missing/unsupported metrics are recorded as unavailable — never fabricated.' };
}

module.exports = { INSIGHTS_GATE, enabled, nextWindow, ingestJob, runOnce, snapshotAccounts, requestRefresh, status, normalizeToFacts };
