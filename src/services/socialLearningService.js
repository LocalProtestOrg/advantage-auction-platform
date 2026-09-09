'use strict';

/**
 * socialLearningService — MARKETING DIRECTOR ANALYSIS → DURABLE LEARNING for organic social.
 *
 * Reads the snapshots the insights loop produced (marketing_social_metric_snapshots) joined to the publish
 * facts on marketing_social_jobs (platform / destination market / wave / copy style / creative / posting
 * time) and the auction's merchandise categories, and produces EXPLAINABLE per-dimension summaries the
 * Director consumes: which platform, market, wave, copy style, posting hour/day, and merchandise category
 * attract engagement — plus downstream Advantage.Bid behavior that co-occurred (INFLUENCED, never causal).
 *
 * Durable learning reuses marketing_learnings (Growth Lab 4B) — NOT a new memory store. A finding is only
 * recorded when the sample is adequate (MIN_SAMPLE posts per dimension value) and the difference is material
 * (≥ MATERIAL_RELATIVE_DIFF vs. the overall rate); attribution_grade is always 'correlational' and the
 * statement carries its evidence. Re-running supersedes the previous social finding for the same key
 * (idempotent). Engagement rate = engagement / reach when both are AVAILABLE — posts missing either are
 * reported as gaps, never imputed.
 */

const db = require('../db');
const learning = require('./marketingLearningService');
const catalog = require('../lib/socialMetricCatalog');

const MIN_SAMPLE = 5;                 // posts per dimension value before a finding is stated
const MATERIAL_RELATIVE_DIFF = 0.25;  // ±25% vs overall engagement rate
const PREFERRED_WINDOW = 'd7';        // steady-state window; falls back to the latest captured
const TZ = 'America/New_York';

function localParts(ts) {
  const d = new Date(ts);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(d);
  const hour = Number((f.find((p) => p.type === 'hour') || {}).value);
  const weekday = (f.find((p) => p.type === 'weekday') || {}).value || null;
  const bucket = !Number.isFinite(hour) ? null : (hour < 9 ? 'early' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night');
  return { hour: Number.isFinite(hour) ? hour : null, weekday, bucket };
}

function num(m, key) { const x = m && m[key]; return x && x.availability === 'available' && typeof x.value === 'number' ? x.value : null; }
function engagementOf(metrics) {
  let any = false; let total = 0;
  for (const k of catalog.ENGAGEMENT_KEYS) { const v = num(metrics, k); if (v != null) { any = true; total += v; } }
  return any ? total : null;
}

/** Load one measured row per REAL published post (latest snapshot, preferring d7). */
async function loadMeasuredPosts(runner, { sinceDays = 90 } = {}) {
  const r = runner || db;
  const rows = (await r.query(
    `SELECT j.id, j.auction_id, j.platform, j.wave, j.copy_style, j.creative_job_id, j.state_code, j.destination_id, j.published_at, j.post_id,
            d.scope AS destination_scope, d.state_code AS destination_state, d.label AS destination_label,
            s.window_key, s.metrics, s.provider_status
       FROM marketing_social_jobs j
       LEFT JOIN marketing_social_destinations d ON d.id = j.destination_id
       LEFT JOIN LATERAL (
         SELECT window_key, metrics, provider_status FROM marketing_social_metric_snapshots ms
          WHERE ms.social_job_id = j.id
          ORDER BY (window_key = $2) DESC, observed_at DESC LIMIT 1) s ON true
      WHERE j.status = 'published' AND j.shadow = false AND j.published_at >= now() - ($1::int * interval '1 day')`,
    [sinceDays, PREFERRED_WINDOW])).rows;
  // Merchandise category: the auction's dominant lot category (auction_id is TEXT on social jobs).
  const auctionIds = [...new Set(rows.map((x) => x.auction_id).filter(Boolean))];
  const catByAuction = {};
  if (auctionIds.length) {
    const cats = (await r.query(
      `SELECT auction_id::text AS auction_id, category_key, count(*)::int n FROM lots
        WHERE auction_id::text = ANY($1::text[]) AND category_key IS NOT NULL GROUP BY auction_id, category_key`, [auctionIds])).rows;
    for (const c of cats) { const cur = catByAuction[c.auction_id]; if (!cur || c.n > cur.n) catByAuction[c.auction_id] = { key: c.category_key, n: c.n }; }
  }
  return rows.map((x) => {
    const metrics = x.metrics || {};
    const reach = num(metrics, 'reach'); const impressions = num(metrics, 'impressions'); const eng = engagementOf(metrics);
    const denom = reach != null ? reach : impressions;
    const t = x.published_at ? localParts(x.published_at) : { hour: null, weekday: null, bucket: null };
    return {
      job_id: x.id, auction_id: x.auction_id, platform: x.platform || 'facebook', wave: x.wave || 'ANY', copy_style: x.copy_style || null,
      creative_job_id: x.creative_job_id || null,
      market: x.destination_scope === 'state' ? `state:${x.destination_state}` : (x.destination_scope ? `${x.destination_scope}` : 'unknown'),
      category: catByAuction[x.auction_id] ? catByAuction[x.auction_id].key : null,
      weekday: t.weekday, hour_bucket: t.bucket, window: x.window_key || null, measured: !!x.window_key,
      reach, impressions, engagement: eng, clicks: num(metrics, 'clicks'), comments: num(metrics, 'comments'), shares: num(metrics, 'shares'), saves: num(metrics, 'saves'),
      video_views: num(metrics, 'video_views'),
      engagement_rate: eng != null && denom != null && denom > 0 ? eng / denom : null,
    };
  });
}

function groupBy(posts, dim) {
  const g = {};
  for (const p of posts) {
    const v = p[dim] == null ? 'unknown' : String(p[dim]);
    const b = g[v] || (g[v] = { value: v, posts: 0, measured: 0, with_rate: 0, reach_sum: 0, reach_n: 0, engagement_sum: 0, engagement_n: 0, rate_sum: 0, clicks_sum: 0, clicks_n: 0 });
    b.posts++; if (p.measured) b.measured++;
    if (p.reach != null) { b.reach_sum += p.reach; b.reach_n++; }
    if (p.engagement != null) { b.engagement_sum += p.engagement; b.engagement_n++; }
    if (p.clicks != null) { b.clicks_sum += p.clicks; b.clicks_n++; }
    if (p.engagement_rate != null) { b.with_rate++; b.rate_sum += p.engagement_rate; }
  }
  return Object.values(g).map((b) => ({
    value: b.value, posts: b.posts, measured: b.measured,
    avg_reach: b.reach_n ? Math.round(b.reach_sum / b.reach_n) : null,
    avg_engagement: b.engagement_n ? Math.round((b.engagement_sum / b.engagement_n) * 10) / 10 : null,
    total_clicks: b.clicks_n ? b.clicks_sum : null,
    avg_engagement_rate: b.with_rate ? Math.round((b.rate_sum / b.with_rate) * 10000) / 10000 : null,
    sample_adequate: b.with_rate >= MIN_SAMPLE,
  })).sort((a, c) => (c.avg_engagement_rate || 0) - (a.avg_engagement_rate || 0));
}

const DIMENSIONS = ['platform', 'market', 'wave', 'copy_style', 'category', 'weekday', 'hour_bucket'];

/** Downstream Advantage.Bid behavior that co-occurred with posts (INFLUENCED — correlational, never causal). */
async function downstreamSignals(runner, posts, { windowDays = 7 } = {}) {
  const r = runner || db;
  const out = { note: 'INFLUENCED: co-occurrence with the post window via Meta referrers/fbclid — never a causal claim.', by_post: [], totals: { social_referred_events: 0, social_referred_bid_intent: 0, fbclid_captures: 0 } };
  for (const p of posts) {
    if (!p.auction_id || !/^[0-9a-f-]{36}$/i.test(p.auction_id)) continue;
    const startRow = (await r.query(`SELECT published_at FROM marketing_social_jobs WHERE id=$1`, [p.job_id])).rows[0];
    if (!startRow || !startRow.published_at) continue;
    const start = new Date(startRow.published_at); const end = new Date(start.getTime() + windowDays * 86400000);
    const ev = (await r.query(
      `SELECT count(*)::int n,
              count(*) FILTER (WHERE page_intent IN ('auction_interest','event_interest','estate_sale_interest') OR event_type IN ('bid_placed','watchlist_add'))::int intent
         FROM analytics_events
        WHERE auction_id = $1::uuid AND received_at >= $2 AND received_at < $3
          AND (referrer ILIKE '%facebook.com%' OR referrer ILIKE '%instagram.com%' OR referrer ILIKE '%fb.me%' OR referrer ILIKE '%l.facebook%' OR referrer ILIKE '%lm.instagram%')`,
      [p.auction_id, start.toISOString(), end.toISOString()])).rows[0];
    out.by_post.push({ job_id: p.job_id, auction_id: p.auction_id, social_referred_events: ev.n, social_referred_bid_intent: ev.intent });
    out.totals.social_referred_events += ev.n; out.totals.social_referred_bid_intent += ev.intent;
  }
  if (posts.length) {
    const fb = (await r.query(`SELECT count(*)::int n FROM marketing_click_ids WHERE click_type='fbclid' AND first_seen_at >= now() - ($1::int * interval '1 day')`, [90])).rows[0];
    out.totals.fbclid_captures = fb ? fb.n : 0;
  }
  return out;
}

/** Account growth from daily snapshots (followers delta over the window). */
async function accountGrowth(runner, { sinceDays = 30 } = {}) {
  const r = runner || db;
  const rows = (await r.query(
    `SELECT destination_id, platform, day, metrics FROM marketing_social_account_snapshots
      WHERE day >= (current_date - ($1::int)) ORDER BY destination_id, day ASC`, [sinceDays])).rows;
  const byDest = {};
  for (const x of rows) { (byDest[x.destination_id] = byDest[x.destination_id] || { platform: x.platform, first: null, last: null, days: 0 }); const b = byDest[x.destination_id]; const f = num(x.metrics, 'followers'); b.days++; if (f != null) { if (b.first == null) b.first = { day: x.day, followers: f }; b.last = { day: x.day, followers: f }; } }
  return Object.entries(byDest).map(([destination_id, b]) => ({ destination_id, platform: b.platform, days_observed: b.days,
    followers_first: b.first ? b.first.followers : null, followers_last: b.last ? b.last.followers : null,
    followers_delta: b.first && b.last ? b.last.followers - b.first.followers : null }));
}

/** The Director's organic-social summary (explainable aggregates; no identities; no economics). */
async function directorSummary(runner, { sinceDays = 90 } = {}) {
  const r = runner || db;
  const posts = await loadMeasuredPosts(r, { sinceDays });
  const measured = posts.filter((p) => p.measured);
  const withRate = posts.filter((p) => p.engagement_rate != null);
  const overallRate = withRate.length ? withRate.reduce((a, p) => a + p.engagement_rate, 0) / withRate.length : null;
  const gaps = { posts_without_snapshot: posts.length - measured.length, posts_without_reach: measured.filter((p) => p.reach == null && p.impressions == null).length,
                 posts_without_engagement: measured.filter((p) => p.engagement == null).length };
  const dims = {};
  for (const d of DIMENSIONS) dims[d] = groupBy(posts, d);
  let engagementSummary = null;
  try { engagementSummary = await require('./socialEngagementService').summary(r, { sinceDays }); } catch (_) { engagementSummary = null; }
  return {
    window_days: sinceDays, posts_published: posts.length, posts_measured: measured.length, posts_with_engagement_rate: withRate.length,
    overall_engagement_rate: overallRate == null ? null : Math.round(overallRate * 10000) / 10000,
    minimum_sample_per_finding: MIN_SAMPLE,
    by_dimension: dims,
    downstream: await downstreamSignals(r, measured),
    account_growth: await accountGrowth(r, { sinceDays: Math.min(sinceDays, 30) }),
    engagement: engagementSummary,
    honest_gaps: gaps,
    note: 'Aggregates only. Engagement rate = (reactions+comments+shares+saves+clicks) / reach when both are available; nothing imputed. Correlational — never causal.',
  };
}

/**
 * Persist material, adequately-sampled findings into marketing_learnings (segment 'social_organic',
 * attribution 'correlational'). Idempotent: an existing active finding for the same key is superseded.
 */
async function recordLearnings(runner, { sinceDays = 90, dryRun = false } = {}) {
  const r = runner || db;
  const summary = await directorSummary(r, { sinceDays });
  const findings = [];
  if (summary.overall_engagement_rate == null || summary.posts_with_engagement_rate < MIN_SAMPLE) {
    return { recorded: 0, findings, reason: 'insufficient_sample', posts_with_engagement_rate: summary.posts_with_engagement_rate };
  }
  const overall = summary.overall_engagement_rate;
  for (const dim of DIMENSIONS) {
    for (const b of summary.by_dimension[dim] || []) {
      if (!b.sample_adequate || b.avg_engagement_rate == null || b.value === 'unknown') continue;
      const rel = overall > 0 ? (b.avg_engagement_rate - overall) / overall : 0;
      if (Math.abs(rel) < MATERIAL_RELATIVE_DIFF) continue;
      const verdict = rel > 0 ? 'positive' : 'negative';
      const key = `social_organic:${dim}:${b.value}`;
      const statement = `Organic social ${dim} "${b.value}" averaged ${(b.avg_engagement_rate * 100).toFixed(2)}% engagement rate vs ${(overall * 100).toFixed(2)}% overall (${b.posts} posts, ${sinceDays}-day window) — ${verdict === 'positive' ? 'outperforms' : 'underperforms'} by ${(Math.abs(rel) * 100).toFixed(0)}%.`;
      findings.push({ key, dim, value: b.value, verdict, statement, posts: b.posts, rate: b.avg_engagement_rate });
    }
  }
  if (dryRun) return { recorded: 0, dry_run: true, findings };
  let recorded = 0;
  for (const f of findings) {
    const prev = (await r.query(`SELECT id, statement FROM marketing_learnings WHERE segment=$1 AND category=$2 AND superseded_by IS NULL ORDER BY valid_as_of DESC LIMIT 1`, ['social_organic', f.key])).rows[0];
    if (prev && prev.statement === f.statement) continue; // unchanged — idempotent
    const row = await learning.record({ statement: f.statement, scope: 'segment_specific', segment: 'social_organic', category: f.key,
      verdict: f.verdict, confidence: f.posts >= MIN_SAMPLE * 2 ? 'moderate' : 'low', attributionGrade: 'correlational',
      invalidatingConditions: ['metric availability changes at the provider', `fewer than ${MIN_SAMPLE} posts in the dimension`, 'posting mix changes materially'] });
    if (prev) await learning.supersede(prev.id, row.id);
    recorded++;
  }
  return { recorded, findings };
}

module.exports = { MIN_SAMPLE, MATERIAL_RELATIVE_DIFF, DIMENSIONS, PREFERRED_WINDOW, localParts, engagementOf, loadMeasuredPosts, groupBy, downstreamSignals, accountGrowth, directorSummary, recordLearnings };
