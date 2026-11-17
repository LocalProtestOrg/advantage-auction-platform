# Advantage.Bid — Development TODO list (platform-wide)

The one platform-wide list of approved-but-not-started work and open launch checklist items. Feature-area roadmaps keep
their own detail (for example `docs/projects/professional-storefront-roadmap.md`); this list points to them. Per the
Data Minimization and Focused Development principle in CLAUDE.md, nothing here is built until the owner starts it.

Last updated: 2026-11-16 (launch checklist: completed steps marked, New Jersey pilot, purchase-then-full-refund test).

---

## 1. Launch checklist: first controlled live purchase (Timeless Treasures), then all verified Professional Sellers (OPEN)

The ONE consolidated launch checklist (owner 2026-11-12; status and test procedure updated 2026-11-16). Pilot seller:
**Timeless Treasures** (`https://bid.advantage.bid/pro/timeless-treasures`; seller profile
`81d6f0ce-9f3c-4605-9c09-04cb9c1601fc`, owner account `8c7feda1-a9d7-4dd6-88c5-830ca5d01fb3`). Never Lewis & Maese
(grandfathered; untouched). Global checkout stays OFF.

Advantage.Bid is a New Jersey business operating out of New Jersey (owner, 2026-11-16); the pilot is a New Jersey sale.
The Adrian, Michigan address is a mailing address only.

**Check progress at any time (read-only, changes nothing):**
`railway run --service advantage-auction-platform --environment production node scripts/storefront-pilot-preflight.js --buyer <buyer email>`
Ready when it shows no BLOCKED and no NEEDS OWNER ACTION (UNVERIFIED items are confirmed by hand).

**Still open (2026-11-16):** B2 live payout account (blocked at the payment processor), D1 New Jersey tax rule, D3 live
webhook check, D4 pilot buyer account, D5 owner approval of the pilot lists and of the real-money test.

### A. Admin steps (you, signed in as administrator)
- [x] **A1. Seller type: Retail shop / gallery / studio.** Done (confirmed in production 2026-11-16). Member Detail
      `https://bid.advantage.bid/admin/member.html?id=8c7feda1-a9d7-4dd6-88c5-830ca5d01fb3`.
- [x] **A2. Business verification required again** (it was switched off on 2026-11-12 because the page was unclear; not
      a permanent exemption). Done: the seller went through verification (B1, C1).
      `https://bid.advantage.bid/admin/verification.html?seller=81d6f0ce-9f3c-4605-9c09-04cb9c1601fc`

### B. Seller steps (signed in as the Timeless Treasures account)
- [x] **B0. Seller Agreement version 4 signed.** Done (confirmed 2026-11-16).
- [x] **B1. Business verification submitted.** Done (confirmed 2026-11-16).
- [ ] **B2. Payout account (live): BLOCKED.** `https://bid.advantage.bid/payout-profile.html`: complete Stripe Connect
      with the business bank account until transfers and payouts are both active. On 2026-11-13 the payment processor
      returned "You must have Connect enabled on Accounts v2". Owner action: enable Connect in the Stripe Dashboard
      (the owner is currently locked out pending a two-step authentication reset). The only Connect account in
      production today is a test-mode one; a live one is needed.
- [x] **B3. Pickup location:** Jersey City, New Jersey, confirmed (2026-11-16).
- [x] **B4. Policies published:** Store Terms v1 and Shipping & Pickup Policy v1 (confirmed 2026-11-16).
- [x] **B5. Pilot item listed:** "Brass Candlestick Lamp with Milk Glass Shade", **$3.00 plus $2.00 flat shipping**,
      quantity 1 (confirmed 2026-11-16). It is a temporary test listing, not real merchandise: it is never shipped.

### C. Admin approval (you, as administrator, after B1)
- [x] **C1. Business verification approved.** Done (confirmed 2026-11-16).

### D. Owner decisions (cannot be made in code)
- [ ] **D1. Sales tax for New Jersey:** CPA decision (`docs/operations/storefront-sales-tax-decision-checklist.md`), then
      one New Jersey rule at `https://bid.advantage.bid/admin/tax-jurisdictions.html`: `platform` (Advantage.Bid collects
      and remits; also needs a New Jersey registration in Stripe Tax) or `seller_direct` (nothing collected at checkout;
      the seller is responsible). The older `seller` rule is being retired for new transactions. Without a rule every
      order is refused (fail-closed). A Stripe Tax registration is account-wide and also taxes auction invoices in that
      state.
- [x] **D2. Buyer Terms v4 published 2026-11-13** (covers fixed-price purchases).
- [ ] **D3. Live Stripe webhook** (Stripe Dashboard, live > Developers > Webhooks): endpoint
      `https://bid.advantage.bid/api/payments/webhook` enabled; events `payment_intent.succeeded`, `payment_intent.canceled`,
      `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
      `charge.dispute.closed`, `transfer.created`, `transfer.reversed`, `account.updated`; signing secret equals Railway
      `STRIPE_WEBHOOK_SECRET`. Production has received no webhook since 2026-09-28 (no live activity since), and dispute and
      transfer events have never arrived. 8-step check: `docs/operations/stripe-live-webhook-verification.md`.
- [ ] **D4. Pilot buyer:** a buyer account separate from the seller (buying your own item is refused), with a real
      non-prepaid card you control (entered at checkout) and a New Jersey shipping address.
- [ ] **D5. Authorize activation** (explicit approval of the real-money test and of both pilot lists): set
      `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS` = `81d6f0ce-9f3c-4605-9c09-04cb9c1601fc` and
      `MARKETPLACE_CHECKOUT_PILOT_USER_IDS` = the buyer's user id. Leave `MARKETPLACE_CHECKOUT_ENABLED` unset (no one
      else can buy).

### E. The controlled purchase, then a complete refund (after D5; `docs/operations/storefront-first-sale-test-plan.md`)

One real purchase that is refunded in full. The listing is not real merchandise, so there is **no fulfillment and no
payout test**: nothing is shipped, no tracking or delivery record is entered (none is fabricated), and the order never
becomes payable. Expected: item $3.00 + shipping $2.00 + tax as calculated for New Jersey; commission 9% = $0.27.

- [ ] E1. The authorized pilot buyer completes a real purchase: a shipped order to a New Jersey address.
- [ ] E2. The charge is processed.
- [ ] E3. Sales tax is calculated (according to the New Jersey rule; shown before payment).
- [ ] E4. The transaction is recorded (order, channel Marketplace, commission $0.27, tax and who remits it, Buyer Terms
      v4 acceptance).
- [ ] E5. Buyer and seller notifications are verified.
- [ ] E6. An administrator issues a complete refund (everything the buyer paid).
- [ ] E7. The tax reversal is recorded.
- [ ] E8. Inventory returns to quantity 1.
- [ ] E9. No physical shipment takes place.
- [ ] E10. No tracking or delivery records exist on the order.
- [ ] E11. Confirm no seller payout was generated (an unfulfilled, refunded order never becomes payable).
- [ ] E12. Clear the pilot lists. Cost of the test: the card processing fee is not returned on a refund.

**Later, on a genuine sale:** the first seller payout (fulfillment, reporting period, weekly "Pay Seller" transfer) is
tested on a real sale of real merchandise, not on this test. Broader activation is a separate owner decision (each
further seller: verified, Connect live, policies, pickup or shipping, tax rule for its state).

### Known gaps (not blockers for the pilot)
- No buyer email when the seller marks "ready for pickup" or "shipped" (buyers see it on their purchases page).
- No seller-initiated cancellation (admin refund covers it). Seller staff cannot see storefront payouts.

## 2. DMARC record — DECIDED: no change (owner decision 2026-11-11)

- **DMARC DNS change: NOT REQUIRED at this time.** This is not an owner action and not a launch blocker.
- **Owner decision:** leave the existing `_dmarc.advantage.bid` record unchanged, including its aggregate reporting to
  `info@advantage.bid`, so email authentication reporting is preserved.
- **Why it is safe:** Sasha's automated-mail filtering (deployed 2026-11-11, main 31c15fb) recognises DMARC aggregate
  and forensic reports, bounces and other automated mail and never replies to them.
- **Revisit only** if new evidence shows a problem with email delivery, authentication, reporting, or Sasha's
  filtering (for example Sasha answering a report again). Do not raise it otherwise.

---

## 3. FEATURE — Unified SEO & Growth Dashboard (TODO, not started; owner 2026-11-11)

**Purpose.** One secure, admin-only page that shows how the websites and the marketplace are growing, month over
month, from verified sources only.

**Scope (what it consolidates).**
1. Google Analytics 4: traffic, users, engagement, traffic sources, month-over-month growth.
2. Google Search Console: clicks, impressions, CTR, average position, top pages, top queries, available indexing data.
3. Indexing coverage, sitemap status, SEO health. Verified counts (Search Console) shown separately from estimates
   (for example our own sitemap URL counts), and labelled as such.
4. Sales-alert email subscribers: total, new subscriptions, unsubscribes, monthly growth.
5. Buyer registrations, Professional Seller registrations, published listings, auctions, orders, marketplace activity.
6. Existing platform analytics and reports, reused rather than duplicated.
7. Advertising traffic, conversions and attribution, only once reliable data exists.

**Requirements.**
- Month-over-month comparisons, historical trends, useful charts, and a clear overall growth summary.
- Manual **Refresh Data** button; results cached with a last-updated time per source. No real-time updates.
- Every unavailable or disconnected source is shown as such. Never invent or infer a statistic.
- Minimise external API calls and ongoing cost (refresh on demand and at most a daily cached pull).
- Distinguish the two properties where it matters: `www.advantage.bid` (Brilliant Directories marketing/directory site)
  and `bid.advantage.bid` (the auction and marketplace platform).
- Aggregate figures only: no buyer or seller personal information on the page or in exports.
- Admin-only, enforced server-side (existing admin auth and HTML auth gate).
- Must not read or change checkout, payment, payout or tax settings.
- Public Language Standard applies to all visible text.

**Step 0 before any build: audit.** Inventory all existing analytics, reporting, database statistics and integrations
on both websites, and decide what is reused. Known starting points (2026-11-11, to be verified in the audit):
- GA4 tag on bid.advantage.bid (`src/middleware/analyticsTag.js`, measurement ID G-JM5JYGNJ6H). Whether
  www.advantage.bid (BD) uses the same or a separate GA4 property is unknown.
- First-party event telemetry: `src/services/analyticsService.js`.
- Owner reports: `ownerReviewDigestService` (9:00 AM digest), `baselineReportService` (immutable marketing baselines,
  UNKNOWN never inferred), `directorReportService`, `growthLabReportService`, `marketingReportService` (contains stubs),
  `reportingService` (seller/auction reporting).
- Subscribers: `subscriberService`, `subscriberGeoService`, `/admin/subscribers.html`.
- Advertising measurement: `src/services/measurement/*` (Google conversions, Meta CAPI, cost ingestion, attribution,
  readiness) and `src/services/paidGrowth/*`; `marketing.measurement.*` settings.
- Social: `socialInsightsService` (Meta insights for our own posts).
- Search Console and the GA4 Data API: **no integration exists** (no Google reporting client in the codebase).

**Dependencies / owner actions.**
- Google Search Console: verify both properties (or a Domain property for `advantage.bid`, which needs a DNS TXT record
  in the BD-hosted zone) and grant read access to a service account.
- GA4 Data API: read-only (Viewer) access for the same service account on each GA4 property; confirm which property
  covers www.advantage.bid.
- A Google Cloud project with the Search Console API and Analytics Data API enabled; credentials stored as Railway
  secrets only (never in files).
- Advertising data only after the existing measurement readiness checks report reliable data.

**Acceptance (draft).** Admin-only access enforced server-side; each source shows value, period, last refresh and
status (connected / not connected / error); month-over-month figures match the source for a sampled month; no personal
data in responses; refresh is rate-limited; disconnected sources never show zeros as if real.

## 4. SEO improvements

Audit and record: `docs/projects/seo-audit-2026-11-11.md`. The Brilliant Directories sitemap is at
`https://www.advantage.bid/filedata/cache/xml-sitemaps/sitemap.xml` and is already submitted to Google Search Console
(verified valid 2026-11-11; do not move or duplicate it).

**DEPLOYED 2026-11-11 19:11 UTC, production `main@aa7a1f6`** (CI 7,123 unit + 156 browser tests green; Marketplace
Integrity gate PASS in strict mode on production, including the new sitemap and home-link checks; live pages verified).

- [x] 2. Sitemap and page metadata use the shared visibility rules (demo, hidden, unpublished never indexed; completed sales kept).
- [x] 3. Real 404s for unknown auctions, lots, events and storefronts.
- [x] 5. Structured data and social metadata corrections.
- [x] 6. Home page and internal links to the shop, estate sales and public inventory.
- [ ] BD robots.txt allows all crawlers (owner, in BD; handled separately).
- [ ] Search Console / Bing Webmaster Tools for bid.advantage.bid; submit its sitemap (owner).
- [ ] Server-render auction lot lists and lot pages (platform).
- [ ] Sitemap split by type, real lastmod, drop internal search; historical-lot decision (platform + owner).
- [ ] Indexing decision for imported government-surplus events (owner).
- [ ] `www.bid.advantage.bid` certificate or remove its DNS record (owner).
- [ ] BD page text and canonical links; Merchant Center for `/shop` (later).

## 5. Test infrastructure — isolated database bridge stalls under load (OPEN, test-only; 2026-11-12)

Not a production problem: production uses real Postgres. This affects only the browser journeys' isolated environment
(`tests/fullstack`: PGlite served by `@electric-sql/pglite-socket` 0.0.22).

- **Symptom:** intermittent 30-second waits in browser journeys (seen in `seller-importer`: the readiness panel and the
  Unsold Inventory list never appear; CI and the site watchdog report "failed once, passed on the retry").
- **Evidence (2026-11-12, reproduced with 8 suites in parallel):** app requests hang because their database queries are
  never answered, while the database process is idle (no statement running, not in a transaction, its query queue
  empty). The server answers every request that reaches the database within milliseconds.
- **Variable:** the number of app connections to the bridge. App pool of 10: about 9 to 20 failures per stress run;
  3: 2 failures; 1: none, but a single connection deadlocks sign-in (it needs a second connection), so it was rejected.
  A two-connection run was stopped unfinished; it is not adopted.
- **Not the cause (ruled out):** long or abandoned transactions (transaction watch silent), slow queries, the pool
  running out (no waiters), browser connection limits, rate limits, serialized socket reads (made it worse).
- **Next options:** (a) upgrade the test database stack (pglite-socket 0.2.x needs PGlite 0.5.x; every full-stack suite
  must be re-verified); (b) report/patch the bridge's multi-connection handling; (c) a real Postgres service in CI.
- **Already fixed separately:** the inventory page's stale selection after a bulk action (a real app defect found in the
  same investigation) and the importer test's race with the list reload.
