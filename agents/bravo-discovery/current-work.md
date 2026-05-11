# Bravo-Discovery — Current Work

## Status: ACTIVE — Phase 3: Discovery Enrichment

Last completed: checkpoint-discovery-phase2-v1.

---

## Active Work Cycle

### Assignment
Add keyword search, pagination metadata, and seller context to the public discovery API.
No migration. No server.js changes. Additive only.

### Files Being Modified
- [x] `src/routes/public.js`
- [x] `e2e/public-discovery-phase3.spec.js` (new)

### Changes Scoped
1. `GET /api/public/auctions` — add `q` keyword search; add pagination envelope
2. `GET /api/public/auctions/near` — add pagination envelope
3. `GET /api/public/auctions/:id/lots` — add pagination envelope
4. `GET /api/public/featured-lots` — add seller context JOIN
5. `GET /api/public/featured-videos` — add seller_display_name JOIN

### Checkpoint Target
`checkpoint-discovery-phase3-v1`

### Conflict Check (verified)
- Alpha-Core: IDLE — no overlap
- Charlie-BD: IDLE — no overlap
- Delta-Testing: IDLE — not writing specs for any file being modified

---

## Completed This Session

### Discovery Phase 1 (checkpoint-public-discovery-v1)
- Created `src/routes/public.js` with 6 endpoints
- Created `db/migrations/039_add_public_discovery_fields.sql`
- Created `e2e/public-discovery.spec.js` (42 tests)
- Mounted at `/api/public` in server.js

### Discovery Phase 2 (checkpoint-discovery-phase2-v1)
- Added `/api/public/auctions/near` — Haversine radius search
- Added `/api/public/featured-auctions` — widget feed with geo support
- Added `/api/public/locations` — city/state aggregation
- Extended `/api/public/auctions` with `shippable_lot_count`
- Created `db/migrations/040_add_auction_lat_lng.sql`
- Created `e2e/public-discovery-phase2.spec.js` (45 tests)
- Also added `PATCH /api/admin/auctions/:id/discovery` to admin.js (coordinated with Alpha-Core, minimal additive change to their file)

---

## Potential Next Work (not yet assigned)

These are candidate areas for future Bravo cycles. None are active until the human operator assigns them:

- **Seller profile enrichment** — allow sellers to self-update their display_name, bio, location_label, logo_url via an authenticated seller endpoint (cross-domain: would touch Alpha-Core's seller routes)
- **Discovery search** — full-text search across auction titles/descriptions for the `/api/public/auctions` list
- **Pagination metadata** — add `total_count`, `has_more`, `next_offset` to paginated responses for better widget UX
- **Auction type taxonomy** — normalize `public_auction_type` values and expose a `/api/public/auction-types` enum endpoint
- **Featured videos: auction context expansion** — add seller display_name to the featured-videos response

---

## Work Cycle Template

When assigned, replace this section with:

```
## Status: ACTIVE

### Assignment
[Description of the task]

### Files Being Modified
- [ ] src/routes/public.js
- [ ] db/migrations/0XX_description.sql
- [ ] e2e/public-discovery-phase{N}.spec.js

### Validation Plan
- [ ] All new endpoints: 200 without auth
- [ ] All new endpoints: Cache-Control header present
- [ ] All new endpoints: no blocked fields in response
- [ ] All new endpoints: 400 for invalid inputs
- [ ] All new endpoints: 404 for unknown resources

### Checkpoint Target
Tag name: checkpoint-discovery-phase{N}-v1
```

---

## Conflict Check

Before starting any work cycle, verify the files listed above do not appear in:
- `agents/alpha-core/current-work.md`
- `agents/charlie-bd/current-work.md`
- `agents/delta-testing/current-work.md`
