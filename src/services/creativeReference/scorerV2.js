'use strict';

/**
 * creativeReference/scorerV2 — Phase 3P.1 §14 + 3P.2 gates. Score 0–100 = measurable 60 + judged 40.
 *
 * Measurable block (60): merchandise coverage (field-based) 12 · accidental void 6 · hierarchy incl. event type 10 ·
 * identity prominence 8 · physical audit clean 8 · copy 6 · depth/planes 6 · light ground 2 · brand frame 2.
 * Items that do not apply to the family are n/a and the rest is scaled to 60 (families stay comparable).
 *
 * Two failure tiers (the Owner's six 2026-09-09 verdicts are the regression anchors):
 *   BLOCKING → HARD_FAIL, score 0: physical violations (through / deep-overlap / protected-occluded / unsupported /
 *     scale / wall / ground / room-scale), coverage floor or void cap or panel content, colour hard rules, logo_source or
 *     rendered_logo_elsewhere, negative-signature proximity (< τ_neg/2), screenshot-as-hero in acquisition, copy/claim
 *     rejection, copy-density hard rule, hierarchy floor, G11 anti-similarity, G12 seller-mark leak, G13 provenance, and
 *     a judge "yes" to "is anything passing through / the wrong size".
 *   REGENERATE → score kept, decision REGENERATE with the violations listed: identity prominence, event-type hierarchy,
 *     capitalization hygiene, template echo, judge comprehension failures, negative proximity within τ_neg.
 * Decision: HARD_FAIL · NOT_FOR_PUBLICATION (calibration extreme) · REGENERATE · OWNER_REVIEW / ACCEPT (≥ bar; 75 when the
 * class has a Gold Standard) · REGENERATE (50–bar) · FALLBACK_DEFAULT_FAMILY (< 50).
 */
const SCORER_VERSION = 'p3p1-scorer-v2';

function scoreMeasurable(m, { family, profile, scene } = {}) {
  const cov = m.coverage || {}; const cg = m.coverage_gate || {};
  const band = { ENVIRONMENTAL_PHOTO: [55, 75], ACQUISITION: [45, 65], CENTERED_WHITE: [55, 72], LEFT_THIRD_WHITE: [55, 70], SINGLE_LOT: [40, 70], RESTRAINED_FACTUAL: [0, 30], CATALOG_SCATTER: [65, 88] }[family] || [45, 65];
  const capBy = { ENVIRONMENTAL_PHOTO: 6, ACQUISITION: 8, CENTERED_WHITE: 6, LEFT_THIRD_WHITE: 8, SINGLE_LOT: 25, RESTRAINED_FACTUAL: 30, CATALOG_SCATTER: 5 }[family] || 8;
  const lin = (v, lo, hi, soft) => (v == null ? null : (v >= lo && v <= hi ? 1 : Math.max(0, 1 - (v < lo ? lo - v : v - hi) / soft)));
  const covF = lin(cov.coverage_pct, band[0], band[1], 10);
  const voidF = cov.largest_accidental_void_pct == null ? null : (cov.largest_accidental_void_pct <= capBy ? 1 : Math.max(0, 1 - (cov.largest_accidental_void_pct - capBy) / 4));
  const et = m.event_type || {}; const d = m.density || {};
  const eventFamily = family === 'ENVIRONMENTAL_PHOTO' || profile === 'EVENT';
  const hierF = eventFamily ? (et.violations ? Math.max(0, 1 - 0.25 * et.violations.length) : null)
    : (d.headline_dominance == null ? null : Math.min(1, d.headline_dominance / 2.2));
  const prom = m.prominence || {};
  const promF = prom.violations ? Math.max(0, 1 - 0.25 * prom.violations.length) : null;
  const physF = scene === 'planned' ? ((m.physical_violations || []).length ? 0 : 1) : null;
  const copyF = d.blocks == null ? null : ((d.headline_class_roles || []).length > 1 ? 0.3 : 1);
  const planes = scene === 'planned' ? (m.planes_count != null ? m.planes_count : null) : null;
  const depthF = scene === 'planned' ? (planes == null ? 0.5 : Math.min(1, planes / 2)) : null;
  const lightF = m.colour ? (m.colour.canvas_luminance >= 0.60 ? 1 : 0) : null;
  const bf = m.brand_frame || {};
  const frameF = (bf.band && bf.wordmark && bf.logo) ? 1 : (bf.band && bf.wordmark ? 0.5 : 0);
  const items = [
    ['merchandise_coverage_field', 12, covF, band], ['accidental_void', 6, voidF, '≤ ' + capBy], ['hierarchy_incl_event_type', 10, hierF, eventFamily ? 'event-type rules' : 'headline ≥ 2.2×'],
    ['identity_prominence', 8, promF, 'prominence-rules'], ['physical_audit_clean', 8, physF, '0 violations'], ['copy', 6, copyF, 'one headline-class element'],
    ['depth_planes', 6, depthF, '≥ 2 planes'], ['light_ground', 2, lightF, 'canvas luminance ≥ 0.60'], ['brand_frame', 2, frameF, 'logo + band + wordmark'],
  ].map(([key, pts, f, target]) => ({ key, pts, value: f, points: f == null ? null : Math.round(pts * f * 100) / 100, target }));
  const app = items.filter((i) => i.points != null);
  const raw = app.reduce((a, i) => a + i.points, 0); const max = app.reduce((a, i) => a + i.pts, 0);
  return { points: max ? Math.round((raw / max) * 60 * 100) / 100 : 0, out_of: 60, raw, raw_max: max, items };
}

/** checks: { blocking: {name: {pass, detail}}, regenerate: {name: {pass, detail}} } */
function finalize({ measurable, judge, checks, bar = 70, regenerateFloor = 50, extreme = false, ownerReviewRequired = true }) {
  const fails = (group) => Object.entries(group || {}).filter(([, v]) => v && v.pass === false).map(([k, v]) => ({ gate: k, detail: v.detail || v.failures || v.hits || v.reasons || v.violations || v.hard || [] }));
  const hard = fails(checks.blocking); const regen = fails(checks.regenerate);
  const judgePts = judge && judge.available ? Math.round(judge.points * 100) / 100 : null;
  const score = hard.length ? 0 : Math.round(((measurable.points || 0) + (judgePts || 0)) * 100) / 100;
  let decision;
  if (hard.length) decision = 'HARD_FAIL';
  else if (extreme) decision = 'NOT_FOR_PUBLICATION';
  else if (regen.length) decision = 'REGENERATE';
  else if (score >= bar) decision = ownerReviewRequired ? 'OWNER_REVIEW' : 'ACCEPT';
  else if (score >= regenerateFloor) decision = 'REGENERATE';
  else decision = 'FALLBACK_DEFAULT_FAMILY';
  return { score, decision, bar, hard_failures: hard, regenerate_violations: regen, measurable_points: measurable.points, judge_points: judgePts,
           judge_available: !!(judge && judge.available), score_basis: judge && judge.available ? 'measurable_60 + judge_40' : 'measurable_60 only (judge unavailable) — out of 60', scorer_version: SCORER_VERSION };
}

module.exports = { SCORER_VERSION, scoreMeasurable, finalize };
