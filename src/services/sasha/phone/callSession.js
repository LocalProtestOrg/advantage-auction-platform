'use strict';

/**
 * PhoneCall: the provider-neutral core of Phone Sasha. A voice adapter (Twilio ConversationRelay, Retell, or the
 * simulator) translates its provider's events into these calls and sends `speak` output back as audio/text:
 *
 *   PhoneCall.start({ provider, providerCallId, callerNumber, calledNumber, simulated, simulatedBy })
 *   call.utterance(text)    caller speech (final transcript) → redaction → code check → Sasha → speech
 *   call.keypad(digits)     DTMF (a verification code typed on the keypad)
 *   call.interrupt()        barge-in: stop generating; what was already spoken stands
 *   call.end(reason)        hang-up: session ends, summary written, transcript retention set
 *
 * Sasha's brain is the existing engine (respondStream) with the existing tools and rules; this layer adds only what a
 * call needs: verification state, the scoped session, transcript redaction, budgets and escalation.
 * Real calls require sasha.phone.enabled + a provider; this release mounts no provider route, so only simulations run.
 */

const db = require('../../../db');
const conversations = require('../conversationService');
const engine = require('../engine');
const phoneSettings = require('./phoneSettings');
const verification = require('./verification');
const audit = require('./phoneAudit');
const escalation = require('./escalation');
const { cleanUtterance } = require('./redaction');
const { normalizeUsPhone, last4, identifierHash } = require('../../../lib/phoneNumber');

const GREETING_FOLLOW = 'How can I help you today?';
const FALLBACK = 'I\'m sorry, I can\'t look that up right now. I can have a member of our team call you back. Would that help?';
const STAFF_OWNED = 'Thanks. A member of our team is handling your request and will follow up with you.';
const RECOVERY = 'I\'m sorry, I\'m having trouble pulling that up right now. I can try again, or I can take a message for the team.';
const ACTIVE = new Map();   // callId → PhoneCall (this process)

/** The caller's menu choice, as call context for Sasha (a likely purpose, not a restriction: they may ask anything). */
const ROUTING = {
  buyer: 'MENU CHOICE: the caller pressed 1 (BUYER). Be ready for bidding, auctions, watchlist, invoices, payments and secure payment links, account questions, purchase status, pickup (after verification) and how buying works.',
  seller: 'MENU CHOICE: the caller pressed 2 (SELLER). Be ready for how selling works, Individual and Professional Seller questions, seller onboarding, creating auctions, listings, the fees you are allowed to explain, seller account and navigation questions, and taking a message for the team when staff are needed. Never quote a Professional Seller platform rate as a standard public rate.',
  pickup: 'MENU CHOICE: the caller pressed 3 (RECENT PURCHASE / PICKUP). They most likely need post-purchase help: finding the invoice or purchase, payment status, a secure payment link, pickup dates and times, and the pickup address (only after verification and only if paid, as the tools allow).',
  other: 'MENU CHOICE: the caller pressed 4 (OTHER) or made no choice. Find out conversationally what they need and help.',
};

class PhoneCallError extends Error { constructor(code, message) { super(message); this.code = code; } }

class PhoneCall {
  constructor(row, deps) { this.row = row; this.deps = deps || {}; this.abort = null; this.busy = false; this.lastVerification = null; this.lastCheck = null; this.cardJustRedacted = false; }

  get id() { return this.row.id; }

  static async start({ provider, providerCallId, callerNumber = null, calledNumber = null, simulated = false, simulatedBy = null, routingReason = null,
    greetingSpokenByProvider = false }, deps = {}) {
    const s = await phoneSettings.load();
    if (!simulated && !(await phoneSettings.liveCallsAllowed())) throw new PhoneCallError('PHONE_DISABLED', 'Phone Sasha is switched off.');
    if (simulated && provider !== 'simulated') throw new PhoneCallError('BAD_PROVIDER', 'Simulations use the simulated provider.');
    const active = Number((await db.query(`SELECT count(*)::int n FROM cs_calls WHERE status = 'in_progress' AND is_simulated = $1`, [!!simulated])).rows[0].n);
    if (active >= s.max_concurrent_calls) return { queued: true, reason: 'All of Sasha\'s lines are busy; the caller waits in the queue.', active, limit: s.max_concurrent_calls };
    const caller = normalizeUsPhone(callerNumber);
    const conv = await conversations.createConversation({ channel: 'phone', subject: simulated ? 'Phone call (simulation)' : 'Phone call' });
    const reason = ROUTING[routingReason] ? routingReason : null;
    const row = (await db.query(`INSERT INTO cs_calls (conversation_id, provider, provider_call_id, is_simulated, simulated_by, caller_number_hash, caller_number_last4, called_number, routing_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [conv.id, provider, String(providerCallId).slice(0, 120), !!simulated, simulatedBy, caller.e164 ? identifierHash(caller.e164) : null, caller.e164 ? last4(caller.e164) : null,
      calledNumber ? String(calledNumber).slice(0, 20) : null, reason])).rows[0];
    const call = new PhoneCall(row, deps);
    call.callerE164 = caller.e164 || null;
    ACTIVE.set(row.id, call);
    await audit.record(row, 'call_started', { detail: { provider, routing_reason: reason } });
    // Owner direction (2026-10-08): Sasha greets as an Advantage.Bid representative; no assistant-type announcement.
    const greeting = s.greeting || GREETING_FOLLOW;
    await conversations.addMessage(conv.id, { direction: 'outbound', author: 'sasha', text: greeting, autoSent: true });
    if (call.deps.onSpeak && !greetingSpokenByProvider) call.deps.onSpeak(greeting, { kind: 'greeting' });
    return { call, greeting, conversationId: conv.id };
  }

  static get(callId) { return ACTIVE.get(callId) || null; }
  static activeCount() { return ACTIVE.size; }

  async refresh() { this.row = (await db.query(`SELECT * FROM cs_calls WHERE id = $1`, [this.id])).rows[0]; return this.row; }

  callState(session) {
    const lines = [];
    const st = this.row.verification_state;
    if (session) lines.push(`Caller verification: VERIFIED for this call (session ends ${new Date(session.expires_at).toISOString()}). Account tools are available.`);
    else if (st === 'expired') lines.push('Caller verification: the verified session EXPIRED. Account tools are unavailable; offer to verify again with start_account_verification.');
    else if (st === 'code_sent') lines.push('Caller verification: a code may have been texted (you were not told whether an account matched). Waiting for the caller to read it.');
    else lines.push('Caller verification: NOT verified. Account tools are unavailable.');
    if (this.lastCheck) {
      const c = this.lastCheck;
      lines.push(c.ok ? 'The code the caller just read was CORRECT: they are now verified. Briefly confirm and continue helping.'
        : c.reason === 'expired' ? 'The code the caller read has EXPIRED. Offer to send a new one (start_account_verification) or to take a message for the team.'
          : c.reason === 'too_many_attempts' ? 'Too many wrong codes: verification is LOCKED on this request. Do not try again; offer to take a message for the team (request_callback).'
            : c.reason === 'no_code_requested' ? 'The caller read digits but no code was requested. Ask what they need.'
              : `The code the caller read did NOT match. They can try again (${c.attemptsLeft} tries left) or you can send a new code.`);
    }
    if (this.cardJustRedacted) lines.push('The caller just started reading payment card details. They were removed and not stored. Politely stop them and explain the secure alternative.');
    if (this.row.routing_reason && ROUTING[this.row.routing_reason]) lines.push(ROUTING[this.row.routing_reason]);
    lines.push('There is no live transfer to staff. Help with everything you are able to; if the caller still wants a person, or the matter genuinely needs staff, take a message for the team (request_callback).');
    return lines.join('\n');
  }

  async utterance(rawText, opts = {}) {
    await this.refresh();
    if (!this.row || this.row.status !== 'in_progress') throw new PhoneCallError('CALL_ENDED', 'This call has ended.');
    if (this.busy) this.interrupt();   // a new final utterance while Sasha is talking = barge-in
    this.busy = true;
    const ac = new AbortController(); this.abort = ac;
    const spoken = [];
    const speak = (t, meta) => { spoken.push({ text: t, kind: meta.kind }); if (this.deps.onSpeak) this.deps.onSpeak(t, meta); };
    try {
      const expectCode = this.row.verification_state === 'code_sent';
      const clean = opts.keypadCode ? { text: '[verification code entered on the keypad]', code: opts.keypadCode, cardDetected: false } : cleanUtterance(rawText, { expectCode });
      this.cardJustRedacted = !!clean.cardDetected;
      if (clean.cardDetected) {
        await db.query(`UPDATE cs_calls SET card_data_redacted = card_data_redacted + 1 WHERE id = $1`, [this.id]);
        await audit.record(this.row, 'card_data_redacted', {});
      }
      const inbound = await conversations.addMessage(this.row.conversation_id, { direction: 'inbound', author: 'customer', text: clean.text || '(silence)' });
      this.lastCheck = null;
      if (clean.code) {
        this.lastCheck = await verification.check(this.row, clean.code, this.deps);
        await this.refresh();
      }
      const conv = await conversations.get(this.row.conversation_id);
      if (conv.owner === 'staff') { speak(STAFF_OWNED, { kind: 'speech' }); await this.addReply(STAFF_OWNED); return this.turnResult(spoken); }

      const session = await verification.activeSession(this.row);
      await this.refresh();
      const s = await phoneSettings.load();
      const ctx = { channel: 'phone', userId: session ? session.user_id : null,
        phone: { call: this.row, sessionId: session ? session.id : null, callerE164: this.callerE164, deps: this.deps,
          onVerification: (r) => { this.lastVerification = r; }, onHandoff: (r) => { this.lastHandoff = r; } } };
      const r = await engine.respondStream({ conversationId: this.row.conversation_id, triggerMessageId: inbound.id, ctx, callState: this.callState(session),
        onSpeak: speak, signal: ac.signal, limits: { dailyUsd: s.daily_budget_usd, perCallUsd: s.per_call_budget_usd } }, this.deps);
      this.lastResult = r;
      if ((r.outcome === 'replied' || r.outcome === 'handoff') && r.text) {
        await this.addReply(r.text, r.runId);
        if (r.handoff) await escalation.onEngineHandoff(this.row, r.handoff, this.deps);
      } else if (r.outcome === 'skipped' || r.outcome === 'error' || !r.text) {
        if (r.budget) await audit.record(this.row, 'budget_stopped', { detail: { reason: r.budget } });
        if (r.outcome === 'error') await conversations.requestHandoff(this.row.conversation_id, { reasonCode: 'uncertain', reasonText: 'Sasha could not answer on the phone (' + (r.error || r.outcome) + ').', createdBy: 'system' });
        // Never leave the caller in silence: after an error the recovery line is ALWAYS spoken, even if a progress
        // phrase already played; otherwise the fallback is spoken when nothing at all was said. Both are saved.
        const extra = r.outcome === 'error' ? RECOVERY : (r.text ? '' : FALLBACK);
        if (extra) { speak(extra, { kind: 'speech' }); await this.addReply(((r.text || '') + ' ' + extra).trim(), r.runId); }
      }
      this.cardJustRedacted = false;
      return this.turnResult(spoken, r);
    } finally { if (this.abort === ac) { this.busy = false; this.abort = null; } }
  }

  async keypad(digits) {
    const d = String(digits || '').replace(/\D/g, '');
    if (d.length !== require('../../../lib/verificationCode').CODE_LENGTH) return this.utterance(d.length ? '[keypad: ' + d.length + ' digits]' : '(keypad)');
    return this.utterance('', { keypadCode: d });
  }

  interrupt() {
    if (this.abort && !this.abort.signal.aborted) {
      this.abort.abort();
      db.query(`UPDATE cs_calls SET interruptions = interruptions + 1 WHERE id = $1`, [this.id]).catch(() => {});
      return true;
    }
    return false;
  }

  async addReply(text, runId) {
    const reply = await conversations.addSashaReply(this.row.conversation_id, { text, autoSent: true });
    if (!reply.blocked && runId) await db.query(`UPDATE cs_ai_runs SET reply_message_id = $2 WHERE id = $1`, [runId, reply.id]);
  }

  async turnResult(spoken, r) {
    await this.refresh();
    const session = await verification.activeSession(this.row);
    return { spoken, tools: (r && r.tools) || [], outcome: r ? r.outcome : 'replied', interrupted: !!(r && r.interrupted), budget: r ? r.budget || null : null,
      verification: { state: this.row.verification_state, last_check: this.lastCheck ? { ok: this.lastCheck.ok, reason: this.lastCheck.reason || null, attempts_left: this.lastCheck.attemptsLeft } : null },
      session: session ? { id: session.id, user_id: session.user_id, expires_at: session.expires_at } : null, handoff: r && r.handoff ? r.handoff : null };
  }

  async end(reason = 'caller_hung_up') {
    if (this.abort) this.interrupt();
    await this.refresh();
    if (!this.row || this.row.status !== 'in_progress') { ACTIVE.delete(this.id); return this.row; }
    await verification.endSession(this.row, 'call_ended');
    const s = await phoneSettings.load();
    const summary = await buildSummary(this.row);
    const openHandoff = (await db.query(`SELECT 1 FROM cs_handoffs WHERE conversation_id = $1 AND status = 'open' LIMIT 1`, [this.row.conversation_id])).rowCount;
    this.row = (await db.query(`UPDATE cs_calls SET status = 'completed', ended_at = now(), end_reason = $2, summary = $3,
        duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM now() - started_at))::int, transcript_purge_after = now() + ($4 || ' days')::interval
      WHERE id = $1 RETURNING *`, [this.id, String(reason).slice(0, 60), summary, String(s.transcript_retention_days)])).rows[0];
    await conversations.addMessage(this.row.conversation_id, { direction: 'note', author: 'system', text: 'Call summary: ' + summary });
    if (!openHandoff) await conversations.setStatus(this.row.conversation_id, 'resolved').catch(() => {});
    await audit.record(this.row, 'call_ended', { detail: { end_reason: reason } });
    ACTIVE.delete(this.id);
    return this.row;
  }
}

const TOOL_TOPICS = { get_my_invoices: 'invoices', get_my_bids: 'bids', get_my_pickup_details: 'pickup', get_my_pickup_slots: 'pickup times', get_my_orders: 'storefront orders',
  get_my_order_detail: 'storefront order', get_my_auctions: 'seller auctions', get_my_settlements: 'payouts', get_my_seller_terms: 'seller fees',
  get_my_seller_onboarding: 'seller onboarding', get_my_business_verification: 'business verification', get_my_agreements: 'agreements',
  get_my_auction_registration: 'auction registration', get_auction_or_lot: 'auction/lot lookup', find_auction: 'auction search', search_help_center: 'help center',
  get_platform_rules: 'platform rules', send_text: 'text message', request_callback: 'callback', start_account_verification: 'verification' };

/** Non-sensitive summary kept after the transcript is purged: what happened, never what was disclosed. */
async function buildSummary(call) {
  const runs = (await db.query(`SELECT tools_used FROM cs_ai_runs WHERE conversation_id = $1`, [call.conversation_id])).rows;
  const topics = [...new Set(runs.flatMap((r) => r.tools_used || []).map((t) => TOOL_TOPICS[t]).filter(Boolean))];
  const h = (await db.query(`SELECT reason_code, callback_requested FROM cs_handoffs WHERE conversation_id = $1 ORDER BY created_at`, [call.conversation_id])).rows;
  const secs = Math.max(0, Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000));
  const parts = [`${Math.floor(secs / 60)} min ${secs % 60} s`, call.verification_state === 'verified' || call.verified_user_id ? 'caller verified' : 'caller not verified'];
  if (topics.length) parts.push('topics: ' + topics.join(', '));
  if (h.length) parts.push((h.some((x) => x.callback_requested) ? 'callback requested' : 'handed to the team') + ' (' + [...new Set(h.map((x) => x.reason_code.replace(/_/g, ' ')))].join(', ') + ')');
  if (call.card_data_redacted) parts.push(`card details removed ${call.card_data_redacted} time(s)`);
  if (call.is_simulated) parts.push('simulation');
  return parts.join('; ') + '.';
}

module.exports = { PhoneCall, PhoneCallError, buildSummary, ACTIVE, FALLBACK, RECOVERY, GREETING_FOLLOW, ROUTING };
