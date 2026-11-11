# Advantage.Bid — Development TODO list (platform-wide)

The one platform-wide list of approved-but-not-started work and open launch checklist items. Feature-area roadmaps keep
their own detail (for example `docs/projects/professional-storefront-roadmap.md`); this list points to them. Per the
Data Minimization and Focused Development principle in CLAUDE.md, nothing here is built until the owner starts it.

Last updated: 2026-11-11.

---

## 1. Launch checklist — first controlled real-money storefront purchase (OPEN)

Pilot seller: Timeless Treasures (`/pro/timeless-treasures`, the owner's own Professional Seller account; never Lewis &
Maese). Read-only GO/NO-GO review 2026-11-11: **NO-GO** until the items below are done. Checkout stays OFF until then;
the code paths (9% marketplace / 5% website commission, inventory holds, admin refund, seller isolation, notifications)
reviewed READY. Owner will address these separately.

- [ ] Approve the seller's business verification (`/admin/verification.html`); the publication gate blocks until approved.
- [ ] Seller completes Stripe Connect payout onboarding (ACH) until transfers and payouts are active.
- [ ] Seller sets a default pickup address including the state.
- [ ] Seller publishes Store Terms and the Shipping & Pickup Policy (both draft; checkout refuses `SELLER_POLICIES_REQUIRED`).
- [ ] Seller lists at least one item ($1, quantity 1, pickup).
- [ ] CPA decision for the pickup state, then an Admin > Tax Jurisdictions rule (0 rules today, so every order fails
      closed with `TAX_CONFIGURATION_REQUIRED`). A Stripe Tax registration is account-wide and also taxes auction invoices.
- [ ] Publish Buyer Terms v4 covering fixed-price purchases, or accept v3 in writing (legal decision).
- [ ] Separate pilot buyer account with a saved non-prepaid card (`CANNOT_BUY_OWN` refuses buying your own item).
- [ ] Set `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS` / `MARKETPLACE_CHECKOUT_PILOT_USER_IDS`; leave `MARKETPLACE_CHECKOUT_ENABLED` unset.
- [ ] Confirm the live Stripe webhook endpoint is enabled and points at production (last live webhook seen 2026-09-28).
- [ ] Accept the $1 test economics (about -$0.24 net to Advantage after card cost; about -$0.33 more if refunded).
- Known gap (not a blocker for the pilot): no seller-initiated order cancellation; refunds are admin-only.
- Test plan: `docs/operations/storefront-first-sale-test-plan.md` (branch `docs/storefront-launch-prep`).

## 2. Owner DNS action — DMARC reports out of info@ (OPEN)

`_dmarc.advantage.bid` sends aggregate reports to `info@advantage.bid` (the Sasha customer-service inbox). In the
Brilliant Directories DNS panel, replace the TXT value with
`v=DMARC1; p=none; sp=none; adkim=r; aspf=r; pct=100; fo=0; rf=afrf; ri=86400` (only `rua=` removed). Sasha already
ignores these reports (deployed 2026-11-11, main 31c15fb); this stops the mail itself. Verify with
`nslookup -type=TXT _dmarc.advantage.bid 8.8.8.8` once changed.

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
