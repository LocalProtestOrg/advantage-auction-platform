'use strict';

/**
 * creativeReference/feedbackRecords — Phase 3P.1 Mission 1 persistence: the Owner's attribute-level feedback records
 * (CREATIVE_REVIEW / OWNER_RULE in owner-decisions.jsonl) → marketing_creative_feedback_records / _attributes / _messages,
 * validated against docs/marketing/phase3p1/config/feedback-record.schema.json. Written ONLY from Owner sources.
 *   · verdict.negative_signature → the render's layout signature enters the class's NEGATIVE set (τ_neg check in G11)
 *   · verdict.gold_standard is const false — a Gold write needs an explicit SET_STATUS with the Owner's words
 *   · library_admission 'eligible_after_revision' is recorded, never acted on
 *   · unknown actions are preserved in the ledger and reported, never dropped
 * The ledger file is the source of truth; ingestion is idempotent by line hash.
 */
const fs = require('fs');
const path = require('path');
const lib = require('./library');
const bridge = require('./engineBridge');

const SCHEMA = require('../../../docs/marketing/phase3p1/config/feedback-record.schema.json');
const OWNER_SOURCES = new Set(SCHEMA.properties.source.enum.concat(['folder_placement_by_owner']));
const ATTRS = new Set(SCHEMA.$defs.Attribute.enum);
const PG_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'marketing', 'phase3p', 'proving-grounds', '2026-09-09');
const FEEDBACK_ACTIONS = new Set(['CREATIVE_REVIEW', 'OWNER_RULE']);

/** Focused validation of one feedback record (the contract's required keys, enums and the gold const). */
function validate(rec) {
  const e = [];
  for (const k of SCHEMA.required) if (rec[k] === undefined) e.push('missing ' + k);
  if (!SCHEMA.properties.action.enum.includes(rec.action)) e.push('action not in enum');
  if (!OWNER_SOURCES.has(rec.source)) e.push('source is not an Owner source');
  const v = rec.verdict || {};
  if (v.gold_standard !== undefined && v.gold_standard !== false) e.push('verdict.gold_standard must be false (Gold needs an explicit SET_STATUS with the Owner\'s words)');
  if (v.overall && !SCHEMA.properties.verdict.properties.overall.enum.includes(v.overall)) e.push('verdict.overall not in enum');
  if (v.library_admission && !SCHEMA.properties.verdict.properties.library_admission.enum.includes(v.library_admission)) e.push('library_admission not in enum');
  if (v.library_admission === 'admit_as_owner_approved' && (rec.attributes || []).some((a) => a.severity === 'required')) e.push('admit requires GOOD with no required fixes');
  for (const a of rec.attributes || []) {
    if (!ATTRS.has(a.attribute)) e.push('unknown attribute ' + a.attribute);
    if (!['positive', 'negative'].includes(a.polarity)) e.push('attribute polarity');
    if (!['required', 'strong', 'note'].includes(a.severity)) e.push('attribute severity');
  }
  for (const m of rec.messages || []) if (!SCHEMA.properties.messages.items.properties.status.enum.includes(m.status)) e.push('message status ' + m.status);
  return { valid: e.length === 0, errors: e };
}

function readLedger(root) {
  const p = path.join(root || lib.LIBRARY_ROOT, 'owner-decisions.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    let entry = null; try { entry = JSON.parse(line); } catch (_) { /* malformed lines are reported */ }
    return { line, hash: lib.sha256Text(line), entry };
  });
}

/** Parse the ledger's feedback records (no DB). */
function records(root) {
  const out = []; const unknown = [];
  for (const l of readLedger(root)) {
    const e = l.entry; if (!e) { unknown.push({ hash: l.hash, reason: 'malformed' }); continue; }
    if (FEEDBACK_ACTIONS.has(e.action)) out.push({ hash: l.hash, record: e, validation: validate(e) });
    else if (!['SET_STATUS', 'RECLASSIFY', 'LIBRARY_BASELINE', 'LIBRARY_EXPANSION', 'CALIBRATION_NOTE', 'ADD_GENERATED'].includes(e.action)) unknown.push({ hash: l.hash, action: e.action });
  }
  return { records: out, unknown };
}

/** Approved messages recorded by the Owner (independent of visual verdicts). */
function approvedMessages(root) {
  const msgs = [];
  for (const r of records(root).records) for (const m of r.record.messages || []) msgs.push(Object.assign({ record_hash: r.hash }, m));
  return msgs;
}

function negativeSubjects(root) {
  return records(root).records.filter((r) => r.validation.valid && r.record.verdict && r.record.verdict.negative_signature === true)
    .map((r) => ({ hash: r.hash, job: r.record.subject.job_id, candidate: r.record.subject.candidate, campaign_class: r.record.subject.campaign_class, family: r.record.subject.family }));
}

/** Idempotent DB ingestion + negative signatures. db: { query }. */
async function ingest({ db, root } = {}) {
  const { records: recs, unknown } = records(root);
  let inserted = 0; const negatives = [];
  for (const r of recs) {
    const e = r.record;
    const res = await db.query(`INSERT INTO marketing_creative_feedback_records (record_hash, action, source, subject, verdict, owner_words, rules, recorded_by, record_ts, valid, validation_errors)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11::jsonb) ON CONFLICT (record_hash) DO NOTHING RETURNING record_hash`,
      [r.hash, e.action, e.source, JSON.stringify(e.subject || {}), JSON.stringify(e.verdict || {}), e.owner_words || null, JSON.stringify(e.rules || []), e.recorded_by || null, e.ts || null, r.validation.valid, JSON.stringify(r.validation.errors)]);
    if (!res.rows.length) continue;
    inserted++;
    if (!r.validation.valid || !OWNER_SOURCES.has(e.source)) continue;
    const s = e.subject || {};
    for (const a of e.attributes || []) {
      await db.query(`INSERT INTO marketing_creative_feedback_attributes (record_hash, subject_job_id, subject_candidate, campaign_class, family, render_sha256, attribute, polarity, severity, scope, note, evidence)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [r.hash, s.job_id || null, s.candidate || null, s.campaign_class || null, s.family || null, JSON.stringify(s.render_sha256 || []), a.attribute, a.polarity, a.severity, a.scope || null, a.note || null, a.evidence || null]);
    }
    for (const m of e.messages || []) {
      await db.query(`INSERT INTO marketing_creative_feedback_messages (record_hash, text, status, scope, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [r.hash, m.text, m.status, m.scope || null, m.role || null]);
    }
  }
  // Negative signatures: the Owner's NO verdicts re-mark those renders' signatures as negative evidence for the class.
  for (const n of negativeSubjects(root)) {
    for (const fmt of ['portrait_1080x1350', 'square_1080x1080']) {
      const png = path.join(PG_DIR, `${n.job}-${n.candidate}-${fmt}.png`);
      if (!fs.existsSync(png)) continue;
      const sig = await bridge.signatures([png]);
      const v = sig && sig.ok && Object.values(sig.signatures)[0];
      if (!v) continue;
      await db.query(`INSERT INTO marketing_creative_layout_signatures (subject_kind, subject_id, family, seller, campaign_class, signature, polarity)
        VALUES ('creative',$1,$2,NULL,$3,$4::jsonb,'negative')
        ON CONFLICT (subject_kind, subject_id) DO UPDATE SET polarity='negative', campaign_class=EXCLUDED.campaign_class`, [`${n.job}:${n.candidate}:${fmt}`, n.family || null, n.campaign_class || null, JSON.stringify(v)]);
      negatives.push(`${n.job}:${n.candidate}:${fmt}`);
    }
  }
  return { records: recs.length, inserted, invalid: recs.filter((r) => !r.validation.valid).map((r) => ({ hash: r.hash.slice(0, 12), errors: r.validation.errors })), unknown, negatives };
}

/** Negative signatures for a class (DB), for the τ_neg check. */
async function negativeSignatures(db, campaignClass) {
  const r = await db.query(`SELECT subject_id, signature FROM marketing_creative_layout_signatures WHERE polarity='negative' AND (campaign_class=$1 OR $1 IS NULL)`, [campaignClass || null]);
  return r.rows.map((x) => ({ id: x.subject_id, signature: x.signature }));
}

module.exports = { validate, records, approvedMessages, negativeSubjects, ingest, negativeSignatures, SCHEMA };
