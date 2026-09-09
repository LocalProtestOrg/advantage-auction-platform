"""Advantage.Bid brand frame + drawing/metrics helpers for the Pillow families (Phase 3P).

Brand frame (Phase 3O, unchanged): logo 250px, navy band 120px with white 'Advantage.Bid' wordmark 64px, red accent,
white / very_light ground — for 1080x1350; other formats derive proportionally (band ~8.9% of height).
Fonts are the bundled OFL faces (creative-engine/runtime/fonts/ttf): Quicksand (brand), Playfair Display (expressive
event title), Jost (support/logistics). No reference typeface is ever used — these are Advantage.Bid's own.
"""
import os
from PIL import Image, ImageDraw, ImageFont
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'runtime')
FONT_DIR = os.path.join(RUNTIME, 'fonts', 'ttf')
ASSET_DIR = os.path.join(RUNTIME, 'assets')

NAVY = (24, 46, 69); RED = (214, 40, 40); SLATE = (74, 91, 112); MUTE = (123, 138, 156)
WHITE = (255, 255, 255); VERY_LIGHT = (247, 247, 244); INK = (28, 32, 38)

FRAME_1080x1350 = dict(logo_width_px=250, footer_band_px=120, footer_wordmark_px=64, kicker='ADVANTAGE.BID PRESENTS',
                       navy='#182e45', red='#d62828')

FONT_FILES = {
    'quicksand-600': 'quicksand-latin-600-normal.ttf', 'quicksand-700': 'quicksand-latin-700-normal.ttf',
    'playfair-700': 'playfair-display-latin-700-normal.ttf', 'playfair-900': 'playfair-display-latin-900-normal.ttf',
    'jost-400': 'jost-latin-400-normal.ttf', 'jost-500': 'jost-latin-500-normal.ttf', 'jost-600': 'jost-latin-600-normal.ttf',
}

FORMATS = {'portrait_1080x1350': (1080, 1350), 'square_1080x1080': (1080, 1080), 'landscape_1200x628': (1200, 628),
           'story_1080x1920': (1080, 1920)}


def frame_for(W, H):
    """Proportional brand-frame constants for any format (exact 3O values at 1080x1350)."""
    s = H / 1350.0
    return dict(logo_width_px=int(round(250 * W / 1080.0)), footer_band_px=int(round(120 * s)),
                footer_wordmark_px=int(round(64 * s)), kicker=FRAME_1080x1350['kicker'])


def font(key, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, FONT_FILES[key]), max(6, int(round(size))))


def text_size(fnt, text, tracking=0):
    w = sum(fnt.getlength(ch) for ch in text) + tracking * max(0, len(text) - 1) if tracking else fnt.getlength(text)
    asc, desc = fnt.getmetrics()
    return int(round(w)), asc + desc


def fit_font(key, text, max_w, max_size, min_size=12, tracking=0):
    size = max_size
    while size > min_size:
        f = font(key, size)
        if text_size(f, text, tracking)[0] <= max_w:
            return f
        size -= 2
    return font(key, min_size)


def draw_text(draw, text, x, y, fnt, fill, align='left', box_w=None, tracking=0, role='text', boxes=None, countable=True):
    """Draw one text line; append its measured box to `boxes`. align in left|center|right relative to (x, box_w)."""
    w, h = text_size(fnt, text, tracking)
    if align == 'center' and box_w: x = x + (box_w - w) // 2
    elif align == 'right' and box_w: x = x + box_w - w
    if tracking:
        cx = x
        for ch in text:
            draw.text((cx, y), ch, font=fnt, fill=fill)
            cx += fnt.getlength(ch) + tracking
    else:
        draw.text((x, y), text, font=fnt, fill=fill)
    box = dict(text=text, x=int(x), y=int(y), w=int(w), h=int(h), role=role, countable=countable, size=fnt.size)
    if boxes is not None: boxes.append(box)
    return box


def logo_image(width):
    im = Image.open(os.path.join(ASSET_DIR, 'logo.webp')).convert('RGBA')
    h = int(round(width * im.height / im.width))
    return im.resize((width, h), Image.LANCZOS)


def draw_logo(img, x, y, width, boxes=None):
    lg = logo_image(width)
    img.alpha_composite(lg, (int(x), int(y)))
    box = dict(text='', x=int(x), y=int(y), w=lg.width, h=lg.height, role='logo', logo=True, countable=False)
    if boxes is not None: boxes.append(box)
    return box


def draw_band(img, draw, W, H, fr, boxes=None):
    """Navy footer band with the white Advantage.Bid wordmark (Quicksand 600) — the standard brand close."""
    bh = fr['footer_band_px']
    draw.rectangle([0, H - bh, W, H], fill=NAVY)
    f = font('quicksand-600', fr['footer_wordmark_px'])
    w, h = text_size(f, 'Advantage.Bid')
    asc, desc = f.getmetrics()
    y = H - bh + (bh - (asc + desc)) // 2
    draw.text(((W - w) // 2, y), 'Advantage.Bid', font=f, fill=WHITE)
    if boxes is not None:
        boxes.append(dict(text='Advantage.Bid', x=(W - w) // 2, y=int(y), w=int(w), h=int(asc + desc), role='wordmark', countable=False))
    return dict(x=0, y=H - bh, w=W, h=bh)


def cover_fit(photo, box_w, box_h, focus=(0.5, 0.45)):
    """Crop/scale a photograph to fill box_w x box_h without distortion (cover). focus = relative crop centre."""
    pw, ph = photo.size
    scale = max(box_w / pw, box_h / ph)
    nw, nh = int(round(pw * scale)), int(round(ph * scale))
    im = photo.resize((nw, nh), Image.LANCZOS)
    cx, cy = int((nw - box_w) * focus[0]), int((nh - box_h) * focus[1])
    return im.crop((cx, cy, cx + box_w, cy + box_h))


def rel_luminance(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb[:3]
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast_ratio(a, b):
    la, lb = rel_luminance(a), rel_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return round((hi + 0.05) / (lo + 0.05), 2)


def largest_empty_pct(occ, cell=20):
    H, W = occ.shape
    H2, W2 = (H // cell) * cell, (W // cell) * cell
    occ = occ[:H2, :W2]
    g = occ.reshape(H2 // cell, cell, W2 // cell, cell).any(axis=(1, 3))
    rows, cols = g.shape; best = 0; hist = [0] * cols
    for r in range(rows):
        for c in range(cols): hist[c] = 0 if g[r, c] else hist[c] + 1
        stack = []
        for c in range(cols + 1):
            cur = hist[c] if c < cols else 0
            start = c
            while stack and stack[-1][1] >= cur:
                s, h = stack.pop(); best = max(best, h * (c - s)); start = s
            stack.append((start, cur))
    return round(100.0 * best * cell * cell / (W * H), 1)


def layout_metrics(W, H, band_h, merch_mask, boxes, ground_rgb):
    """compose.metrics-compatible measurements + Phase 3P hierarchy measurements. merch_mask: HxW bool."""
    Hc = H - band_h
    tx = np.zeros((H, W), bool)
    for b in boxes:
        if b.get('role') in ('logo', 'wordmark'): continue
        x0, y0 = max(0, b['x']), max(0, b['y']); x1, y1 = min(W, b['x'] + b['w']), min(H, b['y'] + b['h'])
        if x1 > x0 and y1 > y0: tx[y0:y1, x0:x1] = True
    occ = (merch_mask | tx)[:Hc]
    half = H // 2
    # A copy BLOCK is one role (a wrapped multi-line title is still one block — same counting rule as the
    # shipped text_budget_audit). Hierarchy compares type SIZES (px), not wrapped box heights.
    countable = [b for b in boxes if b.get('countable', True) and b.get('role') not in ('logo', 'wordmark', 'disclosure', 'extreme_label')]
    blocks = {}
    for b in countable:
        blk = blocks.setdefault(b['role'], dict(role=b['role'], size=b.get('size', b['h']), text=[]))
        blk['size'] = max(blk['size'], b.get('size', b['h'])); blk['text'].append(b['text'])
    order = sorted(blocks.values(), key=lambda k: -k['size'])
    title = blocks.get('title')
    others = [k['size'] for k in order if k['role'] != 'title']
    hierarchy_ratio = round(title['size'] / max(others), 2) if title and others else None
    date = blocks.get('date'); time = blocks.get('time')
    return dict(size=[W, H],
                merchandise_pct=round(100.0 * merch_mask[:Hc].mean(), 1),
                text_region_pct=round(100.0 * tx[:Hc].mean(), 1),
                combined_pct=round(100.0 * occ.mean(), 1),
                largest_empty_pct=largest_empty_pct(occ),
                upper_half_merch_pct=round(100.0 * merch_mask[:half].mean(), 1),
                text_blocks=len(blocks),
                text_block_roles=list(blocks.keys()),
                largest_text_px=order[0]['size'] if order else 0,
                hierarchy_ratio=hierarchy_ratio,
                date_gt_time=(bool(date['size'] > time['size']) if (date and time) else None),
                title_words=(len(' '.join(title['text']).split()) if title else None),
                ground_luminance=round(rel_luminance(ground_rgb), 3),
                brand_frame=dict(logo=any(b.get('role') == 'logo' for b in boxes), band=band_h > 0,
                                 wordmark=any(b.get('role') == 'wordmark' for b in boxes)))


def save_png(img, out_png, thumb_w=281):
    os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
    rgb = img.convert('RGB'); rgb.save(out_png, 'PNG', optimize=True)
    tw = thumb_w; th = int(round(tw * img.height / img.width))
    thumb = out_png[:-4] + '_thumb.png'
    rgb.resize((tw, th), Image.LANCZOS).save(thumb, 'PNG', optimize=True)
    return thumb
