# Seller growth and auction shipping: approved roadmap (owner, 2026-11-04)

Each item has a purpose, scope, acceptance tests and completion criteria (Data Minimization and Focused Development
principle). Status as of 2026-11-04. Nothing here changes payment, tax or payout rules.

| | Item | Status |
|---|---|---|
| A | Interactive professional seller demo | **Built** on `feat/discovery-and-seller-growth` (not deployed) |
| B | Seller HOW TO Center | **Built** on `feat/discovery-and-seller-growth` (not deployed) |
| C | Limited Shipping for auctions (default off, verified professionals; individuals only by admin approval) | Planned; needs owner go (business rule + server enforcement) |
| D | Shipping labels, nationwide shippable discovery, filter, combined shipping, estimates, templates, lot eligibility | Planned; after C |
| E | Shipping terms (seller responsibility to the maximum enforceable extent) | **Counsel draft** prepared: `docs/legal/auction-shipping-terms-counsel-draft.md` |

## A. Interactive professional seller demo
**Purpose:** one link for professional seller marketing and sales-agent outreach (including Kymmie's) that shows, in a
minute, what the seller gets: their own branding, more consignments, easy cataloging, auction management, dual
distribution (their website and the Advantage.Bid marketplace) and growth.
**Scope (built):** `/seller-demo`, a static, self-contained, interactive page; no account, no data collected, nothing sent.
The visitor types their business name, picks a brand color and their seller type, and every preview updates live:
- their branded storefront and auction catalog;
- the same listings on their own website (widget) and on the Advantage.Bid marketplace;
- a cataloging walkthrough (photo to listing with Smart Catalog Tools, bulk import);
- an auction timeline (catalog, preview, staggered soft close, pickup);
- the fee summary exactly as the live Professional Sellers page states it.
One call to action: the existing professional registration. A `ref` parameter (for example `?ref=kymmie`) is carried
through to the registration link so outreach can be attributed. Live features only: no "coming soon", nothing about
online checkout until it is enabled.
**Acceptance:** renders on desktop, tablet and 320–390px phones without sideways scrolling; no page errors; no "AI" or
vendor terms; no long dashes in copy; the registration link carries `ref`; indexable with canonical and social tags.
**Completion:** browser journey test passes; owner approves the copy; deployed with the next release.

## B. Seller HOW TO Center
**Purpose:** practical help while a seller prepares an auction: how to organize the sale and get it online.
**Scope (built):** `/seller-how-to`, linked from the auction creation flow and the seller FAQ. Guides:
- organizing merchandise on tables, with painter's tape for lot numbers (no residue on finishes);
- lot numbering (sequence, grouping, matching the catalog);
- photography (light, backgrounds, angles, marks and damage, how many photos);
- pickup preparation (staging, a pickup table, checking IDs and paid invoices, handling large items).
Printable materials, built in the browser and printed or saved as PDF (no files collected or stored):
- Advantage.Bid branded lot labels (lot number, title, the seller's name, the auction), Avery-style sheets;
- an inventory worksheet (lot, title, description, condition, dimensions, photos taken, starting bid if allowed);
- a setup checklist and a pickup-day checklist.
**Acceptance:** all print views print cleanly on Letter paper; renders on phones; no page errors; public-language rules.
**Completion:** browser journey test passes; owner approves; deployed with the next release.

## C. Limited Shipping for auctions (default OFF)
**Purpose:** let trustworthy sellers offer shipping without exposing buyers or the platform to shipping fraud.
**Rules (owner):**
- off by default for every auction and lot;
- a **verified** Professional Seller may turn it on (the same publication gate as their first sale);
- an Individual Seller only when an administrator turns on an explicit, audited shipping approval for that seller (after
  review; reversible; reason required);
- enforced on the server for auction creation, editing, publication and lot changes (today `auctions.shipping_available`
  is a free toggle: the gap recorded in CLAUDE.md, 2026-10-12).
**Risk controls:** shipping only to the buyer's verified billing country/state rules; tracking number required before
payout release for shipped lots; payout hold until delivery confirmation or a set window; per-seller shipped-value limit
for new sellers; admin alert on unusual patterns (many high-value shipped lots, address mismatches); no shipping to
freight forwarders unless allowed; clear seller education (below).
**Fraud-prevention education:** what reshipping and triangulation scams look like, why never to ship before payment
clears on Advantage.Bid, never to ship to a different address than the invoice, never to accept off-platform payment,
how to photograph packing and keep receipts.
**Acceptance:** server tests for each rule (default off, verified professional only, admin approval for individuals,
audit record, refusal messages), plus a journey test. **Owner decisions needed:** payout hold length for shipped lots;
the new-seller shipped-value limit; whether tracking is mandatory for every shipped lot.

## D. Shipping in discovery and bidding (after C)
- Labels on auction search results and cards: **Shipping Available**, **Limited Shipping**, **Local Pickup**.
- Nationwide discovery of shippable auctions (the location filter is skipped for shippable lots when the buyer asks).
- **Shippable Lot Filter** in search.
- **Combined shipping** across a buyer's lots in one auction (one shipment, one charge rule set by the seller).
- **Pre-bid shipping estimates** on the lot page (seller's flat rate or table by destination; never a guess).
- **Reusable shipping templates** per seller (rates, handling time, packaging notes).
- **Lot-level shipping eligibility** (a seller can mark large or fragile lots pickup-only inside a shipping auction).
**Acceptance:** canonical visibility and counts stay in `marketplaceVisibility` and the Marketplace Integrity Suite;
estimates shown before bidding equal what the invoice charges.

## E. Shipping terms
Counsel draft: `docs/legal/auction-shipping-terms-counsel-draft.md`. It allocates fulfillment, packaging, loss, damage,
claims and related costs to the seller to the maximum enforceable extent, and lists what the platform cannot contract
away. Counsel to draft final language; nothing is published from the draft.
