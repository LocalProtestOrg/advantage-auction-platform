# Marketplace Integrity Architecture (Phase 6A)

**Status:** ACTIVE — permanent engineering standard.
**Owner-approved:** yes. **First shipped:** 2026-08-06.

---

## 1. The rule (non-negotiable)

There is **ONE authoritative source of public marketplace information**. Data flows in exactly one
direction, and every public experience consumes the same canonical public APIs:

```
Importer / native creation
        ↓
Canonical Marketplace/Event Database   (events, auctions)
        ↓
Canonical Public APIs                  (/api/public/*)
        ↓
ALL public experiences
  homepage · map · list · search · auctions · estate sales · marketplace · featured ·
  city/state pages · company/professional/org pages · widgets · Railway · Brilliant Directories ·
  mobile · future apps · future APIs · sitemaps · RSS · JSON-LD · OpenGraph · schema.org
```

**No page may bypass the canonical public API.** No page may query database tables directly because
it is easier, maintain its own filtering logic, calculate counts differently, or apply different
publication rules. Every surface consumes the same canonical APIs, which apply the same single
definition of "publicly listable".

## 2. The single definition of "publicly listable"

`src/lib/marketplaceVisibility.js` is the **one place** visibility is defined. Never re-implement it.

- **Events** (`events` table): `status = 'published' AND (end_at IS NULL OR end_at >= now())`
  — via `activeEventSql(alias)`. Type: `sale_type='auction'` → `auction`, else `estate_sale`
  (`eventKindSql`). The geographic map additionally requires `lat/lng IS NOT NULL` (online events are
  correctly list-only, never given fabricated pins).
- **Native auctions** (`auctions` table): `state IN ('published','active') AND is_archived IS NOT TRUE
  AND marketplace_status = 'syndicated'` — via `activeNativeAuctionSql(alias)`.
- `canonicalCounts(db)` produces the authoritative tally + the exact per-API expectations the
  integrity suite asserts (`feed_all_events`, `feed_auctions`, `feed_estate_sales`, `map_auction`,
  `map_estate_sale`).

All future listing code MUST import these fragments/counts. A new surface that re-implements the
predicate will diverge and the Integrity Suite will fail the deployment.

## 3. Canonical public APIs (the only retrieval path)

| API | Purpose | Visibility source |
|---|---|---|
| `GET /api/public/marketplace/feed?preset=all-events\|auctions\|estate-sales` | The unified list feed (native auctions ∪ events); powers BD `/all-events`, `/auctions`, `/estate-sales`, homepage drawer | canonical predicates |
| `GET /api/public/events` | Event list (incl. coordless online auctions) | `activeEventSql` |
| `GET /api/public/events/map` | Map markers (events **with coordinates** only) | `activeEventSql` + coords |
| `GET /api/public/auctions*` | Native auction discovery | `activeNativeAuctionSql` |
| `GET /api/public/marketplace*` | Company/professional pins & profiles | org visibility rules |

Presets are **server-enforced** (`FEED_PRESET_TYPE`) so a tampered request can never widen a
type-locked surface. Individual/private identity is anonymized by `sellerBranding` /
`organizerPrivacy` inside these APIs — never at the page layer.

## 4. Audit report (2026-08-06)

- **Every public HTML page and widget consumes `/api/public/*`** (static pages fetch the API client-
  side; none query the DB directly). The API-only rule is enforced by architecture for the frontend.
- **Duplication found & removed:** the two visibility predicates were repeated as raw SQL across
  `public.js`, `publicEvents.js`, and `eventImport/health.js`. They are now defined once in
  `marketplaceVisibility.js`; `health.js` (the monitoring path) consumes it, and the Integrity Suite
  holds every route's *effective* counts to the canonical tally regardless of local SQL.
- **Count parity verified live (prod):** canonical DB tally == `/marketplace/feed` (all presets) ==
  `/events/map` counts. Sitemap + event-detail canonical + `Event` JSON-LD present. Overall **PASS**.
- **Map exclusion is correct, not a leak:** online auctions have no coordinates → excluded from
  `/events/map` by design and surfaced list-only elsewhere (ratified no-fake-pins policy).

## 5. Marketplace Integrity Suite

`src/services/marketplaceIntegrity.js` → `verify({ db, baseUrl, live })`. Count parity is the
strongest single signal:

- API count **> canonical** ⇒ a hidden/private/expired listing **leaked** ⇒ **FAIL**.
- API count **< canonical** ⇒ a professional/valid listing **is missing** ⇒ **FAIL**.
- A surface with **different filtering** ⇒ its count diverges ⇒ **FAIL**.

Checks: `feed:all-events`, `feed:auctions`, `feed:estate-sales`, `map:auction`, `map:estate_sale`
(exact-equality counts); `feed:pagination` (total ≥ page, pageSize honored); `feed:classification`
(only `auction|estate_sale`); `seo:sitemap` (200 + entries); `seo:event-detail` (canonical + `Event`
JSON-LD). Live HTTP checks degrade to **WARNING** when a URL is unreachable (transient), but a
definitively-broken surface **FAILS**. `formatReport()` renders the PASS/WARNING/FAIL report.

## 6. Deployment gate

```
npm run gate        # jest unit suite + integrity suite (--strict: WARNING also fails) → non-zero on FAIL
npm run integrity   # integrity suite only, against PUBLIC_BASE_URL (or --base <url>)
npm run integrity:db# canonical DB tally only (no HTTP)
```

`scripts/marketplace-integrity.js` exits non-zero on FAIL, so it gates CI / pre-promote / post-deploy
smoke. **Do not promote a build whose gate is red.** Recommended flow: deploy → run
`node scripts/marketplace-integrity.js --base <deployed-url>` → promote only on PASS.

## 7. Continuous monitoring

The scheduled Railway worker's health check (`eventImportWorker.runHealthCheck`) runs the Integrity
Suite every cycle when `EVENT_INTEGRITY_MONITOR_ENABLED=true` (+ `PUBLIC_BASE_URL`). Every scheduled
importer run therefore re-verifies importer health, event/auction/estate counts, feeds, APIs, schema,
sitemap, pagination, and map listings. Anomalies are logged (`marketplace_integrity` log line) and
audited (`marketplace_integrity_warning` / `marketplace_integrity_fail`) — never crashing the worker.

## 8. Permanent engineering standard (all future work)

1. **Read from the canonical public APIs only.** Never add a second retrieval path, a direct DB query
   for a public surface, or a re-implemented visibility/count rule.
2. **Import visibility from `marketplaceVisibility.js`.** Extend it in ONE place if the rule changes.
3. **Add a surface to the Integrity Suite** when you add a public listing surface, with an exact
   count expectation derived from `canonicalCounts`.
4. **The gate must be green to deploy.** A new duplicate-retrieval path will diverge and fail the
   suite — that is the intended backstop against architectural drift.
5. **Backward-compatible only:** keep current URLs, SEO, structured data, and Google/AI
   discoverability. Prefer improving existing code over replacing it.
