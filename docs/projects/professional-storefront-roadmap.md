# Professional Seller Storefront — permanent roadmap and TODO

**This is the canonical, persistent roadmap for the Professional Storefront.** Update it whenever a milestone ships or an
owner decision lands. Related: owner requirements (2026-10-12) `professional-storefront-requirements.md`; readiness
assessment `professional-storefront-readiness-2026-10-15.md`; designs `seller-staff-permissions-design-2026-10-16.md`,
`retail-payout-policy-design-2026-10-16.md`.

## 0. Non-negotiable standards (apply to every item below)

**Security standard (owner, 2026-10-16).** Seller ownership is established server-side from the session, never from a URL,
body, header, widget or import file. Every order, fulfilment record, issue, refund, chargeback, payout and report carries
the transaction's verified seller, enforced by the database (composite keys + guard triggers, migrations 197/198) — a
mismatch is rejected, never corrected. Each milestone ships with authorization tests, database integrity checks,
adversarial cross-seller tests (Nora/Sue, multiple buyers and staff) and a security review **before** deployment.

**Pricing separation.** Storefront Buy Now never carries a buyer's premium: buyer pays item + shipping + tax; seller pays the
flat 11% fee on the item price (includes card processing). The storefront pricing code never loads auction pricing.

**Distribution.** All storefront inventory is always displayed on Advantage.Bid; widgets read the same authoritative
inventory (one record, never a second copy). A seller-site-only option is not part of the model. Sellers without a website
use their Advantage.Bid company storefront page (`/pro/:slug`). Advantage.Bid attribution is kept; never call the widget
fully white-label unless that is actually built.

**Privacy.** No SEO page, API, widget, feed or structured data may expose private seller addresses, buyer information,
transaction records or internal inventory data. Public location = city/state.

**Data minimization and focused development (owner, 2026-10-16; permanent, whole platform — also in `CLAUDE.md`).**
Collect only what is legally, processor- or operationally required (Stripe Connect for taxpayer identity, never
duplicated; no universally mandatory EIN, licence or registration field without a verified requirement and documented
basis). Every milestone states its purpose, scope, acceptance tests and completion criteria; approved future features
stay in this roadmap and are not built early.

**Safety switches.** Live checkout (`MARKETPLACE_CHECKOUT_ENABLED`), payouts, external merchant feeds, paid shopping ads and
public marketing of unfinished features stay OFF until the readiness checks in §6 pass and the owner approves.

## 1. Status (production checkpoint 2026-10-26: main = `2ff6bf9`, migrations through 205; messaging OFF)

| Milestone | Status |
|---|---|
| M1 inventory + checkout safety | LIVE (30ca30c) |
| Ownership + order integrity (migration 197) | LIVE (3a16946), verified in production |
| Professional auction buyer's premium policy + Buy Now 0% premium separation | LIVE (0672359, 7cb793a) |
| M2 moderation, reports, buyer issues, seller permission checkpoint (migration 198) | LIVE (6f6762b), verified in production |
| Seller staff accounts (migration 199) | LIVE (5dab1ae, 2026-10-16), verified; OFF (`SELLER_STAFF_ENABLED` unset) until production phone-code + step-up verification |
| Product SEO foundation (migration 200) | LIVE (5dab1ae, 2026-10-16), verified in production (see §4 "Built") |
| Existing-item product detail editing | LIVE (34a547d, 2026-10-16), verified in production |
| Shipping controls (migration 201, §7.1) | LIVE (7ccd039, 2026-10-16), verified in production; demo items set to pickup only (owner) |
| Staff one-company pilot | LIVE (010eb01, 2026-10-16); general switch off, pilot list empty — no company enabled until the owner confirms the authorised account and phone verification |
| EIN / taxpayer-ID minimisation (migration 202) + seller sale email without buyer contact | LIVE (5e2a4f7, 2026-10-16), verified in production |
| Seller Store Terms + Shipping & Pickup Policy, storefront tabs, item links, purchase snapshots + acknowledgment (migration 203, §7.2–7.4) | LIVE (6383329, 2026-10-16), verified in production (rolled-back DB check `scripts/prod-verify-203.js` PASS) |
| **Milestone N: seller inventory numbers + reliable paid-sale seller notifications** (§8.1–8.2, migration 204) | LIVE (0c069e6, 2026-10-16), verified in production (`scripts/prod-verify-204.js` rolled-back PASS; no email sent) |
| Estimated-proceeds wording in the sale email, known-issues log (MI-1), milestone Q scope, `prod-verify-204.js` | Built on `feat/item-messaging` (`c80dcfc`); not deployed |
| **Milestone Q: secure item-specific buyer-to-seller messaging** (§9, migration 205) | LIVE (code `27ac6c6`, deployed with docs at `2ff6bf9`, 2026-10-26); two independent review rounds, findings fixed; gate green; migration 205 applied + verified (prod-verify-205 rolled-back PASS); flag `STOREFRONT_MESSAGING_ENABLED` stays unset (off) until the owner approves |
| **Milestone 206: sold-item price privacy + message reporting, moderator hiding and controlled messaging pilot** (§9.1, §12.3, migration 206) | Built 2026-10-26 on `feat/sold-price-privacy`; not committed, not deployed; migration 206 NOT applied; messaging and pilot stay OFF (all three settings unset). Waiting for owner review, then commit, independent review and the production gate |
| Widget header, search & filters (§10) | Requirements + design recorded 2026-10-16 (`storefront-messaging-and-widget-design-2026-10-16.md`); not built |
| Bulk import, settlement/statements, tax responsibility, compliance profile, tax-time reports (§8.3–8.7) | Requirements + architecture recorded 2026-10-16 (`storefront-notifications-inventory-finance-compliance-plan-2026-10-16.md`); not built |
| Storefront website widget (§7.5–7.6) | Requirements recorded 2026-10-16; not built |
| M3 retail settlement and payouts | Policy design awaiting owner decisions; nothing moves money; storefront orders are not yet in any settlement or payout report |

Launch readiness: `professional-storefront-launch-readiness-checklist.md` (what is live, built, required before the
first real sale, post-launch, and the owner decisions still open). Technical maintenance: `../operations/known-issues.md`.

## 2. Development sequence (owner priorities 2026-10-16, dependency-ordered)

Done: staff accounts + one-company pilot framework (LIVE, off), product SEO (LIVE), existing-item editing (LIVE),
shipping controls (LIVE), EIN protection (LIVE), seller policies + snapshots (LIVE), inventory numbers + sale-notification
queue (LIVE). Item questions (6) LIVE and OFF (Milestone Q); Milestone 206 (sold-item price privacy, message
reporting/hiding, controlled pilot) built, awaiting owner review, commit and deploy approval.

1. **Staff pilot verification** — owner confirms the authorised pilot account and verifies its phone; then one company
   is added to `SELLER_STAFF_PILOT_SELLER_IDS` and the owner runs invite + step-up; then "Your Team" rollout.
2. **EIN protection** (§8.6 "EIN") — before any seller can enter a taxpayer number in production (none stored today).
3. **Seller Store Terms + Shipping & Pickup Policy** (§7.2), storefront tabs + item policy links (§7.3), purchase
   snapshots + acknowledgment (§7.4).
4. **Seller inventory numbers / SKU** (§8.2).
5. **Reliable sold-item notification queue** (§8.1) — required before live checkout. (Content already corrected: no buyer
   contact in the seller email.)
6. **Item questions and secure seller replies** (§9; flag off until security + privacy testing) — shares the outbox (5).
7. **Storefront ledger, settlement statements and tax accounting** (§8.4–8.5; Milestone 3; transfers off).
8. **Seller compliance profile** (§8.6) and tax-time reports (§8.7; exports only).
9. **Storefront search, filtering and sorting** (§10.2) — shared by marketplace and widget.
10. **Branded website widget with optional navigation header** (§7.5–7.6, §10.1; checkout only on Advantage.Bid).
11. **Spreadsheet and image bulk import** (§8.3).
12. **Shopping-network feeds** (§4.4) and **final launch readiness** (§6: Stripe production verification, readiness
    gates), then the **public marketing launch** (§3).
No requirement is dropped or indefinitely deferred. Live checkout, payouts, external shopping submissions, tax filing
and remittance stay OFF until explicitly approved.

## 3. TODO — Public-facing Professional Seller marketing (owner requirement 2026-10-16)

Prepare in advance; launch only with confirmed operational readiness (storefront working, Stripe production verified, ready
for real sellers and transactions). Lead with the seller's benefit: more sales opportunities, wider buyer reach, easier
inventory management, more value from existing inventory. Keep existing seller-first terminology and the Seller Programs
page rules.

Message — Professional Sellers can:
- conduct online auctions;
- promote estate sales;
- sell fixed-price inventory through their own Advantage.Bid Professional Storefront;
- reach shoppers through the Advantage.Bid marketplace;
- convert eligible unsold auction items into fixed-price listings;
- *(only once launched)* display storefront inventory on their own website with the embeddable storefront widget;
- *(only once launched)* use bulk inventory import tools.

Pages that will need updates:
- Railway platform: `professional-sellers.html`, `become-professional-seller.html`, `become-seller.html`, `start-selling.html`,
  `how-it-works.html`, `how-sellers-get-paid.html`, `seller-faq.html`, `faq.html`, `pro.html`, `storefront.html`,
  `seller-storefront.html` (seller onboarding/empty state), `index.html` marketplace sections, `free-business-listing.html`
  and `claim-listing.html` (upgrade path), seller dashboard prompts.
- Advantage.bid (Brilliant Directories): Professional Seller / membership pages, seller information pages, company
  profile pages (link to the company storefront), city pages where the marketplace widget appears.
- Sasha knowledge articles (e.g. `professional-storefront-fee`) so phone and chat answers match what is launched.
- Emails: seller onboarding / welcome sequences.

## 4. TODO — Product-level SEO and shopping discovery (permanent architectural requirement, 2026-10-16)

### Built and LIVE (2026-10-16, production 5dab1ae)
- Canonical `/shop/item/<uuid>/<slug>` (server-rendered title, description, canonical, Open Graph, Product + Offer +
  BreadcrumbList JSON-LD, item content, "More from this seller" links). Other slugs and `/item.html?id=` 301 to it;
  non-public items 404 + noindex; demo items noindex. One product record per item (browser copy removed).
- Migration 200 product fields (brand, manufacturer, GTIN with check-digit validation, MPN, condition type, era/period,
  material, per-photo descriptions); `identifier_exists` is derived, never entered. Seller add-item form has an optional
  "Product details" section. Single source: `src/lib/productData.js`; pages: `src/services/productPageService.js`.
- `/sitemap.xml` lists published non-demo Professional storefronts and live (active / in-checkout) items, never draft,
  removed, taken-down, sold, demo or non-Professional ones. Tests: `tests/storefront-product-seo.test.js` (§4.5 list).
- Not yet: feed builder/mappers (§4.4), per-item edit form for the new fields (API supports it), category pages.
- **Sold-page policy (owner-approved 2026-10-16):** a sold item keeps its permanent URL and stays reachable with a clear
  SOLD indication and `SoldOut` structured data; it is never purchasable or advertised as available; it is removed
  promptly from the sitemap and from any future shopping feed; it links to the seller's other available items; no buyer
  identity, transaction detail or confidential seller information is shown.

### Next (owner-approved order, 2026-10-16)
1. Verify the staff phone-code / sensitive-action workflow in production with safe, authorized testing (needs the owner's
   verified phone and production phone-code sending enabled).
2. Seller-facing "Your Team" navigation and staff-invitation rollout (then `SELLER_STAFF_ENABLED=true` with approval).
3. Existing-item product-detail editing interface (the API already accepts the fields).
4. Shopping-feed builder design (Google Merchant Center first, destination-neutral; no submission without approval).
5. Milestone 3 retail settlement with live transfers disabled.
6. Public Professional Seller marketing launch after checkout and Stripe readiness.
Design focus: antiques, collectibles, vintage furniture, artwork, estate merchandise and one-of-a-kind inventory; never
invent a GTIN, brand, manufacturer or other identifier; storefront ↔ item internal linking.

### 4.1 Item page architecture
Today (gap): items live at `/item.html?id=<uuid>`, render in the browser with a generic `<title>`, add JSON-LD client-side,
and are not in `/sitemap.xml`. `/pro/:slug` storefront pages are already server-rendered.
- Stable, crawlable product URL, e.g. `/shop/item/<uuid>/<title-slug>`; the UUID is authoritative, the slug cosmetic
  (a changed title 301-redirects to the current slug; never two indexable URLs for one item). `/item.html?id=` 301s to it.
- Server-rendered title, meta description, canonical, Open Graph, and the full product content (same allow-list as
  `marketplaceItemService.publicItem`), following the `/pro/:slug` and shareMeta pattern.
- Schema.org `Product` + `Offer` (price, `priceCurrency` USD, `availability` InStock / SoldOut / OutOfStock while reserved,
  `itemCondition`, `url`, `seller` = verified Professional Seller organization name), `image` list, `brand`/`gtin`/`mpn`
  only when legitimately known.
- Multiple images with meaningful alt text (title + view description), largest image first.
- Internal links: marketplace → category → seller storefront → item, and item → seller storefront + related items.
- Non-public states (draft, removed, taken down, non-Professional seller): 404 with `noindex`; sold: stays reachable as SOLD
  with `availability` SoldOut until removed (decision: how long sold items remain indexed).

### 4.2 Product data model additions
`brand`, `manufacturer`, `gtin`, `mpn`, `identifier_exists` (false for antiques, vintage, handmade, one-of-a-kind),
normalized `condition` (new / used / refurbished, plus a descriptive grade for estate items), `era_or_period`, `material`,
`dimensions` (optional), per-image `alt_text`, Google product category mapping. **Never invent GTINs or manufacturer data**;
secondhand/antique items are submitted as used/vintage with identifiers marked as not existing. Verify the exact attribute
names and rules against each destination's current specification at implementation time (they change).

### 4.3 Sitemap and indexing
- `/sitemap.xml` (or a dedicated product sitemap index) lists every eligible public item with `lastmod` = item `updated_at`.
- Draft, private, removed, taken-down, non-Professional and demo items are never listed, indexed or fed.
- Availability changes (reserved, sold, removed, taken down) update the page, structured data, sitemap and feed together.

### 4.4 Merchant / shopping feed
- Railway is the only source of product data. A feed builder produces a destination-neutral product record from the same
  allow-list used by the item page; per-destination **mappers** (Google Merchant Center first) translate and **validate**
  required attributes; adding a network = a new mapper, never new product records.
- Feed shows actual price, availability, condition, seller identity and canonical product URL; excludes anything not public.
- Generate and validate internally only. **No submission to external networks and no paid shopping ads without owner
  approval and merchant-account setup.** Eligibility is never guaranteed (merchant verification, policies, checkout rules).

### 4.5 Required automated tests
Published product data = database values; feed and structured data price/availability = database; a sold, reserved,
removed or taken-down item is never advertised as available; seller attribution always the item's real seller; private,
draft or moderated listings never appear in feeds, sitemap or structured data; no auction buyer's premium in any storefront
price; one canonical URL per item (no duplicate or conflicting product records); no private address/buyer/order data in any
public output.

## 5. TODO — Future storefront features (official roadmap)
- Buyer-facing marketplace search with high-value product filters.
- Per-storefront search and filters.
- Separate embeddable Professional Storefront widget on the same authoritative inventory (tenant-scoped by seller UUID,
  privacy-safe, Advantage.Bid attribution, canonical links to bid.advantage.bid).
- Seller branding and widget customization.
- Bulk CSV/spreadsheet import: seller-scoped (never another seller's items), inventory numbers, multiple photos with image
  ownership validation, field mapping, preview, duplicate detection, error report; imports always create **drafts** for review.
- Inventory synchronization across Advantage.Bid and seller-site widgets (one record; no second inventory that could sell
  an item twice).

## 6. Readiness gates before live checkout / payouts / feeds / marketing
- Stripe production payments + webhooks verified (owner Dashboard check).
- Stripe Connect onboarding + payout account verification.
- Stripe Tax configuration and registrations (test-mode head office known missing).
- Seller and buyer ownership protections (done: 197/198) and seller staff permissions (LIVE: 199, switched off).
- Fulfilment and delivery verification (M3), refund and chargeback handling (partly done), reconciliation and payout holds (M3).
- Administrative oversight and audit logs (admin read access is not yet logged).
- Paid-sale seller notifications queued, idempotent and monitored (§8.1, N1) — DONE (LIVE 0c069e6).
- Seller policies + purchase snapshots (§7.2–7.4) — DONE (LIVE 6383329); storefront ledger, statements and reconciliation (§8.4, M3a/M3b) — not built.
- Advantage.Bid Buyer Terms cover fixed-price storefront purchases (the live terms do not mention them; the v4 draft is
  unapproved and is never deployed without owner approval).
- Sales tax remitting party determined per jurisdiction after qualified review (§8.5); undetermined → tax held.
- Seller compliance data minimised with logged access (§8.6): EIN field retired (LIVE 202, no EINs stored).

## 7. TODO — Shipping, seller policies, storefront tabs, checkout acknowledgment and storefront widget (owner requirements 2026-10-16, permanent)

Applies together with §0. Every record below belongs to the verified seller organization taken from the session (never
a browser-supplied seller id); one seller can never read, change or display another seller's settings or policies.

### 7.1 Shipping options — default NO shipping
Requirements:
- Store-wide default shipping setting, initially **disabled**; an item-level shipping toggle, initially **disabled** unless
  the seller deliberately applies an approved store default; an explicit **pickup only** designation.
- Shipping methods, service areas, handling times, shipping charges and restrictions; settings for large furniture,
  fragile antiques and oversized merchandise (e.g. freight / white-glove / local delivery / pickup only).
- Items override the store default. **Changing the store default never silently changes existing published listings**
  (the default applies to new items only; a bulk "apply to existing items" would be an explicit, previewed action).
- Shipping charges are calculated or explicitly set before checkout. **Never invent a charge or silently offer free
  shipping**; free shipping only when the seller explicitly sets it. A buyer can never choose shipping on a pickup-only item.
- Every product page states clearly whether shipping, pickup, or both are available.
- The 11% seller fee stays on the item price only; shipping and sales tax remain outside the fee base.

Today (already supported): `marketplace_items.shippable` (default false), `shipping_cost_cents`, `shipping_notes`; a new
direct listing is not shippable unless the seller ticks shipping; checkout refuses shipping on a non-shippable item
(`SHIPPING_UNAVAILABLE`); the fee is computed on the item price only; the product page shows "Shipping available" or
"Local pickup". **Gaps to close in this milestone:** (a) a shippable item with no shipping price is charged $0 shipping at
checkout (`marketplaceOrderService` treats a missing price as 0) — must be refused until the seller sets a price or
explicitly marks shipping free; (b) converting an auction lot copies the lot's shipping setting instead of starting at
"no shipping"; (c) no store-wide default, methods, service areas, handling time, size class or restrictions.
Migration needed: yes (store shipping defaults on the seller organization; item shipping method/handling/area/size/
restriction fields and an explicit free-shipping flag; database checks that shipping cannot be offered without a set price).

**Built (migration 201) — LIVE 7ccd039:** `src/lib/storefrontShipping.js` is the single
authority (checkout, item page, structured data, storefront grid; later the widget and feeds). Pickup only by default;
converted lots always start pickup only; shipping needs method + destinations (contiguous US / all US / listed states) +
a set price or explicit free shipping, enforced in the service and by a database trigger that fires only on shipping
changes (status changes on older listings are never blocked); older listings without complete terms stay listed, pickup
works, shipping checkout is refused until completed. Handling days, oversized, fragile, notes. Store-wide default (off)
applies only to new items when the seller chooses it, never to existing listings. Orders record the offered and selected
shipping terms in the immutable item snapshot. Fee stays 11% of the item price. Seller UI: add form, edit panel, store
default. Tests in `tests/storefront-ownership-adversarial.test.js` ("shipping:" sections).

### 7.2 Seller Store Terms & Conditions and Shipping & Pickup Policy
- A dedicated account area where each Professional Seller writes, edits, previews and publishes their **own** Store Terms
  & Conditions (descriptions and condition, as-is disclosures subject to law, returns and cancellation, inspection,
  pickup deadlines, buyer responsibilities, other seller conditions) and, separately, a **Shipping & Pickup Policy**.
  Each is edited, previewed and published independently.
- Stored under the verified seller organization with version history (append-only published versions), timestamps and an
  audit trail (who edited and published, when). Strict per-seller isolation enforced by the database (composite keys,
  the 197/198 pattern).
- These are the seller's terms, not Advantage.Bid's Buyer Terms; Advantage.Bid's platform terms stay separate and prevail:
  seller terms cannot override mandatory platform policies, payment protections, consumer rights or legal requirements.
  The interface says so. Advantage.Bid never auto-generates legally binding terms for a seller and never presents
  seller-entered text as legally approved (optional neutral headings/prompts only).
- **Built (migration 203, branch `feat/seller-policies`):** `seller_policy_versions` (append-only; draft editable, published
  words fixed forever by trigger, publish supersedes the previous version, nothing deleted), owner editor (save draft,
  preview, publish per policy), public API and server-rendered pages `/pro/:slug/terms` and `/pro/:slug/shipping-pickup`
  (escaped plain text, canonical, sitemap, noindex for demo, note that Advantage.Bid Buyer Terms also apply and prevail),
  storefront tabs (Shop Items / Store Terms / Shipping & Pickup), item-page links to the item's own seller's policies,
  checkout acknowledgment (required by the order service) and an immutable `policy_snapshot` per order (seller versions +
  content hashes + current platform Buyer Terms version; database refuses changes and refuses another seller's version).

### 7.3 Policy access across the storefront and product pages
- The public storefront (`/pro/:slug`) offers **Shop Items**, **Store Terms & Conditions** and **Shipping & Pickup Policy**
  — tabs on desktop, an accessible equivalent (stacked sections / select) on small screens.
- Every product page links to **its own seller's** policies (an item from Heritage & Home links only to Heritage & Home's).
- Stable, crawlable public URLs, e.g. `/pro/:slug/terms` and `/pro/:slug/shipping-pickup`, server-rendered; available on
  Advantage.Bid whether or not the seller has a website.
- Today: storefront is server-rendered at `/pro/:slug` with items; no policy tabs. Migration needed: no (needs 7.2).

### 7.4 Policy acknowledgment and immutable snapshots at checkout
- Before a fixed-price purchase the buyer can open the applicable seller's Store Terms and Shipping & Pickup Policy and
  Advantage.Bid's platform terms, and acknowledges them (design: an unticked confirmation naming the seller, with links;
  the order cannot be created without it).
- Each order permanently records the exact policy versions in force at purchase (version ids + content hash) and the
  acknowledgment time; later edits never alter an existing order's record (database-enforced immutability, as with the
  migration 197 snapshots). Separate from auction buyer's premium settings and auction terms.
- Checkout stays OFF; the unapproved platform Buyer Terms draft is not modified or deployed by this work.
- Today: orders already keep immutable item/seller/pickup snapshots (197). Migration needed: yes (policy-version and
  acknowledgment columns on orders + guard).

### 7.5 Professional Storefront website widget
- Separate from the auction and estate-sale widgets. Shows the seller's name, branding and logo, published fixed-price
  inventory (photos, prices, descriptions, availability), search and filters, Store Terms and Shipping & Pickup Policy
  (Shop Items / Store Terms / Shipping & Pickup tabs, accessible small-screen alternative), and links to each product and
  to checkout **on Advantage.Bid**.
- **Owner checkout decision (2026-10-16):** for the initial widget release every purchase completes through Advantage.Bid
  checkout. No checkout or payment processor inside the seller's website widget. The widget shows the seller's branded
  merchandise, prices, availability, Store Terms and Shipping & Pickup Policy, then sends the buyer securely to the
  Advantage.Bid item and checkout. Advantage.Bid remains the source of truth for inventory, payments, tax, order records,
  refunds and fulfillment.
- Presentation settings (colors, layout, logo display). Policies and inventory are read live from the same authoritative
  records as the public storefront — no duplicate documents or inventory for sellers to maintain.
- Tenant-scoped by a server-issued widget key bound to the seller organization (the white-label auction widget's
  token-scoped pattern), never a seller id trusted from the browser. Never exposes private seller information, buyer data,
  unpublished inventory, pickup street addresses, financial records or another seller's policies.
- SEO: the widget never creates competing indexable product pages (product links point to the canonical
  `/shop/item/<id>/<slug>` URL; widget frames are noindex), so the deployed product SEO foundation is preserved.
- Today: no storefront widget. Migration needed: yes (widget settings/keys per seller).

### 7.6 Mandatory dual distribution
- Every eligible Professional Seller fixed-price listing is published on the Advantage.Bid marketplace; the widget may also
  show it. There is no seller-website-only option.
- Advantage.Bid remains the authoritative inventory, pricing, availability, order and transaction system; all payments use
  the approved Advantage.Bid checkout and financial safeguards; the widget never introduces another payment process.
- A sale through either surface makes the item unavailable on both immediately; no duplicate sales, stale prices or
  conflicting status.
- Today (already supported structurally): one `marketplace_items` record per item, no seller-site-only status, checkout
  reserves the item row under a lock (`pending_purchase`) and the database refuses a second live order, and every surface
  reads the same record. The widget must keep that (read live, never cache availability for purchase decisions).

### 7.7 Shopping networks and SEO
- Keep the deployed product SEO foundation and canonical Advantage.Bid URLs; no duplicate indexing from widgets.
- Feeds carry accurate availability and shipping eligibility (from 7.1); antiques, collectibles, furniture and one-of-a-kind
  inventory are supported without fabricated identifiers.

### 7.8 Required tests (added to every relevant milestone)
Shipping defaults (store and item default off; store default change never alters existing listings; no shipping without a
set or explicitly free price; pickup-only cannot be shipped; fee base excludes shipping and tax); seller policy isolation
(cross-seller read/write/display refused; versions append-only); checkout policy snapshots (recorded at purchase, immutable,
unaffected by later edits); widget ownership (key bound to one seller; no private or unpublished data; another seller's
policies never shown); inventory synchronization (a sale on either surface removes availability on both; no double sale).

## 8. TODO — Sale notifications, inventory numbers, bulk import, settlement, tax and seller compliance (owner requirements 2026-10-16, permanent)

Full detail, current-state review, architecture, milestones (N1, N2, M3a, M3b, T1, C1, R1, I1) and acceptance tests:
`storefront-notifications-inventory-finance-compliance-plan-2026-10-16.md`. Summary of what must never be dropped:

### Milestone N (current) — inventory numbers + reliable paid-sale seller notifications
- **Purpose:** a seller is told reliably, once, and only after payment is confirmed, exactly which item sold (with their own
  inventory number), so they can fulfil it — a prerequisite for live checkout.
- **Scope:** (1) optional per-item inventory number/SKU, unique within the seller's live items, editable on add/edit,
  searchable in the seller's item list, copied into the order snapshot and shown on the seller's orders page; (2) a
  storefront notification outbox: one row per (order, event, recipient) created **inside the paid transaction**,
  delivered by a worker with lease, back-off retries, a final-failure owner alert and an audit trail; (3) the paid-sale
  email: item title, description excerpt, real thumbnail when available, inventory number, sale price, order number,
  fulfilment method, the 11% platform fee on the item price and the estimated proceeds, and a link to the authenticated
  seller order page — **no buyer name, email, phone or address**. Recipient: the company owner's account email.
- **Out of scope (stays in roadmap):** notification preferences and staff recipients (staff are off), other event types
  (refund, dispute, pickup, payout), buyer-receipt queueing, exports/statements, bulk import, messaging, widget, filters.
- **Acceptance tests:** no notice for started/pending/failed checkouts; exactly one notice per paid order under webhook
  replay and worker crash/retry; a failed send is retried with back-off and alerts after the last attempt; a notice can
  only reference its own seller's order (database); the email contains no buyer contact or address; inventory numbers
  are unique per seller but reusable across sellers, preserved through edits, sale and refund, and immutable on the order.
- **Completion criteria:** tests green in the full gate; security review with findings fixed; production pre-check +
  migration verified; owner approval to deploy; production verification with a rolled-back check (no real email sent
  without an authorised test).

### 8.1 Immediate seller sale notifications (before live checkout)
Email to the seller's company address and opted-in fulfilment staff **only after payment is confirmed** (never on
checkout start or pending payment): item title + description, the seller's inventory number, a thumbnail of the real
photo, confirmed sale price, order number, shipping or pickup, the next fulfilment action, a secure link to order
management, and a labelled estimated proceeds amount if reliable. Queued, idempotent (one per order/event/recipient),
retried, monitored, audited; never another seller's order, never payment credentials or unnecessary buyer data.
Separate notices planned for cancellation, refund, dispute, pickup confirmation, shipping deadline, payout completion.
LIVE (0c069e6): queued outbox, owner recipient, retries + failure alert, thumbnail and inventory number. Still to do:
staff recipients and preferences, and the other event types listed above.

### 8.2 Seller inventory numbers / SKU
Per item, seller-scoped (sellers may reuse each other's numbers), searchable in the dashboard, carried into orders,
notices, settlement reports and exports, preserved through imports, edits, sales, refunds and reporting. LIVE (0c069e6): per-item, seller-scoped, searchable, in order snapshots and sale notices. Still to do: settlement
reports, exports and imports.

### 8.3 Bulk inventory import and image migration (major committed deliverable)
CSV/spreadsheet; multiple images; image URLs + authorised image migration; inventory number/SKU mapping; flexible column
mapping; Shopify and Etsy export presets where practical; preview and dry run; duplicate detection; create vs update;
error reports; resumable large imports; progress and completion reports; category, condition, dimensions, materials,
shipping, price and SEO fields. Seller ownership verified on every record. Imported items are **drafts** until the
seller authorises publication; shipping **off** unless complete shipping settings are explicitly confirmed. Never
publish or overwrite another seller's records or create duplicate purchasable listings. Dual distribution preserved.

### 8.4 Seller settlement and deposit breakdowns
Per sale and per payout: seller and account, order and inventory numbers, item description, gross item price, shipping
collected, sales tax collected, tax jurisdiction and remitting party where determined, 11% fee on item price only,
refunds/partials, chargebacks/disputes, adjustments, held/pending, eligible, actually transferred, payout date,
transaction reference, reconciliation status. Distinguish collected / owed / held / remitted as tax / transferred.
Never assume collected tax belongs in seller deposits. Reconcile to Stripe, orders, refunds, fees and bank transfers.
Seller statements + authorised admin reports with CSV/spreadsheet export. Immutable append-only accounting with audit
trail; no silent retroactive changes.

### 8.5 Sales tax responsibility — legal and accounting review (before checkout or payouts)
Document actual collection and remittance obligations (marketplace facilitator, seller, jurisdiction rules) from current
authoritative guidance with qualified review. Assume neither "seller always remits" nor "Advantage.Bid always remits".
The system identifies the remitting party per transaction and jurisdiction; undetermined → tax portion held. Preserve
the Stripe Tax integration; no live tax/payment configuration change without authorisation.

### 8.6 Professional Seller legal and compliance profile
**Scope rule (owner, 2026-10-16):** build only fields with a verified legal, processor or operational requirement. Today
that is the Stripe-held taxpayer-ID *status* (migration 202) and the existing business-verification documents
(registration or licence). Everything listed below is a candidate, not a plan — each needs its basis documented before
it is collected.
Legal name, DBA, entity type, business address, operating states, taxpayer id verification status, state tax
registrations, auctioneer licences (number, state, expiry) and other licences where legally required, documents,
verification status, review dates, expiry reminders. Requirements differ by seller category and state; no universal EIN
or licence requirement without confirming the law. Prefer Stripe-verified taxpayer data and tokenised references;
encrypt sensitive numbers, minimise storage, restrict and log access, retention/deletion controls. Never on public pages,
SEO, widgets or ordinary seller emails.

**EIN assessment (2026-10-16).** Production holds **no EINs** (`seller_identity` has 0 rows; no audit record contains
one; no EIN documents uploaded), so nothing is exposed today. The code paths are unsafe for future use: (a) the seller
business-verification form (`verify-documents.html` → `verificationService.upsertBusinessInfo`) stores the full EIN as
plain text in `seller_identity.ein`; (b) admin `GET /api/admin/verification/sellers/:id/business` returns it in full to
any administrator, unlogged; (c) admin agreements `GET .../identity` returns the whole row; (d) `sellerIdentityService.
upsertIdentity` writes the full before/after row (EIN included) into `audit_log` metadata. Sellers only ever see it
masked; request logs record method/path/status only (no bodies). **Remediation (next, before any seller enters an EIN):**
stop copying identity rows into audit metadata (record changed field names only); store a taxpayer number only encrypted
(application-level envelope encryption, key outside the database) with last-4 in clear, or — preferred — not at all,
relying on Stripe Connect's verified taxpayer status; full view only with a dedicated permission, every view logged;
masked everywhere else. Existing rows: none to migrate today; the migration still ships a reviewed, reversible
backfill for any row that appears before it runs. No identity records are deleted.
**Owner decision 2026-10-16:** Stripe Connect collects and verifies taxpayer IDs; Advantage.Bid stores no complete EIN
unless a verified legal/operational requirement arises. Remediation built (migration 202, branch `feat/ein-remediation`):
EIN never accepted or stored (database CHECK), no full-EIN admin view, identity reads allow-listed, audit log records
changed field names only, taxpayer-ID status (+ at most last 4 from the processor) kept; business verification continues
with state registration or business licence documents (IRS EIN letters no longer requested).

### 8.7 Tax-time and financial reporting
**Scope rule:** only the reports an actual obligation or the ledger reconciliation needs, built with Milestone 3; no
filing features.
On-demand admin reports by tax year, seller, state, jurisdiction or period: gross sales and counts, refunds/chargebacks/
adjustments, commission revenue, shipping, tax collected by jurisdiction, tax remitted by verified party, payouts,
balances and holds, seller verification status, information-return data. Evaluate 1099-K and state reporting obligations
before any filing functionality (the payment settlement entity may be the filer). Validation, exceptions, audit logs,
exports. **No automatic filing, remittance, financial-record changes or government submissions without explicit
approval and verification.**

### 8.8 Preserved requirements (do not drop)
Seller Store Terms + Shipping & Pickup Policies; versioned policy snapshots at purchase; storefront policy tabs and
correct seller-specific item links; branded seller website widget with checkout only on Advantage.Bid; marketplace ↔
widget inventory synchronisation; product search with ~10 high-value filters; product SEO and future shopping feeds;
antiques and unique items without invented identifiers; staff roles and company isolation; refunds, disputes,
fulfilment and payout controls; seller followers and authorised follower notifications; public Professional Seller
marketing only when features are genuinely ready.

## 9. TODO — Ask the seller a question / on-platform messaging / anti-circumvention (owner requirements 2026-10-16, permanent)

### Milestone Q (next) — secure item-specific buyer-to-seller messaging
- **Purpose:** buyers can ask a seller about a specific item on Advantage.Bid without either side exchanging personal
  contact details, so item questions no longer leave the platform.
- **Scope:** (1) item-bound conversations (buyer ↔ the item's seller company; signed-in buyers only in this milestone),
  append-only messages, access for the buyer, the seller owner (and staff with a messages permission once staff are on),
  and logged Advantage.Bid support; (2) layered detection L1–L4 from the design (explicit and disguised contact details
  masked; off-platform payment, "Google my business / call me", "find me on Facebook", "contact the store for a better
  price", "5% off in person", external checkout links held for human review, with a polite rephrase option);
  (3) a review queue tab in the moderation dashboard with decisions and an appeal note, all audited; (4) notification
  events `message_to_seller` / `message_to_buyer` on the existing outbox (no contact details, secure reply link);
  (5) item page "Ask the seller a question" behind a feature flag (OFF), seller and buyer inbox pages; (6) per-buyer,
  per-seller and per-IP rate limits and duplicate suppression.
- **Out of scope (roadmap):** guest (email-verified) askers, attachments, L5 cross-conversation scoring, in-app/push,
  replacing the storefront consultation form (only item pages switch to the new button when the flag is turned on).
- **Acceptance tests:** cross-seller and cross-buyer reads/writes refused (database + API); every L1–L4 example from the
  owner's list masked or held as specified, and a set of legitimate questions (condition, measurements, photos,
  authenticity, shipping cost/destination, pickup/delivery, inspection appointment, on-platform price change) delivered
  untouched; held messages never silently deleted; no automatic penalty path exists; notifications contain no contact
  details; rate limits; append-only history.
- **Completion criteria:** full gate green; security + privacy review with findings fixed; production pre-check +
  rolled-back verification; owner approval to deploy; feature flag stays OFF until the owner approves turning it on.
- **Built (2026-10-26, branch `feat/item-messaging`, not deployed):** migration 205 (`storefront_conversations`,
  append-only `storefront_messages` with original and delivered text, `storefront_message_reviews`,
  `storefront_conversation_access_log`; outbox events `message_to_seller` / `message_to_buyer`); screening rules
  `src/lib/messageScreening.js` (versioned); service `storefrontMessagingService.js`; routes `/api/storefront-messages`
  (all 404 while the flag is off) and `/api/admin/storefront/messages|conversations` (marketplace.moderate); pages
  `/my-questions.html`, `/seller-messages.html`, an "Item messages" tab in Storefront Moderation, the item-page button
  (only when the flag is on, replacing the contact-form link on item pages). Seller permissions
  `company.messages.view|respond` are granted to the owner only. Tests: `tests/storefront-item-messaging.test.js`,
  `tests/message-screening.test.js`. Production scripts: `scripts/prod-migrate-205.js` (`--check`) and
  `scripts/prod-verify-205.js` (rolled back, no email).
- **Independent security review (2026-10-26):** no cross-seller or cross-buyer access path, no identity or contact leak,
  all text escaped, migration safe for production. Fixed: common phone formats not hidden (555-1234567, letters for
  digits), disguised emails and domains ("s m i t h @ g m a i l", "myshop .com", "dotcom", "bob dot smith at …"),
  diversion via social networks / other marketplaces ("FB: …", "on my etsy shop", "$20 off if you pay in person"),
  ordinary antique questions wrongly held ("chime", "new wire", "messenger bag", "ETH Zurich", "see it in person"), a
  notice that could be lost while another was sending, a client-rotatable network limit, removed staff acting on old
  messages, a release/new-message race, an unkeyed network-address hash, and editable decline/delivery/appeal fields.
  Re-review of the fixes: all fixed; its new false masks (measurements "2 x 4 at 6 x 8", size and year lists, "mail
  drop", "polka dot co-") and further bypasses ("my insta is …", "g-mail", "d0t com", "v3nmo", "google it", "I accept
  cash", "twenty dollars off") were fixed in rule version msg-screen-2026-10-26.3.
  Accepted as known: ambiguous mentions such as "I saw this on Facebook / eBay" are held for a person (review-queue
  volume); a single unbroken 10-digit model number is hidden as a phone number; parallel requests can slightly exceed
  the per-buyer limits; a message delivered at the instant its thread's waiting notice starts sending can be covered by
  that email without its own; generic phrasing such as "search Smith Antiques Houston" or split words ("zel le") passes.
- **Owner decisions 2026-10-26 (built in Milestone 206, §9.1):** (a) the recipient of a delivered message may report it,
  and an Advantage.Bid moderator may hide an abusive delivered message (append-only "hidden by Advantage.Bid" state);
  (b) activation is controlled: a pilot for named seller companies (and optionally named asker accounts) before the
  general switch.
- **Still open for Q:** which staff roles get message access once staff are on; message retention period;
  seller-agreement clause against diverting Advantage.Bid sales (legal wording); when to turn the pilot and then the
  general switch on (suggested: demo seller and named test accounts first, then the first real Professional Seller);
  whether consultation requests later move on-platform.

Design: `storefront-messaging-and-widget-design-2026-10-16.md` §1–§4, milestones Q1–Q2.
- Every eligible Professional item page gets "Ask the seller a question" (signed-in buyer or verified guest). The thread is
  tied to the item's real seller company, the item and its inventory number, the buyer identity, with full history and
  timestamps; access only for the buyer, the authorised seller organisation and permitted, logged Advantage.Bid support.
- Email is a **notification channel only** (seller: item title, inventory number, thumbnail, question, secure reply link;
  buyer: notified of replies). No private email address or phone number is exposed. Channel-neutral data model so in-app
  and push notifications can be added without redesign. Message notices and sale notices are different event types.
- Anti-circumvention: communications stay on Advantage.Bid; no direct contact details in the messaging UI; a seller
  agreement clause against diverting Advantage.Bid-generated sales (legal wording for owner approval); a polite reminder
  to buy through Advantage.Bid; detection of contact exchanges, off-platform payment solicitation and checkout bypass
  requests; flags go to human review with audit records and a documented appeal process; **never automatic suspension,
  penalties, order cancellation or accusations from automated detection alone**; legitimate shipping, pickup, condition
  and inspection discussion allowed; spam prevention, rate limits, safe attachments if ever supported, retention policy.
  Circumvention cannot be prevented completely and we do not claim so.
- **Owner decisions 2026-10-16 (eBay-style):** layered detection — explicit contact details, obfuscated contact details
  (spelled-out or separated digits, disguised emails), off-platform payment requests, and **indirect diversion requests**
  ("Google my business name and call me", "look up our phone number on our website", "find me on Facebook", "contact our
  store directly for a better price", "5% off if you buy in person", external checkout links). Obvious contact details
  are masked; ambiguous or diversion messages are held for human review (never silently deleted) with a polite rephrase
  option; review history, appeals and abuse controls; never automatic penalties. Legitimate condition, measurements,
  photos, authenticity, shipping, pickup/delivery, inspections and price changes completed through Advantage.Bid are
  never blocked; post-purchase fulfilment details stay available to authorised staff in the dashboard. Contact-form
  transition: item pages switch to "Ask the seller a question"; the storefront form becomes "Request a consultation"
  for services only, screened by the same rules (design §3.4).
- Today: the storefront "Contact" form (`seller_inquiries`) gives the visitor's name, email and phone directly to the
  seller and is linked from item pages while checkout is off — to be replaced on item pages by the on-platform thread
  (kept only for service consultations, clearly labelled). Messaging stays off until security and privacy testing pass.

### 9.1 Milestone 206: message reporting, moderator hiding and controlled pilot (owner decisions 2026-10-26)
Built together with sold-item price privacy (§12.3) under migration 206 (`206_sold_price_privacy_and_message_moderation.sql`,
additive and idempotent; moves no money; changes no existing value). Branch `feat/sold-price-privacy`; not deployed.
- **Purpose:** let the person who received an abusive message flag it, and let Advantage.Bid remove it from view
  without deleting anything; allow messaging to be tried with one company before anyone else.
- **Reporting:** only the recipient of a DELIVERED message may report it (the conversation's buyer for a seller message;
  the seller company, with `company.messages.view`, for a buyer message); the sender, other buyers and other companies
  get "not found". A reason is required; one report per person per message (database unique index); a report creates
  review work and one admin alert (`storefront_message_reported`, keyed to the message, no message text or customer
  details) and changes nothing else: never an automatic hide, penalty or suspension.
- **Moderator hiding:** an administrator hides a delivered message once, with a required reason (5-1000 characters);
  the recipient sees "A message was removed by Advantage.Bid", the sender sees the reason, and the original words, the
  delivered text and the review history are kept. The database guard enforces: only a delivered message can be hidden,
  once, with who and why; it can never be unhidden, rewritten or created hidden. Hiding stops any notice for that
  message that has not been sent yet (a queued notice is skipped), but it cannot retract an email that was already
  delivered: the message notice is queued when the message is delivered, so a recipient who reports a message has
  usually already received its email. A hidden message is not counted as waiting for the seller. Moderators never write as the seller (no route exists). Every moderator
  read and hide is in the conversation access log. Review queue filters: "Reported by the recipient", "Hidden by
  Advantage.Bid".
- **Controlled pilot (all OFF by default):** `STOREFRONT_MESSAGING_ENABLED` (general switch) stays unset.
  `STOREFRONT_MESSAGING_PILOT_SELLER_IDS` (seller_profiles UUIDs) enables item questions for those companies only;
  `STOREFRONT_MESSAGING_PILOT_USER_IDS` (optional users UUIDs) limits who may ask them. Non-UUID values are ignored. With
  both pilot lists empty and the switch unset, every messaging route returns 404 and item pages are unchanged. The
  service re-checks the conversation's company (and, in a pilot, the asker) on every path: ask, buyer and seller
  replies, buyer inbox and thread reads (non-pilot threads are hidden / "not found"), seller inbox and thread reads,
  withdraw, appeal and report, so listing one company never opens another, including conversations left over from a
  time messaging was on. Documented in `.env.example`.
- **Acceptance tests (`tests/storefront-item-messaging.test.js`):** pilot company + named askers only, everyone else
  off; no pilot + switch off = everything off; only the recipient can report, once, review work only, correct alert
  wording and type, no second alert on a repeat; non-pilot conversations cannot be listed, read, withdrawn, appealed or
  reported (adversarial, nothing changes and no alert); hide rules (recipient view, sender view, record kept, never
  unhidden/rewritten, held messages cannot be hidden); a queued notice for a hidden message is skipped; reasons counted
  in characters like the database (short emoji reasons get a validation answer, never a server error); moderators
  never write as the seller.
- **Sold-page caching:** every server-rendered item page, the public item answer for an unsold item and the
  storefront's public item list are sent `Cache-Control: no-cache` (revalidated on every view; cheap 304 via the
  ETag), so no cached copy can show a price after an item sells. This includes SOLD pages, because their "more from
  this seller" cards show other items' prices (`productPageService.cacheControlFor`). Member answers stay
  `private, no-store`; the not-found page keeps its short public cache (it shows no price).
- **Completion criteria:** full jest gate green; independent security review with findings fixed; production
  `scripts/prod-migrate-206.js --check`, apply and `scripts/prod-verify-206.js` (rolled back) only after owner approval;
  pilot company named by the owner before any pilot setting is filled.
- **Known, not changed in 206 (from 205):** the held-message alert is sent once per conversation, so a later held
  message or an appeal in the same conversation adds to the review queue without a second alert. Review-queue
  visibility is unaffected; consider a per-message alert key in a later maintenance item.

## 10. TODO — Branded widget header, search, filters and sorting (owner requirements 2026-10-16, permanent)

Design: `storefront-messaging-and-widget-design-2026-10-16.md` §5–§6, milestones W1 and S1.
### 10.1 Widget header and navigation
Compact mode (sits under the seller's own header) or Branded mode (optional header with logo, company name, navigation).
Seller navigation editor: link title/CTA, destination URL, order, visible/hidden, add/edit/delete/reorder, responsive.
Logo links to the seller's verified website. Links to the seller's own pages and appropriate Advantage.Bid pages. Safe URL
validation (https only; no javascript:/data:/other unsafe schemes; no malicious redirects or scripts), per-seller
isolation, no impersonation of Advantage.Bid controls, required Advantage.Bid attribution cannot be removed.
### 10.2 Search, filters and sorting (marketplace + widget, shared API)
About ten filters: keyword + seller inventory number, category, price range, condition, material, colour, dimensions/size,
seller and location (where relevant), availability, shipping or pickup eligibility. Sorting: newest, price low→high,
price high→low, category/alphabetical, relevance. Desktop and mobile, including narrow embeds; filters with no data are
hidden. Authoritative Advantage.Bid inventory and search APIs; every eligible item stays on the marketplace; widget
inventory synchronised automatically; purchases go to Advantage.Bid checkout; product SEO, canonical URLs, availability
and seller attribution preserved.

## 11. Deferred requirements index (updated 2026-10-26 — every approved item that is not live)

Priority: **P0** = required before the first real Professional Storefront sale; **P1** = next after launch-critical
work; **P2** = approved, later. Acceptance criteria are summarised here; full criteria live in the home section.

| # | Requirement (owner-approved) | Priority | Status | Acceptance criteria (summary) | Home |
|---|---|---|---|---|---|
| 1 | Buyer Terms that cover fixed-price storefront purchases | P0 | live terms silent; v4 draft unapproved | owner/legal-approved wording published; checkout acknowledgment links to it; draft never deployed without approval | §6 |
| 2 | Sales-tax remitting-party determination + Stripe Tax confirmed for storefront orders | P0 | not started (owner / advisor) | documented conclusion per jurisdiction; undetermined → tax held; live storefront tax calculation verified | §8.5 |
| 3 | Storefront seller settlement: approved manual procedure, or M3 ledger + statements (transfers off) | P0 | not built | every paid storefront order appears in a settlement view with fee, proceeds, holds; reconciles to Stripe; no money moves without approval | §8.4 |
| 4 | First real Professional Seller onboarded (verified, Connect payout details, own policies, real listings) | P0 | none in production | seller verified; policies published; listings pass SEO/shipping checks | checklist §3 |
| 5 | One authorised live, refunded checkout test | P0 | not run (billable — needs approval) | payment, tax, order record, seller notice, fulfilment and refund all verified on one real item | checklist §3 |
| 6 | Item messaging activation (pilot, then flag on) | P0 (recommended) | Q LIVE and OFF; reporting, hiding and the controlled pilot built in Milestone 206 (not deployed); all settings unset | 206 deployed and verified; owner names the pilot company (and test askers); pilot passes on the demo seller; then one real seller; then the general switch | §9, §9.1 |
| 7 | **Red SOLD banner on sold item images** | P1 | not built | see §12.1 | §12.1 |
| 8 | Staff pilot (one company), then "Your Team" rollout and `SELLER_STAFF_ENABLED` | P1 | waiting for the owner to name the pilot account and verify its phone | invite + step-up verified in production for one company; isolation tests pass | §2.1, §4 |
| 9 | Notification preferences and staff recipients; refund / dispute / pickup / shipping-deadline / payout notices | P1 | not built | one notice per event/recipient; no buyer contact; preferences respected; staff only by permission | §8.1 |
| 10 | Seller-agreement clause against sale diversion | P1 | needs legal wording + owner approval | approved wording in the seller agreement; referenced in messaging notices | §9 |
| 11 | Consultation form relabelled "Request a consultation" (services only), screened by the same rules | P1 | not built | not linked from items/widgets/emails; item-specific requests redirected to item questions | §9, design §3.4 |
| 12 | Search, filters (~10) and sorting, shared by marketplace and widget | P1 | not built | same results for marketplace/widget scopes; no other seller's items in a widget; sold/removed excluded unless "include sold"; zero-data facets hidden | §10.2 |
| 13 | Storefront website widget (live inventory, policies, Advantage.Bid checkout only) + branded header / navigation | P1 | not built | key bound to one seller; no private/unpublished data; canonical links; noindex frames; safe nav URLs; attribution kept | §7.5–7.6, §10.1 |
| 14 | Bulk spreadsheet import + image migration (drafts only) | P1 | not built | seller-scoped; drafts only; shipping off unless confirmed; Past Merchandise off; duplicate detection; error report | §8.3 |
| 15 | **Past Merchandise tab** | P2 | not built | see §12.2 | §12.2 |
| 15a | **Sold storefront item pages: price privacy** (part of §12.3) | P0 | DECIDED 2026-10-26: a sold item's price is never public; built in Milestone 206 (not deployed; production still shows the listed price on sold pages, and production has no real storefront sale yet) | 206 deployed and verified before the first real sale; signed-out JSON API, page, meta tags and structured data carry no price or shipping charge for a sold item | §12.3 |
| 15b | **Historical sold-price visibility + member research access** | P2 | per-item "show realized sale price to members" setting built in Milestone 206 (default OFF); Past Merchandise, widget "View Sold Price", research archive and auction labelling not built (auction realized-price gate already LIVE) | see §12.3 | §12.3 |
| 16 | Guest (email-verified) questions, attachments, cross-conversation (L5) scoring, in-app / push notices | P2 | not built | guest email verified before delivery; attachments scanned and seller-scoped; L5 only flags for review | §9 |
| 17 | Shopping-feed builder + Google Merchant Center mapper (no submission without approval) | P2 | not built | feed values = database; sold/removed never advertised; no invented identifiers; validated internally | §4.4 |
| 18 | Tax-time reports (exports only; no filing) | P2 | not built | per-period exports reconcile to the ledger; no filing or remittance features | §8.7 |
| 19 | Compliance profile — only fields with a verified requirement | P2 | scope rule recorded | each field has a documented legal/processor basis before collection | §8.6 |
| 20 | Category pages; sold-item index retention period | P2 | not built / owner decision | category pages list only public items; retention rule applied to sitemap | §4 |
| 21 | Admin read-access logging beyond messaging | P2 | not built | every admin read of private seller/buyer data logged | §6 |
| 22 | Public Professional Seller marketing launch | P2 | prepared only | launch only after P0 items and owner approval; seller-benefit wording | §3 |
| 23 | Phone Sasha timing test (MI-1) | maintenance | separate task | deterministic test; no production-path timing bug masked | `../operations/known-issues.md` |
| 24 | Professional Seller self-serve setup before approval; verification gate for live checkout, payments and payouts | P1 | roadmap only | see §13.A | §13.A |
| 25 | Owner and staff notifications for seller registration and verification work (email + SMS) | P1 | roadmap only | see §13.B | §13.B |
| 26 | Secure seller document upload and authorized staff review | P1 | roadmap only (existing verification documents system to be extended) | see §13.C | §13.C |
| 27 | Individual-item percentage discount editor | P2 | roadmap only | see §13.D | §13.D |
| 28 | Storewide Sales & Promotions dashboard | P2 | roadmap only | see §13.E | §13.E |
| 29 | Search and answer-engine discoverability that respects sold-price privacy | P1 | roadmap only (product SEO foundation LIVE; sold-price redaction built in 206) | see §13.F | §13.F |
| 30 | Owner and Admin/Finance notification when a storefront item is confirmed paid (email + SMS) | P0 (before live storefront checkout) | roadmap only | see §13.G | §13.G |
| 31 | Automatic Thursday seller settlements through Stripe Connect (Wednesday 11:59 PM ET cutoff) | P0 for automation; a manual procedure may cover launch (row 3) | roadmap only (design first; simulation before activation) | see §13.H | §13.H |

## 12. TODO — Sold presentation and Past Merchandise (owner requirements 2026-10-26, permanent)

### 12.1 Red SOLD banner (P1)
- **Requirement:** when a Professional Storefront item has actually sold, its main product image shows a prominent
  **red** banner or corner ribbon at the **top right** reading **"SOLD"** in clear white lettering — on the product page,
  storefront item cards, search results, Past Merchandise and (later) the seller's website widget, wherever a sold item
  appears.
- **Source of truth:** the item's real sale state (`marketplace_items.status = 'sold'`, set only when a paid order exists).
  A pending checkout (`pending_purchase`) is **not** sold: it keeps its "Sale in progress" treatment and no SOLD banner.
- **Rules:** sold items are never purchasable (no Buy Now, no checkout — already enforced server-side); a refund,
  cancellation or relist that returns the item to sale removes the banner at once because it is rendered from live
  status, never stored on the image; the banner is an overlay (the seller's original photo is never altered); accessible
  text ("Sold") for screen readers; works on mobile and narrow widget embeds.
- **Today:** the product page shows a small "SOLD" pill in the buy box and `SoldOut` structured data; there is no image
  banner; storefront grids do not show sold items.
- **Acceptance tests:** sold item → banner on page, card, search and gallery renderings; `pending_purchase` → no banner;
  refund + relist → no banner and purchasable again only through the normal relist rules; no purchase control on any
  sold rendering; one shared rendering helper used by every surface (server-rendered page and client cards).
- **Dependencies:** none for the product page and storefront cards; search results need §10.2; the widget needs §7.5.

### 12.2 Past Merchandise tab (P2)
- **Requirement:** an optional public storefront tab **"Past Merchandise"** — a gallery of previously sold items the
  shop owner chooses to showcase, to show the type and quality of merchandise the business has handled.
- **Rules:**
  - each item has a seller-controlled **"Show in Past Merchandise"** toggle, default **OFF** for every item, including
    imported inventory and converted auction lots; the seller may turn it on or off at any time;
  - only items that have **actually sold** (paid order, not refunded) **and** were explicitly selected appear; the
    toggle can be set in advance but has no effect until the item is sold;
  - gallery items show the original photo, title and the red SOLD banner (§12.1), are clearly unavailable and can never
    be purchased again; the gallery is separate from active inventory (never mixed into Shop Items or counts);
  - the tab is hidden (or shows a friendly empty state) when nothing is selected;
  - seller ownership enforced server-side (the item's real seller only, from the session); only items that are otherwise
    public (not taken down, not demo-only on real pages, Professional seller, branding rules respected); no buyer
    identity, sale price history beyond what the item page shows, order or transaction data;
  - historical product pages stay reachable where appropriate for SEO with `SoldOut` availability and no purchase
    controls; they stay out of shopping feeds; sitemap inclusion follows the sold-item retention decision (§4);
  - relisting, refunds, cancellations, takedowns and other status changes immediately remove an item from the gallery
    (rendered from live status + toggle, never a stored copy);
  - the same behaviour later in the seller-branded storefront widget (§7.5).
- **Data:** one boolean on `marketplace_items` (e.g. `show_in_past_merchandise`, default false) set only through the
  seller's own edit path; no new copy of the item.
- **Acceptance tests:** default off (new, imported, converted items); a sold + selected item appears; an unsold, pending,
  refunded, relisted, removed or taken-down item never appears; another seller cannot set the toggle or see the gallery
  data; gallery items have no purchase controls and carry SOLD + `SoldOut`; empty state / hidden tab; widget parity once
  §7.5 exists.
- **Dependencies:** §12.1 (shared SOLD rendering); storefront tabs (§7.3, live); sold-item retention decision (§4);
  bulk import (§8.3) must default the toggle off; widget (§7.5) for widget parity.
- **Not started until** Milestone Q is deployed and the P0 launch-critical items are handled, per owner instruction.

### 12.3 Historical Sold-Price Visibility and Advantage.Bid Member Research Access (owner decisions 2026-10-26; P2, one P0 decision)
Linked to §12.1 (SOLD banner) and §12.2 (Past Merchandise); their approved defaults are unchanged (Past Merchandise
toggle OFF for every item; red SOLD banner top-right on the main image of every sold item shown).

**A. Auction results.** Realized prices of auctions run on Advantage.Bid follow the established member-access policy:
public visitors can discover historical auction items and descriptions; realized prices are shown to signed-in members.
Hammer price, buyer's premium and total purchase price are always labelled separately and never presented as equal.
- Today (LIVE): `src/lib/realizedPrice.js` hides a closed lot's winning amount / final bid from signed-out callers.
  Gap to check when this is built: every place that shows a realized price labels it as the hammer price, and premium /
  total are shown only where computed from the auction's own terms.

**B. Professional Storefront Past Merchandise.**
- Separate per-item setting **"Show Realized Sale Price to Advantage.Bid Members"**, default **OFF**, seller-controlled,
  changeable later; independent of the Past Merchandise toggle.
- ON: signed-in members may see the actual realized item sale price. OFF: the realized price stays private to the seller
  and authorised Advantage.Bid personnel.
- Never shown: buyer identity, private transaction terms, shipping charges, sales tax, order numbers or other order data.
- Storefront prices are labelled as **fixed-price sales**, never as auction results. The original asking price is kept
  separate from the realized sale price (realized = the paid order's item price; a refunded order has no realized price).
- **P0 decision: DECIDED 2026-10-26, built in Milestone 206 (not deployed).** A fixed-price item sells at its listed
  price, so showing it on a sold page would disclose the sale price. Rule: once an item is SOLD (paid order), no public
  output carries its price or shipping charge: the public JSON API returns `price_cents: null` and `price_hidden: true`;
  the server-rendered page shows "SOLD"; `product:price` meta tags are omitted and `product:availability` is
  "out of stock"; the `Offer` structured data is `SoldOut` with no price or shipping rate; a generated meta description
  says "(sold)" instead of a price. A pending checkout is not a sale and keeps its price. The seller's own tools and orders keep the full
  record. Enforced server-side in `marketplaceItemService.publicItem` (the allow-list every public surface is built
  from), `productData` and `productPageService`.
- **Member disclosure (built in 206):** `marketplace_items.show_realized_price_to_members` (default false for every item,
  including converted and imported ones). Only the company owner can change it (never a staff role), at any time,
  including after the sale. When ON, a signed-in member sees the realized item price (the paid, never-refunded order's
  item price, never shipping, tax or fees), labelled "Fixed-price sale". A member is recognised only when the server
  confirms the session is current: missing, invalid, forged, expired, revoked, suspended or unverifiable sessions get
  the public view (`publicStorefront.confirmedViewerId`). A member's answer is `Cache-Control: private, no-store` with
  `Vary: Authorization, Cookie`; the crawlable page is always the public version. A refund removes the realized price.
  Tests: `tests/storefront-sold-price-privacy.test.js`.

**C. Seller website widgets.** Sellers keep their own branding; Past Merchandise later works in the embedded storefront
widget (§7.5). Visitors browse historical merchandise without an account. Where the seller allows price disclosure, an
optional "View Sold Price" link opens Advantage.Bid to sign in or register (free). Registration is never required just
to browse. Advantage.Bid attribution and mandatory dual distribution (§7.6) are kept.

**D. Research value.** Design for a future searchable research archive (collectors, appraisers, auction houses,
dealers): public titles, photographs, descriptions, seller attribution and SOLD status stay crawlable where appropriate
for search discovery; confidential prices are restricted **at the server/API level** — page HTML, JSON APIs, embedded
widgets, structured data, sitemaps, feeds and every machine-readable endpoint — never by hiding in the browser. Auction
results and storefront transactions are separately identified in research results.

**Data (when built):** one boolean on `marketplace_items` (e.g. `show_realized_price_to_members`, default false) set
only through the seller's own edit path; the realized price read from the item's paid, non-refunded order; one shared
server-side redaction helper used by every surface (like `realizedPrice.js` for auctions).

**Acceptance criteria (measurable):**
1. Defaults: every new, imported and converted item has both toggles OFF (database default + tests).
2. Signed-out request to page, JSON API, widget API, structured data, sitemap and any feed: no realized storefront price
   and no realized auction price appear (automated test over each endpoint).
3. Signed-in member: storefront realized price appears only when the seller's toggle is ON and the order is paid and not
   refunded; it is labelled "Fixed-price sale"; asking price is labelled separately.
4. Auction results show hammer price, buyer's premium and total as separately labelled values; never one number
   labelled as another.
5. No response anywhere contains buyer identity, shipping charge, sales tax or order number for a sold item.
6. Another seller cannot change the toggles; a refund, relist or takedown removes the realized price at once.
7. Widget: browsing works without an account; "View Sold Price" appears only when allowed and links to Advantage.Bid
   sign-in/registration; attribution present.
8. Research results mark each record as "Auction result" or "Fixed-price storefront sale".

**Dependencies:** §12.1 and §12.2; the sold-page price decision above (P0, decision only); member sign-in (live);
widget (§7.5) for C; search (§10.2) for D's research archive; sold-item retention decision (§4).
**Status:** the P0 sold-page rule and the per-item member-disclosure setting are built in Milestone 206 (not deployed).
Everything else in §12.3 (Past Merchandise display, widget "View Sold Price", research archive, auction labelling
checks) is not built and stays post-launch. Not part of Milestone Q.

## 13. TODO — Professional Seller onboarding, compliance, promotions and discoverability (previously approved owner requirements, recorded 2026-10-26; ROADMAP ONLY)

None of these is part of Milestone 206 and none is to be built until it is scheduled as its own milestone with a
purpose, scope, acceptance tests and completion criteria (§0 data-minimisation and focused-development standard).
Each extends an existing system; none adds a second one.

### 13.A Self-serve storefront setup before approval; verification gate for money movement (P1)
- **Requirement:** a Professional Seller can register and immediately set up their storefront and add or edit
  inventory without waiting for manual staff approval. Live checkout, payments and payouts activate only after the
  required verification and compliance checks pass.
- **Existing basis:** owner rule (`CLAUDE.md`): unapproved professionals may build before approval; the first sale is
  gated by the existing `verificationService.publicationGate`, not a second system. Today storefront setup and item
  editing do not require approval, and checkout is off platform-wide (`MARKETPLACE_CHECKOUT_ENABLED`). Gap to close
  when built: the storefront checkout path does not itself check the seller's verification or Stripe Connect status.
- **Acceptance criteria:** an unverified Professional Seller can create and edit a storefront and draft or list items;
  no item of an unverified or non-Connect-ready seller can be bought (server-side, not only hidden in the UI); payouts
  never run for an unverified seller; verification status changes take effect at once; admin override preserved;
  adversarial tests across sellers.

### 13.B Owner and staff notifications for seller registration and verification (P1)
- **Requirement:** use the existing Advantage.Bid email and SMS systems (`emailService`, `ownerAlertService`,
  `PROFESSIONAL_SELLER_VERIFICATION_PENDING` family) to notify the owner and designated staff of new seller
  registrations, missing required documents, uploaded forms needing review and verification readiness.
- **Rules:** recipients configurable by an admin, each verified before use (email confirmation; phone code for SMS);
  SMS is opt-in only; one notice per event and recipient (idempotent); notices contain no taxpayer numbers, document
  contents, full addresses or other sensitive data, only the seller's display name, the event and a secure admin link.
- **Acceptance criteria:** each event type produces exactly one notice per verified recipient; unverified or removed
  recipients receive nothing; content scan proves no sensitive fields; failures are logged and retried without
  duplicates.

### 13.C Secure seller document upload and authorized staff review (P1)
- **Requirement:** secure document upload and staff review for Professional Storefront sellers and auction-house
  resellers, extending the existing verification documents system (migrations 071, 107; `verify-documents.html`).
- **Rules:** collect only documents with a verified legal, processor or operational basis (documented per document
  type and jurisdiction); prefer Stripe Connect for KYC and taxpayer details and never duplicate them (migration 202);
  access limited to the document's own seller and authorised staff by permission; every view, download and decision
  in an append-only audit history; review statuses (e.g. submitted, needs changes, approved, rejected, expired);
  retention period defined and applied; files private, never public URLs.
- **Acceptance criteria:** cross-seller and unauthorised staff access refused (API + storage); every access logged;
  retention job removes expired documents; no taxpayer number captured where Stripe holds it.

### 13.D Individual-item percentage discount editor (P2)
- **Requirement:** on a single item, the seller enters a percentage discount and sees the original price, the
  percentage and the resulting sale price before an explicit **Save**; nothing changes until Save.
- **Rules:** server recomputes and validates the sale price (whole cents, sensible bounds); sold or pending items
  cannot be discounted; checkout charges the saved sale price; the original price is kept; seller-owner (or permitted
  staff) only; audit record of each change.
- **Acceptance criteria:** preview equals the saved and charged price; no change without Save; another seller cannot
  change it; order snapshot records original price, discount and charged price.

### 13.E Storewide Sales & Promotions dashboard (P2)
- **Requirement:** a storewide promotions dashboard with optional start/end scheduling and item exclusions.
- **Rules:** one effective discount per item: a defined precedence prevents unintended stacking of item and storewide
  discounts; schedules use the platform timezone handling; fees and taxes are calculated on the actual transaction
  price, including the existing flat 11% storefront seller fee (`STOREFRONT_FEE_BPS`); the price shown is the price
  charged; ending a promotion restores prices at once; sold items unaffected.
- **Acceptance criteria:** stacking scenarios produce exactly the documented price; 11% fee and tax computed on the
  discounted item price; schedule boundaries tested; exclusions honoured; audit trail.

### 13.F Search and answer-engine discoverability that respects sold-price privacy (P1)
- **Requirement:** keep eligible storefronts, products and historical listings discoverable by traditional search and
  by answer engines and other automated search tools, through structured data, canonical URLs and correct indexing.
- **Rules:** only public, eligible items (Professional Seller, not taken down, not demo on real pages); canonical
  bid.advantage.bid URLs; sold items keep `SoldOut` structured data and never carry a price in any machine-readable
  output (page, meta, JSON-LD, sitemap, feeds), per §12.3 and Milestone 206; sitemap inclusion follows the sold-item
  retention decision (§4); shopping feeds never list sold or removed items (§4.4).
- **Acceptance criteria:** automated checks over the page, structured data, sitemap and any feed show no sold-item
  price; canonical and robots tags correct for each state; Marketplace Integrity Suite coverage for any new public
  listing surface.

### 13.G Owner and Admin/Finance notice when a storefront item is confirmed paid (owner requirement 2026-10-26; P0 before live storefront checkout)
- **Requirement:** whenever a storefront order is confirmed paid (the payment processor's confirmed success, not a
  checkout start), notify the Advantage.Bid owner and authorised Admin/Finance recipients by email and SMS.
- **Content:** a secure admin order link, the seller, the item (title and inventory number), the sale amount (item price),
  the flat 11% storefront fee (`STOREFRONT_FEE_BPS`) and the estimated seller proceeds, labelled as an estimate (not the
  final deposit; refunds, chargebacks and holds can change it). No buyer contact details, card data, pickup address or
  taxpayer information in the SMS or email body; anything more detailed stays behind the signed-in admin link.
- **Reuse, not a second system:** the existing storefront notification outbox (`storefront_notifications`, migration
  204: queue, retries, failure alert) and `ownerAlertService` (SMS, per-recipient idempotency) / `emailService`. The
  paid-sale seller notice (§8.1, LIVE 0c069e6) is the model.
- **Rules:** exactly one notice per paid order per recipient (deduplicated by order id + recipient, across retries,
  webhook replays and restarts); recipients configurable by an admin and verified before use (email confirmation; phone
  code for SMS; SMS opt-in); Finance recipients limited to users with the finance staff role; failures retried and,
  after the last retry, raised as an admin alert; demo orders never notify real recipients.
- **Acceptance criteria:** one paid order produces exactly one email and one SMS per verified recipient (replayed webhook
  → no duplicate); fee and proceeds match the order record to the cent; content scan finds no buyer contact, card or
  taxpayer data; unverified or removed recipients receive nothing; a send failure is retried and then alerted.
- **Dependencies:** live storefront checkout stays OFF until this ships (it is the owner's view of real storefront sales).

### 13.H Automatic Thursday seller settlements through Stripe Connect (owner requirement 2026-10-26; design first)
- **Requirement:** design, then build, automatic weekly seller settlements paid every Thursday through Stripe Connect,
  with an eligibility cutoff of Wednesday 11:59 PM Eastern (America/New_York, daylight saving handled).
- **Eligibility:** a sale is eligible only when it is paid, not refunded or disputed, fulfilled (pickup completed or
  shipment delivered/confirmed, per §8.4 and M3), past any hold window, and the seller is verified with an active,
  payout-enabled Connect account in the current Stripe mode. Anything else is carried to a later week with a recorded
  reason.
- **Safeguards:**
  - duplicate-payout protection: each eligible sale belongs to at most one settlement (database uniqueness), each
    settlement run is idempotent (a stable run key per seller per Thursday, also used as the Stripe idempotency key),
    and a re-run after a crash resumes instead of paying twice;
  - reconciliation: every run reconciles transfers, balances and the ledger (§8.4) against Stripe, and any mismatch
    stops that seller's payout and raises an exception alert;
  - exception alerts to the owner and Finance (missing bank details, failed transfer, negative balance after refunds or
    chargebacks, verification lapse);
  - an emergency pause switch (one admin control, audited; paused until the owner activates automation) that stops
    all new transfers at once without losing the run's calculations;
  - **simulation mode first:** runs produce the full calculation, statements and alerts with no transfer, for an
    owner-reviewed period, before activation is approved.
- **Reuse:** the existing seller settlement and payout records (`seller_payouts`, the settlement workbench) and the
  existing Connect integration; storefront sales join the same ledger rather than a parallel one. Production today has
  `SELLER_SETTLEMENTS_ENABLED` and `STRIPE_CONNECT_ENABLED` on for the admin-initiated auction "Pay Seller" path;
  automatic scheduling must be a separate, default-off switch.
- **Acceptance criteria:** the cutoff boundary (Wednesday 11:59:59 PM ET vs Thursday 12:00 AM) is tested across
  daylight-saving changes; ineligible sales are never paid; a crash and re-run never pays twice; refunds after a payout
  are recovered or held per policy; reconciliation exceptions stop the affected payout; pause stops transfers
  immediately; simulation output equals what live mode would have paid.
- **Dependencies:** §8.4 ledger and statements (M3), fulfilment verification, §13.A verification gate, sales-tax
  remitting-party conclusion (§8.5), owner approval of the payout policy. Until then a manual settlement procedure
  (index row 3) covers launch.
- **Public wording note:** Sasha's knowledge (`src/services/sasha/knowledge/platformFacts.js`) already tells customers
  that storefront sales use a Wednesday 11:59 PM cutoff with Thursday processing. Until automation is built, that
  must stay true through the manual procedure, or the wording must be adjusted.
