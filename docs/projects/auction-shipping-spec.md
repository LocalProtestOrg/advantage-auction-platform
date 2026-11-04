# Auction shipping: specification (owner-approved requirements 2026-11-04; branch `feat/auction-shipping`)

Approved for planning and implementation on this branch. **Not activated publicly without separate owner approval.**
Must not delay Release 2 or the fixed-price payment launch. Local Pickup stays the default everywhere.

## Owner decisions (2026-11-04)
1. **Payout hold for shipped lots:** extends until confirmed delivery plus 3 business days, subject to risk review and the
   payment provider's requirements. Sellers are shown, before they turn shipping on, how shipping can delay their payout
   compared with local pickup.
2. **Shipping limit:** a newly approved shipping seller starts at a **$500 maximum total item value per shipment**;
   administrators adjust it per seller based on verification and performance.
3. **Tracking:** mandatory for every shipped order. Higher-value shipments require signature confirmation; **the exact
   threshold is to be set before launch** (open decision).
4. **Lot-level eligibility:** sellers explicitly mark which lots can ship. Shipping never applies automatically to every lot
   of an auction. Buyers see eligibility, restrictions, the estimated cost or that a quote is required, and the fulfillment
   options **before bidding and again after winning**.
5. **Simple seller controls:** in auction setup and cataloging; clear labels, simple toggles, reusable shipping settings,
   sensible defaults; Local Pickup is the default; payout implications shown before shipping is turned on.
6. **Buyer experience:** buyers can always tell **Shipping Available**, **Limited Shipping** and **Local Pickup** apart, for
   auctions and lots; the system prevents a buyer assuming a lot can ship when it cannot.
Earlier (same day): off by default; verified Professional Sellers may offer shipping; Individual Sellers only through an
explicit, audited administrator approval after review; fraud-prevention education; strong risk controls.

## What exists today (2026-11-04)
- `auctions.shipping_available` (boolean, default false; migration 036) with a search filter and a ranking boost.
- `auctionService.updateAuction`: an Individual Seller may change it only when an administrator set
  `seller_profiles.capabilities.shipping_enabled`; a Professional Seller may always change it (no verification check).
- No lot-level eligibility, rates, limits, tracking, payout hold or buyer labels for auction lots.

## Labels (one definition, server-computed)
| Label | Auction | Lot |
|---|---|---|
| **Local Pickup** | no lot ships | the lot does not ship |
| **Limited Shipping** | some lots ship | the lot ships with a restriction (destination states, quote required, or size) |
| **Shipping Available** | every lot ships | the lot ships at a shown rate to the buyer's destination |
The label comes from the lots' eligibility, never from the auction toggle alone, so an auction cannot claim "Shipping
Available" while some lots are pickup only.

## Data (planned migration, additive)
- `seller_profiles.shipping_approval`: `{ approved_at, approved_by, reason, per_shipment_limit_cents (default 50000) }`
  for Individual Sellers (admin-set, audited); Professional Sellers need verification (`publicationGate` not blocked).
- `seller_shipping_templates`: reusable settings (name, method: flat rate | rate table by state | quote required,
  handling days, destinations, packaging note).
- `lots.shipping_eligible` (default false), `lots.shipping_template_id`, `lots.shipping_restriction` (text shown to
  buyers), `lots.shipping_quote_required` (boolean).
- `auction_shipments`: one per buyer per auction (combined shipping), item value, carrier, tracking (required),
  signature flag, delivered_at, payout_release_at (= delivered_at + 3 business days, Eastern).
- Payout: shipped lots' proceeds held until `payout_release_at` and risk review clear.

## Enforcement (server, every path: create, edit, publish, lot changes, checkout/invoice)
- Shipping is off unless the seller is a verified Professional or an approved Individual.
- A lot ships only if marked eligible; the invoice offers shipping only for eligible lots and only to allowed destinations.
- A shipment's total item value above the seller's limit is refused (pickup remains possible).
- A shipment cannot be marked shipped without tracking; signature required above the threshold.
- Payout for shipped lots is held until delivery + 3 business days.
- Administrators can override any of these (audited), per the admin-override principle.

## Seller education (shown once before shipping is turned on; acknowledged)
Payout timing compared with pickup; the $500 starting limit; tracking and signature rules; packaging responsibility; how
reshipping and triangulation scams work; never ship before payment clears on Advantage.Bid; never ship to an address other
than the invoice; never accept off-platform payment; photograph packing and keep receipts.

## Phases (each with tests, none activated publicly without approval)
1. Labels and lot eligibility (data, server rule, seller toggles in cataloging, buyer labels before and after winning).
2. Seller templates and pre-bid estimates; combined shipping per buyer per auction.
3. Approval, limits, tracking, signature, payout hold, education; admin controls.
4. Discovery: Shippable Lot Filter, nationwide shippable discovery, labels on search results (Marketplace Integrity Suite).

## Open decisions
- Signature-confirmation threshold (decision 3).
- Destinations: domestic only at launch (assumed); any excluded states.
- Shipping terms: counsel draft `docs/legal/auction-shipping-terms-counsel-draft.md` (on PR #85).
