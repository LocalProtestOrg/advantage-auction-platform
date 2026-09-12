'use strict';

/**
 * escalationService — the human queue.
 *
 * Everything the system must not decide alone lands here: a legal or rights concern, an ambiguous
 * reply, a corrected website (which would re-scope permission), a disputed self-service request, a
 * Path D or Path E request from the trust ladder.
 *
 * Nothing in this table is ever auto-resolved. An item leaves the queue only when a named person
 * resolves or dismisses it, and the resolution is recorded. That is the point: an escalation is the
 * system saying "a person owns this now", and silently closing one would defeat it.
 *
 * Escalations are deduplicated on (thread, reason) while open, so a company that sends three
 * confusing replies produces one item to work rather than three.
 */

const db = require('../../db');
const auditService = require('../auditService');

const q = (client) => (client || db);

const SEVERITIES = Object.freeze(['low', 'normal', 'high']);

/** Open an escalation, or return the existing open one for the same thread and reason. */
async function open(input, client) {
  input = input || {};
  const severity = SEVERITIES.indexOf(input.severity) !== -1 ? input.severity : 'normal';

  if (input.threadId && input.reasonCode) {
    const existing = (await q(client).query(
      `SELECT * FROM event_partner_escalations
        WHERE thread_id = $1 AND reason_code = $2 AND status IN ('open','in_review') LIMIT 1`,
      [input.threadId, input.reasonCode])).rows[0];
    if (existing) {
      // Raise severity if this occurrence is worse than the last, but never lower it.
      if (SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(existing.severity)) {
        await q(client).query(
          'UPDATE event_partner_escalations SET severity = $2, updated_at = now() WHERE id = $1',
          [existing.id, severity]);
      }
      return existing;
    }
  }

  const { rows } = await q(client).query(
    `INSERT INTO event_partner_escalations
       (thread_id, message_id, authorization_id, request_id, reason_code, severity, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.threadId || null, input.messageId || null, input.authorizationId || null,
     input.requestId || null, input.reasonCode, severity, (input.summary || '').slice(0, 500) || null]);
  return rows[0];
}

async function list(opts, client) {
  opts = opts || {};
  const params = []; const where = [];
  if (opts.status) { params.push(opts.status); where.push(`e.status = $${params.length}`); }
  else where.push("e.status IN ('open','in_review')");
  if (opts.severity) { params.push(opts.severity); where.push(`e.severity = $${params.length}`); }
  params.push(Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200));
  const { rows } = await q(client).query(
    `SELECT e.*, t.reply_key, t.company_email, t.status AS thread_status,
            a.company_name, a.authorized_domain, a.status AS authorization_status,
            m.classification, m.classification_confidence, m.subject AS message_subject
       FROM event_partner_escalations e
       LEFT JOIN event_partner_threads t ON t.id = e.thread_id
       LEFT JOIN authorized_event_sources a ON a.id = e.authorization_id
       LEFT JOIN event_partner_messages m ON m.id = e.message_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE e.severity WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, e.created_at ASC
      LIMIT $${params.length}`, params);
  return rows;
}

async function claim(id, userId, client) {
  const { rows } = await q(client).query(
    `UPDATE event_partner_escalations
        SET status = 'in_review', assigned_to = $2, updated_at = now()
      WHERE id = $1 AND status = 'open' RETURNING *`, [id, userId]);
  return rows[0] || null;
}

/** Resolve or dismiss. A resolution note is required — "handled" with no account of what happened
 *  is exactly the audit gap escalations exist to prevent. */
async function close(id, input) {
  input = input || {};
  const outcome = input.outcome === 'dismissed' ? 'dismissed' : 'resolved';
  if (!input.actorId) {
    const e = new Error('An acting administrator is required.'); e.status = 401; e.code = 'ACTOR_REQUIRED'; e.expose = true; throw e;
  }
  if (!String(input.resolution || '').trim()) {
    const e = new Error('Say what was done.'); e.status = 400; e.code = 'RESOLUTION_REQUIRED'; e.expose = true; throw e;
  }
  const { rows } = await db.query(
    `UPDATE event_partner_escalations
        SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('open','in_review') RETURNING *`,
    [id, outcome, String(input.resolution).slice(0, 2000), input.actorId]);
  const row = rows[0] || null;
  if (row) {
    const client = await db.connect();
    try {
      await auditService.logEvent(client, {
        eventType: 'event_partner.escalation_' + outcome, entityType: 'event_partner_escalation',
        entityId: row.id, actorId: input.actorId,
        metadata: { reason_code: row.reason_code, thread_id: row.thread_id, severity: row.severity },
      });
    } catch (e) { /* audit best-effort */ } finally { client.release(); }
  }
  return row;
}

async function counts(client) {
  const { rows } = await q(client).query(
    `SELECT status, severity, count(*)::int n FROM event_partner_escalations GROUP BY 1,2`);
  return rows;
}

module.exports = { SEVERITIES, open, list, claim, close, counts };
