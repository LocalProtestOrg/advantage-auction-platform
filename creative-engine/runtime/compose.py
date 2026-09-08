"""Phase 3M.1 composition engine.
A composition = canvas + background + object layers + text blocks.
Objects are the Phase 3M extracted WebPs (alpha only ever removed, never RGB-edited).
Renders at native size with Playwright; measures text boxes in-browser; computes
occupancy metrics from real alpha masks.
"""
import os, json, glob, re, asyncio, base64
from PIL import Image
import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, 'assets')
INV = json.load(open(os.path.join(ASSETS, 'inventory.json')))
NAVY = '#182e45'; RED = '#d62828'; SLATE = '#4a5b70'; MUTE = '#7b8a9c'

# ---------- fonts (local, from the npm Fontsource packages) ----------
def font_css():
    base = os.environ.get('ADB_FONTSOURCE_DIR') or os.path.join(ROOT, 'fonts', 'node_modules', '@fontsource')  # HANDOFF PATCH: was an absolute container path
    fams = {'cormorant-garamond': 'Cormorant Garamond', 'jost': 'Jost', 'quicksand': 'Quicksand',
            'playfair-display': 'Playfair Display', 'lato': 'Lato'}
    out = []
    for slug, fam in fams.items():
        for f in sorted(glob.glob(f'{base}/{slug}/files/{slug}-latin-*-*.woff2')):
            m = re.search(r'-latin-(\d+)-(normal|italic)\.woff2$', f)
            if not m: continue
            out.append(f"@font-face{{font-family:'{fam}';font-style:{m.group(2)};font-weight:{m.group(1)};font-display:block;src:url('file://{f}') format('woff2')}}")
    return '\n'.join(out)

def b64(path):
    return 'data:image/webp;base64,' + base64.b64encode(open(path, 'rb').read()).decode()

# ---------- layers ----------
def obj(lot, x, y, w, z, shadow='mid', contact=None, h=None, opacity=1.0, flip=False, role=None, plane=None, support=None):
    """x,y = top-left in canvas px; w = rendered width; h derived from aspect unless given.
    shadow: 'wall' (hung art, subtle separation) | 'back' | 'mid' | 'front' | 'none'
    contact: None or (cx_frac, cy_px_from_bottom, w_frac, h_px, opacity) -> soft floor ellipse"""
    inv = INV[lot]
    assert inv['status'] == 'CLEAN', f'lot {lot} is {inv["status"]} - not allowed in creative'
    if h is None: h = round(w * inv['h'] / inv['w'])
    return dict(kind='obj', lot=lot, x=x, y=y, w=w, h=h, z=z, shadow=shadow, contact=contact, opacity=opacity, flip=flip, role=role, plane=plane, support=support)

SHADOWS = {  # calibrated for a white/very light ground: softer and lower opacity than the navy set
    'wall':  'drop-shadow(0 4px 6px rgba(24,46,69,.10)) drop-shadow(0 14px 22px rgba(24,46,69,.10))',
    'back':  'drop-shadow(0 6px 10px rgba(24,46,69,.16))',
    'mid':   'drop-shadow(0 10px 16px rgba(24,46,69,.22))',
    'front': 'drop-shadow(0 16px 24px rgba(24,46,69,.28))',
    'none':  'none',
}

def contact_html(L):
    if not L.get('contact'): return ''
    cxf, cyb, wf, hpx, op = L['contact']
    cw = L['w'] * wf; cx = L['x'] + L['w'] * cxf - cw / 2
    cy = L['y'] + L['h'] - cyb - hpx / 2
    return (f'<div style="position:absolute;left:{cx:.0f}px;top:{cy:.0f}px;width:{cw:.0f}px;height:{hpx}px;z-index:{L["z"]-1};'
            f'background:radial-gradient(ellipse at 50% 50%,rgba(24,46,69,{op}) 0%,rgba(24,46,69,{op*0.45:.3f}) 38%,rgba(24,46,69,0) 72%);filter:blur(4px)"></div>')

def obj_html(L):
    src = b64(os.path.join(ASSETS, f'lot{L["lot"]}.webp'))
    flip = 'transform:scaleX(-1);' if L.get('flip') else ''
    return (contact_html(L) +
            f'<div class="oi" data-lot="{L["lot"]}" style="position:absolute;left:{L["x"]}px;top:{L["y"]}px;width:{L["w"]}px;height:{L["h"]}px;'
            f'z-index:{L["z"]};opacity:{L["opacity"]};filter:{SHADOWS[L["shadow"]]};{flip}background-image:url({src})"></div>')

def text(html, x, y, z=50, w=None, align='left', extra=''):
    ws = f'width:{w}px;' if w else ''
    return dict(kind='text', html=f'<div class="tx" style="position:absolute;left:{x}px;top:{y}px;{ws}text-align:{align};z-index:{z};{extra}">{html}</div>')

def logo(x, y, w, z=60):
    src = b64(os.path.join(ASSETS, 'logo.webp'))
    h = round(w * 128 / 555)
    return dict(kind='logo', x=x, y=y, w=w, h=h,
                html=f'<div class="tx logo" style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;z-index:{z};background:url({src}) no-repeat center/contain"></div>')

def banner(label, W, H, top=False):
    pos = 'top:0' if top else 'bottom:0'
    return (f'<div style="position:absolute;left:0;right:0;{pos};height:26px;background:rgba(24,46,69,.86);color:#fff;'
            f'font:600 11px/26px Quicksand,system-ui,sans-serif;letter-spacing:.14em;text-align:center;z-index:9000">{label}</div>')

def footer_html(comp):
    """Standard brand frame: dark navy band across the bottom, white Advantage.Bid centred. Objects sit behind it."""
    f = comp.get('footer')
    if not f: return ''
    h = f.get('h', 120); px = f.get('px', 64)
    return (f'<div style="position:absolute;left:0;right:0;bottom:0;height:{h}px;background:{NAVY};z-index:90;display:flex;align-items:center;justify-content:center">'
            f'<div class="tx" style="font:600 {px}px/1 Quicksand;color:#fff;letter-spacing:-.01em">Advantage.Bid</div></div>')

def build_html(comp):
    W, H = comp['size']
    layers = ''.join(obj_html(L) if L['kind'] == 'obj' else L['html'] for L in sorted(comp['layers'], key=lambda L: L.get('z', 50)))
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{font_css()}
html,body{{margin:0;padding:0;background:#888}}
.cv{{position:relative;width:{W}px;height:{H}px;overflow:hidden;background:{comp.get('bg', '#fff')}}}
.oi{{background-repeat:no-repeat;background-size:100% 100%;background-position:center}}
.tx{{white-space:nowrap}}
</style></head><body><div class="cv" id="cv">{comp.get('bg_html', '')}{layers}{footer_html(comp)}{banner(comp.get('label', 'DEMO / CREATIVE CALIBRATION &mdash; NOT FOR PUBLICATION'), W, H, top=bool(comp.get('footer')))}</div></body></html>'''

# ---------- render ----------
async def _render(html_path, png_path, W, H, thumb_path=None, thumb_w=281):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': W + 40, 'height': H + 40}, device_scale_factor=1)
        await pg.goto('file://' + html_path, wait_until='load')
        await pg.evaluate("document.fonts.ready.then(()=>true)")
        await pg.wait_for_timeout(600)
        el = await pg.query_selector('#cv')
        await el.screenshot(path=png_path)
        boxes = await pg.evaluate("""()=>{const r=document.getElementById('cv').getBoundingClientRect();
          return Array.from(document.querySelectorAll('.tx')).map(e=>{let b;
            if(e.classList.contains('logo')){b=e.getBoundingClientRect();}
            else{const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let n,x0=1e9,y0=1e9,x1=-1e9,y1=-1e9,any=false;
                 while((n=w.nextNode())){if(!n.textContent.trim())continue;const rg=document.createRange();rg.selectNodeContents(n);
                   for(const rc of rg.getClientRects()){if(rc.width===0)continue;any=true;x0=Math.min(x0,rc.left);y0=Math.min(y0,rc.top);x1=Math.max(x1,rc.right);y1=Math.max(y1,rc.bottom);}}
                 b=any?{left:x0,top:y0,width:x1-x0,height:y1-y0}:e.getBoundingClientRect();
                 if(!any){const eb=e.getBoundingClientRect();b={left:eb.left,top:eb.top,width:eb.width,height:eb.height};}}
          return {x:b.left-r.left,y:b.top-r.top,w:b.width,h:b.height,logo:e.classList.contains('logo'),text:(e.innerText||'').slice(0,40)}})}""")
        await b.close()
    if thumb_path:
        im = Image.open(png_path); im.resize((thumb_w, round(thumb_w * H / W)), Image.LANCZOS).save(thumb_path)
    return boxes

def render(comp, name, outdir):
    outdir = os.path.abspath(outdir); os.makedirs(outdir, exist_ok=True)
    W, H = comp['size']
    html_path = os.path.join(outdir, name + '.html'); png_path = os.path.join(outdir, name + '.png')
    open(html_path, 'w').write(build_html(comp))
    boxes = asyncio.run(_render(html_path, png_path, W, H, os.path.join(outdir, name + '_thumb.png')))
    m = metrics(comp, boxes)
    json.dump(m, open(os.path.join(outdir, name + '_metrics.json'), 'w'), indent=1)
    return png_path, m

# ---------- metrics (calibration only, not rules) ----------
def _mask(L, W, H):
    im = Image.open(os.path.join(ASSETS, f'lot{L["lot"]}.webp')).convert('RGBA').resize((max(1, L['w']), max(1, L['h'])), Image.BILINEAR)
    a = np.array(im)[..., 3] > 64
    if L.get('flip'): a = a[:, ::-1]
    full = np.zeros((H, W), bool)
    x0, y0 = L['x'], L['y']; x1, y1 = x0 + a.shape[1], y0 + a.shape[0]
    sx0, sy0 = max(0, -x0), max(0, -y0); dx0, dy0 = max(0, x0), max(0, y0)
    dx1, dy1 = min(W, x1), min(H, y1)
    if dx1 > dx0 and dy1 > dy0:
        full[dy0:dy1, dx0:dx1] = a[sy0:sy0 + (dy1 - dy0), sx0:sx0 + (dx1 - dx0)]
    return full, (x0 < 0 or y0 < 0 or x1 > W or y1 > H - 26)

def _largest_empty_rect(occ, cell=20):
    """largest axis-aligned empty rectangle on a coarse grid, as % of canvas"""
    H, W = occ.shape
    H2, W2 = (H // cell) * cell, (W // cell) * cell
    occ = occ[:H2, :W2]
    g = occ.reshape(H2 // cell, cell, W2 // cell, cell).any(axis=(1, 3))
    rows, cols = g.shape; best = 0
    hist = [0] * cols
    for r in range(rows):
        for c in range(cols): hist[c] = 0 if g[r, c] else hist[c] + 1
        stack = []
        for c in range(cols + 1):
            cur = hist[c] if c < cols else 0
            start = c
            while stack and stack[-1][1] >= cur:
                s, h = stack.pop(); best = max(best, h * (c - s)); start = s
            stack.append((start, cur))
    return 100 * best * cell * cell / (W * H)

def metrics(comp, boxes):
    W, H = comp['size']; Hc = H - 26  # exclude the calibration banner
    fh = (comp.get('footer') or {}).get('h', 0)
    objs = [L for L in comp['layers'] if L['kind'] == 'obj']
    masks = []; edge = 0
    for L in objs:
        m, e = _mask(L, W, H); masks.append(m); edge += int(e)
    merch = np.zeros((H, W), bool)
    for m in masks: merch |= m
    tx = np.zeros((H, W), bool)
    for b in boxes:
        x0, y0 = max(0, int(b['x'])), max(0, int(b['y'])); x1, y1 = min(W, int(b['x'] + b['w'])), min(H, int(b['y'] + b['h']))
        if x1 > x0 and y1 > y0: tx[y0:y1, x0:x1] = True
    overlaps = 0
    for i in range(len(masks)):
        for j in range(i + 1, len(masks)):
            if (masks[i] & masks[j]).sum() > 400: overlaps += 1
    if fh: tx[H - fh:, :] = True          # the brand band is occupied by design
    occ = (merch | tx)[:Hc]
    anchors = sum(1 for L in objs if L['w'] >= 0.40 * W or L['h'] >= 0.40 * Hc)
    half = H // 2
    rising = []
    for L, m in zip(objs, masks):
        ys = np.where(m.any(axis=1))[0]
        if len(ys) and ys.min() < half: rising.append([L['lot'], INV[L['lot']]['name'], int(ys.min())])
    rising.sort(key=lambda r: r[2])
    return dict(name=comp.get('name'), size=[W, H], objects=len(objs),
                categories=len({INV[L['lot']]['cat'] for L in objs}),
                text_region_pct=round(100 * tx[:Hc].mean(), 1),
                merchandise_pct=round(100 * merch[:Hc].mean(), 1),
                combined_pct=round(100 * occ.mean(), 1),
                largest_empty_pct=round(_largest_empty_rect(occ), 1),
                overlap_pairs=overlaps, edge_interactions=edge, anchors=anchors,
                upper_half_merch_pct=round(100 * merch[:half].mean(), 1),
                upper_half_combined_pct=round(100 * (merch | tx)[:half].mean(), 1),
                lower_half_merch_pct=round(100 * merch[half:Hc].mean(), 1),
                objects_reaching_upper_half=rising,
                lots=[L['lot'] for L in objs])
