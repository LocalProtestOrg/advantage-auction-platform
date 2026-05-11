# Bravo-Discovery — Checkpoint Log

Chronological record of completed work cycles. Most recent first.

---

## checkpoint-discovery-phase3-v1 (4194582)

**Date:** 2026-05-11

**What was done:**

No migration. No server.js changes. Additive only to `src/routes/public.js`.

Enriched endpoints:
- `GET /api/public/auctions` — added `q` keyword search (ILIKE on title/description/city,
  parameterized, max 100 chars); added pagination envelope: `total_count` (window function),
  `has_more`, `offset`, `limit`. `total_count` stripped from individual row objects.
- `GET /api/public/auctions/near` — added pagination envelope: `total_count`, `has_more`,
  `offset`, `limit`. Window function on outer subquery counts rows within radius before LIMIT.
- `GET /api/public/auctions/:id/lots` — added pagination envelope: `total_count`, `has_more`,
  `offset`, `limit`.
- `GET /api/public/featured-lots` — added seller context via LEFT JOIN to seller_profiles:
  `seller_display_name`, `seller_location_label`, `seller_logo_url`.
- `GET /api/public/featured-videos` — added `seller_display_name` via LEFT JOIN to
  seller_profiles (through auctions).

Test spec:
- `e2e/public-discovery-phase3.spec.js` — 45 tests covering keyword search, SQL injection
  safety, pagination metadata consistency across pages, seller field type safety, BD
  allowlist (no internal fields in rows).

**All changes backwards-compatible:** existing consumers reading `body.data` are unaffected.

**Live query validation:** all 5 SQL patterns verified against production database.
Window function confirmed: lots table returned `total_count: 27` with `LIMIT 2`.

**What's next (candidates, not assigned):**
- Pagination metadata on `/api/public/auctions/near` offset param (already present)
- Full-text search index (GIN on tsvector) for better `q` performance at scale
- Auction type taxonomy endpoint `/api/public/auction-types`
- Seller profile enrichment endpoint (requires Alpha-Core coordination)

---

## checkpoint-discovery-phase2-v1 (f9f65c1)

**Date:** 2026-05-11

**What was done:**

Schema:
- Migration 040: `auctions.lat` + `auctions.lng` (DOUBLE PRECISION, nullable) with partial index on non-null rows

New public endpoints:
- `GET /api/public/auctions/near` — Haversine radius search. Requires `lat`+`lng`, validates -90..90/-180..180 ranges. Subquery computes `distance_km` once, used in outer WHERE + ORDER BY. Optional `shipping=true` filter. Returns `distance_km` + `shippable_lot_count`.
- `GET /api/public/featured-auctions` — Widget feed for BD. Only `marketplace_priority > 0` auctions. Optional lat/lng/radius_km geo-filter. Partial-coord guard (lat without lng → 400). Returns `distance_km` in geo mode. Full field allowlist in both paths.
- `GET /api/public/locations` — City/state aggregation. Returns `auction_count` + `active_count` per city+state pair. Optional `?address_state=TX` filter. No internal fields exposed.

Additive change to existing endpoint:
- `GET /api/public/auctions` — Added `shippable_lot_count` to response (additive, no breaking change)

Admin coordination:
- Added `PATCH /api/admin/auctions/:id/discovery` to Alpha-Core's `src/routes/admin.js`. Sets `marketplace_priority` (0–10000), `lat`, `lng`. This was a coordinated additive change to Alpha's file — minimal, announced.

Widget:
- `public/widgets/featured-auctions.js` — Self-contained embeddable widget. Geolocation support with 5s timeout + fallback. Dark/light theme. XSS-safe. Shows `lot_count` + `shippable_lot_count` messaging. (Charlie-BD inherits this.)
- `public/widgets/featured-auctions.html` — Embed demo + configuration reference. (Charlie-BD inherits this.)

**Tests:** 45/45 public-discovery-phase2.spec.js PASS; 312 total passing; 10 pre-existing failures (unchanged)

**What's next:** Charlie-BD to build marketplace widget pages consuming the discovery API. Future Bravo work: discovery search, pagination metadata, seller profile enrichment.

---

## checkpoint-public-discovery-v1 (6ccf223)

**Date:** 2026-05-11

**What was done:**

Schema:
- Migration 039: `seller_profiles.display_name`, `.bio`, `.location_label`, `.logo_url` added. `auctions.marketplace_priority INTEGER NOT NULL DEFAULT 0` added. Three discovery indexes created.

New file: `src/routes/public.js` — 6 endpoints, all unauthenticated, all with explicit field allowlists and Cache-Control headers:
- `GET /api/public/auctions` — paginated list, filterable by state/city/address_state/auction_type/shipping. Ordered by `marketplace_priority DESC`.
- `GET /api/public/auctions/:id` — single auction with `auction_terms` + seller snapshot. UUID validation (non-UUID → 404).
- `GET /api/public/auctions/:id/lots` — lot list. Explicit SELECT excludes `reserve_cents`, `winning_buyer_user_id`, `pickup_group`, `soft_close_policy`, `soft_close_extension_count`.
- `GET /api/public/featured-lots` — cross-auction featured lots with auction context. `?auction_state` filter.
- `GET /api/public/featured-videos` — `visible_public=true` + `approved` videos only. No internal moderation fields.
- `GET /api/public/sellers/:sellerId/profile` — seller profile. Only visible if seller has ≥1 public-state auction (draft sellers not discoverable). UUID validation.

Mounted at `app.use('/api/public', publicRoutes)` in `server.js` (coordinated).

**Tests:** 42/42 public-discovery.spec.js PASS; 273 total passing (prior baseline); 9 pre-existing failures (unchanged)

**Field allowlist decisions at this checkpoint:**
- `seller_profile_id` included in single-auction detail (needed for seller profile link)
- `lat`/`lng` not yet in schema (added in Phase 2)
- `marketplace_priority` used for ordering but NOT returned to clients
- `auction_terms` included in single-auction detail only (not in the list endpoint)
