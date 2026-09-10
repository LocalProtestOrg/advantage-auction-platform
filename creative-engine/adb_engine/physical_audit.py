"""Phase 3P.1 Missions 4/5 — physical audit (production port of docs/marketing/phase3p1/reference/physical_audit.py).

Adds to the 3M.3 spatial audit what it does not check: same-plane THROUGH collisions, deep overlaps, real-world
relative scale, support edges, protected-feature intersections, wall/ground rules and room-scale category objects —
driven by the semantic taxonomy and the relationship rules. Thresholds come from creative-engine/config/
physical-audit.json. Masks are alpha > 64 at placed size, exactly as the reference implementation and compose.py.

audit(scene) -> {violations: [{id, kind, message}], notes: [...], scale_px_per_in, primary}
scene = {size: [W, H], layers: [{id, asset | mask, semantic_class, x, y, w, [h], z, plane?, support?, dims_in?, floor_accent?,
                                   protected: [[label, fx0, fy0, fx1, fy1], ...]}]}
Overlap is not the enemy; impossible intersection is. The audit never shrinks or nudges anything — it reports, and the
scene planner returns the violation to the step that caused it.
"""
import os
import numpy as np
from PIL import Image
from . import config

ENGINE_ROOT = config.ENGINE
CATEGORY_ONLY = {'jewelry', 'watch', 'coin'}   # category compositions only — never at room scale beside furniture


def _abs(path):
    return path if os.path.isabs(path) else os.path.join(os.environ.get('ADB_RUNTIME_ROOT', ENGINE_ROOT), path)


def mask_of(layer, W, H):
    """Alpha mask of a placed layer on the canvas."""
    im = Image.open(_abs(layer['asset'])).convert('RGBA')
    w = int(round(layer['w'])); h = int(round(layer.get('h') or im.height * w / im.width))
    a = np.asarray(im.resize((max(1, w), max(1, h)), Image.LANCZOS))[:, :, 3] > 64
    m = np.zeros((H, W), bool)
    x0, y0 = int(round(layer['x'])), int(round(layer['y']))
    xs0, ys0 = max(0, x0), max(0, y0); xs1, ys1 = min(W, x0 + w), min(H, y0 + h)
    if xs1 > xs0 and ys1 > ys0:
        m[ys0:ys1, xs0:xs1] = a[ys0 - y0:ys1 - y0, xs0 - x0:xs1 - x0]
    return m, h


def extent(m):
    ys = np.where(m.any(axis=1))[0]; xs = np.where(m.any(axis=0))[0]
    if not len(ys): return None
    return dict(top=int(ys.min()), base=int(ys.max()), left=int(xs.min()), right=int(xs.max()))


def audit(scene, masks=None):
    T = config.thresholds(); TAX = config.taxonomy()
    W, H = scene['size']; L = scene['layers']
    viol, notes = [], []
    if not L: return dict(violations=[], notes=['empty scene'], scale_px_per_in=None, primary=None)
    M, ext, ph = {}, {}, {}
    for l in L:
        if masks and l['id'] in masks:
            m = masks[l['id']]; h = int(round(l.get('h') or 0)) or (extent(m)['base'] - extent(m)['top'] + 1 if extent(m) else 1)
        else:
            m, h = mask_of(l, W, H)
        M[l['id']] = m; ext[l['id']] = extent(m); ph[l['id']] = h
    L = [l for l in L if ext[l['id']] is not None]
    cls = {l['id']: TAX.get(l['semantic_class']) for l in L}
    plane = {l['id']: l.get('plane') or (cls[l['id']] or {}).get('plane', 'floor') for l in L}
    byid = {l['id']: l for l in L}
    V = lambda i, k, msg: viol.append(dict(id=i, kind=k, message=msg))

    # ---- scale model: scene scale from the primary anchor --------------------------------------------------------------
    def typ_h(l):
        d = l.get('dims_in')
        return (d.get('h') if d else None) or (cls[l['id']] or {}).get('typical_height_in') or 24
    anchors = sorted(L, key=lambda l: -((cls[l['id']] or {}).get('anchor_weight', 0)))
    primary = anchors[0]; pe = ext[primary['id']]
    scale = (pe['base'] - pe['top']) / float(typ_h(primary))
    notes.append('scene scale %.2f px/in from %s (%s)' % (scale, primary['id'], primary['semantic_class']))
    room_scale = any(plane[l['id']] == 'floor' and (cls[l['id']] or {}).get('family') in ('furniture', 'lighting') for l in L)
    for l in L:
        c = cls[l['id']] or {}
        if l['semantic_class'] in CATEGORY_ONLY and room_scale:
            V(l['id'], 'room-scale-category', '%s placed at room scale beside furniture (category compositions only)' % l['semantic_class'])
        if l is primary: continue
        e = ext[l['id']]; px_h = e['base'] - e['top']
        expected = typ_h(l) * scale
        depth = 1.0
        if plane[l['id']] == 'floor' and e['base'] > pe['base']:
            depth = 1.0 + 0.25 * min(1, (e['base'] - pe['base']) / (0.2 * H))
        ratio = px_h / (expected * depth)
        tol = T['scale_tolerance_foreground'] if c.get('foreground_suitability', 0) >= 2 else T['scale_tolerance']
        if l.get('dims_in'): tol = T['scale_tolerance']
        if abs(ratio - 1) > tol:
            V(l['id'], 'scale', '%s rendered %.2fx its expected height vs %s (tol +/-%d%%)' % (l['semantic_class'], ratio, primary['semantic_class'], round(tol * 100)))

    # ---- support edges -------------------------------------------------------------------------------------------------
    for l in L:
        c = cls[l['id']]
        if c and c['plane'] in ('table', 'shelf', 'pedestal'):
            s = l.get('support')
            if not s and l.get('floor_accent') and c.get('foreground_suitability', 0) >= 3 and c['size_class'] in ('XS', 'S'):
                notes.append('%s declared floor-vignette accent (allowed for small foreground decor)' % l['id']); continue
            if not s and (l.get('dims_in') or {}).get('h', 0) >= T['floor_standing_min_in'] and l.get('floor_standing'):
                notes.append('%s declared floor-standing instance with catalogue height >= %d in' % (l['id'], T['floor_standing_min_in'])); continue
            if not s or s not in byid:
                V(l['id'], 'unsupported', '%s needs a support surface' % l['semantic_class']); continue
            se = ext[s]; e = ext[l['id']]
            band_lo, band_hi = se['top'] - 10, se['top'] + 0.35 * (se['base'] - se['top'])
            if not (band_lo <= e['base'] <= band_hi): V(l['id'], 'surface-float', 'not resting on %s' % s)
            from .taxonomy import canonical   # taxonomy entries may name an alias ('small_sculpture' → 'sculpture_small')
            allowed = [canonical(a) for a in (cls[s] or {}).get('can_support', [])]
            if allowed and l['semantic_class'] not in allowed and c['size_class'] not in allowed:
                V(l['id'], 'support-class', '%s cannot support %s' % (byid[s]['semantic_class'], l['semantic_class']))

    # ---- wall rules (3M.3 kept + HANGS_ABOVE tolerance) ------------------------------------------------------------------
    floor_top = min((ext[l['id']]['base'] for l in L if plane[l['id']] == 'floor'), default=None)
    for l in L:
        if plane[l['id']] != 'wall': continue
        e = ext[l['id']]
        if l.get('contact_shadow'): V(l['id'], 'wall-shadow', '%s carries a contact shadow (wall objects hang)' % l['semantic_class'])
        # A wall object's baseline in the floor band reads as "floating on the floor" (invalid: painting on the floor).
        if floor_top is not None and e['base'] >= pe['base'] - T['depth_step_frac'] * H * 0.5 and not l.get('leaning'):
            V(l['id'], 'wall-too-low', '%s baseline sits in the floor band (a wall object hangs above floor objects)' % l['semantic_class'])

    # ---- same-plane collisions -----------------------------------------------------------------------------------------
    ids = [l['id'] for l in L]; z = {l['id']: l['z'] for l in L}
    depth_step = T['depth_step_frac'] * H
    lo_i, hi_i = T['interior_band']; lower = T['lower_edge_band']
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            inter = M[a] & M[b]
            if inter.sum() <= T['min_overlap_px']: continue
            front, back = (a, b) if z[a] > z[b] else (b, a)
            fe, be = ext[front], ext[back]
            if plane[front] == 'wall' and plane[back] != 'wall':
                V(front, 'wall-in-front', '%s drawn in front of %s' % (byid[front]['semantic_class'], byid[back]['semantic_class'])); continue
            if byid[front]['semantic_class'] == 'rug':
                V(front, 'ground-over-object', 'rug drawn over an object'); continue
            if byid[front].get('support') == back or byid[back].get('support') == front: continue
            if plane[back] == 'wall' and plane[front] != 'wall':
                notes.append('%s in front of wall object %s (allowed: wall objects are always behind)' % (front, back)); continue
            same_plane = plane[front] == plane[back] == 'floor'
            ys = np.where(inter.any(axis=1))[0]
            back_h = max(1, be['base'] - be['top'])
            top_f = (ys.min() - be['top']) / back_h; bot_f = (ys.max() - be['top']) / back_h
            closer = fe['base'] - be['base']
            for (label, fx0, fy0, fx1, fy1) in byid[back].get('protected', []):
                bl = byid[back]
                x0 = int(bl['x'] + fx0 * bl['w']); x1 = int(bl['x'] + fx1 * bl['w'])
                y0 = int(bl['y'] + fy0 * ph[back]); y1 = int(bl['y'] + fy1 * ph[back])
                reg = M[front][max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
                if reg.size and reg.mean() > T['protected_occlusion']:
                    V(front, 'protected-occluded', '%s covers %s %s' % (byid[front]['semantic_class'], bl['semantic_class'], label))
            if same_plane:
                if closer < depth_step and top_f < hi_i and bot_f > lo_i:
                    V(front, 'through', '%s passes THROUGH %s (same depth, interior crossing %d%%-%d%%)' % (byid[front]['semantic_class'], byid[back]['semantic_class'], round(top_f * 100), round(bot_f * 100)))
                elif closer >= depth_step and top_f < (1 - lower):
                    if (cls[front] or {}).get('foreground_suitability', 0) >= 2:
                        notes.append('%s foreground accent over %s (allowed)' % (front, back))
                    else:
                        V(front, 'deep-overlap', '%s overlaps %s above its lower-edge band (%d%%) and is not a foreground accent' % (byid[front]['semantic_class'], byid[back]['semantic_class'], round(top_f * 100)))
                else:
                    notes.append('%s layered over lower edge of %s (allowed)' % (front, back))
    return dict(violations=viol, notes=notes, scale_px_per_in=round(scale, 3), primary=primary['id'])
