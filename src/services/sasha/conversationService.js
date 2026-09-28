'use strict';

/**
 * conversationService — Sasha's conversation store (cs_conversations / cs_messages / cs_handoffs).
 *
 * Ownership is the takeover guarantee: a conversation is owned by 'sasha' or 'staff'. Sasha may only add a reply
 * through addSashaReply(), which re-reads the owner UNDER A ROW LOCK in the same transaction as the insert — so a
 * staff takeover that commits first always wins, and Sasha can never answer after a person has taken over.
 */

const crypto = require('crypto');
const db = require('../../db');

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
function newRef() { let s = ''; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) s += REF_ALPHABET[b[i] % REF_ALPHABET.length]; return 'S' + s; }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normEmail = (e) => (e ? String(e).trim().toLowerCase() : null);

async function createConversation({ channel, site = null, subject = null, customerEmail = null, customerName = null, userId = null,
  contactMatchUserId = null, chatToken = null }, runner = db) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await runner.query(
        `INSERT INTO cs_conversations (ref, channel, site, subject, customer_email, customer_name, user_id, contact_match_user_id, chat_token_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [newRef(), channel, site, subject ? String(subject).slice(0, 300) : null, normEmail(customerEmail),
          customerName ? String(customerName).slice(0, 200) : null, userId, contactMatchUserId, chatToken ? sha256(chatToken) : null]);
      return rows[0];
    } catch (e) { if (e.code !== '23505' || !/ref/.test(e.detail || e.message)) throw e; }   // ref collision → retry
  }
  throw new Error('could not allocate a conversation reference');
}

const get = async (id, runner = db) => (await runner.query('SELECT * FROM cs_conversations WHERE id = $1', [id])).rows[0] || null;
const getByChatToken = async (token, runner = db) =>
  (token ? (await runner.query('SELECT * FROM cs_conversations WHERE chat_token_hash = $1', [sha256(token)])).rows[0] : null) || null;
const getByRef = async (ref, runner = db) => (await runner.query('SELECT * FROM cs_conversations WHERE ref = $1', [String(ref || '').toUpperCase()])).rows[0] || null;

async function addMessage(conversationId, m, runner = db) {
  const { rows } = await runner.query(
    `INSERT INTO cs_messages (conversation_id, direction, author_type, staff_user_id, body_text, email_message_id, in_reply_to,
                              references_header, inbound_receipt_id, ses_message_id, delivery_status, auto_sent, attachments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
    [conversationId, m.direction, m.author, m.staffUserId || null, String(m.text || '').slice(0, 20000), m.emailMessageId || null,
      m.inReplyTo || null, m.references || null, m.inboundReceiptId || null, m.sesMessageId || null, m.deliveryStatus || null,
      !!m.autoSent, JSON.stringify(m.attachments || [])]);
  const isCustomer = m.author === 'customer';
  await runner.query(
    `UPDATE cs_conversations SET message_count = message_count + 1, last_message_at = now(), updated_at = now(),
            last_customer_at = CASE WHEN $2 THEN now() ELSE last_customer_at END,
            auto_reply_count = auto_reply_count + CASE WHEN $3 THEN 1 ELSE 0 END,
            status = CASE WHEN $2 AND status IN ('resolved','waiting_customer') THEN 'open'
                          WHEN $4 THEN 'waiting_customer' ELSE status END
      WHERE id = $1`, [conversationId, isCustomer, !!m.autoSent, m.direction === 'outbound']);
  return rows[0];
}

/**
 * Add Sasha's reply ONLY if Sasha still owns the conversation (checked under a row lock). Returns the message, or
 * { blocked: 'staff_owned' | 'closed' } when a person took over (or the thread was closed) while she was thinking.
 */
async function addSashaReply(conversationId, m) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const conv = (await c.query('SELECT owner, status FROM cs_conversations WHERE id = $1 FOR UPDATE', [conversationId])).rows[0];
    if (!conv) { await c.query('ROLLBACK'); return { blocked: 'missing' }; }
    if (conv.owner !== 'sasha') { await c.query('ROLLBACK'); return { blocked: 'staff_owned' }; }
    if (conv.status === 'closed' || conv.status === 'ignored') { await c.query('ROLLBACK'); return { blocked: 'closed' }; }
    const msg = await addMessage(conversationId, { ...m, direction: 'outbound', author: 'sasha' }, c);
    await c.query('COMMIT');
    return msg;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** Open a handoff (idempotent per open reason) and flag the conversation for staff. Sasha keeps ownership unless taken. */
async function requestHandoff(conversationId, { reasonCode, reasonText, createdBy }, runner = db) {
  const open = (await runner.query(`SELECT id FROM cs_handoffs WHERE conversation_id = $1 AND status = 'open' LIMIT 1`, [conversationId])).rows[0];
  if (!open) {
    await runner.query(`INSERT INTO cs_handoffs (conversation_id, reason_code, reason_text, created_by) VALUES ($1,$2,$3,$4)`,
      [conversationId, reasonCode || 'other', reasonText ? String(reasonText).slice(0, 1000) : null, createdBy || 'sasha']);
  }
  await runner.query(`UPDATE cs_conversations SET handoff_state = 'needed', handoff_reason = COALESCE($2, handoff_reason),
      status = CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`,
  [conversationId, reasonText ? String(reasonText).slice(0, 300) : reasonCode]);
}

/** Staff takes over: Sasha stops replying immediately (ownership flips under lock). */
async function takeOver(conversationId, staffUserId) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const conv = (await c.query('SELECT id FROM cs_conversations WHERE id = $1 FOR UPDATE', [conversationId])).rows[0];
    if (!conv) { await c.query('ROLLBACK'); return null; }
    await c.query(`UPDATE cs_conversations SET owner = 'staff', assigned_staff_id = $2, handoff_state = 'taken', updated_at = now() WHERE id = $1`,
      [conversationId, staffUserId]);
    await c.query(`UPDATE cs_handoffs SET status = 'taken', taken_by = $2 WHERE conversation_id = $1 AND status = 'open'`, [conversationId, staffUserId]);
    await addMessage(conversationId, { direction: 'note', author: 'system', text: 'A team member took over this conversation. Sasha will not reply.' }, c);
    await c.query('COMMIT');
    return get(conversationId);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** Staff hands the conversation back to Sasha (she answers the NEXT customer message; nothing is sent now). */
async function returnToSasha(conversationId, staffUserId) {
  await db.query(`UPDATE cs_conversations SET owner = 'sasha', assigned_staff_id = NULL,
      handoff_state = CASE WHEN handoff_state IN ('needed','taken') THEN 'resolved' ELSE handoff_state END, updated_at = now() WHERE id = $1`, [conversationId]);
  await db.query(`UPDATE cs_handoffs SET status = 'resolved', resolved_at = now() WHERE conversation_id = $1 AND status <> 'resolved'`, [conversationId]);
  await addMessage(conversationId, { direction: 'note', author: 'system', text: 'Returned to Sasha by a team member.', staffUserId });
  return get(conversationId);
}

async function setStatus(conversationId, status) {
  await db.query(`UPDATE cs_conversations SET status = $2, updated_at = now(),
      handoff_state = CASE WHEN $2 IN ('resolved','closed') AND handoff_state = 'needed' THEN 'resolved' ELSE handoff_state END WHERE id = $1`,
  [conversationId, status]);
  if (status === 'resolved' || status === 'closed') {
    await db.query(`UPDATE cs_handoffs SET status = 'resolved', resolved_at = now() WHERE conversation_id = $1 AND status <> 'resolved'`, [conversationId]);
  }
  return get(conversationId);
}

/** Messages as the CUSTOMER sees them (never internal notes or system notes). */
async function customerMessages(conversationId, { after = null } = {}) {
  const { rows } = await db.query(
    `SELECT m.id, m.author_type, m.body_text, m.created_at, u.full_name AS staff_name
       FROM cs_messages m LEFT JOIN users u ON u.id = m.staff_user_id
      WHERE m.conversation_id = $1 AND m.direction IN ('inbound','outbound') AND ($2::timestamptz IS NULL OR m.created_at > $2)
      ORDER BY m.created_at ASC LIMIT 200`, [conversationId, after]);
  return rows.map((r) => ({ id: r.id, author: r.author_type, text: r.body_text, at: r.created_at,
    staff_name: r.author_type === 'staff' ? (String(r.staff_name || '').split(' ')[0] || 'Advantage.Bid team') : undefined }));
}

/** Recent turns for the model: customer + Sasha + staff replies (no internal notes), oldest first, capped. */
async function transcriptForModel(conversationId, limit = 24) {
  const { rows } = await db.query(
    `SELECT author_type, body_text FROM (
       SELECT author_type, body_text, created_at FROM cs_messages
        WHERE conversation_id = $1 AND direction IN ('inbound','outbound') ORDER BY created_at DESC LIMIT $2) t
      ORDER BY created_at ASC`, [conversationId, limit]);
  return rows;
}

module.exports = { createConversation, get, getByChatToken, getByRef, addMessage, addSashaReply, requestHandoff, takeOver, returnToSasha,
  setStatus, customerMessages, transcriptForModel, sha256, normEmail, newRef };
