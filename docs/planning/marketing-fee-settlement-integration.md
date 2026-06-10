# Marketing Fee Settlement Integration — Planning

**Status:** Planning only. No code, schema, migration, deployment, or commit is implied by this document.
**Date:** 2026-06-10 · **Production release at time of writing:** `e0f005f` (Line A), Stripe **TEST** mode.
**Decision of record:** **Option A approved** — the marketing package selected for a specific auction is the source of truth for that auction's marketing fee.

---

## 1. Current State

### Summary of existing implementation
Marketing package **selection** exists and is intentionally non-financial. When a seller (or admin) selects a package for an auction:
- `POST /api/marketing/auctions/:auctionId/package` → `marketingService.createMarketingJob()` performs a single `INSERT INTO marketing_jobs (...)`, then calls `triggerMarketingWorkflow()`, which only **logs** and assembles a campaign payload.
- **No charge, PaymentIntent, invoice, or settlement entry** is created at any point (verified: no `stripe`/`PaymentIntent`/`invoice`/`charge`/`settlement` references in any marketing code path).

### Relevant tables, services, workflows
| Layer | Artifact | Role / relevant fields |
|---|---|---|
| Catalog (admin) | `marketing_packages` (mig 043) | `name`, `description`, **`price_cents`** (NOT NULL ≥0), `features` JSONB, `is_active`, `display_order` |
| Legacy catalog | `campaigns` (mig 001) | `tier`, `fee_cents` — superseded by `marketing_packages`; not used by the live flow |
| Per-auction selection | `marketing_jobs` (mig 014) | `auction_id`, `seller_user_id`, **`package_type` (free TEXT)**, `status` (default `pending`), `budget`, `target_radius_miles` — **no price/fee snapshot, no FK to `marketing_packages`** |
| Agreement/terms | `seller_terms` (mig 054) | **`marketing_fee_cents`**, `commission_pct`, `buyer_premium_pct`, `credit_card_fee_pct`, `settlement_terms`, `payout_schedule` — per-seller defaults, managed by `sellerTermsService.js` |
| Settlement | `seller_payouts` (mig 015) | `gross_revenue_cents`, `platform_fee_cents`, `seller_payout_cents`, `payout_method/status/reference` — **no marketing-fee column** |
| Settlement logic | `payoutService.createSellerPayoutRecord()` | `seller_payout = gross − platform_fee` (10%); **no marketing deduction**; **not wired into auction close** |
| Reporting | `reportingService.generateAuctionReport()` | summary: `gross_revenue_cents`, `platform_fee_cents`, `seller_payout_cents`; per-lot `fee_amount_cents` (10%) — **no marketing line** |
| Statement PDF | `pdfGenerationService` (`buildReportPdf` / `sendFinalSellerReport`) | lots table + platform fee/payout; **zero marketing references** |
| Unused intent | `auctions.marketing_selection` (JSONB) + `marketingService.selectCampaignForAuction()` | `// TODO … Not implemented` stub that throws; never populated |

### Why the system only *partially* supports the desired model
The desired flow is **select → no charge → deduct at settlement → itemize on statement**. Only the first two steps hold today, and largely by omission:
- ✅ **No immediate charge** — nothing financial happens at selection.
- ❌ **No settlement deduction** — `seller_payouts` has no marketing-fee field; `payoutService` math excludes it; payout creation isn't even invoked on close.
- ❌ **No statement itemization** — neither `reportingService` nor the PDF emit a marketing line.
- 🔌 **Disconnected building blocks** — `marketing_packages.price_cents` and `seller_terms.marketing_fee_cents` exist but are never joined into the selection→settlement→statement chain; the per-auction selection captures **no monetary value at all**.

---

## 2. Approved Business Rules (Option A)
1. **Per-auction source of truth:** the marketing package selected for a specific auction determines that auction's marketing fee — **independent of seller-level defaults**. Different auctions by the same seller may use different packages.
2. **Never charged immediately:** selecting a package creates **no** Stripe charge, PaymentIntent, invoice, or payment record.
3. **Deducted during settlement:** the marketing fee is subtracted from seller proceeds as part of post-close settlement.
4. **Itemized on seller-facing outputs:** the marketing fee appears as a **separate line item** on seller settlement statements and final-report PDFs.
5. **Historical accuracy:** the fee applied to an auction must reflect the package/price **as selected for that auction**, not the catalog's current price.

---

## 3. Recommended Future Architecture
> Design intent only — not a schema change. Implementation is gated (see §6).

### 3.1 Selection storage (per auction)
- Treat `marketing_jobs` as the authoritative per-auction selection record.
- Add an explicit linkage to the catalog: a nullable reference to the selected `marketing_packages.id` so the chosen package is unambiguous (today `package_type` is free text).
- One active selection per auction; superseding selections should be modeled explicitly (see §3.2 / §7).

### 3.2 Fee snapshot (historical accuracy)
- **Snapshot the fee at selection time** onto the selection record: `marketing_fee_cents` (and a copy of package name/label) captured from `marketing_packages.price_cents` **at the moment of selection**.
- Rationale: catalog prices change; the auction's settlement must use the price **as agreed when selected**, never a later catalog value. The snapshot makes the obligation immutable for that auction.
- Keep a small immutable history (e.g., revisions are new rows with `superseded_at`) so the *effective* selection at settlement time is deterministic and auditable.

### 3.3 Settlement consumption
- Add a marketing-fee field to the settlement record (`seller_payouts`): e.g. `marketing_fee_cents`.
- Settlement math becomes: `seller_payout = gross_revenue − platform_fee − marketing_fee` (floor at 0; define behavior when fees exceed proceeds — see §7).
- At close, resolve the **effective** marketing selection for the auction (latest non-superseded, non-cancelled) and read its snapshotted fee — never re-read the live catalog.
- This must compose with the (currently absent in prod) payout wiring — `createSellerPayoutRecord` should be invoked at/after close and include the marketing line.

### 3.4 Reports & PDFs
- Extend `reportingService.generateAuctionReport()` summary to include `marketing_fee_cents` and a `net_after_marketing` (or reuse `seller_payout_cents` once it nets marketing).
- Extend `pdfGenerationService` final report to render a dedicated **"Marketing package — <name>"** line with its fee, between platform fee and net payout.
- Seller settlement statement mirrors the same itemization.

### 3.5 Auditing
- Every selection, revision, and cancellation writes to `audit_log` (existing infra; `GET /api/admin/audit-log`) with actor, auction, package, fee snapshot, and timestamp.
- The settlement record references the exact selection/snapshot used, so a statement can always be traced back to "which package, at what price, selected when, by whom."

---

## 4. Pilot Handling Procedure (manual — until automation exists)
Because deduction and itemization are not implemented, the pilot handles marketing fees **manually and out-of-band**. (Consistent with `docs/operations/auction-close-runbook.md`, which already notes payouts are manual during the pilot.)

1. **Track selections.** For each auction with a marketing package, operator records in an ops ledger (spreadsheet/issue): auction id, seller, **package name + price_cents (from `marketing_packages` at selection date)**, selection date, selecting actor. Source the selection from `GET /api/marketing/auctions/:auctionId/package` (read-only).
2. **Freeze the price at selection.** Capture the catalog `price_cents` **on the day of selection** into the ledger — do not rely on the live catalog later (it may change).
3. **At settlement (post-close).** Operator computes seller proceeds manually: `gross − platform_fee(10%) − marketing_fee(from ledger)`. Record the marketing deduction explicitly in the ledger and in the audit note.
4. **Adjust the statement.** Since the final-report PDF cannot itemize marketing yet, append a **manual addendum** to the seller statement: a clearly labeled "Marketing package — <name>: −$X.XX" line and the adjusted net. Keep the addendum with the auction's records.
5. **No Stripe action.** Do not create any Stripe object for marketing fees (TEST mode; and per business rule never charge). Deduction is purely a proceeds reduction.
6. **Reconcile.** Weekly, reconcile the ledger against closed auctions to ensure every package-bearing auction had its fee deducted and documented.

---

## 5. Future Implementation Phases
> Phases are scoping guidance only; each requires its own design + review before any code/migration.

**Phase 1 — Data model updates**
- Add per-auction fee snapshot to the selection (`marketing_jobs`: `marketing_package_id`, `marketing_fee_cents`, package label; revision/`superseded_at` handling).
- Add `marketing_fee_cents` to `seller_payouts`.
- Backfill/define defaults; no behavior change yet (write-side capture only).

**Phase 2 — Settlement integration**
- Update `payoutService.createSellerPayoutRecord` to resolve the effective selection and subtract `marketing_fee_cents`.
- Wire payout creation into the auction close flow (currently unwired).
- Handle edge cases (fees > proceeds, cancelled selection) — see §7.

**Phase 3 — Statement / PDF itemization**
- Extend `reportingService` summary + `pdfGenerationService` final report and the seller statement to render the marketing line.

**Phase 4 — End-to-end validation**
- Staging validation: select package → close → payout record includes marketing line → PDF/statement itemizes correctly → audit trail complete. Include the §7 edge cases. Validate before any production rollout and before LIVE.

---

## 6. Dependencies
- **Line B settlement-integrity work** (`b33d720` webhook claim-after-process, `f03809b` refund integrity + orphan PaymentIntent) is **not in production** and is a hard prerequisite for the Stripe LIVE cutover (`docs/stripe-live-cutover-prerequisites.md`).
- This marketing-fee work **modifies the same settlement surface** (`payoutService`, `seller_payouts`, close flow, reporting). Building it **before** the settlement reconciliation is planned/landed risks:
  - merge/data-model collisions with Line B's settlement changes,
  - duplicated or conflicting payout-record logic,
  - re-validating settlement twice.
- **Therefore:** sequence this **after** Line B settlement reconciliation is planned (ideally after it lands), so marketing-fee deduction is layered onto a stabilized, reconciled settlement/payout pipeline. The payout pipeline itself must first be **wired into close** (a Line-B-adjacent gap) before marketing deduction has anywhere to attach.

---

## 7. Risks & Edge Cases
| # | Case | Risk | Mitigation (design intent) |
|---|---|---|---|
| 1 | **Package price changes after selection** | Settlement uses wrong (current) price | **Snapshot fee at selection** (§3.2); settlement reads snapshot, never live catalog |
| 2 | **Auction edited after selection** | Fee/eligibility drift; stale selection | Keep selection independent of auction edits; re-resolve "effective selection" at close; audit any change |
| 3 | **Package removed / cancelled** | Deducting for an un-delivered package, or failing to deduct | Model cancellation explicitly (`status='cancelled'`); settlement excludes cancelled selections; document operator override |
| 4 | **Multiple package revisions** | Ambiguous which fee applies | Revisions as new rows with `superseded_at`; settlement uses the latest non-superseded, non-cancelled selection; full history retained |
| 5 | **Historical reporting accuracy** | Re-running an old report yields a different fee | Reports read the snapshot tied to the settlement record, not the catalog — deterministic regardless of later catalog edits |
| 6 | **Fee exceeds proceeds** | Negative payout | Floor `seller_payout` at 0; flag shortfall for operator; define whether residual is carried/written off (product decision) |
| 7 | **Seller-default vs per-auction conflict** | `seller_terms.marketing_fee_cents` disagrees with the selected package | **Per-auction selection wins** (Option A). `seller_terms.marketing_fee_cents` is a default/fallback only; document precedence explicitly |
| 8 | **Selection with no catalog price** | Free-text `package_type` with no `price_cents` | Require catalog linkage at selection going forward; for legacy rows, operator supplies the fee from the ledger |

---

## Executive Summary
Marketing **package selection** is implemented and correctly **non-financial** — no charge, PaymentIntent, invoice, or settlement entry is created at selection. However, the approved Option A model (no immediate billing → deduct at settlement → itemize on statement) is only **partially** supported: the selection captures **no fee snapshot**, `seller_payouts`/`payoutService` have **no marketing-fee field or logic** (and payout creation isn't even wired into close), and reports/PDFs emit **no marketing line**. The schema already holds the *ingredients* (`marketing_packages.price_cents`, `seller_terms.marketing_fee_cents`) but they are disconnected from the per-auction selection and settlement. The remaining work is net-new and touches the **same settlement surface as the deferred Line B reconciliation**, so it should be sequenced after that. During the pilot, marketing fees are handled **manually** (ledger + statement addendum), consistent with the already-manual payout process. No charge logic needs removal — the "never charge immediately" rule is already satisfied.

## Recommended Future Development Order
1. **Plan/land Line B settlement reconciliation** (prerequisite settlement surface) and **wire payout creation into close**.
2. **Phase 1 — Data model:** per-auction fee snapshot on the selection + `marketing_fee_cents` on `seller_payouts`.
3. **Phase 2 — Settlement integration:** `payoutService` subtracts the snapshotted marketing fee.
4. **Phase 3 — Itemization:** report summary + final-report PDF + seller statement render the marketing line.
5. **Phase 4 — End-to-end validation on staging**, including all §7 edge cases, before production and before any Stripe LIVE cutover.
6. **Until then:** run the §4 manual pilot procedure.

## Classification
- **Launch blocker?** **No.** Production is live; marketing fees can be handled manually.
- **Pilot blocker?** **No.** The §4 manual procedure covers the pilot (no package-bearing auction is blocked).
- **Stripe LIVE blocker?** **No — but strongly recommended before scale.** LIVE is independently gated on Line B. Marketing-fee automation is not strictly required to flip LIVE, but operating real-money settlement with **manual** marketing deductions is error-prone; automating it should be a near-term follow-on, sequenced right after Line B settlement reconciliation.
- **Net classification:** **Future enhancement** (settlement-coupled), to be implemented **after** Line B settlement reconciliation and **before** marketing fees are charged against real-money settlements at any meaningful volume.

---
*Documentation only. No implementation, code changes, schema changes, migrations, or deployments are performed or implied by this plan. References: `src/routes/marketing.js`, `src/services/marketingService.js`, `src/services/marketingWorkflow.js`, `src/services/payoutService.js`, `src/services/reportingService.js`, `src/services/pdfGenerationService.js`, `src/services/sellerTermsService.js`; migrations 014/015/043/054/001; `docs/stripe-live-cutover-prerequisites.md`; `docs/operations/auction-close-runbook.md`.*
