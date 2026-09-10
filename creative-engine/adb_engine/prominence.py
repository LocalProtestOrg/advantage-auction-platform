"""Phase 3P.1 Missions 7/8 + Phase 3P.2 colour — measured prominence, event-type hierarchy and colour-system checks.

Prominence is recognisability at feed size, not raw pixels: every identity rule is evaluated on a 240px-wide feed proxy
(and the 281px thumbnail), then reported in canvas pixels. Config: prominence-rules.json (3P.1; logo band widened to
30–50% by logo-asset-system.json 3P.2) and color-system.json (3P.2).
"""
import numpy as np
from PIL import Image
from . import config, ocr, logo_stage

RED = np.array([214, 40, 40]); NAVY = np.array([24, 46, 69]); NAVY_LOGO = np.array([0, 16, 37])


def _luma(arr):
    a = arr.astype(np.float32) / 255.0
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def _rel(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])


def contrast(a, b):
    la, lb = _rel(a), _rel(b)
    return round((max(la, lb) + 0.05) / (min(la, lb) + 0.05), 2)


def _cap(b):
    return b.get('cap_h') or int(round(b.get('size', b.get('h', 0)) * 0.7))


def identity(img, boxes, logo, context, band_h, feed_w=240):
    """Brand identity prominence. context: advantage_bid_led | seller_led_cobranded."""
    R = config.prominence_rules()['brand_identity']; W, H = img.size
    band_lo = config.logo_system()['qa']['prominence']
    led_band = [30, 50]   # 3P.2 widening of the 3P.1 [30, 40] band (logo-asset-system.json qa.prominence)
    out = dict(context=context, checks={}, violations=[])
    V = lambda k, msg: out['violations'].append(dict(check=k, message=msg))
    wm = [b for b in boxes if b.get('role') == 'wordmark']
    if wm:
        cap = _cap(wm[0]); pct = 100.0 * cap / H
        lo, hi = R['advantage_bid_led']['footer_wordmark_cap_height_pct_of_canvas_height']
        out['checks']['band_wordmark_cap_pct'] = round(pct, 2)
        if pct < lo - 0.05: V('band_wordmark', 'band wordmark cap height %.2f%% < %.1f%%' % (pct, lo))
    else:
        V('band_wordmark', 'no band wordmark')
    proxy = img.convert('RGB').resize((feed_w, int(round(H * feed_w / W))), Image.LANCZOS)
    k = feed_w / float(W)
    if context == 'advantage_bid_led':
        if not logo or 'box' not in logo:
            V('logo_present', 'no composited Advantage.Bid lockup'); return out
        px, py, pw, ph = logo['box']
        width_pct = 100.0 * pw / W
        out['checks'].update(logo_width_pct=round(width_pct, 1), logo_height_feed_px=round(ph * k, 1), logo_top_pct=round(100.0 * py / H, 1))
        if width_pct < led_band[0] - 0.05: V('size_band', 'logo lockup %.1f%% of canvas width < %d%%' % (width_pct, led_band[0]))
        if width_pct > led_band[1] + 0.05: V('size_band', 'logo lockup %.1f%% of canvas width > %d%%' % (width_pct, led_band[1]))
        if ph * k < R['advantage_bid_led']['logo_lockup_min_height_at_feed_proxy_px']: V('feed_height', 'logo %.1fpx tall at the feed proxy < 14px' % (ph * k))
        if (py + ph / 2.0) > 0.22 * H and py > 0.22 * H: V('zone', 'logo not in the top 22% of the canvas')
        cap = ph * 0.22   # the ADVANTAGE.BID wordmark inside the lockup is ~22% of its height
        others = [b for b in boxes if b.get('role') not in ('logo', 'wordmark') and b.get('w')]
        gaps = []
        for b in others:
            dx = max(b['x'] - (px + pw), px - (b['x'] + b['w']), 0); dy = max(b['y'] - (py + ph), py - (b['y'] + b['h']), 0)
            gaps.append(max(dx, dy))
        clear = min(gaps) if gaps else 999
        out['checks']['clear_space_px'] = round(float(clear), 1); out['checks']['clear_space_required_px'] = round(cap, 1)
        if clear < cap: V('clear_space', 'clear space %.0fpx < one logo cap height (%.0fpx)' % (clear, cap))
        ground = np.asarray(img.convert('RGB').crop((max(0, px - 12), max(0, py - 12), min(W, px + pw + 12), max(0, py) + 4))).reshape(-1, 3)
        g = tuple(int(v) for v in np.median(ground, axis=0)) if len(ground) else (255, 255, 255)
        cr = contrast(tuple(NAVY_LOGO) if logo['variant'] != 'white_horizontal' else (255, 255, 255), g)
        out['checks']['contrast'] = cr
        if cr < R['advantage_bid_led']['contrast_min']: V('contrast', 'logo contrast %.2f < 4.5' % cr)
        # feed-proxy recognition: template of the registered asset at proxy scale over the proxy pixels
        reg = logo_stage.registry()['variants'][logo['variant']]
        tw, th = max(4, int(round(pw * k))), max(2, int(round(ph * k)))
        asset = Image.open(reg['path']).convert('RGBA').resize((tw, th), Image.LANCZOS)
        # Sub-pixel exact: downscale the full-resolution crop (what the proxy shows) and the expected ground+asset
        # to the same proxy size — an intact lockup scores ~1.0; a redrawn or altered one does not.
        under = img.convert('RGB').crop((px, py, px + pw, py + ph)).resize((tw, th), Image.LANCZOS)
        g0 = logo.get('_ground')
        full = (g0.copy() if g0 is not None else Image.new('RGBA', (pw, ph), (255, 255, 255, 255))).convert('RGBA')
        full.alpha_composite(Image.open(reg['path']).convert('RGBA').resize((pw, ph), Image.LANCZOS))
        base = full.resize((tw, th), Image.LANCZOS)
        a = np.asarray(under.convert('L')).astype(float); b = np.asarray(base.convert('L')).astype(float)
        a -= a.mean(); b -= b.mean(); d = np.sqrt((a * a).sum() * (b * b).sum())
        tm = float((a * b).sum() / d) if d else 0.0
        out['checks']['feed_proxy_template'] = round(tm, 3)
        if tm < 0.85: V('feed_recognition', 'logo template at the feed proxy %.2f < 0.85' % tm)
    else:
        seller = [b for b in boxes if b.get('role') == 'presenter']
        rel = [b for b in boxes if b.get('role') == 'relationship']
        if not seller: V('seller_identity', 'no seller identity element'); return out
        def weight(bs, fg=None):
            return sum(_cap(b) * b['w'] * contrast(tuple(b.get('fill') or (24, 46, 69)), (255, 255, 255)) for b in bs)
        sw = weight(seller)
        abw = weight(rel)
        if logo and 'box' in logo:
            lpx, lpy, lpw, lph = logo['box']
            abw += (lph * 0.30) * lpw * contrast(tuple(NAVY_LOGO), (255, 255, 255))
        ratio = abw / sw if sw else 0
        rel_cap = 100.0 * max((_cap(b) for b in rel), default=0) / H
        out['checks'].update(seller_weight=round(sw), advantage_bid_weight=round(abw), weight_ratio=round(ratio, 3), relationship_cap_pct=round(rel_cap, 2),
                             relationship_has_logo_mark=bool(logo and 'box' in logo))
        lo, hi = R['seller_led_cobranded']['advantage_bid_identity_weight_ratio']
        if ratio > hi: V('weight_ratio', 'Advantage.Bid weight %.2f× the seller\'s > %.1f (competes)' % (ratio, hi))
        if ratio < lo: V('weight_ratio', 'Advantage.Bid weight %.2f× the seller\'s < %.1f (disappears)' % (ratio, lo))
        clo, chi = R['seller_led_cobranded']['relationship_line_cap_height_pct_of_canvas_height']
        if rel and not (clo - 0.05 <= rel_cap <= chi + 0.05): V('relationship_cap', 'relationship line cap height %.2f%% outside %.1f–%.1f%%' % (rel_cap, clo, chi))
        if not (logo and 'box' in logo): V('relationship_logo_mark', 'relationship line has no Advantage.Bid logo mark')
    # band wordmark legibility at feed size: OCR the proxy band (upscaled for the OCR engine only)
    if wm:
        bb = wm[0]
        # The information is the 240px proxy itself; the OCR engine needs pixels, so the proxy crop is interpolated at a
        # few factors and the wordmark counts as legible when any reading recovers it (OCR is noisy near its size limit).
        ok = False; r = dict(available=ocr.available(), items=[])
        for up in (3.0, 4.0, 5.0, 6.0, 8.0):
            r = ocr.read(proxy, region=(bb['x'] * k - 6, bb['y'] * k - 8, bb['w'] * k + 12, bb['h'] * k + 16), upscale=up)
            if ocr.is_brand_string(' '.join(i['text'] for i in r['items'])): ok = True; break
        out['checks']['feed_proxy_wordmark_ocr'] = ok if r['available'] else 'ocr_unavailable'
        if r['available'] and not ok: V('feed_wordmark', 'band wordmark does not read at the feed proxy')
    out['pass_'] = not out['violations']
    return out


def event_type(boxes, H, required=True):
    """Mission 8: size floors, subtitle pattern, orphan wrap, date ≤ 85% of type, modifiers ≤ 45%."""
    S = config.prominence_rules()['event_type']['sizing']
    et = [b for b in boxes if b.get('role') == 'event_type']
    out = dict(checks={}, violations=[])
    V = lambda k, msg: out['violations'].append(dict(check=k, message=msg))
    if not et:
        if required: V('present', 'event_type role not drawn')
        out['pass_'] = not out['violations']; return out
    texts = [b for b in boxes if b.get('countable', True) and b.get('role') not in ('logo', 'wordmark', 'disclosure', 'extreme_label') and b.get('text')]
    largest = max(_cap(b) for b in texts)
    tcap = max(_cap(b) for b in et)
    out['checks'].update(event_type_cap_px=tcap, largest_text_cap_px=largest, ratio_to_largest=round(tcap / float(largest), 3), pct_of_canvas=round(100.0 * tcap / H, 2))
    if tcap < S['event_type_cap_height_min_pct_of_largest_text'] / 100.0 * largest - 0.5: V('size_vs_largest', 'event type cap %.0fpx < 80%% of the largest text (%.0fpx)' % (tcap, largest))
    if 100.0 * tcap / H < S['event_type_cap_height_min_pct_of_canvas_height'] - 0.01: V('size_vs_canvas', 'event type cap %.2f%% of canvas height < 4.8%%' % (100.0 * tcap / H))
    title = [b for b in boxes if b.get('role') == 'event_title']
    if title and tcap < 0.8 * max(_cap(b) for b in title): V('subtitle_pattern', 'event type set as a subtitle under a larger place-name title')
    date = [b for b in boxes if b.get('role') == 'date']
    if date and max(_cap(b) for b in date) > S['date_cap_height_max_pct_of_event_type'] / 100.0 * tcap + 0.5: V('date_vs_type', 'date larger than 85% of the event type')
    words_total = len(' '.join(b['text'] for b in et).split())
    if words_total >= 2 and any(len(b['text'].split()) == 1 for b in et) and len(et) > 1: V('orphan', 'event type wrapped leaving a single word on its own line')
    mods = [b for b in boxes if b.get('role') == 'modifier']
    if mods and max(_cap(b) for b in mods) > 0.45 * tcap + 0.5: V('modifier', 'modifier larger than 45% of the event type')
    out['pass_'] = not out['violations']
    return out


def colour(img, boxes, band_h, copy_regions, merch_mask=None, red_elements=None):
    """color-system.json measurable checks. red_elements: renderer manifest of red design elements above the band."""
    C = config.color_system(); W, H = img.size
    arr = np.asarray(img.convert('RGB'))
    Hc = H - int(band_h)
    L = _luma(arr[:Hc])
    zone = np.zeros((H, W), bool)
    for r in copy_regions or []:
        x, y, w, h = [int(round(v)) for v in (r['x'], r['y'], r['w'], r['h'])]
        zone[max(0, y):min(H, y + h), max(0, x):min(W, x + w)] = True
    zone = zone[:Hc]
    canvas_l = float(L.mean()); zone_l = float(L[zone].mean()) if zone.any() else None
    hsv = np.asarray(img.convert('RGB').convert('HSV')).astype(np.float32)
    h, s, v = hsv[..., 0] * 360 / 255.0, hsv[..., 1] / 255.0, hsv[..., 2] / 255.0
    sat = (s > 0.45) & (v > 0.25)
    red = sat & ((h < 15) | (h > 345))
    red_zone = red[:Hc] & zone; sat_zone = sat[:Hc] & zone
    red_share = float(red_zone.sum()) / max(1, int(sat_zone.sum())) * 100.0
    # red band / red ground (pixel based, merchandise excluded)
    nm = ~(merch_mask[:Hc] if merch_mask is not None else np.zeros((Hc, W), bool))
    rows_red = (red[:Hc] & nm).mean(axis=1)
    red_band = bool(max((len(list(g)) for k, g in __import__('itertools').groupby(rows_red > 0.7) if k), default=0) >= 0.015 * H)
    red_ground = float((red[:Hc] & nm).sum()) / max(1, int(nm.sum())) > 0.20
    n_red = len(red_elements or [])
    navy_present = any(b.get('role') in ('headline', 'event_type', 'event_title', 'title') and b.get('fill') and np.abs(np.array(b['fill']) - NAVY).sum() < 60 for b in boxes) or band_h > 0
    hard, soft = [], []
    if canvas_l < 0.60: hard.append('light foundation: canvas luminance %.2f < 0.60' % canvas_l)
    if zone_l is not None and zone_l < 0.72: hard.append('copy-zone luminance %.2f < 0.72' % zone_l)
    if red_band: hard.append('red band detected (never a red band)')
    if red_ground: hard.append('red ground detected')
    if n_red > 3: hard.append('%d red elements above the band (budget 3)' % n_red)
    if zone.any() and sat_zone.sum() > 0 and not (35 <= red_share <= 65): soft.append('red share of saturated copy-zone pixels %.0f%% outside 35–65%%' % red_share)
    if not navy_present: soft.append('navy absent from headline and band')
    return dict(pass_=not hard, hard_failures=hard, soft=soft, canvas_luminance=round(canvas_l, 3), copy_zone_luminance=round(zone_l, 3) if zone_l is not None else None,
                red_elements=n_red, red_share_saturated_copy_zone_pct=round(red_share, 1), red_band=red_band, red_ground=red_ground, navy_present=bool(navy_present))
