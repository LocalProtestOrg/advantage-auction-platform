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
- **Iframe embedding (framing):** Helmet sets `X-Frame-Options: SAMEORIGIN` site-wide, which blocks
  cross-origin embedding. `src/middleware/widgetFraming.js` makes a scoped exception for `/widgets/*`
  ONLY: it drops `X-Frame-Options` and sets `Content-Security-Policy: frame-ancestors
  https://advantage.bid https://www.advantage.bid`. So only those two BD origins may frame the widgets;
  every other route keeps SAMEORIGIN. Note `advantage.bid` 301-redirects to `www.advantage.bid`, so the
  real parent origin is the `www` host — both are allowlisted. If BD ever serves the embedding page from
  a different origin (e.g. a preview/editor host), add that origin to the list in that middleware.
- The geocoding provider token stays server-side (never in BD or the browser).

---

# Event SEO Architecture (search-engine discovery of every auction & estate sale)

**Design principle:** the BD widget is a *human* discovery/filtering surface; it is **not** the crawl
path. Search engines discover and index each auction and estate sale through the **Railway detail pages
+ the XML sitemap**, which are independent of the widget. The widget being embedded (or not) has zero
effect on indexability.

## Three roles, kept separate

| Layer | Responsibility | Indexable? |
|---|---|---|
| **Railway detail pages** (`/auction-view.html?auctionId=`, `/event.html?slug=`, `/lot.html?lotId=`) | The SEO unit of record: unique title, meta description, canonical, server-rendered content, and Event/Product JSON-LD — all built from Railway data. | **Yes — the canonical indexable pages.** |
| **BD widgets** (All Events / Auctions / Estate Sales) | Human discovery + location/type/sort filtering. Live display only. Embed page is `noindex`. | No (by design). |
| **Listing pages** (`/all-events`, `/auctions`, `/estate-sales`) | Indexable intro copy + normal internal links; a browse entry point. They **do not replace** the detail pages. | Yes (intro/links), but they are not the per-event unit. |

## Canonical URL strategy

- Every auction: `https://bid.advantage.bid/auction-view.html?auctionId=<uuid>` — self-canonical.
- Every estate sale: `https://bid.advantage.bid/event.html?slug=<slug>` — self-canonical.
- Every lot: `https://bid.advantage.bid/lot.html?lotId=<uuid>` — self-canonical.
- `bid.advantage.bid` (Railway) is the **single canonical host** for all event content. BD pages must
  **not** duplicate event records natively; they link to these canonical URLs. Railway = source of truth.

## How it works (server-side, same HTML for every visitor — never bot-only)

- `src/middleware/shareMeta.js` runs before `express.static` on GET of the three detail pages. It is
  fast, fail-open (any error → the static file serves), and:
  - Strips the static fallback tags and injects **entity-specific** `<title>`, `<meta description>`,
    `<link canonical>`, OG/Twitter, and a JSON-LD `<script>` — all from Railway (`shareMetaService`).
  - For estate sales it also **server-renders a privacy-safe summary** (image, `<h1>`, organizer,
    date, city/state, description) into the `#content` mount, so the initial HTML carries meaningful,
    crawlable content. The client SPA overwrites `#content` on load, so humans get the full app while
    crawlers/no-JS get real content. The **same markup is served to every client** — no dynamic
    rendering for bots.
- **JSON-LD** (`schema.org/Event`):
  - Auctions → `eventAttendanceMode: OnlineEventAttendanceMode`, `VirtualLocation`.
  - Estate sales → `eventAttendanceMode: OfflineEventAttendanceMode`, `Place` with a `PostalAddress`
    carrying **only `addressLocality` (city) + `addressRegion` (state)** — never a street address.
  - `eventStatus: EventScheduled`; `startDate`/`endDate`/`image`/`url`/`name`/`description` included;
    `organizer` only when a public organization name exists (never a private individual). `offers`
    (on lots) only when a real price exists.

## Privacy in structured data

Private seller names, emails, phone numbers, and **street addresses are never emitted** in meta tags,
JSON-LD, or the server-rendered summary. Estate-sale location is city + state only. Private-seller
auctions stay anonymous (no organizer name) via the platform's server-side branding rule.

## XML sitemap (`/sitemap.xml`, dynamic)

- Server route in `server.js`, before `express.static`, fed by `shareMetaService.getSitemapEntries()`.
- Lists static marketing pages **plus** every publicly-visible **auction**, **lot**, and
  **estate-sale event** URL, each with `<lastmod>`. Caps: 2000 auctions / 3000 lots / 2000 events.
- **Auto-updates** because it queries Railway live on each request (1-hour cache): a record appears
  when it becomes eligible and drops when it is closed out of eligibility / cancelled / archived —
  no manual regeneration.
  - Auctions: `state IN (published, active, closed)` AND not archived — closed auctions are **kept**
    (useful historical pages).
  - Events: `status = 'published'` — cancelled/archived events (status ≠ published) drop out.
- Referenced by `robots.txt` (`Sitemap: https://bid.advantage.bid/sitemap.xml`). Submit this URL in
  Google Search Console.

## robots / noindex / status behavior

- `public/robots.txt` **allows** `/auction-view.html`, `/event.html`, `/lot.html` and all public
  content (only member/seller/admin/api surfaces are `Disallow`ed). No `noindex` on detail pages.
- **Closed auctions:** remain 200 + indexable + in sitemap (historical value).
- **Cancelled / removed events:** `status` leaves `published` → no rich meta, dropped from sitemap;
  the detail API 404s so the page shows an "unavailable" state (de-indexes over time).

## Verification (run after deploy)

```bash
# Auction detail — unique title + Event JSON-LD (already live)
curl -s "https://bid.advantage.bid/auction-view.html?auctionId=<uuid>" | grep -E "<title>|ld\+json|OnlineEvent"
# Estate-sale detail — unique title + Offline Event JSON-LD + server-rendered <h1>
curl -s "https://bid.advantage.bid/event.html?slug=<slug>"          | grep -E "<title>|ld\+json|OfflineEvent|<h1>"
# Sitemap includes auctions AND events
curl -s "https://bid.advantage.bid/sitemap.xml" | grep -c "auction-view.html\|event.html?slug="
# robots allows them
curl -s "https://bid.advantage.bid/robots.txt" | grep -i "event\|auction\|Sitemap"
```
Paste the event JSON-LD into Google's Rich Results Test — it validates as an `Event`. Unit coverage:
`tests/share-meta.test.js` (42 tests: event meta, privacy, JSON-LD, body injection, sitemap).
