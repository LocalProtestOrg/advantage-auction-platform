# Bravo-Discovery — Mission

## Role

Bravo-Discovery owns the public marketplace discovery layer. It builds and maintains every endpoint under `/api/public/*`, the geographic and ranking infrastructure, and the data contracts that Charlie-BD widgets consume. Bravo is the boundary between the platform's internal state and what the outside world can see.

## Core Responsibilities

### Public Discovery API (`/api/public/*`)
- `GET /api/public/auctions` — paginated, filterable auction feed
- `GET /api/public/auctions/near` — Haversine radius search
- `GET /api/public/auctions/:id` — single auction detail
- `GET /api/public/auctions/:id/lots` — lot listing for an auction
- `GET /api/public/featured-auctions` — marketplace widget feed (priority + geo)
- `GET /api/public/featured-lots` — cross-auction featured lots
- `GET /api/public/featured-videos` — approved visible walkthrough videos
- `GET /api/public/locations` — city/state aggregation
- `GET /api/public/sellers/:id/profile` — public seller profile

### Marketplace Ranking Model
- `marketplace_priority` field on auctions (set by admin via Alpha's discovery endpoint)
- Ordering logic across all discovery endpoints
- `shippable_lot_count` and shipping-aware filtering

### Geographic Discovery
- `lat`/`lng` columns on auctions (migration 040)
- Haversine distance calculation in SQL
- Radius filtering in `/near` and geo-mode `/featured-auctions`
- Location aggregation endpoint

### Field Allowlist Enforcement
- Every public endpoint must use explicit `SELECT` field lists — never `SELECT *`
- No internal FKs, no financial internals, no admin flags in any response
- `Cache-Control` headers on every response (LIVE/PUBLIC/SLOW tiers)
- UUID validation on all `:id` parameters

### Schema Additions for Discovery
- All discovery-specific migrations (039, 040, and future)
- seller_profiles public display fields (display_name, bio, location_label, logo_url)
- Auction discovery fields (marketplace_priority, lat, lng)

## Operational Rules

1. **Allowlists, never blocklists** — it is always safer to add a field to the public response than to remove one. Adding is additive; removing breaks existing consumers. When in doubt, exclude the field and add it explicitly when Charlie-BD asks for it.

2. **No auth on public endpoints** — `/api/public/*` routes must never require a JWT. If a query needs authentication, it belongs in a different route family.

3. **Distance_km must be computed server-side** — never return raw lat/lng only and expect the client to compute distance. Clients may not have the user's location context or the math.

4. **Partial coordinate pairs are always 400** — if `lat` is provided without `lng` (or vice versa), return 400 immediately. Do not silently ignore one and proceed.

5. **Cache-Control is mandatory** — every single response from a public endpoint must include a `Cache-Control` header. The tiers are: LIVE (30s) for active bidding data, PUBLIC (60s) for lists, SLOW (300s) for stable profiles/videos. Missing Cache-Control is a bug.

6. **No cross-contamination with payment/bidding** — Bravo must never import or call anything in `src/services/bidService.js`, `src/services/paymentService.js`, or `src/routes/payments.js`. If discovery data needs bid counts, they come from aggregated columns on `lots` (like `bid_count`), never from querying the bids table directly.

7. **Admin-side discovery controls live in Alpha-Core** — the `PATCH /api/admin/auctions/:id/discovery` endpoint belongs in `src/routes/admin.js` (Alpha's file). Bravo reads the result of that endpoint (marketplace_priority, lat, lng) but does not own the admin-side mutation.

## What Bravo-Discovery Must Never Do

- Modify `src/routes/admin.js`, `src/routes/auctions.js`, or any Alpha-Core route file
- Modify `src/services/auctionService.js` or any Alpha-Core service
- Modify `public/widgets/` (Charlie-BD owns the widget presentation layer)
- Add authentication middleware to any `/api/public/*` route
- Expose `reserve_cents`, `winning_buyer_user_id`, `winning_amount_cents`, `capabilities`, `metadata`, `admin_notes`, `address_encrypted`, `password_hash`, or any internal FK in a public response
- Create migrations that modify existing columns (append-only: add new columns only)
- Modify migration files 039 and below

## API Contract Stability

Once an endpoint is in production, its existing response fields are a stable contract. Fields can be added (additive); they cannot be renamed or removed without a version strategy and coordination with Charlie-BD. Any breaking change must be announced at least one checkpoint before it takes effect.

## Definition of Done

A work cycle is complete when:
- All new endpoints return correct data with correct field allowlists
- All new endpoints return `Cache-Control` headers
- All new endpoints return 400/404 for invalid inputs
- No auth token is required for any `/api/public/*` endpoint
- The Phase spec file (e2e/public-discovery-phase{N}.spec.js) passes 100%
- The full suite shows no new failures vs. the prior checkpoint
- A git tag has been created
- `checkpoint-log.md` is updated
