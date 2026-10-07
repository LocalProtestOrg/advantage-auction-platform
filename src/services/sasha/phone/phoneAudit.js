'use strict';

/**
 * Phone disclosure audit (cs_phone_audit, migration 188): who was verified, which account was accessed, which
 * sensitive tool ran, what was disclosed or refused, when, and which call/conversation caused it.
 *
 * `detail` holds REFERENCES ONLY (invoice numbers, auction ids, counts, outcome labels). It must never contain a
 * verification code, card data, a street address or free text from the caller; sanitizeDetail() enforces that.
 * Writing is best-effort for read events (a failed audit write is logged loudly) but the caller can require it.
 */

const db = require('../../../db');

const ALLOWED_KEYS = new Set(['invoices', 'auction_ids', 'order_numbers', 'count', 'status', 'reason', 'level', 'provider', 'attempts_left',
  'identifier_type', 'destination_last4', 'what', 'channel', 'end_reason', 'outcome', 'expires_at', 'categories', 'team', 'plan', 'spent_usd', 'limit_usd',
  'lot_count', 'stage', 'blocker', 'verification', 'agreements', 'registered', 'slot_count']);

function sanitizeDetail(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (v == null || typeof v === 'boolean' || typeof v === 'number') out[k] = v;
    else if (typeof v === 'string') out[k] = v.replace(/\d{5,}/g, '[digits]').slice(0, 120);
    else if (Array.isArray(v)) out[k] = v.slice(0, 25).map((x) => String(x).slice(0, 60));
  }
  return out;
}

async function record(call, event, { tool = null, category = null, accountUserId = null, sessionId = null, detail = {} } = {}, runner = db) {
  try {
    await runner.query(
      `INSERT INTO cs_phone_audit (call_id, conversation_id, phone_session_id, account_user_id, is_simulated, actor_user_id, event_type, tool, data_category, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [call.id, call.conversation_id, sessionId, accountUserId, !!call.is_simulated, call.simulated_by || null, event, tool, category, JSON.stringify(sanitizeDetail(detail))]);
    return true;
  } catch (e) { console.error('[sasha-phone] AUDIT WRITE FAILED', event, e.message); return false; }
}

async function forCall(callId, runner = db) {
  return (await runner.query(`SELECT event_type, tool, data_category, detail, account_user_id, phone_session_id, created_at
    FROM cs_phone_audit WHERE call_id = $1 ORDER BY created_at, id`, [callId])).rows;
}

module.exports = { record, forCall, sanitizeDetail, ALLOWED_KEYS };
