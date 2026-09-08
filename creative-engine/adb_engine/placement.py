"""Automatic spatial placement (Phase 3O Wave 1 — blocker 3).

Role-slot templates DERIVED FROM the Owner-approved B3 layout (comp_b.spatial_b), filled by a bounded
solver that sizes each object so its baseline lands in the slot's required band, then audited by the SHIPPED
spatial.py. Candidates iterate (dropping optional objects on a violation) until spatial.audit returns
violations==[]. The audit is NEVER weakened. Deterministic + regression-testable.

Rule (locked): HEAVY OBJECTS OBEY GRAVITY. WALL OBJECTS OBEY WALLS. FOREGROUND OBJECTS MAY OVERLAP BOTH.
"""
import os, sys
RUNTIME = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'runtime')
sys.path.insert(0, RUNTIME)
import compose, spatial  # the acceptance authority

W, H = 1080, 1350
FOOT = 120
BAND_TOP = H - FOOT
FLOOR_MIN = round(H * 0.70)

# Slots derived from the approved B3 composition. Each: role, plane, x, y, target baseline band, support,
# contact, shadow, required(bool). w is solved so baseline (y + w*aspect) lands in the band.
SLOTS = [
    dict(id='wall_left',   role='WALL', plane='BACKGROUND', x=-60, y=138, band=(700, 1000), w_range=(360, 620), shadow='wall', required=False),
    dict(id='wall_lower',  role='WALL', plane='BACKGROUND', x=26,  y=560, band=(720, 1000), w_range=(180, 300), shadow='wall', required=False),
    dict(id='wall_right',  role='WALL', plane='BACKGROUND', x=806, y=158, band=(700, 1000), w_range=(220, 320), shadow='wall', required=False),
    dict(id='tall',        role='TALL', plane='MIDGROUND',  x=880, y=360, band=(945, 1150), w_range=(150, 240), shadow='back', contact=(0.5, 4, 0.9, 16, .22), required=False),
    dict(id='hero_main',   role='HERO', plane='MIDGROUND',  x=230, y=520, band=(1000, 1120), w_range=(560, 760), shadow='mid', contact=(0.5, 8, 0.96, 44, .30), required=True),
    dict(id='hero_surface',role='HERO', plane='MIDGROUND',  x=40,  y=760, band=(1120, 1180), w_range=(260, 340), shadow='front', contact=(0.5, 6, 0.8, 30, .32), surface_provider=True, required=True),
    dict(id='fg_left',     role='FOREGROUND', plane='FOREGROUND', x=20,  y=980,  band=(1160, 1230), w_range=(140, 210), shadow='mid', contact=(0.5, 6, 0.9, 20, .26), required=False),
    dict(id='fg_mid',      role='FOREGROUND', plane='FOREGROUND', x=190, y=978,  band=(1160, 1230), w_range=(190, 260), shadow='front', contact=(0.5, 6, 0.9, 22, .34), required=False),
    dict(id='fg_center',   role='FOREGROUND', plane='FOREGROUND', x=560, y=950,  band=(1170, 1230), w_range=(360, 480), shadow='front', required=False),
    dict(id='fg_right',    role='FOREGROUND', plane='FOREGROUND', x=892, y=1050, band=(1180, 1235), w_range=(240, 300), shadow='front', required=False),
    dict(id='fg_small',    role='FOREGROUND', plane='FOREGROUND', x=430, y=1034, band=(1160, 1230), w_range=(120, 220), shadow='front', required=False),
]

# Which selected-object roles satisfy which slot role.
ROLE_FITS = {
    'WALL': {'WALL'},
    'TALL': {'TALL', 'LIGHT', 'TALL_STRUCTURE'},
    'HERO': {'HERO', 'ANCHOR_H', 'TALL_STRUCTURE', 'TOOL_GROUP'},
    'FOREGROUND': {'FOREGROUND', 'SURFACE', 'OUTDOOR', 'LIGHT'},
}


def _aspect(inv, lot):
    return inv[lot]['h'] / inv[lot]['w']


def _solve_w(slot, aspect):
    """Choose w in w_range so baseline = y + w*aspect lands in the slot band. Returns w or None."""
    lo, hi = slot['w_range']; b0, b1 = slot['band']; y = slot['y']
    # baseline in [b0,b1] -> w in [(b0-y)/aspect, (b1-y)/aspect]
    wlo = max(lo, (b0 - y) / aspect); whi = min(hi, (b1 - y) / aspect)
    if wlo > whi:
        return None
    return int(round((wlo + whi) / 2))


def build_composition(name, assignments, inv, brand_layers=None):
    """assignments: list of (slot, lot). Builds a compose composition using the approved brand frame layers
    (passed in) + solved object layers. Returns the comp dict or None if a required slot cannot be solved."""
    layers = list(brand_layers or [])
    for slot, lot in assignments:
        w = _solve_w(slot, _aspect(inv, lot))
        if w is None:
            if slot['required']:
                return None
            continue
        layer = compose.obj(lot, slot['x'], slot['y'], w, z=_zfor(slot), shadow=slot.get('shadow', 'mid'),
                            contact=slot.get('contact'), role=slot['role'], plane=slot['plane'])
        layers.append(layer)
    bg = dict(background=compose.INV and 'white', footer=dict(h=FOOT))
    return dict(name=name, size=(W, H), layers=layers, footer=dict(h=FOOT))


_Z = {'wall_left': 10, 'wall_lower': 9, 'wall_right': 11, 'tall': 15, 'hero_main': 20, 'hero_surface': 24,
      'fg_left': 25, 'fg_mid': 27, 'fg_center': 30, 'fg_right': 40, 'fg_small': 35}
def _zfor(slot):
    return _Z.get(slot['id'], 25)


def place(name, selected, inv, brand_layers=None):
    """selected: ordered list of dicts {lot, role} (from selection). Assign to role-appropriate slots, solve,
    audit; on any violation drop the last optional object and retry. Returns (comp, audit_summary, rows) with
    violations==[] or (None, summary, rows) if no passing composition exists (→ REVIEW)."""
    # Greedy assign: fill required slots first, then optional, matching role.
    pools = {}
    for s in selected:
        pools.setdefault(s['role'], []).append(s['lot'])
    used = set(); assignments = []
    for slot in SLOTS:
        cand = None
        for r in ROLE_FITS[slot['role']]:
            for lot in pools.get(r, []):
                if lot not in used and _solve_w(slot, _aspect(inv, lot)) is not None:
                    cand = lot; break
            if cand:
                break
        if cand:
            used.add(cand); assignments.append((slot, cand))
        elif slot['required']:
            return None, {'violations': [(slot['id'], 'required-slot-unfilled')]}, []
    # Iterate: on a violation, drop the SPECIFIC offending optional object (e.g. a protected-region that would
    # be occluded routes that object to REVIEW) and re-audit. NEVER weaken the audit. Required objects that
    # violate mean no safe composition exists → REVIEW.
    order = list(assignments)
    guard = 0
    while order and guard < 40:
        guard += 1
        comp = build_composition(name, order, inv, brand_layers)
        if comp is None:
            order = _drop_last_optional(order)
            if order is None:
                return None, {'violations': [('composition', 'required-unsolvable')]}, []
            continue
        rows, summ = spatial.audit(comp)
        if not summ['violations']:
            return comp, summ, rows
        offending_lots = {v[0] for v in summ['violations']}
        dropped = _drop_lots(order, offending_lots)   # drop only OPTIONAL offenders
        if dropped is None:
            return None, summ, rows   # a REQUIRED object violated → no safe composition → REVIEW
        order = dropped
    return None, {'violations': [('composition', 'empty')]}, []


def _drop_last_optional(order):
    for i in range(len(order) - 1, -1, -1):
        if not order[i][0]['required']:
            return order[:i] + order[i + 1:]
    return None  # nothing optional left to drop


def _drop_lots(order, lots):
    """Drop the OPTIONAL assignments whose lot is in `lots`. Returns the reduced order, or None if any
    offending lot is REQUIRED (→ no safe composition; route to REVIEW)."""
    for slot, lot in order:
        if lot in lots and slot['required']:
            return None
    reduced = [(slot, lot) for slot, lot in order if lot not in lots]
    return reduced if len(reduced) < len(order) else _drop_last_optional(order)
