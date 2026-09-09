'use strict';

/**
 * Phase 3P — Owner Creative Reference System: indexing by content hash (add/move/rename/delete/stub/ledger/foreign),
 * schema + lint, retrieval (deterministic, avoid_for, Gold weighting, negatives, empty class, seller concentration),
 * principle extraction (identity stripped), family selection (scatter ration, environmental eligibility), brief
 * cross-checks, gates (seller-mark leak, provenance, anti-similarity incl. a reference-as-candidate), scorer bands
 * and decisions, feedback vocabulary + ledger (Owner sources only), judge-unavailable honesty, publish isolation, and
 * (when Python is available) the real renderers + signatures.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-3p';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const lib = require('../src/services/creativeReference/library');
const indexer = require('../src/services/creativeReference/indexer');
const retriever = require('../src/services/creativeReference/retriever');
const principles = require('../src/services/creativeReference/principles');
const gates = require('../src/services/creativeReference/gates');
const scorer = require('../src/services/creativeReference/scorer');
const familySelector = require('../src/services/creativeReference/familySelector');
const briefValidator = require('../src/services/creativeReference/briefValidator');
const feedback = require('../src/services/creativeReference/feedbackLedger');
const judge = require('../src/services/creativeReference/judge');
const bridge = require('../src/services/creativeReference/engineBridge');

const REAL = lib.LIBRARY_ROOT;
const PY = bridge.PYTHON;
const pythonOk = (() => { try { const r = spawnSync(PY, ['-c', 'import PIL, numpy'], { encoding: 'utf8' }); return r.status === 0; } catch (_) { return false; } })();

// Copy the real library into a temp folder so tests can add/move/delete without touching the Owner's folder.
function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3p-lib-'));
  const copy = (src, dst) => { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) { const s = path.join(src, n), d = path.join(dst, n); if (fs.statSync(s).isDirectory()) copy(s, d); else fs.copyFileSync(s, d); } };
  copy(REAL, dir);
  return dir;
}
const listImgs = (dir) => lib.listLibrary(dir).images;

describe('library — identity + schema + lint', () => {
  test('all 13 delivered sidecars validate; identity = sha256 of the image bytes; dims parsed for jpg/jfif/png', () => {
    const { images, sidecars, foreign } = lib.listLibrary(REAL);
    expect(images.length).toBe(13); expect(sidecars.length).toBe(13); expect(foreign).toEqual([]);
    for (const sc of sidecars) {
      const v = lib.validateSidecar(sc.json); expect(v.errors).toEqual([]);
      const img = images.find((i) => i.rel === sc.json.identity.current_path); expect(img).toBeTruthy();
      expect(lib.sha256File(img.path)).toBe(sc.json.identity.sha256);
      const dims = lib.imageDims(fs.readFileSync(img.path)); expect(dims.width).toBe(sc.json.identity.width); expect(dims.height).toBe(sc.json.identity.height);
    }
  });
  test('lint: hex colour / pixel value / typeface / seller mark in transferable_lessons fail; a % range is only a warning', () => {
    const base = JSON.parse(fs.readFileSync(path.join(REAL, 'estate-sale', '703633034_1679829177020529_6716087826834201503_n.jpg.reference.json'), 'utf8'));
    expect(lib.lintSidecar(base).clean).toBe(true);
    for (const bad of ['use #7a1f2b for the title band', 'title at 120px', 'set the title in Playfair Display', 'copy the Lewis & Maese crest']) {
      const s = JSON.parse(JSON.stringify(base)); s.transferable_lessons.push(bad); expect(lib.lintSidecar(s).clean).toBe(false);
    }
    const w = JSON.parse(JSON.stringify(base)); w.transferable_lessons.push('merchandise can run ~65–70% of the canvas'); const l = lib.lintSidecar(w); expect(l.clean).toBe(true); expect(l.warnings.length).toBe(1);
  });
  test('status_history.source outside the Owner sources fails schema (performance can never write a status)', () => {
    const s = JSON.parse(fs.readFileSync(path.join(REAL, 'estate-sale', '703633034_1679829177020529_6716087826834201503_n.jpg.reference.json'), 'utf8'));
    s.status_history.push({ date: '2026-09-09', status: 'OWNER_GOLD_STANDARD', source: 'performance', recorded_by: 'learning' });
    expect(lib.validateSidecar(s).valid).toBe(false);
  });
});

describe('indexer — reconcile by content hash; Owner never edits JSON', () => {
  let dir; beforeEach(() => { dir = tempLibrary(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('baseline: 13 references, weights recomputed, ledger baseline applied once, index.json + human index written', async () => {
    const r = await indexer.buildIndex({ root: dir });
    expect(r.index.counts.references).toBe(13); expect(r.index.counts.by_status.OWNER_APPROVED).toBe(13);
    expect(r.index.empty_classes).toEqual(expect.arrayContaining(['individual_seller_acquisition', 'professional_seller_acquisition', 'buyer_platform_growth', 'closing_soon']));
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true); expect(fs.existsSync(path.join(dir, 'OWNER-CREATIVE-REFERENCE-INDEX.md'))).toBe(true);
    expect(r.index.ledger.filter((l) => l.applied).length).toBe(1);
    const again = await indexer.buildIndex({ root: dir, appliedHashes: r.index.applied_decisions });
    expect(again.index.ledger[0].applied).toBe(false); expect(again.index.index_version).toBe(r.index.index_version); // deterministic + idempotent
  });
  test('rename + move to gold-standard/ → same record (hash), path updated, GOLD status + history + weight 2.0', async () => {
    const img = listImgs(dir).find((i) => i.category === 'estate-sale');
    const gold = path.join(dir, 'estate-sale', 'gold-standard'); fs.mkdirSync(gold, { recursive: true });
    fs.renameSync(img.path, path.join(gold, 'renamed-by-owner.jpg')); fs.renameSync(img.path + lib.SIDECAR_SUFFIX, path.join(dir, 'estate-sale', 'stray' + lib.SIDECAR_SUFFIX)); // sidecar left behind, renamed
    const r = await indexer.buildIndex({ root: dir });
    const ref = r.index.references.find((x) => x.path === 'estate-sale/gold-standard/renamed-by-owner.jpg');
    expect(ref).toBeTruthy(); expect(ref.reference_id).toBe('REF-09'); expect(ref.owner_status).toBe('OWNER_GOLD_STANDARD'); expect(ref.owner_weight).toBe(2.0);
    const sidecar = JSON.parse(fs.readFileSync(path.join(gold, 'renamed-by-owner.jpg' + lib.SIDECAR_SUFFIX), 'utf8'));
    expect(sidecar.status_history[sidecar.status_history.length - 1]).toMatchObject({ status: 'OWNER_GOLD_STANDARD', source: 'owner_folder_move' });
    expect(fs.existsSync(path.join(dir, 'estate-sale', 'stray' + lib.SIDECAR_SUFFIX))).toBe(false); // sidecar follows the image
    expect(r.index.counts.references).toBe(13);
  });
  test('move to do-not-use/ → negative evidence (-1.0); delete → RETIRED (record kept); new image → stub + task; foreign file reported not indexed', async () => {
    const imgs = listImgs(dir); const a = imgs.find((i) => i.category === 'auction'); const b = imgs.filter((i) => i.category === 'auction')[1];
    const dnu = path.join(dir, 'auction', 'do-not-use'); fs.mkdirSync(dnu); fs.renameSync(a.path, path.join(dnu, a.filename)); fs.renameSync(a.path + lib.SIDECAR_SUFFIX, path.join(dnu, a.filename + lib.SIDECAR_SUFFIX));
    fs.unlinkSync(b.path);
    fs.copyFileSync(imgs.find((i) => i.category === 'notable-lot').path, path.join(dir, 'individual-seller', 'new-owner-pick.jpg')); // a fresh file → hashes differently? (same bytes) → copy a mutated file instead
    fs.appendFileSync(path.join(dir, 'individual-seller', 'new-owner-pick.jpg'), Buffer.from([0xff, 0xd9, 0x00]));
    fs.mkdirSync(path.join(dir, 'not-a-category')); fs.copyFileSync(imgs[2].path, path.join(dir, 'not-a-category', 'x.jpg'));
    const r = await indexer.buildIndex({ root: dir });
    const neg = r.index.references.find((x) => x.reference_id === JSON.parse(fs.readFileSync(path.join(dnu, a.filename + lib.SIDECAR_SUFFIX), 'utf8')).reference_id);
    expect(neg.owner_status).toBe('OWNER_DO_NOT_USE'); expect(neg.owner_weight).toBe(-1);
    const retired = r.index.references.find((x) => x.owner_status === 'RETIRED'); expect(retired).toBeTruthy(); expect(r.index.counts.retired).toBe(1);
    const stub = r.index.references.find((x) => x.stub); expect(stub).toBeTruthy(); expect(stub.owner_status).toBe('OWNER_APPROVED'); expect(stub.campaign_class_primary).toBe('individual_seller_acquisition');
    expect(r.tasks.length).toBe(1); expect(r.tasks[0].task).toBe('write_visual_read');
    expect(r.foreign.length).toBe(1); expect(r.foreign[0].rel).toBe('not-a-category/x.jpg');
    expect(fs.existsSync(path.join(dir, 'individual-seller', 'new-owner-pick.jpg' + lib.SIDECAR_SUFFIX))).toBe(true); // stub written by the system, not the Owner
  });
  test('ledger: an Owner statement promotes to GOLD once (idempotent), with the Owner words in history', async () => {
    fs.appendFileSync(path.join(dir, 'owner-decisions.jsonl'), JSON.stringify({ ts: '2026-09-10T00:00:00Z', source: 'owner_statement_via_desktop_marketing', owner_words: 'the Fine Art & Antiques one is the gold standard', resolved: { reference_id: 'REF-02' }, action: 'SET_STATUS', status: 'OWNER_GOLD_STANDARD', recorded_by: 'desktop-marketing' }) + '\n');
    const r = await indexer.buildIndex({ root: dir });
    const ref = r.index.references.find((x) => x.reference_id === 'REF-02'); expect(ref.owner_status).toBe('OWNER_GOLD_STANDARD'); expect(ref.owner_weight).toBe(2);
    const sc = JSON.parse(fs.readFileSync(path.join(dir, ref.path + lib.SIDECAR_SUFFIX), 'utf8'));
    expect(sc.status_history[sc.status_history.length - 1].owner_words).toMatch(/gold standard/);
    const r2 = await indexer.buildIndex({ root: dir, appliedHashes: r.index.applied_decisions });
    const sc2 = JSON.parse(fs.readFileSync(path.join(dir, ref.path + lib.SIDECAR_SUFFIX), 'utf8'));
    expect(sc2.status_history.length).toBe(sc.status_history.length); // not re-applied
    expect(r2.index.references.find((x) => x.reference_id === 'REF-02').owner_status).toBe('OWNER_GOLD_STANDARD');
  });
});

describe('retriever — campaign-aware, bounded, honest about empty classes', () => {
  const index = indexer.loadIndex(REAL);
  const WU = { campaign_class: 'estate_sale', seller_hierarchy: 'seller_led_cobranded', event_mode: 'on_site', merchandise_breadth: 'broad', format_class: 'portrait', requested_family: 'ENVIRONMENTAL_PHOTO', families_allowed: ['ENVIRONMENTAL_PHOTO', 'LEFT_THIRD_WHITE'], tags: ['environmental', 'room-photo', 'place-plate', 'portrait', 'bands', 'left-panel'] };
  test('West University: REF-09/REF-10 primary first; ≤ 5; deterministic; avoid_for excludes the single-lot/scatter/atmospheric references', () => {
    const a = retriever.retrieve(index, WU); const b = retriever.retrieve(index, WU);
    expect(a.retrieved.map((r) => r.reference_id)).toEqual(b.retrieved.map((r) => r.reference_id));
    expect(a.retrieved.length).toBeLessThanOrEqual(5);
    expect(a.retrieved.slice(0, 2).map((r) => r.reference_id).sort()).toEqual(['REF-09', 'REF-10']);
    expect(a.excluded_by_avoid_for).toEqual(expect.arrayContaining(['REF-08', 'REF-11', 'REF-12']));
    expect(a.confidence).toBe('HIGH'); expect(a.empty_class).toBe(false);
    expect(a.strip_seller_identity).toBe(true); expect(a.seller_concentration.share).toBe(1);
    expect(a.owner_review_required).toBe(false);
  });
  test('empty class → [] + LOW + owner review + neutral lessons at 0.25 (never fabricated calibration)', () => {
    const r = retriever.retrieve(index, { campaign_class: 'individual_seller_acquisition', event_mode: 'not_an_event', merchandise_breadth: 'representative_non_lot', format_class: 'portrait', tags: ['breadth', 'light-ground'] });
    expect(r.retrieved).toEqual([]); expect(r.empty_class).toBe(true); expect(r.confidence).toBe('LOW'); expect(r.owner_review_required).toBe(true);
    expect(r.neutral_fallback.length).toBeGreaterThan(0); expect(r.neutral_fallback.every((x) => x.relevance === 0.25 && x.neutral)).toBe(true);
    expect(r.neutral_fallback.map((x) => x.reference_id)).not.toContain('REF-09'); // avoid_for 'acquisition' respected even for neutral lessons
  });
  test('Gold Standard weighting: a GOLD reference of the class is always included and outranks an equal APPROVED one; DO_NOT_USE is negative evidence only; stubs never retrieved', () => {
    const idx = JSON.parse(JSON.stringify(index));
    const r10 = idx.references.find((r) => r.reference_id === 'REF-10'); r10.owner_status = 'OWNER_GOLD_STANDARD'; r10.owner_weight = 2.0;
    const r09 = idx.references.find((r) => r.reference_id === 'REF-09'); r09.owner_status = 'OWNER_DO_NOT_USE'; r09.owner_weight = -1.0;
    idx.references.push(Object.assign({}, r10, { reference_id: 'REF-99', sha256: 'f'.repeat(64), stub: true, owner_status: 'OWNER_APPROVED', owner_weight: 1 }));
    const r = retriever.retrieve(idx, WU);
    expect(r.retrieved[0].reference_id).toBe('REF-10'); expect(r.retrieved[0].score).toBeGreaterThan(r.retrieved[1].score);
    expect(r.retrieved.map((x) => x.reference_id)).not.toContain('REF-09'); expect(r.negatives.map((n) => n.reference_id)).toContain('REF-09');
    expect(r.retrieved.map((x) => x.reference_id)).not.toContain('REF-99'); expect(r.has_gold_standard).toBe(true);
  });
});

describe('principles — calibration evidence, not templates; identity stripped', () => {
  const index = indexer.loadIndex(REAL);
  const marks = lib.sellerMarksFrom(lib.listLibrary(REAL).sidecars);
  test('100% single-seller retrieval → calibration block with no hex/px/typeface/seller strings; lessons + bands + do_not_copy present', () => {
    const r = retriever.retrieve(index, { campaign_class: 'estate_sale', event_mode: 'on_site', merchandise_breadth: 'broad', format_class: 'portrait', requested_family: 'ENVIRONMENTAL_PHOTO', seller_hierarchy: 'seller_led_cobranded' });
    const cal = principles.buildCalibration(index, r, { campaign_class: 'estate_sale', seller_hierarchy: 'seller_led_cobranded', event_mode: 'on_site', merchandise_mode: 'photograph', family: 'ENVIRONMENTAL_PHOTO', text_profile: 'GENERAL' }, marks);
    expect(principles.leakScan(cal, marks.seller_marks)).toEqual([]);
    expect(cal.principle_profile.transferable_lessons.length).toBeGreaterThan(3);
    expect(cal.principle_profile.merchandise.share_band_pct[0]).toBeGreaterThanOrEqual(50);
    expect(cal.principle_profile.hierarchy[0]).toMatch(/Professional Seller\) leads/);
    expect(cal.do_not_copy.seller_marks).toEqual(expect.arrayContaining(['Lewis & Maese', 'LMAuctionCo']));
    expect(cal.do_not_copy.wording.length).toBeGreaterThan(0); expect(cal.do_not_copy.layout_signatures.length).toBe(cal.reference_ids.length);
    expect(JSON.stringify(cal.principle_profile)).not.toMatch(/#[0-9a-f]{6}|\d+px|Lewis|LMAuction|Playfair/i);
  });
  test('a leaked seller string in the principle profile is refused', () => {
    const r = retriever.retrieve(index, { campaign_class: 'estate_sale', event_mode: 'on_site' });
    const poisoned = JSON.parse(JSON.stringify(index)); poisoned.references.find((x) => x.reference_id === 'REF-09').transferable_lessons.push('use the LMAuctionCo crest');
    const rr = retriever.retrieve(poisoned, { campaign_class: 'estate_sale', event_mode: 'on_site' });
    expect(() => principles.buildCalibration(poisoned, rr, { campaign_class: 'estate_sale', family: 'ENVIRONMENTAL_PHOTO', event_mode: 'on_site' }, marks)).toThrow(/leak/);
    void r;
  });
});

describe('family selection + brief cross-checks + gates', () => {
  test('family rules: 3 objects → LEFT_THIRD_WHITE (never CENTERED/scatter); 1 → SINGLE_LOT; online-only photographs → not ENVIRONMENTAL_PHOTO; acquisition → non-collage; scatter rationed', () => {
    expect(familySelector.selectFamily({ campaign_class: 'auction', wave: 'LAUNCH' }, { clean_objects: 3, category_families: 3 }).family).toBe('LEFT_THIRD_WHITE');
    expect(familySelector.selectFamily({ campaign_class: 'notable_lot' }, { clean_objects: 1 }).family).toBe('SINGLE_LOT');
    expect(familySelector.selectFamily({ campaign_class: 'estate_sale', event_mode: 'online_only', merchandise_mode: 'photograph' }, { photographs: 3, clean_objects: 0 }).family).not.toBe('ENVIRONMENTAL_PHOTO');
    expect(familySelector.selectFamily({ campaign_class: 'estate_sale', event_mode: 'on_site', merchandise_mode: 'photograph' }, { photographs: 3 }).family).toBe('ENVIRONMENTAL_PHOTO');
    expect(familySelector.selectFamily({ campaign_class: 'individual_seller_acquisition' }, {}).family).toBe('ACQUISITION');
    const ok = familySelector.selectFamily({ campaign_class: 'auction', wave: 'LAUNCH', themed: true }, { clean_objects: 12, category_families: 7 }, { scatter_used_this_quarter: 0, creatives_this_quarter: 4, ration_n: 5 });
    expect(ok.family).toBe('CATALOG_SCATTER');
    const rationed = familySelector.selectFamily({ campaign_class: 'auction', wave: 'LAUNCH', themed: true }, { clean_objects: 12, category_families: 7 }, { scatter_used_this_quarter: 1, creatives_this_quarter: 4, ration_n: 5 });
    expect(rationed.family).toBe('CENTERED_WHITE'); expect(rationed.reasons.join(' ')).toMatch(/ration exhausted/);
    expect(familySelector.selectFamily({ campaign_class: 'estate_sale', wave: 'LAUNCH', themed: true, fine_estate: true }, { clean_objects: 12, category_families: 7 }, {}).family).not.toBe('CATALOG_SCATTER');
    expect(familySelector.selectFamily({ campaign_class: 'auction', wave: 'FINAL', themed: true }, { clean_objects: 12, category_families: 7 }, {}).family).not.toBe('CATALOG_SCATTER');
  });
  test('brief validator: mixed auction ids, representative outside acquisition, LOGISTICS without reason, dark_hero outside SINGLE_LOT, library hash as asset → rejected', () => {
    const base = { family: 'CENTERED_WHITE', merchandise_mode: 'lots', auction_id: 'A1', calibration: {}, objects: [{ lot_id: '1', auction_id: 'A1', fidelity: 'CLEAN' }], text_budget: { profile: 'GENERAL' } };
    expect(briefValidator.validateBrief(base).valid).toBe(true);
    expect(briefValidator.validateBrief({ ...base, objects: [{ lot_id: '9', auction_id: 'OTHER', fidelity: 'CLEAN' }] }).errors.join(' ')).toMatch(/belongs to auction OTHER/);
    expect(briefValidator.validateBrief({ ...base, merchandise_mode: 'representative', representative_assets: [{ asset_id: 'x', rights: 'ours', representative_not_lots: true }] }).errors.join(' ')).toMatch(/not permitted in class/);
    expect(briefValidator.validateBrief({ ...base, text_budget: { profile: 'LOGISTICS' } }).errors.join(' ')).toMatch(/logistics_reason/);
    expect(briefValidator.validateBrief({ ...base, family_options: { ground: 'dark_hero' } }).errors.join(' ')).toMatch(/dark_hero/);
    expect(briefValidator.validateBrief({ ...base, objects: [{ lot_id: '1', auction_id: 'A1', fidelity: 'CLEAN', asset_id: 'deadbeef' }] }, { libraryHashes: new Set(['deadbeef']) }).errors.join(' ')).toMatch(/library reference hash/);
    expect(briefValidator.validateBrief({ ...base, family: 'ENVIRONMENTAL_PHOTO', merchandise_mode: 'photograph', site_photographs: [{ asset_id: 'p', provenance: { x: 1 } }], event: { online_only: true } }).errors.join(' ')).toMatch(/online-only/);
  });
  test('G12 seller-mark leak: LMAuctionCo in a non-L&M brief FAILS; passes in the L&M cobranded brief; reference wording fails', () => {
    const marks = ['Lewis & Maese', 'LMAuctionCo', 'fleur-de-lis'];
    expect(gates.sellerMarkLeak({ drawnText: ['Estate Sale', 'Visit LMAuctionCo.com'], sellerMarks: marks, cobrandSeller: null }).pass).toBe(false);
    expect(gates.sellerMarkLeak({ drawnText: ['LEWIS & MAESE', 'in conjunction with Advantage.Bid'], sellerMarks: marks, cobrandSeller: 'Lewis & Maese' }).pass).toBe(true);
    expect(gates.sellerMarkLeak({ drawnText: ['LEWIS & MAESE'], sellerMarks: marks, cobrandSeller: 'Other Seller' }).pass).toBe(false);
    expect(gates.sellerMarkLeak({ drawnText: ['Quality. Heritage. Timeless Style.'], sellerMarks: marks, wording: ['Quality. Heritage. Timeless Style.'], cobrandSeller: 'Lewis & Maese' }).pass).toBe(false);
  });
  test('G13 provenance: photographs need provenance; representative only in acquisition; objects must match the auction', () => {
    expect(gates.provenanceGate({ merchandise_mode: 'photograph', campaign_class: 'estate_sale', site_photographs: [{ asset_id: 'p1' }] }).pass).toBe(false);
    expect(gates.provenanceGate({ merchandise_mode: 'photograph', campaign_class: 'estate_sale', site_photographs: [{ asset_id: 'p1', provenance: { source_url: 'x' } }] }).pass).toBe(true);
    expect(gates.provenanceGate({ merchandise_mode: 'representative', campaign_class: 'auction', representative_assets: [{ asset_id: 'a', rights: 'r', representative_not_lots: true }] }).pass).toBe(false);
    expect(gates.provenanceGate({ merchandise_mode: 'representative', campaign_class: 'individual_seller_acquisition', representative_assets: [{ asset_id: 'a', rights: 'r', representative_not_lots: true }] }).pass).toBe(true);
    expect(gates.provenanceGate({ merchandise_mode: 'lots', auction_id: 'A', campaign_class: 'auction', objects: [{ lot_id: '1', auction_id: 'B', fidelity: 'CLEAN' }] }).pass).toBe(false);
  });
  test('G11 anti-similarity: a reference submitted as a candidate (distance 0) HARD FAILS; a near copy fails; a different layout passes; anchor threshold enforced', () => {
    const ref = [1, 0, 0.5, -0.2, 0.3]; const near = [1, 0.02, 0.5, -0.2, 0.31]; const far = [-1, 0.6, -0.5, 0.9, -0.4];
    expect(gates.antiSimilarity({ candidateSig: ref, referenceSigs: [{ id: 'REF-09', signature: ref }] }).pass).toBe(false);
    expect(gates.antiSimilarity({ candidateSig: near, referenceSigs: [{ id: 'REF-09', signature: ref }] }).pass).toBe(false);
    const ok = gates.antiSimilarity({ candidateSig: far, referenceSigs: [{ id: 'REF-09', signature: ref }], anchorSig: ref }); expect(ok.pass).toBe(true); expect(ok.published_anchor_distance).toBeGreaterThan(0.4);
    expect(gates.antiSimilarity({ candidateSig: near, referenceSigs: [], anchorSig: ref }).failures.join(' ')).toMatch(/published anchor/);
    expect(gates.antiSimilarity({ candidateSig: near, referenceSigs: [], selfSigs: [{ id: 'job:A', signature: ref }] }).failures.join(' ')).toMatch(/prior creative/);
  });
  test('G14 Owner review hold: empty class / proving ground / first of a family; text budget profiles', () => {
    expect(gates.ownerReviewRequired({ emptyClass: true }).required).toBe(true);
    expect(gates.ownerReviewRequired({ provingGround: true }).required).toBe(true);
    expect(gates.ownerReviewRequired({ familyPriorCount: 2 }).required).toBe(true);
    expect(gates.ownerReviewRequired({ familyPriorCount: 3, emptyClass: false }).required).toBe(false);
    expect(gates.textBudget('GENERAL', 6).pass).toBe(false); expect(gates.textBudget('TEASER', 3).pass).toBe(true); expect(gates.textBudget('LOGISTICS', 7).pass).toBe(false); expect(gates.textBudget('LOGISTICS', 7, 'preview hours in the record').pass).toBe(true);
  });
});

describe('scorer — bands, judge honesty, thresholds, hard checks', () => {
  const band = principles.bandFor('ENVIRONMENTAL_PHOTO', indexer.loadIndex(REAL));
  const good = { merchandise_pct: 55, text_region_pct: 20, text_blocks: 5, hierarchy_ratio: 2.7, title_words: 2, date_gt_time: true, largest_empty_pct: 4, upper_half_merch_pct: 35, ground_luminance: 0.93, brand_frame: { band: true, wordmark: true, logo: false } };
  test('inside-band creative scores the full measurable 60; judge unavailable is reported, not fabricated; decision needs Owner review on a proving ground', () => {
    const m = scorer.scoreMeasurable(good, band, { family: 'ENVIRONMENTAL_PHOTO', textProfile: 'GENERAL', eventFamily: true });
    expect(m.points).toBe(60);
    const fin = scorer.finalize({ measurable: m, judge: { available: false, reason: 'no key' }, hardChecks: {}, bar: 70, ownerReviewRequired: true });
    expect(fin.judge_available).toBe(false); expect(fin.score).toBe(60); expect(fin.decision).toBe('REGENERATE'); expect(fin.score_basis).toMatch(/judge unavailable/);
    const fin2 = scorer.finalize({ measurable: m, judge: { available: true, average: 32 }, hardChecks: {}, bar: 70, ownerReviewRequired: true });
    expect(fin2.score).toBe(92); expect(fin2.decision).toBe('OWNER_REVIEW');
    expect(scorer.finalize({ measurable: m, judge: { available: true, average: 32 }, hardChecks: {}, bar: 75, ownerReviewRequired: false }).decision).toBe('ACCEPT');
  });
  test('out-of-band values lose points linearly; hard-check failure → 0 + HARD_FAIL; extreme → NOT_FOR_PUBLICATION; < 50 → FALLBACK', () => {
    const m = scorer.scoreMeasurable({ ...good, merchandise_pct: 20, text_region_pct: 40, text_blocks: 9, hierarchy_ratio: 1.1 }, band, { family: 'ENVIRONMENTAL_PHOTO', textProfile: 'GENERAL', eventFamily: true });
    expect(m.points).toBeLessThan(40);
    expect(scorer.finalize({ measurable: m, judge: { available: true, average: 10 }, hardChecks: {}, bar: 70 }).decision).toBe('FALLBACK_DEFAULT_FAMILY');
    const hf = scorer.finalize({ measurable: scorer.scoreMeasurable(good, band, { family: 'ENVIRONMENTAL_PHOTO' }), judge: { available: true, average: 38 }, hardChecks: { G12: { pass: false, hits: [{ value: 'LMAuctionCo' }] } }, bar: 70 });
    expect(hf.score).toBe(0); expect(hf.decision).toBe('HARD_FAIL');
    expect(scorer.finalize({ measurable: scorer.scoreMeasurable(good, band, { family: 'ENVIRONMENTAL_PHOTO' }), judge: { available: true, average: 38 }, hardChecks: {}, bar: 70, extreme: true }).decision).toBe('NOT_FOR_PUBLICATION');
  });
  test('judge: no credential → available:false (never a fabricated 40)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const j = await judge.judge({ pngPath: __filename, profile: {}, family: 'ACQUISITION', campaignClass: 'individual_seller_acquisition' });
    expect(j.available).toBe(false); expect(j.prompt_version).toBe(judge.PROMPT_VERSION);
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
    expect(judge.buildPrompt({ hierarchy: ['x'] }, 'ENVIRONMENTAL_PHOTO', 'estate_sale')).toMatch(/PRINCIPLE ADHERENCE, not similarity/);
  });
});

describe('feedback ledger — Owner words, Owner sources only, no JSON for the Owner', () => {
  let dir; beforeEach(() => { dir = tempLibrary(); }); afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  test('vocabulary mapping', () => {
    expect(feedback.mapOwnerWords('love this').status).toBe('OWNER_GOLD_STANDARD');
    expect(feedback.mapOwnerWords("that's it, gold standard").status).toBe('OWNER_GOLD_STANDARD');
    expect(feedback.mapOwnerWords("don't use this style again").status).toBe('OWNER_DO_NOT_USE');
    expect(feedback.mapOwnerWords('good').status).toBe('OWNER_APPROVED');
    const n = feedback.mapOwnerWords('come back 10% on the title'); expect(n.action).toBe('CALIBRATION_NOTE'); expect(n.note).toEqual({ element: 'title', direction: 'smaller', amount_pct: 10 });
    expect(feedback.mapOwnerWords('increase the merchandise').note.direction).toBe('larger');
    expect(feedback.mapOwnerWords('hmm').action).toBe('AMBIGUOUS');
  });
  test('appendDecision refuses non-Owner sources (performance/learning can never change a status); records Owner sources verbatim', () => {
    expect(() => feedback.appendDecision({ source: 'performance', action: 'SET_STATUS', status: 'OWNER_GOLD_STANDARD', resolved: { reference_id: 'REF-02' } }, dir)).toThrow(/Owner sources/);
    const out = feedback.appendDecision({ source: 'owner_statement_via_desktop_marketing', owner_words: 'that one is gold standard', resolved: { reference_id: 'REF-02' }, action: 'SET_STATUS', status: 'OWNER_GOLD_STANDARD', recorded_by: 'test' }, dir);
    expect(out.hash).toMatch(/^[a-f0-9]{64}$/);
    const lines = fs.readFileSync(path.join(dir, 'owner-decisions.jsonl'), 'utf8').trim().split('\n'); expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).owner_words).toBe('that one is gold standard');
  });
  test('recordOwnerReview writes a review row + ledger; an approved generated creative can be admitted with Advantage.Bid provenance and the index grows', async () => {
    const writes = [];
    const db = { query: async (sql, params) => { writes.push({ sql: String(sql).slice(0, 60), params }); return { rows: [] }; } };
    const r = await feedback.recordOwnerReview({ creativeJobId: 'p3p-x', candidateKey: 'A', words: 'good, come back 10% on the title', root: dir, db });
    expect(r.status).toBe('approved'); expect(writes.some((w) => /marketing_creative_owner_reviews/.test(w.sql))).toBe(true);
    // admit: render = an existing library image copy (stands in for a generated PNG) → new sidecar with Advantage.Bid provenance
    const png = path.join(os.tmpdir(), 'p3p-render-' + Date.now() + '.png'); fs.copyFileSync(listImgs(dir)[0].path, png); fs.appendFileSync(png, Buffer.from([1, 2, 3]));
    const admitted = await feedback.admitGeneratedCreative({ renderPath: png, category: 'individual-seller', campaignClass: 'individual_seller_acquisition', brief: { family: 'ACQUISITION', merchandise_mode: 'representative', seller_hierarchy: 'advantage_bid_only' }, metrics: { merchandise_pct: 40, text_region_pct: 12, text_blocks: 3, objects: 5 }, calibration: { principle_profile: { transferable_lessons: ['light ground; one message'] } }, ownerWords: 'love this', status: 'OWNER_GOLD_STANDARD', jobId: 'p3p-x', candidateKey: 'A', root: dir });
    expect(admitted.reference_id).toBe('REF-14');
    const idx = indexer.loadIndex(dir);
    const ref = idx.references.find((x) => x.reference_id === 'REF-14');
    expect(ref.seller).toBe('Advantage.Bid'); expect(ref.owner_status).toBe('OWNER_GOLD_STANDARD'); expect(ref.path).toMatch(/^individual-seller\/gold-standard\/advantagebid-individual_seller_acquisition-/);
    expect(idx.empty_classes).not.toContain('individual_seller_acquisition'); expect(idx.seller_concentration.share).toBeLessThan(1);
    fs.unlinkSync(png);
  });
});

describe('publish isolation + learning boundaries (static)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  test('proving ground / reference services never enqueue a social dispatch, never publish, never touch destinations', () => {
    for (const f of ['src/services/creativeReference/provingGround.js', 'src/services/creativeReference/feedbackLedger.js', 'src/services/creativeReference/scorer.js', 'src/services/creativeReference/judge.js']) {
      const s = read(f); expect(s).not.toMatch(/enqueueSocialDispatch|socialDispatchService|metaGraphProvider|graph\.facebook\.com|marketing_social_destinations SET active/);
    }
    expect(read('scripts/run-proving-grounds.js')).not.toMatch(/setPlatformConfig|enqueueSocialDispatch|publishWave/);
  });
  test('the compositor / family renderers have no path to the library directory; the judge never receives a reference image', () => {
    for (const f of ['creative-engine/runtime/compose.py', 'creative-engine/adb_engine/families/environmental_photo.py', 'creative-engine/adb_engine/families/acquisition.py', 'creative-engine/adb_engine/families/brand.py']) expect(read(f)).not.toMatch(/approved-creative-examples/);
    expect(read('src/services/creativeReference/judge.js')).not.toMatch(/approved-creative-examples|reference_image|referenceSigs/);
  });
  test('learning service has no write path to sidecars or the ledger', () => {
    expect(read('src/services/marketingLearningService.js')).not.toMatch(/reference\.json|owner-decisions|creativeReference/);
    expect(read('src/services/socialLearningService.js')).not.toMatch(/reference\.json|owner-decisions|creativeReference/);
  });
  test('migration 147 is additive and flips no publishing gate', () => {
    const sql = read('db/migrations/147_creative_reference_system.sql');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i); expect(sql).not.toMatch(/a9_publish_enabled|meta_enabled|google_ads_enabled/);
    expect(sql).toMatch(/HELD_FOR_OWNER_REVIEW/);
  });
});

(pythonOk ? describe : describe.skip)('Python family engines + signatures (real renders; requires Pillow + numpy)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'p3p-render-'));
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));
  const photo = path.join(REAL, 'estate-sale', '703633034_1679829177020529_6716087826834201503_n.jpg'); // used ONLY as a stand-in photograph for the renderer test, not as a reference
  const copy = { presenter: 'Example Seller', relationship: 'in conjunction with Advantage.Bid', title: 'River Oaks', subtitle: 'On-Site Estate Sale', date: 'Saturday, October 3', time: '9:00 AM – 3:00 PM · One day only', place_plate: 'River Oaks · Houston, TX' };
  test('ENVIRONMENTAL_PHOTO banded + panel render with 5 copy blocks, no copy over merchandise, plate ≤ 6%, date > time, brand band; extreme carries the label', async () => {
    const a = await bridge.render('ENVIRONMENTAL_PHOTO', { format: 'portrait_1080x1350', variant: 'banded', photo_path: photo, copy, options: {}, out_png: path.join(out, 'a.png') });
    expect(a.ok).toBe(true); expect(a.metrics.text_blocks).toBe(5); expect(a.metrics.copy_over_merchandise).toEqual([]); expect(a.metrics.place_plate_ok).toBe(true); expect(a.metrics.date_gt_time).toBe(true); expect(a.metrics.brand_frame.band && a.metrics.brand_frame.wordmark).toBe(true);
    expect(a.metrics.merchandise_pct).toBeGreaterThan(40); expect(a.drawn_text).toContain('Advantage.Bid');
    const b = await bridge.render('ENVIRONMENTAL_PHOTO', { format: 'square_1080x1080', variant: 'panel', photo_path: photo, copy, options: { panel_side: 'left' }, out_png: path.join(out, 'b.png') });
    expect(b.ok).toBe(true); expect(b.metrics.text_blocks).toBe(5); expect(b.metrics.copy_over_merchandise).toEqual([]);
    const c = await bridge.render('ENVIRONMENTAL_PHOTO', { format: 'portrait_1080x1350', variant: 'banded', photo_path: photo, copy, options: { title_scale: 1.15, photo_share: 1.15, extreme_label: true }, out_png: path.join(out, 'c.png') });
    expect(c.ok).toBe(true); expect(c.metrics.extreme).toBe(true); expect(c.drawn_text.join(' ')).toMatch(/NOT FOR PUBLICATION/); expect(c.metrics.text_blocks).toBe(5); // label not counted
  }, 120000);
  test('ACQUISITION concept renders with representative disclosure + help line; TEASER budget (3 blocks)', async () => {
    const A = path.join(__dirname, '..', 'creative-engine', 'runtime', 'assets');
    const r = await bridge.render('ACQUISITION', { format: 'portrait_1080x1350', concept: 'A', copy: { primary: "It's built to be easy.", support: 'Create your own online auction on Advantage.Bid.', help: 'Real people help along the way. Call (551) 655-7050.', disclosure: 'Representative items shown — not auction lots' }, objects: [{ path: path.join(A, 'lot31.webp'), w: 700, cx: 0.6, z: 40, role: 'anchor' }, { path: path.join(A, 'lot46.webp'), w: 210, cx: 0.1, z: 30, role: 'tall' }], screenshot_path: null, out_png: path.join(out, 'acq.png') });
    expect(r.ok).toBe(true); expect(r.metrics.representative).toBe(true); expect(r.metrics.text_blocks).toBe(3); expect(r.drawn_text.join(' ')).toMatch(/Representative items shown/); expect(r.placed.length).toBe(2);
  }, 120000);
  test('signature: a reference vs itself is 0 (a reference as a candidate HARD FAILS G11); two different references sit ≥ τ_ref apart', async () => {
    const imgs = lib.listLibrary(REAL).images.map((i) => i.path).slice(0, 3);
    const s = await bridge.signatures(imgs); expect(s.ok).toBe(true);
    const sig = s.signatures[imgs[0]];
    expect(bridge.distance(sig, sig)).toBe(0);
    expect(gates.antiSimilarity({ candidateSig: sig, referenceSigs: [{ id: 'ref0', signature: sig }] }).pass).toBe(false);
    expect(bridge.distance(s.signatures[imgs[0]], s.signatures[imgs[1]])).toBeGreaterThanOrEqual(0.35);
  }, 120000);
});
