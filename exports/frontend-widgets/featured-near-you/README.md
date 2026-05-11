# Featured Near You Widget — Export Package v1.0.0

Self-contained deployment guide for the Advantage Featured Auctions Near You widget.

---

## Package Contents

| File | Purpose |
|---|---|
| `widget.js` | Thin embed loader — loads widget from CDN |
| `widget.css` | CSS override layer for BD brand customization |
| `README.md` | This deployment guide |
| `version.json` | Version metadata, compatibility, changelog |

---

## Widget Summary

| Field | Value |
|---|---|
| Name | Featured Auctions Near You |
| Version | 1.0.0 |
| Status | Stable |
| Container ID | `aap-featured-near-you` |
| CDN URL | `https://auctions.advantage.bid/widgets/featured-near-you.js` |
| Auth required | None — public endpoints only |

**Purpose:** Renders a responsive card grid of featured auctions near the buyer's location.
Location is resolved in order: hardcoded coordinates → browser geolocation → national fallback.
Best suited for regional landing pages and geo-contextual BD pages.

---

## Location Resolution Strategy

The widget tries three sources in this priority order:

| Priority | Source | Notes |
|---|---|---|
| 1 | `data-lat` + `data-lng` on container | No browser prompt — always use for regional pages |
| 2 | Browser Geolocation API | Prompts user for permission |
| 3 | National featured feed (no geo) | Fallback when geo unavailable or denied |

**Regional pages:** Always use hardcoded coordinates (`data-lat`, `data-lng`). This avoids
the browser permission prompt and delivers consistent results for the page's geographic context.

**Discovery pages:** Use `data-use-geolocation="true"` to trigger the browser prompt and
show buyers auctions near their actual location.

---

## Quickstart Embed — Auto-Detect Location

```html
<!-- Advantage Featured Near You Widget — browser geolocation -->
<div
  id="aap-featured-near-you"
  data-api-base="https://auctions.advantage.bid"
  data-limit="6"
  data-radius-km="200"
  data-use-geolocation="true"
></div>
<script src="https://auctions.advantage.bid/widgets/featured-near-you.js" defer></script>
```

---

## Quickstart Embed — Hardcoded Region (Recommended for Regional Pages)

```html
<!-- Advantage Featured Near You Widget — Dallas/Fort Worth region -->
<div
  id="aap-featured-near-you"
  data-api-base="https://auctions.advantage.bid"
  data-lat="32.7767"
  data-lng="-96.7970"
  data-radius-km="150"
  data-limit="6"
></div>
<script src="https://auctions.advantage.bid/widgets/featured-near-you.js" defer></script>
```

---

## Regional Coordinate Reference

| Region | data-lat | data-lng | Suggested data-radius-km |
|---|---|---|---|
| Dallas / Fort Worth, TX | `32.7767` | `-96.7970` | `150` |
| Houston, TX | `29.7604` | `-95.3698` | `150` |
| San Antonio, TX | `29.4241` | `-98.4936` | `120` |
| Atlanta, GA | `33.7490` | `-84.3880` | `150` |
| Chicago, IL | `41.8781` | `-87.6298` | `100` |
| Phoenix, AZ | `33.4484` | `-112.0740` | `150` |
| Denver, CO | `39.7392` | `-104.9903` | `150` |
| Nashville, TN | `36.1627` | `-86.7816` | `120` |
| Kansas City, MO | `39.0997` | `-94.5786` | `150` |
| Minneapolis, MN | `44.9778` | `-93.2650` | `150` |

For any other city: look up latitude/longitude at [latlong.net](https://www.latlong.net)
and use the city center coordinates.

---

## Configuration — `data-*` Attributes

| Attribute | Type | Default | Description |
|---|---|---|---|
| `data-api-base` | string | `""` | Set to `https://auctions.advantage.bid` on all BD pages |
| `data-limit` | string integer | `"6"` | Cards to show. Range 1–12. Must be quoted. |
| `data-radius-km` | string integer | `"200"` | Search radius in km. Range 1–800. |
| `data-use-geolocation` | string | `"false"` | Set `"true"` to trigger browser geolocation prompt |
| `data-geo-timeout-ms` | string integer | `"5000"` | Geolocation timeout in ms. Range 1000–15000. |
| `data-lat` | string float | `""` | Latitude for hardcoded region. Skips geolocation. |
| `data-lng` | string float | `""` | Longitude for hardcoded region. Required with data-lat. |
| `data-theme` | string | `"light"` | `"light"` or `"dark"` |
| `data-seller-cta-url` | string | `""` | If set, shows seller CTA card after results |
| `data-seller-cta-headline` | string | `"Consigning an Estate?"` | CTA headline |
| `data-seller-cta-label` | string | `"Learn More"` | CTA button label |

**Coordinate note:** `data-lat` and `data-lng` must both be provided or neither.
Values must be decimal degrees: `"32.7767"` not `"32° 46'"`.

---

## Required Public API Endpoints

| Endpoint | Method | Auth | Used for |
|---|---|---|---|
| `GET /api/public/featured-auctions` | GET | None | Primary fetch — geo-filtered featured auctions |
| `GET /api/public/auctions/near` | GET | None | Secondary fetch — all auctions near location (fallback) |

### Query Parameters

| Parameter | Endpoint | Description |
|---|---|---|
| `lat` | Both | Latitude (optional) |
| `lng` | Both | Longitude (optional) |
| `radius_km` | Both | Search radius (optional, default 200) |
| `limit` | Both | Max results (optional, default 6) |

---

## Fetch Strategy (Detail)

```
Has coordinates (lat/lng)?
  ├── YES → GET /api/public/featured-auctions?lat=…&lng=…&radius_km=…
  │          ├── Results > 0 → render and done
  │          └── Results = 0 → fire aap:widget:fallback{reason:'no-results'}
  │                            → GET /api/public/auctions/near?lat=…&lng=…
  │                              ├── Results > 0 → render and done
  │                              └── Results = 0 → render empty state
  └── NO  → GET /api/public/featured-auctions (national, no geo params)
             ├── Results > 0 → render and done
             └── Results = 0 → render empty state
```

---

## Analytics Events

| Event | When fired | Detail |
|---|---|---|
| `aap:widget:loaded` | After grid renders | `{ widgetId, resultCount, source: 'featured'|'near'|'national' }` |
| `aap:widget:fallback` | On geo deny/timeout or no results | `{ reason: 'geo-denied'|'geo-unavailable'|'geo-timeout'|'no-results' }` |
| `aap:auction:click` | User clicks an auction card | `{ auctionId, title, distanceKm, source }` |
| `aap:cta:click` | User clicks CTA button | `{ widgetId }` |

The `source` field on `aap:widget:loaded` tells you which fetch strategy succeeded:
`'featured'` = geo-filtered featured, `'near'` = geo-filtered all, `'national'` = no geo.

```javascript
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('aap-featured-near-you');
  if (!el) return;
  el.addEventListener('aap:widget:loaded', function (e) {
    // dataLayer.push({ event: 'near_you_loaded', source: e.detail.source });
  });
  el.addEventListener('aap:auction:click', function (e) {
    // dataLayer.push({ event: 'auction_click', distance_km: e.detail.distanceKm });
  });
});
```

---

## BD Placement Recommendations

| Page type | Use case | Configuration |
|---|---|---|
| Regional landing page | Show local auctions for a specific metro area | Hardcode `data-lat` + `data-lng` + narrow `data-radius-km` |
| National discovery page | Let buyers find auctions near them | `data-use-geolocation="true"`, no coordinates |
| City scenario page | Reinforce local context | Hardcode city center coordinates |
| BD homepage secondary section | Local discovery below national featured lots | `data-use-geolocation="true"` |

---

## Mobile Considerations

- Below 480px: single-column layout (automatic)
- Geolocation permission dialog is a native browser dialog — appears at top of viewport, non-blocking
- If user denies geolocation, IP fallback activates silently — no error shown
- Widget renders skeleton loading state immediately while resolving location and fetching data
- Card images are fixed 168px height — no distortion at any width

**Required test:** Verify at 375px before marking deployment complete.
Also test with geolocation denied (verify clean fallback to national feed).

---

## Accessibility

- Auction cards use `role="article"`, `tabindex="0"` — fully keyboard-navigable
- Badges carry `aria-label` ("Live auction", "Upcoming auction")
- Distance text ("12 km away") is visible text, not icon-only
- Skeleton loading state uses `aria-busy="true"` on the grid container
- Keyboard: Enter or Space on a focused card triggers click

---

## SEO Considerations

- Widget content renders client-side — not indexed by standard crawlers
- For geo-contextual pages: use a static `<h2>` above the widget that names the region
  (e.g., "Featured Auctions Near Dallas, TX") — this carries SEO keyword value
- Auction cards link to live auction pages — crawlers that execute JS will follow these
- Do not rely on widget content for editorial SEO signals

---

## Deployment Checklist

- [ ] Saved pre-deployment HTML snapshot in `deployment-log.md`
- [ ] Chose correct location strategy (hardcoded vs. geolocation)
- [ ] Set `data-api-base="https://auctions.advantage.bid"`
- [ ] Verified coordinates are correct (if hardcoded)
- [ ] Tested in staging before touching live page
- [ ] Verified no JS errors in console
- [ ] Verified at 1100px+ and 375px viewports
- [ ] Tested geolocation denied case (if using `data-use-geolocation="true"`)
- [ ] Logged deployment in `ops/frontend/docs/deployment-log.md`

---

## Rollback Instructions

### Wrong coordinates (hardcoded region issue)

1. Correct `data-lat` and `data-lng` on the container
2. Hard refresh and verify

### Geolocation causing UX issues (unwanted browser prompt)

Remove `data-use-geolocation="true"` and add hardcoded regional coordinates.
The browser prompt will no longer appear, and results will be region-specific.

### Full rollback

Follow the standard rollback procedure in `ops/frontend/docs/rollback-guide.md`.
Log the rollback and notify engineering if the cause was a widget bug.

*Package published: 2026-05-11 | Source: /public/widgets/featured-near-you.js*
