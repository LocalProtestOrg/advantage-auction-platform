'use strict';

/**
 * followerCampaignService — Professional Seller "Notify Your Followers" campaigns.
 *
 * PRODUCT PRINCIPLE: a Professional Seller may communicate with the Advantage.Bid users who follow their
 * company, but Advantage.Bid retains control of the underlying member/contact database. Sellers NEVER
 * receive, query, or export follower email addresses or contact lists. This service does all targeting +
 * delivery server-side: it resolves the eligible audience, fans out FOLLOWER_EVENT rows into the existing
 * notifications_queue, and the existing notificationWorker delivers the Advantage.Bid-branded email.
 *
 * Reuses: seller_followers (audience), notification_preferences (email_enabled + follower_emails_enabled
 * gates), email_suppressions (unsubscribe/bounce), notifications_queue + notificationWorker (delivery),
 * followerEmails (template). Adds only the campaign metadata + authorization + eligibility layer.
 *
 * Publication safety: activateOnPublish() is the ONLY fan-out path and fires ONLY for a genuinely
 * published event; it is fully best-effort (never throws), so event publication never depends on email.
 */

const db = require('../db');
const log = require('../lib/logger');
const { writeAuditLog } = require('../lib/auditLog');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');
const followerEmails = require('./followerEmails');
const emailToken = require('../lib/followerEmailToken');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const MAX_MESSAGE_LEN = 500;

function forbidden(msg) { const e = new Error(msg); e.status = 403; e.code = 'FOLLOWER_EMAIL_FORBIDDEN'; return e; }

// ── Eligibility SQL fragment (shared by estimate + fan-out) ─────────────────────────────────────────
// A recipient is eligible iff they follow the seller AND transactional email is on AND follower marketing
// is not opted out AND the account is active AND their address is not suppressed. LEFT JOIN + COALESCE so
// a user with no preferences row inherits the opted-in defaults.
const ELIGIBLE_JOIN = `
  FROM seller_followers sf
  JOIN users u ON u.id = sf.user_id
  LEFT JOIN notification_preferences np ON np.user_id = sf.user_id
 WHERE sf.seller_id = $1
   AND COALESCE(np.email_enabled, true) = true
   AND COALESCE(np.follower_emails_enabled, true) = true
   AND COALESCE(u.is_active, true) = true
   AND lower(COALESCE(NULLIF(u.contact_email,''), u.email)) NOT IN (SELECT lower(email) FROM email_suppressions)`;

/**
 * Resolve the seller_profiles row that OWNS an event, via the org owner user (the only reliably-populated
 * path — organizations.seller_profile_id is deprecated/never written). Returns {id, seller_type,
 * follower_email_enabled, is_demo} or null.
 */
async function resolveSellerForEvent(event, runner = db) {
  if (!event || !event.organization_id) return null;
  const { rows } = await runner.query(
    `SELECT sp.id, sp.seller_type, sp.follower_email_enabled, sp.is_demo
       FROM organization_members m
       JOIN seller_profiles sp ON sp.user_id = m.user_id
      WHERE m.organization_id = $1 AND m.role = 'owner' AND m.status = 'active'
      ORDER BY m.created_at ASC LIMIT 1`,
    [event.organization_id]);
  return rows[0] || null;
}

// Is this seller allowed to use the follower-email tool? Uses the STRICT professional set
// (auction_house / estate_sale_company / professional_liquidator — admin-assigned only), so individual,
// private, and 'business' sellers are excluded (§16). Requires privilege on + not a demo account.
function sellerCanEmailFollowers(seller) {
  return !!(seller && PROFESSIONAL_SELLER_TYPES.includes(seller.seller_type)
    && seller.follower_email_enabled && !seller.is_demo);
}

// Approximate count of eligible followers for a seller (never reveals identities).
async function estimateAudience(sellerId, runner = db) {
  if (!sellerId) return 0;
  const { rows } = await runner.query(`SELECT count(*)::int n ${ELIGIBLE_JOIN}`, [sellerId]);
  return rows[0].n;
}

// Human date/time line in the event's timezone (e.g. "Sat, Sep 13, 2026 · 11:00 AM CDT").
function dateLine(startAt, timezone) {
  if (!startAt) return null;
  try {
    const d = new Date(startAt);
    if (isNaN(d.getTime())) return null;
    const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    if (timezone) opts.timeZone = timezone;
    return new Intl.DateTimeFormat('en-US', opts).format(d).replace(', ', ', ').replace(/,([^,]*)$/, ' ·$1');
  } catch (_) { return null; }
}
function locationLine(event) {
  const parts = [event.city, event.state].filter((x) => x && String(x).trim());
  return parts.length ? parts.join(', ') : null;
}

// Build the payload snapshot stored on each queue row (per-campaign, not per-recipient; the unsubscribe
// token is generated per-recipient at send time from user_id + seller_id).
async function buildCampaignPayload(event, campaign, runner = db) {
  const cover = (await runner.query(
    `SELECT url FROM event_images WHERE event_id = $1 ORDER BY is_cover DESC, position ASC LIMIT 1`,
    [event.id])).rows[0];
  let companyName = null;
  if (event.organization_id) {
    const org = (await runner.query('SELECT name FROM organizations WHERE id = $1', [event.organization_id])).rows[0];
    companyName = org && org.name;
  }
  return {
    campaign_id: campaign.id,
    seller_id: campaign.seller_id,
    event_id: event.id,
    company_name: companyName || 'A company you follow',
    event_title: event.title || 'A new event',
    sale_type: event.sale_type || null,
    event_url: event.slug ? `${APP_BASE}/event.html?slug=${encodeURIComponent(event.slug)}` : `${APP_BASE}/upcoming-auctions.html`,
    image_url: (cover && cover.url) || null,
    date_line: dateLine(event.start_at, event.timezone),
    location_line: locationLine(event),
    custom_message: campaign.custom_message || null,
  };
}

/**
 * Seller opt-in BEFORE publish: create/update a SCHEDULED campaign for an event. Caller must have already
 * asserted the user owns the event's org (route does this). Enforces professional + privilege here too.
 * Allowed only while the event has not yet published (draft/submitted/rejected). Returns the campaign row
 * or null (when opting out).
 */
async function upsertScheduledCampaign({ event, userId, enabled, customMessage }, runner = db) {
  const seller = await resolveSellerForEvent(event, runner);
  if (!sellerCanEmailFollowers(seller)) throw forbidden('Follower email is not available for this seller.');
  if (event.status === 'published' || event.status === 'archived') {
    const e = new Error('This event has already been published.'); e.status = 409; e.code = 'ALREADY_PUBLISHED'; throw e;
  }
  if (!enabled) {
    await runner.query(
      `UPDATE follower_campaigns SET status='canceled', updated_at=now()
        WHERE event_id=$1 AND trigger_type='event_published' AND status='scheduled'`, [event.id]);
    return null;
  }
  const msg = customMessage != null ? String(customMessage).trim().slice(0, MAX_MESSAGE_LEN) : null;
  const audience = await estimateAudience(seller.id, runner);
  const { rows } = await runner.query(
    `INSERT INTO follower_campaigns (seller_id, event_id, created_by, trigger_type, status, custom_message, audience_estimate)
     VALUES ($1,$2,$3,'event_published','scheduled',$4,$5)
     ON CONFLICT (event_id, trigger_type) WHERE event_id IS NOT NULL DO UPDATE
       SET custom_message = EXCLUDED.custom_message,
           audience_estimate = EXCLUDED.audience_estimate,
           status = CASE WHEN follower_campaigns.status = 'queued' THEN 'queued' ELSE 'scheduled' END,
           created_by = EXCLUDED.created_by, updated_at = now()
     RETURNING *`,
    [seller.id, event.id, userId, msg, audience]);
  return rows[0];
}

/**
 * Fire AFTER an event genuinely reaches 'published'. Transitions the scheduled campaign → queued and fans
 * out FOLLOWER_EVENT rows to eligible followers (with per-(campaign,user) dedup). Idempotent and fully
 * best-effort: it NEVER throws, so event publication can never depend on it. Guards against draft/rejected/
 * demo/ineligible states.
 */
async function activateOnPublish(event) {
  try {
    if (!event || event.status !== 'published') return { activated: false, reason: 'not_published' };

    const camp = (await db.query(
      `SELECT * FROM follower_campaigns
        WHERE event_id=$1 AND trigger_type='event_published' AND status='scheduled'`, [event.id])).rows[0];
    if (!camp) return { activated: false, reason: 'no_scheduled_campaign' };

    // Re-verify the seller is still professional + privileged + not demo at publish time.
    const seller = (await db.query(
      'SELECT id, seller_type, follower_email_enabled, is_demo FROM seller_profiles WHERE id=$1', [camp.seller_id])).rows[0];
    if (!sellerCanEmailFollowers(seller)) {
      await db.query(`UPDATE follower_campaigns SET status='canceled', updated_at=now() WHERE id=$1`, [camp.id]);
      return { activated: false, reason: 'seller_ineligible' };
    }

    const payload = await buildCampaignPayload(event, camp);
    const ins = await db.query(
      `INSERT INTO notifications_queue (user_id, type, payload)
       SELECT sf.user_id, 'FOLLOWER_EVENT', $2::jsonb
       ${ELIGIBLE_JOIN}
         AND NOT EXISTS (
           SELECT 1 FROM notifications_queue nq
            WHERE nq.type='FOLLOWER_EVENT' AND nq.payload->>'campaign_id'=$3 AND nq.user_id=sf.user_id)`,
      [camp.seller_id, JSON.stringify(payload), camp.id]);

    await db.query(
      `UPDATE follower_campaigns SET status='queued', targeted_count=$2, queued_at=now(), updated_at=now() WHERE id=$1`,
      [camp.id, ins.rowCount]);
    await writeAuditLog({
      event_type: 'follower_campaign.queued', entity_type: 'follower_campaign', entity_id: camp.id,
      actor_id: camp.created_by, metadata: { event_id: event.id, seller_id: camp.seller_id, targeted: ins.rowCount },
    });
    log.info('follower-campaign', `Queued FOLLOWER_EVENT for ${ins.rowCount} follower(s)`, { campaignId: camp.id, eventId: event.id });
    return { activated: true, targeted: ins.rowCount };
  } catch (e) {
    try { log.error('follower-campaign', 'activateOnPublish failed (non-fatal)', { error: e && e.message }); } catch (_) {}
    return { activated: false, reason: 'error', error: e && e.message };
  }
}

// Per-campaign delivery stats derived from the queue (no per-recipient identities exposed).
async function campaignStats(campaignId, runner = db) {
  const { rows } = await runner.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE status='sent')::int delivered,
            count(*) FILTER (WHERE status='failed')::int failed,
            count(*) FILTER (WHERE status IN ('pending','processing'))::int pending,
            count(*) FILTER (WHERE status='skipped')::int skipped
       FROM notifications_queue WHERE type='FOLLOWER_EVENT' AND payload->>'campaign_id'=$1`,
    [String(campaignId)]);
  return rows[0] || { total: 0, delivered: 0, failed: 0, pending: 0, skipped: 0 };
}

// Aggregate view-model for a single campaign (seller/admin safe — counts only, never recipients).
function serializeCampaign(c, stats) {
  return {
    id: c.id, event_id: c.event_id, status: c.status, trigger_type: c.trigger_type,
    custom_message: c.custom_message || null,
    audience_estimate: c.audience_estimate, targeted_count: c.targeted_count,
    delivered_count: stats ? stats.delivered : 0,
    failed_count: stats ? stats.failed : 0,
    pending_count: stats ? stats.pending : 0,
    created_at: c.created_at, queued_at: c.queued_at, updated_at: c.updated_at,
  };
}

async function getCampaignForEvent(eventId, runner = db) {
  const c = (await runner.query(
    `SELECT * FROM follower_campaigns WHERE event_id=$1 AND trigger_type='event_published'
      ORDER BY created_at DESC LIMIT 1`, [eventId])).rows[0];
  if (!c) return null;
  const stats = c.status === 'queued' ? await campaignStats(c.id, runner) : null;
  return serializeCampaign(c, stats);
}

// Campaign history for a seller (dashboard). Counts only.
async function listCampaignsForSeller(sellerId, runner = db) {
  const rows = (await runner.query(
    `SELECT fc.*, e.title AS event_title, e.slug AS event_slug, e.sale_type
       FROM follower_campaigns fc LEFT JOIN events e ON e.id = fc.event_id
      WHERE fc.seller_id=$1 ORDER BY fc.created_at DESC LIMIT 100`, [sellerId])).rows;
  const out = [];
  for (const c of rows) {
    const stats = c.status === 'queued' ? await campaignStats(c.id, runner) : null;
    out.push({ ...serializeCampaign(c, stats), event_title: c.event_title, event_slug: c.event_slug, sale_type: c.sale_type });
  }
  return out;
}

// Build the FOLLOWER_EVENT email for the worker: signs a per-recipient unsubscribe token from the payload.
function buildQueueEmail(payload, userId, toAddress) {
  const token = emailToken.sign(userId, payload.seller_id);
  const unsubscribeUrl = `${APP_BASE}/api/public/follower-emails/unsubscribe?token=${encodeURIComponent(token)}`;
  return followerEmails.buildFollowerEventEmail(payload, { toAddress, unsubscribeUrl });
}

module.exports = {
  MAX_MESSAGE_LEN,
  resolveSellerForEvent,
  sellerCanEmailFollowers,
  estimateAudience,
  buildCampaignPayload,
  upsertScheduledCampaign,
  activateOnPublish,
  campaignStats,
  getCampaignForEvent,
  listCampaignsForSeller,
  buildQueueEmail,
  serializeCampaign,
  dateLine,
  _ELIGIBLE_JOIN: ELIGIBLE_JOIN,
};
