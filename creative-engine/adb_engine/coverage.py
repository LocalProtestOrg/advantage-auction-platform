"""Phase 3P.1 Mission 6 — space utilization (config: docs/marketing/phase3p1/config/coverage-bands.json).

Coverage is measured inside the MERCHANDISE FIELD (canvas minus reserved copy regions minus the navy band), so a
bigger headline can never "fix" a small cluster. The accidental void is the largest empty rectangle of the content
area (canvas minus band) where content = merchandise/photograph ∪ drawn text ∪ logo — a panel or card fill with no
content counts as empty — excluding regions the scene plan declares intentional. Both field-based and canvas-based
numbers are reported so calibration history stays comparable.
"""
import numpy as np
from . import config
from .families.brand import largest_empty_pct


def _rect_mask(H, W, rects):
    m = np.zeros((H, W), bool)
    for r in rects or []:
        x, y, w, h = [int(round(v)) for v in (r['x'], r['y'], r['w'], r['h'])]
        x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
        if x1 > x0 and y1 > y0: m[y0:y1, x0:x1] = True
    return m


def measure(size, field, merch_mask, text_boxes=(), band_h=0, declared=(), panels=(), exclude=()):
    """size=(W,H); field={x,y,w,h}; merch_mask HxW bool (merchandise or photograph pixels); text_boxes: [{x,y,w,h}] incl. logo;
    declared: intentional negative-space rects; panels: [{x,y,w,h,content:[{x,y,w,h}]}] for the panel-content rule."""
    W, H = size
    fm = _rect_mask(H, W, [field]) & ~_rect_mask(H, W, exclude)   # field = rect minus reserved copy regions
    area = max(1, int(fm.sum()))
    mm = merch_mask & fm
    coverage = 100.0 * mm.sum() / area
    ys = np.where(mm.any(axis=1))[0]; xs = np.where(mm.any(axis=0))[0]
    ext_w = ((xs.max() - xs.min() + 1) / float(field['w'])) if len(xs) else 0.0
    ext_h = ((ys.max() - ys.min() + 1) / float(field['h'])) if len(ys) else 0.0
    upper = mm[int(field['y']):int(field['y'] + field['h'] / 2.0)]
    upper_pct = 100.0 * upper.sum() / max(1, int(fm[int(field['y']):int(field['y'] + field['h'] / 2.0)].sum()))
    content = merch_mask | _rect_mask(H, W, text_boxes)
    Hc = H - int(band_h)
    occ = (content | _rect_mask(H, W, declared))[:Hc]
    void_canvas = largest_empty_pct(occ)                       # % of the content area (canvas minus band)
    field_occ = (content | _rect_mask(H, W, declared) | ~fm)[:Hc]
    void_field = round(largest_empty_pct(field_occ) * (W * Hc) / float(area), 1)   # re-expressed as % of the field
    panel_results = []
    for p in panels or []:
        cm = _rect_mask(H, W, p.get('content', []))
        ph = max(1, int(p['h'])); rows = cm[int(p['y']):int(p['y'] + p['h']), int(p['x']):int(p['x'] + p['w'])].any(axis=1)
        filled = rows.sum() / float(ph)
        if len(np.where(rows)[0]):
            r = np.where(rows)[0]; filled = (r.max() - r.min() + 1) / float(ph)
        panel_results.append(dict(panel=p.get('role', 'panel'), content_height_frac=round(float(filled), 3), pass_=bool(filled >= 0.55)))
    return dict(field=dict(field), field_area_px=area, coverage_pct=round(float(coverage), 1), cluster_extent_w=round(float(ext_w), 3),
                cluster_extent_h=round(float(ext_h), 3), upper_field_merch_pct=round(float(upper_pct), 1),
                largest_accidental_void_pct=void_canvas, largest_accidental_void_field_pct=void_field,
                canvas_merchandise_pct=round(100.0 * merch_mask[:Hc].mean(), 1), panels=panel_results,
                declared_intentional=list(declared or []))


def gate(family, m):
    """Hard floors / caps (config gates) + soft points. Returns {pass, hard_failures[], soft: {...}, band}."""
    band = config.coverage_bands()['families'].get(family) or config.coverage_bands()['families']['CENTERED_WHITE']
    lo, hi = band['coverage_pct']; cap = band['largest_accidental_void_pct']
    hard = []
    if m['coverage_pct'] < lo - 10: hard.append('coverage %.1f%% is more than 10 points under the %s floor %d%%' % (m['coverage_pct'], family, lo))
    if m['largest_accidental_void_pct'] > cap + 4: hard.append('accidental void %.1f%% exceeds the %s cap %d%% by more than 4 points' % (m['largest_accidental_void_pct'], family, cap))
    for p in m.get('panels') or []:
        if not p['pass_']: hard.append('%s content fills %.0f%% of its height (< 55%%: a panel must earn its area)' % (p['panel'], p['content_height_frac'] * 100))
    soft = dict(coverage_in_band=lo <= m['coverage_pct'] <= hi, extent_w_ok=m['cluster_extent_w'] >= band['cluster_extent_w'][0],
                extent_h_ok=m['cluster_extent_h'] >= band['cluster_extent_h'][0], void_ok=m['largest_accidental_void_pct'] <= cap,
                upper_ok=m['upper_field_merch_pct'] >= band['upper_field_merch_pct_min'])
    return dict(pass_=not hard, hard_failures=hard, soft=soft, band=band)


def soft_points(family, m, pts=12):
    """Linear soft band: inside → full; within 10 points below / 4 above the cap → linear loss (config soft_band)."""
    band = config.coverage_bands()['families'].get(family) or config.coverage_bands()['families']['CENTERED_WHITE']
    lo, hi = band['coverage_pct']; c = m['coverage_pct']
    if lo <= c <= hi: cov = 1.0
    elif c < lo: cov = max(0.0, 1 - (lo - c) / 10.0)
    else: cov = max(0.0, 1 - (c - hi) / 10.0)
    cap = band['largest_accidental_void_pct']; v = m['largest_accidental_void_pct']
    void = 1.0 if v <= cap else max(0.0, 1 - (v - cap) / 4.0)
    return dict(coverage=round(pts * cov, 2), void=round(6 * void, 2))
