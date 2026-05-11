# Charlie-BD — Blocked Items

## Active Blockers

None at this time. Charlie-BD has not yet started a work cycle.

---

## Pre-Known Dependencies Before First Work Cycle

Before Charlie can build specific widgets, the following data must be available from the public API. These are not blockers yet (no work cycle is active) but will become blockers if Charlie needs data that Bravo hasn't yet exposed.

### Seller display fields
**Status:** Available (added in migration 039)
`seller_profiles.display_name`, `.bio`, `.location_label`, `.logo_url` are available and returned via `/api/public/sellers/:id/profile` and as `seller_display_name` etc. in the auction list.

### Auction coordinates for near-me filtering
**Status:** Available (added in migration 040)
`lat` and `lng` are available on auctions. Currently NULL for all auctions (must be populated by admin via `PATCH /api/admin/auctions/:id/discovery`). Widget functionality works; data richness depends on admin populating coordinates.

### Featured auction feed
**Status:** Available
`GET /api/public/featured-auctions` is live. Returns `marketplace_priority > 0` auctions. Currently returns empty since no auctions have been given non-zero priority in production. Widget code handles empty state gracefully.

### Potential Future Data Needs (not yet blockers)
- **Lot images beyond thumbnail** — `images_count` is returned but not individual image URLs. If a widget needs a gallery, Bravo would need to expose a lot images endpoint.
- **Seller auction history page** — if a "seller spotlight" widget wants recent sold auctions, the seller profile endpoint only returns counts, not the auction list. A new endpoint would be needed.
- **Category/type taxonomy** — `public_auction_type` is a free-text field. If BD wants category browsing, Bravo would need to expose a types list endpoint.

---

## Blocker Template

```
## BLOCKER: [Short title]

- **Opened:** YYYY-MM-DD
- **Blocking:** [What Charlie work is waiting on this]
- **Owner:** [Bravo-Discovery / Alpha-Core / Infrastructure]
- **Resolution needed:** [Specific API endpoint or data field needed]
- **Impact if unresolved:** [What widget feature cannot be built]
- **Workaround:** [Any interim approach, or NONE]

### Context
[What the widget needs and why the current API doesn't provide it]

### Resolution
[Filled in when resolved — what Bravo added and which checkpoint]
```

---

## Resolved Blockers

_None yet. Charlie has not started a work cycle._
