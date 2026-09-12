'use strict';

/**
 * cohortService — approved cohorts, approved template versions, and the hard send gate.
 *
 * The Owner's requirement, made mechanical: no real prospect may receive outreach unless
 *   1. the recipient is in an explicitly approved cohort,            AND
 *   2. event_partners.outreach_enabled is ON,                        AND
 *   3. the message template version is approved,                     AND
 *   4. send-time suppression and deliverability rules pass.
 *
 * All four are checked by `evaluateSend` at SEND time, not at queue time. A recipient who unsubscribes
 * after being queued is still skipped, because the check happens at the last possible moment.
 *
 * Policy is not a gate; a table is. Containment lives in `event_partner_cohort_members`: an address
 * that is not a row in an approved, unexpired cohort cannot be sent to, however a caller is written.
 *
 * The forward path the Owner asked for is `cohorts.autonomous_allowed`. It defaults FALSE, so the
 * pilot stays human-approved per cohort. When the Owner later flips it on a proven cohort, the
 * Director may operate that cohort without per-company approval — and every other lock still applies.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const configService = require('../configService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const suppression = require('./partnerSuppressionService');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}
const q = (client) => (client || db);

// ── Templates ───────────────────────────────────────────────────────────────────────────────────

/**
 * Create a template version. Always 'draft'. A new version is created rather than editing an existing
 * one, so an approved template can never be altered after approval without losing its approval.
 */
async function createTemplateVersion(input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (!input.templateKey || !input.subject || !input.bodyText) {
    throw err(400, 'TEMPLATE_INCOMPLETE', 'A template needs a key, a subject and body text.');
  }
  return withTransaction(async (client) => {
    const next = (await client.query(
      'SELECT COALESCE(max(version), 0) + 1 AS v FROM event_partner_templates WHERE template_key = $1',
      [input.templateKey])).rows[0].v;
    const { rows } = await client.query(
      `INSERT INTO event_partner_templates
         (template_key, version, purpose, subject, body_text, body_html, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8) RETURNING *`,
      [input.templateKey, next, input.purpose || 'initial_outreach', input.subject,
       input.bodyText, input.bodyHtml || null, input.notes || null, input.actorId]);
    await auditService.logEvent(client, {
      eventType: 'event_partner.template_created', entityType: 'event_partner_template', entityId: rows[0].id,
      actorId: input.actorId, metadata: { template_key: input.templateKey, version: next, purpose: rows[0].purpose },
    });
    return rows[0];
  });
}

/** Approve a template version. This is the act that makes it usable by a cohort. */
async function approveTemplate(templateId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  return withTransaction(async (client) => {
    const t = (await client.query(
      'SELECT * FROM event_partner_templates WHERE id = $1 FOR UPDATE', [templateId])).rows[0];
    if (!t) throw err(404, 'NOT_FOUND', 'Template not found.');
    if (t.status === 'approved') return t;
    if (t.status === 'retired') throw err(409, 'RETIRED', 'A retired template cannot be approved.');
    const { rows } = await client.query(
      `UPDATE event_partner_templates SET status = 'approved', approved_by = $2, approved_at = now(),
              updated_at = now() WHERE id = $1 RETURNING *`, [templateId, input.actorId]);
    await auditService.logEvent(client, {
      eventType: 'event_partner.template_approved', entityType: 'event_partner_template', entityId: templateId,
      actorId: input.actorId, metadata: { template_key: t.template_key, version: t.version },
    });
    return rows[0];
  });
}

async function listTemplates(client) {
  const { rows } = await q(client).query(
    `SELECT id, template_key, version, purpose, subject, status, approved_by, approved_at, created_at
       FROM event_partner_templates ORDER BY template_key ASC, version DESC`);
  return rows;
}

// ── Cohorts ─────────────────────────────────────────────────────────────────────────────────────

async function createCohort(input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (!String(input.name || '').trim()) throw err(400, 'NAME_REQUIRED', 'A cohort needs a name.');
  const { rows } = await db.query(
    `INSERT INTO event_partner_cohorts
       (name, description, max_sends, daily_send_cap, expires_at, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [String(input.name).slice(0, 160), input.description || null,
     input.maxSends != null ? Math.min(Math.max(parseInt(input.maxSends, 10) || 0, 1), 500) : 25,
     input.dailySendCap != null ? Math.min(Math.max(parseInt(input.dailySendCap, 10) || 0, 1), 100) : 10,
     input.expiresAt || null, input.notes || null, input.actorId]);
  return rows[0];
}

/**
 * Approve a cohort. Requires an APPROVED template version and an expiry — an approval that never
 * lapses is how a pilot silently becomes a standing permission.
 */
async function approveCohort(cohortId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (!input.templateId) throw err(400, 'TEMPLATE_REQUIRED', 'Approving a cohort requires an approved template version.');
  return withTransaction(async (client) => {
    const c = (await client.query('SELECT * FROM event_partner_cohorts WHERE id = $1 FOR UPDATE', [cohortId])).rows[0];
    if (!c) throw err(404, 'NOT_FOUND', 'Cohort not found.');
    if (c.status !== 'draft') throw err(409, 'NOT_DRAFT', `Only a draft cohort can be approved (status: ${c.status}).`);
    const t = (await client.query('SELECT * FROM event_partner_templates WHERE id = $1', [input.templateId])).rows[0];
    if (!t) throw err(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
    if (t.status !== 'approved') throw err(409, 'TEMPLATE_NOT_APPROVED', 'That template version is not approved.');

    const expires = input.expiresAt || c.expires_at
      || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);   // a pilot approval lapses by default
    const { rows } = await client.query(
      `UPDATE event_partner_cohorts
          SET status = 'approved', template_id = $2, approved_by = $3, approved_at = now(),
              expires_at = $4, updated_at = now()
        WHERE id = $1 RETURNING *`, [cohortId, input.templateId, input.actorId, expires]);
    await auditService.logEvent(client, {
      eventType: 'event_partner.cohort_approved', entityType: 'event_partner_cohort', entityId: cohortId,
      actorId: input.actorId,
      metadata: { template_id: input.templateId, template_key: t.template_key, template_version: t.version,
        max_sends: c.max_sends, expires_at: expires },
    });
    return rows[0];
  });
}

/** Add a recipient to a cohort. Refused once the cohort is approved — membership is part of what
 *  was approved, so it cannot grow afterwards without a new approval. */
async function addMember(cohortId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const normalized = normalizeEmail(input.recipientEmail);
  if (!normalized) throw err(400, 'INVALID_EMAIL', 'A valid recipient email is required.');
  return withTransaction(async (client) => {
    const c = (await client.query('SELECT * FROM event_partner_cohorts WHERE id = $1 FOR UPDATE', [cohortId])).rows[0];
    if (!c) throw err(404, 'NOT_FOUND', 'Cohort not found.');
    if (c.status !== 'draft') throw err(409, 'COHORT_LOCKED', 'Membership is fixed once a cohort is approved.');
    const { rows } = await client.query(
      `INSERT INTO event_partner_cohort_members
         (cohort_id, authorization_id, organization_id, recipient_email, recipient_email_normalized, added_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cohort_id, recipient_email_normalized) DO NOTHING
       RETURNING *`,
      [cohortId, input.authorizationId || null, input.organizationId || null,
       input.recipientEmail, normalized, input.actorId]);
    return rows[0] || null;
  });
}

async function listCohorts(client) {
  const { rows } = await q(client).query(
    `SELECT c.*, t.template_key, t.version AS template_version, t.status AS template_status,
            (SELECT count(*)::int FROM event_partner_cohort_members m WHERE m.cohort_id = c.id) AS member_count,
            (SELECT count(*)::int FROM event_partner_cohort_members m WHERE m.cohort_id = c.id AND m.status = 'sent') AS sent_count
       FROM event_partner_cohorts c
       LEFT JOIN event_partner_templates t ON t.id = c.template_id
      ORDER BY c.created_at DESC LIMIT 100`);
  return rows;
}

async function getCohort(cohortId, client) {
  const { rows } = await q(client).query(
    `SELECT c.*, t.template_key, t.version AS template_version, t.status AS template_status,
            t.subject AS template_subject
       FROM event_partner_cohorts c
       LEFT JOIN event_partner_templates t ON t.id = c.template_id
      WHERE c.id = $1`, [cohortId]);
  return rows[0] || null;
}

// ── The send gate ───────────────────────────────────────────────────────────────────────────────

/**
 * evaluateSend({ cohortId, recipientEmail }) → { allowed, locks, blockedBy[] }
 *
 * The single decision point every send path must pass through. It NEVER sends anything; it returns
 * whether a send would be permitted and, if not, exactly which lock refused. A caller that skips this
 * function is a bug, and the test suite asserts no send path exists that bypasses it.
 *
 * In Phase 2A `outreach_enabled` is false in production, so this function's honest answer is always
 * "no" — which is the intended state.
 */
async function evaluateSend(input, client) {
  input = input || {};
  const blockedBy = [];
  const locks = {};

  // Lock 2: the Owner's platform gate (checked first; cheapest and most decisive).
  locks.outreach_enabled = (await configService.get(null, 'event_partners.outreach_enabled')) === true;
  if (!locks.outreach_enabled) blockedBy.push('outreach_disabled');

  // Lock 1: approved, unexpired cohort containing this exact recipient.
  const normalized = normalizeEmail(input.recipientEmail);
  locks.recipient_valid = !!normalized;
  if (!normalized) blockedBy.push('invalid_recipient');

  let cohort = null; let member = null;
  if (input.cohortId) cohort = await getCohort(input.cohortId, client);
  locks.cohort_exists = !!cohort;
  if (!cohort) blockedBy.push('no_cohort');

  if (cohort) {
    locks.cohort_approved = ['approved', 'active'].indexOf(cohort.status) !== -1;
    if (!locks.cohort_approved) blockedBy.push('cohort_not_approved');

    locks.cohort_unexpired = !cohort.expires_at || new Date(cohort.expires_at).getTime() > Date.now();
    if (!locks.cohort_unexpired) blockedBy.push('cohort_expired');

    // Lock 3: an approved template VERSION.
    locks.template_approved = cohort.template_status === 'approved';
    if (!locks.template_approved) blockedBy.push('template_not_approved');

    locks.within_cohort_cap = (cohort.sends_used || 0) < (cohort.max_sends || 0);
    if (!locks.within_cohort_cap) blockedBy.push('cohort_send_cap_reached');

    if (normalized) {
      member = (await q(client).query(
        `SELECT * FROM event_partner_cohort_members
          WHERE cohort_id = $1 AND recipient_email_normalized = $2`, [cohort.id, normalized])).rows[0] || null;
      locks.recipient_in_cohort = !!member;
      if (!member) blockedBy.push('recipient_not_in_cohort');
      else {
        locks.recipient_not_already_sent = member.status !== 'sent';
        if (member.status === 'sent') blockedBy.push('already_sent');
      }
    }
  }

  // Lock 4: send-time suppression, across BOTH the partner and the global lists.
  if (normalized) {
    const sup = await suppression.isSuppressed(normalized, client);
    locks.not_suppressed = !sup.suppressed;
    if (sup.suppressed) blockedBy.push('suppressed:' + sup.scope + ':' + sup.reason);
  }

  // A platform-wide daily ceiling, independent of any cohort's own cap.
  const ceiling = Number(await configService.get(null, 'event_partners.daily_send_ceiling')) || 25;
  const sentToday = (await q(client).query(
    `SELECT count(*)::int n FROM event_partner_cohort_members
      WHERE status = 'sent' AND sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`)).rows[0].n;
  locks.within_daily_ceiling = sentToday < ceiling;
  if (!locks.within_daily_ceiling) blockedBy.push('daily_ceiling_reached');

  return {
    allowed: blockedBy.length === 0,
    locks, blockedBy,
    cohort: cohort ? { id: cohort.id, name: cohort.name, status: cohort.status } : null,
    member: member ? { id: member.id, status: member.status } : null,
    // Stated plainly so a caller cannot mistake a dry-run for a send.
    note: 'evaluateSend never sends; it only reports whether a send would be permitted.',
  };
}

module.exports = {
  createTemplateVersion, approveTemplate, listTemplates,
  createCohort, approveCohort, addMember, listCohorts, getCohort,
  evaluateSend,
};
