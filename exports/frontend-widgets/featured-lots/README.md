# Featured Lots Widget — Export Package v1.0.0

Self-contained deployment guide for the Advantage Featured Lots widget.

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
| Name | Featured Lots |
| Version | 1.0.0 |
| Status | Stable |
| Container ID | `aap-featured-lots` |
| CDN URL | `https://auctions.advantage.bid/widgets/featured-lots.js` |
| Auth required | None — public endpoint only |

**Purpose:** Renders a responsive card grid of lots marked as "featured" across all published
auctions on the Advantage platform. Cards show lot photo, status badge (LIVE NOW / UPCOMING /
ENDING SOON), title, location, current bid, and a link to the lot detail page. An optional
"Sell with Advantage" CTA card appears at the end of the grid.

---

## Quickstart Embed (Standalone)

Paste the container `<div>` where the grid should appear on the BD page.
Paste the `<script>` tag immediately after.

```html
<!-- Advantage Featured Lots Widget -->
<div
  id="aap-featured-lots"
  data-api-base="https://auctions.advantage.bid"
  data-limit="6"
  data-auction-state="published"
></div>
<script src="https://auctions.advantage.bid/widgets/featured-lots.js" defer></script>
```

No other scripts required. The standalone embed includes all dependencies internally.

---

## Full Platform Layer Embed (Multi-Widget Pages)

When this widget and the Featured Near You widget appear on the same page,
load shared dependencies once:

```html
<!-- Shared platform layer — load once at top of body -->
<script src="https://auctions.advantage.bid/widgets/shared/utils.js"></script>
<script src="https://auctions.advantage.bid/widgets/shared/config.js"></script>
<script>
  AAPConfig.set({
    'marketplace.cta.url': 'https://auctions.advantage.bid/seller-create.html',
    'marketplace.cta.headline': 'Consigning an Estate?',
    'widget.limit': 6
  });
</script>
<script src="https://auctions.advantage.bid/widgets/shared/components/badge.js"></script>
<script src="https://auctions.advantage.bid/widgets/shared/components/skeleton-card.js"></script>
<script src="https://auctions.advantage.bid/widgets/shared/components/auction-card.js"></script>
<script src="https://auctions.advantage.bid/widgets/shared/components/seller-cta.js"></script>
<script src="https://auctions.advantage.bid/widgets/shared/components/empty-state.js"></script>
<script src="https://auctions.advantage.bid/widgets/shared/components/error-state.js"></script>

<!-- Featured Lots container — place in page body -->
<div
  id="aap-featured-lots"
  data-api-base="https://auctions.advantage.bid"
  data-limit="6"
></div>
<script src="https://auctions.advantage.bid/widgets/featured-lots.js" defer></script>
```

---

## Configuration — `data-*` Attributes

Set on the `<div id="aap-featured-lots">` element.

| Attribute | Type | Default | Description |
|---|---|---|---|
| `data-api-base` | string | `""` (same origin) | Set to `https://auctions.advantage.bid` on all BD pages |
| `data-limit` | string integer | `"6"` | Number of lot cards. Range 1–12. Must be quoted: `"6"` not `6` |
| `data-auction-state` | string | `"published"` | Filter: `"published"`, `"active"`, or `"closed"` |
| `data-theme` | string | `"light"` | `"light"` or `"dark"` |
| `data-seller-cta-url` | string | `""` (no CTA) | If set, a seller CTA card appears. Use full URL. |
| `data-seller-cta-headline` | string | `"Consigning an Estate?"` | CTA card headline |
| `data-seller-cta-label` | string | `"Learn More"` | CTA button label text |

---

## Configuration — AAPConfig Keys

When using the full platform layer, these keys can be set via `AAPConfig.set()`:

| Key | Type | Default | Description |
|---|---|---|---|
| `widget.limit` | number | `6` | Default lot count (overridden by `data-limit`) |
| `marketplace.badge.live` | string | `"LIVE NOW"` | Live badge label |
| `marketplace.badge.upcoming` | string | `"UPCOMING"` | Upcoming badge label |
| `marketplace.badge.ships` | string | `"Ships nationwide"` | Ships badge label |
| `marketplace.badge.ending_soon` | string | `"Ending Soon"` | Ending soon badge label |
| `marketplace.badge.ending_soon_threshold_min` | number | `120` | Minutes before close that triggers Ending Soon |
| `marketplace.cta.url` | string | `null` | Seller CTA URL (overridden by `data-seller-cta-url`) |
| `marketplace.cta.headline` | string | `"Consigning an Estate?"` | CTA headline |
| `marketplace.cta.label` | string | `"Learn More"` | CTA button label |
| `marketplace.card.image_height_px` | number | `168` | Card image height in pixels |
| `marketplace.shipping.show_badge` | boolean | `true` | Show/hide the ships badge |

**Config priority:** `data-*` attribute wins over `AAPConfig.set()` wins over remote config wins over platform default.

---

## Required Public API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `GET /api/public/featured-lots` | GET | None | Returns featured lot cards |
| `GET /api/public/config` | GET | None | Optional remote config (only if using `loadRemote()`) |

### Query Parameters for `/api/public/featured-lots`

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Max lots to return |
| `auction_state` | string | Filter by auction state |

---

## Analytics Events

Listen for these custom events on the widget container element.

| Event | When fired | Detail object |
|---|---|---|
| `aap:widget:loaded` | After grid renders | `{ widgetId, resultCount, source: 'featured-lots' }` |
| `aap:lot:click` | User clicks a lot card | `{ lotId, lotTitle, auctionId, auctionTitle }` |
| `aap:cta:click` | User clicks the CTA card button | `{ widgetId }` |

**Attaching listeners:**
```javascript
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('aap-featured-lots');
  if (!el) return;
  el.addEventListener('aap:widget:loaded', function (e) {
    // dataLayer.push({ event: 'featured_lots_loaded', count: e.detail.resultCount });
  });
  el.addEventListener('aap:lot:click', function (e) {
    // dataLayer.push({ event: 'lot_click', lot_id: e.detail.lotId });
  });
});
```

---

## Placement Instructions

### Recommended BD Page Positions

| Page type | Recommended section |
|---|---|
| BD homepage | Below hero, above fold if possible |
| Partner landing page | Main body, after introductory paragraph |
| Auction category page | After category description, before navigation links |
| Email landing page | Top of page — primary buyer conversion surface |

### Container Width

Optimal: **1000px–1400px wide**. The grid auto-fills columns at ~280px minimum per card.

| Container width | Approximate columns |
|---|---|
| 340px | 1 column |
| 620px | 2 columns |
| 900px | 3 columns |
| 1180px | 4 columns |

### Replacing an Existing BD Section

1. **Save the existing HTML** in `ops/frontend/docs/deployment-log.md` before touching anything.
2. Remove the old section HTML entirely — do not leave it alongside the widget.
3. Paste the widget embed in the same position.
4. Hard refresh and verify at both 1100px and 375px viewport widths.

---

## Mobile Considerations

- Below 480px: single-column layout (automatic, no configuration needed)
- Card images are fixed 168px height — no distortion at any width
- All interactive elements (cards, CTA button) are touch-friendly
- No hover-only interactions for core navigation

**Required test:** Verify at 375px (iPhone SE) before marking deployment complete.

---

## Accessibility

- Lot cards are `<div role="article" tabindex="0">` — keyboard navigable
- Card images use `aria-hidden="true"` (decorative)
- Status badges carry `aria-label` with human-readable text
- Loading skeleton uses `aria-busy="true"` on the grid container
- CTA card button is a standard `<a>` element
- Color contrast meets WCAG AA on both light and dark themes

---

## SEO Considerations

- Widget content renders client-side — search crawlers may not index lot cards
- For SEO-critical pages: add a visible static `<h2>` or `<p>` above the widget
  (e.g., "Browse Featured Auction Lots") — this carries keyword value
- Lot card links (`lot_url` in API response) are standard `<a>` elements
  and will be followed by JS-capable crawlers
- Do not rely on widget card content for primary page SEO signals

---

## Internal Linking Recommendations

- If the BD page has a "View All Auctions" or "Browse Auctions" link, place it directly
  below the Featured Lots widget grid
- Link text should be descriptive: "Browse all Advantage auctions →" not "Click here"
- The widget's lot cards already link to individual lot detail pages — no additional
  internal linking needed for the cards themselves

---

## Cache Considerations

- Widget JS (`featured-lots.js`): CDN cache `s-maxage=3600` — updates roll within 1 hour
- API response (`/api/public/featured-lots`): CDN cache `s-maxage=60` — data is fresh within 60 seconds
- Optional remote config (`/api/public/config`): 5-minute localStorage TTL (AAPConfig default)
- Hard refresh (`Ctrl+Shift+R`) bypasses browser cache; CDN cache is separate

---

## Deployment Checklist

- [ ] Saved pre-deployment HTML snapshot in `deployment-log.md`
- [ ] Set `data-api-base="https://auctions.advantage.bid"` (required for BD pages)
- [ ] Set `data-limit` to an appropriate card count for the page width
- [ ] Tested in staging page before touching live BD page
- [ ] Verified no JavaScript errors in browser console
- [ ] Verified widget renders within 3 seconds on a normal connection
- [ ] Verified layout at 1100px+ viewport
- [ ] Verified layout at 375px viewport (mobile single-column)
- [ ] Confirmed no layout shift or CSS collision with BD page styles
- [ ] Logged deployment in `ops/frontend/docs/deployment-log.md`

---

## Rollback Instructions

### Config error (wrong data-* attribute)

1. Correct the `data-*` attribute on the container `<div>`
2. Hard refresh and verify

### Full rollback (widget failure, layout break, JS error)

1. Open `ops/frontend/docs/deployment-log.md` — find the rollback snapshot
2. Remove the widget `<div>` and its `<script>` tag
   - If using full platform layer and no other widgets remain: remove all shared scripts
3. Paste the saved rollback HTML back in place
4. Hard refresh — verify the page looks correct
5. Add rollback entry to `deployment-log.md`:
   ```
   [Date] — ROLLBACK: featured-lots v1.0.0 on [page]
   Reason: [brief]
   Restored to: pre-deployment snapshot
   Engineering notified: yes/no
   ```
6. Notify engineering if the cause was a widget bug, not a config error

---

## Known Limitations

- No `data-columns` attribute — columns are auto-calculated by CSS Grid
- No version-pinned CDN URL — `/widgets/featured-lots.js` always serves latest stable
- Widget requires JavaScript — no server-side rendering

*Package published: 2026-05-11 | Source: /public/widgets/featured-lots.js*
