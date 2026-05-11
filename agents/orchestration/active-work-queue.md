# Active Work Queue

Last updated: 2026-05-11 (Delta-Testing marketplace validation sprint COMPLETE — all streams IDLE)
Maintained by: Human Operator

This is the single-pane view of all active and queued work across all seven
workstreams. Update this file whenever a stream starts, completes, or blocks work.

**Before starting any work cycle:** check this file for file conflicts.
**Before opening a second terminal:** check this file to confirm zero path overlap.

---

## Queue Status Summary

| Stream | Status | Active Files | Next Queued Item |
|---|---|---|---|
| Alpha-Core | IDLE | — | See candidate list below |
| Bravo-Discovery | IDLE | — | See candidate list below |
| Charlie-BD | IDLE | — | See candidate list below |
| Delta-Testing | IDLE | — | Coverage audit: walkthroughs, watchlist, soft-close |
| Frontend Ops | IDLE | — | Awaiting next Charlie-BD export publish |
| Growth Ops | IDLE | — | See candidate list below |
| Marketplace Intelligence | IDLE | — | Initial telemetry query design |

**Current migration ceiling:** `044_create_analytics_events.sql`
The next migration must be numbered `045`. Confirm this in `active-work-queue.md`
before creating any new migration file.

**Migration 045 status:** NOT claimed. No stream has started a migration this cycle.

---

## Stream Detail

---

### Alpha-Core

**Status: IDLE**
Last checkpoint: `checkpoint-admin-moderation-v1`
Agent files: `agents/alpha-core/`

**Active work cycle:** None

**Candidate next assignments** (not active — awaiting operator assignment):
- Soft close + bid extension timer spec hook — add `lot_close_at` and extension
  logic to close worker; Delta-Testing will cover with Playwright after
- Proxy bid mechanics hardening — validate increment ladder enforcement under concurrent bids
- Buyer card verification flow — random charge under $1 at signup and card change
- Seller final submission lock — ensure editing is fully blocked post-submission
- Consignor information storage — recordkeeping fields on auctions table

**Files that would be modified** (for conflict pre-check — not yet active):
- `src/routes/auctions.js` or `src/workers/` — soft close
- `src/routes/bids.js`, `src/services/bidService.js` — proxy bids
- `src/routes/payments.js` — card verification
- `src/routes/auctions.js`, `src/routes/lots.js` — seller submission lock

---

### Bravo-Discovery

**Status: IDLE**
Last checkpoint: `checkpoint-discovery-phase2-v1`
Agent files: `agents/bravo-discovery/`

**Active work cycle:** None

**Candidate next assignments** (not active — awaiting operator assignment):
- Discovery search — full-text across auction titles/descriptions
- Pagination metadata — `total_count`, `has_more`, `next_offset` on list endpoints
- Seller profile enrichment — authenticated seller endpoint for display_name/bio/logo_url
  (cross-domain: touches Alpha-Core's seller routes — must be sequenced after Alpha)
- Featured video context expansion — add `seller_display_name` to featured-videos response
- Auction type taxonomy — normalize `public_auction_type`, expose `/api/public/auction-types`

**Files that would be modified** (for conflict pre-check — not yet active):
- `src/routes/public.js` — all of the above
- `db/migrations/045_*` — if seller profile enrichment requires schema change
- `server.js` — only if a new router is mounted (unlikely for above candidates)

---

### Charlie-BD

**Status: IDLE — Fourth Work Cycle Complete**
Last checkpoint: `checkpoint-bd-marketplace-seller-cta-v1` (7d2e50b, pushed)
Agent files: `agents/charlie-bd/`

**Active work cycle:** None

**Candidate next assignments** (not active — awaiting operator assignment):
- Option A: Sold Lots Showcase Widget — `public/widgets/sold-lots.js`
- Option B: Auction Calendar Widget — `public/widgets/auction-calendar.js`
- Option C: Integration Contract Finalization — `docs/integration-contract-bd.md`
- Option D: Featured Near You Refactor to Config-First
- Option E: Analytics emission — wire `AAPAnalytics.track()` into existing widgets

**Files that would be modified** (for conflict pre-check — not yet active):
- `public/widgets/[new-widget].js`
- `public/widgets/demo-[new-widget].html`
- `e2e/charlie-bd-[new-widget].spec.js` (coordinate with Delta)

---

### Delta-Testing

**Status: IDLE — Monitoring**
Agent files: `agents/delta-testing/`
Known pre-existing failures: 10 (documented in `agents/delta-testing/current-work.md`)

**Active work cycle:** None

**Queued coverage gaps** (not yet active — prioritized for next Delta cycle):

| Priority | Feature | Spec File | Depends On |
|---|---|---|---|
| HIGH | Walkthrough video upload + moderation | `e2e/walkthrough-moderation.spec.js` | Alpha-Core idle |
| HIGH | Soft close + bid extension timer | `e2e/soft-close.spec.js` | Alpha-Core implements first |
| HIGH | Buyer watchlist/favorites | `e2e/buyer-watchlist.spec.js` | Alpha-Core idle |
| MEDIUM | Invoice generation + PDF | `e2e/invoices.spec.js` | Alpha-Core idle |
| MEDIUM | Seller final submission lock | Extend `e2e/seller-dashboard.spec.js` | Alpha-Core idle |
| MEDIUM | Proxy bid mechanics | Extend `e2e/bidding.spec.js` | Alpha-Core idle |
| LOW | Analytics event ingestion | `e2e/analytics-events.spec.js` | Bravo-Discovery idle |
| LOW | `featured-auctions.js` (original v1) | `e2e/featured-auctions-v1.spec.js` | Charlie-BD idle |

**Trigger:** Delta initiates a coverage cycle when any engineering stream checkpoints.

---

### Frontend Ops

**Status: IDLE**
Boundary: `/exports/frontend-widgets/` (consume only) + `deployment-log.md` (append only)

**Active work cycle:** None

**Current export inventory** (as of 2026-05-11):
```
exports/frontend-widgets/
  featured-lots/         v1.0.0  — available for deployment
  featured-near-you/     v1.0.0  — available for deployment
  seller-cta/            v1.0.0  — available for deployment
  onboarding-flow/       v1.0.0  — available for deployment
  city-enhancements/     v1.0.0  — available for deployment
```

**Queued work:**
- Await operator instruction to deploy any of the above packages to BD staging
- Log each deployment in `exports/frontend-widgets/deployment-log.md` per the
  format defined in that file

**Hard constraints:**
- Do NOT modify any file in `/public/widgets/`, `/src/`, or `/db/`
- Do NOT modify `exports/frontend-widgets/[package]/widget.js` or `widget.css`
- Do NOT create new packages — that is Charlie-BD's responsibility
- All deployments must be logged before going live

---

### Growth Ops

**Status: IDLE**
Boundary: `/ops/` (excluding `ops/frontend/`)

**Active work cycle:** None

**Candidate next assignments** (not active — awaiting operator assignment):
- Seller onboarding guide — `ops/onboarding/seller-guide.md`
- SEO city landing page strategy — `ops/growth/city-page-seo.md`
- CRM contact taxonomy — `ops/crm/contact-taxonomy.md`
- Outreach templates — `ops/growth/outreach-templates.md`
- Branding asset registry — `ops/branding/asset-registry.md`
- Platform positioning doc — `ops/docs/platform-positioning.md`

**Hard constraints:**
- All work confined to `/ops/` (excluding `ops/frontend/` — that is Charlie-BD's)
- No code, no routes, no migrations, no widget edits
- If a growth initiative requires a platform change (e.g., new public endpoint for
  SEO data), log it as a cross-stream request to the appropriate engineering stream

---

### Marketplace Intelligence

**Status: IDLE**
Boundary: Read analytics data + propose to `docs/analytics-telemetry.md` and `ops/docs/`

**Active work cycle:** None

**Foundation:** Migration `044_create_analytics_events.sql` is live as of 2026-05-11.
`POST /api/analytics/events` is accepting events. `window.AAPAnalytics` is available
to widgets. Data collection will begin once widgets emit events.

**Candidate next assignments** (not active — awaiting operator assignment):
- Design initial seller-facing analytics report schema — `ops/docs/seller-report-design.md`
- Define telemetry query playbook — `ops/docs/telemetry-query-playbook.md`
- Identify top 5 seller questions the current schema can answer
- Propose additional event types needed for auction-level engagement reporting
- Draft retention and aggregation schedule for `analytics_events`

**Hard constraints:**
- No code writes. All schema additions are PROPOSED to Bravo-Discovery as the owner
  of `analyticsService.js` and the analytics route
- No raw IP data is accessed — all queries must use `ip_hash` only
- No PII fields may appear in any report or planning document
- Any query that accesses the live database requires operator approval

---

## Next Migration Number

**Current ceiling: 044**
**Next available: 045**

Before creating a migration, confirm in this file that no other stream has claimed 045.
Update this section when a migration is created:

```
## Next Migration Number
Current ceiling: 044
Next available: 045
Claimed by: [stream name] on [date] — [description]
```

---

## Recently Completed

| Date | Stream | Checkpoint | Description |
|---|---|---|---|
| 2026-05-11 | Delta-Testing | checkpoint-delta-marketplace-validation-v1 | Marketplace validation sprint: ~90 tests across 8 areas; platform STABLE; greenlit for Discovery Ranking Layer v1 |
| 2026-05-11 | Charlie-BD | checkpoint-bd-marketplace-seller-cta-v1 (7d2e50b) | Marketplace seller acquisition CTA: AAPMarketplaceSellerCta v1 module, auction-view.html integration, ~50 Playwright tests |
| 2026-05-11 | Bravo-Discovery | checkpoint-discovery-phase3-v1 (4194582) | Phase 3 enrichment: keyword search, pagination metadata, seller context on featured-lots and featured-videos |
| 2026-05-11 | Bravo-Discovery | — | Analytics foundation (migration 044, analyticsService, analytics route, AAPAnalytics JS, docs) |
| 2026-05-11 | Growth Ops / Charlie-BD | a6b217c | Deployment governance (deployment-log.md, CHANGELOG.md) |
| 2026-05-11 | Charlie-BD | 1f4378e | Frontend widget export pipeline (/exports/frontend-widgets/) |
| 2026-05-11 | Alpha-Core | 771f57f | Security hardening (.gitignore, pre-commit hook, SOP doc, CLAUDE.md) |
| Prior | Charlie-BD | pending-tag | Marketplace config infrastructure (migrations 041–043, adminConfig, config UI) |
| Prior | Bravo-Discovery | checkpoint-discovery-phase2-v1 | Discovery phase 2 (near, featured-auctions, locations) |
