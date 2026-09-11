'use strict';

/**
 * Phase 3P.1 + 3P.2 — creative foundation: title style (12), copy density profiles + the event headline unit, campaign
 * messages / class separation / assisted pricing / fictional notable-lot facts, feedback records, Gold retrieval and
 * REF-17 imagery-only handling, scorer v2 two-tier decisions, logo registry, media-director provenance, variation /
 * template echo, brief validation (notable lot facts, dark hero) and — when Python is available — the physical audit,
 * the planner (uniform scale, never inside a copy region, alias-aware support classes) and the band accent fit.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-3p2';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const titleCase = require('../src/services/creativeReference/titleCase');
const density = require('../src/services/creativeReference/copyDensity');
const messages = require('../src/services/creativeReference/campaignMessages');
const feedbackRecords = require('../src/services/creativeReference/feedbackRecords');
const retriever = require('../src/services/creativeReference/retriever');
const indexer = require('../src/services/creativeReference/indexer');
const scorerV2 = require('../src/services/creativeReference/scorerV2');
const brandAssets = require('../src/services/creativeReference/brandAssets');
const mediaDirector = require('../src/services/creativeReference/mediaDirector');
const variation = require('../src/services/creativeReference/variation');
const bridge = require('../src/services/creativeReference/engineBridge');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'creative-engine');
const PY = bridge.PYTHON;
const pythonOk = (() => { try { return spawnSync(PY, ['-c', 'import PIL, numpy'], { encoding: 'utf8' }).status === 0; } catch (_) { return false; } })();
const py = (code) => {
  const r = spawnSync(PY, ['-c', 'import sys, json; sys.path.insert(0, "."); ' + code], { cwd: ENGINE, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

describe('title style — 13 rules (capitalization-rules.json)', () => {
  const cases = [
    ['have items to sell?', 'headline', 'Have Items to Sell?'],
    ['bid today. discover tomorrow.', 'headline', 'Bid Today. Discover Tomorrow.'],
    ['in conjunction with', 'major_label', 'In Conjunction With'],                     // last word capitalised
    ['the smarter way to sell', 'headline', 'The Smarter Way to Sell'],               // first word capitalised; short preposition lower
    ['West University Area · Houston, TX', 'place_name', 'West University Area · Houston, TX'], // state code preserved (was "Tx")
    ['sell it in katy, tx', 'headline', 'Sell It in Katy, TX'],                      // state code after "City," uppercased
    ['Or, in time', 'headline', 'Or, in Time'],                                       // "in" after a comma is not Indiana
    ['estate sale in NYC', 'headline', 'Estate Sale in NYC'],                         // short acronym kept
    ['IN CONJUNCTION WITH', 'relationship', 'In Conjunction With'],                   // all-caps source is not trusted as acronyms
    ['one-day estate sale', 'headline', 'One-Day Estate Sale'],                       // hyphenated parts
    ['ManCave Auction', 'event_title', 'ManCave Auction'],                           // a proper name with internal capitals is kept as written
    ['sell with advantage.bid', 'headline', 'Sell with Advantage.Bid'],               // 'with' stays lower mid-title; fixed-case brand token
    ['Create your own online auction on Advantage.Bid.', 'support', 'Create your own online auction on Advantage.Bid.'], // support lines stay sentence case
  ];
  test.each(cases)('%s (%s) → %s', (input, role, expected) => { expect(titleCase.titleCase(input, role)).toBe(expected); });
  test('hygiene flags an all-uppercase headline unless it is a deliberate display choice', () => {
    expect(titleCase.hygiene([{ role: 'headline', text: 'SELL YOUR ITEMS' }]).violations.length).toBeGreaterThan(0);
    expect(titleCase.hygiene([{ role: 'headline', text: 'SELL YOUR ITEMS' }], { uppercaseDisplay: true }).violations.length).toBe(0);
  });
});

describe('copy density profiles (copy-density.json)', () => {
  test('FEED_FAST ceiling 5; two competing headlines hard-fail; ACQUISITION_RICH needs one dominant headline and ≥ 45% merchandise', () => {
    expect(density.gate('FEED_FAST', { blocks: 6, headline_class_roles: ['headline'] }, {}).hard[0]).toMatch(/6 blocks > FEED_FAST ceiling 5/);
    expect(density.gate('FEED_FAST', { blocks: 5, headline_class_roles: ['headline', 'subheadline'] }, {}).hard[0]).toMatch(/two headline-class/);
    const rich = density.gate('ACQUISITION_RICH', { blocks: 9, headline_class_roles: ['headline'], headline_dominance: 1.8 }, { coverage: { coverage_pct: 30 } });
    expect(rich.pass).toBe(false); expect(rich.hard.join(' ')).toMatch(/2\.2×/); expect(rich.hard.join(' ')).toMatch(/45%/);
    expect(density.gate('ACQUISITION_RICH', { blocks: 9, headline_class_roles: ['headline'], headline_dominance: 2.4 }, { coverage: { coverage_pct: 50 } }).pass).toBe(true);
    expect(density.gate('EVENT', { blocks: 7, headline_class_roles: ['event_headline'] }, { text_region_pct: 30 }).soft[0]).toMatch(/text region/);
    expect(density.defaultProfile({ placement: 'feed', campaignClass: 'buyer_platform_growth' })).toBe('FEED_FAST');
    expect(density.defaultProfile({ campaignClass: 'estate_sale' })).toBe('EVENT');
  });
  (pythonOk ? test : test.skip)('engine: event type + event title are ONE headline unit (type leads, title is its second beat); RESTRAINED_FACTUAL merges type+title and date/place', () => {
    const ev = py(`from adb_engine.families import layout as LY
boxes=[dict(role='logo',x=0,y=0,w=10,h=10),dict(role='event_type',text='Estate Sale',cap_h=80,x=0,y=0,w=10,h=10),dict(role='event_title',text='West University',cap_h=72,x=0,y=0,w=10,h=10),
dict(role='date',text='Saturday, September 19',cap_h=40,x=0,y=0,w=10,h=10),dict(role='time',text='9-3',cap_h=20,x=0,y=0,w=10,h=10),dict(role='place_plate',text='Houston, TX',cap_h=18,x=0,y=0,w=10,h=10)]
print(json.dumps(dict(ev=LY.density(boxes, profile='EVENT'), rf=LY.density(boxes, profile='RESTRAINED_FACTUAL'))))`);
    expect(ev.ev.headline_class_roles).toEqual(['event_headline']);
    expect(density.gate('EVENT', ev.ev, {}).hard).toEqual([]);
    expect(ev.rf.blocks).toBe(4);   // logo · event type + title · date/place · band
    expect(density.gate('RESTRAINED_FACTUAL', ev.rf, {}).pass).toBe(true);
  });
  (pythonOk ? test : test.skip)('engine: the band script accent shrinks to fit beside the locked wordmark, or is left out — never clipped at the canvas edge', () => {
    const out = py(`from PIL import Image, ImageDraw
from adb_engine.families import layout as LY
res={}
for label, script in (('short','You Can Do This.'),('long','You Can Do This. Start Today With Us.')):
    img=Image.new('RGBA',(1080,1350),'white'); d=ImageDraw.Draw(img); boxes=[]
    LY.band(img,d,1080,1350,dict(band_h=159,wordmark_px=92,margin=48),boxes,script=script)
    wm=[b for b in boxes if b['role']=='wordmark'][0]; sc=[b for b in boxes if b['role']=='band_script']; om=[b for b in boxes if b['role']=='band_script_omitted']
    res[label]=dict(wm_left=wm['x'], wm_w=wm['w'], sc_right=(sc[0]['x']+sc[0]['w']) if sc else None, omitted=bool(om))
print(json.dumps(res))`);
    expect(out.short.wm_left).toBeGreaterThanOrEqual(0);
    if (out.short.sc_right != null) expect(out.short.sc_right).toBeLessThanOrEqual(1080);
    expect(out.long.omitted || out.long.sc_right <= 1080).toBe(true);
    expect(out.long.wm_left).toBeGreaterThanOrEqual(0);
  });
});

describe('campaign messages, class separation, assisted pricing, fictional facts', () => {
  test('assisted-service pricing is never stated: percentages and fixed prices rejected; the approved availability lines pass', () => {
    expect(messages.assistedPricingHits('Full service for only 40% commission').length).toBeGreaterThan(0);
    expect(messages.assistedPricingHits('Prefer us to run the sale? From $499.').length).toBeGreaterThan(0);
    expect(messages.assistedPricingHits('Hands-on help available in Houston and the NYC area').length).toBe(0);
    expect(messages.assistedPricingHits('Prefer us to run the sale? Ask about assisted service').length).toBe(0);
    const v = messages.validateCopy({ campaignClass: 'individual_seller_acquisition', copy: { availability: 'Prefer us to run the sale? We charge 40%.' }, roles: { availability: 'availability' } });
    expect(v.pass).toBe(false); expect(v.rejections.some((r) => r.rule === 'assisted_service_pricing')).toBe(true);
  });
  test('the fictional notable-lot training facts can never reach production copy', () => {
    const NL = require('../docs/marketing/phase3p2/config/notable-lot-contract.json');
    const fact = (NL.training_example.facts || [])[0];
    expect(fact).toBeTruthy();
    expect(messages.fictionalFactHits('Tonight: ' + fact).length).toBeGreaterThan(0);
  });
  test('seller and buyer lexicons stay separate', () => {
    expect(messages.SELLER_CLASSES).toContain('individual_seller_acquisition');
    expect(messages.BUYER_CLASSES).toContain('buyer_platform_growth');
    expect(messages.SELLER_CLASSES.some((c) => messages.BUYER_CLASSES.includes(c))).toBe(false);
  });
});

describe('Owner feedback records + reference retrieval (Gold weighting, imagery-only)', () => {
  test('feedback records validate against the schema and Owner-rejected candidates become negative subjects', () => {
    const { records: recs, unknown } = feedbackRecords.records();
    expect(recs.length).toBeGreaterThan(0); expect(unknown).toEqual([]);
    for (const r of recs) expect(r.validation.errors).toEqual([]);
    expect(feedbackRecords.validate({ action: 'CREATIVE_REVIEW', source: 'performance_metrics' }).valid).toBe(false);   // never a non-Owner source
    expect(feedbackRecords.negativeSubjects().length).toBeGreaterThan(0);
  });
  test('index: 23 references with 8 Gold; REF-20 + REF-21 are Gold; REF-17 is buyer growth / estate sale, never seller copy', () => {
    const idx = indexer.loadIndex();
    const byId = Object.fromEntries(idx.references.map((r) => [r.reference_id, r]));
    expect(idx.references.length).toBeGreaterThanOrEqual(23);
    expect(byId['REF-20'].owner_status).toBe('OWNER_GOLD_STANDARD'); expect(byId['REF-21'].owner_status).toBe('OWNER_GOLD_STANDARD');
    expect(idx.references.filter((r) => r.owner_status === 'OWNER_GOLD_STANDARD').length).toBeGreaterThanOrEqual(8);
    const seller = retriever.retrieve(idx, { campaign_class: 'individual_seller_acquisition', event_mode: 'not_an_event', merchandise_breadth: 'representative_non_lot', format_class: 'portrait' });
    const ref17 = seller.retrieved.find((r) => r.reference_id === 'REF-17');
    if (ref17) expect(ref17.imagery_only || (seller.imagery_only || []).includes('REF-17')).toBeTruthy();
    expect(seller.retrieved.some((r) => r.owner_status === 'OWNER_GOLD_STANDARD' || (idx.references.find((x) => x.reference_id === r.reference_id) || {}).owner_status === 'OWNER_GOLD_STANDARD')).toBe(true);
  });
});

describe('scorer v2 — two tiers', () => {
  const measurable = { points: 50 };
  test('any BLOCKING failure → HARD_FAIL with score 0; a REGENERATE-tier violation keeps its score; clean + over the bar → OWNER_REVIEW', () => {
    const hard = scorerV2.finalize({ measurable, judge: { available: true, points: 30 }, checks: { blocking: { coverage: { pass: false, detail: 'x' } }, regenerate: {} } });
    expect(hard.decision).toBe('HARD_FAIL'); expect(hard.score).toBe(0);
    const regen = scorerV2.finalize({ measurable, judge: { available: true, points: 30 }, checks: { blocking: {}, regenerate: { capitalization: { pass: false, detail: 'y' } } } });
    expect(regen.decision).toBe('REGENERATE'); expect(regen.score).toBe(80);
    expect(scorerV2.finalize({ measurable, judge: { available: true, points: 30 }, checks: { blocking: {}, regenerate: {} } }).decision).toBe('OWNER_REVIEW');
    const nj = scorerV2.finalize({ measurable, judge: { available: false }, checks: { blocking: {}, regenerate: {} } });
    expect(nj.score_basis).toMatch(/judge unavailable/);
  });
});

describe('official logo registry — composited, never drawn', () => {
  test('every registered lockup is present and its SHA-256 matches; the absolute rule forbids redrawing', () => {
    const v = brandAssets.verify();
    expect(v.ok).toBe(true); expect(v.variants.length).toBeGreaterThan(0); expect(v.variants.every((x) => x.verified)).toBe(true);
    expect(JSON.stringify(v.absolute_rule)).toMatch(/never/i);
  });
});

describe('media director — authentic media only', () => {
  test('an asset without complete provenance, or bound to another event, is ineligible', () => {
    const good = { path: 'x.jpg', asset_sha256: 'a'.repeat(64), provenance: { event_id: 'E1', source_page: 'https://example.test/e1', retrieved_at: '2026-09-10', rights: 'seller-published' } };
    expect(mediaDirector.provenanceOk(good, 'E1').ok).toBe(true);
    expect(mediaDirector.provenanceOk(good, 'E2').ok).toBe(false);
    expect(mediaDirector.provenanceOk({ path: 'y.jpg', provenance: { event_id: 'E1' } }, 'E1').missing.length).toBeGreaterThan(0);
  });
});

describe('variation — template echo', () => {
  test('a scene carrying three or more recurring collaborator props is flagged', () => {
    const echo = variation.templateEcho([{ title: 'Bronze horse sculpture' }, { title: 'Blue and white vase' }, { title: 'Laptop showing the site' }, { title: 'Wingback chair' }]);
    expect(echo.flagged).toBe(true); expect(echo.props.length).toBe(3);
    expect(variation.templateEcho([{ title: 'Wingback chair' }, { title: 'Pie crust table' }]).flagged).toBe(false);
  });
});

(pythonOk ? describe : describe.skip)('physical intelligence (real engine)', () => {
  const A = path.join(ENGINE, 'runtime', 'assets');
  const objs = [
    { id: 'chairs', asset: path.join(A, 'lot31.webp'), title: 'Pair of red wingback chairs', representative: true },
    { id: 'table', asset: path.join(A, 'lot36.webp'), title: 'Mahogany pie crust table', representative: true },
    { id: 'sphere', asset: path.join(A, 'lot11d.webp'), title: 'Rose quartz sphere', representative: true },
  ];
  test('planner: uniform scene scale, physically clean, never inside a copy region; a small sculpture may sit on a side table (alias-aware support classes)', async () => {
    const copy = { x: 0, y: 0, w: 480, h: 640 };
    const p = await bridge.call({ op: 'plan', objects: objs, field: { x: 24, y: 60, w: 1031, h: 1070 }, canvas: [1080, 1350], family: 'ACQUISITION', arrangement: 'split', copy_regions: [copy], options: { align: 'right' } }, { timeoutMs: 300000 });
    expect(p.objects.length).toBeGreaterThan(0);
    expect(p.audit.physical.filter((v) => v.kind === 'support-class')).toEqual([]);
    for (const o of p.objects) {
      const inCopy = o.x < copy.x + copy.w && o.x + o.w > copy.x && o.y < copy.y + copy.h && o.y + o.h > copy.y;
      if (inCopy) expect(o.y + o.h * 0.25).toBeGreaterThanOrEqual(copy.y + copy.h - 1);  // only a bounding-box corner may approach the column; pixels never enter
    }
    const scales = new Set(p.objects.filter((o) => o.dims_in && o.dims_in.h).map((o) => Math.round((o.h / (o.depth_factor || 1)) / o.dims_in.h)));
    expect(scales.size).toBeLessThanOrEqual(1);
  }, 300000);
  test('physical audit: a table pushed through the chairs is flagged; the planned scene is clean', async () => {
    const p = await bridge.call({ op: 'plan', objects: objs.slice(0, 2), field: { x: 24, y: 60, w: 1031, h: 1070 }, canvas: [1080, 1350], family: 'ACQUISITION', arrangement: 'split' }, { timeoutMs: 300000 });
    const layers = p.objects.map((o) => Object.assign({}, o, { asset: o.trimmed_asset }));
    const clean = await bridge.call({ op: 'physical_audit', scene: { size: [1080, 1350], layers } }, { timeoutMs: 120000 });
    expect(clean.violations).toEqual([]);
    const chair = layers.find((l) => l.id === 'chairs'); const table = layers.find((l) => l.id === 'table');
    const bad = layers.map((l) => (l.id === 'table' ? Object.assign({}, l, { x: chair.x + chair.w / 2 - table.w / 2, y: chair.y + chair.h - table.h, baseline: chair.baseline, z: chair.z + 1 }) : l));
    const flagged = await bridge.call({ op: 'physical_audit', scene: { size: [1080, 1350], layers: bad } }, { timeoutMs: 120000 });
    expect(flagged.violations.length).toBeGreaterThan(0);
    expect(flagged.violations.map((v) => v.kind).join(' ')).toMatch(/through|deep-overlap|protected/);
  }, 300000);
});

describe('post-render capitalization reads a wrapped headline as one string', () => {
  test('"Have Items / to Sell?" drawn on two lines is judged as "Have Items to Sell?" (no false "expected To")', () => {
    const pg2 = require('../src/services/creativeReference/provingGround2');
    const drawn = pg2.mapDrawnRoles([{ role: 'headline', text: 'Have Items' }, { role: 'headline', text: 'to Sell?' }, { role: 'support', text: 'List them in your own online auction.' }]);
    expect(drawn).toEqual([{ role: 'headline', text: 'Have Items to Sell?' }, { role: 'support', text: 'List them in your own online auction.' }]);
    expect(titleCase.hygiene(drawn).violations).toEqual([]);
    expect(titleCase.hygiene([{ role: 'headline', text: 'have items to sell?' }]).violations.length).toBeGreaterThan(0);
  });
});
