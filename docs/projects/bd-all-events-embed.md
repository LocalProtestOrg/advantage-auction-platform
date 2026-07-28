# BD `/all-events` — Marketplace Feed embed (owner handoff)

The public List View at **www.advantage.bid/all-events** should display the Railway Marketplace Feed
(auctions + estate sales) instead of any BD-native event listing. BD owns the page shell (SEO/CMS);
Railway owns the data. No event records live in BD.

## Embed (recommended: iframe — simplest, isolated styles)
Paste into the `/all-events` page body (BD page content or an HTML widget):

```html
<iframe
  src="https://bid.advantage.bid/widgets/marketplace-feed.html"
  title="Advantage.Bid Marketplace"
  style="width:100%; min-height:1200px; border:0; display:block"
  loading="lazy"></iframe>
```

## Alternative (script embed — inherits page width, no iframe)
```html
<div id="advantage-marketplace-feed"></div>
<script src="https://bid.advantage.bid/widgets/marketplace-feed.js"></script>
```

## Behavior
- Renders the same event cards as the Railway marketplace, from `GET /api/public/marketplace/feed`.
- Built-in search: keyword (title / city / company), city, state, ZIP, and type (auctions / estate sales).
- **List | Map toggle:** "Map" hands the visitor to the Railway map (`bid.advantage.bid/`), carrying the
  current filters; the Railway map has a reciprocal "List view" link back to `/all-events` with the same
  filters. Switching views never loses context.
- Filters can be pre-set via the page URL, e.g. `…/all-events?state=MI&type=estate_sale` — the embed
  inherits them (works great for city/state SEO pages).

## Notes
- Keep the BD nav label "Browse Events" pointing at `/all-events`.
- Do NOT create native BD event/auction records; the feed is the single source of truth (bid.advantage.bid).
- The embed page is `noindex` (the canonical indexable list is `/all-events` on BD).
