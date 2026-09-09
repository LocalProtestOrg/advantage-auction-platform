'use strict';

/**
 * creativeReference/scorer — Deliverable 7 Part B. Reference calibration score 0–100 with per-principle evidence.
 *   B1 measurable principles — 60 points (from the renderer's layout metrics; principles that do not apply to the
 *      family are marked n/a and the remaining points are scaled to 60 so families are comparable)
 *   B2 judged principles     — 40 points (vision judge, judge.js; when the judge is unavailable the score is reported
 *      as measurable-only with judge:{available:false} — never fabricated)
 *   B3 hard checks           — any failure → score 0 and HARD FAIL regardless of points
 *   B4 decision              — ACCEPT ≥ bar (70; 75 when the class has a Gold Standard) · REGENERATE 50–69 · FALLBACK < 50
 *      A calibration extreme (NOT FOR PUBLICATION) is exempt from the bar (decision NOT_FOR_PUBLICATION).
 * Points inside the band are full; linear to 0 at ±50% outside it.
 */
const SCORER_VERSION = 'p3p-scorer-v1';

function bandPoints(value, band, pts) {
  if (value == null || !band) return null;
  const [lo, hi] = band; if (value >= lo && value <= hi) return pts;
  const width = Math.max(hi - lo, 1); const over = value < lo ? lo - value : value - hi;
  const frac = Math.max(0, 1 - over / (0.5 * Math.max(hi, width)));
  return Math.round(pts * frac * 100) / 100;
}
function boolPoints(ok, pts) { return ok == null ? null : (ok ? pts : 0); }

/** metrics: renderer metrics; band: principles.bandFor(); profile: text profile name; family */
function scoreMeasurable(metrics, band, { family, textProfile = 'GENERAL', eventFamily = true } = {}) {
  const textMax = { GENERAL: 18, LOGISTICS: 26, TEASER: 12 }[textProfile] || 18;
  const budget = { GENERAL: 5, LOGISTICS: 7, TEASER: 3 }[textProfile] || 5;
  const scene = !!band.scene;
  const items = [
    { key: 'merchandise_forward', pts: 12, value: metrics.merchandise_pct, points: bandPoints(metrics.merchandise_pct, band.merch, 12), target: band.merch },
    { key: 'restrained_copy', pts: 8, value: metrics.text_region_pct, points: bandPoints(metrics.text_region_pct, [0, Math.max(textMax, (band.text || [0, textMax])[1])], 8), target: [0, Math.max(textMax, (band.text || [0, textMax])[1])] },
    { key: 'copy_count', pts: 6, value: metrics.text_blocks, points: boolPoints(metrics.text_blocks != null ? metrics.text_blocks <= budget : null, 6), target: '≤ ' + budget },
    { key: 'hierarchy_one_title', pts: 8, value: metrics.hierarchy_ratio, points: metrics.hierarchy_ratio == null ? null : (metrics.hierarchy_ratio >= 2.2 && (metrics.title_words == null || (metrics.title_words >= 2 && metrics.title_words <= 6)) ? 8 : Math.round(8 * Math.min(1, metrics.hierarchy_ratio / 2.2) * 0.6 * 100) / 100), target: 'largest ≥ 2.2× next; title 2–6 words' },
    { key: 'date_gt_time', pts: 3, value: metrics.date_gt_time, points: eventFamily ? boolPoints(metrics.date_gt_time, 3) : null, target: 'date box > time box' },
    { key: 'controlled_occupancy', pts: 6, value: metrics.largest_empty_pct, points: band.empty_max == null ? null : bandPoints(metrics.largest_empty_pct, [0, band.empty_max], 6), target: band.empty_max == null ? 'n/a' : '≤ ' + band.empty_max },
    { key: 'merchandise_rises', pts: 5, value: metrics.upper_half_merch_pct, points: band.upper_half_min ? bandPoints(metrics.upper_half_merch_pct, [band.upper_half_min, 100], 5) : null, target: band.upper_half_min ? '≥ ' + band.upper_half_min : 'n/a' },
    { key: 'depth_diversity', pts: 6, value: metrics.planes || null, points: scene ? boolPoints(metrics.planes ? Object.keys(metrics.planes).length >= 2 && (metrics.meaningful_overlaps || 0) >= (metrics.decorative_overlaps || 0) : false, 6) : null, target: scene ? 'planes ≥ 2; meaningful ≥ decorative overlaps' : 'n/a (not a scene family)' },
    { key: 'light_ground', pts: 3, value: metrics.ground_luminance, points: family === 'SINGLE_LOT' ? null : boolPoints(metrics.ground_luminance != null ? metrics.ground_luminance >= 0.85 : null, 3), target: '≥ 0.85 relative luminance' },
    { key: 'brand_frame', pts: 3, value: metrics.brand_frame, points: boolPoints(metrics.brand_frame ? !!(metrics.brand_frame.band && metrics.brand_frame.wordmark) : null, 3), target: 'band + wordmark (+ logo where the family shows it)' },
  ];
  const applicable = items.filter((i) => i.points != null);
  const raw = applicable.reduce((a, i) => a + i.points, 0); const max = applicable.reduce((a, i) => a + i.pts, 0);
  const scaled = max ? Math.round((raw / max) * 60 * 100) / 100 : 0;
  return { points: scaled, out_of: 60, raw, raw_max: max, items };
}

/** Combine measurable + judge + hard checks → score + decision. */
function finalize({ measurable, judge, hardChecks = {}, bar = 70, regenerateFloor = 50, extreme = false, ownerReviewRequired = false }) {
  const hardFailures = Object.entries(hardChecks).filter(([, v]) => v && v.pass === false).map(([k, v]) => ({ gate: k, detail: v.failures || v.hits || v.reasons || [] }));
  const judgePts = judge && judge.available ? Math.round(judge.average * 100) / 100 : null;
  const score = hardFailures.length ? 0 : Math.round(((measurable.points || 0) + (judgePts || 0)) * 100) / 100;
  let decision;
  if (hardFailures.length) decision = 'HARD_FAIL';
  else if (extreme) decision = 'NOT_FOR_PUBLICATION';
  else if (score >= bar) decision = ownerReviewRequired ? 'OWNER_REVIEW' : 'ACCEPT';
  else if (score >= regenerateFloor) decision = 'REGENERATE';
  else decision = 'FALLBACK_DEFAULT_FAMILY';
  return { score, decision, bar, hard_failures: hardFailures, measurable_points: measurable.points, judge_points: judgePts,
           judge_available: !!(judge && judge.available), score_basis: judge && judge.available ? 'measurable_60 + judge_40' : 'measurable_60 only (judge unavailable) — out of 60', scorer_version: SCORER_VERSION };
}

module.exports = { SCORER_VERSION, bandPoints, scoreMeasurable, finalize };
