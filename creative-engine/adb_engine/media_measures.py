"""Phase 3P.1 Mission 2 — measured inputs for the Authentic Media-First Director (config: media-source-hierarchy.json).

measure_set(paths, options) → per photograph: dimensions, sharpness (Laplacian variance at a 1200px long edge,
normalised to the 90th percentile of THIS set), luminance mean, clipped-highlight %, dark %, grey-world colour cast,
OCR text regions with a contamination class (none | watermark | price_tags | signage), is_photograph (headline-class text
or a composed layout → NOT a photograph → the anchor role), crop fit (subject mass kept in 4:5 and 1:1 crops) and a
perceptual signature for distinctness. Clutter and invitation are judged by the vision judge from a named item list
(Node) — no object detector ships in this runtime; the packet records that stand-in explicitly.
Nothing here modifies an image.
"""
import numpy as np
from PIL import Image, ImageFilter
from . import ocr, signature


def _norm_img(path, long_edge=1200):
    im = Image.open(path).convert('RGB')
    k = long_edge / float(max(im.size))
    return im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS), im.size


def laplacian_var(gray):
    g = np.asarray(gray).astype(np.float64)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def _luma(arr):
    a = arr.astype(np.float32)
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def crop_fit(im, extra_aspects=()):
    """Share of the subject's edge mass kept inside the best-placed crop of each aspect (4:5, 1:1 + the layout's own)."""
    g = np.asarray(im.convert('L').filter(ImageFilter.FIND_EDGES)).astype(np.float64)
    H, W = g.shape
    total = g.sum() or 1.0
    out = {}
    for name, ar in [('4:5', 4 / 5.0), ('1:1', 1.0)] + [('%.2f:1' % a, float(a)) for a in extra_aspects]:
        if W / float(H) > ar:
            cw = int(H * ar); best = 0.0
            for x0 in range(0, W - cw + 1, max(1, (W - cw) // 12 or 1)):
                best = max(best, g[:, x0:x0 + cw].sum() / total)
        else:
            ch = int(W / ar); best = 0.0
            for y0 in range(0, H - ch + 1, max(1, (H - ch) // 12 or 1)):
                best = max(best, g[y0:y0 + ch, :].sum() / total)
        out[name] = round(best, 3)
    return out


def text_class(items, W, H):
    """Contamination class from OCR regions (config: none | watermark | price tags; signage/headline → not ready)."""
    if not items: return 'none', 0.0, []
    area = 0.0; headline = []; small_corner = 0; small_mid = 0
    for it in items:
        x0, y0, x1, y1 = it['box']; h = y1 - y0; w = x1 - x0
        area += w * h
        if h >= 0.03 * H or (w * h) >= 0.01 * W * H: headline.append(it['text'])
        elif (x0 < 0.12 * W or x1 > 0.88 * W) and (y0 < 0.12 * H or y1 > 0.88 * H): small_corner += 1
        else: small_mid += 1
    frac = area / float(W * H)
    if headline or frac >= 0.02: return 'signage', round(frac * 100, 2), headline
    if small_mid and not small_corner: return 'price_tags', round(frac * 100, 2), []
    return 'watermark', round(frac * 100, 2), []


def measure_one(path, run_ocr=True, required_aspects=()):
    im, (W0, H0) = _norm_img(path)
    arr = np.asarray(im)
    L = _luma(arr)
    means = arr.reshape(-1, 3).mean(axis=0)
    cast = float(np.abs(means - means.mean()).max() / (means.mean() or 1))
    rec = dict(path=path, width=W0, height=H0, long_edge=max(W0, H0), laplacian_var=round(laplacian_var(im.convert('L')), 1),
               luminance=round(float(L.mean()), 1), clipped_pct=round(100.0 * float((L > 245).mean()), 2), dark_pct=round(100.0 * float((L < 40).mean()), 2),
               colour_cast=round(cast, 3), crop_fit=crop_fit(im, required_aspects))
    if required_aspects:
        rec['crop_fit_required'] = min(rec['crop_fit']['%.2f:1' % a] for a in required_aspects)
    if run_ocr:
        r = ocr.read(im)
        cls, frac, heads = text_class(r['items'], im.width, im.height)
        rec.update(ocr_available=r['available'], text_items=[i['text'] for i in r['items']][:20], text_class=cls, text_area_pct=frac, headline_text=heads,
                   is_photograph=(cls != 'signage'))
    return rec


def measure_set(paths, options=None):
    opts = options or {}
    recs = [measure_one(p, run_ocr=opts.get('ocr', True), required_aspects=tuple(opts.get('required_aspects') or ())) for p in paths]
    if recs:
        p90 = float(np.percentile([r['laplacian_var'] for r in recs], 90)) or 1.0
        for r in recs: r['sharpness_norm'] = round(min(1.0, r['laplacian_var'] / p90), 3)
    if len(recs) >= 2 and opts.get('distinctness', True):
        sigs = {r['path']: signature.signature(r['path']) for r in recs}
        for r in recs:
            others = [signature.distance(sigs[r['path']], sigs[o['path']]) for o in recs if o is not r]
            r['nearest_other_distance'] = round(min(others), 4) if others else None
    return recs
