"""Wave 1 creative production engine tests: shipped B1/B2/B3 regression (audit == expected), the
materially-different transfer fixture through the FULL automated pipeline, and negative cases. Deterministic;
no browser required (spatial.audit uses real alpha masks via PIL). Run: python tests/test_pipeline.py
"""
import os, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PACK, 'runtime'))
sys.path.insert(0, PACK)
sys.path.insert(0, os.path.join(PACK, 'fixtures'))
os.chdir(os.path.join(PACK, 'runtime'))

import compose, spatial, comp_b  # noqa: E402
from adb_engine import placement, selection, extraction, protected, qa  # noqa: E402
import produce  # noqa: E402
from build_transfer import build  # noqa: E402

EXPECTED = os.path.join(PACK, 'fixtures', 'expected')
fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

# ---- 1. Shipped B1/B2/B3 regression: rebuild + audit == expected (spatial.py acceptance authority) ----
for key, buildfn in comp_b.VERSIONS.items():
    comp = buildfn()
    rows, summ = spatial.audit(comp)
    exp = json.load(open(os.path.join(EXPECTED, comp['name'] + '_audit.expected.json')))['summary']
    check(summ['violations'] == [] and exp['violations'] == [], f'{comp["name"]}: violations == expected (both [])')
    check(summ['planes'] == exp['planes'] and summ['roles'] == exp['roles'], f'{comp["name"]}: planes/roles == expected')
    check(summ['meaningful_overlaps'] == exp['meaningful_overlaps'], f'{comp["name"]}: overlaps == expected')

# ---- 2. Materially-different auction through the FULL automated pipeline (generalization) ----
job, srcdir = build()
res = produce.run(job)
check(res.get('ok') is True, 'transfer: pipeline ok')
check(res.get('audit', {}).get('violations') == [], 'transfer: spatial audit PASS (violations [])')
check(res.get('qa', {}).get('pass') is True, 'transfer: thumbnail/feed QA PASS (1:1 + 4:5)')
obj_lots = set(res.get('creative', {}).get('object_lots') or [])
input_lots = {str(l['lot_id']) for l in job['lots']}
check(obj_lots and obj_lots <= input_lots, 'transfer: NO invented merchandise (all objects are real input lots)')
fams = set()
for L in res.get('audit', {}).get('roles', {}):
    pass
# breadth: composition is not luxury-only (no luxury flag), and >=4 families shown
shown = spatial.category_balance(dict(layers=[compose.obj(l, 0, 0, 100, z=1) for l in obj_lots] if False else [], size=(1080,1350)))
# recompute families shown from INV cats of placed lots
placed_fams = {selection.family_for(compose.INV[l]['cat']) for l in obj_lots}
check(len(placed_fams) >= 4 and not (placed_fams <= {'art', 'jewelry', 'decor'}), f'transfer: broad breadth, not luxury-only ({sorted(placed_fams)})')
check(all((p.get('rgb_edited') is False and p.get('generative') is False) for p in res.get('provenance', [])), 'transfer: provenance shows NO RGB edit / NO generative reconstruction')
check(all(fmt in [f['format'] for f in res['qa']['formats']] for fmt in ('4:5', '1:1')), 'transfer: BOTH 1:1 and 4:5 evaluated')

# ---- 3. Negative cases ----
# 3a. FAILED extraction is excluded / REVIEW is not auto-used.
compose.INV['revX'] = dict(name='x', cat='Silver', status='REVIEW', w=100, h=100, bbox=[0,0,100,100], opaque_pct=70)
try:
    compose.obj('revX', 0, 0, 100, z=1); composed_review = True
except AssertionError:
    composed_review = False
check(composed_review is False, 'negative: REVIEW object rejected by compose.obj (CLEAN-only)')

# 3b. extraction classify gate: near-full alpha (hard box) -> FAILED; empty -> FAILED; mid band -> CLEAN.
check(extraction.classify(dict(opaque_pct=99.0, w=300, h=300, hard_box=True))[0] == 'FAILED', 'negative: hard-box/background-not-removed -> FAILED')
check(extraction.classify(dict(opaque_pct=20.0, w=300, h=300, hard_box=False))[0] == 'FAILED', 'negative: near-empty alpha -> FAILED')
check(extraction.classify(dict(opaque_pct=75.0, w=300, h=300, hard_box=False))[0] == 'CLEAN', 'gate: clean single foreground -> CLEAN')
check(extraction.classify(dict(opaque_pct=90.0, w=300, h=300, hard_box=False))[0] == 'REVIEW', 'gate: borderline opacity -> REVIEW')

# 3c. floating heavy furniture -> GRAVITY violation.
any_clean = next(l for l in input_lots if compose.INV.get(l, {}).get('status') == 'CLEAN')
floating = dict(name='neg', size=(1080, 1350), footer=dict(h=120),
                layers=[compose.obj(any_clean, 400, 100, 400, z=20, role='HERO', plane='MIDGROUND')])  # baseline high, not on floor
_, s = spatial.audit(floating)
check(any(v[1] == 'gravity' for v in s['violations']), 'negative: floating HEAVY object -> GRAVITY violation')

# 3d. cropped protected region -> violation.
spatial.PROTECTED[any_clean] = [('mark', 0.9, 0.9, 1.2, 1.2)]  # region extends beyond the object box -> cropped
grounded = dict(name='neg2', size=(1080, 1350), footer=dict(h=120),
                layers=[compose.obj(any_clean, 300, 900, 300, z=20, role='HERO', plane='MIDGROUND', contact=(0.5, 6, 0.9, 20, .3))])
_, s2 = spatial.audit(grounded)
check(any(v[1] in ('protected-cropped', 'protected-occluded') for v in s2['violations']), 'negative: cropped protected region -> violation')
del spatial.PROTECTED[any_clean]

# 3e. excessive text -> text-budget flag.
tb = spatial.text_budget_audit(dict(layers=[]), [dict(text=f'line {i}') for i in range(7)])
check(len(tb['flags']) > 0, 'negative: >5 copy blocks -> text-budget flag')

# 3f. malformed request -> structured error, never a crash.
bad = produce.run({'auction_id': 'x', 'lots': [{'lot_id': 'z', 'cat': 'Silver', 'status': 'FAILED', 'w': 50, 'h': 50}]})
check(bad.get('ok') is False and 'error' in bad, 'negative: no-CLEAN request -> structured error (no crash)')

print('\nRESULT:', 'ALL PASS' if not fails else f'{len(fails)} FAILED')
sys.exit(1 if fails else 0)
