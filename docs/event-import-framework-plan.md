# Event Import Framework — Architecture & Implementation Plan (V1)

**Repository path:** `docs/event-import-framework-plan.md`
**Status:** APPROVED ARCHITECTURE — pending Commit 0
**Base commit:** `ad04488` — *fix(widgets): stop iframe resize feedback loop (measure true content height)*
**Branch:** `feat/unified-member-experience`
**Owner decisions recorded:** 2026-07-30

---

## 1. Objective & scope

A production-grade framework that continuously grows Advantage.bid with real estate sales and auctions from approved, authorized data sources. Version 1 runs weekly, imports at most 75 new events per run, never duplicates, and permanently retains provenance back to the original source.

CSV is the first connector **only** to prove the pipeline end to end. The deliverable is the framework, not a CSV importer.

---

## 2. Canonical storage (FINAL)

Railway is the **only** canonical home for imported events. Imported events are rows in the Railway `events` table.

- **No native Brilliant Directories event posts are created — ever.** BD displays imported events through widgets, embeds, API-fed feeds, and SEO pages that read live from `bid.advantage.bid`.
- There must never be duplicate event records in BD.
- Visitors should never perceive two systems: imported events appear in the combined feeds, search, filters, maps, and detail pages exactly like native events.
- The original host website remains the destination for registration, bidding, and full host details.

This is consistent with `CLAUDE.md` § *Canonical Auction Distribution Architecture* ("one canonical record", "no duplicate external storage") and requires no owner exception.

---

## 3. Ownership & attribution mapping (FINAL)

**BD Member ID 5 is not AAC and must not be used.** Verified live against advantage.bid (site 15779):

```
user_id 5  → "Admin User -  Blog Author" · sample3@sample.com · company: (empty)
             New York, NY · subscription_id 4 · ref_code "Manually Added"
             signup 2015-12-29 · last_login 2021-06-29
             → a Brilliant Directories stock sample record
                (sibling of user_id 4 "Sample General User" / sample2@sample.com)

user_id 28 → company "AAC" · tylerwitt2015@gmail.com · profession_id 4 (Estate Liquidator)
             New York, NY · subscription_id 1
             /united-states/new-york/estate-liquidator/aac
             → the apparent real AAC identity
```
A `company contains "Advantage"` scan of all 347 BD members returns zero rows.

**Mapping model — three identities, one row, zero hardcoded IDs:**

| Identity | Where it lives | How it is set |
|---|---|---|
| Railway organization (canonical owner) | `organizations.id` | verified by query before any write |
| BD member (display/attribution) | `organizations.bd_listing_id` | set to the verified BD member id (expected `'28'`) |
| Import service owner | `import_sources.owner_organization_id` FK → `organizations.id` | seeded from the verified row |

Every imported event sets `organization_id` = the verified AAC organization, `source = 'imported'`, plus `attribution_source` / `attribution_url` pointing at the original host.

**If the correct AAC Railway organization does not exist, the build stops and reports exactly what is missing** — the importer will not create it unilaterally. The report will state: whether any `organizations` row carries `bd_listing_id = '28'`; whether a name/slug match exists under a different lifecycle state; and which fields a new row would need (`slug`, `name`, `type`, `lifecycle_state`, `plan_tier`, `bd_listing_id`, contact fields). Creation happens only on your explicit approval, via a dry-run-default, prod-guarded seed script — never inline in application code.

**Verification gate (blocking Phase 1):** run and confirm before any record is created —

```sql
SELECT id, slug, name, type, lifecycle_state, source, bd_listing_id,
       verification_status, plan_tier, linked_seller_profile_id, city, state
  FROM organizations
 WHERE bd_listing_id IN ('5','28')
    OR name ILIKE '%advantage%' OR slug ILIKE '%advantage%' OR name ILIKE 'AAC%'
 ORDER BY created_at;
```

If no AAC organization exists, Commit 1 includes a **seed script** (dry-run default, prod-guarded) that creates it — never an inline UUID literal. No UUID is hardcoded anywhere in the codebase; the importer resolves its owner through `import_sources.owner_organization_id` at runtime.

---

## 4. Plan quotas (FINAL)

Imported events are platform inventory, not seller-created content. **They must not consume seller plan quotas.**

Today `eventsService.submit()` enforces `ACTIVE_EVENT_LIMIT` from `organization_plans.max_active_events` (3 / 10 / 25) and `addImage()` enforces `IMAGE_LIMIT` (10 / 25 / 50). At 75 events/week the AAC organization would exhaust the 25-active ceiling in run one.

**Resolution:** the importer runs on its own service path (`eventImport/writer.js` → `createImported()` / `publishImported()`) that does not call `createDraft`/`submit`/`addImage` and therefore never reads `organization_plans`. Seller subscription plans are completely unaffected — no existing code path changes.

Importer limits are configurable per source in `import_sources`, not in code:

| Limit | Column | Default |
|---|---|---|
| Weekly cap per source | `weekly_cap` | 75 |
| Daily cap per source | `daily_cap` | NULL (unused in V1; weekly-only schedule) |
| Images per event | `max_images_per_event` | 40 |
| Outbound request rate | `rate_limit_per_min` | 60 |
| Publish behavior | `auto_publish` | FALSE |

A global ceiling of 75 creates per scheduled run applies across all sources. Caps count **creates only** — updates and re-syncs are free. When a cap truncates a run, `import_runs.capped = TRUE` and `remaining_available` is recorded; truncation is never silent.

---

## 5. Event lifecycle & public expiration (FINAL)

### 5.1 Routing audit — every public surface that reads `events`

| # | Surface | Current filter | Expires today? |
|---|---|---|---|
| 1 | `GET /api/public/events` (feed, maps, upcoming, filters) — `publicEvents.js:67` | `status='published' AND (end_at IS NULL OR end_at >= now())` | **Yes** |
| 2 | Combined marketplace feed (auctions ∪ estate sales, distance/radius search) — `public.js:440` | `e.status='published' AND (e.end_at IS NULL OR e.end_at >= now())` | **Yes** |
| 3 | `GET /api/public/events/:slug` (detail) — `publicEvents.js:99` | `WHERE e.slug=$1 AND e.status='published'` | **No — no date filter** |
| 4 | `shareMetaService.getEventMeta()` → OG / Twitter / Event JSON-LD | `WHERE e.slug=$1 AND e.status='published'` | **No** |
| 5 | `shareMeta` middleware server-rendered event body injected into `/event.html` (`kind:'event'`, `idParams:['slug']`) | follows #4 | **No** |
| 6 | `shareMetaService.getSitemapEntries().events` → `/sitemap.xml` | `status='published' AND slug IS NOT NULL`, capped 2000 — with the explicit comment *"The detail page 200s for any published event (ended ones included, for historical value), so all are safe to list."* | **No** |
| 7 | Featured Items (`discoveryService`) | lots only — `events` never queried | **N/A** (events never appear) |

So feeds, maps, search, and upcoming views already expire correctly on `end_at`. **The gap is exactly four places — #3, #4, #5, #6 — and three of them share one condition.**

### 5.2 Recommendation: **A (expired stub) + `noindex` + sitemap removal**, with 410 reserved for source-removed events

| Option | Verdict |
|---|---|
| **C — redirect to active events** | **Reject as primary.** Many distinct URLs collapsing onto one page is the textbook soft-404 pattern; search engines treat it as a redirect quality problem, and a 301 permanently reassigns a URL we still own. It also strands the visitor with no answer to "did this sale happen?" |
| **B — HTTP 410 Gone** | **Reserve, don't default.** 410 is the strongest removal signal, but it is a dead end for a real person arriving from a bookmark, a shared link, or a search result that hasn't refreshed. Correct for content that should never have existed or that the source retracted — not for a sale that simply ended. |
| **A — expired stub page, `noindex`, out of sitemap** | **Recommended.** Serves no copied source content, gives the visitor a real answer plus a path forward, and `noindex` + sitemap removal is the canonical way to de-index a URL you still serve. Nothing stale, nothing broken. |

**Behavior after `end_at` passes, for `source='imported'` events:**

- `GET /api/public/events/:slug` returns `200` with a deliberately minimal payload — `{ expired: true, slug, city, state, market_slug }`. **No title, description, images, organizer, terms, or source URLs.** Zero third-party content is served after expiry.
- `/event.html` renders "This sale has ended." plus links to active events in that market. `shareMeta` emits `<meta name="robots" content="noindex,follow">` and skips the server-rendered body; `getEventMeta()` returns `null`, so no Event JSON-LD, OG, or Twitter Card is generated.
- The slug is dropped from `/sitemap.xml` (one added clause in the events query).
- **`410 Gone`** is returned instead when `event_sources.sync_status = 'removed'` — the source retracted the listing, so the URL is genuinely gone.

**Scope:** the expiry gate applies to `source='imported'` only. Organization- and admin-created events keep today's behavior (ended detail pages stay live "for historical value" per the existing code comment) — changing that is a separate product decision outside this initiative, and the clause is written so it can be widened in one line later.

### 5.3 Internal retention (unchanged)

The `events` row, `event_sources` provenance, `content_hash` / `images_hash`, `import_runs` / `import_run_items` history, and all `audit_log` entries are retained in full. Nothing is deleted. `archived` remains a deliberate admin action, never an automatic side effect — consistent with `docs/past-auctions-archiving-policy.md`. Admin views show expired imported events normally.

### 5.4 The normalizer's obligation

`end_at` is nullable, and `end_at IS NULL` means **never expires** — the single most dangerous default in this design. The normalizer therefore **always derives a reliable `end_at`**: from the source when supplied; otherwise end of the local start day (single-day sale), last listed day (multi-day), or final close time (auction closing schedule), resolved in the event's `timezone`. **An imported event with no computable end date fails the quality gate, is recorded as `rejected_quality` in `import_run_items`, and is never published.**

No second lifecycle is introduced — expiry is the existing `end_at` rule, extended to the four surfaces that don't yet honor it.

---

## 6. Market resolution (FINAL)

**How it works today.** `events.market_slug TEXT NOT NULL REFERENCES event_markets(slug)`. `event_markets(id, slug UNIQUE, name, is_active, sort_order, center_lat, center_lng, radius_km, created_at)` is seeded with exactly two rows — `houston`, `nyc_tristate`. `GET /api/public/events?market=` returns 400 `UNKNOWN_MARKET` for anything unseeded. The geo columns exist but are unused (`local-events-architecture.md` §13.9). Markets are curated by intent — they are a merchandising surface (feed tabs, widget presets, `sort_order`), not a geocoding artifact.

**Design — curated markets, resilient resolution, admin-gated growth:**

1. Seed a permanent fallback market `national` → "Nationwide", `is_active = FALSE`, `sort_order = 9999`. Inactive keeps it out of the public market picker; `market_slug='national'` events still appear in unfiltered feeds, search, maps, and the sitemap.
2. `marketResolverService.resolve({ lat, lng, zip, city, state })` — first match wins:
   - **radius** — great-circle distance against active markets' `center_lat` / `center_lng` / `radius_km` (activates the reserved columns; no new schema),
   - **ZIP prefix** — `event_market_zips` lookup,
   - **city + state** exact match,
   - **`national`** fallback.
   Returns `{ marketSlug, via }`; `via` is persisted per event (`events.market_resolved_via`) and aggregated per run.
3. **Metro discovery queue** — every `fallback` increments a counter in `market_candidates` keyed on normalized `city|state`. The admin dashboard shows e.g. "Phoenix, AZ — 14 events in `national`" with a one-click **Create market** that seeds `event_markets` (name, center, radius) and re-runs the resolver over `national` events to reassign them.
4. Backfill `center_lat` / `center_lng` / `radius_km` for `houston` and `nyc_tristate` (currently NULL, so radius matching would otherwise no-op).

**Hundreds of markets are never auto-created. Imports never fail on geography.**

---

## 7. Import workflow (FINAL)

Imported events land in Railway with `status = 'draft'`, `source = 'imported'`. Nothing publishes automatically in V1 (`import_sources.auto_publish` exists, defaults FALSE, and is the future promotion path for a proven licensed feed).

**Import Review Queue** — editorial control without one-by-one review:

| Action | Endpoint | Behavior |
|---|---|---|
| Browse | `GET /api/admin/event-imports/queue` | draft imported events; filter by source, run, market, state, date range, `possible_duplicate`; returns a stable `total` |
| Bulk Approve / Publish | `POST …/queue/bulk-publish` | `{ ids: [...] }` or `{ filter: {...}, expectedCount: N }`; chunked transactions; one audit row per event |
| Bulk Reject | `POST …/queue/bulk-reject` | `{ ids \| filter, reason }` — reason required, matching `adminReject` |
| Edit Before Publish | `PATCH …/queue/:id` | admin-editable allowlist on an imported draft (title, subtitle, description, category, market, dates, hours, address, URLs, terms), audited |
| Approve All | `POST …/queue/approve-all` | scoped to a run or source; requires `expectedCount`; refuses on mismatch so a drifting filter can't publish more than the admin saw |

Publishing routes through `publishImported()`, which permits `draft → published` for `source='imported'` alongside the existing `submitted → published`, bypasses plan quotas (§4), and writes `event.published` audit rows. Owner and partner paths are untouched.

---

## 8. Connector framework (FINAL)

Eleven decoupled stages. A new source implements a connector (and usually a declarative field map) and touches nothing else.

```
Connector → Parser → Normalizer → Quality Gate → Duplicate Detection →
Geocoder → Market Resolver → Event Writer → Image Pipeline →
Search/Index (inherited) → Logging & Run Ledger
                                   ↑
                              Scheduler drives the whole chain
```

```
src/services/eventImport/
  index.js                 runImport({ sourceKey, apply, limit, trigger })   ← the engine
  pipeline.js              stage orchestration + per-record error isolation
  connectors/
    index.js               registry: csv | rest | rss | xml | json | partner | manual
    csvConnector.js        V1 proof of concept
    _template.js           documented skeleton for the next connector
  parsers/                 csv.js   (later: rss.js, xml.js, jsonPath.js)
  normalize/
    canonical.js           CanonicalEvent shape + sanitizer primitives
    fieldMap.js            declarative source-field → canonical-field mapping
  validate.js              quality gates (required fields, date sanity, computable end_at)
  dedupe.js                4-tier match ladder + content-hash change detection
  marketResolver.js        §6
  geocode.js               shouldGeocode + outbound throttle + fingerprint persistence
  writer.js                createImported / updateImported / publishImported
  media/{policy.js,ingest.js}
  runLog.js                run + per-record ledger, counters, structured log line
  rateLimit.js             outbound token bucket (the platform has none today)
```

**Connector contract — the entire surface a new source implements:**

```js
module.exports = {
  key: 'csv',
  kind: 'csv',                        // csv | rest | rss | xml | json | partner | manual
  capabilities: {
    incremental: false,               // supports `since` / cursor
    deletions:   true,                // a full pass is authoritative → enables removal reconciliation
    images:      true,
  },
  async *fetch({ config, since, cursor, limit, signal }) {   // async generator — never materializes a whole feed
    yield {
      sourceEventId:   '…',           // REQUIRED — the idempotency key
      sourceUrl:       'https://…',   // REQUIRED — attribution target
      sourceUpdatedAt: '2026-07-28T…',
      payload:         { /* raw, verbatim */ },
      images:          [{ url, position, caption }],
    };
  },
  describe() { return { name: 'CSV upload', docs: '…' }; },
};
```

Adding a REST partner later = one `fetch()` + one field map + one `import_sources` row. **No pipeline change, no schema change, no dashboard change.**

**The source registry lives in the database, not in code** (`import_sources`): kind, `config JSONB`, `auth_env_var` (the *name* of an env var — never a secret), caps, `media_policy`, `auto_publish`, `terms_attested_by/at/url`, `incremental_cursor`, `owner_organization_id`, status.

**Compliance is a runtime gate, not a memo:** `media_policy` defaults to `link_only`, and `terms_attested_*` must be non-null before a source can become `active`. This encodes the existing decisions — *"Recommended path is NOT public scraping"*, *"no scraping … respect source ToS"*, *"do not copy or hotlink … images … without confirmed rights"*. No source is crawled unless it explicitly permits crawling or syndication.

---

## 9. Scheduler

A forked worker following the proven `directorySyncWorker` pattern, with a real run claim:

```
src/workers/eventImportWorker.js
  • 60 s setInterval tick — no new dependency, matches house style
  • due(): Intl-based, DST-aware — weekly, Monday 03:00 America/New_York
  • enabled(env): pure function — false if EVENT_IMPORT_DISABLED=true;
                  true if NODE_ENV=production or EVENT_IMPORT_ENABLED=true
  • stays alive when disabled (no respawn loop); tick() never throws
  • run claim: INSERT INTO import_runs (source_id, scheduled_for, trigger='scheduled')
      with UNIQUE (source_id, scheduled_for) WHERE trigger='scheduled'
      → conflict means another replica owns this week. True mutual exclusion,
        unlike the audit-log read-back the BD sync relies on.
  • installs its own SIGTERM handler and drains the current source — an
    improvement over the three existing workers, which do not
  • spawned from server.js alongside the existing three workers
```

Rejected alternatives: `node-cron` / `bullmq` / `agenda` (new dependency, and bullmq needs Redis, to replicate a 25-line in-repo pattern); a Railway cron service (second service + deployment change; the repo has no `railway.json`/`Procfile`); `setInterval` in the web process (no isolation). The worker is a thin wrapper over `runImport()`, so a cron entrypoint remains a drop-in later.

**Manual trigger is first-class:** `POST /api/admin/event-imports/runs` (dry-run default, `?apply=true` to write) calls the identical engine with `trigger='manual'` — ops is never blocked on the clock, and staging validation doesn't depend on it.

---

## 10. Database changes (additive only — migrations 097–101)

Every migration is `CREATE TABLE/INDEX IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`, ships with `stg-migrate-0NN.js` / `prod-migrate-0NN.js` / `rollback-0NN.js`, and alters **no** auction, bid, payment, or seller table. Highest existing migration is `096` (093 is reserved/absent).

**097 — `import_sources`** — the registry (§8), incl. caps, media policy, terms attestation, `owner_organization_id`.

**098 — `import_runs` + `import_run_items`** — dashboard data and the per-record dead-letter trail the BD importer lacks.
- `import_runs(id, source_id, trigger CHECK('scheduled','manual','backfill'), scheduled_for DATE, status CHECK('running','completed','partial','failed'), fetched, eligible, created, updated, skipped_duplicate, skipped_quality, skipped_ambiguous, images_queued, failed, capped, remaining_available, started_at, finished_at, duration_ms, last_error, stats JSONB)`
- `UNIQUE (source_id, scheduled_for) WHERE trigger='scheduled'` ← the weekly run claim
- `import_run_items(run_id, source_event_id, event_id, outcome CHECK('created','updated','unchanged','duplicate','ambiguous','rejected_quality','failed'), match_via, market_via, reason, error, raw_excerpt JSONB)` — one bad row no longer aborts a run

**099 — `event_sources`** — provenance, one row per (source, external id); supports the same event arriving from two sources.
- `event_id, source_id, source_event_id, source_url, source_url_hash, source_updated_at, content_hash, images_hash, first_imported_at, last_synced_at, sync_status CHECK('active','removed'), raw_payload JSONB`
- `UNIQUE (source_id, source_event_id)` ← the idempotent upsert target · `UNIQUE (source_id, source_url_hash)` · index on `content_hash`
- Satisfies the permanent-reference requirement: original source, original URL, original ID, import timestamp, last-sync timestamp.

**100 — canonical field additions** (fills the 12-field gap identified in the audit).
- `events`: `subtitle, sale_type CHECK('estate_sale','auction','other'), event_format CHECK('online','live','hybrid'), organizer_name, organizer_logo_url, organizer_website_url, contact_name, contact_phone, contact_email, registration_url, bidding_url, sale_hours JSONB, preview_start, preview_end, pickup_start, pickup_end, closing_schedule JSONB, shipping_available, local_pickup_available, buyer_premium_bps, payment_methods TEXT[], terms_text, tags TEXT[], categories TEXT[], source_last_updated_at, content_hash, market_resolved_via, geocoding_status, geocoding_source, location_fingerprint, geocoded_at`
  - `buyer_premium_bps` in basis points to match `auctions.buyer_premium_bps` (067)
  - geocoding columns mirror `auctions` (090) so `shouldGeocode()` works unchanged — fixes the "re-geocode everything every run" flaw in the BD sync
  - `category_slug` stays primary (no read-path change); `categories TEXT[]` carries secondaries
- `event_images`: `source_url, content_hash, public_id, width, height, alt_text`; `UNIQUE (event_id, content_hash)`; `UNIQUE (event_id, position)`
- `events.source` is **not** widened — `'imported'` already exists; *which* source is `event_sources`' job

**101 — market resolution** — seed `national` (inactive), backfill center/radius for the two live markets, create `event_market_zips` and `market_candidates`.

**Not doing:** PostGIS (great-circle SQL suffices at this scale); reusing `image_processing_jobs` (no attempts/lease/backoff — V1 adds `event_image_jobs` modeled on `notifications_queue`, the house gold standard).

---

## 11. Duplicate detection & synchronization

**Match ladder** — first match wins; ambiguity is skipped and logged, never guessed:

1. `(source_id, source_event_id)` → unique constraint → update path
2. Normalized `source_url` hash (strip `utm_*`/fragments, lowercase host) → update path
3. **Event fingerprint** = `sha256(normalized organizer ‖ normalized street ‖ start_at::date)` → exactly one match → link + update; more than one → `ambiguous`, skipped, surfaced in the queue
4. **Soft signal** — same ZIP + same start date + title similarity ≥ threshold → created but flagged `possible_duplicate`, sorted to the top of the review queue. Never auto-merged.

**Change detection:** `content_hash` over the canonical record (volatile fields excluded). Unchanged → `outcome='unchanged'`, zero writes, zero image work, zero geocode calls. `images_hash` separately drives image re-sync.

**Deleted-event detection:** only on a full pass for a source with `capabilities.deletions` (the BD importer's `if (!limit)` guard — without it, reconciliation wrongly removes everything). Soft removal only.

**Errors & retries:** per-record `try/catch` → `import_run_items` row; the run continues and finishes `partial`. Run failures retry at the next scheduled window or via manual trigger — no mid-run retry storm. Outbound calls get a token-bucket throttle, exponential backoff with jitter on 429/5xx, and `r.ok` is actually checked (unlike `bdRestTransport`).

---

## 12. Image handling

- Per-source `media_policy`: **`none`** · **`link_only`** (default — remote URL retained in `event_sources.raw_payload`, UI shows attribution and the original-event link, nothing copied) · **`mirror`** (fetch to Cloudinary, only where rights are confirmed and attested).
- `mirror` path: `fetch(url)` → buffer → `sha256` → skip if `(event_id, content_hash)` exists → new `cloudinaryService.uploadRemote()` (buffer upload + eager `w_400,h_300,c_fill` thumbnail + `f_auto,q_auto`) → `event_images` row with source order preserved.
- **Cap 40 per event**, order preserved, exactly one cover, content-hash dedup, re-sync when `images_hash` changes, orphaned assets destroyed via the stored `public_id`.
- Work runs through `event_image_jobs` (`attempts`, `next_attempt_at`, `locked_at`, `last_error`) so a slow source never blocks a run and image failures never fail an event.

---

## 13. SEO & visitor experience — inherited, not rebuilt

Published imported events automatically receive, with **no new code**: crawlable `/event.html?slug=` detail pages · Event JSON-LD · Open Graph + Twitter Cards (`shareMeta`) · `/sitemap.xml` inclusion (`shareMetaService.getSitemapEntries().events`) · combined event feeds, search, filters, maps · the `"Imported Listing"` badge (`deriveOrganizerBadge`) · `attribution_source` / `attribution_url` in the public payload.

**The only significant new visitor-facing feature** is a prominent call-to-action on the imported-event detail page — **"View Original Event"** / **"Bid on Original Website"** — sending the visitor to the original host for registration, bidding, and full details, with clear organizer attribution.

Language standard applies to every rendered surface including admin: no "AI" terminology, no vendor or infrastructure names (Cloudinary, Railway, Mapbox) in visible text.

---

## 14. Protected files

Do not open or modify without an explicit request from the owner:

```
public/widgets/marketplace-feed.js
public/widgets/featured-items.js
public/widgets/marketplace-embed.js
tests/iframe-resize-convergence.test.js
```

The iframe resize-loop fix at `ad04488` is production-verified. Event Feed and Featured Items resize behavior must not change. All new code lives in `src/services/eventImport/`, `src/workers/eventImportWorker.js`, `src/routes/adminEventImports.js`, `db/migrations/097…101`, `public/admin-event-imports.html`, `tests/eventImport/`.

**`server.js` is touched exactly twice** — one router mount (above line 481, or the `/api/admin` catch-all shadows it) and one `spawnWorker` line — announced in `agents/orchestration/current-work.md` per the shared-infrastructure rule.

---

## 15. Implementation phases

| # | Commit | Contents |
|---|---|---|
| 0 | `docs(import): event import framework architecture + task file` | this document + `tasks/006-event-import-framework.todo.md` |
| 1 | `feat(import): source registry + run ledger (097-098)` | migrations + guarded stg/prod/rollback scripts + AAC owner verification/seed script |
| 2 | `feat(import): provenance + canonical event fields (099-100)` | migrations + scripts |
| 3 | `feat(import): market resolver + national fallback (101)` | migration + resolver + unit tests |
| 4 | `feat(import): pipeline interfaces, normalizer, quality gates` | no connector yet; pure-logic tests; `end_at` derivation |
| 5 | `feat(import): dedup ladder + change detection` | unit tests per tier, ambiguity behavior |
| 6 | `feat(import): geocode wrapper with throttle + fingerprint` | |
| 7 | `feat(import): imported-event writer + createImported path` | tx, provenance, audit, caps, quota bypass |
| 8 | `feat(import): CSV connector (proof of concept)` | + `connectors/_template.js` |
| 9 | `feat(import): image mirror pipeline + per-source media policy` | `uploadRemote`, `event_image_jobs`, 40-cap, hash dedup |
| 10 | `feat(admin): import dashboard + bulk review API` | router + service + authz tests |
| 11 | `feat(admin): bulk review screen` | one admin page |
| 12 | `feat(public): view original event CTA on imported detail pages` | the one new visitor-facing feature |
| 13 | `feat(public): expire imported events from detail, meta and sitemap` | §5.2 — the four surfaces (`publicEvents.js` detail, `getEventMeta`, `shareMeta` body + `noindex`, `getSitemapEntries`), gated on `source='imported'`; 410 for source-removed |
| 14 | `feat(import): weekly scheduler worker` | worker + SIGTERM + `.env.example` flags |
| 15 | `test(import): tier-1 suite + tier-2 staging validation` | `scripts/tier2-event-import-validate.js` (staging-guarded, PASS/FAIL) |

Phase 13 touches `src/routes/publicEvents.js`, `src/services/shareMetaService.js`, and `src/middleware/shareMeta.js` — the SEO files most recently changed by the indexability-parity work. It ships as its own small commit with dedicated tests so the diff stays reviewable in isolation, and it does not touch the protected widget files.

**No production connector is built until phases 0–14 are complete.** CSV (phase 8) exists to exercise the pipeline, not to serve a real source.

---

## 16. Acceptance criteria

**Framework**
1. A new connector requires only a `connectors/*.js` file plus an `import_sources` row — no change to pipeline, schema, dashboard, or scheduler. Demonstrated by a second stub connector in tests.
2. `runImport({ apply: false })` is the default and writes nothing; production writes require an explicit confirm env var.
3. A single malformed record produces one `import_run_items` row with `outcome='failed'` and does not abort the run.

**Correctness**
4. Re-running the same CSV twice yields `created: N` then `created: 0, unchanged: N` — zero duplicate events.
5. Each dedup tier has a passing unit test, including the ambiguous case (skipped, logged, never merged).
6. Every imported event has an `event_sources` row with source, source event id, source URL, import timestamp, and last-sync timestamp.
7. Every imported event has a non-null `end_at`; an event with no computable end date is recorded `rejected_quality` and never published.

**Expiration (§5)**
7a. After `end_at` passes, an imported event is absent from `GET /api/public/events`, the combined marketplace feed, distance/radius search, maps, and upcoming views.
7b. Its detail endpoint returns only `{ expired: true, slug, city, state, market_slug }` — no title, description, image, organizer, terms, or source URL appears in any public response.
7c. `/event.html` for that slug emits `robots: noindex,follow`, no Event JSON-LD, no OG/Twitter card, and no server-rendered body.
7d. Its slug is absent from `/sitemap.xml`.
7e. An event whose `event_sources.sync_status='removed'` returns `410 Gone`.
7f. An organization-created (`source='organization'`) ended event still returns its full detail page and stays in the sitemap — no regression to native events.
8. A scheduled run creates at most 75 events; exceeding it sets `capped = TRUE` with `remaining_available` recorded.
9. Two concurrent worker instances produce exactly one scheduled run per source per week (unique-constraint claim).

**Ownership & quotas**
10. No UUID is hardcoded; the owner resolves through `import_sources.owner_organization_id`.
11. Importing 75 events does not change any seller organization's `max_active_events` usage, and a seller with a full quota can still submit an event.

**Geography**
12. An event in an unmapped metro imports successfully into `national` and appears in the metro discovery queue.
13. An event within a market's radius resolves to that market with `market_resolved_via='radius'`.

**Admin**
14. Bulk publish of 75 drafts completes in chunked transactions with one audit row per event.
15. `approve-all` with a stale `expectedCount` is refused.
16. A non-admin receives 403 on every `/api/admin/event-imports/*` route.

**Non-regression**
17. `npm test` full suite green; `npm run test:governance` 35/35 with `governance-summary.json` `"overall": "pass"`.
18. The four protected files are byte-identical to `ad04488`; Event Feed and Featured Items resize behavior unchanged (`tests/iframe-resize-convergence.test.js` passes untouched).

---

## 17. Rollback strategy

**Per migration.** Each of 097–101 ships a `rollback-0NN.js` following the existing `rollback-077…083` pattern. 097–099 and 101 create only new tables → rollback drops them, and no existing read path references them, so a rollback is inert. 100 adds columns to `events` / `event_images` → rollback drops exactly those columns; every existing serializer is an explicit allowlist, so added columns are invisible until code reads them.

**Per feature.** Three independent kill switches, in increasing severity:
1. `import_sources.status = 'paused'` — stop one source, everything else keeps running (no deploy).
2. `EVENT_IMPORT_DISABLED=true` — the worker idles, stays alive, runs nothing (env change, no deploy).
3. Revert the feature commits — the importer's code is confined to new files plus two lines in `server.js`, so a revert removes the subsystem without touching events, auctions, widgets, or seller flows.

**Data rollback.** Every imported event is identifiable by `source='imported'` joined to `event_sources.source_id`, so a bad run is reversible in one statement scoped to `import_run_items.run_id` — unpublish, archive, or delete the run's creations. Runs are never rolled back automatically; it is an explicit admin action.

**Production promotion order** (house rule): fresh Neon backup → migrations in ascending order, each endpoint-guarded, verified between batches, stop on any FAIL → merge → deploy → `/api/health` 200 + workers start → report backup id, commit, and validation output.

---

## 18. Future connector roadmap

| Wave | Connectors | Prerequisite |
|---|---|---|
| V1 | CSV (proof of concept), Manual entry | none |
| V1.1 | Seller / partner bulk upload through the admin UI | file-upload UI + per-org `imports` capability (already in the capability catalog) |
| V2 | RSS · XML · JSON feeds (generic, config-driven) | a parser per format; per-source terms attestation |
| V2 | REST partner APIs (cursor + `since` incremental) | credentials via `auth_env_var`; `capabilities.incremental = true` |
| V3 | Licensed data providers | contract, counsel review, `media_policy = 'mirror'` attestation |
| V3 | Daily scheduling; per-source cadence | change `due()` to read `import_sources.schedule`; no structural change |
| V3 | Webhook / push ingestion | new inbound route reusing the same pipeline from stage 3 onward |

Every wave adds a connector file and a registry row. The pipeline, schema, dashboard, and scheduler stay as built.

---

## 19. Open items

1. **AAC organization row** (§3) — query result needed before Phase 1 writes anything.
2. **BD member id confirmation** — expected `28`; confirm before it is written to `organizations.bd_listing_id`.
3. **First real source** — when named, its permission basis goes into `terms_attested_*` and its image rights into `media_policy`.
4. **`docs/projects/project-constitution.md` is missing** — three implemented architecture docs cite it as the governing authority on marketplace syndication (§7). If it exists off-repo, it should be read before compliance is claimed.
