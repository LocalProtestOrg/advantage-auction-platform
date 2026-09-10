"""EVENT_PHOTO family (Phase 3P.1 Mission 10-A + Phase 3P.2) — a real event led by its own authentic photograph.

Seller-led co-brand (Professional Seller primary) or Advantage.Bid-led. Title-unit patterns (prominence-rules.json):
  TYPE_LED       'Estate Sale' largest; the place/name second at 60–100% of it; modifiers ≤ 45% of the type cap height
  TWO_LINE_UNIT  place line / type line, type ≥ 80% of the place line
  UNIT           'West University Estate Sale' as one unit when it fits on ≤ 2 lines without an orphan
Identity: co-brand header — the seller in type (no seller logo asset exists in production; never lifted from a
reference) and 'In Conjunction with' + the REAL Advantage.Bid lockup composited by the logo stage (weight 60–90% of the
seller's). The band wordmark closes at the prominence cap height. Red: the rule under the title unit + ONE of
{event type, date}. The photograph is the event's own (provenance-bound), bleeds to both side edges, and is never
enhanced beyond crop. Calibration extremes scale ONLY identity and event type; the NOT FOR PUBLICATION label is a
sidecar label, never drawn on the canvas.
"""
import numpy as np
from PIL import Image, ImageDraw
from . import brand as B
from . import layout as LY
from .. import logo_stage


def _title_unit(draw, spec, W, H, y, boxes, reds, ts, s):
    c = spec['copy']; pat = spec.get('pattern', 'TYPE_LED'); m = int(0.045 * W)
    red_type = spec.get('red', 'event_type') == 'event_type'
    col = [0, W]
    def line(text, key, px, role, fill, max_w=None):
        f = B.fit_font(key, text, max_w or int(W * 0.92), px, 30)
        bx = B.draw_text(draw, text, 0, y, f, fill, align='center', box_w=W, role=role, boxes=boxes)
        bx['col'] = col
        return bx, f
    if c.get('modifier') and pat != 'UNIT':
        fm = B.font('jost-600', 30 * s)
        b = B.draw_text(draw, c['modifier'], 0, y, fm, B.SLATE, align='center', box_w=W, tracking=2, role='modifier', boxes=boxes); b['col'] = col
        y += int(fm.size * 1.45)
    type_px = int(122 * s * ts); title_px = int(92 * s)
    if not c.get('event_type'):
        f, ls = LY.fit_lines('playfair-900', c['event_title'], int(W * 0.9), int(108 * s), 40, max_lines=2)
        for ln in ls:
            bx = B.draw_text(draw, ln, 0, y, f, B.NAVY, align='center', box_w=W, role='event_title', boxes=boxes); bx['col'] = col
            y += int(f.size * 1.04)
    elif pat == 'TYPE_LED':
        b, f = line(c['event_type'], 'playfair-900', type_px, 'event_type', B.RED if red_type else B.NAVY)
        if red_type: reds.append(dict(kind='event_type'))
        y += int(f.size * 1.02)
        b2, f2 = line(c['event_title'], 'playfair-700', min(title_px, int(f.size * 0.9)), 'event_title', B.NAVY)
        y += int(f2.size * 1.08)
    elif pat == 'TWO_LINE_UNIT':
        b2, f2 = line(c['event_title'], 'playfair-900', int(104 * s), 'event_title', B.NAVY)
        y += int(f2.size * 1.02)
        b, f = line(c['event_type'], 'playfair-900', max(int(f2.size * 0.86 * ts), int(f2.size * 0.8)), 'event_type', B.RED if red_type else B.NAVY)
        if red_type: reds.append(dict(kind='event_type'))
        y += int(f.size * 1.08)
    else:   # UNIT
        text = c['event_title'] + ' ' + c['event_type']
        f, ls = LY.fit_lines('playfair-900', text, int(W * 0.92), int(96 * s * ts), 40, max_lines=2)
        for ln in ls:
            role = 'event_type' if c['event_type'] in ln else 'event_title'
            bx = B.draw_text(draw, ln, 0, y, f, B.NAVY, align='center', box_w=W, role=role, boxes=boxes); bx['col'] = col
            y += int(f.size * 1.04)
        if c.get('modifier'):
            fm = B.font('jost-600', 28 * s)
            bx = B.draw_text(draw, c['modifier'], 0, y, fm, B.SLATE, align='center', box_w=W, tracking=2, role='modifier', boxes=boxes); bx['col'] = col
            y += int(fm.size * 1.4)
    # the rule sits under the whole title unit, clear of its descenders (measured from the drawn boxes)
    unit = [b for b in boxes if b.get('role') in ('event_type', 'event_title', 'modifier')]
    y = max([y] + [b['y'] + b['h'] for b in unit]) + int(12 * s)
    rw = int(0.16 * W)
    LY.red_rule(draw, (W - rw) // 2, y, rw, max(4, int(7 * s)), boxes, reds)
    return y + int(30 * s)


def render(spec):
    W, H = B.FORMATS[spec.get('format', 'portrait_1080x1350')]
    fr = LY.frame(W, H); m = fr['margin']; s = H / 1350.0
    opt = spec.get('options') or {}
    ids = float(opt.get('identity_scale', 1.0)); ts = float(opt.get('type_scale', 1.0))
    c = spec['copy']; context = spec.get('context', 'seller_led_cobranded')
    img = Image.new('RGBA', (W, H), B.WHITE + (255,))
    draw = ImageDraw.Draw(img); boxes, reds = [], []
    merch = np.zeros((H, W), bool)
    band_top = H - fr['band_h']
    y = int(0.035 * H)
    logo_box = None
    # ── co-brand header: seller (primary, left) · 'In Conjunction with' + Advantage.Bid lockup (right) ──
    if context == 'seller_led_cobranded':
        fp = B.fit_font('playfair-700', c['presenter'], int(W * 0.5), int(66 * s), 30)
        pb = B.draw_text(draw, c['presenter'], m, y + int(10 * s), fp, B.NAVY, role='presenter', boxes=boxes)
        pb['col'] = [m, int(W * 0.5)]
        fr_ = B.font('jost-500', 42 * s * ids)
        lw = int(round(254 * s * ids)); lh = int(round(lw * 793 / 1983.0))   # scales with the canvas like the seller's type
        rt = c.get('relationship', 'In Conjunction with')
        tw, th = B.text_size(fr_, rt)
        rx = W - m - max(tw, lw)
        rb = B.draw_text(draw, rt, W - m - tw, y, fr_, B.SLATE, role='relationship', boxes=boxes, countable=False)
        rb['col'] = [rx, W - m - rx]
        logo_box = (W - m - lw, y + th + int(4 * s), lw, lh)
        y = max(pb['y'] + pb['h'], logo_box[1] + lh) + int(26 * s)
    else:
        lw = int(round(W * 0.40)); lh = int(round(lw * 793 / 1983.0))
        logo_box = ((W - lw) // 2, y, lw, lh)
        y += lh + int(22 * s)
    # ── title unit ──
    y = _title_unit(draw, spec, W, H, y, boxes, reds, ts, s)
    # ── date block (bottom, above the band) measured first so the photograph fills the space between ──
    fd = B.font('quicksand-700', 54 * s); fti = B.font('jost-500', 32 * s); fpl = B.font('jost-600', 26 * s)
    date_h = int(fd.size * 1.25) + int(fti.size * 1.55) + (int(fpl.size * 2.2) if c.get('place_plate') else 0) + int(34 * s)
    photo_top = y; photo_bottom = band_top - date_h
    declared = []
    if spec.get('photo_path'):
        ph = Image.open(spec['photo_path']).convert('RGB')
        fit = B.cover_fit(ph, W, max(40, photo_bottom - photo_top), focus=tuple(spec.get('focus', (0.5, 0.5))))
        img.paste(fit, (0, photo_top)); merch[photo_top:photo_bottom, :] = True
    else:
        # Tier 6 RESTRAINED_FACTUAL: no authentic media is ready — never a manufactured collage. The quiet ground is
        # declared intentional negative space; an event-bound lot photograph may sit as ONE small inset.
        area_h = photo_bottom - photo_top
        draw.rectangle([0, photo_top, W, photo_bottom], fill=B.VERY_LIGHT)
        if spec.get('inset_path'):
            ins = Image.open(spec['inset_path']).convert('RGB')
            ih = int(area_h * 0.78); iw = int(ih * ins.width / ins.height)
            ins = ins.resize((iw, ih), Image.LANCZOS)
            ix, iy = (W - iw) // 2, photo_top + (area_h - ih) // 2
            frame = Image.new('RGB', (iw + 16, ih + 16), (255, 255, 255)); img.paste(frame, (ix - 8, iy - 8)); img.paste(ins, (ix, iy))
            merch[iy:iy + ih, ix:ix + iw] = True
            declared = [dict(x=0, y=photo_top, w=ix - 8, h=area_h, reason='restrained factual quiet ground'), dict(x=ix + iw + 8, y=photo_top, w=W - ix - iw - 8, h=area_h, reason='restrained factual quiet ground')]
        else:
            declared = [dict(x=0, y=photo_top, w=W, h=area_h, reason='restrained factual quiet ground (no authentic media ready)')]
    draw = ImageDraw.Draw(img)
    dy = photo_bottom + int(18 * s)
    red_date = spec.get('red') == 'date'
    db = B.draw_text(draw, c['date'], 0, dy, fd, B.RED if red_date else B.NAVY, align='center', box_w=W, role='date', boxes=boxes); db['col'] = [0, W]
    if red_date: reds.append(dict(kind='date'))
    dy += int(fd.size * 1.25)
    tb = B.draw_text(draw, c['time'], 0, dy, fti, B.SLATE, align='center', box_w=W, role='time', boxes=boxes); tb['col'] = [0, W]
    dy += int(fti.size * 1.55)
    if c.get('place_plate'):
        tw, th = B.text_size(fpl, c['place_plate'], tracking=1)
        px0 = (W - tw) // 2 - 20; draw.rectangle([px0, dy, px0 + tw + 40, dy + th + 16], fill=B.NAVY)
        pb2 = B.draw_text(draw, c['place_plate'], px0 + 20, dy + 8, fpl, B.WHITE, tracking=1, role='place_plate', boxes=boxes); pb2['col'] = [0, W]
    LY.band(img, draw, W, H, fr, boxes)
    logo_rec = logo_stage.place(img, logo_box, context='cobrand' if context == 'seller_led_cobranded' else 'advantage_bid_led')
    boxes.append(dict(text='', x=logo_rec['box'][0], y=logo_rec['box'][1], w=logo_rec['box'][2], h=logo_rec['box'][3], role='logo', countable=False,
                      col=[logo_box[0], logo_box[2]]))
    thumb = B.save_png(img, spec['out_png'])
    field = dict(x=0, y=photo_top, w=W, h=photo_bottom - photo_top)
    fam = 'ENVIRONMENTAL_PHOTO' if spec.get('photo_path') else 'RESTRAINED_FACTUAL'
    met = LY.finish(img, dict(spec, event_type_required=bool(c.get('event_type'))), boxes, merch, fr, field, logo_rec, reds, fam, context, declared=declared,
                    extra=dict(pattern=spec.get('pattern', 'TYPE_LED'), photo_box=dict(x=0, y=photo_top, w=W, h=photo_bottom - photo_top), identity_scale=ids, type_scale=ts))
    qa = logo_stage.qa(spec['out_png'], logo_rec, band_box=[0, band_top, W, fr['band_h']])
    rec = {k: v for k, v in logo_rec.items() if not k.startswith('_')}
    placed = [dict(kind='photograph', asset=spec.get('photo_asset_id'), **met['photo_box'])] if spec.get('photo_path') else ([dict(kind='lot_photograph_inset', asset=spec.get('inset_asset_id'))] if spec.get('inset_path') else [])
    met['event_type_missing'] = not c.get('event_type')
    return dict(ok=True, png=spec['out_png'], thumb=thumb, boxes=boxes, placed=placed, logo=rec, logo_qa=qa,
                metrics=met, drawn_text=[b['text'] for b in boxes if b.get('text')], field=field, band_h=fr['band_h'])
