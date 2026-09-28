'use strict';

/**
 * Sasha website chat (bid.advantage.bid and www.advantage.bid via the same iframe).
 *
 * A browser holds a random chat token (only its hash is stored). Identity for account data comes ONLY from the
 * authenticated session (req.user), never from the token or anything typed: a conversation is bound to the signed-in
 * user who started it, and a different signed-in user on the same browser gets a fresh conversation.
 */

const crypto = require('crypto');
const db = require('../../db');
const conversations = require('./conversationService');
const settings = require('./settings');
const engine = require('./engine');

const GREETING = "Hi! I'm Sasha. How can I help you today?";
const MAX_TEXT = 2000;
const MAX_MESSAGES_PER_10_MIN = 20;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function err(status, message) { return Object.assign(new Error(message), { status, userFacing: true }); }

async function enabledFor(site) {
  const s = await settings.effective();
  return site === 'www' ? s.chat_www : s.chat_bid;
}

/** Open (or resume) the visitor's conversation. Returns { token, ref, messages }. */
async function start({ site, token, userId }) {
  if (!(await enabledFor(site))) throw err(503, 'Chat is not available right now. Please email info@advantage.bid and we will help.');
  let conv = token ? await conversations.getByChatToken(token) : null;
  // Never show one signed-in person's conversation to another (shared computer): start fresh.
  if (conv && conv.user_id && conv.user_id !== userId) conv = null;
  if (conv && (conv.status === 'closed' || conv.status === 'ignored')) conv = null;
  if (conv && !conv.user_id && userId) {
    await db.query(`UPDATE cs_conversations SET user_id = $2, updated_at = now() WHERE id = $1 AND user_id IS NULL`, [conv.id, userId]);
  }
  if (!conv) {
    token = crypto.randomBytes(24).toString('base64url');
    let email = null, name = null;
    if (userId) {
      const u = (await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId])).rows[0];
      if (u) { email = u.email; name = u.full_name; }
    }
    conv = await conversations.createConversation({ channel: 'chat', site, customerEmail: email, customerName: name, userId: userId || null, chatToken: token });
    await conversations.addMessage(conv.id, { direction: 'outbound', author: 'sasha', text: GREETING });
  }
  return { token, ref: conv.ref, messages: await conversations.customerMessages(conv.id) };
}

async function requireConversation(token, userId) {
  const conv = token ? await conversations.getByChatToken(token) : null;
  if (!conv || conv.channel !== 'chat') throw err(404, 'This chat has ended. Please reopen help to start again.');
  if (conv.user_id && conv.user_id !== userId) throw err(404, 'This chat has ended. Please reopen help to start again.');
  return conv;
}

/** A customer message → Sasha's reply (unless a person owns the conversation). Returns { messages } (new ones). */
async function send({ token, text, userId, site }, deps = {}) {
  if (!(await enabledFor(site))) throw err(503, 'Chat is not available right now. Please email info@advantage.bid and we will help.');
  const conv = await requireConversation(token, userId);
  const body = String(text || '').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT);
  if (!body) throw err(400, 'Please type a message.');
  const recent = (await db.query(`SELECT count(*)::int n FROM cs_messages WHERE conversation_id = $1 AND author_type = 'customer'
    AND created_at > now() - interval '10 minutes'`, [conv.id])).rows[0].n;
  if (recent >= MAX_MESSAGES_PER_10_MIN) throw err(429, 'You\'re sending messages very quickly. Please wait a moment and try again.');

  const since = new Date(Date.now() - 1000);
  const inbound = await conversations.addMessage(conv.id, { direction: 'inbound', author: 'customer', text: body });
  // A visitor who is not signed in may give an email so the team can follow up.
  if (!conv.customer_email) {
    const m = EMAIL_RE.exec(body);
    if (m) await db.query(`UPDATE cs_conversations SET customer_email = $2 WHERE id = $1 AND customer_email IS NULL`, [conv.id, m[0].toLowerCase()]);
  }
  const fresh = await conversations.get(conv.id);
  if (fresh.owner === 'staff') return { messages: await conversations.customerMessages(conv.id, { after: since }) };

  const r = await engine.respond({ conversationId: conv.id, triggerMessageId: inbound.id,
    ctx: { channel: 'chat', userId: fresh.user_id && fresh.user_id === userId ? userId : null, customerName: fresh.customer_name,
      hasContactEmail: !!fresh.customer_email } }, deps);
  if (r.outcome === 'replied' || r.outcome === 'handoff') {
    const reply = await conversations.addSashaReply(conv.id, { text: r.text, autoSent: true });
    if (!reply.blocked && r.runId) await db.query(`UPDATE cs_ai_runs SET reply_message_id = $2 WHERE id = $1`, [r.runId, reply.id]);
  } else {
    // Engine off / budget / failure: never leave the visitor unanswered — hand to the team and say so.
    await conversations.requestHandoff(conv.id, { reasonCode: 'uncertain', reasonText: `Sasha could not answer automatically (${r.outcome}).`, createdBy: 'system' });
    const need = fresh.customer_email ? '' : ' If you\'d like us to reply by email, please type your email address.';
    await conversations.addSashaReply(conv.id, { text: `Thanks for your message. A member of our team will follow up with you.${need}`, autoSent: true });
  }
  return { messages: await conversations.customerMessages(conv.id, { after: since }) };
}

async function poll({ token, after, userId }) {
  const conv = await requireConversation(token, userId);
  const at = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
  return { messages: await conversations.customerMessages(conv.id, { after: at }), owner: conv.owner };
}

module.exports = { start, send, poll, enabledFor, GREETING, LIMITS: { MAX_TEXT, MAX_MESSAGES_PER_10_MIN } };
