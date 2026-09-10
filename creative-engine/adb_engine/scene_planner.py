"""Phase 3P.1 Mission 5 — composition intelligence: plan the scene BEFORE rendering.

Identify → Classify (taxonomy) → Estimate relative scale (primary anchor → px/in) → Select anchors → Establish planes
(floor line, rear line, wall line, support tops) → Establish relationships (typed edges: BESIDE, BEHIND, ON, HANGS_ABOVE,
FOREGROUND_ACCENT) → Fill secondary space → Foreground accents → physical audit + coverage fit → render.

Every object is sized from its real-world height (catalogue dimensions win over class defaults) × one scene scale ×
the audit's depth factor, so relative scale is correct by construction; the audit then checks it independently. An
audit violation returns to the step that caused it (config violation_to_planner_step) — the renderer never nudges
pixels to "fix" a plan. Assets are trimmed to their opaque bounding box once (cache) so sizes mean object sizes.
"""
import copy, hashlib, json, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from . import config, taxonomy, physical_audit, coverage

CACHE = os.path.join(config.ENGINE, 'runtime', 'cache', 'trim')
ANNOT = os.path.join(config.ENGINE, 'runtime', 'assets', 'annotations.json')


def _annotations():
    try:
        with open(ANNOT, encoding='utf-8') as f: return json.load(f)
    except Exception: return {}


def trimmed(path):
    """Crop an RGBA asset to its opaque bounding box (alpha > 64). Returns (trimmed_path, (w, h), bbox_in_original)."""
    src = path if os.path.isabs(path) else os.path.join(config.ENGINE, path)
    os.makedirs(CACHE, exist_ok=True)
    key = hashlib.sha256(open(src, 'rb').read()).hexdigest()[:16]
    out = os.path.join(CACHE, os.path.splitext(os.path.basename(src))[0] + '-' + key + '.png')
    im = Image.open(src).convert('RGBA')
    a = np.asarray(im)[:, :, 3] > 64
    ys = np.where(a.any(axis=1))[0]; xs = np.where(a.any(axis=0))[0]
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(xs) else (0, 0, im.width, im.height)
    if not os.path.exists(out): im.crop(bbox).save(out, 'PNG')
    return out, (bbox[2] - bbox[0], bbox[3] - bbox[1]), (bbox, im.size)


def _protected_for(asset, bbox_info):
    """Per-asset protected-feature rects (fractions of the ORIGINAL image) converted to the trimmed image."""
    ann = _annotations().get(os.path.basename(asset), {})
    (x0, y0, x1, y1), (W0, H0) = bbox_info
    tw, th = float(x1 - x0), float(y1 - y0)
    out = []
    for label, fx0, fy0, fx1, fy1 in ann.get('protected', []):
        out.append([label, (fx0 * W0 - x0) / tw, (fy0 * H0 - y0) / th, (fx1 * W0 - x0) / tw, (fy1 * H0 - y0) / th])
    return out


def _roles(objs):
    floor = [o for o in objs if o['rec']['plane'] == 'floor']
    if not floor: return None
    primary = max(floor, key=lambda o: (o['rec'].get('anchor_weight', 0), o['h_in'] * o['aspect']))
    roles = {}
    for o in objs:
        r = o['rec']; p = r['plane']
        if o is primary: roles[o['id']] = 'HERO'
        elif p == 'wall': roles[o['id']] = 'WALL'
        elif p == 'ground': roles[o['id']] = 'GROUND'
        elif p in ('table', 'shelf', 'pedestal'): roles[o['id']] = 'SURFACE'
        elif p == 'floor' and o['h_in'] >= 55: roles[o['id']] = 'TALL'
        elif p == 'floor' and r.get('can_support'): roles[o['id']] = 'SURFACE_PROVIDER'
        else: roles[o['id']] = 'SECONDARY'
    return primary, roles


def _prepare(objects):
    out = []
    for o in objects:
        res = taxonomy.resolve(o.get('title'), o.get('category_key'), o.get('dims_in'), o.get('semantic_class'))
        tp, (tw, th), bbox_info = trimmed(o['asset'])
        rec = res['record']
        out.append(dict(id=o['id'], asset=tp, source_asset=o['asset'], title=o.get('title'), semantic_class=res['semantic_class'], resolved_by=res['resolved_by'],
                        confidence=res['confidence'], dims_source=res['dims_source'], dims_in=o.get('dims_in'), rec=rec,
                        h_in=float(rec.get('typical_height_in') or 24), aspect=tw / float(th), protected=_protected_for(o['asset'], bbox_info),
                        representative=o.get('representative', False), role_hint=o.get('role_hint'), group=o.get('group')))
    return out


def _depth(base, primary_base, H):
    return 1.0 + 0.25 * min(1.0, max(0.0, (base - primary_base) / (0.2 * H)))


def _layout(objs, roles, primary, field, H, s, arrangement, T, opts):
    """Deterministic placement for scene scale s. Returns (layers, edges, planes)."""
    fx, fy, fw, fh = field['x'], field['y'], field['w'], field['h']
    ds = T['depth_step_frac'] * H
    accents = [o for o in objs if roles[o['id']] == 'SURFACE' and o.get('role_hint') == 'accent' and opts.get('accent_mode', 'foreground') == 'foreground']
    surfaces = [o for o in objs if roles[o['id']] == 'SURFACE' and o not in accents]
    providers = [o for o in objs if roles[o['id']] == 'SURFACE_PROVIDER']
    talls = [o for o in objs if roles[o['id']] == 'TALL']
    secondaries = [o for o in objs if roles[o['id']] == 'SECONDARY']
    walls = [o for o in objs if roles[o['id']] == 'WALL']
    # Surface objects that cannot find a provider become accents when small enough (declared floor-vignette decor).
    if not providers:
        for o in list(surfaces):
            if o['rec'].get('foreground_suitability', 0) >= 3 and o['rec']['size_class'] in ('XS', 'S'):
                surfaces.remove(o); accents.append(o)
    bottom_margin = opts.get('bottom_margin_frac', 0.03) * fh
    # an accent keeps its own strip only when it is big enough at this scale to overlap the anchor's lower edge
    hero_h_px = primary['h_in'] * s
    live_accents = [o for o in accents if o['h_in'] * s * 1.2 > ds * 1.02 + 0.04 * hero_h_px]
    F = fy + fh - bottom_margin - ((ds * 1.1 + 4) if live_accents else 0)     # mid floor line (primary baseline)
    R = F - ds * 1.12                                                       # rear floor line (tall verticals behind)
    size = lambda o, depth=1.0: (o['h_in'] * s * depth * o['aspect'], o['h_in'] * s * depth)
    layers, edges = {}, []

    def put(o, cx, base, z, depth=1.0, **kw):
        w, h = size(o, depth)
        layers[o['id']] = dict(id=o['id'], asset=o['asset'], semantic_class=o['semantic_class'], x=cx - w / 2.0, y=base - h, w=w, h=h, z=z,
                               baseline=base, depth_factor=round(depth, 3), plane=o['rec']['plane'], protected=o['protected'],
                               dims_in=o.get('dims_in'), role=roles[o['id']], **kw)
        return layers[o['id']]

    # Floor row. Arrangements are explicit left-to-right orders around the HERO:
    #   anchor_right  [tall, provider, secondary, HERO]      anchor_left    [HERO, secondary, provider, tall]
    #   split         [provider, HERO, secondary, tall]      split_reverse  [tall, secondary, HERO, provider]
    # A tall vertical stands on the rear line; a surface provider next to it stands in front of its lower edge (valid
    # layering: closer by a depth step, overlap inside the tall object's bottom band). Everything else is BESIDE with a gap.
    pw, ph = size(primary)
    gap = opts.get('beside_gap_frac', 0.012) * fw
    T0 = talls[0] if talls else None; P0 = providers[0] if providers else None; S0 = secondaries[0] if secondaries else None
    HERO_ = 'HERO'
    orders = {'anchor_right': [T0, P0, S0, HERO_], 'anchor_left': [HERO_, S0, P0, T0], 'split': [P0, HERO_, S0, T0], 'split_reverse': [T0, S0, HERO_, P0]}
    seq = [x for x in orders.get(arrangement, orders['anchor_right']) if x is not None]
    extras = talls[1:] + providers[1:] + secondaries[1:]
    for i, e in enumerate(extras):
        if i % 2: seq.insert(0, e)
        else: seq.append(e)
    def obj_of(x): return primary if x == HERO_ else x
    def role_of(x): return 'HERO' if x == HERO_ else roles[x['id']]
    widths = [size(obj_of(x))[0] for x in seq]
    joins = []
    for a, b in zip(seq, seq[1:]):
        ra, rb = role_of(a), role_of(b)
        if {ra, rb} == {'TALL', 'SURFACE_PROVIDER'}:
            prov = a if ra == 'SURFACE_PROVIDER' else b
            joins.append(-0.15 * size(obj_of(prov))[0])     # provider overlaps the tall vertical's lower edge
        else:
            joins.append(gap)
    total = sum(widths) + sum(joins)
    align = opts.get('align', 'center'); side = opts.get('side_margin_frac', 0.02) * fw
    if align == 'right': start = fx + fw - side - total
    elif align == 'left': start = fx + side
    else: start = fx + (fw - total) / 2.0
    xc = start
    hero = None
    for i, x in enumerate(seq):
        o = obj_of(x); r = role_of(x); w_ = widths[i]
        base = R if r == 'TALL' else F
        z = {'TALL': 1, 'HERO': 2, 'SECONDARY': 2, 'SURFACE_PROVIDER': 3}.get(r, 2)
        L_ = put(o, xc + w_ / 2.0, base, z)
        if r == 'HERO': hero = L_
        if i + 1 < len(seq): xc += w_ + joins[i]
    for x in seq:
        if x == HERO_: continue
        r = role_of(x)
        nb = seq[seq.index(x) - 1] if seq.index(x) > 0 else None
        na = seq[seq.index(x) + 1] if seq.index(x) + 1 < len(seq) else None
        pair = [n for n in (nb, na) if n is not None and {role_of(n), r} == {'TALL', 'SURFACE_PROVIDER'}]
        if pair and r == 'SURFACE_PROVIDER':
            edges.append(dict(type='IN_FRONT_OF', a=x['id'], b=obj_of(pair[0])['id']))
        edges.append(dict(type='BESIDE', a=x['id'], b=primary['id']))
    # Surface objects ON providers (top band), distributed across the provider's top.
    prov_placed = [layers[o['id']] for o in providers if o['id'] in layers]
    for i, o in enumerate(surfaces):
        if not prov_placed:
            continue
        pl = prov_placed[i % len(prov_placed)]
        ow, oh = size(o)
        n_on = sum(1 for j, _ in enumerate(surfaces) if j % len(prov_placed) == i % len(prov_placed))
        k = sum(1 for j in range(i) if j % len(prov_placed) == i % len(prov_placed))
        slot = pl['x'] + pl['w'] * (0.5 if n_on == 1 else (0.3 + 0.4 * k / max(1, n_on - 1)))
        base = pl['y'] + pl['h'] * opts.get('surface_seat_frac', 0.05)
        put(o, slot, base, 4, support=pl['id']); edges.append(dict(type='ON', a=o['id'], b=pl['id']))
    # Foreground accents: small decor over the lower edge of the anchor, avoiding its protected features.
    for i, o in enumerate(list(accents)):
        base = min(field['y'] + field['h'] - 2, F + ds * 1.02)
        depth = _depth(base, F, H)
        ow, oh = size(o, depth)
        if base - oh > F - 0.04 * hero['h']:
            # too small at this scene scale to overlap the anchor's lower edge → it would float: seat it on a support
            pl = next((layers[p['id']] for p in providers if p['id'] in layers and (o['semantic_class'] in (p['rec'].get('can_support') or []))), None)
            if pl is not None:
                sw_, sh_ = size(o)
                put(o, pl['x'] + pl['w'] * 0.72, pl['y'] + pl['h'] * opts.get('surface_seat_frac', 0.05), 4, support=pl['id'])
                edges.append(dict(type='ON', a=o['id'], b=pl['id'], note='accent reassigned: too small to overlap the anchor edge at this scale'))
            continue
        side = opts.get('accent_side', 'right' if arrangement != 'anchor_left' else 'left')
        ax = hero['x'] + hero['w'] * (0.86 if side == 'right' else 0.14) + (i * ow * 1.1 if side == 'right' else -i * ow * 1.1)
        put(o, ax, base, 5 + i, depth=depth, floor_accent=True); edges.append(dict(type='FOREGROUND_ACCENT', a=o['id'], b=primary['id']))
    # Wall objects HANG ABOVE the anchor line (always behind), as a gallery centred over the floor cluster: row 1 sits one
    # wall gap above the anchor's top; pieces that do not fit the cluster width go to a second row above it. Tall floor
    # verticals may rise in front of the gallery (wall objects are behind everything).
    if walls:
        floor_layers = [l for l in layers.values() if l['plane'] == 'floor']
        cl = min(l['x'] for l in floor_layers); cr = max(l['x'] + l['w'] for l in floor_layers)
        target = layers.get(opts.get('wall_target')) or hero
        wgap = opts.get('wall_gap_frac', 0.035) * fh
        ggap = gap * 1.6
        zone = opts.get('wall_zone')           # the gallery never enters a copy column: it is confined to the wall zone
        zx0, zx1 = (zone['x'], zone['x'] + zone['w']) if zone else (fx, fx + fw)
        limit_w = (zx1 - zx0) * 0.96
        # Pack at most two rows that fit the wall zone (largest pieces first). A piece with no wall room is left out and
        # recorded — never squeezed into a copy column and never shrunk on its own (scale stays uniform).
        rows, widths, dropped = [[], []], [0.0, 0.0], []
        for o in sorted(walls, key=lambda o: -o['h_in'] * o['aspect']):
            ow, oh = size(o)
            for ri in range(max(1, min(2, opts.get('gallery_rows_hint', 1) if opts.get('gallery_rows_hint', 1) > 1 else 1))):
                need = ow + (ggap if rows[ri] else 0)
                if widths[ri] + need <= limit_w:
                    rows[ri].append(o); widths[ri] += need; break
            else:
                dropped.append(o['id'])
        rows = [r_ for r_ in rows if r_]
        for d_ in dropped: edges.append(dict(type='NOT_PLACED', a=d_, b=None, note='no wall room inside the wall zone at this scale'))
        line = target['y'] - wgap
        centre_x = target['x'] + target['w'] / 2.0 if opts.get('gallery_over') == 'target' else (cl + cr) / 2.0
        for ri, row in enumerate(rows):
            dims = [size(o) for o in row]
            row_h = max(h for _, h in dims); row_w = sum(w for w, _ in dims) + ggap * (len(row) - 1)
            if ri > 0 and line - row_h < fy + opts.get('top_margin_frac', 0.02) * fh:
                for o in row: edges.append(dict(type='NOT_PLACED', a=o['id'], b=None, note='second gallery row does not fit the wall at this scale'))
                break
            cx_row = min(max(centre_x, zx0 + row_w / 2.0), zx1 - row_w / 2.0)
            wx = cx_row - row_w / 2.0; mid = line - row_h / 2.0
            for o, (ow, oh) in zip(row, dims):
                put(o, wx + ow / 2.0, mid + oh / 2.0, 0, contact_shadow=False); edges.append(dict(type='HANGS_ABOVE', a=o['id'], b=target['id']))
                wx += ow + ggap
            line = line - row_h - wgap
    planes = dict(floor_baseline=round(F, 1), rear_baseline=round(R, 1), wall_top_line=round(min((l['y'] for l in layers.values() if l['plane'] == 'wall'), default=F), 1),
                  supports={l['id']: dict(top_band=[round(l['y'] - 10, 1), round(l['y'] + 0.35 * l['h'], 1)]) for l in layers.values() if l['role'] == 'SURFACE_PROVIDER'})
    return layers, edges, planes


def _scale_limits(objs, roles, primary, field, H, T, opts):
    """Largest scene scale that keeps every object inside the field (vertical) with the wall gallery above the anchor."""
    fh, fw = field['h'], field['w']
    ds = T['depth_step_frac'] * H
    usable_h = fh * (1 - opts.get('bottom_margin_frac', 0.03)) - (ds * 1.1 + 4 if any(o.get('role_hint') == 'accent' for o in objs) else 0) - opts.get('top_margin_frac', 0.02) * fh
    tallest = max(o['h_in'] for o in objs if o['rec']['plane'] == 'floor')
    walls = [o for o in objs if roles[o['id']] == 'WALL']
    s_v = usable_h / tallest
    if walls:
        wall_h = max(o['h_in'] for o in walls)
        # scale is budgeted for ONE gallery row above the anchor; a second row is placed only if it fits the wall
        s_v = min(s_v, (usable_h - opts.get('wall_gap_frac', 0.035) * fh) / (primary['h_in'] + wall_h))
    row = [o for o in objs if roles[o['id']] in ('HERO', 'TALL', 'SURFACE_PROVIDER', 'SECONDARY')]
    row_in = sum(o['h_in'] * o['aspect'] for o in row)
    s_h = (fw * (1 - 2 * opts.get('side_margin_frac', 0.02))) / max(1e-6, row_in * 1.02)
    return min(s_v, s_h), dict(vertical=round(s_v, 3), horizontal=round(s_h, 3))


def _masks(layers, W, H):
    ms = {}
    for l in layers.values():
        m, _ = physical_audit.mask_of(l, W, H); ms[l['id']] = m
    return ms


def plan(objects, field, canvas, family='ACQUISITION', arrangement='anchor_right', copy_regions=(), declared=(), options=None, max_iter=8):
    opts = dict(options or {})
    T = config.thresholds()
    W, H = canvas
    objs = _prepare(objects)
    r = _roles(objs)
    if not r: return dict(ok=False, error='no floor object to anchor the scene (planner needs a floor anchor; use a category family)')
    primary, roles = r
    unresolved_anchor = primary['semantic_class'] == 'unresolved'
    s, limits = _scale_limits(objs, roles, primary, field, H, T, opts)
    s *= opts.get('scale_factor', 1.0)
    history = []
    band = config.coverage_bands()['families'].get(family) or config.coverage_bands()['families']['CENTERED_WHITE']
    for it in range(max_iter):
        layers, edges, planes = _layout(objs, roles, primary, field, H, s, arrangement, T, opts)
        out_of_field = [l['id'] for l in layers.values() if l['y'] < field['y'] - 1 or l['x'] < field['x'] - 1 or l['x'] + l['w'] > field['x'] + field['w'] + 1]
        if out_of_field and it < max_iter - 1:
            history.append(dict(iteration=it, scale_px_per_in=round(s, 3), out_of_field=out_of_field)); s *= 0.95; continue
        ms = _masks(layers, W, H)
        # never enter a copy region (object PIXELS, not bounding boxes): a hung artwork that clashes is left out at the
        # same scale (it is decorative); any other clash re-plans the whole scene smaller — never clipped.
        clash = []
        for lid, m in ms.items():
            for c in copy_regions or []:
                x0, y0 = max(0, int(c['x'])), max(0, int(c['y'])); x1, y1 = min(W, int(c['x'] + c['w'])), min(H, int(c['y'] + c['h']))
                if x1 > x0 and y1 > y0 and m[y0:y1, x0:x1].sum() > 150: clash.append(lid); break
        wall_clash = [c_ for c_ in clash if roles.get(c_) == 'WALL']
        if clash and set(clash) == set(wall_clash) and it < max_iter - 1:
            opts.setdefault('_excluded_walls', []).extend(wall_clash)
            objs = [o for o in objs if o['id'] not in wall_clash]
            history.append(dict(iteration=it, scale_px_per_in=round(s, 3), walls_left_out=wall_clash, reason='hung art would enter a copy region'))
            continue
        au = physical_audit.audit(dict(size=[W, H], layers=list(layers.values())), masks=ms)
        merch = np.zeros((H, W), bool)
        for m in ms.values(): merch |= m
        cov = coverage.measure((W, H), field, merch, band_h=opts.get('band_h', 0), declared=declared)
        step = dict(iteration=it, scale_px_per_in=round(s, 3), violations=[v['kind'] + ':' + v['id'] for v in au['violations']], copy_region_clash=clash,
                    coverage_pct=cov['coverage_pct'], extent_w=cov['cluster_extent_w'], extent_h=cov['cluster_extent_h'])
        history.append(step)
        routed = [dict(v, route=T['violation_to_planner_step'].get(v['kind'], 'establish_relationships')) for v in au['violations']]
        if clash and it < max_iter - 1:
            s *= 0.96; continue
        if routed:
            kinds = {v['kind'] for v in routed}
            if kinds & {'through', 'deep-overlap', 'protected-occluded'}:
                opts['beside_gap_frac'] = opts.get('beside_gap_frac', 0.012) + 0.012
                opts['accent_side'] = 'left' if opts.get('accent_side', 'right') == 'right' else 'right'
                continue
            if kinds & {'surface-float'}:
                opts['surface_seat_frac'] = max(0.0, opts.get('surface_seat_frac', 0.05) - 0.02); continue
            break
        if cov['coverage_pct'] > band['coverage_pct'][1] and it < max_iter - 1:
            s *= 0.95; continue
        break
    ok = not au['violations'] and not clash
    return dict(ok=ok, family=family, arrangement=arrangement, field=dict(field), canvas=[W, H], scene_scale_px_per_in=round(s, 3), scale_limits=limits,
                primary_anchor=primary['id'], unresolved_anchor=unresolved_anchor, planes=planes,
                objects=[dict({k: v for k, v in layers[o['id']].items() if k not in ('asset',)}, asset=os.path.basename(o['source_asset']), trimmed_asset=layers[o['id']]['asset'],
                              semantic_class=o['semantic_class'], resolved_by=o['resolved_by'], dims_source=o['dims_source'],
                              edges=[e for e in edges if e['a'] == o['id']]) for o in objs if o['id'] in layers],
                edges=edges, intentional_negative_space=list(declared or []),
                audit=dict(physical=au['violations'], notes=au['notes'], coverage=cov), iterations=history)


def render_plan(img, plan_obj, merch=None, shadow=0.20):
    """Composite a plan's layers in z order (contact shadow for floor/accent objects; none for wall objects)."""
    W, H = img.size
    if merch is None: merch = np.zeros((H, W), bool)
    placed = []
    for l in sorted(plan_obj['objects'], key=lambda l: l['z']):
        im = Image.open(l['trimmed_asset']).convert('RGBA').resize((max(1, int(round(l['w']))), max(1, int(round(l['h'])))), Image.LANCZOS)
        x, y = int(round(l['x'])), int(round(l['y']))
        if l['plane'] == 'floor' and not l.get('support'):
            sw, sh = im.width, max(6, im.height // 14)
            sh_img = Image.new('RGBA', (sw, sh), (0, 0, 0, 0))
            ImageDraw.Draw(sh_img).ellipse([int(sw * 0.06), 0, int(sw * 0.94), sh], fill=(20, 24, 30, int(255 * shadow)))
            sh_img = sh_img.filter(ImageFilter.GaussianBlur(max(1, sh // 3)))
            img.alpha_composite(sh_img, (x, max(0, int(y + im.height - sh * 0.55))))
        img.alpha_composite(im, (x, y))
        a = np.asarray(im)[..., 3] > 64
        x0, y0 = max(0, x), max(0, y); x1, y1 = min(W, x + im.width), min(H, y + im.height)
        if x1 > x0 and y1 > y0: merch[y0:y1, x0:x1] |= a[y0 - y:y1 - y, x0 - x:x1 - x]
        placed.append(dict(id=l['id'], asset=l['asset'], semantic_class=l['semantic_class'], x=x, y=y, w=im.width, h=im.height, z=l['z'], plane=l['plane'], representative=True))
    return merch, placed


def plan_best(objects, field, canvas, family='ACQUISITION', arrangements=('anchor_right', 'anchor_left', 'split', 'split_reverse'), copy_regions=(), declared=(), options=None):
    """Mission 6 fit procedure as a search: base cluster (anchor + supports + surfaces + accents), then + a tall vertical
    for height, then + hung wall art in one or two rows, in each arrangement. Every candidate plan is physically audited;
    the best one that passes the audit and the coverage hard gate wins (in-band coverage first, then extents, then
    coverage closest to the band centre). The full trail is returned so the packet shows what was considered."""
    objs = _prepare(objects)
    r = _roles(objs)
    if not r: return dict(ok=False, error='no floor object to anchor the scene')
    primary, roles = r
    ids = lambda pred: [o['id'] for o in objs if pred(o)]
    tall = ids(lambda o: roles[o['id']] == 'TALL'); walls = ids(lambda o: roles[o['id']] == 'WALL')
    base = [o['id'] for o in objs if o['id'] not in tall and o['id'] not in walls]
    configs = [('base', base, 1)]
    if any(o.get('role_hint') == 'accent' for o in objs): configs.append(('base (accents on support)', base, 1))
    if tall: configs.append(('base+tall', base + tall, 1))
    if walls:
        configs.append(('base+walls', base + walls, 1)); configs.append(('base+walls(2 rows)', base + walls, 2))
        if tall: configs.append(('base+tall+walls', base + tall + walls, 1)); configs.append(('base+tall+walls(2 rows)', base + tall + walls, 2))
    # Fit step 7 (coverage-bands.json): when the band cannot be met, FEWER, LARGER objects — the anchor, its surface
    # provider and what sits on it, plus hung art — so the uniform scene scale can grow instead of the row shrinking to
    # fit every piece. Secondary floor pieces and tall verticals are left out (recorded in the trail, never resized).
    sec = ids(lambda o: roles[o['id']] == 'SECONDARY')
    fewer = [i for i in base if i not in sec]
    if sec or tall:
        configs.append(('fewer-larger', fewer, 1))
        if walls: configs.append(('fewer-larger+walls', fewer + walls, 1)); configs.append(('fewer-larger+walls(2 rows)', fewer + walls, 2))
    if walls and len(fewer) > 1:
        solo = [primary['id']] + [o['id'] for o in objs if roles[o['id']] == 'SURFACE' and o.get('role_hint') == 'accent']
        configs.append(('anchor+walls', solo + walls, 1)); configs.append(('anchor+walls(2 rows)', solo + walls, 2))
    band = config.coverage_bands()['families'].get(family) or config.coverage_bands()['families']['CENTERED_WHITE']
    lo, hi = band['coverage_pct']; mid = (lo + hi) / 2.0
    trail, best, best_key = [], None, None
    for name, sel, rows in configs:
        subset = [o for o in objects if o['id'] in sel]
        for arr in arrangements:
            extra = dict(gallery_rows_hint=rows)
            if 'accents on support' in name or 'walls' in name or 'tall' in name: extra['accent_mode'] = 'on_support'
            p = plan(subset, field, canvas, family=family, arrangement=arr, copy_regions=copy_regions, declared=declared,
                     options=dict(options or {}, **extra))
            if not p.get('objects'): continue
            c = p['audit']['coverage']; g = coverage.gate(family, c)
            entry = dict(config=name, arrangement=arr, physical_ok=p['ok'], coverage_pct=c['coverage_pct'], extent_w=c['cluster_extent_w'], extent_h=c['cluster_extent_h'],
                         void=c['largest_accidental_void_pct'], coverage_hard_pass=g['pass_'], scale=p['scene_scale_px_per_in'], violations=[v['kind'] for v in p['audit']['physical']])
            trail.append(entry)
            key = (p['ok'], g['pass_'], g['soft']['coverage_in_band'], g['soft']['extent_w_ok'] and g['soft']['extent_h_ok'], g['soft']['void_ok'], -abs(c['coverage_pct'] - mid))
            if best_key is None or key > best_key: best, best_key = p, key
    if best is None: return dict(ok=False, error='no plan could be produced', fit_trail=trail)
    best['fit_trail'] = trail
    best['fit_choice'] = next((t for t in trail if t['arrangement'] == best['arrangement'] and t['scale'] == best['scene_scale_px_per_in']), None)
    if not coverage.gate(family, best['audit']['coverage'])['pass_']:
        best['change_family_recommended'] = 'coverage cannot reach the %s floor with the available objects (fit step 7: fewer, larger objects or one object)' % family
    return best
