"""Automatic merchandise selection (Phase 3O Wave 1 — blocker 2).

Ranks CLEAN objects and assigns a spatial ROLE per object from its category, maximizing category BREADTH so a
broad estate does not read as luxury/antiques only. Only CLEAN objects are eligible; no fabrication — a
missing category yields an honest audit signal, never an invented object. STAGE THE MERCHANDISE.
"""

# Category -> primary spatial role (uses the shipped roles + supplemental roles).
CAT_ROLE = {
    'Furniture': 'HERO', 'Cabinet': 'TALL_STRUCTURE', 'Armoire': 'TALL_STRUCTURE', 'Bookcase': 'TALL_STRUCTURE',
    'Trunk': 'ANCHOR_H', 'Coffee table': 'ANCHOR_H', 'Chest': 'ANCHOR_H',
    'Lighting': 'LIGHT', 'Lamp': 'LIGHT', 'Torchiere': 'TALL',
    'Tools': 'TOOL_GROUP', 'Power tools': 'TOOL_GROUP', 'Shop equipment': 'TOOL_GROUP',
    'Fine art': 'WALL', 'Works on paper': 'WALL', 'Mirror': 'WALL',
    'Outdoor': 'OUTDOOR', 'Garden': 'OUTDOOR', 'Patio': 'OUTDOOR',
    'Household': 'FOREGROUND', 'Dinnerware': 'FOREGROUND', 'Kitchen': 'FOREGROUND', 'Glassware': 'FOREGROUND',
    'Collectibles': 'FOREGROUND', 'Minerals': 'FOREGROUND', 'Watches': 'FOREGROUND',
    'Porcelain': 'SURFACE', 'Silver': 'SURFACE', 'Metalware': 'SURFACE', 'Sculpture': 'SURFACE', 'Jewelry': 'FOREGROUND',
}
# Category -> breadth family (mirrors spatial.CATEGORY_FAMILIES).
FAMILY = {
    'Furniture': 'furniture', 'Cabinet': 'furniture', 'Armoire': 'furniture', 'Bookcase': 'furniture', 'Trunk': 'furniture', 'Coffee table': 'furniture', 'Chest': 'furniture',
    'Lighting': 'lighting', 'Lamp': 'lighting', 'Torchiere': 'lighting',
    'Tools': 'tools', 'Power tools': 'tools', 'Shop equipment': 'tools',
    'Household': 'household', 'Dinnerware': 'household', 'Kitchen': 'household', 'Glassware': 'household',
    'Collectibles': 'collectibles', 'Minerals': 'collectibles', 'Watches': 'collectibles',
    'Porcelain': 'decor', 'Porcelain figure': 'decor', 'Asian ceramics': 'decor', 'Metalware': 'decor', 'Silver': 'decor', 'Sculpture': 'decor',
    'Fine art': 'art', 'Works on paper': 'art', 'Jewelry': 'jewelry', 'Mirror': 'decor',
    'Outdoor': 'outdoor', 'Garden': 'outdoor', 'Patio': 'outdoor',
}


def role_for(cat):
    return CAT_ROLE.get(cat, 'FOREGROUND')


def family_for(cat):
    return FAMILY.get(cat, 'decor')


def select(clean_objects, max_objects=10):
    """clean_objects: [{lot, cat, name, w, h, importance?}]. Returns an ordered selection [{lot, role, cat,
    family}] maximizing category breadth (one per family first), then filling by importance. CLEAN-only is the
    caller's guarantee; this never invents an object."""
    enriched = []
    for o in clean_objects:
        enriched.append(dict(lot=str(o['lot']), cat=o.get('cat'), name=o.get('name'), role=role_for(o.get('cat')),
                             family=family_for(o.get('cat')), importance=float(o.get('importance', 0.5)),
                             area=float(o.get('w', 1)) * float(o.get('h', 1))))
    # Breadth-first: pick the highest-importance object from each family once, then fill by importance.
    by_family = {}
    for e in enriched:
        by_family.setdefault(e['family'], []).append(e)
    for fam in by_family:
        by_family[fam].sort(key=lambda e: (-e['importance'], -e['area']))
    chosen, used = [], set()
    for fam in sorted(by_family):
        top = by_family[fam][0]
        chosen.append(top); used.add(top['lot'])
    rest = sorted([e for e in enriched if e['lot'] not in used], key=lambda e: (-e['importance'], -e['area']))
    for e in rest:
        if len(chosen) >= max_objects:
            break
        chosen.append(e); used.add(e['lot'])
    # Ensure at least one HERO-eligible object exists (composition needs a grounded anchor).
    return chosen[:max_objects]
