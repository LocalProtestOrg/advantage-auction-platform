'use strict';

/**
 * creativeReference/indexer — reconciles the Owner's library folder with sidecar records BY CONTENT HASH, applies
 * the append-only Owner decisions ledger, validates + lints every sidecar, recomputes weights, writes index.json and
 * the human index, and (optionally) upserts marketing_creative_references. The Owner only ever moves/adds/deletes
 * image files or speaks to Desktop Marketing; this code owns every JSON file.
 *
 *   new image, no sidecar   → stub record (OWNER_APPROVED by folder placement, stub=true, task emitted); retrievable
 *                             for weight/count purposes only after Desktop Marketing writes the visual read (stubs
 *                             carry no transferable_lessons, so principles ignore them).
 *   moved / renamed         → current_path updated; status follows the folder ONLY when it changed by a folder move
 *                             (gold-standard/ → OWNER_GOLD_STANDARD, do-not-use/ → OWNER_DO_NOT_USE, plain → OWNER_APPROVED)
 *   missing file            → RETIRED (record kept for provenance)
 *   ledger entry            → applied once (hash of the line), status_history appended with the Owner's words
 */
const fs = require('fs');
const path = require('path');
const lib = require('./library');

const INDEXER_VERSION = '3P.1';

function todayIso() { return new Date().toISOString().slice(0, 10); }

function folderStatus(img) {
  if (img.subfolder === 'gold-standard') return 'OWNER_GOLD_STANDARD';
  if (img.subfolder === 'do-not-use') return 'OWNER_DO_NOT_USE';
  return 'OWNER_APPROVED';
}

function nextReferenceId(sidecars) {
  let max = 0;
  for (const s of sidecars) { const m = /^REF-(\d+)$/.exec((s.json || s).reference_id || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return 'REF-' + String(max + 1).padStart(2, '0');
}

function stubSidecar(img, sha, dims, refId) {
  const fc = dims ? lib.formatClass(dims.width, dims.height) : 'square';
  return {
    schema_version: '1.0', reference_id: refId,
    identity: { sha256: sha, current_path: img.rel, original_filename: img.filename, width: dims ? dims.width : 1, height: dims ? dims.height : 1, format_class: fc, aspect_ratio: dims ? Math.round((dims.width / dims.height) * 100) / 100 : 1 },
    owner_status: folderStatus(img), owner_weight: lib.weightFor(folderStatus(img)),
    status_history: [{ date: todayIso(), status: folderStatus(img), source: 'folder_placement_by_owner', owner_words: 'Owner placed the file in ' + img.category + '/' + (img.subfolder ? img.subfolder + '/' : ''), recorded_by: 'indexer ' + INDEXER_VERSION }],
    source: { seller: 'unknown', origin: 'Owner-placed image (visual read pending)', rights: 'Calibration evidence only. Never reproduce, never pass to a generator as image input, never publish.' },
    classification: { campaign_class_primary: lib.FOLDER_CLASS[img.category] || 'general_brand', campaign_class_secondary: [], owner_folder: img.category, event_product_type: 'unknown', seller_hierarchy: 'unknown', visual_family: 'SCENE_EXTRACTED', nearest_advantage_family: 'NONE', event_mode: 'unknown', merchandise_breadth: 'none' },
    visual_read: { visual_hierarchy: 'pending visual read', merchandise_treatment: 'pending', composition_style: 'pending', typography_treatment: 'pending', information_density: 'medium', branding_hierarchy: 'pending', cta_treatment: 'pending', footer_treatment: 'pending', photographic_style: 'pending', overlapping_objects: 'none', environmental_staged_composition: 'pending', negative_space: 'modest', ground: 'mixed', overall_visual_impact: 'moderate' },
    measured: { light_pixel_pct: 0, dark_pixel_pct: 0, saturated_pixel_pct: 0, dominant_hues: [], est_merchandise_share_pct: [0, 0], est_text_share_pct: [0, 0], object_count_est: 0, text_block_count: 0 },
    strongest_attributes: ['pending visual read'], transferable_lessons: ['pending visual read'], do_not_generalize: ['pending visual read'],
    text_density_assessment: { level: 'medium', why_it_works_here: 'pending', advantage_bid_budget_note: 'pending' },
    composition_assessment: { spatial_logic: 'pending', gravity_and_grounding: 'pending', depth: 'pending', scale_strategy: 'pending', edge_handling: 'pending' },
    retrieval: { use_cases: ['pending visual read'], tags: [], avoid_for: [] },
    performance: null,
    provenance: { created_by: 'indexer ' + INDEXER_VERSION, created_at: new Date().toISOString(), analysis_method: 'stub — pending Desktop Marketing visual read (no analysis performed)', phase: '3P' },
  };
}
const isStub = (sc) => /^stub/.test((sc.provenance && sc.provenance.analysis_method) || '');

/** Read + parse the ledger; each line hashed for idempotent application. */
function readLedger(root) {
  const p = path.join(root, 'owner-decisions.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    try { return { line, hash: lib.sha256Text(line), entry: JSON.parse(line) }; } catch (_) { return { line, hash: lib.sha256Text(line), entry: null, malformed: true }; }
  });
}

function applyLedgerEntry(entry, bySha, byRefId, applied, hash) {
  if (!entry || applied.has(hash)) return { applied: false, reason: applied.has(hash) ? 'already_applied' : 'malformed' };
  const targets = [];
  const res = entry.resolved || {};
  if (res.sha256 && bySha[res.sha256]) targets.push(bySha[res.sha256]);
  else if (res.reference_id && byRefId[res.reference_id]) targets.push(byRefId[res.reference_id]);
  for (const id of (res.reference_ids || [])) if (byRefId[id]) targets.push(byRefId[id]);
  if (entry.action === 'SET_STATUS' && lib.STATUSES.includes(entry.status) && lib.STATUS_SOURCES.includes(entry.source)) {
    for (const t of targets) {
      if (t.json.owner_status === entry.status) continue;
      t.json.owner_status = entry.status;
      t.json.status_history.push({ date: String(entry.ts || '').slice(0, 10) || todayIso(), status: entry.status, source: entry.source, owner_words: entry.owner_words || '', recorded_by: entry.recorded_by || 'ledger' });
      t.dirty = true;
    }
    return { applied: true, targets: targets.map((t) => t.json.reference_id) };
  }
  if (entry.action === 'RECLASSIFY' && targets.length && entry.payload && entry.payload.campaign_class_primary) {
    for (const t of targets) { t.json.classification.campaign_class_primary = entry.payload.campaign_class_primary; t.dirty = true; }
    return { applied: true, targets: targets.map((t) => t.json.reference_id) };
  }
  // LIBRARY_BASELINE / CALIBRATION_NOTE / ADD_GENERATED: recorded (mirror), no sidecar mutation here.
  return { applied: true, targets: targets.map((t) => t.json.reference_id), noop: true };
}

/**
 * Build the index. opts: { root, write (default true), db (optional runner for upserts), weights, appliedHashes (Set) }
 * Returns { index, tasks, foreign, problems, sidecarsWritten }.
 */
async function buildIndex(opts = {}) {
  const root = opts.root || lib.LIBRARY_ROOT;
  const write = opts.write !== false;
  const weights = opts.weights || lib.DEFAULT_WEIGHTS;
  const { images, sidecars, foreign } = lib.listLibrary(root);
  const bySha = {}; const byRefId = {};
  for (const sc of sidecars) { const sha = sc.json && sc.json.identity && sc.json.identity.sha256; if (sha) { bySha[sha] = sc; if (sc.json.reference_id) byRefId[sc.json.reference_id] = sc; } }
  const tasks = []; const problems = []; const seen = new Set();

  // 1. Images → reconcile by hash.
  for (const img of images) {
    const buf = fs.readFileSync(img.path); const sha = lib.sha256File(img.path); const dims = lib.imageDims(buf);
    seen.add(sha);
    let sc = bySha[sha];
    if (!sc) {
      const refId = nextReferenceId(sidecars);
      const json = stubSidecar(img, sha, dims, refId);
      sc = { path: img.path + lib.SIDECAR_SUFFIX, rel: img.rel + lib.SIDECAR_SUFFIX, json, dirty: true, isNew: true };
      sidecars.push(sc); bySha[sha] = sc; byRefId[refId] = sc;
      tasks.push({ task: 'write_visual_read', reference_id: refId, path: img.rel, note: 'new Owner-placed image indexed as ' + json.owner_status + ' (stub) — Desktop Marketing to write the visual read' });
      continue;
    }
    const j = sc.json;
    if (j.identity.current_path !== img.rel) { j.identity.current_path = img.rel; j.identity.original_filename = img.filename; sc.dirty = true; sc.moved = true; }
    if (j.classification.owner_folder !== img.category) { j.classification.owner_folder = img.category; sc.dirty = true; }
    // Folder placement drives status when the file sits in an explicit subfolder, or when it left one.
    const fstat = folderStatus(img);
    const lastSrc = (j.status_history[j.status_history.length - 1] || {}).source;
    const folderDriven = ['folder_placement_by_owner', 'owner_folder_move'].includes(lastSrc);
    if (j.owner_status === 'RETIRED' || (fstat !== j.owner_status && (img.subfolder || folderDriven))) {
      j.owner_status = fstat;
      j.status_history.push({ date: todayIso(), status: fstat, source: 'owner_folder_move', owner_words: 'Owner moved the file to ' + img.category + '/' + (img.subfolder ? img.subfolder + '/' : ''), recorded_by: 'indexer ' + INDEXER_VERSION });
      sc.dirty = true;
    }
    // Expected sidecar location: beside the image (moves carry the sidecar).
    const expectedSidecar = img.path + lib.SIDECAR_SUFFIX;
    if (path.resolve(sc.path) !== path.resolve(expectedSidecar)) { sc.relocateTo = expectedSidecar; sc.dirty = true; }
  }
  // 2. Sidecars whose image is gone → RETIRED.
  for (const sc of sidecars) {
    const sha = sc.json && sc.json.identity && sc.json.identity.sha256;
    if (sha && !seen.has(sha) && sc.json.owner_status !== 'RETIRED') {
      sc.json.owner_status = 'RETIRED';
      sc.json.status_history.push({ date: todayIso(), status: 'RETIRED', source: 'owner_folder_move', owner_words: 'file removed from the library', recorded_by: 'indexer ' + INDEXER_VERSION });
      sc.dirty = true;
    }
  }
  // 3. Ledger (idempotent by line hash).
  const applied = new Set(opts.appliedHashes || []);
  const ledger = readLedger(root); const ledgerResults = [];
  for (const l of ledger) {
    const r = applyLedgerEntry(l.entry, bySha, byRefId, applied, l.hash);
    ledgerResults.push({ hash: l.hash, ...r, action: l.entry && l.entry.action, source: l.entry && l.entry.source });
    if (r.applied) applied.add(l.hash);
  }
  // 4. Weights, validation, lint.
  const refs = [];
  for (const sc of sidecars) {
    const j = sc.json; if (!j) continue;
    const w = lib.weightFor(j.owner_status, weights);
    if (j.owner_weight !== w) { j.owner_weight = w; sc.dirty = true; }
    const v = lib.validateSidecar(j); const l = lib.lintSidecar(j);
    if (!v.valid) problems.push({ reference_id: j.reference_id, kind: 'schema', errors: v.errors.slice(0, 5) });
    if (!l.clean && !isStub(j)) problems.push({ reference_id: j.reference_id, kind: 'lint', errors: l.problems });
    refs.push(sc);
  }
  // 5. Write sidecars (machine-owned), index.json, human index.
  let written = 0;
  if (write) {
    for (const sc of refs) {
      if (!sc.dirty) continue;
      const target = sc.relocateTo || sc.path;
      fs.writeFileSync(target, JSON.stringify(sc.json, null, 2) + '\n');
      if (sc.relocateTo && path.resolve(sc.relocateTo) !== path.resolve(sc.path) && fs.existsSync(sc.path)) fs.unlinkSync(sc.path);
      written++;
    }
  }
  const index = composeIndex(refs.map((s) => s.json), root, weights, applied);
  index.tasks = tasks; index.foreign = foreign; index.problems = problems; index.ledger = ledgerResults.map((r) => ({ hash: r.hash.slice(0, 12), action: r.action, applied: r.applied, targets: r.targets }));
  if (write) {
    fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'OWNER-CREATIVE-REFERENCE-INDEX.md'), humanIndex(index));
  }
  if (opts.db) await upsertDb(opts.db, refs, index, ledger, applied);
  return { index, tasks, foreign, problems, sidecarsWritten: written };
}

function composeIndex(sidecars, root, weights, appliedHashes) {
  const active = sidecars.filter((j) => j.owner_status !== 'RETIRED');
  const count = (arr, fn) => arr.reduce((m, j) => { const k = fn(j); m[k] = (m[k] || 0) + 1; return m; }, {});
  const bySeller = count(active, (j) => j.source.seller);
  const dominant = Object.entries(bySeller).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  const profiles = {};
  for (const j of active) {
    if (isStub(j)) continue;
    const fam = j.classification.nearest_advantage_family; const p = profiles[fam] || (profiles[fam] = { references: [], est_merchandise_share_pct: [999, 0], est_text_share_pct: [999, 0], text_block_count: [999, 0], object_count_est: [999, 0], information_density: new Set(), ground: new Set() });
    p.references.push(j.reference_id);
    const m = j.measured;
    p.est_merchandise_share_pct = [Math.min(p.est_merchandise_share_pct[0], m.est_merchandise_share_pct[0]), Math.max(p.est_merchandise_share_pct[1], m.est_merchandise_share_pct[1])];
    p.est_text_share_pct = [Math.min(p.est_text_share_pct[0], m.est_text_share_pct[0]), Math.max(p.est_text_share_pct[1], m.est_text_share_pct[1])];
    p.text_block_count = [Math.min(p.text_block_count[0], m.text_block_count), Math.max(p.text_block_count[1], m.text_block_count)];
    p.object_count_est = [Math.min(p.object_count_est[0], m.object_count_est), Math.max(p.object_count_est[1], m.object_count_est)];
    p.information_density.add(j.visual_read.information_density); p.ground.add(j.visual_read.ground);
  }
  for (const p of Object.values(profiles)) { p.information_density = [...p.information_density]; p.ground = [...p.ground]; p.note = 'Bands are the union of visual estimates across the references in this family; they are calibration evidence, not targets to hit exactly.'; }
  const byClass = {}; for (const c of lib.CAMPAIGN_CLASSES) byClass[c] = active.filter((j) => j.classification.campaign_class_primary === c).map((j) => j.reference_id);
  const versionSeed = active.map((j) => j.identity.sha256 + ':' + j.owner_status + ':' + lib.sha256Text(JSON.stringify(j)).slice(0, 8)).sort().join('|');
  return {
    index_version: INDEXER_VERSION + '.' + lib.sha256Text(versionSeed).slice(0, 12),
    built_at: new Date().toISOString(), built_by: 'indexer ' + INDEXER_VERSION + ' (production creative reference system)',
    library_root: path.relative(path.join(__dirname, '..', '..', '..'), root).replace(/\\/g, '/'), schema: 'reference.schema.json',
    identity_rule: 'A reference is identified by identity.sha256 of the image bytes; current_path is informational and may change when the Owner moves a file.',
    counts: { references: active.length, retired: sidecars.length - active.length, stubs: active.filter(isStub).length, by_status: count(active, (j) => j.owner_status), by_owner_folder: count(active, (j) => j.classification.owner_folder), by_primary_class: count(active, (j) => j.classification.campaign_class_primary), by_visual_family: count(active, (j) => j.classification.visual_family), by_seller: bySeller },
    seller_concentration: { dominant_seller: dominant[0], share: active.length ? Math.round((dominant[1] / active.length) * 100) / 100 : 0, rule: 'When one seller supplies more than 60% of the retrieved references, only transferable_lessons reach the brief; seller identity facets are stripped.' },
    weighting: { owner_status_weights: Object.assign({}, lib.DEFAULT_WEIGHTS, weights || {}), relevance_factors: { primary: 1.0, secondary: 0.5, family_compatible_only: 0.25 }, effective_weight: 'owner_weight × relevance_factor × facet_similarity (0..1)', performance: 'Campaign performance is stored separately and never changes owner_status or owner_weight.' },
    class_map: byClass, empty_classes: lib.CAMPAIGN_CLASSES.filter((c) => byClass[c].length === 0),
    principle_profiles_by_advantage_family: profiles,
    global_transferable_profile: { references: active.filter((j) => !isStub(j)).map((j) => j.reference_id), light_ground_pct: pct(active, (j) => ['white', 'cream'].includes(j.visual_read.ground)), dark_ground_pct: pct(active, (j) => j.visual_read.ground === 'dark'), footer_band_pct: pct(active, (j) => /band/i.test(j.visual_read.footer_treatment || '')), median_text_block_count: median(active.map((j) => j.measured.text_block_count)) },
    applied_decisions: [...appliedHashes].sort(),
    references: sidecars.map((j) => ({ reference_id: j.reference_id, sha256: j.identity.sha256, path: j.identity.current_path, owner_status: j.owner_status, owner_weight: j.owner_weight, stub: isStub(j), seller: j.source.seller,
      campaign_class_primary: j.classification.campaign_class_primary, campaign_class_secondary: j.classification.campaign_class_secondary, owner_folder: j.classification.owner_folder,
      visual_family: j.classification.visual_family, nearest_advantage_family: j.classification.nearest_advantage_family, event_mode: j.classification.event_mode, merchandise_breadth: j.classification.merchandise_breadth,
      seller_hierarchy: j.classification.seller_hierarchy, format_class: j.identity.format_class, information_density: j.visual_read.information_density, ground: j.visual_read.ground,
      tags: j.retrieval.tags, avoid_for: j.retrieval.avoid_for, transferable_lessons: j.transferable_lessons, do_not_generalize: j.do_not_generalize, measured: j.measured, sidecar_hash: lib.sha256Text(JSON.stringify(j)) })),
  };
}
function pct(arr, fn) { return arr.length ? Math.round((arr.filter(fn).length / arr.length) * 100) : 0; }
function median(nums) { const s = nums.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }

function humanIndex(index) {
  const lines = ['# Owner Creative Reference Index', '', `Built ${index.built_at} · index_version ${index.index_version} · ${index.counts.references} active reference(s), ${index.counts.retired} retired, ${index.counts.stubs} awaiting a visual read.`, '',
    '| Ref | Status | Weight | Class | Family | Seller | Path |', '|---|---|---|---|---|---|---|'];
  for (const r of index.references) lines.push(`| ${r.reference_id} | ${r.owner_status} | ${r.owner_weight} | ${r.campaign_class_primary} | ${r.nearest_advantage_family} | ${r.seller} | ${r.path} |`);
  lines.push('', '## Empty classes (Owner review required until a first example is approved)', '', index.empty_classes.map((c) => '- ' + c).join('\n') || '- none', '');
  if (index.tasks.length) lines.push('## Tasks for Desktop Marketing', '', ...index.tasks.map((t) => `- ${t.reference_id}: ${t.note}`), '');
  if (index.problems.length) lines.push('## Problems', '', ...index.problems.map((p) => `- ${p.reference_id} (${p.kind}): ${p.errors.join('; ')}`), '');
  lines.push('_Generated by the indexer. The Owner never edits this file or any .reference.json._', '');
  return lines.join('\n');
}

async function upsertDb(db, refs, index, ledger, applied) {
  for (const sc of refs) {
    const j = sc.json; const c = j.classification;
    await db.query(
      `INSERT INTO marketing_creative_references (sha256, reference_id, current_path, owner_status, owner_weight, campaign_class_primary, campaign_class_secondary, owner_folder, visual_family, nearest_advantage_family, seller, stub, sidecar, sidecar_hash, index_version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15, now())
       ON CONFLICT (sha256) DO UPDATE SET reference_id=EXCLUDED.reference_id, current_path=EXCLUDED.current_path, owner_status=EXCLUDED.owner_status, owner_weight=EXCLUDED.owner_weight,
         campaign_class_primary=EXCLUDED.campaign_class_primary, campaign_class_secondary=EXCLUDED.campaign_class_secondary, owner_folder=EXCLUDED.owner_folder, visual_family=EXCLUDED.visual_family,
         nearest_advantage_family=EXCLUDED.nearest_advantage_family, seller=EXCLUDED.seller, stub=EXCLUDED.stub, sidecar=EXCLUDED.sidecar, sidecar_hash=EXCLUDED.sidecar_hash, index_version=EXCLUDED.index_version, updated_at=now()`,
      [j.identity.sha256, j.reference_id, j.identity.current_path, j.owner_status, j.owner_weight, c.campaign_class_primary, JSON.stringify(c.campaign_class_secondary || []), c.owner_folder, c.visual_family, c.nearest_advantage_family, j.source.seller, isStub(j), JSON.stringify(j), lib.sha256Text(JSON.stringify(j)), index.index_version]);
  }
  for (const l of ledger) {
    if (!l.entry) continue;
    await db.query(
      `INSERT INTO marketing_creative_reference_decisions (ledger_hash, ts, source, owner_words, resolved, action, status, payload, recorded_by, applied_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9, CASE WHEN $10 THEN now() ELSE NULL END) ON CONFLICT (ledger_hash) DO NOTHING`,
      [l.hash, l.entry.ts || null, l.entry.source || 'unknown', l.entry.owner_words || null, JSON.stringify(l.entry.resolved || {}), l.entry.action || 'UNKNOWN', l.entry.status || null, JSON.stringify(l.entry.payload || l.entry.note || {}), l.entry.recorded_by || null, applied.has(l.hash)]);
  }
}

/** Load the current index.json (built artifact) — retrieval reads this, never the images. */
function loadIndex(root) { return JSON.parse(fs.readFileSync(path.join(root || lib.LIBRARY_ROOT, 'index.json'), 'utf8')); }

module.exports = { INDEXER_VERSION, buildIndex, loadIndex, readLedger, stubSidecar, isStub, folderStatus, composeIndex, humanIndex };
