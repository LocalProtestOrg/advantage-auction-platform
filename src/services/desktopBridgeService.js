'use strict';

/**
 * desktopBridgeService — the controlled Desktop Marketing operating bridge (Phase 3O §10). It is the ONLY
 * interface between the VS Code production runtime and Desktop Marketing, and it is deliberately small:
 *   VS → Desktop : an ANONYMIZED RUNTIME_EXPORT (aggregates + opaque ids ONLY — no names/emails/addresses/
 *                  cards/recipients/credentials).
 *   Desktop → VS : structured PROPOSALS/REVIEWS validated against the schema pack, stored, and ROUTED to an
 *                  existing controlled path (PR / admin config / admin version registry / fidelity queue /
 *                  report-only). Desktop can NEVER write live production directly. Full auditability from
 *                  proposal id → applied change is preserved.
 * There is NO generic remote-command endpoint.
 */

const db = require('../db');
const contract = require('./phase3oContract');

// PII/leak guard: reject any payload that contains obvious recipient/credential material.
const PII_RE = /("email"|"phone"|"address"|"card"|"cardnumber"|"cvv"|"ssn"|"secret"|"token"|"password"|"api[_-]?key"|@[a-z0-9.-]+\.[a-z]{2,}|\+\d{10,15})/i;

// Build an anonymized runtime export (aggregate/opaque only). Never includes recipient records or PII.
async function buildRuntimeExport(windowLabel, runner) {
  const r = runner || db;
  const byState = (await r.query(`SELECT state, count(*)::int n FROM marketing_obligations GROUP BY state`)).rows;
  const attempts = (await r.query(`SELECT COALESCE(AVG(attempts),0)::float avg_attempts, MAX(attempts)::int max_attempts FROM marketing_obligations`)).rows[0];
  const ladderOutcomes = (await r.query(`SELECT rung, count(*)::int n FROM marketing_obligation_events WHERE rung IS NOT NULL GROUP BY rung`)).rows;
  const substitutions = (await r.query(`SELECT count(*)::int n FROM marketing_obligations WHERE state='substituted'`)).rows[0].n;
  const readiness = (await r.query(`SELECT channel_key, state FROM marketing_channel_readiness`)).rows;
  const payload = {
    window_label: windowLabel || 'rolling',
    obligations_by_state: byState,
    attempts: { avg: attempts.avg_attempts, max: attempts.max_attempts },
    ladder_outcomes: ladderOutcomes,
    substitutions,
    channel_readiness: readiness,
    generated_note: 'Aggregate + opaque ids only. No names, emails, addresses, card data, recipient records, or credentials.',
  };
  // Assert no PII slipped in.
  const json = JSON.stringify(payload);
  const containsPii = PII_RE.test(json);
  const exportId = 'rex_' + Math.abs(hashStr(json)).toString(36);
  await r.query(`INSERT INTO marketing_runtime_exports (export_id, window_label, payload, contains_pii) VALUES ($1,$2,$3::jsonb,$4)`,
    [exportId, windowLabel || 'rolling', json, containsPii]);
  const message = { message_id: 'msg_' + exportId, direction: 'vs_to_desktop', type: 'RUNTIME_EXPORT',
    created_at: new Date().toISOString(), contract_version: '3O.1', body: payload, references: [exportId],
    contains_production_credentials: false, contains_recipient_data: false };
  const validation = contract.validate('interface_message', message);
  return { export_id: exportId, contains_pii: containsPii, message, valid: validation.valid, errors: validation.errors };
}

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

// Route a validated proposal type to the controlled application path (never applies live directly).
const ROUTE_FOR_TYPE = {
  RULE_PROPOSAL: 'pull_request',
  CREATIVE_FAMILY_SPEC: 'pull_request',
  CONFIG_PROPOSAL: 'admin_config_editor',
  RECIPE_VERSION_PROPOSAL: 'admin_version_registry',
  CREATIVE_REVIEW_REQUEST: 'fidelity_review_queue',
  AUDIT_FINDING: 'report_only',
  CALIBRATION_REPORT: 'report_only',
  OWNER_QUESTION: 'report_only',
};

// Ingest a Desktop → VS proposal. Validates against the interface schema, rejects credentials/recipient
// data, stores it, and routes it to a controlled path. NEVER mutates live production directly.
async function ingestProposal(message, actorId, runner) {
  const r = runner || db;
  const validation = contract.validate('interface_message', message);
  const json = JSON.stringify(message || {});
  const hasPii = PII_RE.test(json);
  const credOk = message && message.contains_production_credentials === false;
  const recipientOk = message && message.contains_recipient_data === false;
  const valid = validation.valid && !hasPii && credOk && recipientOk;
  const errors = [].concat(validation.errors, hasPii ? ['recipient/credential-like content present'] : [],
    !credOk ? ['contains_production_credentials must be false'] : [], !recipientOk ? ['contains_recipient_data must be false'] : []);
  const applies_via = valid ? (ROUTE_FOR_TYPE[message.type] || 'report_only') : null;
  const status = valid ? 'routed' : 'rejected';
  const row = (await r.query(
    `INSERT INTO marketing_desktop_messages (message_id, direction, message_type, contract_version, body, schema_valid, schema_errors, applies_via, status, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10)
     ON CONFLICT (message_id) DO NOTHING RETURNING *`,
    [message && message.message_id, message && message.direction, message && message.type, (message && message.contract_version) || '3O.1',
     JSON.stringify((message && message.body) || {}), valid, JSON.stringify(errors), applies_via, status, actorId || null])).rows[0];
  return { valid, status, applies_via, errors, stored: !!row, id: row && row.id };
}

module.exports = { buildRuntimeExport, ingestProposal, ROUTE_FOR_TYPE, PII_RE };
