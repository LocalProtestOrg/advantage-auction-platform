'use strict';

/**
 * Phone escalation: a person instead of Sasha.
 *
 *   plan()            what happens when a person is needed. Live transfer is NOT wired in this release (no voice
 *                     provider), so the plan is always a callback; once a provider and an on-call list exist, the plan
 *                     can return { action: 'transfer' } during staffed hours and the adapter performs it.
 *   requestCallback() the existing handoff (cs_handoffs, Shared Inbox "Needs a person") plus the callback number and
 *                     a callback status, then a staff alert.
 *   alertStaff()      routes to the SUPPORT TEAM numbers (SASHA_PHONE_SUPPORT_ALERT_E164S), never to the owner by
 *                     default. Unset → the callback waits in the Shared Inbox only. Simulated calls never text anyone.
 */

const db = require('../../../db');
const conversations = require('../conversationService');
const audit = require('./phoneAudit');

function plan() {
  return { action: 'callback', transfer_available: false, reason: 'Live transfer is not enabled yet; the team calls back.' };
}

function supportNumbers() {
  return String(process.env.SASHA_PHONE_SUPPORT_ALERT_E164S || '').split(',').map((s) => s.trim()).filter((s) => /^\+1[2-9]\d{9}$/.test(s));
}

async function alertStaff(call, { kind, reason }, deps = {}) {
  const already = (await db.query(`SELECT 1 FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'staff_alerted' LIMIT 1`, [call.id])).rowCount;
  if (already) return { alerted: false, reason: 'already alerted for this call' };
  const conv = await conversations.get(call.conversation_id);
  const message = `Advantage.Bid phone ${kind === 'callback' ? 'callback requested' : 'call needs a person'} (Ref ${conv ? conv.ref : '-'}): ${String(reason || 'other').replace(/_/g, ' ')}. Open Customer Service to respond.`;
  if (call.is_simulated) {
    if (Array.isArray(deps.staffAlerts)) deps.staffAlerts.push({ message, to: 'support team (simulated, not sent)' });
    await audit.record(call, 'staff_alerted', { detail: { outcome: 'simulated: not sent', team: 'support' } });
    return { alerted: false, simulated: true, message };
  }
  const to = supportNumbers();
  if (!to.length) {
    await audit.record(call, 'staff_alerted', { detail: { outcome: 'no support team number configured; Shared Inbox only', team: 'support' } });
    return { alerted: false, reason: 'no support number configured' };
  }
  const sms = deps.smsService || require('../../smsService');
  let sent = 0;
  for (const n of to) { try { await sms.sendSMS({ to: n, message }); sent++; } catch (e) { console.error('[sasha-phone] staff alert failed', e.message); } }
  await audit.record(call, 'staff_alerted', { detail: { outcome: sent ? 'sent' : 'failed', count: sent, team: 'support' } });
  return { alerted: sent > 0 };
}

/** Callback request: an open handoff with the callback number, visible in the Shared Inbox. */
async function requestCallback(call, { number, reason, summary, userId }, deps = {}) {
  const r = String(reason || 'customer_request');
  await conversations.requestHandoff(call.conversation_id, { reasonCode: r, reasonText: String(summary || '').slice(0, 1000) || 'Callback requested by phone.',
    createdBy: r === 'customer_request' ? 'customer' : 'sasha' });
  await db.query(`UPDATE cs_handoffs SET callback_requested = true, callback_phone_e164 = $2, callback_status = 'open'
     WHERE id = (SELECT id FROM cs_handoffs WHERE conversation_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1)`, [call.conversation_id, number]);
  await audit.record(call, 'callback_requested', { accountUserId: userId || null, detail: { reason: r, destination_last4: String(number).slice(-4) } });
  const alert = await alertStaff(call, { kind: 'callback', reason: r }, deps);
  return { callback: true, plan: plan(), alert };
}

/** Sasha's own request_human during a call (handoff already recorded by the engine): alert the team once. */
async function onEngineHandoff(call, handoff, deps = {}) {
  await audit.record(call, 'handoff_requested', { detail: { reason: handoff && handoff.reason } });
  return alertStaff(call, { kind: 'handoff', reason: handoff && handoff.reason }, deps);
}

module.exports = { plan, requestCallback, onEngineHandoff, alertStaff, supportNumbers };
