'use strict';

/**
 * Phone Sasha simulator (Super Admin tester and automated tests). Drives the REAL call path (ConversationRelay message
 * translator → PhoneCall → existing Sasha engine, tools, verification, audit, escalation) with provider 'simulated':
 *   - no telephone, no SMS, no Twilio: verification codes and texts go to an in-memory "handset" shown in the tester;
 *   - staff alerts are recorded, never sent;
 *   - every call, verification, session and disclosure is written and marked is_simulated (with who ran it).
 * Simulations do not need the phone switch (so the team can test while it is OFF) but use the same model budget caps.
 */

const crypto = require('crypto');
const db = require('../../../db');
const { RelaySession } = require('./adapters/conversationRelay');
const audit = require('./phoneAudit');
const verification = require('./verification');

const SIMS = new Map();   // callId → { relay, outbox, handset, alerts, actorId, startedAt }
const MAX_SIMS = 20;
const IDLE_MS = 30 * 60 * 1000;

function sweep() {
  for (const [id, s] of SIMS) if (Date.now() - s.touchedAt > IDLE_MS) { s.relay.close('simulation_idle').catch(() => {}); SIMS.delete(id); }
}

async function start({ actorId, callerNumber = null }, deps = {}) {
  sweep();
  if (SIMS.size >= MAX_SIMS) throw Object.assign(new Error('Too many simulated calls are open. End one first.'), { status: 429 });
  const sim = { outbox: [], handset: [], alerts: [], actorId, touchedAt: Date.now() };
  const send = (m) => sim.outbox.push(m);
  sim.relay = new RelaySession(send, { provider: 'simulated', simulatedBy: actorId,
    deps: { ...deps, handset: sim.handset, staffAlerts: sim.alerts,
      onTestCode: (code, last4) => sim.handset.push({ to_last4: last4, body: `Your Advantage.Bid verification code is ${code}. (simulation: shown only in this tester)`, at: new Date().toISOString(), kind: 'code' }) } });
  const r = await sim.relay.onMessage({ type: 'setup', callSid: 'SIM' + crypto.randomBytes(8).toString('hex'), from: callerNumber, to: '+15516557050' });
  if (!sim.relay.call) return { started: false, refused: r && (r.queued ? 'queue' : r.code) };
  SIMS.set(sim.relay.call.id, sim);
  return { started: true, call_id: sim.relay.call.id, ...(await state(sim.relay.call.id, actorId)) };
}

function own(callId, actorId) {
  const sim = SIMS.get(callId);
  if (!sim || sim.actorId !== actorId) throw Object.assign(new Error('Simulated call not found (or started by someone else).'), { status: 404 });
  sim.touchedAt = Date.now();
  return sim;
}

async function say(callId, actorId, text) {
  const sim = own(callId, actorId); const before = sim.outbox.length;
  await sim.relay.onMessage({ type: 'prompt', voicePrompt: String(text || '').slice(0, 2000), last: true });
  return { turn: sim.outbox.slice(before), ...(await state(callId, actorId)) };
}
async function keypad(callId, actorId, digits) {
  const sim = own(callId, actorId); const before = sim.outbox.length;
  for (const d of String(digits || '').replace(/[^0-9#*]/g, '').slice(0, 12)) await sim.relay.onMessage({ type: 'dtmf', digit: d });
  return { turn: sim.outbox.slice(before), ...(await state(callId, actorId)) };
}
async function interrupt(callId, actorId) {
  const sim = own(callId, actorId);
  await sim.relay.onMessage({ type: 'interrupt', utteranceUntilInterrupt: '' });
  return state(callId, actorId);
}
async function end(callId, actorId) {
  const sim = own(callId, actorId);
  await sim.relay.close('simulation_ended');
  const st = await state(callId, actorId);
  SIMS.delete(callId);
  return st;
}

/** Everything the tester shows: caller, verification, account, transcript, tools, disclosures, handoff, session, handset. */
async function state(callId, actorId) {
  const sim = SIMS.get(callId) || null;
  const call = (await db.query(`SELECT c.*, u.email AS verified_email, u.full_name AS verified_name, u.role AS verified_role,
      (SELECT seller_type FROM seller_profiles sp WHERE sp.user_id = c.verified_user_id) AS verified_seller_type
      FROM cs_calls c LEFT JOIN users u ON u.id = c.verified_user_id WHERE c.id = $1 AND c.is_simulated AND c.simulated_by = $2`, [callId, actorId])).rows[0];
  if (!call) throw Object.assign(new Error('Simulated call not found.'), { status: 404 });
  const session = call.status === 'in_progress' ? await verification.activeSession(call) : null;
  const messages = (await db.query(`SELECT direction, author_type, body_text, created_at FROM cs_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [call.conversation_id])).rows;
  const runs = (await db.query(`SELECT outcome, outcome_reason, tools_used, cost_micro_usd, latency_ms, created_at FROM cs_ai_runs WHERE conversation_id = $1 ORDER BY created_at`, [call.conversation_id])).rows;
  const handoffs = (await db.query(`SELECT reason_code, reason_text, status, callback_requested, callback_status, right(callback_phone_e164, 4) AS callback_last4, created_at
      FROM cs_handoffs WHERE conversation_id = $1 ORDER BY created_at`, [call.conversation_id])).rows;
  const conv = (await db.query(`SELECT ref, owner, handoff_state, status FROM cs_conversations WHERE id = $1`, [call.conversation_id])).rows[0];
  return {
    call: { id: call.id, ref: conv && conv.ref, status: call.status, caller_last4: call.caller_number_last4, started_at: call.started_at, ended_at: call.ended_at,
      duration_seconds: call.duration_seconds, interruptions: call.interruptions, card_data_redacted: call.card_data_redacted, summary: call.summary, owner: conv && conv.owner },
    verification: { state: call.verification_state },
    account: call.verified_user_id ? { email: call.verified_email, name: call.verified_name, role: call.verified_role, seller_type: call.verified_seller_type } : null,
    session: session ? { id: session.id, expires_at: session.expires_at } : null,
    transcript: messages, runs, handoffs, handoff_state: conv && conv.handoff_state,
    disclosures: await audit.forCall(call.id),
    handset: sim ? sim.handset : [], staff_alerts: sim ? sim.alerts : [],
    cost_usd: runs.reduce((s, r) => s + Number(r.cost_micro_usd || 0), 0) / 1e6,
  };
}

module.exports = { start, say, keypad, interrupt, end, state, SIMS };
