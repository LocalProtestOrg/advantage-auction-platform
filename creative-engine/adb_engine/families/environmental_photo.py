"""ENVIRONMENTAL_PHOTO family (Phase 3P) — real on-site estate-sale environments.

Two treatments: 'banded' (type band / photograph / date band — portrait) and 'panel' (information panel on one side,
photograph on the other). The photograph is an event-bound asset handed in by the caller with provenance; nothing is
generated. Copy sits only on the light ground, never over merchandise — except the small place plate (≤ 6% of the
canvas) anchored on the photograph's edge. The seller (presenter) leads; Advantage.Bid is the subordinate partner line
and the navy band close. A 'calibration extreme' pushes title scale / photograph share ~15% past the band and carries
a visible NOT FOR PUBLICATION label (excluded from the text budget, flagged in the layout).
"""
import numpy as np
from PIL import Image, ImageDraw
from . import brand as B

PLATE_MAX_AREA_PCT = 6.0


def _plate(img, draw, text, x, y, W, boxes, align_left=True, max_w=None):
    f = B.font('jost-600', 26)
    tw, th = B.text_size(f, text, tracking=2)
    if max_w:
        f = B.fit_font('jost-600', text, max_w - 44, 26, 16, tracking=2)
        tw, th = B.text_size(f, text, tracking=2)
    pad_x, pad_y = 22, 12
    w, h = tw + 2 * pad_x, th + 2 * pad_y
    if not align_left: x = x - w
    draw.rectangle([x, y, x + w, y + h], fill=B.NAVY)
    B.draw_text(draw, text, x + pad_x, y + pad_y, f, B.WHITE, tracking=2, role='place_plate', boxes=boxes)
    return dict(x=x, y=y, w=w, h=h)


def render(spec):
    """spec: { format, variant: banded|panel, photo_path, copy: {presenter, relationship, title, subtitle, date, time,
    place_plate}, options: {title_scale, photo_share, extreme_label, panel_side}, out_png }"""
    W, H = B.FORMATS[spec.get('format', 'portrait_1080x1350')]
    fr = B.frame_for(W, H)
    opt = spec.get('options') or {}
    ts = float(opt.get('title_scale', 1.0)); ps = float(opt.get('photo_share', 1.0))
    copy = spec['copy']
    img = Image.new('RGBA', (W, H), B.VERY_LIGHT + (255,))
    draw = ImageDraw.Draw(img)
    boxes = []
    merch = np.zeros((H, W), bool)
    band_h = fr['footer_band_px']
    content_h = H - band_h
    photo = Image.open(spec['photo_path']).convert('RGB')
    variant = spec.get('variant', 'banded')
    s = H / 1350.0

    if variant == 'banded':
        # ── top type block ──
        y = int(54 * s)
        fp = B.font('jost-600', 30 * s)
        B.draw_text(draw, copy['presenter'].upper(), 0, y, fp, B.NAVY, align='center', box_w=W, tracking=6, role='presenter', boxes=boxes)
        y += fp.getmetrics()[0] + fp.getmetrics()[1] + int(6 * s)
        fr_ = B.font('jost-400', 24 * s)
        B.draw_text(draw, copy['relationship'], 0, y, fr_, B.SLATE, align='center', box_w=W, role='relationship', boxes=boxes, countable=False)
        y += fr_.getmetrics()[0] + fr_.getmetrics()[1] + int(22 * s)
        ft = B.fit_font('playfair-900', copy['title'], int(W * 0.92), 150 * s * ts, 40)
        tb = B.draw_text(draw, copy['title'], 0, y, ft, B.INK, align='center', box_w=W, role='title', boxes=boxes)
        y += tb['h'] + int(4 * s)
        # red accent rule under the title (brand accent, not a seller ornament)
        draw.rectangle([(W - int(90 * s)) // 2, y, (W + int(90 * s)) // 2, y + int(6 * s)], fill=B.RED)
        y += int(18 * s)
        fs = B.font('jost-500', 40 * s * min(ts, 1.08))
        sb = B.draw_text(draw, copy['subtitle'], 0, y, fs, B.SLATE, align='center', box_w=W, role='title', boxes=boxes)
        y += sb['h'] + int(26 * s)
        top_h = y
        # ── photograph block ──
        date_block_h = int(150 * s)
        photo_h = int(min(content_h - top_h - date_block_h, (content_h * 0.55) * ps))
        photo_h = max(int(content_h * 0.40), photo_h)
        date_block_h = content_h - top_h - photo_h
        ph = B.cover_fit(photo, W, photo_h, focus=(0.5, 0.4))
        img.paste(ph, (0, top_h)); merch[top_h:top_h + photo_h, :] = True
        draw = ImageDraw.Draw(img)
        plate = _plate(img, draw, copy['place_plate'].upper(), int(48 * s), top_h + photo_h - int(30 * s), W, boxes)
        merch[plate['y']:plate['y'] + plate['h'], plate['x']:plate['x'] + plate['w']] = False
        # ── date block ──
        dy = top_h + photo_h + int(30 * s)
        avail = content_h - dy - int(16 * s)
        fd = B.fit_font('quicksand-700', copy['date'].upper(), int(W * 0.9), min(64 * s, avail * 0.48), 24)
        db = B.draw_text(draw, copy['date'].upper(), 0, dy, fd, B.NAVY, align='center', box_w=W, tracking=2, role='date', boxes=boxes)
        fti = B.fit_font('jost-500', copy['time'], int(W * 0.9), min(34 * s, db['h'] * 0.6), 18)
        B.draw_text(draw, copy['time'], 0, dy + db['h'] + int(8 * s), fti, B.SLATE, align='center', box_w=W, tracking=1, role='time', boxes=boxes)
    else:
        # ── panel treatment: information panel (46%) beside the photograph; logistics anchored to the panel foot ──
        side = opt.get('panel_side', 'left')
        panel_w = int(W * 0.46)
        px0 = 0 if side == 'left' else W - panel_w
        photo_x0 = panel_w if side == 'left' else 0
        photo_w = W - panel_w
        photo_h = content_h
        ph = B.cover_fit(photo, photo_w, photo_h, focus=(0.5, 0.45))
        img.paste(ph, (photo_x0, 0)); merch[0:photo_h, photo_x0:photo_x0 + photo_w] = True
        draw = ImageDraw.Draw(img)
        pad = int(52 * s); x = px0 + pad; cw = panel_w - 2 * pad
        y = int(64 * s)
        fp = B.font('jost-600', 26 * s)
        for line in _wrap(copy['presenter'].upper(), fp, cw, tracking=4):
            B.draw_text(draw, line, x, y, fp, B.NAVY, tracking=4, role='presenter', boxes=boxes); y += fp.getmetrics()[0] + fp.getmetrics()[1] + int(2 * s)
        y += int(4 * s)
        fr_ = B.font('jost-400', 22 * s)
        for line in _wrap(copy['relationship'], fr_, cw):
            B.draw_text(draw, line, x, y, fr_, B.SLATE, role='relationship', boxes=boxes, countable=False); y += fr_.getmetrics()[0] + fr_.getmetrics()[1]
        y += int(34 * s)
        title_lines = copy['title'].split(' ')
        ft = B.fit_font('playfair-900', max(title_lines, key=len), cw, 132 * s * ts, 36)
        for line in title_lines:
            B.draw_text(draw, line, x, y, ft, B.INK, role='title', boxes=boxes); y += int(ft.size * 1.02)
        y += int(14 * s)
        draw.rectangle([x, y, x + int(90 * s), y + int(6 * s)], fill=B.RED); y += int(28 * s)
        fs = B.font('jost-500', 36 * s * min(ts, 1.08))
        for line in _wrap(copy['subtitle'], fs, cw):
            B.draw_text(draw, line, x, y, fs, B.SLATE, role='title', boxes=boxes); y += fs.getmetrics()[0] + fs.getmetrics()[1]
        # logistics block anchored to the foot of the panel (date larger than time)
        day_word, _, day_rest = copy['date'].partition(', ')
        fd_small = B.font('jost-600', 26 * s); fd_big = B.fit_font('quicksand-700', day_rest.upper() or copy['date'].upper(), cw, 58 * s, 22)
        t_lines = [t.strip() for t in copy['time'].split('·')]
        fti = B.font('jost-500', 28 * s)
        block_h = (fd_small.getmetrics()[0] + fd_small.getmetrics()[1] + int(4 * s)) + int(fd_big.size * 1.05) + int(12 * s) + len(t_lines) * (fti.getmetrics()[0] + fti.getmetrics()[1] + int(2 * s))
        ly = content_h - int(56 * s) - block_h
        if ly < y + int(30 * s): ly = y + int(30 * s)
        B.draw_text(draw, day_word.upper(), x, ly, fd_small, B.NAVY, tracking=3, role='date', boxes=boxes); ly += fd_small.getmetrics()[0] + fd_small.getmetrics()[1] + int(4 * s)
        B.draw_text(draw, (day_rest or copy['date']).upper(), x, ly, fd_big, B.NAVY, tracking=1, role='date', boxes=boxes); ly += int(fd_big.size * 1.05) + int(12 * s)
        for t in t_lines:
            B.draw_text(draw, t, x, ly, fti, B.SLATE, role='time', boxes=boxes); ly += fti.getmetrics()[0] + fti.getmetrics()[1] + int(2 * s)
        plate = _plate(img, draw, copy['place_plate'].upper(), photo_x0 + int(40 * s), photo_h - int(72 * s), W, boxes, max_w=photo_w - int(80 * s))
        merch[plate['y']:plate['y'] + plate['h'], plate['x']:plate['x'] + plate['w']] = False

    # ── brand band + subordinate Advantage.Bid logo (kept inside the band's visual field: above the band, right) ──
    B.draw_band(img, draw, W, H, fr, boxes)
    if opt.get('extreme_label'):
        lf = B.font('quicksand-700', 22 * s)
        lw, lh = B.text_size(lf, 'CALIBRATION EXTREME — NOT FOR PUBLICATION', tracking=2)
        draw.rectangle([0, 0, W, lh + int(14 * s)], fill=B.RED)
        B.draw_text(draw, 'CALIBRATION EXTREME — NOT FOR PUBLICATION', 0, int(7 * s), lf, B.WHITE, align='center', box_w=W, tracking=2, role='extreme_label', boxes=boxes, countable=False)

    thumb = B.save_png(img, spec['out_png'])
    m = B.layout_metrics(W, H, band_h, merch, boxes, B.VERY_LIGHT)
    plate_pct = round(100.0 * plate['w'] * plate['h'] / (W * H), 2)
    m.update(dict(family='ENVIRONMENTAL_PHOTO', variant=variant, photo_pct=m['merchandise_pct'], place_plate_pct=plate_pct,
                  place_plate_ok=plate_pct <= PLATE_MAX_AREA_PCT,
                  copy_over_merchandise=_copy_over_merch(boxes, merch, plate),
                  panel_contrast=B.contrast_ratio(B.NAVY, B.VERY_LIGHT), plate_contrast=B.contrast_ratio(B.WHITE, B.NAVY),
                  title_scale=ts, photo_share=ps, extreme=bool(opt.get('extreme_label'))))
    return dict(ok=True, png=spec['out_png'], thumb=thumb, boxes=boxes, metrics=m,
                drawn_text=[b['text'] for b in boxes if b.get('text')])


def _copy_over_merch(boxes, merch, plate):
    """Any countable copy box (other than the place plate) whose area intersects the photograph → violation."""
    hits = []
    for b in boxes:
        if b.get('role') in ('place_plate', 'logo', 'wordmark'): continue
        x0, y0, x1, y1 = b['x'], b['y'], b['x'] + b['w'], b['y'] + b['h']
        if x1 <= x0 or y1 <= y0: continue
        if merch[max(0, y0):y1, max(0, x0):x1].any(): hits.append(b['text'][:40])
    return hits


def _wrap(text, fnt, max_w, tracking=0):
    words = text.split(' '); lines = []; cur = ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if B.text_size(fnt, t, tracking)[0] <= max_w or not cur: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines
