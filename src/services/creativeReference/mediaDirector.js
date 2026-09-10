'use strict';

/**
 * creativeReference/mediaDirector — Phase 3P.1 Mission 2 + 3P.2 alignment: the Authentic Media-First Creative Director.
 * Config: docs/marketing/phase3p1/config/media-source-hierarchy.json (+ phase3p2 authentic-media-alignment.json).
 *
 * For an event-specific campaign the Director evaluates the event's own media BEFORE a collage may be planned:
 *   1 cover image · 2 walkthrough-video frame · 3 one strong environmental photograph · 4 several · 5 editorial object
 *   composition (incl. lot photography) · 6 restrained branded factual creative.
 * Provenance is a hard gate (asset bound to the campaign's event_id with source, retrieval time and rights) — an asset
 * that cannot be bound is EXCLUDED, not scored low. Composed seller graphics (headline-class text) fail is_photograph
 * and go to the published-anchor role. Hard gates first (a failed gate = not ready), then the tier's 100-point score;
 * readiness 70; tier walk 1→6; a lower tier overrides a higher one only with a recorded reason and a > 10 point gap.
 * Clutter and invitation come from the vision judge with the config's named item list (no object detector ships in
 * this runtime — recorded as the stand-in). Output: brief.media_decision with the full trail.
 */
const fs = require('fs');
const HIER = require('../../../docs/marketing/phase3p1/config/media-source-hierarchy.json');
const bridge = require('./engineBridge');

const READY = HIER.readiness_threshold;
const CLUTTER_ITEMS = ['cardboard boxes', 'cables', 'plastic bags', 'price stickers', 'people', 'phones', 'trash', 'cleaning items'];

function provenanceOk(a, eventId) {
  const p = a.provenance || {};
  const missing = ['asset_sha256', 'event_id', 'uploaded_by_or_source_page', 'retrieved_at', 'rights'].filter((k) => {
    if (k === 'asset_sha256') return !(a.asset_sha256 || p.sha256);
    if (k === 'uploaded_by_or_source_page') return !(p.source_page || p.uploaded_by || p.source_url);
    if (k === 'event_id') return !(p.event_id || a.event_id);
    return !p[k];
  });
  const bound = (p.event_id || a.event_id) === eventId;
  return { ok: missing.length === 0 && bound, missing, bound };
}

/** Vision-judge stand-in for clutter + invitation (two runs averaged); returns null when unavailable (never invented). */
async function judgeScene(pngPath, { client = null, model } = {}) {
  let Anthropic, c = client;
  if (!c) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    try { Anthropic = require('@anthropic-ai/sdk'); c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch (_) { return null; }
  }
  const mdl = model || process.env.CREATIVE_JUDGE_MODEL || 'claude-sonnet-5';
  const prompt = 'You are checking a real estate-sale room photograph for advertising readiness. Count instances of these clutter items that are clearly visible: ' + CLUTTER_ITEMS.join(', ') +
    '. Also say whether any person, hand or phone is in the frame, whether a foreground object obstructs more than 5% of the frame, and rate invitation 0-4 (would a buyer want to walk into this room). ' +
    'Reply ONLY with compact JSON: {"clutter":{"cardboard boxes":0,...},"obstruction_over_5pct":false,"person_or_hand":false,"invitation":0,"note":"<=15 words"}';
  const b64 = fs.readFileSync(pngPath).toString('base64');
  const media = /\.png$/i.test(pngPath) ? 'image/png' : 'image/jpeg';
  const runs = [];
  for (let i = 0; i < 2; i++) {
    try {
      const res = await c.messages.create({ model: mdl, max_tokens: 600, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media, data: b64 } }, { type: 'text', text: prompt }] }] });
      const t = (res.content || []).map((x) => x.text || '').join(''); const m = t.match(/\{[\s\S]*\}/);
      if (m) runs.push(JSON.parse(m[0]));
    } catch (_) { /* a failed run is simply absent */ }
  }
  if (!runs.length) return null;
  const count = (r) => Object.values(r.clutter || {}).reduce((a, v) => a + (Number(v) || 0), 0);
  return { model: mdl, runs: runs.length, clutter_items: Math.round(runs.reduce((a, r) => a + count(r), 0) / runs.length), invitation: runs.reduce((a, r) => a + (Number(r.invitation) || 0), 0) / runs.length,
           obstruction: runs.some((r) => r.obstruction_over_5pct === true || r.person_or_hand === true), notes: runs.map((r) => r.note).filter(Boolean), items: runs.map((r) => r.clutter) };
}

function tier3Score(m, judged, requiredAspect) {
  const W = HIER.tiers[2].scored_criteria;
  const sharp = W.sharpness * Math.min(1, m.sharpness_norm / 0.8);
  const expo = W.exposure_and_colour * Math.max(0, 1 - Math.abs(m.luminance - 140) / 90 - m.clipped_pct / 30 - m.dark_pct / 100);
  const vis = W['merchandise_visibility_and_variety'] * (judged ? Math.min(1, 0.5 + judged.invitation / 8) : 0.6);
  const clutter = W['clutter_free (boxes, cables, bags, people, tags)'] * (judged ? Math.max(0, 1 - Math.min(18, 3 * judged.clutter_items) / 18) : 0.5);
  const inv = W.invitation * (judged ? judged.invitation / 4 : 0.5);
  const fit = m.crop_fit_required != null ? m.crop_fit_required : Math.max(m.crop_fit['4:5'], m.crop_fit['1:1']);
  const aspect = W['aspect_suitability'] * Math.min(1, fit / 0.75);
  const rep = W['representative_value'] * (judged ? Math.min(1, judged.invitation / 3) : 0.5);
  return Math.round((sharp + Math.max(0, expo) + vis + clutter + inv + aspect + rep) * 10) / 10;
}

/**
 * event: { id }; media: { cover: {path, provenance, asset_sha256} | null, videos: [{path, provenance, frame_selection?}],
 *          site_photographs: [...], lot_photographs: [...], clean_objects: n }
 * opts: { judge (bool), requiredAspect (band aspect of the chosen family), client }
 */
async function decide(event, media, opts = {}) {
  const trail = []; const excluded = [];
  const eligible = (list, kind) => (list || []).filter((a) => {
    const pv = provenanceOk(a, event.id);
    if (!pv.ok) excluded.push({ kind, asset: a.name || a.path, reason: pv.bound ? 'provenance incomplete: ' + pv.missing.join(', ') : 'not bound to event ' + event.id });
    return pv.ok;
  });
  const cover = media.cover ? eligible([media.cover], 'cover')[0] : null;
  const photos = eligible(media.site_photographs, 'site_photograph');
  const videos = eligible(media.videos, 'video');
  const lotPhotos = eligible(media.lot_photographs, 'lot_photograph');
  const paths = [cover, ...photos].filter(Boolean).map((a) => a.path);
  const meas = paths.length ? await bridge.call({ op: 'media_measure', paths, options: { ocr: true, distinctness: true, required_aspects: opts.requiredAspect ? [opts.requiredAspect] : [] } }, { timeoutMs: 240000 }) : { ok: true, results: [] };
  const byPath = new Map(((meas && meas.results) || []).map((r) => [r.path, r]));
  let anchor = null;
  const cands = [];
  const consider = async (a, tier, kind) => {
    const m = byPath.get(a.path); if (!m) return;
    if (m.is_photograph === false) {                                   // composed seller graphic → published-anchor role
      anchor = anchor || { asset_sha256: a.asset_sha256 || (a.provenance || {}).sha256, path: a.path, role: 'published_anchor', reason: 'composed graphic: headline-class text (' + (m.headline_text || []).slice(0, 3).join(' / ') + ')' };
      trail.push({ tier, kind, asset: a.name || a.path, routed: 'anchor_role', reason: 'is_photograph = false (text class ' + m.text_class + ')' });
      return;
    }
    const minEdge = tier === 1 ? 1200 : 1080; const sharpFloor = tier === 1 ? 0.35 : 0.30;
    const gates = { min_long_edge: m.long_edge >= minEdge, sharpness: m.sharpness_norm >= sharpFloor && m.laplacian_var >= 150, clipped: m.clipped_pct <= 6, dark: m.dark_pct <= 25,
                    text: ['none', 'watermark', 'price_tags'].includes(m.text_class) };
    let judged = null;
    if (opts.judge && Object.values(gates).every(Boolean)) judged = await judgeScene(a.path, { client: opts.client });
    if (judged && judged.obstruction) gates.obstruction = false;
    const ready = Object.values(gates).every(Boolean);
    const score = ready ? tier3Score(m, judged, opts.requiredAspect) : null;
    cands.push({ tier, kind, asset: a.name || a.path, path: a.path, asset_sha256: a.asset_sha256 || (a.provenance || {}).sha256, gates, score, ready: ready && score >= READY,
                 measures: { laplacian_var: m.laplacian_var, sharpness_norm: m.sharpness_norm, luminance: m.luminance, clipped_pct: m.clipped_pct, dark_pct: m.dark_pct, text_class: m.text_class, crop_fit: m.crop_fit, nearest_other_distance: m.nearest_other_distance },
                 judged: judged ? { clutter_items: judged.clutter_items, invitation: judged.invitation, obstruction: judged.obstruction, notes: judged.notes, model: judged.model } : (opts.judge ? 'unavailable' : 'not_requested') });
  };
  if (cover) await consider(cover, 1, 'cover');
  for (const p of photos) await consider(p, 3, 'site_photograph');
  // tier 2: walkthrough video frames (selection pipeline result supplied per video)
  for (const v of videos) {
    const fs_ = v.frame_selection;
    if (!fs_) { trail.push({ tier: 2, kind: 'video', asset: v.name || v.path, routed: 'not_evaluated', reason: 'frame selection not run' }); continue; }
    cands.push({ tier: 2, kind: 'video_frame', asset: (v.name || v.path) + '@' + fs_.selected_timestamp_ms + 'ms', score: fs_.shortlist && fs_.shortlist[0] ? fs_.shortlist[0].score : null, ready: !!fs_.ready && fs_.shortlist[0] && fs_.shortlist[0].score >= READY, video_frame_selection: fs_ });
  }
  const tiers = [1, 2, 3];
  let chosen = null;
  for (const t of tiers) {
    const r = cands.filter((c) => c.tier === t && c.ready).sort((a, b) => b.score - a.score);
    if (r.length) { chosen = r[0]; break; }
  }
  const readyPhotos = cands.filter((c) => c.tier === 3 && c.ready).sort((a, b) => b.score - a.score);
  const distinct = readyPhotos.filter((c) => (c.measures.nearest_other_distance || 0) >= 0.35);
  let tierSelected = chosen ? chosen.tier : null;
  const tier4 = readyPhotos.length >= 2 && distinct.length >= 2;
  if (!chosen) {
    if (lotPhotos.length || (media.clean_objects || 0) >= 3) tierSelected = 5; else tierSelected = 6;
  }
  const decision = {
    event_id: event.id, tier_selected: tierSelected, selected_asset_sha256: chosen ? chosen.asset_sha256 : null, selected_asset: chosen ? chosen.asset : null,
    tier4_available: tier4, tier4_reserved_for: tier4 ? 'a MID-wave creative with the second-best distinct photograph (sequential, never a 3-tile grid)' : null,
    candidates: cands.map((c) => Object.assign({}, c, { path: undefined })), excluded, published_anchor: anchor,
    override_reason: null,
    collage_considered: tierSelected >= 5, collage_reason: chosen ? `authentic ${chosen.kind === 'video_frame' ? 'video frame' : 'photograph'} ready at tier ${chosen.tier} (Owner rule: a real photograph taken by a person beats manufactured composition)` : (tierSelected === 5 ? 'no authentic media ≥ ' + READY + ' — editorial composition of this event\'s own objects' : 'no authentic media and no objects — restrained factual creative (never a manufactured collage)'),
    owner_review_required: (tierSelected === 2) || cands.every((c) => (c.score || 0) < 60),
    clutter_invitation_source: opts.judge ? 'vision judge (named item list) — no object detector ships in this runtime' : 'not judged',
    readiness_threshold: READY, trail,
  };
  decision.merchandise_mode = tierSelected <= 4 ? 'photograph' : (tierSelected === 5 ? 'lots' : 'none');
  return decision;
}

module.exports = { decide, provenanceOk, tier3Score, judgeScene, CLUTTER_ITEMS, READY };
