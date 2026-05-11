# City Enhancements — Export Package v1.0.0

Pre-configured regional variants of the Featured Near You widget.
Each configuration targets a specific metro area with hardcoded coordinates —
no browser geolocation prompt.

---

## Package Contents

| File | Purpose |
|---|---|
| `widget.js` | City-aware embed loader with built-in coordinate table |
| `widget.css` | CSS override layer |
| `README.md` | This deployment guide |
| `version.json` | Version metadata and available city list |

---

## Widget Summary

| Field | Value |
|---|---|
| Name | City Enhancements |
| Version | 1.0.0 |
| Status | Stable |
| Container ID | `aap-featured-near-you` (same as Featured Near You) |
| Underlying widget | `featured-near-you.js` |

**Purpose:** Simplifies deploying the Featured Near You widget on regional BD pages.
Instead of looking up coordinates, the frontend operator specifies a city slug (`data-city`)
and the loader applies the correct coordinates automatically. No geolocation prompt ever fires.

---

## Available City Configurations

| Slug | City | Default Radius |
|---|---|---|
| `dallas-tx` | Dallas / Fort Worth, TX | 150 km |
| `houston-tx` | Houston, TX | 150 km |
| `san-antonio-tx` | San Antonio, TX | 120 km |
| `atlanta-ga` | Atlanta, GA | 150 km |
| `chicago-il` | Chicago, IL | 100 km |
| `phoenix-az` | Phoenix, AZ | 150 km |
| `denver-co` | Denver, CO | 150 km |
| `nashville-tn` | Nashville, TN | 120 km |
| `kansas-city-mo` | Kansas City, MO | 150 km |
| `minneapolis-mn` | Minneapolis, MN | 150 km |

**For unlisted cities:** Use the `featured-near-you` widget directly with `data-lat` and `data-lng`.

---

## Quickstart Embed

```html
<!-- Advantage City Enhancement — Dallas/Fort Worth page -->
<div
  id="aap-featured-near-you"
  data-api-base="https://auctions.advantage.bid"
  data-city="dallas-tx"
  data-limit="6"
></div>
<script src="./widget.js"></script>
```

### With a custom radius override

```html
<!-- Tighter radius for a specific neighborhood page -->
<div
  id="aap-featured-near-you"
  data-api-base="https://auctions.advantage.bid"
  data-city="chicago-il"
  data-radius-km="50"
  data-limit="6"
></div>
<script src="./widget.js"></script>
```

### With seller CTA

```html
<div
  id="aap-featured-near-you"
  data-api-base="https://auctions.advantage.bid"
  data-city="atlanta-ga"
  data-limit="6"
  data-seller-cta-url="https://auctions.advantage.bid/seller-create.html"
  data-seller-cta-headline="Selling in Atlanta?"
  data-seller-cta-label="Get Started"
></div>
<script src="./widget.js"></script>
```

---

## Configuration — `data-*` Attributes

| Attribute | Required | Default | Description |
|---|---|---|---|
| `data-api-base` | **Yes** | — | Always `https://auctions.advantage.bid` on BD pages |
| `data-city` | **Yes** | — | City slug from the table above |
| `data-limit` | No | `"6"` | Cards to show, 1–12 |
| `data-radius-km` | No | Per-city default | Override the default radius for the city |
| `data-theme` | No | `"light"` | `"light"` or `"dark"` |
| `data-seller-cta-url` | No | `""` | Show seller CTA card if set |
| `data-seller-cta-headline` | No | `"Consigning an Estate?"` | CTA headline |
| `data-seller-cta-label` | No | `"Learn More"` | CTA button label |

**Note:** `data-lat` and `data-lng` should NOT be set when using `data-city` —
the loader sets them from the city config. If you set them explicitly, they will be
preserved as-is (your values override the city defaults).

---

## BD Placement Recommendations

| Page type | Configuration |
|---|---|
| City landing page | `data-city="[city-slug]"`, standard `data-limit="6"` |
| Regional estate sale page | `data-city="[city-slug]"`, add seller CTA |
| City blog or guide page | `data-city="[city-slug]"`, `data-limit="3"` for compact placement |
| State/region page (multiple cities) | Deploy one widget per city section with different city slugs |

### Multi-city page pattern (one widget per city section)

If a single page covers multiple cities, use separate widget instances with different
parent container IDs (wrapped elements). See the Featured Near You `README.md` for
multi-widget load order guidance.

---

## Required API Endpoints

Same as Featured Near You widget:
- `GET /api/public/featured-auctions?lat=…&lng=…&radius_km=…`
- `GET /api/public/auctions/near?lat=…&lng=…&radius_km=…`

---

## Adding New Cities (Engineering Task)

City configurations are maintained in `widget.js` in the `CITY_CONFIGS` object.
To add a new city:

1. Look up the city center lat/lng coordinates
2. Add an entry to `CITY_CONFIGS` in `widget.js`
3. Add the slug to `available_city_configs` in `version.json`
4. Bump the PATCH version in `version.json` (adding a city is non-breaking)
5. Update the city table in this `README.md`
6. Commit: `export: city-enhancements — add [city-name] config`

Frontend operations cannot add cities — this requires an engineering update to the export package.

---

## Mobile Considerations

Same as Featured Near You widget:
- Below 480px: single-column layout
- No geolocation prompt ever fires (hardcoded coordinates)
- Test at 375px before deploying

---

## Rollback Instructions

Remove `<div id="aap-featured-near-you">` and its `<script src="./widget.js">`.
Paste back the pre-deployment HTML from `ops/frontend/docs/deployment-log.md`.

*Package published: 2026-05-11 | Source: /public/widgets/featured-near-you.js*
