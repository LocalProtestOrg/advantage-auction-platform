'use strict';

/**
 * metaWebhookService — verification + bounded, replay-protected processing of Meta webhook deliveries
 * (Page `feed` changes and Instagram `comments`). Webhooks complement polling: they make engagement visible
 * sooner and pull a post's next insights window forward, but the polling ladder remains the source of truth
 * for metrics. Provider-side subscription (App Dashboard callback + verify token, then subscribing the Page
 * via pages_manage_metadata) is an OWNER console step — this module never alters Page settings.
 *
 * SECURITY (fail-closed):
 *   • GET verification requires META_WEBHOOK_VERIFY_TOKEN (timing-safe compare) → echoes hub.challenge.
 *   • POST requires META_APP_SECRET; X-Hub-Signature-256 (HMAC-SHA256 over the RAW body) is verified
 *     timing-safe → 401 otherwise. Missing secret → 503. Nothing in a payload is trusted.
 *   • Replay/idempotency: sha256(object|entry.id|entry.time|field|value) UNIQUE; duplicates are ignored.
 *   • Tenant isolation: changes for ANY provider account id that is not a registered Advantage.Bid destination
 *     (e.g. other Business Portfolio assets such as Lewis & Maese) are logged as 'ignored' WITHOUT storing the
 *     payload. Nothing is ever processed for them.
 *   • Bounded: ≤ MAX_ENTRIES entries / ≤ MAX_CHANGES changes per delivery; oversize remainder is dropped.
 *   • No secrets logged. Commenter identity (`from`) is never stored.
 */

const crypto = require('crypto');
const db = require('../db');
const destinations = require('./socialDestinationService');
const engagement = require('./socialEngagementService');
const insights = require('./socialInsightsService');

const MAX_ENTRIES = 50;
const MAX_CHANGES = 20;

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Meta's GET verification handshake. Returns { status, body }. */
function verifyChallenge(query = {}) {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) return { status: 503, body: 'Webhook verification is not configured' };
  const mode = query['hub.mode']; const token = query['hub.verify_token']; const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || !timingSafeEqual(token, expected)) return { status: 403, body: 'Forbidden' };
  return { status: 200, body: String(challenge || '') };
}

/** Verify X-Hub-Signature-256 over the raw body buffer. Returns { ok, status, error }. */
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return { ok: false, status: 503, error: 'Webhook signature verification is not configured' };
  if (!Buffer.isBuffer(rawBody)) return { ok: false, status: 400, error: 'Raw body required' };
  const sig = String(signatureHeader || '');
  if (!sig.startsWith('sha256=')) return { ok: false, status: 401, error: 'Unauthorized' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!timingSafeEqual(sig, expected)) return { ok: false, status: 401, error: 'Unauthorized' };
  return { ok: true, status: 200 };
}

function dedupKey(object, entryId, time, field, value) {
  return crypto.createHash('sha256').update([object, entryId, time, field, JSON.stringify(value || null)].join('|')).digest('hex');
}

// Registered destination for a provider account id (Page ID or IG Business Account ID) — else null (ignored).
async function destinationForEntry(entryId, r) {
  const all = await destinations.list(r);
  return all.find((d) => String(d.provider_account_id) === String(entryId)) || null;
}

// Normalize one change into engagement events (comments/reactions/shares) — identity fields dropped.
async function applyChange(object, dest, field, value, r) {
  const platform = dest.platform;
  const out = { events: 0, refreshed: 0, kind: null };
  if (!value || typeof value !== 'object') return out;
  if (object === 'page' && field === 'feed') {
    const item = value.item; const verb = value.verb;
    const postId = value.post_id || null;
    if (verb !== 'add') return out;
    if (item === 'comment' && value.comment_id) {
      const res = await engagement.ingestEvent({ platform, destinationId: dest.id, providerPostId: postId, kind: 'comment', providerEventId: value.comment_id,
        occurredAt: value.created_time ? new Date(Number(value.created_time) * 1000).toISOString() : null, text: value.message, source: 'webhook' }, r);
      if (res.ok && !res.idempotent) out.events++; out.kind = 'comment';
    } else if ((item === 'reaction' || item === 'share') && postId) {
      const key = `${item}:${postId}:${value.created_time || ''}:${value.reaction_type || ''}:${value.share_id || ''}`;
      const res = await engagement.ingestEvent({ platform, destinationId: dest.id, providerPostId: postId, kind: item, providerEventId: crypto.createHash('sha1').update(key).digest('hex'),
        occurredAt: value.created_time ? new Date(Number(value.created_time) * 1000).toISOString() : null, source: 'webhook' }, r);
      if (res.ok && !res.idempotent) out.events++; out.kind = item;
    }
    if (postId) out.refreshed = (await insights.requestRefresh(postId, { runner: r })).refreshed;
  } else if (object === 'instagram' && field === 'comments' && value.id) {
    const mediaId = value.media && value.media.id ? value.media.id : null;
    const res = await engagement.ingestEvent({ platform, destinationId: dest.id, providerPostId: mediaId, kind: 'comment', providerEventId: value.id,
      occurredAt: null, text: value.text, source: 'webhook' }, r);
    if (res.ok && !res.idempotent) out.events++; out.kind = 'comment';
    if (mediaId) out.refreshed = (await insights.requestRefresh(mediaId, { runner: r })).refreshed;
  }
  return out;
}

/**
 * Process an already-AUTHENTICATED delivery payload. Durable per change (received → processed/ignored/error).
 * Returns aggregate counts; never throws on a bad change (recorded as error).
 */
async function processDelivery(payload, runner) {
  const r = runner || db;
  const summary = { object: payload && payload.object, entries: 0, changes: 0, processed: 0, ignored: 0, duplicates: 0, errors: 0, events: 0 };
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) return { ...summary, malformed: true };
  const object = String(payload.object || '');
  for (const entry of payload.entry.slice(0, MAX_ENTRIES)) {
    summary.entries++;
    const entryId = entry && entry.id != null ? String(entry.id) : null;
    const time = entry && entry.time != null ? entry.time : null;
    const changes = Array.isArray(entry && entry.changes) ? entry.changes.slice(0, MAX_CHANGES) : [];
    const dest = entryId ? await destinationForEntry(entryId, r) : null;
    for (const ch of changes) {
      summary.changes++;
      const field = ch && ch.field ? String(ch.field) : null;
      const value = ch ? ch.value : null;
      const key = dedupKey(object, entryId, time, field, value);
      // Unregistered account (e.g. another portfolio asset): record the fact, store NO payload, process nothing.
      const store = dest ? JSON.stringify(stripIdentity(value)) : null;
      const ins = await r.query(
        `INSERT INTO marketing_social_webhook_events (dedup_key, object, entry_id, field, change, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
        [key, object, entryId, field, store, dest ? 'received' : 'ignored']);
      if (!ins.rows.length) { summary.duplicates++; continue; }
      if (!dest) { summary.ignored++; continue; }
      try {
        const out = await applyChange(object, dest, field, value, r);
        summary.events += out.events; summary.processed++;
        await r.query(`UPDATE marketing_social_webhook_events SET status='processed', processed_at=now() WHERE id=$1`, [ins.rows[0].id]);
      } catch (e) {
        summary.errors++;
        await r.query(`UPDATE marketing_social_webhook_events SET status='error', error=$2, processed_at=now() WHERE id=$1`, [ins.rows[0].id, String(e.message || e).slice(0, 300)]);
      }
    }
  }
  return summary;
}

// Drop commenter/actor identity from a stored change (data minimization).
function stripIdentity(value) {
  if (!value || typeof value !== 'object') return value;
  const { from, sender_id, sender_name, ...rest } = value; // eslint-disable-line no-unused-vars
  return rest;
}

/** Operator-facing status (no secrets). */
async function status(runner) {
  const r = runner || db;
  const rows = (await r.query(`SELECT status, count(*)::int n, max(received_at) last_at FROM marketing_social_webhook_events GROUP BY status`)).rows;
  return {
    configured: { app_secret_present: !!process.env.META_APP_SECRET, verify_token_present: !!process.env.META_WEBHOOK_VERIFY_TOKEN },
    callback_path: '/api/meta/webhook',
    deliveries_by_status: rows,
    provider_side: 'App Dashboard → Webhooks: subscribe Page object field `feed` and Instagram object field `comments`; then subscribe the Page to the app (pages_manage_metadata). Owner console step — never automated here.',
  };
}

module.exports = { verifyChallenge, verifySignature, dedupKey, processDelivery, stripIdentity, status, MAX_ENTRIES, MAX_CHANGES };
