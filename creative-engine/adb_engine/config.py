"""Phase 3P.1/3P.2 config access for the engine. The design configs are the Desktop Marketing deliverables under
docs/marketing/phase3p1/config and docs/marketing/phase3p2/config (read-only here); numeric physical-audit thresholds
live in creative-engine/config/physical-audit.json so no threshold is hard-coded in engine code."""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
REPO = os.path.dirname(ENGINE)
P1 = os.path.join(REPO, 'docs', 'marketing', 'phase3p1', 'config')
P2 = os.path.join(REPO, 'docs', 'marketing', 'phase3p2', 'config')
LOGO_DIR = os.path.join(REPO, 'docs', 'marketing', 'brand-assets', 'logos')
_cache = {}


def _load(path):
    if path not in _cache:
        with open(path, encoding='utf-8') as f:
            _cache[path] = json.load(f)
    return _cache[path]


def p1(name): return _load(os.path.join(P1, name))
def p2(name): return _load(os.path.join(P2, name))
def engine(name): return _load(os.path.join(ENGINE, 'config', name))


def thresholds(): return engine('physical-audit.json')
def coverage_bands(): return p1('coverage-bands.json')
def prominence_rules(): return p1('prominence-rules.json')
def color_system(): return p2('color-system.json')
def logo_system(): return p2('logo-asset-system.json')
def relationship_rules(): return p1('relationship-rules.json')


def strip_annotation(s):
    """'small_decor_on_seat(no)' -> 'small_decor_on_seat'; 'cabinet(inside)' -> 'cabinet'."""
    return re.sub(r'\(.*?\)', '', str(s)).strip()


def taxonomy():
    key = '__taxonomy__'
    if key not in _cache:
        raw = p1('object-taxonomy.json')
        classes = {}
        for c in raw['classes']:
            c = dict(c)
            # '(no)' annotations negate the entry; everything else keeps the class name without its note.
            c['can_support'] = [strip_annotation(x) for x in c.get('can_support', []) if '(no)' not in str(x)]
            c['can_be_supported_by'] = [strip_annotation(x) for x in c.get('can_be_supported_by', []) if '(no)' not in str(x)]
            classes[c['semantic_class']] = c
        _cache[key] = classes
    return _cache[key]
