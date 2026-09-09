'use strict';

/**
 * socialEngagementService — governed engagement/comment handling for OUR organic posts.
 *
 * The Owner enabled pages_manage_engagement for FUTURE autonomous use. This module establishes the software
 * boundary NOW, as five explicitly separated stages:
 *
 *   A. READ / OBSERVE   — autonomous (poll + webhook). Public comments/reactions on our posts are recorded.
 *   B. CLASSIFY         — autonomous, deterministic keyword rules (explainable reason; no black-box scoring).
 *   C. REPORT / LEARN   — autonomous (counts by classification feed the Director summary).
 *   D. DRAFT a response — GOVERNED capability: only when marketing.social.reply_draft_enabled (FALSE) and only
 *                         from factual auction data; a draft is stored, never sent.
 *   E. PUBLISH a reply  — STRUCTURALLY DISABLED. publishReply() always refuses; there is no Graph write path
 *                         for comments in metaGraphProvider and no config flag can enable it. Marketing
 *                         PUBLISHING authorization (A9 + Meta) does NOT imply reply authorization; enabling E
 *                         requires an explicit Owner policy AND a code change.
 *
 * Data minimization: only the provider comment id, timestamp, a ≤500-char excerpt and the classification are
 * stored. NO commenter identity (no user ids, names, profile links) is requested, stored, or derived.
 */

const db = require('../db');
const marketingConfig = require('./marketingConfigService');

const DRAFT_GATE = 'marketing.social.reply_draft_enabled';
const EXCERPT_MAX = 500;
const REPLY_POLICY = {
  publish_enabled: false,
  reason: 'autonomous_public_replies_not_authorized',
  requires: 'explicit Owner policy authorizing autonomous public replies + code change (no config flag exists by design)',
};

// ── B. Deterministic classification (explainable) ──
const RULES = [
  { cls: 'spam',            re: /(https?:\/\/|www\.)\S+|\b(crypto|forex|bitcoin|dm me|whatsapp|telegram)\b/i,                        why: 'link or solicitation pattern' },
  { cls: 'complaint',       re: /\b(scam|fraud|refund|never (got|received)|rip[- ]?off|worst|terrible|report(ed)?)\b/i,                why: 'complaint keyword' },
  { cls: 'purchase_intent', re: /\b(how much|price|still available|available\??|buy|bid|pick ?up|ship(ping)?|deliver|reserve|hold it)\b/i, why: 'purchase/logistics intent keyword' },
  { cls: 'question',        re: /\?/,                                                                                                  why: 'contains a question mark' },
  { cls: 'negative',        re: /\b(ugly|junk|overpriced|no thanks|pass|nope|meh)\b/i,                                                 why: 'negative sentiment keyword' },
  { cls: 'positive',        re: /\b(love|beautiful|gorgeous|nice|great|amazing|wow|want|interested|cool|awesome)\b|[!]{1,}|❤|😍|🔥/i,     why: 'positive sentiment keyword' },
];
function classify(text) {
  const t = String(text || '').trim();
  if (!t) return { classification: 'other', reason: 'empty text' };
  for (const rule of RULES) if (rule.re.test(t)) return { classification: rule.cls, reason: rule.why };
  return { classification: 'other', reason: 'no rule matched' };
}

// Response-state default by classification (draft only ever happens through draftResponse()).
function defaultResponseState(cls) {
  return ['question', 'purchase_intent', 'complaint'].includes(cls) ? 'draft_pending' : (cls === 'spam' ? 'no_response_needed' : 'observed');
}

/**
 * A. Record ONE observed engagement event (comment/reaction/share). Idempotent on (platform, provider_event_id).
 * Never stores author identity even if the caller passes it (fields are simply not written).
 */
async function ingestEvent({ platform, destinationId = null, providerPostId = null, socialJobId = null, kind = 'comment',
  providerEventId, occurredAt = null, text = null, source = 'poll' }, runner) {
  const r = runner || db;
  if (!platform || !providerEventId) return { ok: false, reason: 'missing_identifiers' };
  const excerpt = kind === 'comment' && text != null ? String(text).slice(0, EXCERPT_MAX) : null;
  const cls = kind === 'comment' ? classify(excerpt) : { classification: 'other', reason: `${kind} (no text)` };
  if (!socialJobId && providerPostId) {
    const j = (await r.query(`SELECT id FROM marketing_social_jobs WHERE post_id=$1 ORDER BY created_at DESC LIMIT 1`, [providerPostId])).rows[0];
    socialJobId = j ? j.id : null;
  }
  const ins = await r.query(
    `INSERT INTO marketing_social_engagement_events (platform, destination_id, provider_post_id, social_job_id, event_kind, provider_event_id, occurred_at, text_excerpt, classification, classification_reason, source, response_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (platform, provider_event_id) DO NOTHING RETURNING id`,
    [platform, destinationId, providerPostId, socialJobId, kind, String(providerEventId), occurredAt, excerpt, cls.classification, cls.reason, source,
     kind === 'comment' ? defaultResponseState(cls.classification) : 'observed']);
  if (!ins.rows.length) return { ok: true, idempotent: true };
  return { ok: true, id: ins.rows[0].id, classification: cls.classification, reason: cls.reason };
}

/** A. Poll comments for one published job (read-only). Permission gaps are reported, never treated as "no comments". */
async function pollCommentsForJob(job, { provider, destination, runner } = {}) {
  const r = runner || db;
  if (!provider || !provider.active || !provider.fetchComments || !job.post_id) return { ok: false, ingested: 0, availability: 'unavailable' };
  const res = await provider.fetchComments(job.post_id, { limit: 50 });
  if (!res.ok) return { ok: false, ingested: 0, availability: res.availability, error: res.error };
  let ingested = 0;
  for (const c of res.comments) {
    if (!c || !c.id) continue;
    const out = await ingestEvent({ platform: job.platform || 'facebook', destinationId: destination ? destination.id : job.destination_id, providerPostId: job.post_id,
      socialJobId: job.id, kind: 'comment', providerEventId: c.id, occurredAt: c.occurred_at, text: c.text, source: 'poll' }, r);
    if (out.ok && !out.idempotent) ingested++;
  }
  return { ok: true, ingested, availability: 'available', seen: res.comments.length };
}

/**
 * D. Governed DRAFT. Gated by marketing.social.reply_draft_enabled (FALSE). Builds a factual, link-clean draft
 * from auction facts only (no promises, no pricing claims). Stored on the event; NEVER published.
 */
async function draftResponse(eventId, { auction = null, runner } = {}) {
  const r = runner || db;
  if (!(await marketingConfig.getBool(DRAFT_GATE, false))) return { ok: false, reason: 'reply_drafting_disabled', gate: DRAFT_GATE };
  const ev = (await r.query(`SELECT * FROM marketing_social_engagement_events WHERE id=$1`, [eventId])).rows[0];
  if (!ev) return { ok: false, reason: 'not_found' };
  if (ev.event_kind !== 'comment') return { ok: false, reason: 'not_a_comment' };
  if (ev.classification === 'spam') return { ok: false, reason: 'no_response_for_spam' };
  const link = auction && auction.auction_id ? `https://bid.advantage.bid/auction/${auction.auction_id}` : 'https://bid.advantage.bid';
  const templates = {
    question: `Thanks for asking! Full details, photos, and closing times are on the auction page: ${link}`,
    purchase_intent: `Bidding happens on Advantage.Bid — register free and bid here: ${link}${auction && auction.closing_at ? ` (closes ${auction.closing_at})` : ''}`,
    complaint: `We're sorry to hear that. Please reach our team through the contact page so we can help directly: https://bid.advantage.bid/contact.html`,
    positive: `Thank you! See everything in this auction here: ${link}`,
    negative: null, other: null,
  };
  const draft = templates[ev.classification] || null;
  if (!draft) { await r.query(`UPDATE marketing_social_engagement_events SET response_state='no_response_needed' WHERE id=$1`, [eventId]); return { ok: true, drafted: false, response_state: 'no_response_needed' }; }
  await r.query(`UPDATE marketing_social_engagement_events SET draft_text=$2, response_state='draft_ready' WHERE id=$1`, [eventId, draft]);
  return { ok: true, drafted: true, response_state: 'draft_ready', draft, published: false };
}

/** E. STRUCTURALLY DISABLED. No config, argument, or gate can make this publish. */
async function publishReply() {
  return { ok: false, published: false, ...REPLY_POLICY };
}

/** C. Aggregate view for the Director / Admin (counts only; no excerpts, no identities). */
async function summary(runner, { sinceDays = 30 } = {}) {
  const r = runner || db;
  const rows = (await r.query(
    `SELECT platform, event_kind, classification, count(*)::int n
       FROM marketing_social_engagement_events WHERE created_at >= now() - ($1::int * interval '1 day')
      GROUP BY platform, event_kind, classification ORDER BY platform, event_kind, classification`, [sinceDays])).rows;
  const pending = (await r.query(`SELECT count(*)::int n FROM marketing_social_engagement_events WHERE response_state IN ('draft_pending','draft_ready')`)).rows[0];
  const draftGate = await marketingConfig.getBool(DRAFT_GATE, false);
  return {
    window_days: sinceDays, by_platform_kind_classification: rows,
    awaiting_human_response: pending ? pending.n : 0,
    governance: { observe: 'autonomous', classify: 'autonomous', learn: 'autonomous', draft: draftGate ? 'enabled (governed)' : 'disabled', publish: 'DISABLED (structural)' },
    reply_policy: REPLY_POLICY,
  };
}

module.exports = { DRAFT_GATE, REPLY_POLICY, EXCERPT_MAX, classify, ingestEvent, pollCommentsForJob, draftResponse, publishReply, summary };
