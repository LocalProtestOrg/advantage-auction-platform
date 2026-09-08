from compose import *

W, H = 1080, 1350
FOOT = 120                      # standard brand frame: navy band height
BAND_TOP = H - FOOT             # 1230
FLOOR = 1150                    # objects inside the utility line's x-range stop here
BG = dict(bg='radial-gradient(120% 80% at 50% 28%,#ffffff 0%,#faf9f7 55%,#efedea 100%)',
          bg_html=f'<div style="position:absolute;left:0;right:0;bottom:{FOOT}px;height:360px;background:linear-gradient(to top,rgba(24,46,69,.07),rgba(24,46,69,0))"></div>',
          footer=dict(h=FOOT, px=64))

def title_html(px, treatment='red-amp'):
    amp = f'<span style="color:{RED}">&amp;</span>' if treatment in ('red-amp', 'red-amp-italic') else '&amp;'
    home = '<i>Home</i>' if treatment == 'red-amp-italic' else 'Home'
    return f'<div style="font:400 {px}px/0.90 \'Cormorant Garamond\';color:{NAVY};letter-spacing:-2px">Heritage<br>{amp} {home}</div>'

def head(L, title_px, sub_px, title_y=160, treatment='red-amp'):
    L.append(logo((W - 250) // 2, 50, 250))                                                     # 50..108
    L.append(text(f'<span style="font:500 24px/1 Quicksand;letter-spacing:.30em;color:{RED}">ADVANTAGE.BID PRESENTS</span>', 0, 130, w=W, align='center'))
    L.append(text(title_html(title_px, treatment), 0, title_y, w=W, align='center'))
    sub_y = title_y + round(title_px * 0.9 * 2) + 6
    L.append(text(f'<div style="font:italic 400 {sub_px}px/1 \'Cormorant Garamond\';color:{SLATE}">Estate Auction</div>', 0, sub_y, w=W, align='center'))
    return sub_y + sub_px

def reserve(L):
    """event line sits on the white just above the brand band; the destination lives in the band"""
    L.append(text(f'<div style="height:2px;width:64px;background:{RED};margin:0 auto"></div>', 0, 1170, w=W, align='center', z=80))
    L.append(text(f'<div style="font:500 28px/1 Quicksand;color:{NAVY}">Maplewood, Ohio &nbsp;&middot;&nbsp; {{EVENT DATE}} &nbsp;&middot;&nbsp; {{START TIME}}</div>', 0, 1188, w=W, align='center', z=80))

def floor_row(L, herend_x=590, bust_x=740, pheasant_x=480, box_x=190, sphere_x=400, vases_x=20, imari=True, pheasant_z=28):
    L.append(obj('53', vases_x, 1030, 170, z=25, shadow='mid', contact=(0.5, 6, 0.9, 20, .26)))       # vases, far left, may reach the band
    L.append(obj('20', box_x, 978, 230, z=27, shadow='front', contact=(0.5, 6, 0.9, 22, .34)))        # box
    L.append(obj('11d', sphere_x, 1034, 100, z=29, shadow='front', contact=(0.5, 5, 0.8, 12, .34)))   # sphere
    L.append(obj('25', pheasant_x, 973, 110, z=pheasant_z, shadow='mid', contact=(0.5, 4, 0.8, 12, .26)))     # pheasant
    L.append(obj('87', herend_x, 973, 400, z=30, shadow='front'))                                     # Herend
    L.append(obj('78', bust_x, 823, 190, z=25, shadow='front', contact=(0.5, 4, 0.8, 18, .34)))       # bust
    if imari: L.append(obj('30', 892, 1050, 280, z=40, shadow='front'))                               # Imari, crossing the right edge, sitting on the band

def version_a(name='A_owner_refinement', treatment='red-amp'):
    """Title -16% (196 -> 165px). Painting hung high on the left, cropped by the edge; mirror high right with the
    torchiere climbing into it. Chairs unchanged at 700px, raised 65px."""
    L = []; head(L, 165, 66, treatment=treatment); reserve(L)
    L.append(obj('73', -310, 158, 560, z=10, shadow='wall'))                                   # painting high left, cropped by the edge (signature inside)
    L.append(obj('3', 830, 208, 250, z=11, shadow='wall'))                                     # cathedral mirror high right
    L.append(obj('46', 870, 430, 220, z=22, shadow='mid', contact=(0.5, 4, 0.9, 18, .28)))    # torchiere rising from the floor into the mirror
    L.append(obj('31', 230, 583, 700, z=20, shadow='mid', contact=(0.5, 8, 0.96, 44, .30)))   # hero chairs, unchanged size
    L.append(obj('36', 40, 800, 300, z=24, shadow='front', contact=(0.5, 6, 0.8, 30, .32)))   # table, raised
    L.append(obj('63', 112, 736, 150, z=26, shadow='mid', contact=(0.5, 8, 0.9, 14, .26)))    # bowl on table
    floor_row(L)
    return dict(name=name, size=(W, H), layers=L, **BG)

def version_b(name='B_more_vertical', treatment='red-amp'):
    """Title -23% (196 -> 150px). Larger painting and a second work on the left wall; larger mirror and a taller
    torchiere on the right; chairs raised further. Still 700px chairs."""
    L = []; head(L, 150, 60, treatment=treatment); reserve(L)
    L.append(obj('73', -340, 138, 620, z=10, shadow='wall'))                                   # painting, larger, high left
    L.append(obj('74', 26, 600, 246, z=9, shadow='wall'))                                      # Chagall below it - the left wall climbs
    L.append(obj('3', 806, 158, 280, z=11, shadow='wall'))                                     # mirror, larger, high right
    L.append(obj('46', 860, 380, 236, z=22, shadow='mid', contact=(0.5, 4, 0.9, 18, .28)))    # torchiere, taller, flame into the mirror
    L.append(obj('31', 230, 553, 700, z=20, shadow='mid', contact=(0.5, 8, 0.96, 44, .30)))   # chairs raised 95px
    L.append(obj('36', 40, 780, 300, z=24, shadow='front', contact=(0.5, 6, 0.8, 30, .32)))
    L.append(obj('63', 112, 716, 150, z=26, shadow='mid', contact=(0.5, 8, 0.9, 14, .26)))
    floor_row(L)
    return dict(name=name, size=(W, H), layers=L, **BG)

def version_c(name='C_asymmetric_editorial', treatment='red-amp'):
    """Title -16% (165px). The LEFT climbs to the top band: painting high, torchiere rising in front of its lower
    edge. The RIGHT stays modest: Chagall beside the sub-line, mirror standing behind the right chair, table moved right."""
    L = []; head(L, 165, 66, treatment=treatment); reserve(L)
    L.append(obj('73', -350, 148, 600, z=10, shadow='wall'))                                   # painting high left (signature inside the frame)
    L.append(obj('46', 0, 430, 220, z=22, shadow='mid', contact=(0.5, 4, 0.9, 18, .28)))      # torchiere on the LEFT, in front of the painting's lower edge
    L.append(obj('74', 830, 478, 250, z=9, shadow='wall'))                                     # Chagall mid right - the right side rises only this far
    L.append(obj('3', 790, 700, 300, z=12, shadow='back'))                                     # mirror standing behind the right chair
    L.append(obj('31', 230, 583, 700, z=20, shadow='mid', contact=(0.5, 8, 0.96, 44, .30)))   # chairs
    L.append(obj('36', 750, 800, 300, z=24, shadow='front', contact=(0.5, 6, 0.8, 30, .32)))  # table moved to the right
    L.append(obj('63', 822, 736, 150, z=26, shadow='mid', contact=(0.5, 8, 0.9, 14, .26)))    # bowl on it
    floor_row(L, herend_x=470, bust_x=620, pheasant_x=440, box_x=190, sphere_x=350, vases_x=30, pheasant_z=31)
    return dict(name=name, size=(W, H), layers=L, **BG)

if __name__ == '__main__':
    import sys
    which = sys.argv[1:] or ['a', 'b', 'c']
    for w in which:
        comp = {'a': version_a, 'b': version_b, 'c': version_c}[w]()
        p, m = render(comp, comp['name'], 'out2')
        print(json.dumps({k: m[k] for k in ['name', 'objects', 'categories', 'merchandise_pct', 'combined_pct', 'largest_empty_pct', 'overlap_pairs', 'edge_interactions', 'upper_half_merch_pct', 'upper_half_combined_pct', 'objects_reaching_upper_half']}))
