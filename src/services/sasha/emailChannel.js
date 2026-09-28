'use strict';

/**
 * Sasha email channel — customer-service mail for info@advantage.bid.
 *
 * Mail arrives as a COPY: cPanel keeps the real info@ mailbox and the Gmail forwarder, and adds one more forwarder to
 * inbox@reply.advantage.bid, which reaches us through the existing SES → S3 → SNS pipeline (sesInbound routes that
 * address here as programme 'company_inbox'). Replies go out from info@advantage.bid, so the customer's reply comes
 * back through the same copy path and threads onto the same conversation.
 *
 * Protections (in order): own-domain / Sasha-loop mail, bounces, autoresponders and bulk/list mail, no-reply and
 * system senders, empty mail → ignored (never answered). Duplicate Message-ID → idempotent no-op. Threading by
 * In-Reply-To/References (our Message-ID or SES id) then the [Ref …] subject token (only for the same sender).
 * Per-sender and per-conversation auto-reply caps stop loops and floods. A staff-owned conversation is never
 * auto-answered. Attachments are never opened (names/types recorded only).
 */

const db = require('../../db');
const conversations = require('./conversationService');
const settings = require('./settings');
const engine = require('./engine');

const SUPPORT_FROM = () => process.env.SASHA_SUPPORT_FROM || 'info@advantage.bid';
const SIGNATURE = '\n\nSasha\nAdvantage.Bid\nhttps://www.advantage.bid';
const MAX_AUTO_PER_SENDER_PER_HOUR = 4;
const MAX_AUTO_PER_SENDER_PER_DAY = 12;
const MAX_AUTO_PER_CONVERSATION = 25;

const OWN_DOMAINS = /(^|\.)advantage\.bid$|(^|\.)advantageauction\.bid$/i;
const SYSTEM_SENDER = /^(no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|automated|system|daemon|root|nobody)([+._-].*)?@/i;
const SYSTEM_DOMAINS = /(^|\.)(stripe\.com|amazonses\.com|amazonaws\.com|railway\.app|brilliantdirectories\.com|bdsites\.net|google\.com|facebookmail\.com|twilio\.com|sendgrid\.net|mailchimp\.com|mcsv\.net)$/i;

function header(msg, name) { const h = msg.headers || {}; return String(h[name] || h[name.toLowerCase()] || '').trim(); }

/** Why this message must NOT be answered (or null when it is a customer message). */
function ignoreReason(msg) {
  const from = String(msg.fromEmail || '').toLowerCase();
  const domain = from.split('@')[1] || '';
  if (!from || !from.includes('@')) return 'no_sender';
  if (header(msg, 'x-advantage-sasha')) return 'sasha_loop';
  if (OWN_DOMAINS.test(domain) || header(msg, 'x-advantage-oversight')) return 'own_mail';
  const auto = header(msg, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return 'auto_submitted';
  const prec = header(msg, 'precedence').toLowerCase();
  if (/^(bulk|list|junk|auto_reply)$/.test(prec)) return 'bulk_or_auto';
  if (header(msg, 'x-autoreply') || header(msg, 'x-autorespond') || /\b(oof|autoreply)\b/i.test(header(msg, 'x-auto-response-suppress'))) return 'auto_responder';
  if (header(msg, 'list-id') || header(msg, 'list-unsubscribe')) return 'mailing_list';
  if (/multipart\/report/i.test(header(msg, 'content-type')) || /^(mailer-daemon|postmaster)@/i.test(from)) return 'bounce';
  if (/^(auto(matic)?[ -]?reply|out of (the )?office|delivery status notification|undeliverable|returned mail)/i.test(String(msg.subject || ''))) return 'auto_responder';
  if (SYSTEM_SENDER.test(from)) return 'system_sender';
  if (SYSTEM_DOMAINS.test(domain)) return 'system_domain';
  if (!String(msg.textBody || '').trim() && !String(msg.htmlBody || '').trim()) return 'empty';
  return null;
}

const idsFrom = (s) => (String(s || '').match(/<[^>]+>/g) || []).map((x) => x.trim());
const REF_RE = /\[Ref\s+(S[A-Z0-9]{6})\]/i;

/** Find the conversation a reply belongs to: our Message-ID / SES id in In-Reply-To/References, else the subject ref. */
async function findThread(msg) {
  const ids = [...idsFrom(msg.inReplyTo), ...idsFrom(msg.references)];
  if (ids.length) {
    const sesIds = ids.map((i) => (/^<([^@>]+)@email\.amazonses\.com>$/i.exec(i) || [])[1]).filter(Boolean);
    const hit = (await db.query(
      `SELECT conversation_id FROM cs_messages WHERE (email_message_id = ANY($1::text[]) OR ses_message_id = ANY($2::text[]))
        ORDER BY created_at DESC LIMIT 1`, [ids, sesIds])).rows[0];
    if (hit) return conversations.get(hit.conversation_id);
  }
  const m = REF_RE.exec(String(msg.subject || ''));
  if (m) {
    const conv = await conversations.getByRef(m[1]);
    // A subject token alone only threads mail from the SAME address (a forged ref can't join someone else's thread).
    if (conv && conv.channel === 'email' && conv.customer_email === conversations.normEmail(msg.fromEmail)) return conv;
  }
  return null;
}

/** Strip quoted history so the model and staff see what the customer actually wrote now. */
function newText(msg) {
  let t = String(msg.textBody || '');
  if (!t.trim() && msg.htmlBody) t = String(msg.htmlBody).replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const cut = t.search(/\n\s*(On .{5,200}wrote:|-{2,}\s*Original Message|From:\s.+\n\s*Sent:|_{5,})/i);
  if (cut > 0) t = t.slice(0, cut);
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
}

async function autoRepliesToSender(email) {
  const r = (await db.query(
    `SELECT count(*) FILTER (WHERE m.created_at > now() - interval '1 hour')::int h, count(*)::int d
       FROM cs_messages m JOIN cs_conversations c ON c.id = m.conversation_id
      WHERE c.customer_email = $1 AND m.auto_sent = true AND m.created_at > now() - interval '1 day'`, [email])).rows[0];
  return r || { h: 0, d: 0 };
}

function replySubject(conv, original) {
  const base = String(original || conv.subject || 'Your question').replace(REF_RE, '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim().slice(0, 150) || 'Your question';
  return `Re: ${base} [Ref ${conv.ref}]`;
}

async function sendReply(conv, inbound, text, deps) {
  const email = deps.emailService || require('../emailService');
  const refs = [...new Set([...idsFrom(inbound.references_header), ...idsFrom(inbound.email_message_id)])].slice(-10).join(' ');
  const body = text.trim() + SIGNATURE + `\n\nRef: ${conv.ref}`;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">'
    + body.split(/\n{2,}/).map((p) => '<p style="margin:0 0 12px">' + p.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
      .replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>') + '</p>').join('') + '</div>';
  return email.sendEmail({
    to: conv.customer_email, subject: replySubject(conv, inbound.subject || conv.subject), text: body, html,
    fromAddress: SUPPORT_FROM(), fromName: 'Sasha at Advantage.Bid', replyTo: SUPPORT_FROM(), mailStream: 'support',
    headers: {
      ...(inbound.email_message_id ? { 'In-Reply-To': inbound.email_message_id } : {}),
      ...(refs ? { References: refs } : {}),
      'Auto-Submitted': 'auto-replied',          // RFC 3834: other autoresponders must not answer us (loop guard)
      'X-Advantage-Sasha': conv.ref,             // our own mail is recognised and never answered
    },
  });
}

/**
 * Handle one inbound customer-service email (called by sesInbound for programme 'company_inbox').
 * Returns an outcome object for the receipt log. Throws INBOUND_DISABLED when receiving is switched off (the
 * receipt is held and retried — never lost).
 */
async function handleInbound(msg, receipt = {}, deps = {}) {
  const s = await settings.effective();
  if (!s.email_inbound) { const e = new Error('Sasha inbound is disabled'); e.code = 'INBOUND_DISABLED'; throw e; }
  const why = ignoreReason(msg);
  if (why) return { status: 'ignored', reason: why };
  const messageId = msg.messageIdHeader ? String(msg.messageIdHeader).trim() : null;
  if (messageId) {
    const dup = (await db.query(`SELECT conversation_id FROM cs_messages WHERE direction = 'inbound' AND email_message_id = $1`, [messageId])).rows[0];
    if (dup) return { status: 'duplicate', conversation_id: dup.conversation_id };
  }
  const fromEmail = conversations.normEmail(msg.fromEmail);
  let conv = await findThread(msg);
  if (!conv) {
    const match = (await db.query(`SELECT id FROM users WHERE lower(email) = $1 OR lower(contact_email) = $1 LIMIT 1`, [fromEmail])).rows[0];
    conv = await conversations.createConversation({ channel: 'email', subject: msg.subject, customerEmail: fromEmail, customerName: msg.fromName,
      contactMatchUserId: match ? match.id : null });
  }
  let inbound;
  try {
    inbound = await conversations.addMessage(conv.id, { direction: 'inbound', author: 'customer', text: newText(msg) || '(no text)',
      emailMessageId: messageId, inReplyTo: msg.inReplyTo || null, references: msg.references || null, inboundReceiptId: receipt.id || null,
      attachments: (msg.attachments || []).slice(0, 20).map((a) => ({ name: a.filename || null, type: a.contentType || null, size: a.size || null })) });
  } catch (e) {
    if (e.code === '23505') return { status: 'duplicate', conversation_id: conv.id };
    throw e;
  }
  inbound.subject = msg.subject;
  conv = await conversations.get(conv.id);

  if (conv.owner === 'staff') return { status: 'received', conversation_id: conv.id, reply: 'staff_owned' };

  const counts = await autoRepliesToSender(fromEmail);
  if (counts.h >= MAX_AUTO_PER_SENDER_PER_HOUR || counts.d >= MAX_AUTO_PER_SENDER_PER_DAY || conv.auto_reply_count >= MAX_AUTO_PER_CONVERSATION) {
    await conversations.requestHandoff(conv.id, { reasonCode: 'other', reasonText: 'Auto-reply limit reached for this sender (possible loop or flood) — please review.', createdBy: 'system' });
    return { status: 'received', conversation_id: conv.id, reply: 'rate_limited' };
  }

  const r = await engine.respond({ conversationId: conv.id, triggerMessageId: inbound.id, ctx: { channel: 'email', userId: null, customerName: msg.fromName } }, deps);
  if (r.outcome !== 'replied' && r.outcome !== 'handoff') {
    await conversations.requestHandoff(conv.id, { reasonCode: 'uncertain', reasonText: `Sasha could not answer automatically (${r.outcome}${r.budget ? ': daily budget' : ''}).`, createdBy: 'system' });
    return { status: 'received', conversation_id: conv.id, reply: r.outcome };
  }
  if (!s.email_autoreply) {
    await conversations.addMessage(conv.id, { direction: 'note', author: 'sasha', text: `Suggested reply (not sent — email auto-reply is off):\n\n${r.text}` });
    if (!r.handoff) await conversations.requestHandoff(conv.id, { reasonCode: 'other', reasonText: 'Email auto-reply is off: review and send Sasha\'s suggested reply.', createdBy: 'system' });
    return { status: 'received', conversation_id: conv.id, reply: 'drafted' };
  }
  const reply = await conversations.addSashaReply(conv.id, { text: r.text, autoSent: true, deliveryStatus: 'pending' });
  if (reply.blocked) return { status: 'received', conversation_id: conv.id, reply: reply.blocked };
  try {
    const sent = await sendReply(conv, inbound, r.text, deps);
    await db.query(`UPDATE cs_messages SET delivery_status = $2, email_message_id = $3, ses_message_id = $4 WHERE id = $1`,
      [reply.id, sent && sent.skipped ? 'not_sent' : 'sent', sent && sent.messageId ? `<${String(sent.messageId).replace(/^<|>$/g, '')}>` : null, (sent && sent.sesMessageId) || null]);
    if (r.runId) await db.query(`UPDATE cs_ai_runs SET reply_message_id = $2 WHERE id = $1`, [r.runId, reply.id]);
    return { status: 'processed', conversation_id: conv.id, reply: 'sent', handoff: !!r.handoff };
  } catch (e) {
    await db.query(`UPDATE cs_messages SET delivery_status = 'failed', delivery_error = $2 WHERE id = $1`, [reply.id, String(e.message).slice(0, 300)]);
    await conversations.requestHandoff(conv.id, { reasonCode: 'other', reasonText: 'Sasha\'s email reply could not be sent — please reply manually.', createdBy: 'system' });
    return { status: 'processed', conversation_id: conv.id, reply: 'send_failed' };
  }
}

/** Staff reply by email (from the Shared Inbox) — same threading headers; never auto-submitted. */
async function sendStaffEmail(conv, text, staffUserId, deps = {}) {
  const email = deps.emailService || require('../emailService');
  const last = (await db.query(`SELECT email_message_id, references_header FROM cs_messages WHERE conversation_id = $1 AND direction = 'inbound'
    ORDER BY created_at DESC LIMIT 1`, [conv.id])).rows[0] || {};
  const refs = [...new Set([...idsFrom(last.references_header), ...idsFrom(last.email_message_id)])].slice(-10).join(' ');
  const body = text.trim() + '\n\nAdvantage.Bid\nhttps://www.advantage.bid' + `\n\nRef: ${conv.ref}`;
  const sent = await email.sendEmail({ to: conv.customer_email, subject: replySubject(conv, conv.subject), text: body,
    html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">' + body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>') + '</div>',
    fromAddress: SUPPORT_FROM(), fromName: 'Advantage.Bid', replyTo: SUPPORT_FROM(), mailStream: 'support',
    headers: { ...(last.email_message_id ? { 'In-Reply-To': last.email_message_id } : {}), ...(refs ? { References: refs } : {}), 'X-Advantage-Sasha': conv.ref } });
  return sent;
}

module.exports = { handleInbound, sendStaffEmail, ignoreReason, findThread, newText, replySubject, LIMITS: { MAX_AUTO_PER_SENDER_PER_HOUR, MAX_AUTO_PER_SENDER_PER_DAY, MAX_AUTO_PER_CONVERSATION } };
