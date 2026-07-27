# Brilliant Directories — Marketplace Embed Guide (production-ready)

**Status:** Increment 9 deliverable. The snippets below are production-ready. Placement inside BD is
**owner-controlled** (the BD Widget Manager is not API-accessible), so this is **not deployed or
tested inside BD** — it ships as exact snippets + a local fixture the owner uses to verify, then
paste into BD.

**Principle — keep BD thin.** BD only *embeds and configures* the shared Advantage widgets. It must
not contain a second implementation of Marketplace discovery. All rendering, data, privacy gating,
and cards live in the platform widgets served from `bid.advantage.bid`.

**Local preview:** `https://bid.advantage.bid/widgets/bd-embed-preview.html` (add `?org=<uuid>` to
exercise the organization-scoped embed). It renders all three configurations against the live
public feeds.

---

## 1. Unified `/all-events` Marketplace (auctions + events, one grid)

```html
<!-- Advantage Marketplace — unified auctions + events feed -->
<link rel="stylesheet" href="https://bid.advantage.bid/marketplace.css?v=1">
<div id="marketplace-feed"></div>
<script src="https://bid.advantage.bid/marketplace-components.js?v=1"></script>
<script src="https://bid.advantage.bid/widgets/marketplace-feed.js?v=1"
        data-api-base="https://bid.advantage.bid"
        data-types="auctions,events"
        data-container="marketplace-feed"></script>
```

Renders every item through one card framework (`makeMarketplaceCard`) with an All / Auctions /
Events filter. Place the `<div id="marketplace-feed">` where the feed should appear.

## 2. City / market-scoped Events

```html
<!-- Advantage Events — one market (e.g. a city page) -->
<div data-advantage-events data-market="houston" data-limit="12"></div>
<script async src="https://bid.advantage.bid/widgets/events.js?v=1"></script>
```

## 3. Organization / company-scoped Events

```html
<!-- Advantage Events — a single organization's listings only -->
<div data-advantage-events data-organization-id="ORGANIZATION_UUID" data-limit="12"></div>
<script async src="https://bid.advantage.bid/widgets/events.js?v=1"></script>
```

Filtering is by a **stable organization UUID**, never by company name. An unknown/invalid id returns
**zero rows** (never another company's events).

---

## 4. Values you must replace

| Snippet | Placeholder | Replace with | Notes |
|---|---|---|---|
| All | `?v=1` | current release version | Cache-buster — see §10. Keep the SAME `v` across the CSS/JS of one release. |
| 1 (unified) | `data-container="marketplace-feed"` + `<div id="marketplace-feed">` | any unique id | Must match; lets you place >1 feed per page. |
| 1 (unified) | `data-types="auctions,events"` | `auctions`, `events`, or both | Drop a type to show only the other. |
| 2 (market) | `data-market="houston"` | a valid market slug (`houston`, `nyc_tristate`) | Must exist in `event_markets`. |
| 2/3 | `data-limit="12"` | 1–48 | Max cards to fetch. |
| 3 (org) | `ORGANIZATION_UUID` | the organization's UUID | From `organizations.id`. Never a name. |

Optional `events.js` attributes: `data-category="estate_sales"`. Optional `marketplace-feed.js`:
`data-api-base` (defaults to the script's own origin when omitted; set it explicitly on BD).

---

## 5. Loading / empty / error states (built in)

All three degrade gracefully with no host-page work:
- **Loading:** the unified feed shows skeleton cards; the events widget shows "Loading events…".
- **Empty:** unified feed → "Nothing to show here yet…"; events → "No upcoming events right now."
- **Error / API unreachable:** unified feed → "The marketplace is unavailable right now…"; events →
  "Events are unavailable right now." A failed request never throws into the host page.

## 6. Responsive behavior

Both widgets are fluid: the unified feed uses the platform `auctions-grid` (auto-fill, min column
width) and the events widget uses an auto-fill grid inside a **shadow root** (CSS fully isolated from
BD's theme — BD styles cannot leak in, and the widget cannot alter BD). They reflow from multi-column
desktop to single-column mobile with no configuration.

## 7. Duplicate-initialization protection

- `events.js`: each `[data-advantage-events]` container initializes at most once (`__abEventsInit`);
  a second script include only re-runs init and skips mounted containers.
- `marketplace-feed.js`: the target container is guarded (`__abMktInit`) so a double-included script
  cannot double-render.

Including a widget script twice is therefore safe (though not recommended).

## 8. No credentials in the browser

The snippets contain **no API keys, tokens, secrets, or admin data**. The widgets call only public,
read-only endpoints (`/api/public/auctions`, `/api/public/featured-auctions`, `/api/public/events`)
that return published, privacy-safe data. Event addresses are gated server-side by the Hide-Address
rules, so a hidden exact address is never sent to the browser regardless of embed.

## 9. CORS / CSP / production-domain configuration

- **Canonical origin:** `https://bid.advantage.bid` serves the widgets, CSS, and public APIs.
- **Auctions feed** (`/api/public/auctions`, `/api/public/featured-auctions`): CORS `*` — embeddable
  from any origin.
- **Events feed** (`/api/public/events`): CORS is **restricted to an allow-list**
  (`EVENTS_ALLOWED_ORIGINS`, default `https://advantage.bid, https://www.advantage.bid, localhost`).
  - **BD pages on `www.advantage.bid` work out of the box** (already on the list), so snippets 1–3
    function on BD `/all-events`, city pages, and company profile pages hosted by BD.
  - **A company's own external domain** embedding snippet 3 needs either (a) that domain added to
    `EVENTS_ALLOWED_ORIGINS` (env, comma-separated), or (b) an **owner decision** to relax the events
    feed to CORS `*` to match the auctions feed (the data is already public + privacy-safe). This is
    a trust-boundary change and is intentionally left to the owner — not changed here.
- **CSP:** BD's CSP is permissive (`script-src https:`, `connect-src *`), so loading the widget
  scripts and fetching the feeds is allowed. If a host tightens CSP, allow `script-src` +
  `connect-src` for `https://bid.advantage.bid` and `style-src` for the widget CSS/inline styles.

## 10. Cache-versioning

Widget assets are static files served from the platform and may be cached by browsers/CDN. To release
an update reliably, **bump the `?v=` query string** on every widget URL in the snippet
(`marketplace-components.js?v=2`, `widgets/marketplace-feed.js?v=2`, `widgets/events.js?v=2`, and the
CSS). Because the query string changes the effective URL, clients fetch the new file immediately while
old cached copies expire naturally. Each widget also stamps its version on `window`
(`__ADV_MARKETPLACE_FEED__`, `__ADV_EVENTS_WIDGET__`) so you can confirm which version a BD page loaded
from the browser console. Keep the `v` identical across all assets of a single release.

---

## Owner action checklist (BD side)

1. Preview locally at `bid.advantage.bid/widgets/bd-embed-preview.html` (+ `?org=<uuid>`).
2. Paste snippet 1 into the BD `/all-events` content region (below the intro; do not remove existing
   content). Optionally retire the older auctions-only embed once the unified feed is confirmed.
3. Paste snippet 2 on city/market pages; snippet 3 on company profile pages (with each company's
   organization UUID).
4. On release, bump `?v=` everywhere.
5. If embedding snippet 3 on non-`advantage.bid` domains, decide the events-feed CORS posture (§9).
