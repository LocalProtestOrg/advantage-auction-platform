'use strict';

/**
 * socialMetricCatalog — the SINGLE place that maps provider-specific Meta metrics onto Advantage.Bid's
 * normalized social metric keys. Everything the insights loop reads is declared here as DATA so a Graph API
 * metric rename/deprecation is a one-line catalog change, never a code hunt.
 *
 * Normalized keys (provider-neutral; what the Marketing Director reasons about):
 *   impressions, reach, engaged_users, clicks, reactions, comments, shares, saves, video_views
 * Account-level: followers, media_count, account_impressions, account_reach
 *
 * Availability is ALWAYS explicit per metric: 'available' (numeric value observed), 'unavailable' (provider
 * returned nothing for it), 'not_supported' (provider rejected the metric for this object/version), 'error'.
 * A missing metric is NEVER written as 0 — zero is only recorded when the provider actually said 0.
 */

// Facebook Page POST — /{post-id}/insights (read_insights) + object fields (pages_read_engagement).
const FACEBOOK_POST = {
  insights: [
    { key: 'impressions',   metric: 'post_impressions' },
    { key: 'reach',         metric: 'post_impressions_unique' },
    { key: 'engaged_users', metric: 'post_engaged_users' },
    { key: 'clicks',        metric: 'post_clicks' },
    { key: 'reactions',     metric: 'post_reactions_by_type_total', reduce: 'sum_object' },
    { key: 'video_views',   metric: 'post_video_views', optional: true },
  ],
  // Object fields read on the post itself (comments/shares/reactions summaries).
  fields: 'shares,comments.summary(true).limit(0),reactions.summary(true).limit(0),created_time',
  fieldMap: [
    { key: 'shares',    path: ['shares', 'count'] },
    { key: 'comments',  path: ['comments', 'summary', 'total_count'] },
    { key: 'reactions', path: ['reactions', 'summary', 'total_count'], fallbackOnly: true }, // only if insights lacked reactions
  ],
};

// Instagram MEDIA — /{ig-media-id}/insights (instagram_manage_insights) + object fields (instagram_basic).
// `impressions` is deprecated for newer media on recent Graph versions → recorded as not_supported, never fabricated.
const INSTAGRAM_MEDIA = {
  insights: [
    { key: 'reach',       metric: 'reach' },
    { key: 'impressions', metric: 'impressions', optional: true },
    { key: 'video_views', metric: 'views', optional: true },
    { key: 'reactions',   metric: 'likes' },
    { key: 'comments',    metric: 'comments' },
    { key: 'shares',      metric: 'shares' },
    { key: 'saves',       metric: 'saved' },
  ],
  fields: 'like_count,comments_count,media_type,timestamp',
  fieldMap: [
    { key: 'reactions', path: ['like_count'], fallbackOnly: true },
    { key: 'comments',  path: ['comments_count'], fallbackOnly: true },
  ],
};

// Account level (daily). Facebook Page fields need pages_read_engagement; insights need read_insights.
const FACEBOOK_PAGE = {
  fields: 'followers_count,fan_count',
  fieldMap: [
    { key: 'followers', path: ['followers_count'] },
    { key: 'fans',      path: ['fan_count'], optional: true },
  ],
  insights: [
    { key: 'account_impressions', metric: 'page_impressions', period: 'day', optional: true },
    { key: 'account_engagements', metric: 'page_post_engagements', period: 'day', optional: true },
  ],
};
const INSTAGRAM_ACCOUNT = {
  fields: 'followers_count,media_count',
  fieldMap: [
    { key: 'followers',   path: ['followers_count'] },
    { key: 'media_count', path: ['media_count'] },
  ],
  insights: [
    { key: 'account_reach', metric: 'reach', period: 'day', optional: true },
  ],
};

// Bounded post-level polling ladder (after publish). Windows are idempotent per (job, window).
const POLL_LADDER = [
  { key: 'h1',  afterMs: 1 * 60 * 60 * 1000 },
  { key: 'h24', afterMs: 24 * 60 * 60 * 1000 },
  { key: 'h72', afterMs: 72 * 60 * 60 * 1000 },
  { key: 'd7',  afterMs: 7 * 24 * 60 * 60 * 1000 },
  { key: 'd14', afterMs: 14 * 24 * 60 * 60 * 1000 },
];
const MAX_ERRORS_PER_WINDOW = 4;                 // then the window is recorded as 'error' and the ladder advances
const ERROR_BACKOFF_BASE_MS = 15 * 60 * 1000;    // 15m, 30m, 60m, 120m

// Normalized keys that count as "engagement" for the Director's engagement-rate view.
const ENGAGEMENT_KEYS = ['reactions', 'comments', 'shares', 'saves', 'clicks'];

function postCatalog(platform) { return platform === 'instagram' ? INSTAGRAM_MEDIA : FACEBOOK_POST; }
function accountCatalog(platform) { return platform === 'instagram' ? INSTAGRAM_ACCOUNT : FACEBOOK_PAGE; }

function dig(obj, path) { let cur = obj; for (const p of path) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[p]; } return cur; }

// Reduce a Graph insight `values[0].value` to a number (or null when it is not numeric / not an object sum).
function reduceValue(entry, spec) {
  if (!entry) return null;
  const v = Array.isArray(entry.values) && entry.values.length ? entry.values[entry.values.length - 1].value : entry.value;
  if (spec.reduce === 'sum_object' && v && typeof v === 'object') return Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

module.exports = {
  FACEBOOK_POST, INSTAGRAM_MEDIA, FACEBOOK_PAGE, INSTAGRAM_ACCOUNT,
  POLL_LADDER, MAX_ERRORS_PER_WINDOW, ERROR_BACKOFF_BASE_MS, ENGAGEMENT_KEYS,
  postCatalog, accountCatalog, dig, reduceValue,
};
