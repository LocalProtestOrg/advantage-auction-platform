# Sales Tax Architecture Plan — Phase 1 (Architecture Only)

**Status:** PLAN ONLY. No code, no migrations, no deployment. Awaiting approval before Phase 2.
**Date:** 2026-06-24
**Production constraints in force:** Stripe TEST · Buyer Premium inactive · Buyer Terms v1 active (v2 draft) · Seller Agreement active.
**Inputs:** `docs/projects/financial-workflow-audit.md` (Section E), `docs/projects/tax-exemption-reseller-certificate-plan.md` (exemption sub-system), code verification (this doc).

> **Compliance gate:** Where tax is collected, when it is collected, and which jurisdictions Advantage must register in are **legal/tax decisions, not engineering decisions.** This document recommends a *technical architecture*; it does not determine tax liability. Attorney + CPA sign-off is a hard prerequisite before any tax goes live. See [Compliance Considerations](#compliance-considerations).

---

## 1. The decisive architectural fact: this is a pickup business

The tax architecture for a general e-commerce store (destination-based, ship-to every US address, thousands of jurisdictions) is **not** the architecture this platform needs. Verified against code:

- **The platform is pickup-based.** Buyers collect lots at the auction's **single published address** during slot windows grouped by size category A/B/C (`pickup_assignments`, `pickup_schedules`, `slots_capacity`; `paymentService.js` assigns a pickup slot on payment). There is no shipping flow — `lots.shippable`/`shipping_cost_cents` and `auctions.shipping_available` columns exist but default false and are **stubbed, not implemented**.
- **No buyer address is captured anywhere.** The `users` table has `email, role, stripe_customer_id, full_name, phone` — and no address/state/zip. Buyers have no billing or shipping address field. (This also aligns with the business rule that full address stays hidden until payment is verified.)
- **The auction/seller location IS captured.** `auctions` has `city, address_state, zip, street_address, address_encrypted` (migrations 001 + 036); `seller_identity` separately has full address (055).
- **No address reaches Stripe today.** PaymentIntent (`paymentService.js:311-315`) sends amount + currency + metadata only — no `customer`, no address. Stripe Customer (`cardService.js:25`) is created with email + metadata only.

**Consequence for sourcing:** Because the buyer takes possession at the auction's pickup location, the sale is **sourced to the pickup/auction jurisdiction** (point-of-sale / origin-like), **not** to a buyer's home address. Every lot in a given auction is taxed at **one** jurisdiction's rate — the auction's location. This collapses an "every-US-address destination engine" problem into a **one-jurisdiction-per-auction** problem. That is dramatically simpler and shapes the recommendation below.

*(If/when shipping is ever implemented, shipped lots become destination-sourced and would need buyer ship-to address + a destination engine. That is explicitly out of scope for this plan — see [Open Decisions](#open-decisions-for-product--counsel).)*

---

## 2. Options evaluated

### Option A — Stripe Tax (`automatic_tax`) — **RECOMMENDED**
Use Stripe's native tax product. Stripe maintains rates for every US jurisdiction, monitors nexus thresholds, manages registrations, and produces filing/remittance exports. Tax is computed via Stripe's Tax Calculation API at invoice/charge time using a location.

- **Fit with pickup model:** We supply the **auction pickup address** as the tax location for the calculation (the point where goods are received). We do *not* need to capture a buyer address — which matches the current data model and the address-privacy rule.
- **Pros:** Already fully on Stripe (TEST today); no rate tables to build or maintain; nexus monitoring + registration management + filing exports built in; native exemption support via Stripe Customer `tax_exempt` and customer tax IDs; rates stay current automatically; minimizes our compliance-engineering surface.
- **Cons:** Per-transaction Stripe Tax fee; ties tax tighter to Stripe (acceptable — we are Stripe-committed); Stripe Tax is designed destination-first, so we must deliberately configure it to source to the pickup location rather than a buyer address (supported, but a configuration decision, not a default).
- **Maintenance:** Low. Stripe owns rate accuracy and jurisdiction changes.

### Option B — Custom tax-rate engine (in-house)
Maintain our own rate tables per state/county/city and compute tax ourselves.

- **Pros:** No per-transaction tax vendor fee; full control.
- **Cons:** We become responsible for **rate accuracy across thousands of changing jurisdictions**, nexus tracking, and producing remittance reports — an ongoing compliance liability with real legal exposure if wrong. High build + perpetual maintenance. Strongly discouraged for a small team.
- **Caveat that softens this:** Because we are origin/pickup-sourced and Advantage operates from a small, known set of auction locations (often a single state — Michigan governing law), the *rate-lookup* problem is small. If counsel confirms collection is limited to one or a few states, a **minimal curated rate table** (one rate per active auction jurisdiction, admin-maintained) becomes viable as a fallback if Stripe Tax is rejected. This is the only scenario where a custom approach is reasonable.

### Option C — Third-party engine (Avalara / TaxJar)
- **Pros:** Best-in-class jurisdiction coverage + filing services.
- **Cons:** Heavier integration than Stripe Tax, additional vendor + cost, and redundant given we already run on Stripe. Overkill for a one-jurisdiction-per-auction pickup model.

### Recommendation
**Adopt Stripe Tax (Option A)**, configured to source tax to the **auction pickup jurisdiction**. Rationale:
1. We already run entirely on Stripe; this is the lowest-integration, lowest-maintenance path.
2. The pickup model means we need a *location for the calculation*, and we already have it (auction address) — no new buyer-address capture, preserving the address-privacy rule.
3. Stripe Tax absorbs the highest-risk, highest-maintenance burden (rate accuracy, nexus monitoring, registration, filing exports) — the parts most dangerous to own in-house.
4. Native exemption support (`tax_exempt` + tax IDs) integrates cleanly with the planned exemption sub-system.

**Fallback:** If counsel confirms collection is limited to a single state, an admin-maintained one-rate-per-jurisdiction table (Option B-minimal) is an acceptable lighter alternative — but Stripe Tax is still preferred for nexus monitoring and filing support as the business expands.

---

## 3. Sourcing decision (origin/pickup vs destination)

| Scenario | Sourcing | Tax location used |
|---|---|---|
| **Pickup (current, ~all sales)** | Point-of-sale / origin-like | **Auction pickup address** (`auctions.address_state/city/zip`) |
| Shipping (stubbed, not built) | Destination | Buyer ship-to address (NOT captured today) — out of scope |

**Phase-1 build target: pickup-only, sourced to the auction location.** This is the entire current business. Shipping tax is deferred until shipping itself is implemented.

---

## 4. Required schema changes (for Phase 2, not built now)

> Additive, reversible, behind the existing per-file guarded-migration pattern. Charging behavior changes only when explicitly activated alongside Stripe LIVE.

**`invoices`** — add line-item + tax fields:
- `subtotal_cents` (hammer; later + premium), `tax_cents`, `total_cents`
- `tax_rate` (numeric, snapshot of applied rate), `tax_jurisdiction` (text, e.g. "MI / Kent County")
- `tax_calculation_id` (Stripe Tax Calculation reference, for audit/filing)
- `tax_exempt` (bool) + `exemption_id` (FK to buyer exemption record), `tax_basis_snapshot` (JSONB — the rate/jurisdiction/exemption in effect at invoice time, preserved historically)

**`payments`** — separate tax from principal:
- `tax_cents` (tax portion of the charge), keep `amount_cents` semantics explicit (hammer vs total). Total charged = hammer (+ premium when active) + tax.

**`auctions`** — tax config per auction:
- `tax_collection_enabled` (bool), derived/confirmed `tax_jurisdiction` from address, optional `tax_behavior` (tax-exclusive expected for auctions).

**New: `buyer_tax_exemptions`** — per the existing exemption plan (`tax-exemption-reseller-certificate-plan.md`): legal/business name, permit/resale number, issuing state, certificate type, expiration, document reference (private Cloudinary + SHA-256), status (`not_submitted|pending|approved|rejected|expired|revoked|manual_review`), reviewer/audit trail.

**New (optional): `tax_jurisdictions` / registration config** — if Stripe Tax is *not* used, a small admin-maintained rate table keyed by state/jurisdiction. Not needed if Stripe Tax owns rates.

**Seller settlement note:** tax collected is a **liability, not seller revenue.** `seller_payouts` must continue to compute payout on **hammer only** and must NOT include `tax_cents`. (No change to the live flat-10% payout in this phase, per constraints — but the settlement *document* must clearly separate "tax collected (remitted by Advantage)" from seller proceeds.)

---

## 5. Required UI changes (for Phase 2)

**Buyer:**
- Tax shown as a line item on the invoice and at payment time. (Business rule: "tax is calculated after auction close" → tax appears at the post-close payment step, consistent with the win→pay flow.)
- Exemption certificate upload + status in the Account page (buyers currently have **no upload surface** — net-new; see exemption plan Phases A–B).

**Admin:**
- Per-auction tax config: confirm/override pickup jurisdiction, enable/disable collection.
- Tax-collected report (by auction, by jurisdiction, by period) for remittance — fills the Section G gap (no tax liability report today).
- Exemption review queue (approve/reject/revoke), reusing the video-moderation pattern (exemption plan Phase C).

**Seller:**
- Settlement document shows tax collected separately and excluded from seller proceeds (clarity, not a payout change).

---

## 6. Estimated implementation effort

| Workstream | Effort | Notes |
|---|---|---|
| Stripe Tax integration (calc at charge/invoice, pickup-sourced) | **M** | Wire Tax Calculation API; attach to PaymentIntent/invoice; store calc id |
| Schema: invoice line items + tax fields, payment tax split | **M** | Additive migrations; invoiceService + paymentService changes |
| Auction tax config + admin UI | **S–M** | Derive jurisdiction from `address_state`; enable/disable |
| Tax-collected / remittance report | **M** | New admin report (ties to reconciliation gap) |
| Exemption sub-system (manual-first: upload → admin approve → invoice exempt) | **M–L** | Per existing exemption plan Phases A/C/D; buyer upload surface is net-new |
| Settlement document tax separation | **S** | Display-only; no payout math change |
| Tests (calc correctness, exempt path, rounding, historical snapshot) | **M** | Business-rule coverage required |
| **Total (pickup-only, Stripe Tax, manual exemptions)** | **L (multi-sprint)** | Shipping/destination tax explicitly deferred |

Effort is bounded largely *because* the pickup model yields one jurisdiction per auction and Stripe Tax owns rate maintenance. A destination-based custom build would be materially larger and riskier.

---

## Compliance Considerations

**These are hard gates and require attorney + CPA sign-off before any tax goes live. Engineering cannot decide them.**

1. **Marketplace facilitator status.** Advantage collects payment on sellers' behalf, which in most states makes it a **marketplace facilitator** legally responsible for collecting and remitting tax on facilitated sales. This likely shifts the obligation from sellers to Advantage. Must be confirmed per state.
2. **Nexus & registration.** Determine which states/jurisdictions Advantage must register in and collect for. Stripe Tax monitors economic-nexus thresholds, but the **decision to register** is legal. (Michigan is the governing-law state and a likely primary jurisdiction.)
3. **Taxability of auction/estate sales.** Whether these sales (and which categories) are taxable, and whether occasional-sale/estate exemptions apply — counsel/CPA decision.
4. **Pickup sourcing confirmation.** Confirm with CPA that pickup sales source to the pickup location (the architectural assumption here).
5. **Buyer premium taxability.** When premium activates (later phase), confirm whether the 18% premium is part of the taxable base.
6. **Exemption / resale certificate handling.** Manual-first (buyer uploads → admin approves → invoice marked exempt), historical certificate-in-effect snapshot per invoice, retention per state rules. Do not auto-decide validity without an official validation source. (Detail in `tax-exemption-reseller-certificate-plan.md`.)
7. **Remittance & filing cadence.** Who files, how often, via what export (Stripe Tax filing/reports vs CPA-managed). Record retention multi-year.
8. **Privacy/security of tax PII.** Exemption documents are private (Cloudinary private + signed short-TTL URLs + SHA-256), admin-only access, every view/decision audited — treat like `seller_identity`.

---

## Phasing within the tax workstream (post-approval)

- **1A (this doc):** Architecture decision — Stripe Tax, pickup-sourced. *Approval gate.*
- **1B:** Counsel/CPA engagement on the compliance gates above. *Cannot be skipped.*
- **2:** Schema + Stripe Tax calculation wired in **TEST**, tax shown on invoice/payment, tax-collected report. No LIVE charging.
- **3:** Manual exemption flow (upload → approve → exempt invoice).
- **4 (gated on Stripe LIVE + counsel sign-off):** Activate real collection. This coincides with the broader Stripe-LIVE go-live, not before.

---

## Open Decisions (for product / counsel)

1. Which state(s) will Advantage collect tax in at launch? (Drives Stripe Tax registration scope vs. the minimal-rate-table fallback.)
2. Confirm marketplace-facilitator obligation (Advantage collects/remits vs. seller-of-record).
3. Confirm pickup-location sourcing for in-person collection.
4. Is shipping on the roadmap? If yes and near-term, destination tax + buyer ship-to address capture must be added to scope (currently deferred).
5. Stripe Tax vs minimal in-house rate table — proceed with Stripe Tax unless cost/scope analysis from counsel favors a single-state table.
6. Premium taxability (defer until premium activation, but flag now).

---

## Recommendation Summary

> **Adopt Stripe Tax, sourced to the auction pickup jurisdiction.** It fits the pickup-based, no-buyer-address model exactly; offloads the riskiest compliance-engineering (rate accuracy, nexus, filing) to Stripe; and integrates natively with the planned exemption sub-system. The pickup model reduces this from a destination-engine problem to one jurisdiction per auction, keeping effort at a bounded multi-sprint **L**. **The build is gated behind attorney + CPA sign-off on marketplace-facilitator status, nexus/registration, and taxability — and behind Stripe LIVE for real collection.**

**No code was written. No schema was changed. Stopping for Phase 1 approval.**
