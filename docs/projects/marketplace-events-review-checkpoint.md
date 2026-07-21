# Marketplace Events — Review Checkpoint (Increments 2–9)

**Branch:** `feat/marketplace-events` — 8 commits off `main` @ `f2fc250`. **Local only; not pushed,
not deployed, no PR.** 35 files changed (+3,497 / −90). One additive migration. Test suite:
**702 passed / 0 failed** (10 DB-backed suites skip outside their scratch branch).

**Status:** feature-complete for the public product surface, but **inert in production until** (a)
migration 093 is applied, (b) organizations are assigned membership tiers, and (c) the owner embeds
the BD snippets. No auction / bid / payment / settlement code was touched.

---

## 1. Summary of Increments 2–9

- **2 — Foundation + membership tiers.** Migration 093: event field extensions + four membership
  tiers (Gold Retailer / Silver Retailer / Individual / Appraiser) with server-side enforcement
  (NULL = unlimited; Appraiser blocked from listings; Individual = 1 active; Silver = 1/month; Gold
  unlimited). Capabilities for weekly-email/badge/profile/lead-gen provisioned.
- **3 — Seller event creation.** Event type (6 Marketplace types) + contact fields in the org
  create/edit flow; same familiar workflow, additive only.
- **4 — Reusable Advantage Media Uploader.** Platform-wide signed **direct-to-object-storage**
  uploads (bytes bypass Railway): `mediaUploadService` context registry + `POST
  /api/uploads/signature`; auth-agnostic client `media-uploader.js` (drag-drop hundreds, progress,
  retry, cancel, reorder, cover). Events are the first consumer; caps enforced (Gold unlimited,
  Silver/Individual 125). The BD 10-at-a-time limit is gone.
- **5 — Hide Address Until.** Pure reveal engine (`eventAddressPrivacy`) — exact address withheld
  until 24h before start (server-authoritative), area + notice while hidden. Two-tier geocoding
  (`eventGeocodingService`) reusing the auction offset model (precise internal / ~0.10mi public).
- **6 — Public event page (auction twin) + shared components.** New shared `gallery.js` +
  `pin-map.js`; `event.html` rewritten with shared chrome/tokens; privacy-safe OG + JSON-LD via the
  existing `shareMeta` pipeline (`buildMarketplaceEvent`, physical Event, never leaks a hidden
  address); events added to the sitemap inventory.
- **7 — Discovery parity + shared card framework.** `/api/public/events` gains q/city/state/
  event_type + tier ranking; `makeEventCard` + `makeMarketplaceCard` dispatcher (one grid, many
  types); `content_type` discriminator.
- **8 — Unified marketplace feed.** `marketplace-feed.js` + `all-events.html`: auctions + events in
  ONE grid via `makeMarketplaceCard`, unified sort, All/Auctions/Events filter.
- **9 — BD embed packages.** `organization_id` tenant filter on the events feed; hardened widgets
  (duplicate-init guards, states, versions); local fixture + production embed guide.

## 2. Commit list

| Incr | Commit | Title |
|---|---|---|
| 2 | `4f8acfa` | Marketplace Events foundation — four membership tiers + field extensions |
| 3 | `dff0dbc` | seller event creation captures Marketplace type + contact |
| 4 | `c856966` | reusable Advantage Media Uploader + Events bulk photos |
| 5 | `9e24d3a` | Hide Address Until — reveal engine + two-tier geocoding |
| 6 | `119f64c` | public Event page as the auction twin + shared gallery/map + event SEO |
| 7 | `0c7784c` | Marketplace discovery parity + shared card framework |
| 8 | `7b7566b` | unified marketplace feed — one grid, one card entry point |
| 9 | `3c12018` | production-ready BD embed packages |

## 3. Migration list

- **`db/migrations/093_marketplace_events_foundation.sql`** — the ONLY new migration. Additive +
  idempotent (ADD COLUMN IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING, pg_constraint-guarded
  CHECKs). Adds: event fields (event_type, contact_email/phone), address-privacy + two-tier
  geocoding columns (behavior wired in code), `archived_at`; makes `organization_plans` limit
  columns nullable + adds `max_listings_per_month`/`search_placement_tier`; seeds four tiers; adds
  four capabilities + plan_capabilities mappings. No changes to auction/bid/payment/seller tables.
  **Not yet applied to any database.**

## 4. Environment variables / production configuration

| Variable | Needed for | Status |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | signed direct uploads (secret stays server-side) | already set (existing upload path) |
| `MAPBOX_GEOCODING_TOKEN` | event map coordinates (two-tier offset) | **optional** — absent → no map marker; time-based address reveal still works |
| `EVENTS_ALLOWED_ORIGINS` | events-feed CORS allow-list | defaults to advantage.bid + localhost; add external company domains if they embed the org widget |
| `PUBLIC_BASE_URL` / publicBaseUrl | canonical URLs in OG/JSON-LD | already set (`bid.advantage.bid`) |

**No new secrets introduced.** Migration 093 must be applied before deploy.

## 5. Known limitations & unverified runtime paths

- **Nothing has run against a real database.** Only source-level + pure-logic unit tests executed;
  migration 093 was never applied (the Neon "staging" branch resolves to prod, so migrations are not
  run casually). All DB-backed behavior — enforcement, bulk attach, geocoding writes, feed queries —
  is **unexercised at runtime**. The DB integration scratch suite still targets migration 076 and
  must be re-run with 093 applied to cover the new columns.
- **Signed direct-to-Cloudinary upload is not runtime-verified.** The `api_sign_request` flow +
  browser upload need a real Cloudinary account in a browser; only unit-guarded here.
- **Event geocoding is not runtime-verified** and needs `MAPBOX_GEOCODING_TOKEN`; degrades silently
  without it.
- **Membership tier assignment has no admin UI/endpoint.** Tiers are seeded and enforced, but
  setting an org's `plan_tier` to a retailer tier is currently a raw UPDATE (a future admin action).
  Until an org is assigned a tier, it stays on the default `free` plan.
- **Hide-Address "register for reminders" is display-only.** The reveal notice is shown, but no
  reminder-subscription endpoint was built (deferred).
- **Sitemap not wired.** `getSitemapEntries` now includes events, but no `/sitemap.xml` route
  consumes it anywhere in the app.
- **BD placement is untested.** Widget Manager is owner-controlled; snippets + fixture delivered, not
  embedded/tested inside BD.
- **Events-feed CORS is a restricted allow-list.** External (non-advantage.bid) company domains need
  a config/CORS decision to embed the org widget (documented).
- **Deferred (Increment 10 / owner-gated):** per-day multi-day schedules, weekly email promotion (a
  whole new subsystem), the Silver $35 additional-listing fee (Stripe-gated — quota enforced,
  charging not built).

## 6. Deployment order

1. **Back up** the prod DB (Neon branch) — record the branch name.
2. **Apply migration 093** to the prod DB (additive/idempotent; verify columns + 4 seeded tiers +
   capabilities).
3. **Confirm env:** Cloudinary vars present; set `MAPBOX_GEOCODING_TOKEN` if event maps are wanted;
   set `EVENTS_ALLOWED_ORIGINS` as desired.
4. **Merge PR → main**, auto-deploy to `bid.advantage.bid`.
5. **Re-run the DB scratch integration suite** with 093 applied (recommended before/after).
6. **Assign** real organizations to their membership tiers.
7. **Owner:** embed BD snippets on `/all-events` + city/company pages; set `?v=1`.
8. Run the smoke tests (§7). Rollback = revert the 8 commits + redeploy; migration 093 is additive
   and safe to leave (or drop the added columns/rows if a clean revert is required).

## 7. Production smoke-test checklist

- [ ] `/all-events.html` loads; unified feed renders; All/Auctions/Events filter works; no console
      errors / failed requests.
- [ ] Seller creates an event (org portal): type + contact + address-visibility captured.
- [ ] Bulk uploader: select many photos → direct-to-Cloudinary upload with progress; reorder + cover;
      Silver capped at 125, Gold unlimited; Appraiser blocked from creating a listing.
- [ ] Admin **Approve & Publish**; geocoding fires (if token set).
- [ ] Public event page: **hidden** address shows notice + area + no map; **after reveal** shows
      address + MapLibre map + directions; gallery + lightbox work.
- [ ] `view-source` of `/event.html?slug=…`: injected OG tags + JSON-LD physical `Event`; **no
      streetAddress / geo while the address is hidden**.
- [ ] `/api/public/events?q=&city=&state=&event_type=&organization_id=` filters behave; unrelated
      `organization_id` → 0 rows (isolation); invalid id → 0 rows.
- [ ] Membership: Silver blocked on the 2nd listing in a month; Gold not blocked.
- [ ] `events.js` market + org embeds render; empty + error states verified (e.g. bad market).
- [ ] No secrets/tokens present in any served widget (view-source `marketplace-feed.js` / `events.js`).

## 8. Recommended PR & review plan

- **One PR:** `feat/marketplace-events → main`, titled "Marketplace Events platform (Increments
  2–9)", using this document as the description. The 8 commits are clean, one-per-increment — review
  commit-by-commit.
- **Reviewer focus areas (highest risk first):**
  1. **Migration 093** — additive correctness, idempotency, the four-tier seed + NULL=unlimited.
  2. **Hide-Address privacy gating** (`eventAddressPrivacy`, `publicEvents` serializer,
     `shareMetaService.getEventMeta`, `buildMarketplaceEvent`) — confirm no exact address / precise
     geo ever leaves the server while hidden. (Unit tests assert this.)
  3. **Signed upload endpoint** (`mediaUploadService`, `/api/uploads/signature`) — secret stays
     server-side; per-context authorization; folder scoping.
  4. **Membership enforcement** (`eventsService`) — the four tiers, monthly counter, Appraiser guard.
  5. **CORS posture** for the events feed (external-domain decision).
- **Pre-merge gate:** run the DB integration scratch suite with 093 applied; manual run of the §7
  smoke tests on staging (or a scratch env).
- **Prod deploy gate (owner sign-off required):** DB backup + migration 093 + smoke tests green +
  Stripe untouched (the $35 fee is explicitly NOT built).
- **Post-merge, owner-side, non-blocking:** assign org tiers; embed BD snippets; decide external CORS.

---

*Prepared at the Increment-9 review checkpoint. No production, BD, or database changes have been
made. Increment 10 (per-day schedules, weekly email, $35 billing) remains deferred and owner-gated.*
