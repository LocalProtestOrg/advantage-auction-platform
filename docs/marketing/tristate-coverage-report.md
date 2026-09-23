# New York Tri-State In-Home Service Area — coverage report

**Status: PENDING OWNER GEOGRAPHY APPROVAL.** No documented Owner service boundary exists; the only prior definitions are an 87-mile events radius and a state-level (NY/NJ/CT) inquiry label, both far broader than an in-home service footprint.

Generated 2026-09-23T16:35:33.746Z by `scripts/prepare-tristate-market.js`. Location keys come from the provider's own
geolocation search; reach is the provider's delivery estimate for adults aged 25+. Distances are approximate.

**Whole footprint reach:** 12,500,000 – 14,700,000 people (overlap de-duplicated by the provider).

## Anchors (targeted)

| Anchor | Provider key | Radius | Intended coverage | Reach |
|---|---|---|---|---|
| New York, New York | 2490299 | 15 mi | Manhattan, Brooklyn, Queens, the Bronx; Hudson County NJ | 9,900,000–11,600,000 |
| White Plains, New York | 2492495 | 10 mi | central / southern Westchester | 817,900–962,300 |
| Mineola, New York | 2490084 | 10 mi | Nassau County | 1,600,000–1,900,000 |
| New City, New York | 2490260 | 10 mi | Rockland County | 433,700–510,300 |
| Hackensack, New Jersey | 2483839 | 10 mi | Bergen County | 5,200,000–6,100,000 |
| Paterson, New Jersey | 2484578 | 10 mi | Passaic (south) and north Essex | 1,600,000–1,900,000 |
| Morristown, New Jersey | 2484358 | 10 mi | Morris County | 577,400–679,300 |
| Elizabeth, New Jersey | 2483609 | 10 mi | Union, south Essex, north Staten Island | 2,600,000–3,000,000 |
| Perth Amboy, New Jersey | 2484614 | 10 mi | Woodbridge area and south Staten Island | 1,200,000–1,500,000 |
| New Brunswick, New Jersey | 2484414 | 10 mi | Middlesex and east Somerset | 956,600–1,100,000 |
| Stamford, Connecticut | 2425322 | 10 mi | Greenwich, Stamford, Darien, New Canaan | 393,200–462,600 |
| Norwalk, Connecticut | 2425102 | 10 mi | Norwalk, Westport, Wilton, Weston | 450,800–530,300 |

## Counties

| County | State | Coverage | Nearest anchor (≈ mi) |
|---|---|---|---|
| New York (Manhattan) | NY | INCLUDED | New York (5) |
| Kings (Brooklyn) | NY | INCLUDED | New York (5) |
| Queens | NY | INCLUDED | New York (11) |
| Bronx | NY | INCLUDED | New York (12) |
| Richmond (Staten Island) | NY | INCLUDED | Elizabeth (7) |
| Westchester | NY | INCLUDED | White Plains (6) |
| Nassau | NY | INCLUDED | Mineola (3) |
| Rockland | NY | INCLUDED | New City (2) |
| Suffolk | NY | EXCLUDED | Norwalk (39) |
| Putnam | NY | EXCLUDED | New City (22) |
| Orange | NY | EXCLUDED | New City (24) |
| Dutchess | NY | EXCLUDED | New City (45) |
| Hudson | NJ | INCLUDED | New York (3) |
| Bergen | NJ | INCLUDED | Hackensack (3) |
| Essex | NJ | PARTIAL | New York (14) |
| Passaic | NJ | PARTIAL | Paterson (10) |
| Union | NJ | INCLUDED | Elizabeth (5) |
| Morris | NJ | INCLUDED | Morristown (6) |
| Middlesex | NJ | INCLUDED | New Brunswick (4) |
| Somerset | NJ | PARTIAL | New Brunswick (10) |
| Monmouth | NJ | EXCLUDED | Perth Amboy (19) |
| Mercer | NJ | EXCLUDED | New Brunswick (19) |
| Hunterdon | NJ | EXCLUDED | New Brunswick (25) |
| Sussex | NJ | EXCLUDED | Morristown (26) |
| Warren | NJ | EXCLUDED | Morristown (28) |
| Ocean | NJ | EXCLUDED | New Brunswick (44) |
| Fairfield (southwest) | CT | INCLUDED | Stamford (3) |
| Fairfield (east: Bridgeport / Danbury) | CT | PARTIAL | Norwalk (14) |
| New Haven | CT | EXCLUDED | Norwalk (31) |

## Spillover and limits

- Circles cross county and state lines: edge communities outside the listed service area can see ads (e.g. western Suffolk near the Nassau line, southern Orange near Rockland, northern Monmouth near Perth Amboy / New Brunswick, the Bridgeport edge of the Norwalk circle).
- The provider targets people living in or recently in a location, so commuters and visitors can be reached.
- Geographic targeting is not eligibility: an inquiry from a reached person may still be outside the in-home service footprint and must be qualified by the team.
- The state regions of New York, New Jersey and Connecticut are NOT targeted; only the anchor circles are.

## Optional additions for the Owner to decide

- Monmouth County (Freehold, key resolvable) — central NJ, excluded by default
- eastern Fairfield County (Bridgeport / Danbury)
- Suffolk County
