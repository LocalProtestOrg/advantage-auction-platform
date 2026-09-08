"""Protected-region derivation (Phase 3O Wave 1 — blocker 4, part A).

Production cannot depend on hand-marking every auction. This derives candidate protected regions from
object category heuristics (as fractions of the object box, matching spatial.PROTECTED's format) and returns
a confidence. Low-confidence cases are classified REVIEW rather than asserting certainty. The derived regions
are injected into the shipped spatial.PROTECTED so the audit ENFORCES them (never crop/occlude).
"""

# category -> [(label, fx0, fy0, fx1, fy1)] candidate protected regions + confidence.
CAT_PROTECTED = {
    'Fine art':       ([('signature', 0.80, 0.86, 0.99, 0.98)], 0.7),
    'Works on paper': ([('signature area', 0.05, 0.90, 0.95, 0.99)], 0.7),
    'Watches':        ([('dial', 0.28, 0.28, 0.72, 0.72)], 0.85),
    'Clocks':         ([('dial', 0.30, 0.18, 0.70, 0.58)], 0.8),
    'Jewelry':        ([('centre stone', 0.35, 0.30, 0.65, 0.60)], 0.6),
    'Sculpture':      ([('face', 0.30, 0.06, 0.70, 0.40)], 0.55),
    'Portrait':       ([('face', 0.28, 0.10, 0.72, 0.45)], 0.75),
}


def derive(cat):
    """Returns (regions, confidence). Regions may be empty (no known protected feature)."""
    regions, conf = CAT_PROTECTED.get(cat, ([], 1.0))
    return regions, conf


def apply_to_spatial(spatial_module, lot, cat, review_threshold=0.5):
    """Inject derived protected regions for `lot` into spatial.PROTECTED so the audit enforces them. Returns
    'REVIEW' when confidence is below threshold (ambiguous → do not assert certainty), else 'OK'."""
    regions, conf = derive(cat)
    if regions and conf < review_threshold:
        return 'REVIEW'
    if regions:
        spatial_module.PROTECTED[str(lot)] = regions
    return 'OK'
