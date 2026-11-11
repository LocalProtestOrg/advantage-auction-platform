'use strict';

/**
 * Sasha email channel — customer-service mail for info@advantage.bid.
 *
 * Mail arrives as a COPY: cPanel keeps the real info@ mailbox and the Gmail forwarder, and adds one more forwarder to
 * inbox@reply.advantage.bid, which reaches us through the existing SES → S3 → SNS pipeline (sesInbound routes that
 * address here as programme 'company_inbox'). Replies go out from info@advantage.bid, so the customer's reply comes
 * back through the same copy path and threads onto the same conversation.
 *
 * Three outcomes (owner 2026-11-11): a customer message is answered; automated, junk or forged mail (own/Sasha loops,
 * bounces, DMARC/TLS reports, auto-replies, no-reply and system senders, spam, failed authentication, and bulk or
 * marketing mail that starts a new conversation) is ignored and recorded on the receipt; uncertain mail is held for a
 * person (a handoff in the Sasha Admin Inbox, listed in the 9:00 AM digest) without an automatic reply. A draft in
 * which Sasha herself says the mail needs no answer is not sent either. Duplicate Message-ID → idempotent no-op. Threading by
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

const MAX_AUTO_GLOBAL_PER_HOUR = 30;      // all senders together: a flood or loop stops here and goes to a person

const OWN_DOMAINS = /(^|\.)advantage\.bid$|(^|\.)advantageauction\.bid$/i;
// "no-reply" anywhere in the local part (testflight_no_reply@, noreply-dmarc-support@), or a whole system mailbox name.
const SYSTEM_SENDER = /^(.*[._+-])?(no-?reply|no_reply|do-?not-?reply|do_not_reply|donotreply)([._+-].*)?@|^(mailer-daemon|postmaster|bounces?|notifications?|alerts?|automated|system|daemon|root|nobody)([+._-].*)?@/i;
const SYSTEM_DOMAINS = /(^|\.)(stripe\.com|amazonses\.com|amazonaws\.com|railway\.app|brilliantdirectories\.com|bdsites\.net|google\.com|facebookmail\.com|twilio\.com|sendgrid\.net|mailchimp\.com|mcsv\.net)$/i;
// DMARC aggregate/forensic and SMTP TLS reports (e.g. dmarcreport@microsoft.com, noreply-dmarc-support@google.com).
const REPORT_SENDER = /^[^@]*(dmarc|tls-?rpt|tls-?reports?)[^@]*@/i;
const REPORT_SUBJECT = /^\s*(\[preview\]\s*)?report\s+domain:|\breport-id:|\bdmarc\s+(aggregate|forensic|failure)\s+report\b|^\s*report\s+domain\s|\bsmtp tls report(ing)?\b/i;
const REPORT_ATTACHMENT = /^[^!\s]+![^!\s]+!\d{9,}!\d{9,}(![^.]*)?\.(xml|json)(\.gz|\.zip)?$|\.(xml|json)\.gz$/i;
const OOO_SUBJECT = /^\s*(auto(matic)?[ -]?(reply|response|antwort)|autoreply|out of (the )?office|away from (the )?office|on vacation|vacation reply|delivery (status )?notification|undeliver(able|ed)|returned mail|mail delivery (failed|subsystem)|delivery failure|failure notice|read:\s|message not delivered|not read:)/i;
// Headers only sending platforms add (bulk, marketing or transactional systems: never a person writing to us).
const BULK_PLATFORM_HEADERS = ['feedback-id', 'x-campaign', 'x-campaign-id', 'x-campaignid', 'x-mc-user', 'x-mailchimp-campaign', 'x-sg-eid', 'x-sfmc-stack',
  'x-mkto-trk', 'x-marketoid', 'x-hs-cta-tracking', 'x-hubspot-email', 'x-klaviyo', 'x-mailjet-campaign', 'x-sib-id', 'x-csa-complaints', 'x-pm-tag', 'x-mailgun-tag'];
const BULK_MAILER = /\b(mailchimp|marketo|hubspot|klaviyo|exacttarget|salesforce marketing|sendgrid|mailgun|constant ?contact|sendinblue|brevo|pardot|iterable|customer\.io|campaign monitor|activecampaign|mailjet|omnisend|convertkit|drip|aweber|getresponse|pabbly|lemlist|instantly|apollo|outreach\.io|smartlead|woodpecker|reply\.io)\b/i;
// A sending subdomain such as em.salesai.com, mail.mapbox.com, m.newyorksavings.co: used by mail platforms, not by people.
const SENDING_SUBDOMAIN = /^(e|m|r|t|em|e2|email|emails|mail|mailer|mailing|mails|news|newsletter|newsletters|mkt|marketing|campaign|campaigns|promo|promos|fyi|go|hello|updates|offers|engage|send|bulk|info)$/i;
// Paid-link / SEO solicitations (content signal; only ever stops an automatic reply).
const SOLICITATION = /\b(guest[- ]post(ing)?|back-?links?|link[- ]insertion|link[- ]building|sponsored (post|article|content)|brand mention|editorial link|blog mention|do-?follow link|niche edit)s?\b/i;
const BILLING_ROLE = /^(billing|invoices?|invoicing|accounts?|accounting|accounts-?payable|accounts-?receivable|receipts?|payments?|ar|ap)([+._-].*)?@/i;
const RISKY_ATTACHMENT = /\.(exe|scr|com|pif|bat|cmd|msi|jar|js|jse|vbs|vbe|wsf|wsh|hta|lnk|ps1|iso|img|vhd|html?|shtml|svg)$/i;
const BRAND_NAME = /advantage\s*\.?\s*bid|advantage auction/i;

const OUTREACH_REPLY_ADDR = /\b(listings|partner)\+l?[0-9a-f]{24}@reply\.advantage\.bid\b/i;

function header(msg, name) { const h = msg.headers || {}; return String(h[name] || h[name.toLowerCase()] || '').trim(); }

/** Authentication results: SES verdicts (when the copy came through SES) or the receiving server's Authentication-Results header. */
function authResults(msg, verdicts) {
  const v = verdicts || {};
  const ar = header(msg, 'authentication-results').toLowerCase();
  const pick = (k) => { const m = new RegExp('\\b' + k + '=(\\w+)').exec(ar); return m ? m[1] : null; };
  const norm = (x) => (x ? String(x).toLowerCase() : null);
  return { spf: norm(v.spf) || pick('spf'), dkim: norm(v.dkim) || pick('dkim'), dmarc: norm(v.dmarc) || pick('dmarc'), spam: norm(v.spam) };
}

function sendingSubdomain(domain) {
  const labels = String(domain || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 3 || !SENDING_SUBDOMAIN.test(labels[0])) return false;
  // mail.co.uk-style provider domains are not a subdomain of someone else's domain.
  return !(labels.length === 3 && /^(co|com|net|org|gov|edu|ac)$/.test(labels[1]));
}

/**
 * Why this message must NOT be answered (or null). Two strengths:
 *   HARD reasons are never answered (loops, bounces, reports, auto-replies, system senders, failed authentication).
 *   SOFT reasons (bulk / marketing / solicitations) are never answered as a NEW conversation; inside an existing
 *   conversation they are held for a person instead (handleInbound decides). Both are recorded on the receipt.
 */
function ignoreReason(msg, verdicts) {
  const from = String(msg.fromEmail || '').toLowerCase();
  const domain = from.split('@')[1] || '';
  const subject = String(msg.subject || '');
  if (!from || !from.includes('@')) return 'no_sender';
  if (header(msg, 'x-advantage-sasha')) return 'sasha_loop';
  // A copy of a Claimed Listing / Event Partner outreach thread (e.g. a reply that also went to info@): that
  // programme handles it; Sasha never answers outreach.
  if (OUTREACH_REPLY_ADDR.test([header(msg, 'to'), header(msg, 'cc')].join(' '))) return 'outreach_thread';
  if (OWN_DOMAINS.test(domain) || header(msg, 'x-advantage-oversight')) return 'own_mail';
  const auto = header(msg, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return 'auto_submitted';
  const ctype = header(msg, 'content-type');
  if (/multipart\/report/i.test(ctype) && /report-type=["']?feedback-report/i.test(ctype)) return 'dmarc_report';   // forensic (ARF)
  if (/multipart\/report/i.test(ctype) || /^(mailer-daemon|postmaster)@/i.test(from)) return 'bounce';
  if (REPORT_SENDER.test(from) || REPORT_SUBJECT.test(subject) || (msg.attachments || []).some((a) => REPORT_ATTACHMENT.test(String(a.filename || '')))) return 'dmarc_report';
  const prec = header(msg, 'precedence').toLowerCase();
  if (prec === 'auto_reply') return 'auto_responder';
  if (header(msg, 'x-autoreply') || header(msg, 'x-autorespond') || /\b(oof|autoreply)\b/i.test(header(msg, 'x-auto-response-suppress')) || OOO_SUBJECT.test(subject)) return 'auto_responder';
  if (SYSTEM_SENDER.test(from)) return 'system_sender';
  if (SYSTEM_DOMAINS.test(domain)) return 'system_domain';
  const s = String((verdicts && verdicts.spam) || '').toUpperCase();
  if (s === 'FAIL' || /^yes\b/i.test(header(msg, 'x-spam-flag')) || /^yes\b/i.test(header(msg, 'x-spam-status'))) return 'spam';
  if (String((verdicts && verdicts.virus) || '').toUpperCase() === 'FAIL') return 'virus';
  const a = authResults(msg, verdicts);
  // Forged sender: the domain's own DMARC check failed and neither SPF nor DKIM vouches for it.
  if (a.dmarc === 'fail' && a.spf !== 'pass' && a.dkim !== 'pass') return 'auth_failed';
  if (!String(msg.textBody || '').trim() && !String(msg.htmlBody || '').trim()) return 'empty';
  // ── soft ──
  if (/^(bulk|list|junk)$/.test(prec)) return 'bulk_or_auto';
  if (header(msg, 'list-id') || header(msg, 'list-unsubscribe') || header(msg, 'list-post')) return 'mailing_list';
  if (BULK_PLATFORM_HEADERS.some((h) => header(msg, h)) || BULK_MAILER.test(header(msg, 'x-mailer'))) return 'bulk_platform';
  if (sendingSubdomain(domain)) return 'bulk_sender_domain';
  if (SOLICITATION.test(subject + '\n' + String(msg.textBody || '').slice(0, 4000))) return 'solicitation';
  return null;
}
const SOFT_REASONS = new Set(['bulk_or_auto', 'mailing_list', 'bulk_platform', 'bulk_sender_domain', 'solicitation']);

/**
 * Uncertain mail that may still be legitimate: never answered automatically, kept in the Sasha Admin Inbox as a
 * handoff (it then appears in the 9:00 AM owner review digest). Returns a short reason, or null.
 */
function reviewReason(msg, verdicts) {
  const from = String(msg.fromEmail || '').toLowerCase();
  const a = authResults(msg, verdicts);
  if (a.spam === 'gray' || a.spam === 'processing_failed') return 'spam_check_uncertain';
  if (a.dmarc === 'fail') return 'sender_authentication_failed';
  if ((msg.attachments || []).some((x) => RISKY_ATTACHMENT.test(String(x.filename || '')))) return 'risky_attachment';
  if (BRAND_NAME.test(String(msg.fromName || '')) && !OWN_DOMAINS.test(from.split('@')[1] || '')) return 'brand_impersonation';
  if (BILLING_ROLE.test(from)) return 'billing_or_vendor_notice';
  return null;
}
const REVIEW_LABELS = {
  spam_check_uncertain: 'the spam check was inconclusive', sender_authentication_failed: "the sender's domain failed its authentication check",
  risky_attachment: 'it carries an attachment type often used in phishing', brand_impersonation: 'the sender name uses the Advantage.Bid name from another domain',
  billing_or_vendor_notice: 'it looks like a billing or vendor notice', bulk_or_auto: 'it looks like bulk mail', mailing_list: 'it looks like mailing-list mail',
  bulk_platform: 'it was sent by a bulk mail platform', bulk_sender_domain: 'it came from a bulk sending address', solicitation: 'it looks like a marketing solicitation',
  not_customer_message: 'Sasha judged it was not a customer message',
};

// Backstop on Sasha's own draft (never the only check): a draft saying the mail needs no answer is not sent.
const NOT_CUSTOMER_DRAFT = /\bnot an? (customer|support|customer[- ]service)( support)? (request|inquiry|question|message|email)\b|\bnothing (here )?(for me )?to (help with|respond to|reply to|answer)\b|\bno (reply|response|action) (is )?(needed|required) (on my end|from me|here)\b|\b(this|it) (looks|appears) (like|to be) an? (automated|automatic|system[- ]generated)\b/i;

/**
 * Content fingerprint for mail that has no Message-ID: sender + Date header + subject + the customer's new text.
 * Stable across delivery routes (the info@ mailbox read over IMAP, or a forwarded copy through SES).
 */
function contentFingerprint(msg) {
  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
  const parts = [norm(msg.fromEmail), norm(header(msg, 'date')), norm(String(msg.subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')), norm(newText(msg))];
  if (!parts[0] || !parts[3]) return null;
  return require('crypto').createHash('sha256').update(parts.join('|')).digest('hex');
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
  // "On <date> <name> wrote:" — Gmail/Apple often wrap it over two lines, so allow one line break inside.
  const cut = t.search(/\n\s*(On [^\n]{5,200}(\n[^\n]{0,120})?wrote:|-{2,}\s*Original Message|From:\s.+\n\s*Sent:|_{5,})/i);
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

/** Automatic email replies to anyone in the last hour (a flood or a loop with many addresses stops here). */
async function autoRepliesLastHour() {
  const r = (await db.query(
    `SELECT count(*)::int n FROM cs_messages m JOIN cs_conversations c ON c.id = m.conversation_id
      WHERE c.channel = 'email' AND m.auto_sent = true AND m.created_at > now() - interval '1 hour'`)).rows[0];
  return (r && r.n) || 0;
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
  const verdicts = receipt.verdicts || null;
  const why = ignoreReason(msg, verdicts);
  // Bulk/marketing mail that starts a new conversation is not answered. The same signal inside a conversation we are
  // already having (someone replying to us) is held for a person instead of being dropped.
  let thread = null;
  if (why && SOFT_REASONS.has(why)) thread = await findThread(msg);
  if (why && !thread) return { status: 'ignored', reason: why };
  const holdFor = why || reviewReason(msg, verdicts);
  const messageId = msg.messageIdHeader ? String(msg.messageIdHeader).trim() : null;
  if (messageId) {
    const dup = (await db.query(`SELECT conversation_id FROM cs_messages WHERE direction = 'inbound' AND email_message_id = $1`, [messageId])).rows[0];
    if (dup) return { status: 'duplicate', conversation_id: dup.conversation_id };
  }
  // Layer 3: mail WITHOUT a Message-ID is deduplicated by a content fingerprint (same message via two routes).
  const fingerprint = messageId ? null : contentFingerprint(msg);
  if (fingerprint) {
    const dup = (await db.query(`SELECT conversation_id FROM cs_messages WHERE direction = 'inbound' AND email_message_id IS NULL AND content_fingerprint = $1`, [fingerprint])).rows[0];
    if (dup) return { status: 'duplicate', conversation_id: dup.conversation_id };
  }
  const fromEmail = conversations.normEmail(msg.fromEmail);
  let conv = thread || await findThread(msg);
  if (!conv) {
    const match = (await db.query(`SELECT id FROM users WHERE lower(email) = $1 OR lower(contact_email) = $1 LIMIT 1`, [fromEmail])).rows[0];
    conv = await conversations.createConversation({ channel: 'email', subject: msg.subject, customerEmail: fromEmail, customerName: msg.fromName,
      contactMatchUserId: match ? match.id : null });
  }
  let inbound;
  try {
    inbound = await conversations.addMessage(conv.id, { direction: 'inbound', author: 'customer', text: newText(msg) || '(no text)',
      emailMessageId: messageId, contentFingerprint: fingerprint, inReplyTo: msg.inReplyTo || null, references: msg.references || null, inboundReceiptId: receipt.id || null,
      attachments: (msg.attachments || []).slice(0, 20).map((a) => ({ name: a.filename || null, type: a.contentType || null, size: a.size || null })) });
  } catch (e) {
    if (e.code === '23505') return { status: 'duplicate', conversation_id: conv.id };
    throw e;
  }
  inbound.subject = msg.subject;
  conv = await conversations.get(conv.id);

  if (conv.owner === 'staff') return { status: 'received', conversation_id: conv.id, reply: 'staff_owned' };

  // Uncertain: kept for a person, never answered automatically. No instant alert (the 9:00 AM digest lists it).
  if (holdFor) {
    await conversations.requestHandoff(conv.id, { reasonCode: 'uncertain', createdBy: 'system', notify: false,
      reasonText: `Held for review, not answered automatically: ${REVIEW_LABELS[holdFor] || holdFor}.` });
    return { status: 'received', conversation_id: conv.id, reply: 'held_for_review', reason: holdFor };
  }

  const counts = await autoRepliesToSender(fromEmail);
  const globalHour = await autoRepliesLastHour();
  if (counts.h >= MAX_AUTO_PER_SENDER_PER_HOUR || counts.d >= MAX_AUTO_PER_SENDER_PER_DAY || conv.auto_reply_count >= MAX_AUTO_PER_CONVERSATION
      || globalHour >= MAX_AUTO_GLOBAL_PER_HOUR) {
    await conversations.requestHandoff(conv.id, { reasonCode: 'other', reasonText: 'Auto-reply limit reached for this sender (possible loop or flood) — please review.', createdBy: 'system' });
    return { status: 'received', conversation_id: conv.id, reply: 'rate_limited' };
  }

  const r = await engine.respond({ conversationId: conv.id, triggerMessageId: inbound.id, ctx: { channel: 'email', userId: null, customerName: msg.fromName } }, deps);
  if (r.outcome !== 'replied' && r.outcome !== 'handoff') {
    await conversations.requestHandoff(conv.id, { reasonCode: 'uncertain', reasonText: `Sasha could not answer automatically (${r.outcome}${r.budget ? ': daily budget' : ''}).`, createdBy: 'system' });
    return { status: 'received', conversation_id: conv.id, reply: r.outcome };
  }
  if ((r.outcome === 'replied' || r.outcome === 'handoff') && NOT_CUSTOMER_DRAFT.test(String(r.text || ''))) {
    await conversations.addMessage(conv.id, { direction: 'note', author: 'sasha', text: `Not sent (Sasha judged this was not a customer message):\n\n${r.text}` });
    await conversations.requestHandoff(conv.id, { reasonCode: 'uncertain', createdBy: 'system', notify: false,
      reasonText: `Held for review, not answered automatically: ${REVIEW_LABELS.not_customer_message}.` });
    return { status: 'received', conversation_id: conv.id, reply: 'held_for_review', reason: 'not_customer_message' };
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

/**
 * Sasha-initiated email (R-1 seller activation check-ins only; see sellerActivationService). Same From, Shared Inbox
 * reply path and loop guard as her replies, so the seller's answer threads onto the same conversation and staff can
 * take over. A follow-up in the same conversation replies to the previous check-in.
 */
async function sendActivationEmail(conv, subject, text, deps = {}) {
  const email = deps.emailService || require('../emailService');
  const last = (await db.query(`SELECT email_message_id, references_header FROM cs_messages WHERE conversation_id = $1 AND email_message_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`, [conv.id])).rows[0] || {};
  const refs = [...new Set([...idsFrom(last.references_header), ...idsFrom(last.email_message_id)])].slice(-10).join(' ');
  const body = String(text).trim() + SIGNATURE + `\n\nRef: ${conv.ref}`;
  if (/[—–]/.test(body + subject)) throw new Error('em dash in Sasha outbound text');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">'
    + body.split(/\n{2,}/).map((p) => '<p style="margin:0 0 12px">' + p.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
      .replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>') + '</p>').join('') + '</div>';
  return email.sendEmail({
    to: conv.customer_email, subject: last.email_message_id ? replySubject(conv, subject) : `${subject} [Ref ${conv.ref}]`, text: body, html,
    fromAddress: SUPPORT_FROM(), fromName: 'Sasha at Advantage.Bid', replyTo: SUPPORT_FROM(), mailStream: 'support',
    headers: {
      ...(last.email_message_id ? { 'In-Reply-To': last.email_message_id } : {}),
      ...(refs ? { References: refs } : {}),
      'Auto-Submitted': 'auto-generated',
      'X-Advantage-Sasha': conv.ref,
    },
  });
}

module.exports = { handleInbound, sendStaffEmail, sendActivationEmail, ignoreReason, reviewReason, authResults, findThread, newText, replySubject, contentFingerprint,
  SOFT_REASONS, LIMITS: { MAX_AUTO_PER_SENDER_PER_HOUR, MAX_AUTO_PER_SENDER_PER_DAY, MAX_AUTO_PER_CONVERSATION, MAX_AUTO_GLOBAL_PER_HOUR } };
