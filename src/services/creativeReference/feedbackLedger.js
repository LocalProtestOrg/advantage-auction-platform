'use strict';

/**
 * creativeReference/feedbackLedger — Deliverable 9. Durable Owner creative feedback in the Owner's own words → one
 * append-only ledger (owner-decisions.jsonl) + DB mirror + Owner review rows. Vocabulary is conceptual, never a
 * required keyword; ambiguity is surfaced (never guessed). A generated creative the Owner approves can be admitted to
 * the library with Advantage.Bid provenance (the only way the library grows). owner_status writes are limited to the
 * schema's Owner sources — performance has no path here (learning boundary #9).
 */
const fs = require('fs');
const path = require('path');
const lib = require('./library');
const indexer = require('./indexer');

const OWNER_SOURCES = new Set(lib.STATUS_SOURCES);
const VOCAB = [
  { re: /\b(gold standard|gold|perfect|that'?s it|love (this|it)|best of its kind)\b/i, action: 'SET_STATUS', status: 'OWNER_GOLD_STANDARD', review: 'gold' },
  { re: /\b(do ?n[o']t use|never (that|this|again)|not us|no more of|stop using)\b/i, action: 'SET_STATUS', status: 'OWNER_DO_NOT_USE', review: 'rejected' },
  { re: /\b(remove it|take it out|retire|delete it)\b/i, action: 'SET_STATUS', status: 'RETIRED', review: 'rejected' },
  { re: /\b(come back|bring (it )?back|reduce|smaller|less|increase|bigger|larger|more)\b/i, action: 'CALIBRATION_NOTE', review: 'note' },
  { re: /\b(good|approved?|like it|yes|keep|fine|ok(ay)?)\b/i, action: 'SET_STATUS', status: 'OWNER_APPROVED', review: 'approved' },
];
const ELEMENTS = ['title', 'headline', 'photo', 'photograph', 'merchandise', 'text', 'copy', 'logo', 'date', 'band', 'panel', 'plate'];

/** Map the Owner's words to a ledger action (never guesses between two plausible meanings → ambiguous). */
function mapOwnerWords(words) {
  const w = String(words || '').trim();
  const matches = VOCAB.filter((v) => v.re.test(w));
  if (!matches.length) return { action: 'AMBIGUOUS', question: 'Which do you mean: good / love this (gold standard) / do not use this style / a change such as "come back 10% on the title"?' };
  const statusMatch = matches.find((m) => m.action === 'SET_STATUS');
  const first = statusMatch || matches[0];
  const out = { action: first.action, status: first.status || null, review_status: first.review };
  if (first.action === 'CALIBRATION_NOTE') {
    const pct = /(\d{1,2})\s*%/.exec(w); const element = ELEMENTS.find((e) => new RegExp('\\b' + e + '\\b', 'i').test(w)) || null;
    const direction = /\b(come back|reduce|smaller|less)\b/i.test(w) ? 'smaller' : (/\b(increase|bigger|larger|more)\b/i.test(w) ? 'larger' : null);
    out.note = { element, direction, amount_pct: pct ? Number(pct[1]) : null };
    if (!element) out.question = 'Which element should change (title, photo, merchandise, text, date…)?';
  }
  // A "good" that also carries a change request is a note first (approval stays with the Owner's explicit word).
  if (matches.length > 1 && matches.some((m) => m.action === 'CALIBRATION_NOTE') && first.action !== 'CALIBRATION_NOTE') out.also_note = mapOwnerWords(w.replace(first.re, '')).note || null;
  return out;
}

/** Append one ledger entry (append-only; the Owner's words verbatim). Returns the entry + line hash. */
function appendDecision(entry, root) {
  root = root || lib.LIBRARY_ROOT;
  if (!OWNER_SOURCES.has(entry.source)) { const e = new Error('owner_status changes are permitted only from Owner sources: ' + [...OWNER_SOURCES].join(', ')); e.code = 'FORBIDDEN_SOURCE'; throw e; }
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry));
  fs.appendFileSync(path.join(root, 'owner-decisions.jsonl'), line + '\n');
  return { entry: JSON.parse(line), hash: lib.sha256Text(line) };
}

/** Record an Owner review of a generated creative (words → status + optional note) as a review row + ledger entry. */
async function recordOwnerReview({ creativeJobId, candidateKey, words, recordedBy = 'admin-ui', source = 'owner_review_of_generated_creative', root, db }) {
  const mapped = mapOwnerWords(words);
  const status = mapped.review_status || 'note';
  const ledger = appendDecision({ source, owner_words: words, resolved: { creative_job_id: creativeJobId, candidate_key: candidateKey }, action: mapped.action, status: mapped.status || null, note: mapped.note || mapped.also_note || null, recorded_by: recordedBy }, root);
  if (db) {
    await db.query(`INSERT INTO marketing_creative_owner_reviews (creative_job_id, candidate_key, status, owner_words, note, source, recorded_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [creativeJobId, candidateKey || null, status, words, JSON.stringify(mapped.note || mapped.also_note || null), source, recordedBy]);
    if (['approved', 'gold'].includes(status)) await db.query(`UPDATE marketing_creative_calibrations SET publication_status='OWNER_APPROVED' WHERE creative_job_id=$1 AND ($2::text IS NULL OR candidate_key=$2) AND publication_status='HELD_FOR_OWNER_REVIEW'`, [creativeJobId, candidateKey || null]);
    if (status === 'rejected') await db.query(`UPDATE marketing_creative_calibrations SET publication_status='OWNER_REJECTED' WHERE creative_job_id=$1 AND ($2::text IS NULL OR candidate_key=$2)`, [creativeJobId, candidateKey || null]);
  }
  return { mapped, status, ledger_hash: ledger.hash, question: mapped.question || null };
}

/**
 * Admit an Owner-approved generated creative to the library: copy the render into the category folder with a stable
 * name and generate its sidecar from the brief/metrics/calibration (Advantage.Bid provenance). Rebuilds the index.
 */
async function admitGeneratedCreative({ renderPath, category, campaignClass, brief, metrics, calibration, ownerWords, status = 'OWNER_APPROVED', jobId, candidateKey, root, db }) {
  root = root || lib.LIBRARY_ROOT;
  if (!lib.CATEGORY_FOLDERS.includes(category)) throw new Error('unknown category folder: ' + category);
  const sub = status === 'OWNER_GOLD_STANDARD' ? 'gold-standard' : null;
  const dir = path.join(root, category, sub || ''); fs.mkdirSync(dir, { recursive: true });
  const name = `advantagebid-${campaignClass}-${new Date().toISOString().slice(0, 10)}-${String(jobId).replace(/[^a-z0-9]/gi, '').slice(0, 12)}${candidateKey ? '-' + candidateKey : ''}.png`;
  const dest = path.join(dir, name); fs.copyFileSync(renderPath, dest);
  const buf = fs.readFileSync(dest); const sha = lib.sha256File(dest); const dims = lib.imageDims(buf) || { width: 1080, height: 1350 };
  const cal = calibration || {}; const pp = cal.principle_profile || {};
  const sidecar = {
    schema_version: '1.0', reference_id: nextId(root),
    identity: { sha256: sha, current_path: path.relative(root, dest).replace(/\\/g, '/'), original_filename: name, width: dims.width, height: dims.height, format_class: lib.formatClass(dims.width, dims.height), aspect_ratio: Math.round((dims.width / dims.height) * 100) / 100 },
    owner_status: status, owner_weight: lib.weightFor(status),
    status_history: [{ date: new Date().toISOString().slice(0, 10), status, source: 'owner_review_of_generated_creative', owner_words: String(ownerWords || ''), recorded_by: 'feedbackLedger' }],
    source: { seller: 'Advantage.Bid', origin: `generated by the production creative engine, job ${jobId}${candidateKey ? ' candidate ' + candidateKey : ''}, Owner-approved`, rights: 'Advantage.Bid-owned creative; calibration evidence; merchandise/photograph provenance in the creative job.', advantage_bid_visible: true },
    classification: { campaign_class_primary: campaignClass, campaign_class_secondary: [], owner_folder: category, event_product_type: (brief && brief.event && brief.event.title) || 'generated creative', seller_hierarchy: (brief && brief.seller_hierarchy) || 'advantage_bid_only', visual_family: brief && brief.family === 'ENVIRONMENTAL_PHOTO' ? 'ENVIRONMENTAL_ROOM' : (brief && brief.family === 'LEFT_THIRD_WHITE' ? 'LEFT_PANEL_EXTRACTED' : 'SCENE_EXTRACTED'), nearest_advantage_family: brief && brief.family === 'ACQUISITION' ? 'NONE' : ((brief && brief.family) || 'CENTERED_WHITE'), event_mode: (brief && brief.event && brief.event.online_only === false) ? 'on_site' : 'unknown', merchandise_breadth: brief && brief.merchandise_mode === 'representative' ? 'representative_non_lot' : 'broad' },
    visual_read: { visual_hierarchy: (pp.hierarchy || []).join('; ') || 'derived from brief', merchandise_treatment: (pp.merchandise && pp.merchandise.treatment) || 'derived from brief', composition_style: 'family ' + ((brief && brief.family) || ''), typography_treatment: 'brand faces; ' + ((pp.typography && pp.typography.rule) || ''), information_density: (metrics && metrics.text_blocks > 5) ? 'high' : 'medium', branding_hierarchy: (brief && brief.seller_hierarchy) || 'advantage_bid_only', cta_treatment: 'factual or none', footer_treatment: 'navy Advantage.Bid band', photographic_style: brief && brief.merchandise_mode === 'photograph' ? 'event site photograph' : 'n/a', overlapping_objects: 'light', environmental_staged_composition: brief && brief.merchandise_mode === 'photograph' ? 'environmental' : 'staged', negative_space: 'modest', ground: 'white', overall_visual_impact: 'high' },
    measured: { light_pixel_pct: 0, dark_pixel_pct: 0, saturated_pixel_pct: 0, dominant_hues: [], est_merchandise_share_pct: [Math.floor(metrics ? metrics.merchandise_pct : 0), Math.ceil(metrics ? metrics.merchandise_pct : 0)], est_text_share_pct: [Math.floor(metrics ? metrics.text_region_pct : 0), Math.ceil(metrics ? metrics.text_region_pct : 0)], object_count_est: (metrics && metrics.objects) || 0, text_block_count: (metrics && metrics.text_blocks) || 0 },
    strongest_attributes: (pp.transferable_lessons || ['Owner-approved generated creative']).slice(0, 4),
    transferable_lessons: (pp.transferable_lessons && pp.transferable_lessons.length ? pp.transferable_lessons : ['principles as briefed; see calibration record']).slice(0, 6),
    do_not_generalize: ['event-specific title, date, place and merchandise of this creative'],
    text_density_assessment: { level: (metrics && metrics.text_blocks > 5) ? 'high' : 'medium', why_it_works_here: 'measured on the render', advantage_bid_budget_note: 'within the briefed profile' },
    composition_assessment: { spatial_logic: 'per family audit', gravity_and_grounding: 'per family audit', depth: 'per family audit', scale_strategy: 'per family audit', edge_handling: 'per family audit' },
    retrieval: { use_cases: [campaignClass], tags: ['advantage-bid', (brief && brief.family || '').toLowerCase()].filter(Boolean), avoid_for: [] },
    performance: null,
    provenance: { created_by: 'feedbackLedger (production creative engine)', created_at: new Date().toISOString(), analysis_method: 'derived from brief, audit and metrics', phase: '3P' },
  };
  fs.writeFileSync(dest + lib.SIDECAR_SUFFIX, JSON.stringify(sidecar, null, 2) + '\n');
  appendDecision({ source: 'owner_review_of_generated_creative', owner_words: String(ownerWords || ''), resolved: { creative_job_id: jobId, candidate_key: candidateKey, sha256: sha, reference_id: sidecar.reference_id }, action: 'ADD_GENERATED', status, recorded_by: 'feedbackLedger' }, root);
  const built = await indexer.buildIndex({ root, db });
  return { reference_id: sidecar.reference_id, sha256: sha, path: sidecar.identity.current_path, index_version: built.index.index_version };
}
function nextId(root) { const idx = indexer.loadIndex(root); let max = 0; for (const r of idx.references) { const m = /^REF-(\d+)$/.exec(r.reference_id); if (m) max = Math.max(max, +m[1]); } return 'REF-' + String(max + 1).padStart(2, '0'); }

module.exports = { mapOwnerWords, appendDecision, recordOwnerReview, admitGeneratedCreative, VOCAB };
