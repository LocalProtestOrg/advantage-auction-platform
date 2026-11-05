# Auction shipping: specification (owner-approved requirements 2026-11-04; branch `feat/auction-shipping`)

Approved for planning and implementation on this branch. **Not activated publicly without separate owner approval.**
Must not delay Release 2 or the fixed-price payment launch. Local Pickup stays the default everywhere.

## Owner decisions (2026-11-04)
1. **Payout hold for shipped lots:** extends until confirmed delivery plus 3 business days, subject to risk review and the
   payment provider's requirements. Sellers are shown, before they turn shipping on, how shipping can delay their payout
   compared with local pickup.
2. **Shipping limit:** a newly approved shipping seller starts at a **$500 maximum total item value per shipment**;
   administrators adjust it per seller based on verification and performance.
3. **Tracking:** mandatory for every shipped order. Higher-value shipments require signature confirmation.
   **Decided 2026-11-05:** signature confirmation is required above **$500 total item value** per shipment, with an
   authorized (audited) administrator override.
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

## Phase 1 as built (branch `feat/auction-shipping`, 2026-11-05; OFF behind `AUCTION_SHIPPING_ENABLED`)
Owner confirmations built in (2026-11-05): off by default and Local Pickup everywhere; only lots explicitly marked
eligible ship; labels before bidding and after winning; verified Professionals or audited-approved Individuals only;
$500 per-shipment start (admin-adjustable per seller); tracking always; signature above $500 (admin override); payout
hold = confirmed delivery + 3 US Eastern business days (subject to risk review, payment-provider constraints and final
legal review); reusable shipping profiles with defaults; one-time payout and fraud education acknowledgment.

- **Flag:** `AUCTION_SHIPPING_ENABLED` (exactly `true` = on; unset = off). Off: `/api/auction-shipping/*` answers 404
  (except `GET /config`), no payload carries a shipping summary, and the seller and buyer pages draw nothing new. The
  legacy `auctions.shipping_available` and its toggle, search filter and ranking boost are unchanged.
- **Policy module (one home):** `src/lib/auctionShippingPolicy.js`: constants ($500 limit, $500 signature threshold,
  3 business days), the lot and auction label functions, the seller eligibility rule, the shipment rule check
  (`shipmentViolations`: limit, tracking, signature, with admin overrides) and `payoutReleaseAt` (delivery + 3 business
  days). Business days = Monday to Friday excluding US federal holidays on their observed dates (Saturday holiday to
  Friday, Sunday to Monday); the count starts the day after the delivery's Eastern calendar date and the release is at
  the END of the third business day (00:00 Eastern the next day), so a hold is always at least 3 full business days.
- **Migration 218** (`db/migrations/218_auction_shipping_phase1.sql`; guarded runner `scripts/prod-migrate-218.js`
  with `--check` / `--dry-run`; reverse statements in the file header). Additive:
  `seller_shipping_profiles` (name, method flat_rate | quote_required, flat rate, handling days, destinations
  domestic_us only, excluded states, packaging note, one default per seller, archived never deleted);
  `lots.shipping_eligible` (default false), `shipping_profile_id`, `shipping_restriction` (300 chars),
  `shipping_quote_required`, with the rule "an eligible lot names its profile"; `seller_profiles.shipping_approved_at`,
  `shipping_approved_by`, `shipping_approval_reason`, `shipping_per_shipment_limit_cents` (NULL = $500 default),
  `shipping_education_acknowledged_at`, `shipping_education_version`. Deviations from the planned data: approval is
  typed columns instead of a JSONB `shipping_approval`; "templates" are called shipping profiles; the
  rate-table-by-state method is not built (flat rate or quote required only); `auction_shipments` is deferred to Phase 3.
- **Who may offer shipping** (server, `src/services/auctionShippingService.js`): a Professional Seller when
  `verificationService.publicationGate` is not blocked; an Individual Seller only when
  `seller_profiles.capabilities.shipping_enabled` is true (the existing, audited admin gate, reused; the new approve
  endpoint sets it and records approver and reason). Inactive accounts never. Either must acknowledge the education once
  (timestamp + version, audited) before creating profiles or marking lots. On acknowledgment a default "Standard
  shipping" profile (quote required, 3 handling days, domestic) is created.
- **Lot rules:** a seller changes only their own lot, under the existing catalog edit lock, and only while the lot is open
  with no bids (buyers bid on the terms shown). Administrators may override any of this, with a required reason; every
  change is audited (`lot_shipping_updated`, `auction_shipping_admin_override`). Setting eligibility also sets the legacy
  `lots.shippable` to match, so older discovery badges agree for lots managed through this path.
- **Labels:** computed only in the policy module from lot eligibility + the lot's profile. Lot: not eligible or no profile
  = Local Pickup; flat rate and no restriction = Shipping Available; quote required, excluded states or restriction text
  = Limited Shipping. Auction: no lot ships = Local Pickup; every lot Shipping Available = Shipping Available; otherwise
  Limited Shipping. Buyer terms include the destinations, estimate or "quoted after the auction closes", handling time,
  restriction, the seller's per-shipment limit, tracking and signature rules, and that local pickup remains available.
- **Endpoints** (`src/routes/auctionShipping.js`, mounted at `/api/auction-shipping`): `GET /config`;
  seller `GET /seller/status`, `POST /seller/acknowledge`, `GET|POST /seller/profiles`, `PATCH|DELETE /seller/profiles/:id`
  (archive; refused while an open shipping lot uses it); `GET|PUT /lots/:lotId`; admin
  `GET /admin/sellers/:sellerProfileId`, `POST .../approve` (reason, optional limit), `POST .../revoke` (reason; open lots
  without bids return to Local Pickup, lots with bids keep their terms), `PUT .../limit` (reason; null = default).
  Every admin action writes `audit_log`.
- **Payload additions (flag on only; no new retrieval path):** `shipping` on `GET /api/auctions/:id/summary` and
  `GET /api/public/auctions/:id` (auction label), and on each lot in `GET /api/lots/:id`, `GET /api/lots/auction/:id`,
  `GET /api/lots/my-bids` and `GET /api/public/auctions/:id/lots`.
- **UI (flag on only):** auction setup (`public/seller-create.html`) shows eligibility, the payout explanation, the
  one-time acknowledgment and the shipping profiles, and hides the legacy auction toggle; the Lot Studio
  (`public/dashboard/lots.html`) shows "This lot can ship" (off by default), the profile picker (default preselected),
  quote required, restriction text and a payout reminder. Buyer labels and terms: auction page and lot cards
  (`public/auction-view.html`), lot page before bidding and after winning (`public/lot.html`), won lots
  (`public/my-bids.html`). Shared scripts: `public/widgets/shared/seller-shipping.js`, `shipping-label.js`.
- **Tests:** `tests/auction-shipping-policy.test.js` (constants, labels, eligibility, shipment rules, business-day release
  incl. weekends, holidays, DST), `tests/auction-shipping-enforcement.test.js` (real PGlite + migration 218 + real routes).

## Phase 3 scaffolding and payout safeguards as built (branch `feat/auction-shipping`, 2026-11-05)
Owner-approved 2026-11-05 (assessment `docs/projects/seller-fraud-protections-assessment.md`). Auction shipments are OFF
behind `AUCTION_SHIPPING_ENABLED`; the storefront delivery rule is OFF behind `STOREFRONT_SHIPPED_PAYOUT_DELAY_ENABLED`.
- **Migration 219** (`db/migrations/219_shipment_fulfillment_and_delivery.sql`; guarded runner `scripts/prod-migrate-219.js`
  with `--check` / `--dry-run`; reverse statements in the header; NOT applied anywhere). Additive:
  `auction_shipments` (one per buyer per auction; total item value and the seller's per-shipment limit fixed at creation;
  carrier + tracking required to mark shipped and kept as recorded; signature confirmation required above $500 unless an
  administrator override with a reason; the limit unless an administrator override with a reason; delivery source buyer or
  admin; `payout_release_at`; status forward only; never deleted), `auction_shipment_lots` (a lot is in at most one
  shipment; never changed or deleted), and `marketplace_orders.delivered_at / delivery_confirmed_by /
  delivery_confirmation_source` (kept as recorded once set). Database triggers enforce the same rules as the service
  (migration 197 pattern). The $500 signature threshold is written in the trigger as well as in the policy module; changing
  it needs a migration.
- **Service** `src/services/auctionShipmentService.js` and routes under `/api/auction-shipping` (flag-gated 404):
  `POST /shipments` (seller of the auction or admin; the buyer's won, shipping-eligible lots; refused above the limit unless an
  admin gives `limit_override_reason`; idempotent), `GET /shipments/:id` (seller, buyer or admin; the buyer never sees
  override notes), `POST /shipments/:id/ship` (only after the buyer has paid: combined invoice paid or every lot paid;
  carrier + tracking; `signature_confirmation` above $500), `POST /shipments/:id/confirm-delivery` (the buyer, or an admin
  with a note and an optional delivery date not before shipping), `POST /admin/shipments/:id/override`
  (`signature` or `limit`, reason), `GET /admin/auctions/:auctionId/payout-hold`. Every change audited in its transaction.
- **Payout hold wiring:** with the flag on, both auction pay paths (Mark Paid, Direct Deposit) refuse while any shipment of
  the auction is not yet delivered, or delivered but before `payout_release_at` (code `SHIPPING_DELIVERY_HOLD`); an
  administrator may pay anyway only with a written reason (audited `settlement.shipping_delivery_hold_override`). Fails
  closed. With the flag off the check is never run.
- **Storefront shipped orders** (flag `STOREFRONT_SHIPPED_PAYOUT_DELAY_ENABLED`, off): the seller marking a shipped order
  complete no longer makes it payable; it becomes eligible when the buyer confirms receipt
  (`POST /api/marketplace/orders/:id/confirm-delivery`) or an administrator confirms delivery with a note
  (`POST /api/marketplace/admin/orders/:id/confirm-delivery`), with `payout_eligible_at = payoutReleaseAt(delivered_at)`,
  so the weekly payout includes it only after delivery + 3 US Eastern business days.
- **Payout safeguards (all sellers, auction and storefront; live behavior, see the assessment):** administrator hold /
  release for auction settlements; suspended sellers not paid without an audited reason; payout-detail changes audited and
  emailed; identity confirmation to replace a payout destination (current password, or for an account without a usable
  password a one-time code emailed to the account, migration 220); a payout within 7 days of a destination change needs an
  audited administrator review reason. Shared module `src/services/payoutSafeguards.js`.
- **Tests:** `tests/payout-fraud-safeguards.test.js` (PGlite + migrations 218/219 + real routes and audit writer) and the
  safeguard blocks at the end of `tests/storefront-payouts.test.js`.

## Remaining (not built)
- **Phase 2:** shipping on the invoice and checkout (combined shipping per buyer per auction; the buyer choosing shipping
  and a ship-to snapshot at payment; quote entry by the seller after close; destination check against excluded states);
  creating the `auction_shipments` row from that choice (today a seller or admin creates it); the per-shipment limit applied
  to the buyer's actual order total; labels on the combined invoice page (`public/invoices.html`); a rate table by state if
  still wanted.
- **Phase 3 remainder:** seller and buyer UI for shipments (ship with tracking, confirm delivery); admin UI for approval /
  limit / overrides / delivery confirmation (the endpoints exist; `public/admin/moderation.html` still drives only the old
  capability checkbox, which remains a valid approval path but records no approver or reason on the seller row); a risk
  review flag at settlement (for example "first shipped sale above $X"); carrier tracking verification (later).

## Launch blockers for auction shipping
1. Owner approval to turn on `AUCTION_SHIPPING_ENABLED`, after migrations 218 and 219 are applied (both owner-gated).
2. Phase 2 (buyer chooses shipping on the invoice, ship-to captured at payment, shipment created from it). Without it a
   shipped lot with no shipment record would not be held, because the payout hold reads shipment records.
3. Seller and buyer shipment UI (ship with tracking; confirm delivery) and the admin delivery / override screen.
4. Final legal review of the payout hold wording and the shipping terms (`docs/legal/auction-shipping-terms-counsel-draft.md`).
5. Storefront: decide when to turn on `STOREFRONT_SHIPPED_PAYOUT_DELAY_ENABLED` (needs migration 219) and add the buyer
   "confirm receipt" button to the buyer order page.
- **Phase 4:** discovery (Shippable Lot Filter, nationwide shippable discovery, labels on search results) through the
  Marketplace Integrity Suite; reconcile the legacy `auctions.shipping_available` and `lots.shippable` (values set before
  Phase 1 can still show a shipping badge on discovery surfaces while the new label says Local Pickup).

## Open decisions
- Destinations: domestic only at launch (built that way); any platform-wide excluded states.
- Shipping terms: counsel draft `docs/legal/auction-shipping-terms-counsel-draft.md` (on PR #85); final legal review of
  the payout hold wording.
