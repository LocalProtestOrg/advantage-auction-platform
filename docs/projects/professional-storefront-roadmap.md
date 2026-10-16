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

**Safety switches.** Live checkout (`MARKETPLACE_CHECKOUT_ENABLED`), payouts, external merchant feeds, paid shopping ads and
public marketing of unfinished features stay OFF until the readiness checks in §6 pass and the owner approves.

## 1. Status (2026-10-16)

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
| Item questions / messaging, anti-circumvention, widget header, search & filters (§9–§10) | Requirements + design recorded 2026-10-16 (`storefront-messaging-and-widget-design-2026-10-16.md`); not built; messaging stays off until security + privacy testing |
| Sale notifications, inventory numbers, bulk import, settlement/statements, tax responsibility, compliance profile, tax-time reports (§8) | Requirements + architecture recorded 2026-10-16 (`storefront-notifications-inventory-finance-compliance-plan-2026-10-16.md`); not built |
| Seller policies, storefront tabs, policy snapshots, storefront widget (§7.2–7.6) | Requirements recorded 2026-10-16; not built |
| M3 retail settlement and payouts | Policy design awaiting owner decisions; nothing moves money |

## 2. Development sequence (owner priorities 2026-10-16, dependency-ordered)

Done: staff accounts + one-company pilot framework (LIVE, off), product SEO (LIVE), existing-item editing (LIVE),
shipping controls (LIVE).

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
- Seller and buyer ownership protections (done: 197/198) and seller staff permissions (built: 199, not deployed).
- Fulfilment and delivery verification (M3), refund and chargeback handling (partly done), reconciliation and payout holds (M3).
- Administrative oversight and audit logs (admin read access is not yet logged).
- Paid-sale seller notifications queued, idempotent and monitored (§8.1, N1) — required before live checkout.
- Seller policies + purchase snapshots (§7.2–7.4); storefront ledger, statements and reconciliation (§8.4, M3a/M3b).
- Sales tax remitting party determined per jurisdiction after qualified review (§8.5); undetermined → tax held.
- Seller compliance data encrypted with logged access (§8.6), including the existing plain-text EIN field.

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

**Built (migration 201, branch `feat/storefront-shipping`, not deployed):** `src/lib/storefrontShipping.js` is the single
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
- Today: nothing exists. Migration needed: yes (`seller_policies` + append-only `seller_policy_versions`).

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

### 8.1 Immediate seller sale notifications (before live checkout)
Email to the seller's company address and opted-in fulfilment staff **only after payment is confirmed** (never on
checkout start or pending payment): item title + description, the seller's inventory number, a thumbnail of the real
photo, confirmed sale price, order number, shipping or pickup, the next fulfilment action, a secure link to order
management, and a labelled estimated proceeds amount if reliable. Queued, idempotent (one per order/event/recipient),
retried, monitored, audited; never another seller's order, never payment credentials or unnecessary buyer data.
Separate notices planned for cancellation, refund, dispute, pickup confirmation, shipping deadline, payout completion.
Today: an inline "Item sold" email to the owner exists (no retry, no staff, no thumbnail/inventory number).

### 8.2 Seller inventory numbers / SKU
Per item, seller-scoped (sellers may reuse each other's numbers), searchable in the dashboard, carried into orders,
notices, settlement reports and exports, preserved through imports, edits, sales, refunds and reporting. Today: none.

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

### 8.7 Tax-time and financial reporting
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
- Today: the storefront "Contact" form (`seller_inquiries`) gives the visitor's name, email and phone directly to the
  seller and is linked from item pages while checkout is off — to be replaced on item pages by the on-platform thread
  (kept only for service consultations, clearly labelled). Messaging stays off until security and privacy testing pass.

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

