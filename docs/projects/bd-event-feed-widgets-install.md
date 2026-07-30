# BD Event-Feed Widgets — Install Package (All Events · Auctions · Estate Sales)

**One Railway engine, three presets.** All three "widgets" are the SAME `marketplace-feed.js` engine with
a different `preset` — the SERVER enforces the event type, so a visitor can't widen a preset. No duplicate
code, no duplicate data, no Railway secrets in BD.

**BD API is read-only (GET-only) — I cannot create Widget Manager widgets programmatically.** These are
the exact copy-paste blocks + placement for the owner to add in BD.

## Recommended embed: IFRAME (in the widget) + helper script (in Footer Scripts)

**Important — how BD treats pasted markup:** BD's content editor **strips `<script>` tags and custom
attributes** (`id`, `data-*`) from widget HTML. So the helper CANNOT live inside the widget content, and
the iframe cannot be relied on to keep an `id`. The helper therefore (a) is loaded once from BD **Footer
Scripts** (which allows scripts) and (b) finds the widget iframe by its **`src`** (which BD preserves).

**Step A — the widget (BD Custom Widget → HTML tab), one per page.** Just the iframe:

### 1. Advantage All Events → page `/all-events`
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events"
        title="Advantage.Bid — All Events" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
```

### 2. Advantage Auctions Only → page `/auctions`
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=auctions"
        title="Advantage.Bid — Auctions" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
```

### 3. Advantage Estate Sales Only → page `/estate-sales`
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=estate-sales"
        title="Advantage.Bid — Estate Sales" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
```

**Step B — the helper (once, in BD Footer Scripts / a script-allowed area).** This is what makes the
iframe auto-size and the page scroll to the results on paging. Add it once for the whole site:
```html
<!-- Optional: clear a sticky BD header on the paging scroll. Inspect your real header height and set it
     here (the helper also auto-detects a sticky/fixed header if you omit this): -->
<script>window.ADV_SCROLL_OFFSET = 190;</script>
<script src="https://bid.advantage.bid/widgets/marketplace-embed.js"></script>
```

The helper listens for `postMessage` from the widget and (a) sets the iframe's exact height so it never
grows its own scrollbar, and (b) after a pagination click, smooth-scrolls the **main BD page** to the top
of the widget/results. It finds the iframe by `src` (so BD stripping `id`/attributes is fine), routes each
message to the matching iframe by `event.source`, sets `overflow-anchor:none` on the iframe so a growing
height can't pin the viewport, and scrolls after two animation frames plus one re-assert (to absorb late
image-load resizes). It is idempotent and multi-iframe safe.

**Security:** it trusts a message ONLY when `event.origin === https://bid.advantage.bid`, it comes from one
of THIS page's widget iframes (`event.source` match), and it carries the expected `source`/`type`/`widget`
fields. No wildcard trust; it never reads the widget's cross-origin DOM.

> **Geolocation:** `allow="geolocation"` lets the cross-origin iframe use "Use my location" (the typed
> Location field works regardless). `style="width:100%"` keeps it responsive full-width. `min-height` is
> only the pre-resize floor; the helper then sets the exact height.
> **Scroll offset precedence:** `window.ADV_SCROLL_OFFSET` → `data-adv-scroll-offset` on the iframe/html
> (if BD keeps it) → auto-detected sticky-header height → 0. A small 12px breathing room is always added.

### Fully-inline alternative (if you can put a `<script>` right next to the iframe)
Only works where BD does NOT strip scripts (e.g., a raw-HTML block). Give the iframe an `id` and:
```html
<iframe id="adv-all-events" src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events"
        title="Advantage.Bid — All Events" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
<script>
(function () {
  var FRAME = document.getElementById('adv-all-events');
  var ORIGIN = 'https://bid.advantage.bid', MIN = 400, MAX = 20000, OFFSET = 190; // px header offset
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;                          // strict origin
    if (!FRAME || e.source !== FRAME.contentWindow) return;    // must be THIS iframe
    var d = e.data;
    if (!d || d.source !== 'advantage-bid-widget' || d.widget !== 'marketplace-feed') return;
    if (d.type === 'resize') {
      var h = parseInt(d.height, 10); if (!isFinite(h)) return;
      FRAME.style.overflowAnchor = 'none'; FRAME.style.minHeight = '0px';
      FRAME.style.height = Math.max(MIN, Math.min(MAX, h)) + 'px';
    } else if (d.type === 'scroll-to-widget') {
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        var y = FRAME.getBoundingClientRect().top + window.scrollY - OFFSET;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }); });
    }
  }, false);
})();
</script>
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
- **Pagination (List view):** true numbered pagination — `Previous 1 2 … Next`, **12 cards per page**
  (centralized: `FEED_PAGE_SIZE` in `src/routes/public.js` and `PAGE_SIZE` in the widget). The API
  paginates at the query level (`?page=&pageSize=`, `LIMIT/OFFSET` + `COUNT(*) OVER()`) and returns
  `pagination { currentPage, pageSize, totalItems, totalPages, hasPreviousPage, hasNextPage }` (legacy
  `total/offset/limit/has_more` kept). Any filter/search/sort/location/radius change resets to page 1;
  changing pages preserves preset + all filters and writes `?page=` into the iframe URL (refresh/back
  keeps the page). Page changes scroll to the top of the result area **within the iframe only** (never
  the parent BD page). No infinite scroll, no Load-More.
- **Pagination × Map:** the **List** view is paginated (12/page). The **Map** is a separate Railway
  view that loads its own bounded dataset (`/api/public/auctions`, capped at 60) — it is NOT the feed
  endpoint and does NOT paginate; it shows all matching pins in the area, which is the correct map UX.
  The List→Map hand-off carries location/radius/type/sort but deliberately **omits `page`** (a map of
  one arbitrary 12-item page would be misleading). No unbounded map request is ever created.

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

---

# Featured Items Available Now — BD embed (reuses the Event Feed embed stack)

Separate widget, same proven iframe + `postMessage` + dynamic-height + parent-scroll architecture. It
shows ranked, diversified ACTIVE auction lots and links each card to the canonical Railway lot page.
Railway (`/api/public/discovery/items`) is the sole source of truth; the crawlable page is `/items`.

**No new Footer Script is required.** The `marketplace-embed.js` helper you already added to BD Footer
Scripts now also powers this widget (it detects the iframe by `src` and accepts `widget:"featured-items"`).
Existing Event Feed widgets are unaffected.

**Widget (BD Custom Widget → HTML tab), placed at the bottom of the target page:**
```html
<iframe src="https://bid.advantage.bid/widgets/featured-items.html?placement=event_feed_footer"
        title="Advantage.Bid — Featured Items Available Now" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
```
`placement` may be `event_feed_footer` · `auctions_footer` · `estate_sales_footer` · `homepage` ·
`standalone` (the server validates it and caps pagination at 6 pages / 72 items regardless of input).
**V1 note:** `placement` currently affects only analytics segmentation and server-side cache
partitioning — it does **not** change which items appear, their ranking, or the layout. Every placement
returns the same ranked inventory. It is a deliberate future extension point (later versions may make
discovery placement-aware — e.g. homepage diversity, category emphasis, city relevance, or
personalization — without changing this embed code).
Height auto-fits and the page scrolls to the results on paging via the existing footer helper. While no
eligible live inventory exists, the widget shows the approved empty state (a link to active auctions).
