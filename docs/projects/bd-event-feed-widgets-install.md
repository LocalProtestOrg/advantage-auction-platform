# BD Event-Feed Widgets — Install Package (All Events · Auctions · Estate Sales)

**One Railway engine, three presets.** All three "widgets" are the SAME `marketplace-feed.js` engine with
a different `preset` — the SERVER enforces the event type, so a visitor can't widen a preset. No duplicate
code, no duplicate data, no Railway secrets in BD.

**BD API is read-only (GET-only) — I cannot create Widget Manager widgets programmatically.** These are
the exact copy-paste blocks + placement for the owner to add in BD.

## Recommended embed: IFRAME (simplest, style-isolated, no CORS surface)

Create three BD Custom Widgets (HTML tab), paste one block each, then place each widget on its page.

> **Geolocation:** a cross-origin iframe only gets the Geolocation API if the parent grants it via
> `allow="geolocation"` — without it the "Use my location" button is blocked by browser Permissions
> Policy (the typed Location field still works). The blocks below include it. The `style="width:100%"`
> makes the embed responsive full-width; it fills whatever column BD places it in.

### 1. Advantage All Events → page `/all-events`
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events"
        title="Advantage.Bid — All Events" loading="lazy" allow="geolocation"
        style="width:100%; min-height:1300px; border:0; display:block"></iframe>
```

### 2. Advantage Auctions Only → page `/auctions`
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=auctions"
        title="Advantage.Bid — Auctions" loading="lazy" allow="geolocation"
        style="width:100%; min-height:1300px; border:0; display:block"></iframe>
```

### 3. Advantage Estate Sales Only → page `/estate-sales`
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=estate-sales"
        title="Advantage.Bid — Estate Sales" loading="lazy" allow="geolocation"
        style="width:100%; min-height:1300px; border:0; display:block"></iframe>
```

## Alternative embed: SCRIPT (inherits page width, no iframe; CORS is allowlisted `*`)
```html
<div id="advantage-marketplace-feed" data-preset="all-events"></div>
<script src="https://bid.advantage.bid/widgets/marketplace-feed.js"></script>
```
Change `data-preset` to `auctions` or `estate-sales` for the other two pages. Use only ONE feed per page.

## What each widget does (identical across presets)
- **Location** field (free-text: city / ZIP / state / full street address / county) → server geocode →
  resolved point; the resolved place is shown back ("Showing events near …").
- **Distance slider** (5–250 mi, default 50, + Nationwide) directly below Location; updates results on
  release (debounced); keyboard + touch accessible.
- **Use my location** (asks permission only on click; typed field still works if denied).
- **Type filter** (All / Auctions / Estate Sales) — shown only on the All Events preset.
- **Sort**: Nearest (when a location is set) · Ending soon · Recently added.
- **List | Map**: Map hands off to the Railway map carrying the location/filters; the Railway map has a
  reciprocal "List view" link back to `/all-events`.
- Cross-preset **persistence**: the chosen location + radius carry across All Events / Auctions / Estate
  Sales (shared `ab_feed_loc`).
- One shared **event card** (image, type badge, title, general location, date/close, distance, approved
  business branding, CTA). **Private sellers are anonymous; full addresses never shown pre-payment** —
  enforced server-side.

## Placement rules
- Put the H1 / SEO title / intro copy in the BD page (BD owns SEO); the widget uses only h3+ headings —
  it will not fight your page H1.
- Keep the canonical pages `/all-events`, `/auctions`, `/estate-sales` as-is; the widget does not create
  new canonical URLs. Do NOT create native BD event/auction records — the widget is a live display only.
- Recommended: verify **All Events** on an unpublished/preview page first, then publish; then place
  Auctions and Estate Sales.

## Rollback
- Remove the widget/iframe block from the BD page (or unpublish the BD widget). No Railway change needed;
  the platform pages are unaffected.
- Railway rollback (if ever needed): revert `main` to `c4e29c2` (pre-engine) — the `/marketplace/feed`
  and `/geocode` endpoints are additive; nothing else depends on them.

## Notes
- The feed shows results only for **live, eligible** events (published/active + syndicated auctions;
  published estate-sale events). When none are live it shows a friendly "no events — try nationwide"
  state. It populates automatically as sellers publish.
- CORS for `/api/public/*` and `/widgets/*` is `*`; BD (`www.advantage.bid`) can embed and call them.
- The geocoding provider token stays server-side (never in BD or the browser).
