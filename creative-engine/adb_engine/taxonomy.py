"""Phase 3P.1 Mission 4 — semantic object taxonomy (port of docs/marketing/phase3p1/config/object-taxonomy.json).

resolve(title, category_key=None, dims_in=None) -> {semantic_class, confidence, dims_source, resolved_by, record}
Resolution order: explicit semantic_class → title keyword rules → category_key fallback → generic-by-size (unresolved).
Nothing is inferred from imagery here; an unresolved class that would anchor a scene is an Owner-review flag.
"""
import re
from . import config

# Keyword rules (most specific first). Words are matched on word boundaries in the lower-cased title.
KEYWORDS = [
    ('wingback_chair', ['wingback', 'wing back', 'wing chair']),
    ('torchiere', ['torchiere', 'torchère']),
    ('floor_lamp', ['floor lamp', 'standing lamp']),
    ('table_lamp', ['table lamp', 'desk lamp', 'boudoir lamp', 'lamp']),
    ('chandelier', ['chandelier']),
    ('candelabra', ['candelabra', 'candelabrum', 'candlestick']),
    ('loveseat', ['loveseat', 'love seat', 'settee']),
    ('sofa', ['sofa', 'couch', 'chesterfield', 'davenport']),
    ('armchair', ['armchair', 'arm chair', 'club chair', 'bergere', 'fauteuil', 'lounge chair']),
    ('dining_chair', ['dining chair', 'dining chairs']),
    ('side_chair', ['side chair', 'accent chair', 'chair']),
    ('bench', ['bench', 'ottoman', 'footstool']),
    ('coffee_table', ['coffee table', 'cocktail table']),
    ('console_table', ['console', 'sofa table', 'hall table', 'server', 'sideboard', 'buffet']),
    ('dining_table', ['dining table', 'banquet table', 'drop leaf table', 'drop-leaf table']),
    ('side_table', ['side table', 'end table', 'pie crust table', 'piecrust', 'tilt top', 'tilt-top', 'lamp table', 'accent table', 'nightstand', 'night stand', 'candle stand', 'stand']),
    ('desk', ['desk', 'secretary', 'writing table', 'bureau plat']),
    ('cabinet', ['cabinet', 'breakfront', 'china cabinet', 'curio', 'armoire', 'hutch', 'vitrine', 'credenza']),
    ('chest_of_drawers', ['chest of drawers', 'dresser', 'commode', 'highboy', 'lowboy', 'bureau']),
    ('bookcase', ['bookcase', 'etagere', 'étagère', 'shelving unit']),
    ('bed', ['bed', 'headboard', 'daybed']),
    ('floor_vase', ['floor vase', 'palace vase']),
    ('urn', ['urn', 'jardiniere', 'jardinière', 'planter']),
    ('vase', ['vase', 'vases', 'jar', 'ginger jar', 'amphora', 'ewer']),
    ('bowl', ['bowl', 'centerpiece', 'centrepiece', 'compote', 'tazza']),
    ('silver_group', ['silver', 'sterling', 'tea set', 'tea service', 'coffee service', 'pitcher', 'flatware']),
    ('china_group', ['china', 'dinnerware', 'porcelain service', 'plates', 'imari', 'dinner service', 'stemware', 'glassware', 'crystal']),
    ('figurine', ['figurine', 'figure', 'boehm', 'lladro', 'hummel', 'netsuke', 'statuette']),
    ('clock_tall', ['tall case clock', 'grandfather clock', 'longcase', 'grandmother clock']),
    ('clock_mantel', ['mantel clock', 'bracket clock', 'clock']),
    ('book_stack', ['book', 'books', 'volumes', 'encyclopedia']),
    ('tray', ['tray', 'salver']),
    ('bust', ['bust']),
    ('sculpture_large', ['life size', 'life-size', 'monumental', 'garden statue']),
    ('sculpture_small', ['sculpture', 'bronze', 'statue', 'carving', 'mineral', 'apophyllite', 'quartz', 'geode', 'sphere']),
    ('pedestal', ['pedestal', 'plinth', 'column stand']),
    ('mirror', ['mirror', 'looking glass', 'pier glass']),
    ('print', ['lithograph', 'etching', 'print', 'engraving', 'serigraph', 'giclee', 'poster', 'work on paper', 'works on paper', 'drawing', 'watercolor', 'watercolour']),
    ('painting', ['painting', 'oil on canvas', 'oil on board', 'oil', 'acrylic', 'canvas', 'portrait', 'landscape']),
    ('wall_shelf', ['wall shelf', 'wall bracket', 'hanging shelf']),
    ('rug', ['rug', 'carpet', 'kilim', 'runner', 'dhurrie']),
    ('tool_chest', ['tool chest', 'toolbox', 'tool box', 'rolling cabinet']),
    ('power_tool', ['drill', 'saw', 'grinder', 'compressor', 'power tool']),
    ('hand_tools_group', ['hand tools', 'wrench', 'wrenches', 'tools']),
    ('tractor', ['tractor', 'mower', 'skid steer', 'excavator', 'backhoe']),
    ('vehicle', ['car', 'truck', 'vehicle', 'automobile', 'pickup', 'motorcycle', 'boat', 'trailer']),
    ('bicycle', ['bicycle', 'bike']),
    ('outdoor_furniture', ['patio', 'outdoor', 'garden bench', 'adirondack', 'wrought iron set']),
    ('watch', ['watch', 'wristwatch', 'rolex', 'omega', 'pocket watch', 'mido']),
    ('jewelry', ['ring', 'necklace', 'bracelet', 'earring', 'earrings', 'brooch', 'pendant', 'jewelry', 'jewellery', 'diamond', 'pearls']),
    ('coin', ['coin', 'coins', 'bullion', 'medal', 'token']),
    ('taxidermy_mount', ['taxidermy', 'mount', 'trophy head', 'antlers']),
    ('musical_instrument', ['guitar', 'violin', 'piano', 'banjo', 'trumpet', 'saxophone', 'drum', 'cello']),
    ('arcade_cabinet', ['arcade', 'pinball', 'jukebox', 'slot machine']),
]

# Category-key fallbacks (lots.category_key vocabulary) when no title keyword matches.
CATEGORY_FALLBACK = {
    'furniture': None, 'lighting': 'table_lamp', 'art': 'painting', 'fine_art': 'painting', 'works_on_paper': 'print', 'prints': 'print',
    'jewelry': 'jewelry', 'watches': 'watch', 'coins': 'coin', 'silver': 'silver_group', 'china': 'china_group', 'porcelain': 'figurine',
    'glass': 'vase', 'rugs': 'rug', 'tools': 'hand_tools_group', 'vehicles': 'vehicle', 'clocks': 'clock_mantel', 'books': 'book_stack',
    'sculpture': 'sculpture_small', 'minerals': 'sculpture_small', 'decor': 'vase', 'collectibles': 'figurine',
}


# Shorthand used inside the taxonomy's support lists → canonical class (resolution only; the config is not edited).
ALIASES = {'small_sculpture': 'sculpture_small', 'centrepiece': 'bowl', 'centerpiece': 'bowl', 'silver': 'silver_group'}
# Support tokens that name a surface or plane rather than an object class.
NON_CLASS_TOKENS = {'cushion', 'throw', 'small_decor', 'small_decor_on_seat', 'floor', 'mantel', 'workbench', 'stand', 'shelf', 'plant', 'books'}


def canonical(ref):
    return ALIASES.get(ref, ref)


def _match(title):
    t = ' ' + re.sub(r'[^a-z0-9éè\- ]+', ' ', str(title or '').lower()) + ' '
    for cls, words in KEYWORDS:
        for w in words:
            if re.search(r'(?<![a-z])' + re.escape(w) + r'(?![a-z])', t):
                return cls, w
    return None, None


def generic_by_size(dims_in=None):
    h = (dims_in or {}).get('h')
    size = 'M'
    if h:
        for k, lim in (('XS', 8), ('S', 20), ('M', 36), ('L', 60), ('XL', 90)):
            if h <= lim: size = k; break
        else: size = 'XXL'
    return dict(semantic_class='unresolved', family='unknown', size_class=size, typical_height_in=h or 24, typical_width_in=(dims_in or {}).get('w') or 20,
                plane='floor' if size in ('L', 'XL', 'XXL') else 'table', orientation='upright', anchor_weight=1, foreground_suitability=1,
                can_support=[], can_be_supported_by=[], protected_features=[], dominant_ground_object=False)


def resolve(title=None, category_key=None, dims_in=None, semantic_class=None):
    tax = config.taxonomy()
    if semantic_class and semantic_class in tax:
        rec = tax[semantic_class]; by, conf = 'explicit', 1.0
    else:
        cls, word = _match(title)
        if cls and cls in tax:
            rec = tax[cls]; by, conf = 'keyword:' + word, 0.8
        else:
            fb = CATEGORY_FALLBACK.get(str(category_key or '').lower())
            if fb and fb in tax:
                rec = tax[fb]; by, conf = 'category_key:' + str(category_key), 0.5
            else:
                rec = generic_by_size(dims_in); by, conf = 'unresolved', 0.0
    out = dict(rec)
    if dims_in and dims_in.get('h'):
        out['typical_height_in'] = dims_in['h']
        if dims_in.get('w'): out['typical_width_in'] = dims_in['w']
    return dict(semantic_class=out['semantic_class'], confidence=conf, resolved_by=by,
                dims_source='catalogue' if dims_in and dims_in.get('h') else 'class_default', record=out)


def support_references_resolve():
    """Every can_support / can_be_supported_by entry must name a class, a size class, or a known non-class token."""
    tax = config.taxonomy(); sizes = set(config.p1('object-taxonomy.json')['size_classes'].keys())
    missing = []
    for c in tax.values():
        for ref in c.get('can_support', []) + c.get('can_be_supported_by', []):
            if ref in tax or ref in sizes or ref in NON_CLASS_TOKENS or ALIASES.get(ref) in tax: continue
            missing.append((c['semantic_class'], ref))
    return missing
