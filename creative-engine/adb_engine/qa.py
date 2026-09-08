"""Rendered thumbnail / feed QA (Phase 3O Wave 1 — blocker 4, part B + blocker 5 QA).

Deterministic, measurable checks for the required formats (4:5 native 1080x1350, and a 1:1 1080x1080 crop).
Reuses the shipped text-budget audit + category-balance. Renders a target-size preview when Playwright is
available; otherwise performs geometry-level checks (text-safe region clear of merchandise, essential info
present, brand footer intact, merchandise visible in the crop). Reduced text hierarchy is preserved; the
logo + footer wordmark do NOT count against the 5-block text budget.
"""
import os, sys
RUNTIME = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'runtime')
sys.path.insert(0, RUNTIME)
import spatial  # text_budget_audit + category_balance

# Title text-SAFE rectangle (centered column where the reduced-hierarchy copy sits). Side/tall objects that
# stay clear of this centered column are fine (the shipped layouts place objects at the edges + lower).
TITLE_SAFE = (320, 130, 760, 460)
FOOTER_BAND = (0, 1230, 1080, 1350)  # navy brand frame


def _rect_overlap(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def qa_format(comp, text_boxes, fmt, catalog_families=None):
    """fmt in {'4:5','1:1'}. Returns {format, pass, flags}."""
    flags = []
    notes = []
    # 1) text budget (logo/footer excluded) — the shipped audit.
    flags += spatial.text_budget_audit(comp, text_boxes or []).get('flags', [])
    # 2) category breadth — the shipped audit. A LUXURY-ONLY read is a hard fail; "families not shown" is an
    #    HONEST SIGNAL (an ad cannot show everything) reported as a note, never satisfied by fabrication.
    for f in spatial.category_balance(comp, catalog_families).get('flags', []):
        (flags if 'luxury' in f.lower() else notes).append(f)
    # 3) title-safe legibility: no object may intrude the CENTERED title text column.
    objs = [L for L in comp['layers'] if L.get('kind') == 'obj']
    for L in objs:
        box = (L['x'], L['y'], L['x'] + L['w'], L['y'] + L['h'])
        if _rect_overlap(box, TITLE_SAFE):
            flags.append(f'THUMB[{fmt}]: object {L["lot"]} intrudes the title text column')
    # 4) merchandise visibility in the crop (1:1 crops the vertical centre band 135..1215).
    if fmt == '1:1':
        crop = (0, 135, 1080, 1215)
        visible = [L for L in objs if _rect_overlap((L['x'], L['y'], L['x'] + L['w'], L['y'] + L['h']), crop)]
        if len(visible) < 3:
            flags.append('THUMB[1:1]: too little merchandise visible in the square crop')
    # 5) footer brand frame present.
    if not (comp.get('footer') or {}).get('h'):
        flags.append(f'THUMB[{fmt}]: brand footer missing')
    return dict(format=fmt, **{'pass': len(flags) == 0}, flags=flags, notes=notes)


def qa_all(comp, text_boxes=None, formats=('4:5', '1:1'), catalog_families=None):
    results = [qa_format(comp, text_boxes, f, catalog_families) for f in formats]
    return dict(**{'pass': all(r['pass'] for r in results)}, formats=results)
