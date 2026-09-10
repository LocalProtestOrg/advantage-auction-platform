"""Phase 3P.1 — physical audit REFERENCE IMPLEMENTATION (not production code).

Adds to the 3M.3 spatial audit what it does not check: same-plane THROUGH collisions, real-world relative scale, support edges and
protected-feature intersections, driven by the semantic taxonomy (object-taxonomy.json) and relationship rules (relationship-rules.json).
Port as a module; keep the thresholds in config. Masks are alpha > 64 at placed size, as in compose.py.
"""
import json, os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(HERE, "..", "config")
TAX = {c["semantic_class"]: c for c in json.load(open(os.path.join(CFG, "object-taxonomy.json")))["classes"]}
RULES = json.load(open(os.path.join(CFG, "relationship-rules.json")))

DEPTH_STEP_FRAC = 0.06      # same-depth tolerance on baselines (fraction of canvas height)
INTERIOR_BAND = (0.20, 0.80)  # back object's interior band (fraction of its height) where a crossing is a THROUGH
LOWER_EDGE_BAND = 0.35      # bottom fraction of a back object's silhouette where foreground layering is allowed
SCALE_TOL = 0.20
SCALE_TOL_FG = 0.35
MIN_OVERLAP_PX = 400
PROTECTED_OCCLUSION = 0.15


def mask_of(layer, W, H):
    """Alpha mask of a placed layer on the canvas. layer: dict(asset, x, y, w, [h])."""
    path = layer["asset"]
    if not os.path.isabs(path): path = os.path.join(os.environ.get("ADB_RUNTIME_ROOT", "."), path)
    im = Image.open(path).convert("RGBA")
    w = int(round(layer["w"])); h = int(round(layer.get("h") or im.height * w / im.width))
    a = np.asarray(im.resize((w, h), Image.LANCZOS))[:, :, 3] > 64
    m = np.zeros((H, W), bool)
    x0, y0 = int(round(layer["x"])), int(round(layer["y"]))
    xs0, ys0 = max(0, x0), max(0, y0); xs1, ys1 = min(W, x0 + w), min(H, y0 + h)
    if xs1 > xs0 and ys1 > ys0:
        m[ys0:ys1, xs0:xs1] = a[ys0 - y0:ys1 - y0, xs0 - x0:xs1 - x0]
    return m, h


def extent(m):
    ys = np.where(m.any(axis=1))[0]; xs = np.where(m.any(axis=0))[0]
    if not len(ys): return None
    return dict(top=int(ys.min()), base=int(ys.max()), left=int(xs.min()), right=int(xs.max()))


def audit(scene):
    """scene = dict(size=(W,H), layers=[dict(id, asset, semantic_class, x, y, w, z, plane?, support?, dims_in?, protected=[(label,fx0,fy0,fx1,fy1)])])"""
    W, H = scene["size"]; L = scene["layers"]
    masks, ext, ph = {}, {}, {}
    for l in L:
        m, h = mask_of(l, W, H); masks[l["id"]] = m; ext[l["id"]] = extent(m); ph[l["id"]] = h
    viol, notes = [], []
    cls = {l["id"]: TAX.get(l["semantic_class"]) for l in L}
    plane = {l["id"]: l.get("plane") or (cls[l["id"]] or {}).get("plane", "floor") for l in L}

    # ---- scale model: scene scale from the primary anchor -------------------------------------------------------------
    def typ_h(l):
        d = l.get("dims_in")
        return (d.get("h") if d else None) or (cls[l["id"]] or {}).get("typical_height_in") or 24
    anchors = sorted(L, key=lambda l: -((cls[l["id"]] or {}).get("anchor_weight", 0)))
    primary = anchors[0]
    scale = (ext[primary["id"]]["base"] - ext[primary["id"]]["top"]) / typ_h(primary)   # px per inch
    notes.append(f"scene scale {scale:.2f} px/in from {primary['id']} ({primary['semantic_class']})")
    for l in L:
        if l is primary: continue
        e = ext[l["id"]]; px_h = e["base"] - e["top"]
        expected = typ_h(l) * scale
        depth = 1.0
        if plane[l["id"]] == "floor" and e["base"] > ext[primary["id"]]["base"]: depth = 1.0 + 0.25 * min(1, (e["base"] - ext[primary["id"]]["base"]) / (0.2 * H))
        ratio = px_h / (expected * depth)
        tol = SCALE_TOL_FG if (cls[l["id"]] or {}).get("foreground_suitability", 0) >= 2 else SCALE_TOL
        if l.get("dims_in"): tol = SCALE_TOL
        if abs(ratio - 1) > tol:
            viol.append((l["id"], "scale", f"{l['semantic_class']} rendered {ratio:.2f}× its expected height vs {primary['semantic_class']} (tol ±{tol:.0%})"))

    # ---- support edges --------------------------------------------------------------------------------------------------
    byid = {l["id"]: l for l in L}
    for l in L:
        c = cls[l["id"]]
        if c and c["plane"] in ("table", "shelf", "pedestal"):
            s = l.get("support")
            if not s and l.get("floor_accent") and c.get("foreground_suitability", 0) >= 3 and c["size_class"] in ("XS", "S"):
                notes.append(f"{l['id']} declared floor-vignette accent (allowed for small foreground decor; counts toward the foreground plane)"); continue
            if not s: viol.append((l["id"], "unsupported", f"{l['semantic_class']} needs a support surface")); continue
            sc = byid[s]; se = ext[s]; e = ext[l["id"]]
            band_lo, band_hi = se["top"] - 10, se["top"] + 0.35 * (se["base"] - se["top"])
            if not (band_lo <= e["base"] <= band_hi): viol.append((l["id"], "surface-float", f"not resting on {s}"))
            allowed = [a.split("(")[0] for a in (cls[s] or {}).get("can_support", [])]
            if allowed and l["semantic_class"] not in allowed and c["size_class"] not in allowed:
                viol.append((l["id"], "support-class", f"{sc['semantic_class']} cannot support {l['semantic_class']}"))

    # ---- same-plane collisions ------------------------------------------------------------------------------------------
    ids = [l["id"] for l in L]; z = {l["id"]: l["z"] for l in L}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            inter = masks[a] & masks[b]
            if inter.sum() <= MIN_OVERLAP_PX: continue
            front, back = (a, b) if z[a] > z[b] else (b, a)
            fe, be = ext[front], ext[back]
            # wall objects never in front of floor objects (3M.3 rule kept)
            if plane[front] == "wall" and plane[back] != "wall":
                viol.append((front, "wall-in-front", f"{byid[front]['semantic_class']} drawn in front of {byid[back]['semantic_class']}")); continue
            # rug: always behind
            if byid[front]["semantic_class"] == "rug":
                viol.append((front, "ground-over-object", "rug drawn over an object")); continue
            # ON relation handled by support check
            if byid[front].get("support") == back or byid[back].get("support") == front: continue
            same_plane = plane[front] == plane[back] == "floor"
            ys = np.where(inter.any(axis=1))[0]
            back_h = be["base"] - be["top"]
            inter_top_frac = (ys.min() - be["top"]) / back_h; inter_bot_frac = (ys.max() - be["top"]) / back_h
            depth_step = DEPTH_STEP_FRAC * H
            closer = fe["base"] - be["base"]
            # protected features of the back object
            for (label, fx0, fy0, fx1, fy1) in byid[back].get("protected", []):
                x0 = int(byid[back]["x"] + fx0 * byid[back]["w"]); x1 = int(byid[back]["x"] + fx1 * byid[back]["w"])
                y0 = int(byid[back]["y"] + fy0 * ph[back]); y1 = int(byid[back]["y"] + fy1 * ph[back])
                reg = masks[front][max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
                if reg.size and reg.mean() > PROTECTED_OCCLUSION:
                    viol.append((front, "protected-occluded", f"{byid[front]['semantic_class']} covers {byid[back]['semantic_class']} {label}"))
            if same_plane:
                if closer < depth_step and inter_top_frac < INTERIOR_BAND[1] and inter_bot_frac > INTERIOR_BAND[0]:
                    viol.append((front, "through", f"{byid[front]['semantic_class']} passes THROUGH {byid[back]['semantic_class']} (same depth, interior crossing {inter_top_frac:.0%}–{inter_bot_frac:.0%})"))
                elif closer >= depth_step and inter_top_frac < (1 - LOWER_EDGE_BAND):
                    fg = (cls[front] or {}).get("foreground_suitability", 0) >= 2
                    if not fg:
                        viol.append((front, "deep-overlap", f"{byid[front]['semantic_class']} overlaps {byid[back]['semantic_class']} above its lower-edge band ({inter_top_frac:.0%}) and is not a foreground accent"))
                    else:
                        notes.append(f"{front} foreground accent over {back} (allowed)")
                else:
                    notes.append(f"{front} layered over lower edge of {back} (allowed)")
    return viol, notes


if __name__ == "__main__":
    import sys
    scene = json.load(open(sys.argv[1]))
    v, n = audit(scene)
    print(json.dumps(dict(violations=v, notes=n), indent=1))
