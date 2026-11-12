# Advantage.Bid — Development TODO list (platform-wide)

The one platform-wide list of approved-but-not-started work and open launch checklist items. Feature-area roadmaps keep
their own detail (for example `docs/projects/professional-storefront-roadmap.md`); this list points to them. Per the
Data Minimization and Focused Development principle in CLAUDE.md, nothing here is built until the owner starts it.

Last updated: 2026-11-11 (SEO 2/3/5/6 deployed; DMARC decision recorded).

---

## 1. Launch checklist: first controlled live purchase (Timeless Treasures), then all verified Professional Sellers (OPEN)

The ONE consolidated launch checklist (owner 2026-11-12). Pilot seller: **Timeless Treasures**
(`https://bid.advantage.bid/pro/timeless-treasures`; seller profile `81d6f0ce-9f3c-4605-9c09-04cb9c1601fc`, owner account
`8c7feda1-a9d7-4dd6-88c5-830ca5d01fb3`). Never Lewis & Maese (grandfathered; untouched). Global checkout stays OFF.

**Check progress at any time (read-only, changes nothing):**
`railway run --service advantage-auction-platform --environment production node scripts/storefront-pilot-preflight.js --buyer <buyer email>`
Ready when it shows no BLOCKED and no NEEDS OWNER ACTION (UNVERIFIED items are confirmed by hand).

### A. Admin steps (you, signed in as administrator)
- [ ] **A1. Seller type: Retail shop / gallery / studio** (it is "auction house" today). Member Detail
      `https://bid.advantage.bid/admin/member.html?id=8c7feda1-a9d7-4dd6-88c5-830ca5d01fb3` > Professional type > "Retail Shop, Gallery or Studio" >
      Save Changes (asks for a reason; audited).
- [ ] **A2. Require business verification again** (it was switched off on 2026-11-12 because the page was unclear; not
      a permanent exemption). `https://bid.advantage.bid/admin/verification.html?seller=81d6f0ce-9f3c-4605-9c09-04cb9c1601fc`
      > "Business verification required before selling" = **Yes** > Save. Timeless Treasures then moves from the
      "exempt" list to "Sellers awaiting business verification".

### B. Seller steps (signed in as the Timeless Treasures account)
- [ ] **B1. Submit business verification:** `https://bid.advantage.bid/verify-documents.html`: business details and one
      business document (for example a business license or registration).
- [ ] **B2. Payout account (live):** `https://bid.advantage.bid/payout-profile.html`: complete Stripe Connect with the
      business bank account until transfers and payouts are both active. (The only Connect account in production today
      is a test-mode one; a live one is needed.)
- [ ] **B3. Pickup location and window:** `https://bid.advantage.bid/seller-storefront.html?tab=market` > "Storefront
      pickup location" (full address including state) > save.
- [ ] **B4. Publish policies:** `https://bid.advantage.bid/seller-storefront.html?tab=store` > publish Store Terms and the
      Shipping & Pickup Policy (drafts exist).
- [ ] **B5. List the pilot item:** `https://bid.advantage.bid/seller-inventory.html` (or Add Item): price $1.00, quantity
      1, pickup only, published.

### C. Admin approval (you, as administrator, after B1)
- [ ] **C1. Approve:** the verification page above > the submitted request > review the documents > **Approve business
      verification**. Nothing is approved without a submitted request.

### D. Owner decisions (cannot be made in code)
- [ ] **D1. Sales tax** for the pickup state: CPA decision (`docs/operations/storefront-tax-configuration-steps.md`), then
      one rule at `https://bid.advantage.bid/admin/tax-jurisdictions.html`. Without a rule every order is refused
      (fail-closed). A Stripe Tax registration is account-wide and also taxes auction invoices in that state.
- [ ] **D2. Buyer Terms:** publish v4 covering fixed-price purchases (`docs/legal/buyer-terms-v4-fixed-price.md`), or approve
      v3 for the pilot in writing.
- [ ] **D3. Live Stripe webhook** (Stripe Dashboard, live > Developers > Webhooks): endpoint
      `https://bid.advantage.bid/api/payments/webhook` enabled; events `payment_intent.succeeded`, `payment_intent.canceled`,
      `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
      `charge.dispute.closed`, `transfer.created`, `transfer.reversed`, `account.updated`; signing secret equals Railway
      `STRIPE_WEBHOOK_SECRET`. Production has received no webhook since 2026-09-28 (no live activity since), and dispute and
      transfer events have never arrived. 8-step check: `docs/operations/stripe-live-webhook-verification.md`.
- [ ] **D4. Pilot buyer:** a buyer account separate from the seller (buying your own item is refused), with a real
      non-prepaid card you control (entered at checkout).
- [ ] **D5. Authorize activation** (explicit approval): set `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS` =
      `81d6f0ce-9f3c-4605-9c09-04cb9c1601fc` and `MARKETPLACE_CHECKOUT_PILOT_USER_IDS` = the buyer's user id. Leave
      `MARKETPLACE_CHECKOUT_ENABLED` unset (no one else can buy).

### E. The controlled purchase (after D5; `docs/operations/storefront-first-sale-test-plan.md`)
- [ ] E1. $1 pickup purchase as the pilot buyer; confirm receipt, seller and admin notices, order, inventory 0, fee 9%.
- [ ] E2. Seller marks ready for pickup / picked up; reporting period passes (48 h after pickup).
- [ ] E3. Weekly payout: admin "Pay Seller" (a live charge may need a few days to settle; retry if Stripe reports
      insufficient funds); confirm the transfer and the seller's payout.
- [ ] E4. Refund check on a second $1 purchase (admin refund), if wanted. Economics: about -$0.24 per $1 sale after card
      cost; a refund does not return the card fee (about -$0.33).
- [ ] E5. Clear the pilot lists; decide on broader activation (each further seller: verified, Connect live, policies,
      pickup or shipping, tax rule for its state).

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
