'use strict';

/**
 * tristateFootprint — the New York Tri-State In-Home Service Area as anchor communities with radii.
 *
 * TARGETING NEVER USES THE COORDINATES HERE. Every anchor is resolved to a provider city key through
 * the provider's own geolocation search at run time; the approximate public coordinates below exist
 * only to produce the human coverage report (which counties are covered, partly covered, excluded).
 * The provider's minimum city radius is 10 miles.
 *
 * Version 1 (2026-09-23, prepared): 12 anchors.
 * Version 2 (2026-09-23, Owner-approved with adjustments): + Monmouth County, + practical eastern
 * Fairfield County. The Owner explicitly did NOT add Suffolk, Putnam, Orange, Dutchess, Mercer,
 * Hunterdon, Sussex, Warren, Ocean or New Haven.
 */

const V1 = Object.freeze([
  { name: 'New York', region: 'New York', radius: 15, ll: [40.7128, -74.0060], serves: 'Manhattan, Brooklyn, Queens, the Bronx; Hudson County NJ' },
  { name: 'White Plains', region: 'New York', radius: 10, ll: [41.0340, -73.7629], serves: 'central / southern Westchester' },
  { name: 'Mineola', region: 'New York', radius: 10, ll: [40.7493, -73.6407], serves: 'Nassau County' },
  { name: 'New City', region: 'New York', radius: 10, ll: [41.1476, -73.9893], serves: 'Rockland County' },
  { name: 'Hackensack', region: 'New Jersey', radius: 10, ll: [40.8859, -74.0435], serves: 'Bergen County' },
  { name: 'Paterson', region: 'New Jersey', radius: 10, ll: [40.9168, -74.1718], serves: 'Passaic (south) and north Essex' },
  { name: 'Morristown', region: 'New Jersey', radius: 10, ll: [40.7968, -74.4815], serves: 'Morris County' },
  { name: 'Elizabeth', region: 'New Jersey', radius: 10, ll: [40.6640, -74.2107], serves: 'Union, south Essex, north Staten Island' },
  { name: 'Perth Amboy', region: 'New Jersey', radius: 10, ll: [40.5068, -74.2654], serves: 'Woodbridge area and south Staten Island' },
  { name: 'New Brunswick', region: 'New Jersey', radius: 10, ll: [40.4862, -74.4518], serves: 'Middlesex and east Somerset' },
  { name: 'Stamford', region: 'Connecticut', radius: 10, ll: [41.0534, -73.5387], serves: 'Greenwich, Stamford, Darien, New Canaan' },
  { name: 'Norwalk', region: 'Connecticut', radius: 10, ll: [41.1177, -73.4082], serves: 'Norwalk, Westport, Wilton, Weston' },
]);

const V2_ADDITIONS = Object.freeze([
  { name: 'Middletown', region: 'New Jersey', radius: 10, ll: [40.3943, -74.1168], serves: 'northern / eastern Monmouth: Middletown, Red Bank, Holmdel, Long Branch' },
  { name: 'Freehold', region: 'New Jersey', radius: 10, ll: [40.2601, -74.2738], serves: 'western / central Monmouth: Freehold, Manalapan, Marlboro, Howell' },
  { name: 'Fairfield', region: 'Connecticut', radius: 10, ll: [41.1412, -73.2637], serves: 'eastern Fairfield County: Fairfield, Bridgeport, Trumbull, Stratford' },
]);

const V2 = Object.freeze([...V1, ...V2_ADDITIONS]);

// Counties considered (approximate centroids) and the Owner's decision for each in version 2.
const COUNTIES = Object.freeze([
  ['New York (Manhattan)', 'NY', 40.7831, -73.9712, 'KEEP'], ['Kings (Brooklyn)', 'NY', 40.6501, -73.9496, 'KEEP'],
  ['Queens', 'NY', 40.7282, -73.7949, 'KEEP'], ['Bronx', 'NY', 40.8448, -73.8648, 'KEEP'],
  ['Richmond (Staten Island)', 'NY', 40.5795, -74.1502, 'KEEP'], ['Westchester', 'NY', 41.1220, -73.7949, 'KEEP'],
  ['Nassau', 'NY', 40.7289, -73.5894, 'KEEP'], ['Rockland', 'NY', 41.1489, -74.0260, 'KEEP'],
  ['Suffolk', 'NY', 40.9434, -72.6922, 'NOT_YET'], ['Putnam', 'NY', 41.4351, -73.7949, 'NOT_YET'],
  ['Orange', 'NY', 41.4020, -74.3118, 'NOT_YET'], ['Dutchess', 'NY', 41.7784, -73.7478, 'NOT_YET'],
  ['Hudson', 'NJ', 40.7453, -74.0535, 'KEEP'], ['Bergen', 'NJ', 40.9263, -74.0770, 'KEEP'], ['Essex', 'NJ', 40.7870, -74.2460, 'KEEP'],
  ['Passaic', 'NJ', 41.0337, -74.3000, 'KEEP'], ['Union', 'NJ', 40.6598, -74.3082, 'KEEP'], ['Morris', 'NJ', 40.8620, -74.5446, 'KEEP'],
  ['Middlesex', 'NJ', 40.4400, -74.4059, 'KEEP'], ['Somerset', 'NJ', 40.5638, -74.6168, 'KEEP'], ['Monmouth', 'NJ', 40.2589, -74.1240, 'ADD'],
  ['Mercer', 'NJ', 40.2830, -74.7010, 'NOT_YET'], ['Hunterdon', 'NJ', 40.5654, -74.9120, 'NOT_YET'], ['Sussex', 'NJ', 41.1390, -74.6905, 'NOT_YET'],
  ['Warren', 'NJ', 40.8570, -75.0059, 'NOT_YET'], ['Ocean', 'NJ', 39.8670, -74.2500, 'NOT_YET'],
  ['Fairfield (southwest)', 'CT', 41.0900, -73.5000, 'KEEP'], ['Fairfield (east: Bridgeport / Fairfield / Trumbull)', 'CT', 41.2000, -73.2200, 'ADD'],
  ['New Haven', 'CT', 41.3490, -72.9000, 'NOT_YET'],
]);

/** Great-circle distance in miles. Pure. */
function miles(a, b) {
  const R = 3958.7613, rad = (d) => d * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Approximate county coverage for a set of anchors. Pure. */
function coverage(anchors) {
  return COUNTIES.map(([name, st, lat, lng, decision]) => {
    let best = null;
    for (const a of anchors) {
      const d = miles([lat, lng], a.ll);
      if (!best || d - a.radius < best.margin) best = { anchor: a.name, distance: d, margin: d - a.radius };
    }
    const status = best.margin <= -2 ? 'INCLUDED' : best.margin <= 8 ? 'PARTIAL' : 'EXCLUDED';
    return { county: name, state: st, owner_decision: decision, status, nearest_anchor: best.anchor, approx_miles_from_anchor: Math.round(best.distance) };
  });
}

/** Would any anchor circle reach into an area the Owner said NOT to add? Pure; reports spillover. */
function spilloverIntoExcluded(anchors, { marginMiles = 4 } = {}) {
  const out = [];
  for (const [name, st, lat, lng, decision] of COUNTIES) {
    if (decision !== 'NOT_YET') continue;
    for (const a of anchors) {
      const d = miles([lat, lng], a.ll);
      // A centroid inside a circle would mean targeting the county itself — never allowed.
      if (d <= a.radius) out.push({ county: name, state: st, anchor: a.name, severity: 'CENTROID_INSIDE' });
      else if (d <= a.radius + marginMiles) out.push({ county: name, state: st, anchor: a.name, severity: 'EDGE' });
    }
  }
  return out;
}

module.exports = { V1, V2, V2_ADDITIONS, COUNTIES, miles, coverage, spilloverIntoExcluded };
