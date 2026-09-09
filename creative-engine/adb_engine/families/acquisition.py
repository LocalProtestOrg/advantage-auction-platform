"""ACQUISITION family (Phase 3P, Deliverable 11) — Advantage.Bid-led, non-collage, light ground.

Concepts: A 'Your things, your auction' (representative cluster + one message), B 'You can do this' (real production
screenshot + a few representative items), C 'Help is here' (help promise + real contact fact + small cluster).
Representative objects are Advantage.Bid-owned extracted assets (alpha webp) flagged 'representative_not_lots' and the
canvas carries a visible disclosure line. No people, no stock, no generated imagery. Text budget TEASER/GENERAL.
"""
import os
import numpy as np
from PIL import Image, ImageDraw
from . import brand as B


def _place_objects(img, merch, objects, floor_y, W, H, scale_w, top_limit=None, layout_w=None, max_x=None, min_x=None):
    """Grounded lineup: each object sits on the floor line (baseline = floor_y), sized by its 'w' (px at 1080),
    placed at its 'cx' (relative 0..1 of layout_w, default the canvas). Foreground objects (z high) may overlap
    midground ones. Soft contact shadow. No object may rise above top_limit (the copy block) or cross max_x (a copy
    panel) — merchandise never sits under the message. The merchandise mask always uses the full canvas."""
    draw = ImageDraw.Draw(img)
    placed = []
    LW = layout_w or W
    for o in sorted(objects, key=lambda o: o.get('z', 50)):
        im = Image.open(o['path']).convert('RGBA')
        w = int(round(o['w'] * scale_w)); h = int(round(w * im.height / im.width))
        if top_limit is not None and floor_y - h < top_limit:
            h = max(40, int(floor_y - top_limit)); w = max(40, int(round(h * im.width / im.height)))
        if max_x is not None:
            limit = int(2 * (max_x - o['cx'] * LW))
            if w > limit: w = max(40, limit); h = max(40, int(round(w * im.height / im.width)))
        if min_x is not None:
            limit = int(2 * (o['cx'] * LW - min_x))
            if w > limit: w = max(40, limit); h = max(40, int(round(w * im.height / im.width)))
        im = im.resize((w, h), Image.LANCZOS)
        x = int(round(o['cx'] * LW - w / 2)); y = int(floor_y - h)
        # contact shadow (ellipse) under the object
        sh = Image.new('RGBA', (w, max(6, h // 12)), (0, 0, 0, 0))
        ImageDraw.Draw(sh).ellipse([int(w * 0.08), 0, int(w * 0.92), sh.height], fill=(20, 24, 30, int(255 * o.get('shadow', 0.22))))
        img.alpha_composite(sh, (x, int(floor_y - sh.height // 2)))
        img.alpha_composite(im, (x, y))
        a = np.array(im)[..., 3] > 64
        x0, y0 = max(0, x), max(0, y); x1, y1 = min(W, x + w), min(H, y + h)
        if x1 > x0 and y1 > y0:
            merch[y0:y1, x0:x1] |= a[y0 - y:y1 - y, x0 - x:x1 - x]
        placed.append(dict(asset=os.path.basename(o['path']), x=x, y=y, w=w, h=h, role=o.get('role'), representative=True))
    return placed


def _screenshot_frame(img, merch, shot_path, x, y, w, corner=28):
    shot = Image.open(shot_path).convert('RGB')
    h = int(round(w * shot.height / shot.width))
    shot = shot.resize((w, h), Image.LANCZOS)
    frame = Image.new('RGBA', (w + 24, h + 24), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle([0, 0, w + 23, h + 23], radius=corner, fill=(255, 255, 255, 255), outline=(203, 210, 220, 255), width=2)
    # soft drop shadow
    shadow = Image.new('RGBA', (w + 64, h + 64), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([20, 28, w + 44, h + 52], radius=corner, fill=(20, 24, 30, 60))
    img.alpha_composite(shadow, (x - 32, y - 32))
    img.alpha_composite(frame, (x - 12, y - 12))
    img.paste(shot, (x, y))
    merch[y:y + h, x:x + w] = True
    return dict(x=x, y=y, w=w, h=h)


def render(spec):
    """spec: { format, concept: A|B|C, copy: {primary, support, help, contact, disclosure}, objects: [{path,w,cx,z,role}],
    screenshot_path|None, options: {title_scale}, out_png }"""
    W, H = B.FORMATS[spec.get('format', 'portrait_1080x1350')]
    fr = B.frame_for(W, H); s = H / 1350.0
    opt = spec.get('options') or {}; ts = float(opt.get('title_scale', 1.0))
    copy = spec['copy']; concept = spec.get('concept', 'A')
    img = Image.new('RGBA', (W, H), B.WHITE + (255,))
    draw = ImageDraw.Draw(img); boxes = []; merch = np.zeros((H, W), bool)
    band_h = fr['footer_band_px']; content_h = H - band_h

    # brand frame top: Advantage.Bid logo (Advantage-led campaign)
    B.draw_logo(img, (W - fr['logo_width_px']) // 2, int(46 * s), fr['logo_width_px'], boxes)
    draw = ImageDraw.Draw(img)
    y = int(150 * s)
    ft = B.fit_font('playfair-900', copy['primary'], int(W * 0.9), 118 * s * ts, 40)
    tb = B.draw_text(draw, copy['primary'], 0, y, ft, B.INK, align='center', box_w=W, role='title', boxes=boxes)
    y += tb['h'] + int(6 * s)
    draw.rectangle([(W - int(90 * s)) // 2, y, (W + int(90 * s)) // 2, y + int(6 * s)], fill=B.RED); y += int(22 * s)
    fs = B.font('jost-500', 38 * s)
    for line in _wrap(copy['support'], fs, int(W * 0.84)):
        sb = B.draw_text(draw, line, 0, y, fs, B.SLATE, align='center', box_w=W, role='subtitle', boxes=boxes); y += sb['h'] + int(2 * s)
    y += int(14 * s)
    placed = []; shot = None
    floor_y = content_h - int(150 * s)
    if concept == 'B' and spec.get('screenshot_path'):
        sw = int(W * 0.62); sx = W - sw - int(40 * s); sy = y + int(16 * s)
        shot = _screenshot_frame(img, merch, spec['screenshot_path'], sx, sy, sw)
        draw = ImageDraw.Draw(img)
        placed = _place_objects(img, merch, spec.get('objects') or [], floor_y, W, H, W / 1080.0, top_limit=y)
    elif concept == 'C':
        # Help-forward: a very_light help panel on the LEFT carries the contact fact; the cluster sits on the right
        # (mirror of the product-forward concept so the two never share a silhouette).
        px0 = int(40 * s); py0 = y + int(10 * s); pw = int(W * 0.46); ph = floor_y - py0 - int(10 * s)
        draw.rounded_rectangle([px0, py0, px0 + pw, py0 + ph], radius=int(22 * s), fill=B.VERY_LIGHT, outline=(226, 230, 236), width=2)
        pad = int(36 * s); cx = px0 + pad; cw = pw - 2 * pad; cy = py0 + pad
        fh = B.fit_font('quicksand-700', copy['contact'].split(' · ')[0], cw, 60 * s, 22)
        for line in copy['contact'].split(' · '):
            hb = B.draw_text(draw, line, cx, cy, fh, B.NAVY, role='contact', boxes=boxes); cy += hb['h'] + int(6 * s)
            fh = B.fit_font('quicksand-700', line, cw, 34 * s, 18)
        cy += int(14 * s); draw.rectangle([cx, cy, cx + int(70 * s), cy + int(5 * s)], fill=B.RED); cy += int(24 * s)
        fl = B.font('jost-500', 28 * s)
        for line in _wrap(copy['help'], fl, cw):
            lb = B.draw_text(draw, line, cx, cy, fl, B.SLATE, role='help', boxes=boxes); cy += lb['h'] + int(2 * s)
        mirrored = [dict(o, cx=0.5 + float(o['cx']) * 0.5) for o in (spec.get('objects') or [])]
        placed = _place_objects(img, merch, mirrored, floor_y, W, H, W / 1080.0 * 0.9, top_limit=y, min_x=px0 + pw + int(16 * s))
    else:
        placed = _place_objects(img, merch, spec.get('objects') or [], floor_y, W, H, W / 1080.0, top_limit=y)
    draw = ImageDraw.Draw(img)
    # help line (A/B carry one help line under the cluster; C's help lives in the panel)
    hy = content_h - int(118 * s)
    if concept != 'C':
        fl = B.fit_font('jost-500', copy['help'], int(W * 0.9), 30 * s, 18)
        B.draw_text(draw, copy['help'], 0, hy, fl, B.SLATE, align='center', box_w=W, role='help', boxes=boxes)
    # representative disclosure (factual flag; not counted in the copy budget)
    fd = B.font('jost-400', 20 * s)
    B.draw_text(draw, copy['disclosure'], 0, content_h - int(44 * s), fd, B.MUTE, align='center', box_w=W, role='disclosure', boxes=boxes, countable=False)
    B.draw_band(img, draw, W, H, fr, boxes)
    if opt.get('extreme_label'):
        lf = B.font('quicksand-700', 22 * s)
        lw, lh = B.text_size(lf, 'CALIBRATION EXTREME — NOT FOR PUBLICATION', tracking=2)
        draw.rectangle([0, 0, W, lh + int(14 * s)], fill=B.RED)
        B.draw_text(draw, 'CALIBRATION EXTREME — NOT FOR PUBLICATION', 0, int(7 * s), lf, B.WHITE, align='center', box_w=W, tracking=2, role='extreme_label', boxes=boxes, countable=False)
    thumb = B.save_png(img, spec['out_png'])
    m = B.layout_metrics(W, H, band_h, merch, boxes, B.WHITE)
    hits = []
    for b in boxes:
        if b.get('role') in ('logo', 'wordmark', 'disclosure', 'extreme_label'): continue
        x0, y0, x1, y1 = max(0, b['x']), max(0, b['y']), min(W, b['x'] + b['w']), min(H, b['y'] + b['h'])
        if x1 > x0 and y1 > y0 and merch[y0:y1, x0:x1].any(): hits.append(b['text'][:40])
    m.update(dict(family='ACQUISITION', concept=concept, representative=True, objects=len(placed), screenshot=bool(shot), copy_over_merchandise=hits,
                  title_scale=ts, extreme=bool(opt.get('extreme_label'))))
    return dict(ok=True, png=spec['out_png'], thumb=thumb, boxes=boxes, placed=placed, screenshot=shot, metrics=m,
                drawn_text=[b['text'] for b in boxes if b.get('text')])


def _wrap(text, fnt, max_w):
    words = text.split(' '); lines = []; cur = ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if B.text_size(fnt, t)[0] <= max_w or not cur: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines
