"""Phase 3M.3 - spatial role model, gravity/wall rules, depth planes, and the automatic spatial audit.
Roles are compositional, not product categories; an object may qualify for more than one.
"""
import json, os
import numpy as np
from compose import INV, _mask, ASSETS

# ---- spatial roles for the CLEAN inventory (primary first) ----
ROLES = {
    '73':  ['WALL'],                       # Nierman abstract oil
    '74':  ['WALL'],                       # Chagall lithograph
    '44e': ['WALL'],                       # Knox Martin etching
    '3':   ['WALL', 'TALL'],               # cathedral mirror: hung, or standing against a wall
    '31':  ['HERO'],                       # pair of wingback chairs
    '36':  ['HERO', 'SURFACE_PROVIDER'],   # pie-crust table: structural, and a surface for small objects
    '46':  ['TALL'],                       # bronze torchiere
    '78':  ['FOREGROUND', 'SURFACE'],      # marble bust
    '63':  ['SURFACE', 'FOREGROUND'],      # sterling bowl
    '13':  ['SURFACE', 'FOREGROUND'],      # silver chocolate pitcher
    '25':  ['SURFACE', 'FOREGROUND'],      # Boehm pheasant
    '11d': ['SURFACE', 'FOREGROUND'],      # rose quartz sphere
    '11c': ['FOREGROUND', 'SURFACE'],      # apophyllite
    '20':  ['FOREGROUND', 'SURFACE'],      # Indian document box
    '53':  ['FOREGROUND', 'SURFACE'],      # pair of porcelain vases
    '30':  ['FOREGROUND'],                 # Imari plates (grouped)
    '87':  ['FOREGROUND'],                 # Herend service (grouped)
}
# protected identifying regions, as fractions of the object's own box (x0,y0,x1,y1). Must stay in-frame and unoccluded.
PROTECTED = {
    '73': [('signature', 0.84, 0.86, 0.99, 0.96)],
    '44e': [('signature area', 0.05, 0.90, 0.95, 0.99)],
}
HEAVY = {'HERO', 'TALL'}

# ---- Supplemental calibration (Owner-approved, post-3M.3): additional spatial roles ----
# These extend the vocabulary; nothing in the locked 3M.3 roles changes.
#   LIGHT           table/floor lamps - introduce warmth and illumination; grounded (floor) or SURFACE (table lamp)
#   TALL_STRUCTURE  cabinets, armoires, bookcases - vertical structure; HERO-class gravity
#   ANCHOR_H        trunk, coffee table, chest - central horizontal anchor; HERO-class gravity; SURFACE_PROVIDER
#   TOOL_GROUP      tools, power tools, toolboxes, rolling tool cabinet - a substantial grouped mass, grounded
#   OUTDOOR         grills, patio, garden - grounded, usually foreground/edge
ROLE_PLANE_DEFAULTS = {'WALL': 'BACKGROUND', 'HERO': 'MIDGROUND', 'TALL': 'MIDGROUND', 'SURFACE': 'MIDGROUND',
                       'LIGHT': 'MIDGROUND', 'TALL_STRUCTURE': 'MIDGROUND', 'ANCHOR_H': 'MIDGROUND', 'TOOL_GROUP': 'MIDGROUND', 'OUTDOOR': 'FOREGROUND'}
HEAVY = HEAVY | {'TALL_STRUCTURE', 'ANCHOR_H', 'TOOL_GROUP'}

# Merchandise breadth: broad auction ads should not read as antiques/fine art/jewelry only. Category families for the balance check.
CATEGORY_FAMILIES = {
    'furniture': {'Furniture'}, 'lighting': {'Lighting'}, 'tools': {'Tools', 'Power tools', 'Shop equipment'},
    'household': {'Dinnerware', 'Household', 'Kitchen', 'Glassware'}, 'collectibles': {'Collectibles', 'Minerals', 'Watches'},
    'decor': {'Porcelain', 'Porcelain figure', 'Asian ceramics', 'Metalware', 'Silver', 'Sculpture'},
    'art': {'Fine art', 'Works on paper'}, 'jewelry': {'Jewelry'}, 'outdoor': {'Outdoor', 'Garden', 'Patio'},
}
LUXURY_FAMILIES = {'art', 'jewelry', 'decor'}

# Text budget (Owner: less text). Slots allowed on a general ad: presenter/logo, one primary message, one short supporting line,
# essential event info, brand footer. Anything beyond is flagged.
TEXT_BUDGET = dict(max_text_blocks=5, max_words_primary=6, max_words_support=10)

def text_budget_audit(comp, boxes):
    """boxes = measured text boxes from render(). Flags over-budget copy. Logo and footer wordmark do not count as copy."""
    copy = [b for b in boxes if not b.get('logo') and (b.get('text') or '').strip() and (b.get('text') or '').strip() != 'Advantage.Bid']
    n = len(copy)
    flags = []
    if n > TEXT_BUDGET['max_text_blocks']: flags.append(f'TEXT: {n} copy blocks > budget {TEXT_BUDGET["max_text_blocks"]}')
    return dict(copy_blocks=n, flags=flags, blocks=[(b.get('text') or '')[:40] for b in copy])

def category_balance(comp, catalog_families=None):
    """Which families the composition shows vs. what the auction contains. catalog_families = set of families present in the auction
    (from lots.category_key). Flags: an available family with no object shown; a luxury-only read on a broad ad."""
    objs = [L for L in comp['layers'] if L['kind'] == 'obj']
    shown = set()
    for L in objs:
        cat = INV[L['lot']]['cat']
        for fam, cats in CATEGORY_FAMILIES.items():
            if cat in cats: shown.add(fam)
    flags = []
    if catalog_families:
        missing = set(catalog_families) - shown
        if missing: flags.append('BREADTH: catalog families not shown: ' + ', '.join(sorted(missing)))
    if shown and shown <= LUXURY_FAMILIES: flags.append('BREADTH: composition reads as luxury/antiques only')
    return dict(families_shown=sorted(shown), flags=flags)


def role_of(L):
    return L.get('role') or ROLES.get(L['lot'], ['FOREGROUND'])[0]

def plane_of(L):
    if L.get('plane'): return L['plane']
    r = role_of(L)
    return ROLE_PLANE_DEFAULTS.get(r, 'FOREGROUND')

def audit(comp, floor_min_frac=0.70):
    """Per-object spatial audit + summary. Uses the real alpha masks at placed size."""
    W, H = comp['size']
    band_top = H - (comp.get('footer') or {}).get('h', 0)
    floor_min = round(H * floor_min_frac)
    objs = [L for L in comp['layers'] if L['kind'] == 'obj']
    masks = {}; rows = {}
    for L in objs:
        m, _ = _mask(L, W, H); masks[L['lot']] = m
        ys = np.where(m.any(axis=1))[0]; xs = np.where(m.any(axis=0))[0]
        top, base = (int(ys.min()), int(ys.max())) if len(ys) else (None, None)
        edges = []
        if L['x'] < 0: edges.append('left')
        if L['x'] + L['w'] > W: edges.append('right')
        if L['y'] < 0: edges.append('top')
        if L['y'] + L['h'] > band_top: edges.append('bottom/band')
        rows[L['lot']] = dict(lot=L['lot'], name=INV[L['lot']]['name'], role=role_of(L), roles=ROLES.get(L['lot'], []), plane=plane_of(L),
                              anchor=bool(L['w'] >= 0.40 * W or L['h'] >= 0.40 * H), top=top, baseline=base, z=L['z'],
                              edges=edges, support=L.get('support'), shadow=L['shadow'], contact=bool(L.get('contact')),
                              in_front_of=[], behind=[], checks=[])
    # overlap relationships with direction
    lots = [L['lot'] for L in objs]; zof = {L['lot']: L['z'] for L in objs}
    meaningful = 0; decorative = 0
    for i in range(len(lots)):
        for j in range(i + 1, len(lots)):
            a, b = lots[i], lots[j]
            if (masks[a] & masks[b]).sum() <= 400: continue
            front, back = (a, b) if zof[a] > zof[b] else (b, a)
            rows[front]['in_front_of'].append(back); rows[back]['behind'].append(front)
            pf, pb = rows[front]['plane'], rows[back]['plane']; rf, rb = rows[front]['role'], rows[back]['role']
            ok = (pf != pb) or (rf == 'SURFACE' and rb in ('HERO', 'SURFACE_PROVIDER')) or (rb == 'TALL') or (rf == 'FOREGROUND' and rb != 'FOREGROUND')
            if ok: meaningful += 1
            else: decorative += 1
    # rule checks
    violations = []
    for L in objs:
        r = rows[L['lot']]; role = r['role']
        # gravity: heavy objects need a baseline in the floor band
        if role in HEAVY:
            if r['baseline'] is None or not (floor_min <= r['baseline'] <= band_top + 4):
                r['checks'].append('GRAVITY: baseline outside floor band'); violations.append((L['lot'], 'gravity'))
            else: r['checks'].append('grounded')
            if not r['contact'] and role == 'HERO': r['checks'].append('no contact shadow')
        # wall objects: hang above the floor band, never in front of a non-wall object
        if role == 'WALL':
            if r['baseline'] is not None and r['baseline'] > floor_min + 60:
                r['checks'].append('WALL: hangs into the floor band'); violations.append((L['lot'], 'wall-too-low'))
            else: r['checks'].append('hung')
            if r['contact']: r['checks'].append('WALL: has a contact shadow'); violations.append((L['lot'], 'wall-contact'))
            for f in r['behind']:
                pass  # anything may sit in front of a wall object
            for b in r['in_front_of']:
                r['checks'].append(f'WALL: in front of {b}'); violations.append((L['lot'], 'wall-in-front'))
        # surface objects declared on a support: baseline must sit in the support's top band
        if r['support']:
            s = rows.get(r['support'])
            if s and not (s['top'] - 10 <= r['baseline'] <= s['top'] + 0.35 * (s['baseline'] - s['top'])):
                r['checks'].append(f'SURFACE: not resting on {r["support"]}'); violations.append((L['lot'], 'surface-float'))
            else: r['checks'].append(f'rests on {r["support"]}')
        # perspective consistency among grounded objects that overlap horizontally
    grounded = [rows[l] for l in lots if rows[l]['role'] in HEAVY or (rows[l]['plane'] == 'FOREGROUND')]
    for a in grounded:
        for b in grounded:
            if a is b or a['z'] >= b['z']: continue      # a behind b
            La = next(L for L in objs if L['lot'] == a['lot']); Lb = next(L for L in objs if L['lot'] == b['lot'])
            if La['x'] < Lb['x'] + Lb['w'] and Lb['x'] < La['x'] + La['w'] and a['support'] is None and b['support'] is None:
                if a['baseline'] is not None and b['baseline'] is not None and a['baseline'] > b['baseline'] + 30 and a['role'] in HEAVY and b['role'] in HEAVY:
                    a['checks'].append(f'PERSPECTIVE: behind {b["lot"]} but baseline lower'); violations.append((a['lot'], 'perspective'))
    # protected regions: in frame and unoccluded
    for L in objs:
        for (label, fx0, fy0, fx1, fy1) in PROTECTED.get(L['lot'], []):
            x0 = L['x'] + fx0 * L['w']; x1 = L['x'] + fx1 * L['w']; y0 = L['y'] + fy0 * L['h']; y1 = L['y'] + fy1 * L['h']
            r = rows[L['lot']]
            if x0 < 0 or y0 < 0 or x1 > W or y1 > band_top:
                r['checks'].append(f'PROTECTED {label}: cropped'); violations.append((L['lot'], 'protected-cropped')); continue
            xs0, xs1, ys0, ys1 = int(x0), int(x1), int(y0), int(y1)
            occluder = None
            for M in objs:
                if M['z'] > L['z'] and masks[M['lot']][ys0:ys1, xs0:xs1].mean() > 0.15: occluder = M['lot']; break
            if occluder: r['checks'].append(f'PROTECTED {label}: occluded by {occluder}'); violations.append((L['lot'], 'protected-occluded'))
            else: r['checks'].append(f'{label} visible')
    planes = {}
    for r in rows.values(): planes[r['plane']] = planes.get(r['plane'], 0) + 1
    roles = {}
    for r in rows.values(): roles[r['role']] = roles.get(r['role'], 0) + 1
    summary = dict(planes=planes, roles=roles, plane_count=len(planes), role_count=len(roles),
                   meaningful_overlaps=meaningful, decorative_overlaps=decorative, violations=violations,
                   bridging=[r['lot'] for r in rows.values() if r['top'] is not None and r['top'] < H * 0.45 and r['baseline'] is not None and r['baseline'] > H * 0.72])
    return [rows[l] for l in lots], summary

def audit_table_html(rows, summary):
    def td(v): return f'<td>{v}</td>'
    out = ['<table><thead><tr><th>Lot</th><th>Object</th><th>Role</th><th>Plane</th><th>Anchor</th><th>In front of</th><th>Behind</th><th>Edges</th><th>Shadow</th><th>Checks</th></tr></thead><tbody>']
    for r in rows:
        chk = '; '.join(r['checks']) or '—'
        bad = any(c.split(':')[0].isupper() and ':' in c for c in r['checks'])
        out.append(f'<tr{" class=bad" if bad else ""}>{td(r["lot"])}{td(r["name"])}{td(r["role"] + ((" (" + "/".join(x for x in r["roles"] if x != r["role"]) + ")") if len([x for x in r["roles"] if x != r["role"]]) else ""))}{td(r["plane"])}{td("yes" if r["anchor"] else "")}'
                   f'{td(", ".join(r["in_front_of"]) or "—")}{td(", ".join(r["behind"]) or "—")}{td(", ".join(r["edges"]) or "—")}{td(r["shadow"] + (" + contact" if r["contact"] else ""))}{td(chk)}</tr>')
    out.append('</tbody></table>')
    return ''.join(out)
