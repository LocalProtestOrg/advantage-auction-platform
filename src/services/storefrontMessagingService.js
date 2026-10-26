'use strict';

/**
 * storefrontMessagingService — milestone Q: secure item-specific buyer-to-seller messaging (migration 205; roadmap §9).
 * Gated by STOREFRONT_MESSAGING_ENABLED at the routes (off by default).
 *
 * Who can see what
 *   • A conversation belongs to ONE item and ONE signed-in buyer, and always to the item's REAL seller company (read from
 *     the item; composite key in the database). The buyer sees their own conversations; the seller company sees its own
 *     (owner, and staff whose role grants company.messages.*). Nobody else, except Advantage.Bid reviewers with the
 *     marketplace.moderate permission — every reviewer read is written to storefront_conversation_access_log.
 *   • Neither side ever receives the other's name, email address, phone number or address: the seller sees "Buyer",
 *     the buyer sees the company name (or "The seller" when the seller keeps branding private).
 *   • The other party only ever sees `delivered_body` (contact details hidden). What the sender typed (`body`) is shown
 *     back to the sender and to reviewers only.
 *
 * Screening (src/lib/messageScreening.js): contact details are hidden; payment-off-platform and diversion requests are
 * held for a person to review, who releases (contact details stay hidden) or declines with a reason the sender sees.
 * The sender may withdraw a held message and rephrase, and may appeal a decline once. Screening never suspends,
 * penalises or accuses anyone and never cancels an order.
 *
 * Notifications: one outbox row per delivered message for the other party (events message_to_seller /
 * message_to_buyer), at most one waiting notice per conversation and recipient, so a busy thread does not flood email.
 */

const crypto = require('crypto');
const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');
const screening = require('../lib/messageScreening');
const { resolveSellerContext } = require('../middleware/requireSellerPermission');
const { hasSellerPermission } = require('../lib/sellerRbac');
const guards = require('../lib/launchGuards');
const OFF = () => err(404, 'MESSAGING_OFF', 'Item questions are not available yet.');
function requireAllowed(sellerId, userId, side) { if (!guards.storefrontMessagingAllowed({ sellerId, userId, side })) throw OFF(); }

const LIMITS = {
  BODY_MAX: 2000,
  NEW_CONVERSATIONS_PER_DAY: 10,      // per buyer
  MESSAGES_PER_HOUR_BUYER: 30,        // per buyer, all conversations
  MESSAGES_PER_HOUR_SELLER: 120,      // per seller company, all conversations
  MESSAGES_PER_HOUR_CONVERSATION: 20, // per sender, one conversation
  MESSAGES_PER_HOUR_IP: 60,           // per network address (hashed)
  DUPLICATE_WINDOW_MIN: 10,           // the same words again in the same conversation → the earlier message is returned
  SAME_TEXT_CONVERSATIONS_PER_HOUR: 3,// the same words sent to more than this many other conversations → refused (spam)
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const isUuid = (v) => UUID_RE.test(String(v || ''));
function bodyOf(v) {
  const b = (v == null ? '' : String(v)).replace(/\r\n?/g, '\n').trim();
  if (!b) throw err(422, 'MESSAGE_REQUIRED', 'Write your message first.');
  if (b.length > LIMITS.BODY_MAX) throw err(422, 'MESSAGE_TOO_LONG', `Messages can be up to ${LIMITS.BODY_MAX} characters.`);
  return b;
}
// Counted in characters (code points), the way the database CHECK counts them (5-1000), so a note that passes here never
// fails in the database (an emoji is one character, not two).
function noteOf(v, code, msg) {
  const clean = (v == null ? '' : String(v)).replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').trim();
  const n = Array.from(clean).slice(0, 1000).join('').trim();
  if (Array.from(n).length < 5) throw err(422, code, msg);
  return n;
}
const PROCESS_KEY = crypto.randomBytes(32).toString('hex');
// Keyed hash (a plain hash of an IPv4 address could be reversed by trying every address). Used only for rate limiting.
function ipHashOf(ip) {
  if (!ip) return null;
  const key = process.env.MESSAGE_RATE_LIMIT_SECRET || process.env.JWT_SECRET || PROCESS_KEY;   // never a fixed, guessable key
  return crypto.createHmac('sha256', key).update('sfm:' + ip).digest('hex').slice(0, 32);
}

// What the sender is told after sending (polite; never an accusation).
const NOTICE = {
  masked: 'We hid contact details in your message. For everyone\'s safety, please keep questions and payments on Advantage.Bid.',
  held: 'Your message is waiting for a quick review because it may ask to continue the conversation or the payment outside '
    + 'Advantage.Bid. You can withdraw it and send a new message instead.',
};

// ── Shapes returned to each party (allow-lists) ──────────────────────────────────────────────────────────
function messageFor(m, viewerSide) {
  const mine = m.sender_role === viewerSide;
  const out = { id: m.id, from: mine ? 'you' : m.sender_role, created_at: m.created_at };
  // Hidden by an Advantage.Bid moderator: the recipient sees only that a message was removed; the sender sees why.
  if (m.hidden_at) {
    out.hidden = true;
    if (!mine) { out.body = null; return out; }
    out.hidden_reason = m.hidden_reason;
  }
  if (mine) {
    out.status = m.status;                     // delivered / held / declined / withdrawn
    out.body = m.body;                         // what you wrote
    out.delivered_body = m.delivered_body;     // what the other side sees (contact details hidden)
    if (m.status === 'declined') { out.decline_reason = m.decline_reason; out.can_appeal = !m.appealed_at; }
    if (m.status === 'held') out.can_withdraw = true;
  } else {
    out.body = m.delivered_body;               // only delivered messages reach this branch
  }
  return out;
}
function conversationHead(c, viewerSide) {
  const snap = c.subject_snapshot || {};
  const branded = c.show_branding_to_buyers !== false;
  const head = {
    id: c.id, item_id: c.item_id, item_title: snap.title || c.item_title || 'Item', thumbnail_url: snap.thumbnail_url || null,
    item_status: c.item_status || null, created_at: c.created_at, last_message_at: c.last_message_at,
  };
  if (viewerSide === 'seller') {
    head.inventory_number = snap.inventory_number || null;
    head.buyer_label = 'Buyer · question ' + String(c.id).slice(0, 8).toUpperCase();
    head.waiting = c.waiting_count != null ? Number(c.waiting_count) : undefined;
  } else {
    head.seller_name = branded ? (c.seller_name || 'The seller') : 'The seller';
    head.storefront_slug = branded ? (c.storefront_slug || null) : null;
  }
  return head;
}

// ── Rate limits and duplicate suppression ─────────────────────────────────────────────────────────────
async function checkLimits(client, conv, side, userId, sellerId, body, ipHash) {
  const one = async (sql, p) => Number((await client.query(sql, p)).rows[0].n);
  // The same words again in the same conversation within a few minutes: return the earlier message (double click, retry).
  const dup = (await client.query(
    `SELECT * FROM storefront_messages WHERE conversation_id = $1 AND sender_user_id = $2 AND body = $3
        AND created_at > now() - ($4 || ' minutes')::interval ORDER BY created_at DESC LIMIT 1`,
    [conv.id, userId, body, String(LIMITS.DUPLICATE_WINDOW_MIN)])).rows[0];
  if (dup) return dup;
  if (await one(`SELECT count(*)::int n FROM storefront_messages WHERE conversation_id = $1 AND sender_user_id = $2 AND created_at > now() - interval '1 hour'`,
    [conv.id, userId]) >= LIMITS.MESSAGES_PER_HOUR_CONVERSATION) throw err(429, 'TOO_MANY_MESSAGES', 'You have sent several messages in this conversation. Please wait a little before sending more.');
  if (side === 'buyer') {
    if (await one(`SELECT count(*)::int n FROM storefront_messages WHERE sender_user_id = $1 AND sender_role = 'buyer' AND created_at > now() - interval '1 hour'`,
      [userId]) >= LIMITS.MESSAGES_PER_HOUR_BUYER) throw err(429, 'TOO_MANY_MESSAGES', 'You have sent many messages in the last hour. Please try again later.');
    if (await one(`SELECT count(DISTINCT conversation_id)::int n FROM storefront_messages WHERE sender_user_id = $1 AND body = $2 AND conversation_id <> $3
        AND created_at > now() - interval '1 hour'`, [userId, body, conv.id]) >= LIMITS.SAME_TEXT_CONVERSATIONS_PER_HOUR) {
      throw err(429, 'REPEATED_MESSAGE', 'This message was already sent to several sellers. Please write to each seller about their item.');
    }
  } else if (await one(`SELECT count(*)::int n FROM storefront_messages WHERE seller_id = $1 AND sender_role = 'seller' AND created_at > now() - interval '1 hour'`,
    [sellerId]) >= LIMITS.MESSAGES_PER_HOUR_SELLER) throw err(429, 'TOO_MANY_MESSAGES', 'Your company has sent many messages in the last hour. Please try again later.');
  if (ipHash && await one(`SELECT count(*)::int n FROM storefront_messages WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`,
    [ipHash]) >= LIMITS.MESSAGES_PER_HOUR_IP) throw err(429, 'TOO_MANY_MESSAGES', 'Too many messages from this network. Please try again later.');
  return null;
}

// One waiting notice per conversation and recipient (a busy thread does not send an email per message). Only a notice that
// has not started sending absorbs a new message; once one is being sent, the next message gets its own notice.
async function enqueueNotice(client, msg) {
  const event = msg.sender_role === 'buyer' ? 'message_to_seller' : 'message_to_buyer';
  await client.query(
    `INSERT INTO storefront_notifications (seller_id, message_id, event, recipient_user_id, recipient_email)
     SELECT m.seller_id, m.id, $2::text, u.id, lower(u.email)
       FROM storefront_messages m JOIN storefront_conversations c ON c.id = m.conversation_id
       JOIN seller_profiles sp ON sp.id = c.seller_id
       JOIN users u ON u.id = CASE WHEN $2::text = 'message_to_seller' THEN sp.user_id ELSE c.buyer_user_id END
      WHERE m.id = $1 AND m.status = 'delivered' AND u.email IS NOT NULL AND COALESCE(u.is_active, true)
        AND NOT EXISTS (SELECT 1 FROM storefront_notifications n JOIN storefront_messages m2 ON m2.id = n.message_id
                         WHERE m2.conversation_id = m.conversation_id AND n.event = $2::text AND n.status = 'pending')
     ON CONFLICT (message_id, event, recipient_email) WHERE message_id IS NOT NULL DO NOTHING`, [msg.id, event]);
}

async function alertHeld(conv) {
  try {
    const oa = require('./ownerAlertService');
    await oa.notifyAdminActionRequired({ actionType: oa.ALERT_TYPES.STOREFRONT_MESSAGE_HELD || 'storefront_message_held', entityType: 'storefront_conversation',
      entityId: conv.id, headline: 'Item message waiting for review', context: 'A storefront item message was held by the safety rules.',
      adminPath: '/admin/storefront-moderation.html', adminId: 'messages', adminParam: 'tab', actionLabel: 'Review' });
  } catch (e) { console.error('[messaging] review alert failed:', e.message); }
}
// A recipient's report: its own alert type, keyed to the reported MESSAGE, so it is never absorbed by an earlier
// held-message alert for the same conversation.
async function alertReported(messageId) {
  try {
    const oa = require('./ownerAlertService');
    await oa.notifyAdminActionRequired({ actionType: oa.ALERT_TYPES.STOREFRONT_MESSAGE_REPORTED || 'storefront_message_reported', entityType: 'storefront_message',
      entityId: messageId, headline: 'Item message reported', context: 'The recipient of a delivered storefront item message reported it for review.',
      adminPath: '/admin/storefront-moderation.html', adminId: 'messages', adminParam: 'tab', actionLabel: 'Review' });
  } catch (e) { console.error('[messaging] report alert failed:', e.message); }
}

// Insert one message from `side` into a locked conversation row. Returns { message, duplicate }.
async function insertMessage(client, conv, side, userId, rawBody, ip) {
  const body = bodyOf(rawBody);
  const ipHash = ipHashOf(ip);
  const dup = await checkLimits(client, conv, side, userId, conv.seller_id, body, ipHash);
  if (dup) return { message: dup, duplicate: true };
  const s = screening.screen(body);
  const held = s.hold.length > 0;
  const m = (await client.query(
    `INSERT INTO storefront_messages (conversation_id, seller_id, sender_role, sender_user_id, body, delivered_body, status, screening, ip_hash, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING *`,
    [conv.id, conv.seller_id, side, userId, body, held ? null : s.text, held ? 'held' : 'delivered',
      JSON.stringify({ version: s.version, masked: s.masked, hold: s.hold }), ipHash, held ? null : new Date()])).rows[0];
  if (!held) {
    await client.query('UPDATE storefront_conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
    await enqueueNotice(client, m);
  }
  return { message: m, duplicate: false, held, masked: s.masked };
}

function sendResult(conv, r, side) {
  const out = { conversation_id: conv.id, message: messageFor(r.message, side), duplicate: !!r.duplicate };
  if (r.message.status === 'held') out.notice = NOTICE.held;
  else if (r.masked && r.masked.length) out.notice = NOTICE.masked;
  return out;
}

// ── Buyer ─────────────────────────────────────────────────────────────────────────────────────────────
// Ask the seller a question about a public item (opens the buyer's thread for that item, or adds to it).
async function askAboutItem(itemId, buyerUserId, { body, ip } = {}) {
  if (!isUuid(itemId)) throw err(404, 'ITEM_NOT_FOUND', 'Item not found.');
  bodyOf(body);
  let heldConv = null;
  const out = await withTransaction(async (client) => {
    const it = (await client.query(
      `SELECT mi.id, mi.seller_id, mi.title, mi.inventory_number, mi.thumbnail_url, sp.user_id AS owner_user_id
         FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
        WHERE mi.id = $1 AND mi.status IN ('active','pending_purchase') AND COALESCE(mi.moderation_status, 'none') = 'none'
          AND sp.seller_type = ANY($2::text[])`, [itemId, PROFESSIONAL_SELLER_TYPES])).rows[0];
    if (!it) throw err(404, 'ITEM_NOT_FOUND', 'This item is not available for questions.');
    requireAllowed(it.seller_id, buyerUserId, 'buyer');
    if (it.owner_user_id === buyerUserId) throw err(409, 'OWN_ITEM', 'This is your own company\'s item.');
    const staff = (await client.query(
      `SELECT 1 FROM seller_staff_members WHERE seller_id = $1 AND user_id = $2 AND status IN ('active','suspended')`, [it.seller_id, buyerUserId])).rows[0];
    if (staff) throw err(409, 'OWN_ITEM', 'This is your own company\'s item.');
    let conv = (await client.query('SELECT * FROM storefront_conversations WHERE item_id = $1 AND buyer_user_id = $2 FOR UPDATE', [it.id, buyerUserId])).rows[0];
    if (!conv) {
      const today = Number((await client.query(
        `SELECT count(*)::int n FROM storefront_conversations WHERE buyer_user_id = $1 AND created_at > now() - interval '1 day'`, [buyerUserId])).rows[0].n);
      if (today >= LIMITS.NEW_CONVERSATIONS_PER_DAY) throw err(429, 'TOO_MANY_CONVERSATIONS', 'You have started several conversations today. Please try again tomorrow.');
      conv = (await client.query(
        `INSERT INTO storefront_conversations (seller_id, item_id, buyer_user_id, subject_snapshot) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (item_id, buyer_user_id) DO NOTHING RETURNING *`,
        [it.seller_id, it.id, buyerUserId, JSON.stringify({ title: it.title, inventory_number: it.inventory_number || null,
          thumbnail_url: it.thumbnail_url && /^https:\/\//i.test(it.thumbnail_url) ? it.thumbnail_url : null })])).rows[0]
        || (await client.query('SELECT * FROM storefront_conversations WHERE item_id = $1 AND buyer_user_id = $2 FOR UPDATE', [it.id, buyerUserId])).rows[0];
    }
    const r = await insertMessage(client, conv, 'buyer', buyerUserId, body, ip);
    if (r.held) heldConv = conv;
    return sendResult(conv, r, 'buyer');
  });
  if (heldConv) await alertHeld(heldConv);
  return out;
}

async function listForBuyer(buyerUserId) {
  const { rows } = await db.query(
    `SELECT c.*, mi.status AS item_status, mi.title AS item_title, sp.storefront_slug, sp.show_branding_to_buyers,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM storefront_conversations c JOIN marketplace_items mi ON mi.id = c.item_id JOIN seller_profiles sp ON sp.id = c.seller_id
      WHERE c.buyer_user_id = $1 ORDER BY c.last_message_at DESC LIMIT 200`, [buyerUserId]);
  // In a pilot, only conversations with a listed company (and, when askers are listed, only for a listed asker).
  return rows.filter((c) => guards.storefrontMessagingAllowed({ sellerId: c.seller_id, userId: buyerUserId, side: 'buyer' }))
    .map((c) => conversationHead(c, 'buyer'));
}

async function loadThread(runner, convId, side) {
  const msgs = (await runner.query(
    `SELECT * FROM storefront_messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`, [convId])).rows;
  return msgs.filter((m) => m.sender_role === side || m.status === 'delivered').map((m) => messageFor(m, side));
}

async function getForBuyer(convId, buyerUserId) {
  if (!isUuid(convId)) return null;
  const c = (await db.query(
    `SELECT c.*, mi.status AS item_status, mi.title AS item_title, sp.storefront_slug, sp.show_branding_to_buyers,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM storefront_conversations c JOIN marketplace_items mi ON mi.id = c.item_id JOIN seller_profiles sp ON sp.id = c.seller_id
      WHERE c.id = $1 AND c.buyer_user_id = $2`, [convId, buyerUserId])).rows[0];
  if (!c) return null;
  if (!guards.storefrontMessagingAllowed({ sellerId: c.seller_id, userId: buyerUserId, side: 'buyer' })) return null;
  return { ...conversationHead(c, 'buyer'), messages: await loadThread(db, c.id, 'buyer') };
}

async function replyAsBuyer(convId, buyerUserId, { body, ip } = {}) {
  if (!isUuid(convId)) throw err(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  bodyOf(body);
  let heldConv = null;
  const out = await withTransaction(async (client) => {
    const conv = (await client.query('SELECT * FROM storefront_conversations WHERE id = $1 AND buyer_user_id = $2 FOR UPDATE', [convId, buyerUserId])).rows[0];
    if (!conv) throw err(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
    requireAllowed(conv.seller_id, buyerUserId, 'buyer');
    const r = await insertMessage(client, conv, 'buyer', buyerUserId, body, ip);
    if (r.held) heldConv = conv;
    return sendResult(conv, r, 'buyer');
  });
  if (heldConv) await alertHeld(heldConv);
  return out;
}

// ── Seller company (ctx from requireSellerPermission: the company comes from the session) ─────────────────
async function listForSeller(ctx) {
  requireAllowed(ctx.sellerId, ctx.userId, 'seller');
  const { rows } = await db.query(
    `SELECT c.*, mi.status AS item_status, mi.title AS item_title,
            (SELECT count(*)::int FROM storefront_messages m WHERE m.conversation_id = c.id AND m.sender_role = 'buyer' AND m.status = 'delivered'
                AND m.hidden_at IS NULL AND m.created_at > COALESCE((SELECT max(s.created_at) FROM storefront_messages s WHERE s.conversation_id = c.id AND s.sender_role = 'seller'), '-infinity'::timestamptz)) AS waiting_count
       FROM storefront_conversations c JOIN marketplace_items mi ON mi.id = c.item_id
      WHERE c.seller_id = $1 ORDER BY c.last_message_at DESC LIMIT 500`, [ctx.sellerId]);
  return rows.map((c) => conversationHead(c, 'seller'));
}

async function getForSeller(convId, ctx) {
  requireAllowed(ctx.sellerId, ctx.userId, 'seller');
  if (!isUuid(convId)) return null;
  const c = (await db.query(
    `SELECT c.*, mi.status AS item_status, mi.title AS item_title FROM storefront_conversations c JOIN marketplace_items mi ON mi.id = c.item_id
      WHERE c.id = $1 AND c.seller_id = $2`, [convId, ctx.sellerId])).rows[0];
  if (!c) return null;
  return { ...conversationHead(c, 'seller'), messages: await loadThread(db, c.id, 'seller') };
}

async function replyAsSeller(convId, ctx, { body, ip } = {}) {
  requireAllowed(ctx.sellerId, ctx.userId, 'seller');
  if (!isUuid(convId)) throw err(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  bodyOf(body);
  let heldConv = null;
  const out = await withTransaction(async (client) => {
    const conv = (await client.query('SELECT * FROM storefront_conversations WHERE id = $1 AND seller_id = $2 FOR UPDATE', [convId, ctx.sellerId])).rows[0];
    if (!conv) throw err(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
    const r = await insertMessage(client, conv, 'seller', ctx.userId, body, ip);
    if (r.held) heldConv = conv;
    return sendResult(conv, r, 'seller');
  });
  if (heldConv) await alertHeld(heldConv);
  return out;
}

// ── Sender: withdraw a held message, or appeal a decline once ─────────────────────────────────────────────
// A seller-side sender must still act for that company with permission to answer (a removed staff member cannot).
async function ownSentMessage(client, messageId, userId) {
  const m = (await client.query('SELECT * FROM storefront_messages WHERE id = $1 AND sender_user_id = $2 FOR UPDATE', [messageId, userId])).rows[0];
  if (!m) return null;
  if (m.sender_role === 'seller') {
    const ctx = await resolveSellerContext(userId, client);
    if (!ctx || ctx.sellerId !== m.seller_id || !hasSellerPermission(ctx, 'company.messages.respond')) return null;
  }
  // Messaging must still be on for this conversation's company (and, in a pilot, for this asker).
  requireAllowed(m.seller_id, userId, m.sender_role === 'seller' ? 'seller' : 'buyer');
  return m;
}

async function withdraw(messageId, userId) {
  if (!isUuid(messageId)) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  return withTransaction(async (client) => {
    const m = await ownSentMessage(client, messageId, userId);
    if (!m) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    if (m.status !== 'held') throw err(409, 'NOT_HELD', 'Only a message waiting for review can be withdrawn.');
    await client.query(`UPDATE storefront_messages SET status = 'withdrawn' WHERE id = $1`, [m.id]);
    await client.query(`INSERT INTO storefront_message_reviews (message_id, seller_id, action, actor_user_id) VALUES ($1, $2, 'withdrawn', $3)`, [m.id, m.seller_id, userId]);
    return { id: m.id, status: 'withdrawn' };
  });
}

async function appeal(messageId, userId, { note } = {}) {
  if (!isUuid(messageId)) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  const why = noteOf(note, 'NOTE_REQUIRED', 'Tell us briefly why this message should be delivered.');
  const out = await withTransaction(async (client) => {
    const m = await ownSentMessage(client, messageId, userId);
    if (!m) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    if (m.status !== 'declined' || m.appealed_at) throw err(409, 'CANNOT_APPEAL', 'Only a declined message can be appealed, once.');
    await client.query(`UPDATE storefront_messages SET status = 'held', appeal_note = $2, appealed_at = now() WHERE id = $1`, [m.id, why]);
    await client.query(`INSERT INTO storefront_message_reviews (message_id, seller_id, action, actor_user_id, note) VALUES ($1, $2, 'appealed', $3, $4)`, [m.id, m.seller_id, userId, why]);
    return { id: m.id, status: 'held', conversation_id: m.conversation_id };
  });
  await alertHeld({ id: out.conversation_id });
  return { id: out.id, status: out.status };
}

// ── Advantage.Bid review (marketplace.moderate) — every read of a conversation is logged ─────────────────
async function logAccess(runner, convs, adminId, purpose) {
  for (const c of convs) {
    await runner.query(`INSERT INTO storefront_conversation_access_log (conversation_id, seller_id, actor_user_id, purpose) VALUES ($1, $2, $3, $4)`,
      [c.conversation_id || c.id, c.seller_id, adminId, purpose]);
  }
}

async function listForReview({ status } = {}, adminId) {
  const st = ['held', 'declined', 'delivered', 'withdrawn', 'reported', 'hidden'].includes(status) ? status : 'held';
  const where = st === 'reported' ? `m.status = 'delivered' AND m.hidden_at IS NULL AND EXISTS (SELECT 1 FROM storefront_message_reviews r WHERE r.message_id = m.id AND r.action = 'reported')`
    : st === 'hidden' ? 'm.hidden_at IS NOT NULL'
      : st === 'delivered' ? `m.status = 'delivered' AND m.hidden_at IS NULL AND m.screening->'masked' <> '[]'::jsonb` : 'm.status = $1';
  const { rows } = await db.query(
    `SELECT m.id, m.conversation_id, m.seller_id, m.sender_role, m.body, m.delivered_body, m.status, m.screening, m.decline_reason, m.appeal_note, m.appealed_at,
            m.hidden_at, m.hidden_reason, m.created_at, c.item_id, c.subject_snapshot, c.is_demo,
            (SELECT json_agg(r.note ORDER BY r.created_at) FROM storefront_message_reviews r WHERE r.message_id = m.id AND r.action = 'reported') AS reports,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM storefront_messages m JOIN storefront_conversations c ON c.id = m.conversation_id JOIN seller_profiles sp ON sp.id = m.seller_id
      WHERE ${where}
      ORDER BY m.created_at ${st === 'held' || st === 'reported' ? 'ASC' : 'DESC'} LIMIT 200`, where.includes('$1') ? [st] : []);
  const seen = new Map(); rows.forEach((r) => seen.set(r.conversation_id, r));
  await logAccess(db, [...seen.values()], adminId, 'review_queue');
  return rows.map((r) => ({ ...r, delivered_preview: r.status === 'held' ? screening.screen(r.body).text : undefined,
    item_title: (r.subject_snapshot || {}).title || null, inventory_number: (r.subject_snapshot || {}).inventory_number || null }));
}

async function conversationForReview(convId, adminId) {
  if (!isUuid(convId)) return null;
  const c = (await db.query(
    `SELECT c.*, COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM storefront_conversations c JOIN seller_profiles sp ON sp.id = c.seller_id WHERE c.id = $1`, [convId])).rows[0];
  if (!c) return null;
  await logAccess(db, [c], adminId, 'conversation_view');
  const messages = (await db.query(`SELECT id, sender_role, body, delivered_body, status, screening, decline_reason, appeal_note, hidden_at, hidden_reason, created_at
    FROM storefront_messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`, [c.id])).rows;
  const reviews = (await db.query(`SELECT r.message_id, r.action, r.note, r.created_at FROM storefront_message_reviews r
    JOIN storefront_messages m ON m.id = r.message_id WHERE m.conversation_id = $1 ORDER BY r.created_at ASC`, [c.id])).rows;
  return { id: c.id, item_id: c.item_id, seller_name: c.seller_name, subject: c.subject_snapshot, is_demo: c.is_demo, created_at: c.created_at, messages, reviews };
}

// ── Reports and hiding (abusive delivered messages) ─────────────────────────────────────────────────────
// The RECIPIENT of a delivered message (the conversation's buyer for a seller message; the seller company for a buyer
// message) may report it. A report creates review work only — it never hides or penalises anything by itself.
async function reportMessage(messageId, userId, { reason } = {}) {
  if (!isUuid(messageId)) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  const why = noteOf(reason, 'REASON_REQUIRED', 'Tell us briefly what is wrong with this message.');
  const out = await withTransaction(async (client) => {
    const m = (await client.query(
      `SELECT m.*, c.buyer_user_id FROM storefront_messages m JOIN storefront_conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [messageId])).rows[0];
    if (!m || m.status !== 'delivered' || m.hidden_at) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    let recipient = false;
    if (m.sender_role === 'seller') recipient = m.buyer_user_id === userId;
    else {
      const ctx = await resolveSellerContext(userId, client);
      recipient = !!ctx && ctx.sellerId === m.seller_id && hasSellerPermission(ctx, 'company.messages.view');
    }
    if (!recipient) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    // The reporter is the recipient: the buyer for a seller message, the seller company for a buyer message.
    requireAllowed(m.seller_id, userId, m.sender_role === 'seller' ? 'buyer' : 'seller');
    const r = (await client.query(
      `INSERT INTO storefront_message_reviews (message_id, seller_id, action, actor_user_id, note) VALUES ($1, $2, 'reported', $3, $4)
       ON CONFLICT (message_id, actor_user_id) WHERE action = 'reported' DO NOTHING RETURNING id`, [m.id, m.seller_id, userId, why])).rows[0];
    return { message_id: m.id, already_reported: !r };
  });
  if (!out.already_reported) await alertReported(out.message_id);
  return { reported: true, already_reported: out.already_reported };
}

// A moderator hides a delivered message from the recipient, once, with a reason. The words and the record are kept;
// nothing happens to either account. Moderators never write as the seller (there is no route for it).
async function hideMessage(messageId, adminId, { reason } = {}) {
  if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can do this.');
  if (!isUuid(messageId)) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  const why = noteOf(reason, 'REASON_REQUIRED', 'Give a short reason (kept in the review history; the sender sees it).');
  return withTransaction(async (client) => {
    const m = (await client.query('SELECT * FROM storefront_messages WHERE id = $1 FOR UPDATE', [messageId])).rows[0];
    if (!m) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    if (m.status !== 'delivered') throw err(409, 'NOT_DELIVERED', 'Only a delivered message can be hidden.');
    if (m.hidden_at) throw err(409, 'ALREADY_HIDDEN', 'This message is already hidden.');
    await client.query(`UPDATE storefront_messages SET hidden_at = now(), hidden_by = $2, hidden_reason = $3 WHERE id = $1`, [m.id, adminId, why]);
    await client.query(`INSERT INTO storefront_message_reviews (message_id, seller_id, action, actor_user_id, note) VALUES ($1, $2, 'hidden', $3, $4)`,
      [m.id, m.seller_id, adminId, why]);
    await logAccess(client, [m], adminId, 'conversation_view');
    return { id: m.id, hidden: true };
  });
}

// decision 'release' (delivered with contact details hidden) or 'decline' (the note is shown to the sender).
async function review(messageId, adminId, { decision, note } = {}) {
  if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can do this.');
  if (!isUuid(messageId)) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  if (!['release', 'decline'].includes(decision)) throw err(422, 'DECISION_REQUIRED', 'Choose release or decline.');
  const why = noteOf(note, 'NOTE_REQUIRED', decision === 'decline'
    ? 'Write a short, polite reason (the sender will see it).' : 'Write a short note (kept in the review history).');
  return withTransaction(async (client) => {
    // Lock the conversation first (same order as sending), so a release and a new message cannot both queue a notice.
    const ref = (await client.query('SELECT conversation_id FROM storefront_messages WHERE id = $1', [messageId])).rows[0];
    if (!ref) throw err(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    await client.query('SELECT id FROM storefront_conversations WHERE id = $1 FOR UPDATE', [ref.conversation_id]);
    const m = (await client.query('SELECT * FROM storefront_messages WHERE id = $1 FOR UPDATE', [messageId])).rows[0];
    if (m.status !== 'held') throw err(409, 'ALREADY_REVIEWED', 'This message is not waiting for review.');
    if (decision === 'release') {
      await client.query(`UPDATE storefront_messages SET status = 'delivered', delivered_body = $2, delivered_at = now() WHERE id = $1`,
        [m.id, screening.screen(m.body).text]);
      await client.query('UPDATE storefront_conversations SET last_message_at = now() WHERE id = $1', [m.conversation_id]);
      await enqueueNotice(client, { ...m, status: 'delivered' });
    } else {
      await client.query(`UPDATE storefront_messages SET status = 'declined', decline_reason = $2 WHERE id = $1`, [m.id, why]);
    }
    await client.query(`INSERT INTO storefront_message_reviews (message_id, seller_id, action, actor_user_id, note) VALUES ($1, $2, $3, $4, $5)`,
      [m.id, m.seller_id, decision === 'release' ? 'released' : 'declined', adminId, why]);
    await logAccess(client, [m], adminId, 'conversation_view');
    return { id: m.id, status: decision === 'release' ? 'delivered' : 'declined' };
  });
}

// insertMessage takes the caller's transaction client (used by the rolled-back production verification script).
module.exports = { LIMITS, NOTICE, insertMessage, askAboutItem, listForBuyer, getForBuyer, replyAsBuyer, listForSeller, getForSeller, replyAsSeller,
  withdraw, appeal, reportMessage, hideMessage, listForReview, conversationForReview, review };
