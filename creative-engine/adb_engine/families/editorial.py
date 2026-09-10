"""EDITORIAL family (Phase 3P.1 + 3P.2) — Advantage.Bid-led creative in a named STRUCTURE with a named COPY PROFILE.

Structures (variation-requirements.json): LEFT_COPY · RIGHT_COPY · CENTERED · TOP_COPY_BOTTOM_SCENE · ASYMMETRIC ·
ENVIRONMENTAL_FULL_BLEED · HERO_OBJECT. Profiles (copy-density.json): FEED_FAST · ACQUISITION_RICH · NOTABLE_LOT ·
RESTRAINED_FACTUAL · EVENT. Scene kinds: planned (scene_planner — physically audited representative or lot objects),
photo (an authentic photograph, cover-fitted), hero (one lot's own photograph/cutout), none.

Order of work (logo-asset-system compositing stage): layout reserves the logo box → scene → typography → band →
LOGO STAGE composites the registered asset (never drawn) → metrics/QA. Copy arrives already cased and approved by the
Node copy engine; this module never invents text. Representative scenes carry the disclosure line.
"""
import numpy as np
from PIL import Image, ImageDraw
from . import brand as B
from . import layout as LY
from .. import scene_planner, logo_stage

STRUCTURES = ('LEFT_COPY', 'RIGHT_COPY', 'CENTERED', 'TOP_COPY_BOTTOM_SCENE', 'ASYMMETRIC', 'ENVIRONMENTAL_FULL_BLEED', 'HERO_OBJECT')


def _headline_font(spec):
    return 'jost-800' if (spec.get('options') or {}).get('headline_case') == 'uppercase_display' else 'playfair-700'


def _copy_stack(img, draw, spec, x, y, col_w, H, boxes, reds, align='left', scale=1.0):
    """Eyebrow → headline (one red word) → red rule → sub-headline → support → benefits → CTA → help/availability."""
    c = spec['copy']; s = H / 1350.0 * scale
    if c.get('eyebrow'):
        fe = B.font('jost-600', 26 * s)
        B.draw_text(draw, c['eyebrow'], x, y, fe, B.SLATE, align=align, box_w=col_w, tracking=3, role='eyebrow', boxes=boxes)
        y += int(fe.size * 1.5)
    head = c.get('headline')
    if head:
        fh, lines = LY.fit_lines(_headline_font(spec), head, col_w, int(spec.get('headline_px', 104) * s), 40, max_lines=spec.get('headline_max_lines', 3))
        y = LY.draw_lines(draw, lines, x, y, fh, B.NAVY, align, col_w, 'headline', boxes, leading=1.04, red_words=c.get('headline_red_words') or [])
        y += int(fh.size * 0.42)   # the rule sits clearly BELOW the whole headline unit (a divider, never a one-word underline)
        rw = int(min(col_w * 0.30, 130 * s))
        LY.red_rule(draw, x + ((col_w - rw) // 2 if align == 'center' else 0), y, rw, max(4, int(7 * s)), boxes, reds)
        y += int(30 * s)
    if c.get('subheadline'):
        fs, ls = LY.fit_lines('playfair-600', c['subheadline'], col_w, int(52 * s), 26, max_lines=2)
        y = LY.draw_lines(draw, ls, x, y, fs, B.NAVY, align, col_w, 'subheadline', boxes, leading=1.1)
        y += int(12 * s)
    if c.get('support'):
        fsu = B.font('jost-500', 34 * s)
        y = LY.draw_lines(draw, LY.wrap(c['support'], fsu, col_w), x, y, fsu, B.SLATE, align, col_w, 'support', boxes, leading=1.3)
        y += int(18 * s)
    if c.get('benefits'):
        fb = B.font('jost-600', 30 * s)
        y = LY.benefit_rows(draw, c['benefits'][:4], x, y, fb, boxes, int(16 * s)) + int(10 * s)
        reds.append(dict(kind='benefit_disc_group'))
    if c.get('cta'):
        fc = B.font('jost-700', 34 * s)
        bt = LY.button(img, draw, c['cta'], x, y, fc, boxes, reds, pad=(int(34 * s), int(20 * s)), align=align, box_w=col_w)
        y = bt['y'] + bt['h'] + int(22 * s)
    for role in ('availability', 'help'):
        if c.get(role):
            fl = B.font('jost-500', 28 * s)
            y = LY.draw_lines(draw, LY.wrap(c[role], fl, col_w), x, y, fl, B.SLATE if role == 'help' else B.NAVY, align, col_w, role, boxes, leading=1.3)
            y += int(8 * s)
    if c.get('slogan'):
        fsl = B.font('playfair-700i', 34 * s)
        B.draw_text(draw, c['slogan'], x, y, fsl, B.NAVY, align=align, box_w=col_w, role='slogan', boxes=boxes)
        y += int(fsl.size * 1.4)
    return y


def _facts_ladder(draw, spec, x, y, col_w, H, boxes, reds, align='left'):
    """NOTABLE_LOT fact ladder: label → lot number + item → event type + date → catalogue size (if true) → CTA."""
    c = spec['copy']; s = H / 1350.0
    fl = B.font('jost-700', 30 * s)
    B.draw_text(draw, c['label'], x, y, fl, B.RED, align=align, box_w=col_w, tracking=3, role='label', boxes=boxes)
    reds.append(dict(kind='label')); y += int(fl.size * 1.6)
    if c.get('lot_number'):
        fn = B.font('jost-600', 34 * s)
        B.draw_text(draw, c['lot_number'], x, y, fn, B.SLATE, align=align, box_w=col_w, role='lot_number', boxes=boxes); y += int(fn.size * 1.35)
    fh, lines = LY.fit_lines('playfair-700', c['item_title'], col_w, int(84 * s), 34, max_lines=3)
    y = LY.draw_lines(draw, lines, x, y, fh, B.NAVY, align, col_w, 'headline', boxes, leading=1.05)
    y += int(24 * s)
    fe = B.font('jost-600', 40 * s)
    if c.get('event_type'):
        B.draw_text(draw, c['event_type'], x, y, fe, B.NAVY, align=align, box_w=col_w, role='event_type_line', boxes=boxes); y += int(fe.size * 1.3)
    if c.get('event_title'):
        fet = B.font('jost-500', 32 * s)
        y = LY.draw_lines(draw, LY.wrap(c['event_title'], fet, col_w), x, y, fet, B.SLATE, align, col_w, 'event_title_line', boxes, leading=1.25)
    if c.get('date'):
        fd = B.font('jost-600', 32 * s)
        B.draw_text(draw, c['date'], x, y, fd, B.NAVY, align=align, box_w=col_w, role='date', boxes=boxes); y += int(fd.size * 1.4)
    if c.get('catalogue_size'):
        fcs = B.font('jost-500', 28 * s)
        B.draw_text(draw, c['catalogue_size'], x, y, fcs, B.SLATE, align=align, box_w=col_w, role='catalogue_size', boxes=boxes); y += int(fcs.size * 1.4)
    y += int(16 * s)
    if c.get('cta'):
        fc = B.font('jost-700', 32 * s)
        bt = LY.button(None, draw, c['cta'], x, y, fc, boxes, reds, pad=(int(30 * s), int(18 * s)), align=align, box_w=col_w)
        y = bt['y'] + bt['h'] + int(16 * s)
    return y


def _place_scene(img, spec, field, W, H, fr, merch):
    sc = spec.get('scene') or {}
    kind = sc.get('kind', 'none')
    plan = None; placed = []
    if kind == 'planned':
        fam = spec.get('coverage_family', 'ACQUISITION')
        sc = dict(sc, options=dict(sc.get('options') or {}, **{k: v for k, v in (spec.get('_planner_extra') or {}).items() if k != 'copy_regions'}))
        if sc.get('search', True):
            plan = scene_planner.plan_best(sc['objects'], field, (W, H), family=fam, arrangements=tuple(sc.get('arrangements') or ('anchor_right', 'anchor_left', 'split', 'split_reverse')),
                                           copy_regions=(spec.get('_planner_extra') or {}).get('copy_regions') or [],
                                           options=dict(sc.get('options') or {}, band_h=fr['band_h']), declared=sc.get('declared') or [])
        else:
            plan = scene_planner.plan(sc['objects'], field, (W, H), family=fam, arrangement=sc.get('arrangement', 'anchor_right'),
                                      options=dict(sc.get('options') or {}, band_h=fr['band_h']), declared=sc.get('declared') or [])
        if plan.get('objects'):
            merch, placed = scene_planner.render_plan(img, plan, merch)
    elif kind == 'photo':
        ph = Image.open(sc['photo_path']).convert('RGB')
        fit = B.cover_fit(ph, int(field['w']), int(field['h']), focus=tuple(sc.get('focus', (0.5, 0.5))))
        img.paste(fit, (int(field['x']), int(field['y'])))
        merch[int(field['y']):int(field['y'] + field['h']), int(field['x']):int(field['x'] + field['w'])] = True
        placed = [dict(asset=sc.get('asset_id'), kind='photograph', x=int(field['x']), y=int(field['y']), w=int(field['w']), h=int(field['h']))]
    elif kind == 'hero':
        im = Image.open(sc['path']).convert('RGBA')
        cutout = np.asarray(im)[..., 3].min() < 250
        if cutout:
            tp, (tw, th), _ = scene_planner.trimmed(sc['path'])
            im = Image.open(tp).convert('RGBA')
        box_w, box_h = field['w'] * sc.get('fill', 0.86), field['h'] * sc.get('fill', 0.86)
        k = min(box_w / im.width, box_h / im.height)
        im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
        x = int(field['x'] + (field['w'] - im.width) / 2); y = int(field['y'] + (field['h'] - im.height) * sc.get('valign', 0.55))
        if cutout:
            sh = Image.new('RGBA', (im.width, max(8, im.height // 14)), (0, 0, 0, 0))
            ImageDraw.Draw(sh).ellipse([int(im.width * 0.08), 0, int(im.width * 0.92), sh.height], fill=(20, 24, 30, 50))
            img.alpha_composite(sh, (x, y + im.height - sh.height // 2))
        img.alpha_composite(im, (x, y))
        a = (np.asarray(im)[..., 3] > 64) if cutout else np.ones((im.height, im.width), bool)
        merch[y:y + im.height, x:x + im.width] |= a[:max(0, min(im.height, H - y)), :max(0, min(im.width, W - x))]
        placed = [dict(asset=sc.get('asset_id'), kind='lot_photograph' if not cutout else 'lot_cutout', x=x, y=y, w=im.width, h=im.height)]
    return merch, plan, placed


def render(spec):
    W, H = B.FORMATS[spec.get('format', 'portrait_1080x1350')]
    fr = LY.frame(W, H); m = fr['margin']; s = H / 1350.0
    st = spec.get('structure', 'LEFT_COPY'); opt = spec.get('options') or {}
    ground = B.WHITE if spec.get('ground', 'white') == 'white' else B.VERY_LIGHT
    img = Image.new('RGBA', (W, H), ground + (255,))
    draw = ImageDraw.Draw(img)
    boxes, reds = [], []
    merch = np.zeros((H, W), bool)
    band_top = H - fr['band_h']
    logo_w = int(round(opt.get('logo_width_pct', 0.40) * W))
    logo_h = int(round(logo_w * 793 / 1983.0))
    landscape = W > H * 1.2
    field = None; logo_box = None; col = None; align = 'left'
    if st in ('LEFT_COPY', 'RIGHT_COPY'):
        col_w = int(W * opt.get('copy_col_frac', 0.44)) - m
        cx = m if st == 'LEFT_COPY' else W - m - col_w
        logo_box = (cx, int(0.035 * H), logo_w, logo_h)
        y0 = logo_box[1] + logo_h + max(int(0.03 * H), int(logo_h * 0.26))   # ≥ one logo cap height of clear space
        # L-shaped scene: the floor row may run the full width under the copy column; hung art stays in the wall zone
        field = dict(x=m // 2, y=int(0.05 * H), w=W - m, h=band_top - int(0.05 * H) - int(0.045 * H))
        col = (cx, y0, col_w); align = 'left'
        wall_zone = dict(x=cx + col_w + int(0.03 * W), w=W - (cx + col_w + int(0.03 * W)) - m // 2) if st == 'LEFT_COPY' else dict(x=m // 2, w=W - col_w - m - int(0.03 * W))
    elif st in ('CENTERED', 'TOP_COPY_BOTTOM_SCENE'):
        align = 'center' if st == 'CENTERED' else 'left'
        lx = (W - logo_w) // 2 if align == 'center' else m
        logo_box = (lx, int(0.03 * H), logo_w, logo_h)
        y0 = logo_box[1] + logo_h + max(int(0.04 * H), int(logo_h * 0.26))
        col = (m, y0, W - 2 * m)
    elif st == 'ASYMMETRIC':
        logo_box = (m, int(0.035 * H), logo_w, logo_h)
        field = dict(x=int(W * 0.34), y=logo_box[1] + logo_h + int(0.02 * H), w=W - int(W * 0.34) - m // 2, h=int(0.52 * H))
        col = (m, None, int(W * 0.60)); align = 'left'
    elif st == 'ENVIRONMENTAL_FULL_BLEED':
        field = dict(x=0, y=0, w=W, h=band_top)
        pw = int(W * opt.get('panel_frac', 0.50))
        logo_box = (m + int(0.02 * W), int(0.05 * H), min(logo_w, pw - 2 * m), int(min(logo_w, pw - 2 * m) * 793 / 1983.0))
        col = (m + int(0.02 * W), logo_box[1] + logo_box[3] + int(0.025 * H), pw - 2 * m - int(0.02 * W)); align = 'left'
    elif st == 'HERO_OBJECT':
        col_w = int(W * 0.42) - m
        logo_box = (m, int(0.035 * H), min(logo_w, col_w), int(min(logo_w, col_w) * 793 / 1983.0))
        field = dict(x=m + col_w + int(0.03 * W), y=int(0.05 * H), w=W - m - col_w - int(0.03 * W) - m // 2, h=band_top - int(0.09 * H))
        col = (m, logo_box[1] + logo_box[3] + int(0.03 * H), col_w); align = 'left'
    else:
        raise ValueError('unknown structure ' + str(st))

    # ── scene first for full-bleed (the copy panel sits over it); otherwise after the copy block is measured ──
    if st == 'ENVIRONMENTAL_FULL_BLEED':
        merch, plan, placed = _place_scene(img, spec, field, W, H, fr, merch)
        pw = int(W * opt.get('panel_frac', 0.50))
        panel = Image.new('RGBA', (pw, band_top), (255, 255, 255, int(255 * opt.get('panel_opacity', 0.94))))
        img.alpha_composite(panel, (0, 0)); merch[:band_top, :pw] = False
        draw = ImageDraw.Draw(img)
        # field for coverage = the photograph area not under the copy panel
        field = dict(x=pw, y=0, w=W - pw, h=band_top)
    # copy
    cx, cy, cw = col
    if st == 'ASYMMETRIC':
        # headline low-left: measure the stack height first by drawing on a scratch canvas
        scratch = Image.new('RGBA', (W, H)); sd = ImageDraw.Draw(scratch); tmp_boxes, tmp_reds = [], []
        end = _copy_stack(scratch, sd, dict(spec, copy=dict(spec['copy'], cta=None)), cx, 0, cw, H, tmp_boxes, tmp_reds, align)
        cy = band_top - int(0.035 * H) - end
    n_before = len(boxes)
    if spec.get('profile') == 'NOTABLE_LOT':
        y_end = _facts_ladder(draw, spec, cx, cy, cw, H, boxes, reds, align)
    else:
        sp = dict(spec, copy=dict(spec['copy'], cta=None)) if st == 'ASYMMETRIC' else spec
        y_end = _copy_stack(img, draw, sp, cx, cy, cw, H, boxes, reds, align)
    col_block = [0, W] if st in ('CENTERED', 'TOP_COPY_BOTTOM_SCENE') else [cx, cw]
    for b in boxes[n_before:]:
        b['col'] = col_block        # the copy column reserves its block (coverage field = canvas minus these)
    if field is None:   # CENTERED / TOP_COPY: scene below the copy block
        field = dict(x=m // 2, y=y_end + int(0.015 * H), w=W - m, h=band_top - y_end - int(0.015 * H) - int(0.04 * H))
    if st not in ('ENVIRONMENTAL_FULL_BLEED',):
        if st in ('LEFT_COPY', 'RIGHT_COPY'):
            cbox = [b for b in boxes if b.get('w') and b.get('role') not in ('wordmark', 'band_script')]
            x0 = min(b['x'] for b in cbox); x1 = max(b['x'] + b['w'] for b in cbox)
            col_rect = dict(x=x0 - int(0.015 * W), y=0, w=x1 - x0 + int(0.03 * W), h=max(b['y'] + b['h'] for b in cbox) + int(0.03 * H))
            if st == 'LEFT_COPY':
                zx = col_rect['x'] + col_rect['w'] + int(0.01 * W); wall_zone = dict(x=zx, w=W - zx - m // 2)
            else:
                wall_zone = dict(x=m // 2, w=col_rect['x'] - int(0.01 * W) - m // 2)
            spec = dict(spec, _planner_extra=dict(copy_regions=[col_rect], wall_zone=wall_zone, align='right' if st == 'LEFT_COPY' else 'left'))
        merch, plan, placed = _place_scene(img, spec, field, W, H, fr, merch)
        draw = ImageDraw.Draw(img)
    # disclosure (representative scenes only) at the foot of the field
    if spec['copy'].get('disclosure'):
        LY.disclosure(draw, spec['copy']['disclosure'], field['x'], band_top - int(0.032 * H), field['w'], W, H, boxes, align='center')
    # band (+ one script accent) and, for ASYMMETRIC, the CTA on the band
    LY.band(img, draw, W, H, fr, boxes, script=spec.get('band_script'), align='left' if spec.get('copy', {}).get('cta') and st == 'ASYMMETRIC' else 'center')
    if st == 'ASYMMETRIC' and spec['copy'].get('cta'):
        fc = B.font('jost-700', 32 * s)
        tw, _ = B.text_size(fc, spec['copy']['cta'])
        LY.button(img, draw, spec['copy']['cta'], W - m - tw - 70 * s, band_top + (fr['band_h'] - (fc.getbbox('H')[3] - fc.getbbox('H')[1]) - 46 * s) / 2, fc, boxes, reds, pad=(int(35 * s), int(20 * s)))
    # LOGO STAGE — the reserved box is still clear ground; composite the registered asset (never drawn)
    logo_rec = logo_stage.place(img, logo_box, key=opt.get('logo_variant'))
    boxes.append(dict(text='', x=logo_rec['box'][0], y=logo_rec['box'][1], w=logo_rec['box'][2], h=logo_rec['box'][3], role='logo', countable=False,
                      col=[0, W] if st in ('CENTERED', 'TOP_COPY_BOTTOM_SCENE') else [logo_box[0], logo_box[2]]))
    thumb = B.save_png(img, spec['out_png'])
    family = spec.get('coverage_family', 'ACQUISITION')
    m_ = LY.finish(img, spec, boxes, merch, fr, field, logo_rec, reds, family, 'advantage_bid_led',
                   extra=dict(representative=bool(spec['copy'].get('disclosure')), scene_kind=(spec.get('scene') or {}).get('kind'),
                              physical_violations=(plan or {}).get('audit', {}).get('physical', []) if plan else [], screenshot=False))
    drawn_brand_copy = [[b['x'], b['y'], b['w'], b['h']] for b in boxes if b.get('text') and 'advantage.bid' in b['text'].lower() and b.get('role') not in ('logo',)]
    qa = logo_stage.qa(spec['out_png'], logo_rec, band_box=[0, band_top, W, fr['band_h']], extra_allowed_boxes=drawn_brand_copy)
    rec = {k: v for k, v in logo_rec.items() if not k.startswith('_')}
    return dict(ok=True, png=spec['out_png'], thumb=thumb, boxes=boxes, placed=placed, plan=plan, logo=rec, logo_qa=qa, metrics=m_,
                drawn_text=[b['text'] for b in boxes if b.get('text')], field=field, band_h=fr['band_h'])
