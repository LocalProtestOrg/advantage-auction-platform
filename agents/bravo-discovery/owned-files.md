# Bravo-Discovery — File Ownership

## Ownership Tiers

- **PRIMARY** — Bravo-Discovery is the sole owner; no other agent modifies without explicit handoff
- **SHARED-COORD** — Multiple agents may touch; Bravo must announce before modifying
- **READ-ONLY** — Bravo reads for context; does not modify
- **FORBIDDEN** — Bravo must never touch these files

---

## PRIMARY Ownership

### Discovery Route
```
src/routes/public.js
```
This is Bravo's core file. Every `/api/public/*` endpoint lives here. No other agent modifies this file without an explicit handoff documented in both agents' `current-work.md`.

### Discovery Migrations
```
db/migrations/039_add_public_discovery_fields.sql   (immutable — applied)
db/migrations/040_add_auction_lat_lng.sql            (immutable — applied)
db/migrations/041_*.sql                              (future Bravo migrations, if needed)
```
Note: migration files once applied are immutable. Bravo creates new numbered files; it never modifies existing ones.

### Tests
```
e2e/public-discovery.spec.js
e2e/public-discovery-phase2.spec.js
e2e/public-discovery-phase{N}.spec.js   (future phase specs)
```

---

## SHARED-COORD Ownership

### Server Entry Point
```
server.js
```
Bravo appended `app.use('/api/public', publicRoutes)` in the Discovery Phase 1 cycle. If future discovery work requires adding another mount (unlikely), coordinate with Alpha-Core first. Protocol: announce in `current-work.md`, confirm Alpha's `current-work.md` is clear, make minimal additive change only.

---

## READ-ONLY (context only, do not modify)

```
src/routes/admin.js               — Alpha-Core owns; Bravo reads to understand
                                    the /api/admin/auctions/:id/discovery endpoint
                                    that feeds marketplace_priority + lat/lng
src/services/auctionService.js    — Alpha-Core owns; read for auction state logic
src/routes/auctions.js            — Alpha-Core owns; understand what internal
                                    endpoints already expose so Bravo avoids duplication
db/migrations/001–038_*.sql       — historical schema context; do not modify
public/widgets/                   — Charlie-BD owns; Bravo reads to understand
                                    what the consumer needs from the API contract
docs/bd-integration-architecture.md  — Charlie-BD owns; Bravo reads for contract spec
agents/                           — read for coordination
```

---

## FORBIDDEN (Bravo must never touch)

```
src/routes/auth.js
src/routes/auctions.js
src/routes/bids.js
src/routes/payments.js
src/routes/invoices.js
src/routes/lots.js
src/routes/sellers.js
src/routes/admin.js
src/routes/marketing.js
src/routes/marketingReports.js
src/routes/payoutPreferences.js
src/routes/ai.js
src/routes/watchlist.js
src/routes/imageProcessing.js
src/routes/uploads.js
src/services/auctionService.js
src/services/bidService.js
src/services/paymentService.js
src/services/walkthroughVideoService.js
src/services/followerNotificationService.js
src/services/pdfGenerationService.js
src/middleware/
src/lib/
imageProcessingWorker.js
notificationWorker.js
public/admin/moderation.html
public/lot.html
public/dashboard.html
public/invoice.html
public/payment.html
public/seller-dashboard.html
public/seller-create.html
public/demo.html
public/favicon.svg
public/widgets/                        (Charlie-BD owns)
docs/bd-integration-architecture.md   (Charlie-BD owns)
docs/integration-contract-bd.md       (Charlie-BD owns)
```

---

## Field Allowlist Reference

Fields that must NEVER appear in any `/api/public/*` response:

```
seller_id               — internal FK, leaks relational structure
user_id                 — PII adjacency and FK leak
reserve_cents           — business-confidential
reserve_visible         — internal flag
winning_buyer_user_id   — PII + FK leak
winning_amount_cents    — exposes internal settlement
capabilities            — seller account privileges
metadata                — internal seller metadata
admin_notes             — internal moderation content
address_encrypted       — encrypted PII
increment_ladder        — internal bidding configuration
marketing_selection     — internal campaign data
marketplace_priority    — internal ranking signal (used for ordering, not returned)
soft_close_policy       — internal auction mechanics
pickup_group            — internal logistics
password_hash           — obvious
approved_by             — internal moderation FK
rejection_reason        — internal moderation content
visible_public          — internal visibility flag
featured_for_marketing  — internal marketing flag
```

Fields that ARE safe to return in public responses (illustrative, not exhaustive):
```
id, title, subtitle, description, auction_terms (single-auction detail only)
public_auction_type, state, city, address_state, zip
shipping_available, shippable_lot_count, lot_count
start_time, end_time, pickup_window_start, pickup_window_end
preview_start, preview_end
cover_image_url, banner_image_url
lat, lng, distance_km (when geo query)
seller_display_name, seller_bio, seller_location_label, seller_logo_url, seller_type
seller_profile_id (on single-auction detail only — needed for /sellers/:id/profile link)
created_at (for sort context)
```
