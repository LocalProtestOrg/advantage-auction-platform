from compose import *
from comp_refine import W, H, FOOT, BG, head, reserve

def title_treatment(t):
    """Heritage & Home typography. 'red-amp' = current; 'italic-home' = formal Heritage + editorial italic Home;
    'italic-home-navy' = same with the ampersand in navy. One family (Cormorant Garamond) throughout."""
    return {'red-amp': 'red-amp', 'italic-home': 'red-amp-italic', 'italic-home-navy': 'italic-navy'}[t]

def spatial_b(name, treatment='red-amp', creative=False):
    """Phase 3M.2 Version B with spatial roles made explicit and grounding refined.
    creative=True adds the B3 creative-director decision: surface objects go on the surface, the top lot takes the foreground centre."""
    L = []
    if treatment == 'italic-navy':
        # head() only knows the shared treatments; build the navy-ampersand italic title here
        L.append(logo((W - 250) // 2, 50, 250))
        L.append(text(f'<span style="font:500 24px/1 Quicksand;letter-spacing:.30em;color:{RED}">ADVANTAGE.BID PRESENTS</span>', 0, 130, w=W, align='center'))
        L.append(text(f'<div style="font:400 150px/0.90 \'Cormorant Garamond\';color:{NAVY};letter-spacing:-2px">Heritage<br>&amp; <i>Home</i></div>', 0, 160, w=W, align='center'))
        L.append(text(f'<div style="font:italic 400 60px/1 \'Cormorant Garamond\';color:{SLATE}">Estate Auction</div>', 0, 160 + round(150 * 0.9 * 2) + 6, w=W, align='center'))
    else:
        head(L, 150, 60, treatment=treatment)
    reserve(L)
    # ---- BACKGROUND / WALL: hung high, no contact shadows, nothing in front of them but merchandise ----
    L.append(obj('73', -340, 138, 620, z=10, shadow='wall', role='WALL', plane='BACKGROUND'))          # painting, high left, edge-cropped, signature in frame
    L.append(obj('74', 26, 560, 246, z=9, shadow='wall', role='WALL', plane='BACKGROUND'))              # Chagall, lower on the same wall, clear of the bowl
    L.append(obj('3', 806, 158, 280, z=11, shadow='wall', role='WALL', plane='BACKGROUND'))            # mirror, high right
    # ---- MIDGROUND / HERO + TALL: grounded, contact shadows, perspective-consistent baselines ----
    L.append(obj('46', 880, 377, 200, z=15, shadow='back', role='TALL', plane='MIDGROUND',
                 contact=(0.5, 4, 0.9, 16, .22)))                                                          # torchiere BEHIND the right chair, base at 1050, flame into the mirror
    L.append(obj('31', 230, 553, 700, z=20, shadow='mid', role='HERO', plane='MIDGROUND', contact=(0.5, 8, 0.96, 44, .30)))   # chairs, baseline 1062
    L.append(obj('36', 40, 780, 300, z=24, shadow='front', role='HERO', plane='MIDGROUND', contact=(0.5, 6, 0.8, 30, .32)))  # table, baseline 1143 (nearer than chairs)
    L.append(obj('63', 112, 716, 150, z=26, shadow='mid', role='SURFACE', plane='MIDGROUND', support='36', contact=(0.5, 8, 0.9, 14, .26)))  # bowl on the table
    if creative:
        L.append(obj('25', 236, 668, 100, z=27, shadow='mid', role='SURFACE', plane='MIDGROUND', support='36', contact=(0.5, 4, 0.8, 12, .26)))  # pheasant joins the bowl on the table
    # ---- FOREGROUND: small merchandise, lowest baselines, may overlap anything behind ----
    L.append(obj('53', 20, 1030, 170, z=25, shadow='mid', role='FOREGROUND', plane='FOREGROUND', contact=(0.5, 6, 0.9, 20, .26)))
    L.append(obj('20', 190, 978, 230, z=27, shadow='front', role='FOREGROUND', plane='FOREGROUND', contact=(0.5, 6, 0.9, 22, .34)))
    L.append(obj('11d', 430 if creative else 400, 1034, 100, z=29, shadow='front', role='FOREGROUND', plane='FOREGROUND', contact=(0.5, 5, 0.8, 12, .34)))
    if not creative:
        L.append(obj('25', 480, 973, 110, z=28, shadow='mid', role='FOREGROUND', plane='FOREGROUND', contact=(0.5, 4, 0.8, 12, .26)))
    if creative:
        L.append(obj('87', 560, 950, 460, z=30, shadow='front', role='FOREGROUND', plane='FOREGROUND'))       # top lot, larger, foreground centre
    else:
        L.append(obj('87', 590, 973, 400, z=30, shadow='front', role='FOREGROUND', plane='FOREGROUND'))
    L.append(obj('78', 740, 823, 190, z=25, shadow='front', role='FOREGROUND', plane='FOREGROUND', contact=(0.5, 4, 0.8, 18, .34)))
    L.append(obj('30', 892, 1050, 280, z=40, shadow='front', role='FOREGROUND', plane='FOREGROUND'))
    return dict(name=name, size=(W, H), layers=L, **BG)

VERSIONS = {
    'b1': lambda: spatial_b('B1_spatial_B', 'red-amp'),
    'b2': lambda: spatial_b('B2_spatial_B_italic_home', 'red-amp-italic'),
    'b3': lambda: spatial_b('B3_creative_director_B', 'red-amp-italic', creative=True),
}

if __name__ == '__main__':
    import sys
    from spatial import audit
    for w in (sys.argv[1:] or ['b1', 'b2', 'b3']):
        comp = VERSIONS[w]()
        p, m = render(comp, comp['name'], 'out3')
        rows, summ = audit(comp)
        json.dump(dict(rows=rows, summary=summ), open(f'out3/{comp["name"]}_audit.json', 'w'), indent=1)
        print(comp['name'], json.dumps({k: m[k] for k in ['objects', 'merchandise_pct', 'combined_pct', 'largest_empty_pct', 'overlap_pairs', 'edge_interactions', 'upper_half_merch_pct']}))
        print('   ', json.dumps(summ))
        for r in rows:
            if any(':' in c and c.split(':')[0].isupper() for c in r['checks']): print('    !!', r['lot'], r['checks'])
