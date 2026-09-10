"""Phase 3P.1/3P.2 shared layout toolkit for the new families (editorial, event_photo, restrained_factual).

Every element is drawn through brand.draw_text / the helpers here so each box carries role, size, cap height and fill;
the family returns those boxes plus the merchandise mask, reserved copy regions, the logo placement and the red-element
manifest, and `finish()` computes coverage (field-based), prominence, event-type, colour and density measures in one
place. The logo is never drawn here — only reserved; logo_stage composites the registered asset.
"""
import numpy as np
from PIL import Image, ImageDraw
from . import brand as B
from .. import coverage, prominence, logo_stage, config

WORDMARK_CAP_PCT = 5.6          # inside the 5.2–6.5% band (prominence-rules.json)


def frame(W, H):
    """3P.1 identity frame: the band grows so the wordmark cap height reaches the prominence band."""
    # square canvases are smaller at feed size, so their wordmark sits higher in the 5.2–6.5% band
    cap = (6.3 if W / float(H) > 0.9 else WORDMARK_CAP_PCT) / 100.0 * H
    f = B.font('quicksand-600', 200)
    hb = f.getbbox('H'); ratio = (hb[3] - hb[1]) / 200.0
    size = int(round(cap / ratio)) + 1
    band_h = int(round(max(0.118 * H, cap * 2.05)))
    return dict(band_h=band_h, wordmark_px=size, margin=int(round(0.045 * W)))


def wrap(text, fnt, max_w, tracking=0):
    words = str(text).split(' '); lines = []; cur = ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if B.text_size(fnt, t, tracking)[0] <= max_w or not cur: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    # no orphan: if the last line is a single short word, pull one word down
    if len(lines) >= 2 and len(lines[-1].split()) == 1 and len(lines[-2].split()) >= 3:
        prev = lines[-2].split(); lines[-2] = ' '.join(prev[:-1]); lines[-1] = prev[-1] + ' ' + lines[-1]
    return lines


def fit_lines(key, text, max_w, max_size, min_size=16, max_lines=2, tracking=0):
    size = max_size
    while size >= min_size:
        f = B.font(key, size)
        ls = wrap(text, f, max_w, tracking)
        if len(ls) <= max_lines and all(B.text_size(f, l, tracking)[0] <= max_w for l in ls):
            return f, ls
        size -= 2
    f = B.font(key, min_size)
    return f, wrap(text, f, max_w, tracking)


def draw_lines(draw, lines, x, y, fnt, fill, align, box_w, role, boxes, leading=1.06, red_words=(), tracking=0, countable=True):
    """Draw wrapped lines; words listed in red_words are drawn in red (one red word/line is the colour budget's headline slot)."""
    reds = {w.lower().strip('.,!?') for w in red_words}
    for ln in lines:
        w, h = B.text_size(fnt, ln, tracking)
        lx = x + (box_w - w) // 2 if align == 'center' else (x + box_w - w if align == 'right' else x)
        if reds and any(tok.lower().strip('.,!?') in reds for tok in ln.split()):
            cx = lx
            for i, tok in enumerate(ln.split(' ')):
                seg = tok + (' ' if i < len(ln.split(' ')) - 1 else '')
                col = B.RED if tok.lower().strip('.,!?') in reds else fill
                draw.text((cx, y), seg, font=fnt, fill=col)
                cx += fnt.getlength(seg)
            hb = fnt.getbbox('H')
            boxes.append(dict(text=ln, x=int(lx), y=int(y), w=int(w), h=int(h), role=role, countable=countable, size=fnt.size, cap_h=int(hb[3] - hb[1]), fill=list(fill), red_words=list(reds)))
        else:
            B.draw_text(draw, ln, lx, y, fnt, fill, role=role, boxes=boxes, countable=countable, tracking=tracking)
        y += int(round(fnt.size * leading))
    return y


def red_rule(draw, x, y, w, h, boxes, red_manifest, role='accent_rule'):
    draw.rectangle([int(x), int(y), int(x + w), int(y + h)], fill=B.RED)
    red_manifest.append(dict(kind=role, x=int(x), y=int(y), w=int(w), h=int(h)))
    boxes.append(dict(text='', x=int(x), y=int(y), w=int(w), h=int(h), role=role, countable=False, fill=list(B.RED)))


def button(img, draw, text, x, y, fnt, boxes, red_manifest, pad=(34, 18), align='left', box_w=None, fill=None):
    tw, th = B.text_size(fnt, text)
    hb = fnt.getbbox('H'); cap = hb[3] - hb[1]
    w, h = tw + 2 * pad[0], cap + 2 * pad[1] + 6
    if align == 'center' and box_w: x = x + (box_w - w) // 2
    col = fill or B.RED
    draw.rounded_rectangle([int(x), int(y), int(x + w), int(y + h)], radius=int(h * 0.22), fill=col)
    draw.text((x + pad[0], y + (h - cap) / 2 - hb[1]), text, font=fnt, fill=B.WHITE)
    boxes.append(dict(text=text, x=int(x), y=int(y), w=int(w), h=int(h), role='cta', countable=True, size=fnt.size, cap_h=int(cap), fill=list(B.WHITE), button=True))
    if col == B.RED: red_manifest.append(dict(kind='cta', x=int(x), y=int(y), w=int(w), h=int(h)))
    return dict(x=int(x), y=int(y), w=int(w), h=int(h))


def benefit_rows(draw, items, x, y, fnt, boxes, gap, icon_fill=None, cols=1, col_w=None):
    """3–4 rows (icon disc + ≤ 4 words) for ACQUISITION_RICH only; the disc group counts as ONE red element."""
    hb = fnt.getbbox('H'); cap = hb[3] - hb[1]; d = int(cap * 1.55)
    col = icon_fill or B.RED
    y0 = y
    for i, t in enumerate(items):
        cx = x + (i % cols) * (col_w or 0); cy = y + (i // cols) * (d + gap)
        draw.ellipse([cx, cy, cx + d, cy + d], fill=col)
        # check mark (geometric glyph)
        draw.line([(cx + d * 0.28, cy + d * 0.52), (cx + d * 0.44, cy + d * 0.68), (cx + d * 0.74, cy + d * 0.34)], fill=B.WHITE, width=max(2, d // 9))
        B.draw_text(draw, t, cx + d + int(cap * 0.7), cy + (d - cap) // 2 - hb[1], fnt, B.NAVY, role='benefits', boxes=boxes)
    rows = (len(items) + cols - 1) // cols
    return y0 + rows * (d + gap)


def band(img, draw, W, H, fr, boxes, script=None, align='center'):
    """Navy band + the locked 'Advantage.Bid' wordmark at the prominence cap height; optional ONE script accent (white)."""
    bh = fr['band_h']
    draw.rectangle([0, H - bh, W, H], fill=B.NAVY)
    f = B.font('quicksand-600', fr['wordmark_px'])
    w, h = B.text_size(f, 'Advantage.Bid')
    hb = f.getbbox('H'); cap = hb[3] - hb[1]
    y = H - bh + (bh - cap) / 2 - hb[1]
    if script:
        # The wordmark size is locked (prominence cap); the script accent yields: it shrinks to fit the band width and,
        # if it still cannot fit at 0.40× the wordmark size, it is left out (recorded) — never clipped at the canvas edge.
        avail = W - 2 * fr['margin']
        k = 0.62
        while True:
            fs = B.font('pinyon', int(fr['wordmark_px'] * k))
            sw, sh = B.text_size(fs, script)
            total = w + int(W * 0.05) + sw
            if total <= avail or k <= 0.40: break
            k = round(k - 0.04, 2)
        if total > avail:
            boxes.append(dict(text='', x=0, y=int(H - bh), w=0, h=0, role='band_script_omitted', countable=False, note='script accent does not fit beside the locked wordmark'))
            script = None
    if script:
        x = (W - total) // 2 if align == 'center' else fr['margin']
        draw.text((x, y), 'Advantage.Bid', font=f, fill=B.WHITE)
        sx = x + w + int(W * 0.05); shb = fs.getbbox('H')
        draw.text((sx, H - bh + (bh - (shb[3] - shb[1])) / 2 - shb[1]), script, font=fs, fill=B.WHITE)
        boxes.append(dict(text=script, x=int(sx), y=int(H - bh), w=int(sw), h=int(bh), role='band_script', countable=False, size=fs.size, cap_h=int(shb[3] - shb[1]), fill=list(B.WHITE)))
    else:
        x = (W - w) // 2 if align == 'center' else fr['margin']
        draw.text((x, y), 'Advantage.Bid', font=f, fill=B.WHITE)
    boxes.append(dict(text='Advantage.Bid', x=int(x), y=int(y + hb[1]), w=int(w), h=int(cap), role='wordmark', countable=False, size=f.size, cap_h=int(cap), fill=list(B.WHITE)))
    return dict(x=0, y=H - bh, w=W, h=bh)


def disclosure(draw, text, x, y, box_w, W, H, boxes, align='left'):
    f = B.font('jost-400', max(15, int(0.0145 * H)))
    return B.draw_text(draw, text, x, y, f, B.MUTE, align=align, box_w=box_w, role='disclosure', boxes=boxes, countable=False)


def copy_regions(boxes, pad=10, W=None):
    """Reserved copy REGIONS (coverage-bands.json merchandise_field): each copy element reserves a block across its
    layout column — the full canvas width for a centred / top copy block, the copy column for a side layout (box['col']).
    A box without column information reserves its own padded rectangle, or the full width when it is centred.
    Panel / card fills are NOT copy regions: their empty area stays in the field (a card must earn its area)."""
    out = []
    for b in boxes:
        if b.get('role') in ('wordmark', 'band_script', 'band_item', 'disclosure') or not b.get('w'): continue
        col = b.get('col')
        if col:
            x0, cw = col
        elif W and abs((b['x'] + b['w'] / 2.0) - W / 2.0) < 0.05 * W and b['w'] > 0.25 * W:
            x0, cw = 0, W
        else:
            x0, cw = b['x'], b['w']
        out.append(dict(x=x0 - pad, y=b['y'] - pad, w=cw + 2 * pad, h=b['h'] + 2 * pad, role=b.get('role')))
    return out


DENSITY_EXCLUDE = {'band_script_omitted', 'disclosure', 'extreme_label', 'accent_rule', 'wordmark', 'band_script', 'band_item', 'relationship', 'logo_mark'}


# copy-density.json slots group several drawn roles into one block: "presenter (seller/logo)", "date/time (sessions)",
# the modifier is the support line, and a Notable Lot's "lot number + item name" / "event name + date" are one slot each.
SLOT_OF = {'time': 'date', 'modifier': 'support', 'lot_number': 'headline', 'event_type_line': 'event_line', 'event_title_line': 'event_line'}


HEADLINE_UNIT = {'event_type': 'event_headline', 'event_title': 'event_headline', 'event_type_line': 'event_headline', 'event_title_line': 'event_headline'}


def density(boxes, has_band=True, profile=None):
    """Copy-density blocks per copy-density.json slots; the logo and the band count as one each."""
    present = {b.get('role') for b in boxes}
    roles = []
    for b in boxes:
        r = b.get('role')
        if r in DENSITY_EXCLUDE or r is None: continue
        r = SLOT_OF.get(r, r)
        if r == 'logo' and 'presenter' in present: r = 'presenter'          # co-brand: the partnership mark sits in the presenter slot
        if profile == 'NOTABLE_LOT' and r == 'date': r = 'event_line'
        if profile == 'RESTRAINED_FACTUAL':
            # copy-density.json RESTRAINED_FACTUAL slots: "event type + title" is one slot, "date/place" is one slot
            if r in ('event_type', 'event_title'): r = 'event_line'
            if r == 'place_plate': r = 'date'
        if r not in roles: roles.append(r)
    blocks = len(roles) + (1 if has_band else 0)
    texts = [b for b in boxes if b.get('role') not in DENSITY_EXCLUDE and b.get('role') != 'logo' and b.get('text')]
    caps = sorted({(b['role'], b.get('cap_h') or 0) for b in texts}, key=lambda x: -x[1])
    per_role = {}
    for r, c in caps:
        # The event-type hierarchy (3P.1) sets event type + event title as ONE headline unit (type leads, title follows
        # as its second beat — "Estate Sale / West University"); copy-density's one_idea rule treats a two-beat
        # headline as one idea. They are therefore one headline-class element, never two competing headlines.
        r = HEADLINE_UNIT.get(r, r)
        per_role[r] = max(per_role.get(r, 0), c)
    ranked = sorted(per_role.items(), key=lambda x: -x[1])
    headline_class = [r for r, c in ranked if ranked and c >= 0.75 * ranked[0][1]]
    dominance = round(ranked[0][1] / float(ranked[1][1]), 2) if len(ranked) > 1 and ranked[1][1] else None
    return dict(blocks=blocks, roles=roles + (['band'] if has_band else []), headline_class_roles=headline_class, headline_dominance=dominance)


def finish(img, spec, boxes, merch, fr, field, logo_rec, red_manifest, family, context, extra=None, declared=(), panels=()):
    W, H = img.size
    band_h = fr['band_h']
    regions = copy_regions(boxes, W=W)
    cov_field = dict(x=0, y=0, w=W, h=H - band_h) if (spec.get('coverage_field') or 'canvas') == 'canvas' else field
    cov = coverage.measure((W, H), cov_field, merch, text_boxes=[b for b in boxes if b.get('w') and b.get('role') not in ('wordmark', 'band_script')], band_h=band_h,
                           declared=declared, panels=panels, exclude=[r for r in regions if r.get('role') != 'disclosure'])
    cov_gate = coverage.gate(family, cov)
    prom = prominence.identity(img, boxes, logo_rec, context, band_h)
    col = prominence.colour(img, boxes, band_h, regions, merch_mask=merch, red_elements=red_manifest)
    et = prominence.event_type(boxes, H, required=bool(spec.get('event_type_required')))
    dens = density(boxes, profile=spec.get('profile'))
    tx = np.zeros((H, W), bool)
    for b in boxes:
        if b.get('role') in ('wordmark', 'band_script') or not b.get('w'): continue
        x0, y0 = max(0, b['x']), max(0, b['y']); x1, y1 = min(W, b['x'] + b['w']), min(H, b['y'] + b['h'])
        if x1 > x0 and y1 > y0: tx[y0:y1, x0:x1] = True
    Hc = H - band_h
    hits = []
    for b in boxes:
        if b.get('role') in ('logo', 'wordmark', 'band_script', 'disclosure', 'accent_rule') or not b.get('w'): continue
        x0, y0, x1, y1 = max(0, b['x']), max(0, b['y']), min(W, b['x'] + b['w']), min(H, b['y'] + b['h'])
        if x1 > x0 and y1 > y0 and merch[y0:y1, x0:x1].mean() > 0.02: hits.append(b['text'][:40])
    m = dict(size=[W, H], family=family, structure=spec.get('structure'), profile=spec.get('profile'), band_h=band_h,
             merchandise_pct=round(100.0 * merch[:Hc].mean(), 1), text_region_pct=round(100.0 * tx[:Hc].mean(), 1),
             coverage=cov, coverage_gate=dict(pass_=cov_gate['pass_'], hard_failures=cov_gate['hard_failures'], soft=cov_gate['soft']),
             prominence=prom, colour=col, event_type=et, density=dens, copy_over_merchandise=hits,
             largest_empty_pct=cov['largest_accidental_void_pct'], upper_half_merch_pct=round(100.0 * merch[:H // 2].mean(), 1),
             text_blocks=dens['blocks'], ground_luminance=col['canvas_luminance'],
             brand_frame=dict(logo=bool(logo_rec and 'box' in logo_rec), band=True, wordmark=any(b.get('role') == 'wordmark' for b in boxes)))
    if extra: m.update(extra)
    return m
