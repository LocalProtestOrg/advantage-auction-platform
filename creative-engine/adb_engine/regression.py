"""Phase 3P.1/3P.2 regression anchors — the six 2026-09-09 proving-ground renders re-measured with the v2 checks.

Each anchor is re-rendered with the UNCHANGED 3P legacy renderer from its recorded spec (regression_anchor mode) and the
PNG hash is compared with the stored render, proving the geometry analysed is exactly what the Owner reviewed. Then the
v2 measures run on that geometry: field-based coverage + void + panel-content, physical audit (placed objects →
taxonomy classes), identity prominence, event-type hierarchy (the legacy subtitle that carries the event type is
labelled event_type for the analysis), colour, and the screenshot-as-hero flag. Node's scorer v2 turns these into the
expected outcomes (WU-A/C regenerate on prominence + event type; WU-B void/hierarchy; IS-A physics; IS-B screenshot +
negative signature; IS-C coverage).
"""
import hashlib, os, re, copy as _copy
import numpy as np
from PIL import Image
from . import config, coverage, prominence, physical_audit, taxonomy
from .families import environmental_photo as ENV, acquisition as ACQ, brand as B

PG = os.path.join(config.REPO, 'docs', 'marketing', 'phase3p', 'proving-grounds', '2026-09-09')
ASSETS = os.path.join(config.ENGINE, 'runtime', 'assets')
LOT_TITLES = {'31': 'Pair of red wingback chairs', '46': 'French bronze torchiere', '36': 'Mahogany pie crust table', '53': 'Pair of Chinese porcelain vases',
              '63': 'Sterling silver bowl', '87': 'Herend dinnerware set', '3': 'Cathedral three panel mirror'}
WU_COPY = dict(presenter='Lewis & Maese', relationship='in conjunction with Advantage.Bid', title='West University', subtitle='Exclusive On-Site Estate Sale',
               date='Saturday, September 19', time='9:00 AM – 3:00 PM · One day only', place_plate='West University Area · Houston, TX')
IS_HELP = 'Real people help along the way. Call (551) 655-7050.'
DISC = 'Representative items shown — not auction lots'


def _photos():
    d = os.path.join(PG, 'assets')
    names = sorted(f for f in os.listdir(d) if re.match(r'^IMG_0(520|522|526-1|529|546|549|550|552)', f))
    return [os.path.join(d, n) for n in names]


def _rep(lot, w, cx, z, role):
    return dict(path=os.path.join(ASSETS, 'lot%s.webp' % lot), w=w, cx=cx, z=z, role=role, shadow=0.22)


def anchors():
    ph = _photos(); pick = lambda n: ph[n % len(ph)]
    cluster = [_rep('31', 860, 0.60, 40, 'anchor'), _rep('46', 270, 0.09, 30, 'tall'), _rep('36', 470, 0.27, 45, 'surface'), _rep('53', 260, 0.90, 60, 'foreground'), _rep('63', 300, 0.44, 70, 'foreground')]
    shot = os.path.join(PG, 'assets', 'create-auction-screenshot.png')
    return [
        dict(key='WU-A', job='p3p-west-university', cand='A', family='ENVIRONMENTAL_PHOTO', cov_family='ENVIRONMENTAL_PHOTO', context='seller_led_cobranded', spec=dict(variant='banded', photo_path=pick(0), copy=WU_COPY, options={})),
        dict(key='WU-B', job='p3p-west-university', cand='B', family='ENVIRONMENTAL_PHOTO', cov_family='ENVIRONMENTAL_PHOTO', context='seller_led_cobranded', spec=dict(variant='panel', photo_path=pick(2), copy=WU_COPY, options=dict(panel_side='right'))),
        dict(key='WU-C', job='p3p-west-university', cand='C', family='ENVIRONMENTAL_PHOTO', cov_family='ENVIRONMENTAL_PHOTO', context='seller_led_cobranded', spec=dict(variant='banded', photo_path=pick(1), copy=WU_COPY, options=dict(title_scale=1.15, photo_share=1.15, extreme_label=True))),
        dict(key='IS-A', job='p3p-individual-seller', cand='A', family='ACQUISITION', cov_family='ACQUISITION', context='advantage_bid_led', spec=dict(concept='A', copy=dict(primary="It's built to be easy.", support='Create your own online auction on Advantage.Bid.', help=IS_HELP, disclosure=DISC), objects=cluster, screenshot_path=None)),
        dict(key='IS-B', job='p3p-individual-seller', cand='B', family='ACQUISITION', cov_family='ACQUISITION', context='advantage_bid_led', spec=dict(concept='B', copy=dict(primary='You can do this.', support='Describe your sale, then add your items — one screen at a time.', help=IS_HELP, disclosure=DISC), objects=[_rep('36', 430, 0.15, 45, 'surface'), _rep('63', 260, 0.32, 70, 'foreground')], screenshot_path=shot)),
        dict(key='IS-C', job='p3p-individual-seller', cand='C', family='ACQUISITION', cov_family='ACQUISITION', context='advantage_bid_led', spec=dict(concept='C', copy=dict(primary='Help is here.', support='Real people help you create and run your own online auction.', help="It's built to be easy — and you are never on your own.", contact='(551) 655-7050 · info@advantage.bid', disclosure=DISC), objects=[_rep('31', 1100, 0.55, 40, 'anchor'), _rep('46', 360, 0.12, 30, 'tall'), _rep('87', 560, 0.40, 60, 'foreground')], screenshot_path=None)),
    ]


def _sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def _merch_from_render(res, W, H):
    """Rebuild the merchandise/photograph mask from the legacy result (photo band or placed objects)."""
    m = np.zeros((H, W), bool)
    for p in res.get('placed') or []:
        if p.get('asset') and os.path.exists(os.path.join(ASSETS, p['asset'])):
            im = Image.open(os.path.join(ASSETS, p['asset'])).convert('RGBA').resize((max(1, p['w']), max(1, p['h'])), Image.LANCZOS)
            a = np.asarray(im)[..., 3] > 64
            x, y = p['x'], p['y']; x0, y0 = max(0, x), max(0, y); x1, y1 = min(W, x + p['w']), min(H, y + p['h'])
            if x1 > x0 and y1 > y0: m[y0:y1, x0:x1] |= a[y0 - y:y1 - y, x0 - x:x1 - x]
    pb = res.get('photo_box') or (res.get('metrics') or {}).get('photo_box')
    if pb: m[pb['y']:pb['y'] + pb['h'], pb['x']:pb['x'] + pb['w']] = True
    sc = res.get('screenshot')
    if sc: m[sc['y']:sc['y'] + sc['h'], sc['x']:sc['x'] + sc['w']] = True
    return m


def analyse(req=None):
    out_dir = (req or {}).get('out_dir') or os.path.join(config.ENGINE, 'runtime', 'cache', 'regression')
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for a in anchors():
        for fmt in ('portrait_1080x1350', 'square_1080x1080'):
            spec = _copy.deepcopy(a['spec']); spec['format'] = fmt; spec['regression_anchor'] = True
            name = '%s-%s-%s.png' % (a['job'], a['cand'], fmt)
            spec['out_png'] = os.path.join(out_dir, name)
            mod = ENV if a['family'] == 'ENVIRONMENTAL_PHOTO' else ACQ
            res = mod.render(spec)
            stored = os.path.join(PG, name)
            identical = os.path.exists(stored) and _sha(stored) == _sha(spec['out_png'])
            W, H = B.FORMATS[fmt]
            img = Image.open(spec['out_png']).convert('RGBA')
            boxes = [dict(b) for b in res['boxes']]
            # analysis labels: the legacy subtitle carries the event type; the place-name title is the event title
            for b in boxes:
                if a['family'] == 'ENVIRONMENTAL_PHOTO' and b.get('role') == 'title':
                    b['role'] = 'event_type' if 'Estate Sale' in b.get('text', '') else 'event_title'
                if a['family'] == 'ACQUISITION' and b.get('role') == 'title': b['role'] = 'headline'
            band_h = int(round(120 * H / 1350.0))
            merch = _merch_from_render(res, W, H)
            if a['family'] == 'ENVIRONMENTAL_PHOTO':
                # photograph pixels: everything that is not ground/text/band in the content area (the photo is a solid block)
                arr = np.asarray(img.convert('RGB')).astype(int)
                ground = np.array(B.VERY_LIGHT)
                nonground = np.abs(arr - ground).sum(axis=2) > 30
                tx = np.zeros((H, W), bool)
                for b in boxes:
                    if b.get('w'): tx[max(0, b['y']):b['y'] + b['h'], max(0, b['x']):b['x'] + b['w']] = True
                merch = nonground & ~tx
                merch[H - band_h:] = False
            from .families.layout import copy_regions
            regions = copy_regions([b for b in boxes if b.get('role') not in ('extreme_label',)], W=W)
            panels = []
            if a['spec'].get('variant') == 'panel':
                pw = int(W * 0.46); px = W - pw if a['spec']['options'].get('panel_side') == 'right' else 0
                panels.append(dict(role='information panel', x=px, y=0, w=pw, h=H - band_h, content=[b for b in boxes if b.get('w') and b.get('role') not in ('wordmark',) and px <= b['x'] < px + pw]))
            if a['key'] == 'IS-C':
                cb = [b for b in boxes if b.get('role') in ('contact', 'help')]
                if cb:
                    px0 = int(40 * H / 1350.0); pw = int(W * 0.46); py0 = min(b['y'] for b in cb) - int(46 * H / 1350.0)
                    ph = (H - band_h - int(150 * H / 1350.0)) - py0 - int(10 * H / 1350.0)
                    panels.append(dict(role='contact card', x=px0, y=py0, w=pw, h=ph, content=cb))
            cov = coverage.measure((W, H), dict(x=0, y=0, w=W, h=H - band_h), merch, text_boxes=[b for b in boxes if b.get('w') and b.get('role') != 'wordmark'],
                                   band_h=band_h, panels=panels, exclude=regions)
            gate = coverage.gate(a['cov_family'], cov)
            logo_box = next((b for b in boxes if b.get('role') == 'logo'), None)
            logo = dict(box=[logo_box['x'], logo_box['y'], logo_box['w'], logo_box['h']], variant='primary_transparent', _ground=None) if logo_box else None
            prom = prominence.identity(img, boxes, logo, a['context'], band_h)
            et = prominence.event_type(boxes, H, required=a['family'] == 'ENVIRONMENTAL_PHOTO')
            col = prominence.colour(img, [b for b in boxes if b.get('role') != 'extreme_label'], band_h, regions, merch_mask=merch,
                                    red_elements=[b for b in boxes if b.get('role') in ('accent_rule',)])
            phys = None
            if res.get('placed'):
                layers = []
                for i, p in enumerate(res['placed']):
                    lot = re.sub(r'^lot|\.webp$', '', p['asset'])
                    rec = taxonomy.resolve(LOT_TITLES.get(lot, lot))
                    layers.append(dict(id='lot' + lot, asset=os.path.join(ASSETS, p['asset']), semantic_class=rec['semantic_class'], x=p['x'], y=p['y'], w=p['w'], h=p['h'], z=i,
                                       protected=[]))
                from .scene_planner import _annotations
                ann = _annotations()
                for l in layers:
                    pr = ann.get(os.path.basename(l['asset']), {}).get('protected')
                    if pr: l['protected'] = pr
                phys = physical_audit.audit(dict(size=[W, H], layers=layers))
            m = res.get('metrics') or {}
            results.append(dict(key=a['key'], job=a['job'], candidate=a['cand'], format=fmt, render_identical_to_stored=identical, stored_png=stored,
                                family=a['family'], coverage=cov, coverage_gate=dict(pass_=gate['pass_'], hard_failures=gate['hard_failures'], soft=gate['soft']),
                                prominence=prom, event_type=et, colour=col, physical=phys, screenshot_hero=bool(m.get('screenshot')),
                                hierarchy_ratio=m.get('hierarchy_ratio'), text_blocks=m.get('text_blocks'),
                                drawn=[dict(text=b.get('text'), role=b.get('role')) for b in boxes if b.get('text')]))
    return dict(ok=True, anchors=results)
