# Financial Workflow & Invoicing Audit

**Status:** Discovery / research only — no code, no migrations, no deployment.
**Date:** 2026-06-11
**Production reference:** `main @ 4ce3a12`
**Stripe mode:** TEST on prod and staging (no LIVE keys present).
**Scope:** End-to-end money path — buyer invoice, buyer email, payment, buyer premium, sales tax, seller settlement, accounting/reconciliation, operator experience.

> This audit documents the **actual implemented state** of the codebase, verified against source. It does NOT assume Stripe or any third party handles tax, fees, or reconciliation automatically. Where a business rule is documented but unbuilt, it is called out as **aspirational / unbuilt**.

---

## Executive Summary

The platform can take a buyer's card on file (Stripe SetupIntent), charge the **hammer price only** per lot, record a payment, create a minimal invoice row, and compute a flat-10% seller payout at auction close. Bidding-lifecycle emails are real and wired via Amazon SES. That core path is functional in TEST mode.

Everything that turns "we can charge a card" into "we can run a compliant auction business" is **missing or preview-only**:

- **Sales tax is entirely unimplemented** — no calculation, no storage, no exemptions. The "tax calculated after close" business rule is aspirational.
- **Buyer premium (18%) is config + preview only** — buyers are charged hammer only; sellers paid flat 10%.
- **No buyer financial documents are emailed** — no invoice email, no payment receipt, no settlement delivery (the settlement endpoint is a 501 stub).
- **No reconciliation surface** — Stripe fees, chargebacks, and tax liability are not tracked; refunds do not flow back into seller payouts.
- **No operator (admin) UI** for refunds, payouts, mark-paid, or resends — these exist as raw API endpoints only.

**Bottom line:** The money path is a working TEST-mode prototype. It is **not launch-ready for live charging** until tax, premium activation, financial-document delivery, and reconciliation are built. See [Consolidated Launch Blockers](#consolidated-launch-blockers).

---

## A. Buyer Invoices

### Current state
- **Trigger:** Invoice rows are created **only on successful payment**, inside `paymentService.recordPaymentSuccess()` (`src/services/paymentService.js:481` → `invoiceService.createInvoice`). Nothing is generated at auction close or at win-notification time.
- **Schema** (`db/migrations/029_create_invoices.sql`): `id, payment_id, buyer_user_id, auction_id, lot_id, amount_cents, status, created_at`. UUID primary key; **no human-readable invoice number**; `status` is `issued`/`paid` mirroring the payment.
- **Amount:** `amount_cents` mirrors the payment amount — **hammer price only**, no line items, no premium, no tax, no fees breakdown.
- **Buyer access:** JSON API only — `GET /api/invoices/mine` (`src/routes/invoices.js:6-41`) returns `{ id, amount_cents, lot_id, created_at, status, lot_title, lot_image_url }`.
- **Granularity:** **One invoice row per lot** (mirrors the per-lot payment model — see Section C). A buyer winning 5 lots gets 5 separate invoices.

### Does the invoice include thumbnail / title / lot number / auction name?
| Field | Present? | Notes |
|---|---|---|
| Lot **thumbnail** | ✅ Yes | First `lot_images` row by `sort_order` (`src/routes/invoices.js:6-29`) |
| Lot **title** | ✅ Yes | `l.title` |
| Lot **number** | ❌ No | `lots.lot_number` exists but is not selected |
| **Auction name** | ❌ No | Would need a JOIN to `auctions` |
| Itemized fees / tax / premium | ❌ No | Single `amount_cents` only |
| Payment date / method | ❌ No | Lives on `payments`, not joined |
| Pickup info | ❌ No | Lives in pickup assignment tables, not linked |

### Risks
- No invoice number → no stable external reference for accounting, disputes, or buyer support.
- Per-lot invoices → a multi-lot winner receives a fragmented, confusing set of separate charges/invoices with no consolidated total.
- Invoice amount is hammer-only → once premium/tax go live, the invoice record will understate what was actually charged unless restructured.
- No PDF and no email (see Section B) → buyers have no document to retain.

### Missing functionality
- Human-readable sequential invoice number.
- Line-item structure (hammer, premium, tax, fees, total).
- Auction name + lot number on the invoice.
- Consolidated per-buyer-per-auction invoice option.
- Invoice PDF rendering (no invoice PDF exists anywhere — `pdfGenerationService` only builds *auction reports*).
- Buyer-facing invoice HTML page (no `invoices.html`).

### Recommended fixes (no work performed here)
1. Add an invoice number sequence (per-year or per-auction) and a `tax_cents` + line-item structure (ties into Sections D & E).
2. Add a consolidated invoice view (group lot invoices by auction for one buyer).
3. Build an invoice PDF generator (reuse PDFKit + Cloudinary pattern already used for seller agreements / reports).
4. Wire an invoice email (Section B).

### Estimated effort
- Invoice numbering + line items + auction/lot-number fields: **M** (schema migration + invoiceService rewrite).
- Invoice PDF + buyer page: **M**.
- Consolidated multi-lot invoice: **M–L** (depends on whether the per-lot payment model is also consolidated — Section C).

### Launch blockers
- **A consolidated, line-itemized invoice carrying tax + premium is a LIVE-charge blocker** (cannot bill premium/tax without an invoice that shows them).

### Nice-to-haves
- Branded invoice PDF, downloadable from the buyer account page; invoice number search for support.

---

## B. Buyer Emails

### Current state
Two systems exist: a **legacy mock** (`src/services/notificationService.js`, console-log only, largely unwired) and the **active production system** (`src/lib/notificationContent.js` + `src/workers/notificationWorker.js` + `src/services/emailService.js`). The active system enqueues rows in `notifications_queue` and a worker polls every 5s, delivering via **Amazon SES** (nodemailer SMTP) with 5-retry exponential backoff.

**Wired & active (10 types):** `OUTBID`, `LEADING`, `WINNING`, `ENDING_SOON`, `CLOSE_TO_WINNING`, `FINAL_SECONDS`, `EXTENDED_BIDDING`, `NEW_AUCTION` (followers), `AUCTION_REJECTED` (seller), `AUCTION_RETURNED_TO_DRAFT` (seller). `WINNING` (`auctionService.js:696`) is the closest thing to a "you won — pay now" email and carries the winning amount + a payment CTA.

### Missing / incomplete buyer financial emails
| Email | Status | Evidence |
|---|---|---|
| **Invoice email** | ❌ Missing | No code path; invoice row created silently |
| **Payment receipt** | ❌ Missing | No code path |
| **Payment confirmed** | ⚠️ Mock only | Event emitted (`paymentService.js:516`) but handler only `console.log`s (`notificationService.js:439-498`); no SES send |
| **Card verification confirm** | ❌ Missing | `cardService.js` sends nothing on card-on-file |
| **Pickup reminder** | ❌ Missing | No code |
| **Bid confirmation** | ❌ Missing | Bidder gets no "your bid is in" email |
| **Registration confirmation** | ❌ Missing | `auth.js` register returns JWT only; template never emitted |

### Risks
- A buyer can be charged and have **no receipt or confirmation** — a chargeback and trust liability once charging is real money.
- No payment confirmation → support burden and disputes ("did my payment go through?").
- SES delivery is fire-and-forget; if SMTP env is unset, `sendEmail` returns `{ skipped: true }` and the row eventually marks failed — silent in production.

### Missing functionality
- Transactional buyer financial emails: payment receipt, invoice delivery (with PDF attachment once A is built), card-verified confirmation, pickup reminder.
- Registration confirmation / welcome.

### Recommended fixes
1. Promote `PAYMENT_CONFIRMED` from the mock system to the active `notificationContent` + worker pipeline with a real SES template; attach the invoice PDF.
2. Add a payment-receipt and pickup-reminder type to the active system.
3. Add SES delivery monitoring/alerting for `skipped`/failed rows.

### Estimated effort
- Payment receipt + invoice email (active pipeline, reuse attachment support): **S–M**.
- Pickup reminder (needs a scheduler hook on pickup assignments): **M**.
- Registration confirmation: **S**.

### Launch blockers
- **Payment receipt / payment-confirmed email is a LIVE-charge blocker** (charging real cards without a receipt is not acceptable).

### Nice-to-haves
- Card-verified confirmation, registration welcome, SES bounce/complaint handling.

---

## C. Payment Flow

### Current state
- **Card on file:** Stripe **SetupIntent** flow. `users.stripe_customer_id` + `card_verifications.stripe_payment_method_id` (migration 063). Customer created on demand (`cardService.ensureStripeCustomer`). Card metadata (brand/last4/exp) read live from Stripe, not stored. **"Has card on file" = customer exists AND a `verified` `card_verifications` row exists.**
- **The <$1 verification charge is NOT implemented** — `cardVerificationService.startVerification()` is a `throw "Not implemented"` stub (`src/services/cardVerificationService.js:5`). Card validity rests on SetupIntent confirmation only. *(Note: this conflicts with the CLAUDE.md business rule requiring a temporary sub-$1 verification charge at signup/card change.)*
- **Auth vs capture:** Direct immediate capture — `paymentIntents.create` sets no `capture_method`, so Stripe defaults to automatic (`paymentService.js:311-315`). No auth-then-capture.
- **Amount:** Hammer only (`lots.winning_amount_cents`). No premium, no tax.
- **Idempotency:** HTTP `Idempotency-Key` forwarded to Stripe; three-phase transactional create (DB pending row → Stripe call outside tx → attach intent id) with orphan/stale-pending guards.
- **Multi-lot:** **One PaymentIntent per lot.** `createPaymentIntent(userId, auctionId, lotId, …)`; partial unique index allows one active payment per `(lot_id, buyer_user_id)`. A multi-lot winner is charged separately per lot.
- **Failure handling:** `payment_intent.payment_failed` webhook → `recordPaymentFailure` increments `retry_count`; after 3 → `failed`. No backoff/cooldown (TODO). Webhook permits `failed → paid` recovery because Stripe is authoritative.
- **Refunds (full + partial):** `processRefund` (admin-only) with overspend guard (`refunded + new <= amount`, DB CHECK `chk_refunded_amount_bounded`, migration 059), 30s concurrent-click guard, cumulative `refunded_amount_cents`, status `partially_refunded`/`refunded`. Out-of-band Dashboard refunds reconciled via `charge.refunded` webhook (`_handleChargeRefunded`).
- **Mode:** Stripe **TEST**. No runtime LIVE gate — promotion is a manual env-var swap + webhook re-registration.

### Disputes / chargebacks
**NOT handled.** Explicit comment at `paymentService.js:456`: "Chargebacks/disputes arrive via separate event types and are not handled here." No `charge.dispute.*` webhook handler exists.

### Risks
- **No chargeback handling** → disputes are invisible to the platform; seller may already be paid (Section F) when a buyer charges back.
- **Per-lot charging** → a multi-lot winner sees N separate card charges; higher decline rate, N receipts, poor UX, and more reconciliation rows.
- **Missing <$1 verification** → violates the documented business rule; bad cards only surface at charge time (after the auction closed and the buyer "won").
- **No retry backoff** → failed payments need manual operator action.

### Missing functionality
- `charge.dispute.*` webhook handling + chargeback ledger.
- The signup/card-change sub-$1 verification charge.
- Optional multi-lot consolidated PaymentIntent.
- Premium + tax in the charged amount (Sections D, E).

### Recommended fixes
1. Add a `charge.dispute.created`/`.closed` webhook handler that records the dispute and flags/holds the related seller payout.
2. Implement (or formally waive in writing) the sub-$1 card verification per the business rule.
3. Decide multi-lot model: keep per-lot, or aggregate to one PaymentIntent + one invoice per buyer-per-auction.

### Estimated effort
- Dispute webhook + ledger: **M**.
- Sub-$1 verification: **S–M**.
- Multi-lot consolidation: **L** (touches payments, invoices, settlement).

### Launch blockers
- **Chargeback/dispute handling is a LIVE-charge blocker** (real money = real disputes).
- **Sub-$1 verification** is at least a business-rule compliance blocker (confirm with product whether it is launch-gating).

### Nice-to-haves
- Retry backoff/cooldown; saved-card management UI for buyers.

---

## D. Buyer Premium (18%) — DO NOT ACTIVATE

### Current state — **INACTIVE (config + preview only)**
- `billingTermsService.js` header is explicit: *"NOT used for live charging or live payout. Buyers are charged hammer only and sellers are paid the existing flat 10% … until Phase 2 (gated on Buyer Terms v2 + Stripe LIVE)."*
- **Defaults:** `DEFAULT_BUYER_PREMIUM_BPS = 1800` (18%), `DEFAULT_AAC_BP_SHARE_BPS = 500` (5%), `DEFAULT_AAC_HAMMER_COMMISSION_BPS = 200` (2%). Seller BP share = premium − AAC share = 1300 bps (13%).
- **Config precedence** (`resolveEffectiveTerms`): auction override (`auctions.buyer_premium_bps`, migration 067) → seller default (`seller_terms.buyer_premium_pct`, migration 069) → platform default.
- **Calculation** (`computeSettlement`) produces a preview breakdown only; stored to additive `seller_payouts` columns + `terms_snapshot` JSONB (migration 069) with `active: false` hardcoded.
- **Charged amount = hammer only** (`paymentService.js:312`); **invoice = hammer only** (`invoiceService.js:14`); **payout = flat 10%**. Admin preview endpoint `GET /api/admin/auctions/:id/settlement-preview` is explicitly labeled "PREVIEW ONLY — buyer premium is NOT charged."

### Risks
- The config exists but is divorced from the charge/invoice/payout paths — activating it requires wiring three separate surfaces consistently (charge amount, invoice line item, payout calc) or buyers and sellers will be billed/paid inconsistently.
- Premium-vs-tax ordering is undefined (is premium taxable? — see Section E).

### Missing functionality (for eventual Phase 2, not now)
- Premium added to PaymentIntent amount.
- Premium as an invoice line item (Section A).
- Premium reflected in live seller settlement (Section F).
- Live buyer-facing premium display during bidding (the CLAUDE.md rule "buyer premium must be shown live" — verify the bidding UI separately).

### Estimated effort
- Full Phase-2 activation (charge + invoice + payout + UI + tests): **L**. Gated behind Buyer Terms v2 + Stripe LIVE.

### Launch blockers
- None *for this audit* — the directive is **do not activate**. It becomes relevant only at the Phase-2 / Stripe-LIVE milestone.

### Nice-to-haves
- N/A until activation.

---

## E. Sales Tax — CRITICAL

> Verified directly against code. **Do not assume Stripe handles this.**

### Current state — **NOT IMPLEMENTED (completely absent)**
- Zero matches for `tax`, `tax_cents`, `sales_tax`, `taxRate` in application code.
- **No Stripe Tax / `automatic_tax`** on PaymentIntents or Invoices.
- **No third-party tax engine** (TaxJar / Avalara / Stripe Tax) — no import, config, or call.
- **No tax storage** anywhere: no `tax_cents` on `invoices`, `payments`, or `seller_payouts` across all 71 migrations.
- **No exemptions / reseller certificates** — no `tax_exempt`/`resale`/`certificate` column.
- **No destination-based logic** — no buyer ship-to/pickup address feeds any tax computation (`auctions.address_state` is the seller's location and is never used for tax).
- PaymentIntent charges bare `amount_cents`; invoice stores a single `amount_cents`.

The CLAUDE.md business rule "tax is calculated after auction close" is **aspirational and unbuilt**. A planning doc — `docs/projects/tax-exemption-reseller-certificate-plan.md` — already confirms this and marks tax a **Stripe-LIVE blocker**.

### Risks
- **Charging real money with no sales tax collection is a legal/compliance exposure** (Michigan governing law per the seller agreement; marketplace facilitator rules may apply by state).
- Retrofitting tax after launch requires invoice/payment/payout restructuring and possibly re-billing.

### Missing functionality (everything)
- Tax rate determination (destination-based, by buyer pickup/ship state).
- Tax engine integration (Stripe Tax is the lowest-friction given existing Stripe use).
- `tax_cents` storage on invoice/payment; tax as an invoice line item.
- Exemption / reseller-certificate capture + workflow.
- Tax liability / collected-tax report (Section G).
- Decision: is buyer premium taxable? (interacts with D).

### Recommended fixes
1. Decide engine: **Stripe Tax (`automatic_tax`)** is the most direct path given the Stripe-native stack; evaluate vs. Avalara/TaxJar for auction-specific rules.
2. Capture buyer tax address + exemption status at registration/checkout.
3. Add tax fields to invoice/payment schema and include tax in the charged amount.
4. Build a collected-tax report for remittance.

### Estimated effort
- **L** (engine integration + schema + exemption workflow + reporting + tests). This is a project, not a task.

### Launch blockers
- **Sales tax is a hard LIVE-charge blocker.** Do not enable Stripe LIVE for buyer charging until tax collection (and exemption handling) is implemented or a documented, counsel-approved decision exempts it.

### Nice-to-haves
- Automated remittance filing; per-jurisdiction reporting.

---

## F. Seller Settlement

### Current state — **Partially implemented (flat-10% live model)**
- **Live formula** (`reportingService.js:64-90`): `PLATFORM_FEE_RATE = 0.10`; per auction, `gross_revenue_cents = Σ winning_amount_cents (won lots)`, `platform_fee_cents = gross × 0.10`, `seller_payout_cents = gross − fee`. Net = **90% of hammer**.
- **Payout record:** `payoutService.createSellerPayoutRecord()` reads `report.summary.{gross_revenue_cents, platform_fee_cents, seller_payout_cents}` (correct nested shape) and upserts `seller_payouts` (one row per auction, idempotent on `auction_id`).
- **`seller_payouts` schema** (migration 015 + 069 preview cols): `gross_revenue_cents, platform_fee_cents, seller_payout_cents, payout_method, payout_status, payout_reference` + preview-only `buyer_premium_cents / aac_bp_share_cents / seller_bp_share_cents / aac_hammer_commission_cents / terms_snapshot`.
- **Settlement PDF + email:** `pdfGenerationService.sendFinalSellerReport()` builds an auction-report PDF (lots table + summary) and emails the seller. **However, the admin trigger endpoint `POST /api/admin/auctions/:id/send-final-report` returns 501 — "not yet implemented"** (`src/routes/admin.js:670-686`). So the PDF builder exists but is not operably wired to a working admin action.
- **Payout preferences:** `seller_payout_preferences` (migration 016) stores ACH/check method. **No automated release** — `payout_status` is managed manually; no Stripe Connect integration.

### Critical gaps
- **Refunds do NOT flow into payout.** `generateAuctionReport` reads `lots.winning_amount_cents` directly; a refund after close does not decrement `seller_payouts`. A seller can be paid in full while the buyer is refunded.
- **Chargebacks do NOT flow into payout** (no dispute handling at all — Section C).
- **No pickup/no-show/logistics adjustments** in settlement.
- **Buyer premium is preview-only** (`active: false`) — does not affect live payout.
- **No tax handling** (nothing collected to exclude — Section E).
- **No seller-facing payout report** — only the admin `/api/admin/payouts` JSON.

### Risks
- Paying sellers gross-of-refund/chargeback creates **clawback exposure** once real money flows.
- The settlement email being a 501 stub means sellers currently have **no automated settlement document**.

### Recommended fixes
1. Implement the `send-final-report` endpoint (the PDF builder already exists) + an admin UI button.
2. Make payout calculation refund-aware (subtract `payments.refunded_amount_cents`) and add a hold/adjustment when a dispute is open.
3. Add a seller-facing settlement view/PDF download.
4. Define and build payout-release workflow (manual approve now; Stripe Connect later).

### Estimated effort
- Wire 501 settlement endpoint + UI: **S–M**.
- Refund/chargeback-aware payout: **M** (depends on Section C dispute handling).
- Seller-facing settlement surface: **M**.

### Launch blockers
- **Refund-aware (and dispute-aware) payout is a LIVE-charge blocker** — paying gross-of-refund is a real financial-loss path.
- **A working settlement document delivery** (the 501) should be fixed before sellers transact for real money.

### Nice-to-haves
- Automated Stripe Connect payouts; payout scheduling (the documented 14-day-after-close rule).

---

## G. Accounting & Reconciliation

### Current state
| Component | Data exists? | Aggregation/report? | Status |
|---|---|---|---|
| Hammer revenue | ✅ `lots.winning_amount_cents` | ✅ `/api/auctions/:id/report` | Present |
| Buyer premium revenue | ⚠️ config only | ⚠️ settlement-preview | Config only, not charged |
| **Sales tax collected** | ❌ | ❌ | **Missing** |
| **Stripe fees** | ❌ | ❌ | **Missing** |
| Seller payouts | ✅ `seller_payouts` | ✅ `/api/admin/payouts` | Present |
| Refunds | ✅ `payments.refunded_amount_cents` | ⚠️ per-payment only | Partial |
| **Chargebacks** | ❌ | ❌ | **Missing** |

- **Audit log present (partial):** `audit_log` table (migration 013) + `GET /api/admin/audit-log` with filters. Logs `payment.created`, `payment.refund_started`, `payment.refunded`, seller suspension. **Does not** log Stripe-fee/balance-txn reconciliation or chargebacks (those aren't captured at all).
- **Platform fee** is a hardcoded `0.10` in `reportingService.js` — not stored per transaction, not inspectable historically.

### Risks
- **No Stripe-fee capture** → platform cannot compute true net revenue or reconcile Stripe deposits to platform records.
- **No reconciliation report** → no way to tie Stripe settled balances ↔ DB payments ↔ payouts; manual, error-prone.
- **No tax liability report** → cannot remit collected tax (compounds Section E).
- **No chargeback ledger** → losses invisible.

### Missing functionality
- Stripe fee recording (extract `balance_transaction.fee` on charge/refund webhooks).
- Reconciliation report: Stripe payouts/balance ↔ DB payments ↔ seller payouts ↔ refunds.
- Tax-collected/liability report.
- Chargeback tracking table + report.
- Per-transaction fee snapshot (so historical payouts are auditable).

### Recommended fixes
1. On `charge.succeeded`/`charge.refunded` webhooks, fetch the balance transaction and persist `stripe_fee_cents`.
2. Build a reconciliation report endpoint + admin view.
3. Add tax + chargeback ledgers (tie to E and C).

### Estimated effort
- Stripe fee capture: **M**.
- Reconciliation report: **M–L**.
- Tax/chargeback ledgers: rolled into E and C.

### Launch blockers
- **Stripe fee capture + a basic reconciliation report are strongly recommended before LIVE** (operating real money with no reconciliation is high-risk, though arguably a fast-follow rather than a hard gate — flag for finance/owner decision).
- **Tax liability reporting is a hard blocker** (part of Section E).

### Nice-to-haves
- Double-entry / GL export (QuickBooks/Xero), payment-variance alerts.

---

## H. Operator (Admin) Experience

### Current state — capability matrix
| Capability | API endpoint | Admin UI | Status |
|---|---|---|---|
| View audit log | ✅ `GET /api/admin/audit-log` | ❌ | API only |
| View payments (diagnostics) | ✅ | ✅ read-only table | Present |
| View seller payouts | ✅ `GET /api/admin/payouts` | ❌ ("UI pending", `admin/index.html:326`) | API only |
| Mark payment paid | ✅ `POST /api/admin/payments/:id/record-success` | ❌ | API only |
| Issue refund (full/partial) | ✅ `POST /api/admin/payments/:id/refund` | ❌ | API only |
| Resend settlement / final report | ⚠️ 501 stub | ❌ | Wired, not implemented |
| Resend invoice | ❌ | ❌ | Missing |
| Resend payment receipt | ❌ | ❌ | Missing |
| Mark invoice paid | ❌ | ❌ | Missing |
| View tax collected | ❌ | ❌ | Missing |
| Export reports (CSV) | ❌ | ❌ | Missing |
| Export auction report (PDF) | ✅ `GET /api/auctions/:id/report/pdf` | ❌ not linked | API only |

### Risks
- **Refunds and mark-paid are API-only** → operators must craft authenticated HTTP calls (with `Idempotency-Key`) by hand to refund a customer. Error-prone and not delegable to non-engineers — a serious operational gap once real money flows.
- No way for an operator to resend a buyer their invoice/receipt or a seller their settlement (the latter is a 501).
- No CSV export → finance cannot pull data without DB access.

### Missing functionality
- Admin financial console UI: payments list with refund (full/partial), mark-paid, payout list with release/hold, and document resend buttons.
- Resend invoice / receipt / settlement.
- Tax-collected view (after Section E).
- CSV export of payments/payouts/auctions.

### Recommended fixes
1. Build an admin "Payments & Payouts" UI over the existing endpoints (refund, mark-paid, view payouts) — highest leverage, mostly front-end over endpoints that already exist.
2. Implement the 501 settlement endpoint + a resend button.
3. Add invoice/receipt resend endpoints + buttons.
4. Add CSV export.

### Estimated effort
- Admin Payments/Payouts UI over existing APIs: **M**.
- Settlement endpoint + resends: **S–M**.
- CSV export: **S**.

### Launch blockers
- **An operator refund + payout UI is effectively a LIVE-charge blocker** — you cannot run real-money support through hand-built API calls. (The capability exists; only the UI is missing, so this is achievable quickly.)

### Nice-to-haves
- Bulk operations, saved finance exports, role-scoped finance admin.

---

## Consolidated Launch Blockers

Ordered by severity for enabling **Stripe LIVE / real buyer charges**:

1. **Sales tax collection + exemption handling (Section E)** — hard legal/compliance blocker. Currently 0% built.
2. **Buyer payment receipt / confirmation email (Section B)** — charging real cards with no receipt is unacceptable.
3. **Line-itemized, tax-bearing invoice (Section A)** — prerequisite for billing tax/premium and for receipts.
4. **Refund- and dispute-aware seller payout (Sections C & F)** — prevents paying sellers money that was refunded/charged back.
5. **Chargeback / dispute webhook handling (Section C)** — real money = real disputes; currently unhandled.
6. **Operator refund/payout UI (Section H)** — support cannot run on hand-built API calls. (Endpoints exist; UI is the gap — fast.)
7. **Working settlement-document delivery (Section F)** — the send-final-report endpoint is a 501 stub.
8. **Stripe fee capture + basic reconciliation (Section G)** — strongly recommended; owner/finance to confirm hard-gate vs. fast-follow.
9. **Sub-$1 card verification (Section C)** — business-rule compliance; confirm launch-gating with product.

**Explicitly NOT a blocker to activate now:** Buyer premium (Section D) — directive is *do not activate*; it belongs to the Phase-2 / Buyer-Terms-v2 / Stripe-LIVE milestone.

## Nice-to-Haves (post-launch)
- Consolidated multi-lot invoice + single charge per buyer-per-auction.
- Automated Stripe Connect seller payouts + 14-day schedule.
- GL/accounting export (QuickBooks/Xero), payment-variance alerting.
- Card-management + registration/welcome emails; pickup reminders.

---

## Appendix — Key Source References
- Invoices: `src/services/invoiceService.js`, `src/routes/invoices.js`, `db/migrations/029_create_invoices.sql`
- Emails: `src/services/emailService.js`, `src/lib/notificationContent.js`, `src/workers/notificationWorker.js`, `src/services/notificationService.js` (legacy mock)
- Payments: `src/services/paymentService.js`, `src/services/cardService.js`, `src/services/cardVerificationService.js`, migrations 004/059/063
- Buyer premium: `src/services/billingTermsService.js`, migrations 067/069
- Tax: *(none in code)* — `docs/projects/tax-exemption-reseller-certificate-plan.md`
- Settlement: `src/services/reportingService.js`, `src/services/payoutService.js`, `src/services/payoutPreferenceService.js`, `src/services/pdfGenerationService.js`, migrations 015/016
- Reconciliation/audit: `db/migrations/013_create_audit_log.sql`, `src/routes/admin.js` (audit-log, payouts, payments, refund endpoints)
- Operator UI: `public/admin/*.html`

> No code, schema, or production state was modified in producing this audit.
