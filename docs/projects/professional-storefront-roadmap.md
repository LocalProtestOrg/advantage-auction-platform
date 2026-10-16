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
| Seller staff accounts (migration 199) | Built + tested on `feat/seller-staff-accounts` (approved defaults); not deployed; off until `SELLER_STAFF_ENABLED=true` |
| M3 retail settlement and payouts | Policy design awaiting owner decisions; nothing moves money |

## 2. Development sequence (recommended)

1. **Seller staff accounts** — BUILT (membership, invitations, step-up, revocation; flag-gated). Awaiting deploy approval.
2. **Product SEO foundation** (§4.1–4.3) — server-rendered item pages, canonical URLs, structured data, sitemap, SEO data
   fields. Safe to build and ship now: it only improves what is already public. Must land **before** bulk import and the
   widget, so imported and widget items are born with the right data model.
3. **M3 retail settlement** — build ledger, holds, reconciliation with transfers OFF; live transfers only after owner approval.
4. **Buyer marketplace search and filters**; per-storefront search and filters.
5. **Stripe production verification** (payments, webhooks, Connect onboarding, Tax registrations) and checkout readiness.
6. **Merchant feed** (§4.4) — generate + validate internally (no submission) alongside 4–5; submit to Google Merchant
   Center only after checkout is live, the merchant account is set up and the owner approves.
7. **Public marketing launch** (§3) — prepared in advance, launched with confirmed operational readiness.
8. **Embeddable storefront widget**, seller branding/customization, inventory synchronization.
9. **Bulk CSV / spreadsheet import.**

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
