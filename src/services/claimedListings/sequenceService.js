'use strict';

/**
 * sequenceService — cohorts and the per-company sequence (handoff sections 5 and 11).
 *
 *   E1 at approval · E2 at +6 days (E2_CLICKED instead, 2 days after a human visit without a claim) ·
 *   E3 at +14 days · then DORMANT for 180 days · one E4_REFRESH (cycle 2) · then permanent stop.
 *   Three emails per cycle, never more. Each step issues a new claim link.
 *
 * Cohorts are the Owner's send lock: a Director or staff member may PROPOSE a cohort (draft); only a
 * Super Admin approves it, and only with approved template versions bound. autonomous_allowed stays false.
 *
 * `tick` is idempotent and safe to run every 10 minutes. With claimed_listings.sending_enabled = false it
 * sends nothing: sends are attempted only through outreachSender, which re-checks every gate.
 * `shadowRun` renders a cohort and evaluates every gate with NO send, NO token and NO message row.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const listingContext = require('./listingContext');
const eligibility = require('./eligibilityService');
const scoring = require('./scoringService');
const sender = require('./outreachSender');
const locks = require('../acquisition/contactLockService');
const identity = require('../acquisition/companyIdentityService');

const DAY = 86400000;
const STEP_KEYS = { 1: 'E1', 3: 'E3', 4: 'E4_REFRESH' };   // step 2 = E2_NOCLICK | E2_CLICKED
const REQUIRED_TEMPLATES = ['E1', 'E2_NOCLICK', 'E2_CLICKED', 'E3'];

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }

// ── cohorts ───────────────────────────────────────────────────────────────────────────────────

/**
 * Propose a cohort: ELIGIBLE listings only, strategic markets first, then by score. Draft; sends nothing.
 */
async function proposeCohort({ name, size = null, markets = ['houston', 'ny_tristate'], actorId = null, repUserId = null } = {}, runner = db) {
  const maxCfg = (await runner.query(`SELECT value FROM platform_config WHERE key = 'claimed_listings.first_cohort_max'`)).rows[0];
  const limit = Math.min(Number(size) || 50, Number(maxCfg && maxCfg.value) || 50);
  const ctx = await listingContext.load(runner);
  const picks = [];
  for (const e of ctx.listings) {
    const d = eligibility.decide(e, ctx);
    if (d.decision !== eligibility.DECISIONS.ELIGIBLE) continue;
    const s = scoring.scoreListing(e, ctx);
    picks.push({ entity: e, score: s, market: s.factors.strategic_market.value });
  }
  picks.sort((a, b) => (markets.includes(b.market) ? 1 : 0) - (markets.includes(a.market) ? 1 : 0) || b.score.score - a.score.score || (a.entity.label < b.entity.label ? -1 : 1));
  const chosen = picks.slice(0, limit);
  return withTransaction(async (client) => {
    const c = (await client.query(
      `INSERT INTO listing_outreach_cohorts (name, description, status, max_sends, daily_cap, created_by, assigned_rep_user_id)
       VALUES ($1,$2,'draft',$3,10,$4,$5) RETURNING *`,
      [name || ('Pilot ' + new Date().toISOString().slice(0, 10)), 'Proposed from ELIGIBLE listings; strategic markets first.',
       chosen.length * 3, actorId, repUserId])).rows[0];
    for (const p of chosen) {
      const cluster = ctx.snap.clusterFor('organization', p.entity.entity_id);
      await client.query(
        `INSERT INTO listing_outreach_cohort_members (cohort_id, organization_id, company_id, recipient_email_normalized, status, added_by)
         VALUES ($1,$2,$3,$4,'pending',$5) ON CONFLICT (cohort_id, organization_id) DO NOTHING`,
        [c.id, p.entity.entity_id, ctx.companyIdOf(cluster), normalizeEmail(p.entity.row.contact_email || ''), actorId]);
    }
    await auditService.logEvent(client, { eventType: 'claimed_listing.cohort_proposed', entityType: 'listing_outreach_cohort', entityId: c.id, actorId,
      metadata: { members: chosen.length, markets: chosen.reduce((m, p) => { const k = p.market || 'other'; m[k] = (m[k] || 0) + 1; return m; }, {}) } });
    return { cohort: c, members: chosen.map((p) => ({ organization_id: p.entity.entity_id, name: p.entity.label, score: p.score.score, tier: p.score.tier, market: p.market })) };
  });
}

/** Bind approved template versions to a draft cohort (Super Admin). */
async function bindTemplates(cohortId, templateVersions, { actorId }, runner = db) {
  const ids = Object.values(templateVersions || {});
  const ok = (await runner.query(`SELECT id, template_key FROM listing_outreach_templates WHERE id = ANY($1::uuid[]) AND status = 'approved'`, [ids])).rows;
  for (const [key, id] of Object.entries(templateVersions || {})) {
    if (!ok.find((r) => r.id === id && r.template_key === key)) throw err(400, 'TEMPLATE_NOT_APPROVED', key + ' must be an approved version of ' + key + '.');
  }
  const r = await runner.query(
    `UPDATE listing_outreach_cohorts SET template_versions = $2::jsonb, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *`,
    [cohortId, JSON.stringify(templateVersions)]);
  if (!r.rows[0]) throw err(409, 'COHORT_NOT_DRAFT', 'Only a draft cohort can be changed.');
  await auditService.logEvent(runner, { eventType: 'claimed_listing.cohort_templates_bound', entityType: 'listing_outreach_cohort', entityId: cohortId, actorId, metadata: { templateVersions } });
  return r.rows[0];
}

/** Approve a cohort (Super Admin): every required template bound + approved, a rep assigned, a size within the cap. */
async function approveCohort(cohortId, { actorId, expiresInDays = 30 }, runner = db) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An approving administrator is required.');
  const c = (await runner.query(`SELECT * FROM listing_outreach_cohorts WHERE id = $1`, [cohortId])).rows[0];
  if (!c) throw err(404, 'NOT_FOUND', 'Cohort not found.');
  if (c.status !== 'draft') throw err(409, 'COHORT_NOT_DRAFT', 'Cohort is already ' + c.status + '.');
  const tv = c.template_versions || {};
  const missing = REQUIRED_TEMPLATES.filter((k) => !tv[k]);
  if (missing.length) throw err(400, 'TEMPLATES_REQUIRED', 'Bind approved versions of: ' + missing.join(', '));
  const approved = (await runner.query(`SELECT id FROM listing_outreach_templates WHERE id = ANY($1::uuid[]) AND status = 'approved'`, [Object.values(tv)])).rows.length;
  if (approved !== Object.values(tv).length) throw err(400, 'TEMPLATE_NOT_APPROVED', 'Every bound template must be an approved version.');
  if (!c.assigned_rep_user_id) throw err(400, 'REP_REQUIRED', 'Assign the signing representative first.');
  const size = (await runner.query(`SELECT count(*)::int AS n FROM listing_outreach_cohort_members WHERE cohort_id = $1`, [cohortId])).rows[0].n;
  const maxCfg = (await runner.query(`SELECT value FROM platform_config WHERE key = 'claimed_listings.first_cohort_max'`)).rows[0];
  if (size > (Number(maxCfg && maxCfg.value) || 50)) throw err(400, 'COHORT_TOO_LARGE', 'The cohort exceeds claimed_listings.first_cohort_max.');
  const r = (await runner.query(
    `UPDATE listing_outreach_cohorts SET status = 'approved', approved_by = $2, approved_at = now(),
        expires_at = now() + ($3 || ' days')::interval, max_sends = LEAST(max_sends, $4 * 3), updated_at = now()
      WHERE id = $1 RETURNING *`, [cohortId, actorId, String(expiresInDays), size])).rows[0];
  await auditService.logEvent(runner, { eventType: 'claimed_listing.cohort_approved', entityType: 'listing_outreach_cohort', entityId: cohortId, actorId,
    metadata: { members: size, templates: tv, note: 'Sending additionally requires claimed_listings.sending_enabled and every send gate.' } });
  return r;
}

async function setCohortStatus(cohortId, status, { actorId, reason = null }, runner = db) {
  if (!['paused', 'closed', 'active'].includes(status)) throw err(400, 'STATUS_INVALID', 'Invalid status.');
  const r = (await runner.query(
    `UPDATE listing_outreach_cohorts SET status = $2, notes = COALESCE($3, notes), updated_at = now()
      WHERE id = $1 AND status <> 'draft' RETURNING *`, [cohortId, status, reason])).rows[0];
  if (!r) throw err(409, 'COHORT_NOT_CHANGEABLE', 'A draft cohort must be approved first.');
  if (status !== 'active') {
    await runner.query(
      `UPDATE listing_outreach_sequences SET state = CASE WHEN $2 = 'closed' THEN 'stopped' ELSE 'paused' END,
          stop_reason = 'cohort_' || $2, updated_at = now()
        WHERE cohort_id = $1 AND state IN ('queued','active')`, [cohortId, status]);
  }
  await auditService.logEvent(runner, { eventType: 'claimed_listing.cohort_' + status, entityType: 'listing_outreach_cohort', entityId: cohortId, actorId, metadata: { reason } });
  return r;
}

// ── shadow run: render + gate, nothing sent, nothing issued ───────────────────────────────────

async function shadowRun(cohortId, { now = new Date() } = {}, runner = db) {
  const c = (await runner.query(`SELECT * FROM listing_outreach_cohorts WHERE id = $1`, [cohortId])).rows[0];
  if (!c) throw err(404, 'NOT_FOUND', 'Cohort not found.');
  const members = (await runner.query(
    `SELECT m.*, o.name FROM listing_outreach_cohort_members m JOIN organizations o ON o.id = m.organization_id WHERE m.cohort_id = $1 ORDER BY o.name`, [cohortId])).rows;
  const shared = { ctx: await listingContext.load(runner) };
  const results = [];
  for (const m of members) {
    const r = await sender.sendStep({ sequence: { id: null, organization_id: m.organization_id, cohort_id: cohortId, company_id: m.company_id, cycle_no: 1 },
      stepKey: 'E1', stepNo: 1, shadow: true, now, shared }, runner);
    await runner.query(`UPDATE listing_outreach_cohort_members SET gate_result = $2::jsonb, gate_checked_at = now(), updated_at = now() WHERE id = $1`,
      [m.id, JSON.stringify({ shadow: true, allowed: r.gate.allowed, blocked_by: r.gate.blocked_by, checks: r.gate.checks })]);
    results.push({ organization_id: m.organization_id, name: m.name, allowed: r.gate.allowed, blocked_by: r.gate.blocked_by,
      subject: r.subject, render_error: r.render_error || null, template: r.template });
  }
  const blocked = results.reduce((acc, r) => { for (const b of r.blocked_by) acc[b] = (acc[b] || 0) + 1; return acc; }, {});
  return { cohort_id: cohortId, cohort_status: c.status, members: results.length, would_send: results.filter((r) => r.allowed).length,
    sends: 0, blocked_by: blocked, rendered: results.filter((r) => r.subject).length, render_errors: results.filter((r) => r.render_error).length, results,
    sample: results.find((r) => r.subject) ? (await sender.sendStep({ sequence: { id: null, organization_id: results.find((r) => r.subject).organization_id,
      cohort_id: cohortId, cycle_no: 1 }, stepKey: 'E1', stepNo: 1, shadow: true, now, shared }, runner)).preview : null };
}

// ── the scheduler ─────────────────────────────────────────────────────────────────────────────

async function humanVisitAfter(sequenceId, since, runner) {
  const r = (await runner.query(
    `SELECT min(occurred_at) AS at FROM listing_claim_events
      WHERE sequence_id = $1 AND event_key = 'page_view' AND is_automated = false AND is_internal = false AND occurred_at > $2`,
    [sequenceId, since])).rows[0];
  return r && r.at ? new Date(r.at) : null;
}

/** Which message is due for this sequence now? Returns { stepNo, stepKey } or null. Pure-ish (reads visits). */
async function dueStep(seq, runner) {
  if (seq.cycle_no === 2) return seq.step < 4 ? { stepNo: 4, stepKey: 'E4_REFRESH' } : null;
  if (seq.step === 0) return { stepNo: 1, stepKey: 'E1' };
  if (seq.step === 1) return { stepNo: 2, stepKey: seq.variant === 'clicked' ? 'E2_CLICKED' : 'E2_NOCLICK' };
  if (seq.step === 2) return { stepNo: 3, stepKey: 'E3' };
  return null;
}

/**
 * One scheduler pass. Queues approved cohort members, promotes E2 to the clicked variant after a human
 * visit, moves finished sequences to dormant/completed, starts the single cycle-2 refresh, and asks the
 * sender to deliver whatever is due. Nothing leaves while sending is disabled.
 */
async function tick({ now = new Date() } = {}, runner = db) {
  const out = { queued: 0, attempted: 0, sent: 0, blocked: 0, stopped: 0, dormant: 0, promoted_clicked: 0, sending_enabled: false };
  const enabled = (await runner.query(`SELECT value FROM platform_config WHERE key = 'claimed_listings.sending_enabled'`)).rows[0];
  out.sending_enabled = !!(enabled && enabled.value === true);
  if (!out.sending_enabled) return out;   // fail closed: no queueing, no sends, no tokens while the switch is off

  // 1. Queue members of approved/active cohorts that have no sequence yet.
  const pending = (await runner.query(
    `SELECT m.*, c.status AS cohort_status FROM listing_outreach_cohort_members m JOIN listing_outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'pending' AND c.status IN ('approved','active') AND (c.expires_at IS NULL OR c.expires_at > now())`)).rows;
  for (const m of pending) {
    const companyId = m.company_id || await identity.ensureCompany('organization', m.organization_id, { runner }).catch(() => null);
    const seq = (await runner.query(
      `INSERT INTO listing_outreach_sequences (organization_id, company_id, cohort_id, cycle_no, step, state, next_send_at, assigned_rep_user_id)
       SELECT $1,$2,$3,1,0,'queued',now(), c.assigned_rep_user_id FROM listing_outreach_cohorts c WHERE c.id = $3
       ON CONFLICT (organization_id, cycle_no) DO NOTHING RETURNING *`, [m.organization_id, companyId, m.cohort_id])).rows[0];
    if (!seq) { await runner.query(`UPDATE listing_outreach_cohort_members SET status = 'skipped', skip_reason = 'already sequenced', updated_at = now() WHERE id = $1`, [m.id]); continue; }
    if (companyId && !(await locks.acquireSystem(companyId, seq.id, runner))) {
      await runner.query(`UPDATE listing_outreach_sequences SET state = 'paused', stop_reason = 'contact lock held', updated_at = now() WHERE id = $1`, [seq.id]);
    }
    await runner.query(`UPDATE listing_outreach_cohort_members SET status = 'queued', company_id = $2, updated_at = now() WHERE id = $1`, [m.id, companyId]);
    out.queued += 1;
  }

  // 2. A human visit without a claim brings E2 forward as the "finish claiming" variant (2 days after the visit).
  const waiting = (await runner.query(`SELECT * FROM listing_outreach_sequences WHERE state = 'active' AND step = 1 AND COALESCE(variant,'') <> 'clicked'`)).rows;
  for (const s of waiting) {
    const visit = await humanVisitAfter(s.id, s.last_sent_at, runner);
    if (visit) {
      const at = new Date(Math.min(new Date(s.next_send_at).getTime(), visit.getTime() + 2 * DAY));
      await runner.query(`UPDATE listing_outreach_sequences SET variant = 'clicked', next_send_at = $2, updated_at = now() WHERE id = $1`, [s.id, at]);
      out.promoted_clicked += 1;
    }
  }

  // 3. Dormant 180 days → one refresh (cycle 2).
  const wake = (await runner.query(
    `SELECT * FROM listing_outreach_sequences WHERE state = 'dormant' AND cycle_no = 1 AND next_send_at <= now()`)).rows;
  for (const s of wake) {
    await runner.query(`UPDATE listing_outreach_sequences SET state = 'completed', updated_at = now() WHERE id = $1`, [s.id]);
    const s2 = (await runner.query(
      `INSERT INTO listing_outreach_sequences (organization_id, company_id, cohort_id, cycle_no, step, state, next_send_at, assigned_rep_user_id)
       VALUES ($1,$2,$3,2,0,'queued',now(),$4) ON CONFLICT (organization_id, cycle_no) DO NOTHING RETURNING *`,
      [s.organization_id, s.company_id, s.cohort_id, s.assigned_rep_user_id])).rows[0];
    if (s2 && s.company_id) await locks.acquireSystem(s.company_id, s2.id, runner);
  }

  // 4. Deliver what is due.
  const due = (await runner.query(
    `SELECT * FROM listing_outreach_sequences WHERE state IN ('queued','active') AND next_send_at <= now() ORDER BY next_send_at LIMIT 25`)).rows;
  const shared = due.length ? { ctx: await listingContext.load(runner) } : {};
  for (const s of due) {
    const step = await dueStep(s, runner);
    if (!step) continue;
    out.attempted += 1;
    const r = await sender.sendStep({ sequence: s, stepKey: step.stepKey, stepNo: step.stepNo, now, shared }, runner);
    await runner.query(
      `UPDATE listing_outreach_cohort_members SET gate_result = $3::jsonb, gate_checked_at = now(), updated_at = now()
        WHERE cohort_id = $1 AND organization_id = $2`, [s.cohort_id, s.organization_id, JSON.stringify({ allowed: !!(r.gate && r.gate.allowed), blocked_by: r.gate ? r.gate.blocked_by : [], step: step.stepKey })]);
    if (r.sent) {
      out.sent += 1;
      const e1 = step.stepNo === 1 ? now : new Date(((await runner.query(
        `SELECT min(sent_at) AS at FROM listing_outreach_messages WHERE sequence_id = $1 AND status = 'sent'`, [s.id])).rows[0] || {}).at || now);
      let next = null; let state = 'active';
      if (step.stepNo === 1) next = new Date(e1.getTime() + 6 * DAY);
      else if (step.stepNo === 2) next = new Date(e1.getTime() + 14 * DAY);
      else if (step.stepNo === 3) { state = 'dormant'; next = new Date(now.getTime() + 180 * DAY); out.dormant += 1; }
      else if (step.stepNo === 4) { state = 'completed'; next = null; }
      await runner.query(
        `UPDATE listing_outreach_sequences SET step = $2, state = $3, next_send_at = $4, last_sent_at = $5, retry_count = 0, updated_at = now() WHERE id = $1`,
        [s.id, step.stepNo === 4 ? 4 : step.stepNo, state, next, now]);
      if (state !== 'active' && s.company_id) await locks.releaseSystem(s.id, runner);
      await runner.query(`UPDATE listing_outreach_cohort_members SET status = 'active', updated_at = now() WHERE cohort_id = $1 AND organization_id = $2`, [s.cohort_id, s.organization_id]);
    } else if (r.error) {
      const retry = sender.RETRY_MINUTES[Math.min(s.retry_count || 0, sender.RETRY_MINUTES.length - 1)];
      await runner.query(`UPDATE listing_outreach_sequences SET retry_count = retry_count + 1, next_send_at = now() + ($2 || ' minutes')::interval, updated_at = now() WHERE id = $1`,
        [s.id, String(retry)]);
    } else if (r.gate && r.gate.permanent) {
      await runner.query(`UPDATE listing_outreach_sequences SET state = 'stopped', stop_reason = $2, next_send_at = NULL, updated_at = now() WHERE id = $1`,
        [s.id, 'gate: ' + r.gate.blocked_by.join(',')]);
      if (s.company_id) await locks.releaseSystem(s.id, runner);
      await runner.query(`UPDATE listing_outreach_cohort_members SET status = 'stopped', skip_reason = $3, updated_at = now() WHERE cohort_id = $1 AND organization_id = $2`,
        [s.cohort_id, s.organization_id, r.gate.blocked_by.join(',')]);
      out.stopped += 1;
    } else {
      out.blocked += 1;   // window / caps / spacing / switch: wait for a later tick
    }
  }
  return out;
}

/** Staff pause / resume of one company's sequence (a person is handling it). */
async function pauseSequence(organizationId, { actorId, reason }, runner = db) {
  const r = await runner.query(
    `UPDATE listing_outreach_sequences SET state = 'paused', stop_reason = $2, updated_at = now()
      WHERE organization_id = $1 AND state IN ('queued','active') RETURNING id`, [organizationId, 'staff: ' + (reason || 'paused')]);
  await auditService.logEvent(runner, { eventType: 'claimed_listing.sequence_paused', entityType: 'organization', entityId: organizationId, actorId, metadata: { reason } }).catch(() => {});
  return { paused: r.rowCount };
}

module.exports = { REQUIRED_TEMPLATES, STEP_KEYS, proposeCohort, bindTemplates, approveCohort, setCohortStatus, shadowRun, dueStep, tick, pauseSequence };
