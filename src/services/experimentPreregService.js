'use strict';

/**
 * experimentPreregService — server-authoritative pre-registration freeze + immutability. Freeze the
 * contract + a deterministic hash before execution; once execution starts, the frozen fields cannot be
 * silently edited — a change requires a NEW experiment version referencing the prior one. Mirrors the
 * pricing/publish/allocation freeze pattern. Stale UI / direct API cannot bypass (enforced here).
 */
const db = require('../db');
const prereg = require('../lib/experimentPrereg');

async function preregister(experimentId, fields = {}) {
  const cur = (await db.query('SELECT execution_started_at FROM marketing_experiments WHERE id = $1', [experimentId])).rows[0];
  if (!cur) { const e = new Error('Experiment not found.'); e.code = 'NOT_FOUND'; e.status = 404; throw e; }
  if (cur.execution_started_at) { const e = new Error('Pre-registration is locked: this experiment has started executing. Create a new version.'); e.code = 'PREREG_LOCKED'; e.status = 409; throw e; }
  const frozen = prereg.freeze(fields);
  const missing = prereg.missingRequired(frozen);
  if (missing.length) { const e = new Error('Missing required pre-registration fields: ' + missing.join(', ')); e.code = 'PREREG_INCOMPLETE'; e.status = 422; throw e; }
  const h = prereg.hash(frozen);
  await db.query(
    `UPDATE marketing_experiments SET preregistration = $2, prereg_hash = $3, prereg_frozen_at = now(),
            analysis_window_days = COALESCE($4, analysis_window_days),
            attribution_grade = COALESCE($5, attribution_grade), updated_at = now()
      WHERE id = $1`,
    [experimentId, JSON.stringify(frozen), h, frozen.analysis_window_days || null, frozen.attribution_grade || null]);
  return { prereg_hash: h, frozen };
}

async function startExecution(experimentId, actorId = null) {
  const cur = (await db.query('SELECT prereg_hash, execution_started_at FROM marketing_experiments WHERE id = $1', [experimentId])).rows[0];
  if (!cur) { const e = new Error('Experiment not found.'); e.code = 'NOT_FOUND'; e.status = 404; throw e; }
  if (!cur.prereg_hash) { const e = new Error('Cannot start execution before pre-registration is frozen.'); e.code = 'PREREG_REQUIRED'; e.status = 422; throw e; }
  if (cur.execution_started_at) return { alreadyStarted: true };
  await db.query(`UPDATE marketing_experiments SET execution_started_at = now(), status = 'running', updated_at = now() WHERE id = $1`, [experimentId]);
  try {
    const { writeAuditLog } = require('../lib/auditLog');
    writeAuditLog({ event_type: 'experiment_execution_started', entity_type: 'marketing_experiment', entity_id: experimentId, actor_id: actorId, metadata: { prereg_hash: cur.prereg_hash } }).catch(() => {});
  } catch (_) { /* audit best-effort */ }
  return { started: true };
}

// Guard: refuse to mutate frozen fields after execution — callers must use newVersion() instead.
async function assertPreregMutable(experimentId) {
  const cur = (await db.query('SELECT execution_started_at FROM marketing_experiments WHERE id = $1', [experimentId])).rows[0];
  if (cur && cur.execution_started_at) { const e = new Error('Pre-registered fields are immutable after execution starts; create a new experiment version.'); e.code = 'PREREG_LOCKED'; e.status = 409; throw e; }
  return true;
}

// Create a NEW experiment version referencing the prior, then pre-register it (the only path to "change").
async function newVersion(priorId, fields = {}) {
  const prior = (await db.query('SELECT * FROM marketing_experiments WHERE id = $1', [priorId])).rows[0];
  if (!prior) { const e = new Error('Prior experiment not found.'); e.code = 'NOT_FOUND'; e.status = 404; throw e; }
  const ins = await db.query(
    `INSERT INTO marketing_experiments (hypothesis, objective, campaign_class, primary_metric, proposed_by_agent, supersedes_experiment_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,'proposed') RETURNING id`,
    [fields.hypothesis || prior.hypothesis, prior.objective, prior.campaign_class, fields.primary_metric || prior.primary_metric, prior.proposed_by_agent, priorId]);
  const pr = await preregister(ins.rows[0].id, fields);
  return { id: ins.rows[0].id, supersedes: priorId, ...pr };
}

module.exports = { preregister, startExecution, assertPreregMutable, newVersion };
