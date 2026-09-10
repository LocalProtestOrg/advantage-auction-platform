"""Phase 3P.2 — official Advantage.Bid logo asset system (config: docs/marketing/phase3p2/config/logo-asset-system.json).

The generator NEVER redraws, typesets or approximates the logo. Sequence: layout reserves a logo box → the box is kept
clear (ground colour) → select an approved registered variant from the luminance/busyness under the box → composite the
actual asset with uniform scale and position only → QA:
  logo_source             normalised cross-correlation of the box vs the registered asset rendered on the same ground ≥ 0.97,
                          OCR of the box reads ADVANTAGE.BID (+ GET THE ADVANTAGE for full lockups), no extra text in the box
  rendered_logo_elsewhere OCR over the whole canvas: any ADVANTAGE.BID string outside the box and outside the locked band
                          wordmark fails; multi-scale template search for the lockup outside the box fails at ≥ 0.85
The footer band wordmark is a locked brand-frame text element, not a logo (config absolute_rule).
"""
import hashlib, os
import numpy as np
from PIL import Image
from . import config, ocr

_REG = None


def registry(verify=True):
    """Load the registry; verify every registered file's SHA-256. Unregistered files are never authoritative."""
    global _REG
    if _REG is None:
        sysc = config.logo_system()
        root = os.path.join(config.REPO, sysc['asset_registry']['root'])
        out, problems = {}, []
        for v in sysc['asset_registry']['variants']:
            p = os.path.join(root, v['file'])
            if not os.path.exists(p): problems.append('missing ' + v['file']); continue
            sha = hashlib.sha256(open(p, 'rb').read()).hexdigest()
            if verify and sha != v['sha256']: problems.append('hash mismatch ' + v['file']); continue
            out[v['key']] = dict(v, path=p, verified=sha == v['sha256'])
        registered = {v['file'] for v in sysc['asset_registry']['variants']}
        unregistered = sorted(f for f in os.listdir(root) if f.lower().endswith('.png') and f not in registered)
        _REG = dict(variants=out, problems=problems, unregistered_files=unregistered)
    return _REG


def _lum(arr):
    a = arr.astype(np.float32) / 255.0
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def zone_stats(img, box):
    x, y, w, h = [int(round(v)) for v in box]
    reg = np.asarray(img.convert('RGB').crop((x, y, x + w, y + h)))
    L = _lum(reg)
    gy, gx = np.gradient(L)
    return dict(luminance=round(float(L.mean()), 3), busyness=round(float(np.hypot(gx, gy).mean()), 4), pure_white=bool((reg.min(axis=2) >= 250).mean() > 0.98))


def select_variant(img, box, context='advantage_bid_led', available_width_pct=None):
    """config variant_selection rules. Returns (key, reason). ab_icon is never the answer for an advertisement."""
    st = zone_stats(img, box)
    if available_width_pct is not None and available_width_pct < 22:
        return None, 'available width < 22%% of canvas — re-layout (ab_icon is not an ad substitute)'
    if st['luminance'] < 0.45 or st['busyness'] > 0.06:
        return 'white_horizontal', 'zone luminance %.2f / busyness %.3f → white lockup on a quiet dark area' % (st['luminance'], st['busyness'])
    # The primary lockup's own white rectangle is not pure white and reads as a visible box on white or light grounds
    # (config: it must never sit visibly over a coloured ground), so light zones take the transparent lockup.
    return 'primary_transparent', 'light/neutral zone (luminance %.2f) → transparent lockup' % st['luminance']


def composite(img, box, key):
    """Uniform scale to the box width, centred vertically in the box. Returns the placement record."""
    reg = registry()['variants'][key]
    asset = Image.open(reg['path']).convert('RGBA')
    x, y, w, h = [int(round(v)) for v in box]
    scale = w / float(asset.width)
    nh = int(round(asset.height * scale))
    if nh > h:   # the box is too short for this width: scale to height instead (still uniform)
        scale = h / float(asset.height); nh = h
    nw = int(round(asset.width * scale))
    lg = asset.resize((nw, nh), Image.LANCZOS)
    px, py = x + (w - nw) // 2, y + (h - nh) // 2
    img.alpha_composite(lg, (px, py))
    return dict(variant=key, file=reg['file'], sha256=reg['sha256'], box=[px, py, nw, nh], scale=round(scale, 5),
                transform='uniform_scale+position', reserved_box=[x, y, w, h])


def _ncc(a, b):
    a = a.astype(np.float64).ravel(); b = b.astype(np.float64).ravel()
    a -= a.mean(); b -= b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d else 0.0


def template_match(img, placement, ground_rgb=None):
    """Compare the composited box with the registered asset rendered over the SAME ground pixels (exact reconstruction)."""
    reg = registry()['variants'][placement['variant']]
    px, py, nw, nh = placement['box']
    asset = Image.open(reg['path']).convert('RGBA').resize((nw, nh), Image.LANCZOS)
    under = img.convert('RGB').crop((px, py, px + nw, py + nh))
    return round(_ncc(np.asarray(under.convert('L')), np.asarray(_expected(img, placement, asset).convert('L'))), 4)


def _expected(img, placement, asset):
    px, py, nw, nh = placement['box']
    ground = placement.get('_ground')
    base = ground.copy() if ground is not None else Image.new('RGBA', (nw, nh), (255, 255, 255, 255))
    base.alpha_composite(asset)
    return base.convert('RGB')


def place(img, box, key=None, context='advantage_bid_led'):
    """Full logo stage: keep the reserved box clear → select → composite → record ground for the QA reconstruction."""
    x, y, w, h = [int(round(v)) for v in box]
    ground = img.crop((x, y, x + w, y + h)).convert('RGBA')
    if key is None:
        key, reason = select_variant(img, box, context)
        if key is None: return dict(ok=False, error=reason)
    else:
        reason = 'variant requested by layout'
    rec = composite(img, box, key)
    gx, gy = rec['box'][0] - x, rec['box'][1] - y
    rec['_ground'] = ground.crop((gx, gy, gx + rec['box'][2], gy + rec['box'][3]))
    rec['selection_reason'] = reason; rec['ok'] = True
    return rec


def qa(img_path_or_img, placement, band_box=None, extra_allowed_boxes=()):
    """logo_source + rendered_logo_elsewhere. img: the FINAL render."""
    img = Image.open(img_path_or_img).convert('RGBA') if isinstance(img_path_or_img, str) else img_path_or_img
    out = dict(logo_source=dict(pass_=False), rendered_logo_elsewhere=dict(pass_=False))
    if not placement or not placement.get('ok', True) or 'box' not in placement:
        out['logo_source'] = dict(pass_=False, reason='no composited logo'); return out
    tm = template_match(img, placement)
    px, py, nw, nh = placement['box']
    full = placement['variant'] in ('primary_horizontal', 'primary_transparent', 'white_horizontal')
    r = ocr.read(img, region=(px - 4, py - 4, nw + 8, nh + 8), upscale=max(1.0, 600.0 / max(1, nw)))
    texts = [i['text'] for i in r['items']]
    joined = ocr.squash(' '.join(texts))
    reads_brand = ocr.is_brand_string(joined)
    reads_tagline = ('GETTHEADVANTAGE' in joined) or ('GETTHE' in joined and 'ADVANTAGE' in joined.replace('ADVANTAGEBID', '', 1))
    allowed = {'ADVANTAGEBID', 'GETTHE', 'ADVANTAGE', 'GETTHEADVANTAGE', 'ADVANTAGE8ID', 'ADVANTAGEB1D', 'GET', 'THE'}
    extra = [t for t in texts if ocr.squash(t) and not any(ocr.squash(t) in a or a in ocr.squash(t) for a in allowed)]
    ls_pass = tm >= 0.97 and (not r['available'] or (reads_brand and (reads_tagline or not full or nw < 260))) and not extra
    out['logo_source'] = dict(pass_=bool(ls_pass), template_match=tm, threshold=0.97, variant=placement['variant'], asset_sha256=placement['sha256'],
                              ocr_available=r['available'], ocr_text=texts, reads_advantage_bid=reads_brand, reads_tagline=reads_tagline, extra_text=extra)
    # rendered_logo_elsewhere: whole-canvas OCR, excluding the logo box and the locked band wordmark box.
    whole = ocr.read(img, upscale=1.0)
    excl = [placement['box']] + ([band_box] if band_box else []) + list(extra_allowed_boxes or [])
    def inside(b, e):
        ex, ey, ew, eh = e
        cx, cy = (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0
        return ex - 6 <= cx <= ex + ew + 6 and ey - 6 <= cy <= ey + eh + 6
    def standalone(t):
        q = ocr.squash(t); return ocr.is_brand_string(t) and len(q) <= len('ADVANTAGEBID') + 6
    hits = [i for i in whole['items'] if standalone(i['text']) and not any(inside(i['box'], e) for e in excl)]
    tmpl = search_lockup(img, exclude=excl)
    out['rendered_logo_elsewhere'] = dict(pass_=bool(whole['available'] and not hits and not tmpl['hits']), ocr_available=whole['available'],
                                          ocr_hits=hits, template_hits=tmpl['hits'], template_threshold=tmpl['threshold'])
    return out


def search_lockup(img, exclude=(), threshold=0.85, scales=(0.10, 0.14, 0.19, 0.25)):
    """Coarse multi-scale NCC search for the full lockup (gavel + wordmark) outside the excluded boxes (1/4 resolution)."""
    reg = registry()['variants'].get('primary_transparent')
    if not reg: return dict(hits=[], threshold=threshold, note='no transparent lockup registered')
    g = img.convert('L'); k = 4
    small = np.asarray(g.resize((max(1, g.width // k), max(1, g.height // k)), Image.BILINEAR)).astype(np.float64)
    mask = np.ones_like(small, bool)
    for (ex, ey, ew, eh) in exclude:
        mask[max(0, int(ey // k) - 2):int((ey + eh) // k) + 2, max(0, int(ex // k) - 2):int((ex + ew) // k) + 2] = False
    asset = Image.open(reg['path']).convert('RGBA')
    white = Image.new('RGBA', asset.size, (255, 255, 255, 255)); white.alpha_composite(asset)
    hits = []
    for sc in scales:
        tw = max(8, int(img.width * sc / k)); th = max(4, int(tw * asset.height / asset.width))
        t = np.asarray(white.convert('L').resize((tw, th), Image.BILINEAR)).astype(np.float64)
        t -= t.mean(); tn = np.sqrt((t * t).sum())
        if tn == 0 or small.shape[0] < th or small.shape[1] < tw: continue
        step = max(2, tw // 8)
        for yy in range(0, small.shape[0] - th, step):
            for xx in range(0, small.shape[1] - tw, step):
                if not mask[yy:yy + th, xx:xx + tw].all(): continue
                w = small[yy:yy + th, xx:xx + tw]; wm = w - w.mean(); wn = np.sqrt((wm * wm).sum())
                if wn == 0: continue
                v = float((wm * t).sum() / (wn * tn))
                if v >= threshold: hits.append(dict(x=xx * k, y=yy * k, w=tw * k, h=th * k, ncc=round(v, 3), scale=sc))
    return dict(hits=hits[:10], threshold=threshold)
