# Marketplace Architecture — Permanent Vocabulary & Count Rules

**Status:** LOCKED engineering standard. This file is authoritative for customer-facing marketplace
vocabulary and how counts are derived. See also `docs/architecture/marketplace-integrity-architecture.md`.

## 1. Customer-facing product families (locked)

There are exactly **four** customer-facing product families. Use these labels everywhere a customer
can see them (map key, filters, search, widgets, dashboards, API display labels, structured-data and
analytics labels):

| Family key (`family`) | Customer label | Meaning |
|---|---|---|
| `advantage_auction` | **Advantage.Bid Auctions** | Auctions hosted directly using Advantage.Bid auction software (the native `auctions` table). |
| `partner_event` | **Auction Partner Events** | Auction events **posted or imported** from professional auction companies (the `events` table, `sale_type='auction'`) — e.g. GSA imports. NOT hosted on Advantage.Bid bidding software. |
| `estate_sale` | **Estate Sales** | Estate-sale events (`events`, `sale_type <> 'auction'`). |
| `marketplace` | **Marketplace** | **Fixed-price items** available through Advantage.Bid. (No fixed-price inventory table exists yet → the count is authoritatively **0**.) |

Do **not** use these as customer-facing family labels: *Events, Auctions, Promotional Events,
Marketplace / Professionals, Other Estate Services, Native Auctions, Partner Auctions* (internal only).

## 2. Professionals is a SEPARATE concept — never "Marketplace"

The professional **directory** (auction houses, estate-sale companies, appraisers) is **not** a product
family and must **never** be presented as Marketplace inventory. It renders in its own **Professionals**
section:

| Category key | Label | profession_id |
|---|---|---|
| `estate_sale_companies` | Estate Sale Companies | 4 |
| `auction_houses` | Auction Houses | 3 |
| `appraisers` | Appraisers | 5 |

No `Other Estate Services` row is shown (there is no populated, intentionally-supported category behind
it). Reintroduce a category only if it is real and populated.

## 3. Canonical count sources (single source of truth)

- **Definition of "listable":** `src/lib/marketplaceVisibility.js` (`activeEventSql`,
  `activeNativeAuctionSql`, `activeMarketplaceCompanySql`, `canonicalCounts`).
- **Family labels:** `src/lib/marketplaceVocabulary.js` (`FAMILIES`, `PROFESSIONALS`).
- **Public counts API:** `GET /api/public/marketplace/counts` →
  `{ families: { advantage_auction, partner_event, estate_sale, marketplace }, professionals: { estate_sale_companies, auction_houses, appraisers, total } }`.
  Every surface (including the map key) reads counts from here — the browser never computes independent
  totals.
- **Enforcement:** `src/services/marketplaceIntegrity.js` verifies the canonical DB tally equals every
  public API (incl. `/marketplace/counts`) on every deploy (`npm run gate`) and every scheduled worker
  cycle.

## 4. Inventory count vs. map-marker count (do not conflate)

- A **family inventory count** is the total number of active listings in that family. It is derived from
  the canonical DB via `canonicalCounts` — **never** from map pins or the current map viewport.
- A **map marker** is a plotted pin. Online / coordinate-less listings have **no marker** and are
  **never** given a fabricated pin.
- Therefore: **Auction Partner Events** stays at its full active total (e.g. 56) even when 0 are
  plottable on the map; **Estate Sales** and **Advantage.Bid Auctions** likewise reflect full active
  totals. Checkboxes control what is *displayed*; counts reflect *inventory*. The two are independent.

## 5. Family vs. origin/source

`family` is the customer-facing product family; it is derived from origin:
- native `auctions` table → `advantage_auction`
- imported/partner auction event (`events`, `sale_type='auction'`) → `partner_event`
- estate-sale event → `estate_sale`

GSA imports are **Auction Partner Events** (`partner_event`) — they must **never** be counted as
Advantage.Bid Auctions.

## 6. No coordinate requirement for online Auction Partner Events

Auction Partner Events may be online, in-person, hybrid, or coordinate-less. They still count in the
`partner_event` family total and appear in `/auctions` and `/all-events`. They are not required to have
coordinates and are not given fabricated map pins.

## 7. Rule for all future work

Any new public listing surface reads counts from `/api/public/marketplace/counts` (or `canonicalCounts`)
and labels families from `marketplaceVocabulary.js`. Professional-directory counts remain separate and
are never presented as Marketplace inventory. A second retrieval path or a re-implemented count will
diverge and fail the Marketplace Integrity gate.
