# Professional Storefront: sale notifications, inventory numbers, bulk import, settlement, tax and seller compliance

Owner requirements of 2026-10-16. Planning document: **nothing here moves money, files tax forms, remits tax or contacts a
government agency**. It records what exists today, the gaps, the proposed database and security architecture,
milestones with acceptance tests, and the decisions that need the owner (and, where stated, qualified tax/legal review).
Canonical TODO: `professional-storefront-roadmap.md` §8.

## 1. What exists today (reviewed in code, 2026-10-16)

| Area | Exists | Gap |
|---|---|---|
| Paid-sale seller email | `marketplaceOrderNotifier.sendPaid` emails the owner "Item sold" only after the order is **paid** (once per paid transition), with title, price, order number, pickup/shipping, buyer contact for fulfilment, proceeds and a link to Marketplace Orders. | Sent inline after the webhook commit, best-effort: a failed send is **not retried** and leaves no delivery record; owner email only (no company address or fulfilment staff); no thumbnail, description, inventory number or "next action"; no seller notification preferences. |
| Notification queue | `notifications_queue` (migrations 021/065): lease, retry back-off, skipped/failed states, worker `notificationWorker.js` — used for auction notifications. | Its `type` CHECK covers auction events only and rows are per **user**; no idempotency key per (order, event, recipient). Reuse the worker pattern; add a storefront outbox (below) rather than a second queue engine. |
| Other storefront notices | Buyer receipt, refund and conflict-refund emails; buyer-issue alerts (owner + neutral seller email). | No seller notices for cancellation, refund, dispute, pickup confirmation, shipping deadline or payout completion. |
| Inventory number / SKU | None (no column). | Needed on items, orders (snapshot), notices, statements and exports; seller-scoped uniqueness. |
| Bulk import | None for storefront items (CSV tools exist only for events/prospects). | Whole feature (§4). |
| Auction settlement | `settlementEngine` (computed settlement, adjustments, review, disputes count, Stripe fee capture, `paySellerViaTransfer` gated by Connect + settlements flags), `seller_payouts`, seller settlements pages. | Built for auctions; not used for storefront orders. |
| Storefront settlement | Orders carry item price, shipping, tax, 11% fee, proceeds, refund amounts, `payout_eligible`, `payout_hold`, append-only order history (197). | No ledger, no payout batches, no statements, no reconciliation to Stripe balance transactions, no exports. |
| Sales tax | Stripe Tax calculation per order and `recordTransaction` on payment; reversal on refunds; `tax_cents` and Stripe tax ids on the order. | No record of **who remits** per transaction/jurisdiction; no jurisdiction breakdown stored; no tax reports. |
| Seller identity / compliance | `seller_identity` (legal/company name, signatory, city/state, phone, `payout_info_ref`; `ein` and `dba_name` added in 107); payout profile (check address or Stripe-tokenised ACH reference, `tax_status`); seller document uploads (verification). | **`seller_identity.ein` is stored as plain text** (masked only in responses) — must move to encrypted storage or a Stripe-verified reference with last-4 only. No entity type, operating states, tax registrations, licences, expirations, reminders or access logging. |
| Followers | `seller_followers` + authorised follower email campaigns (auctions). | Storefront "new items" follower notices not yet planned in detail (§8.9 roadmap). |

## 2. Proposed architecture

### 2.1 Storefront notification outbox (migration, before live checkout)
- `storefront_notifications` — one row per (order, event, recipient): `id, seller_id, order_id, event` (`sale_paid`,
  `order_cancelled`, `refund`, `dispute`, `pickup_confirmed`, `shipping_due`, `payout_sent`), `recipient_user_id` or
  `recipient_email`, `status` (pending/processing/sent/failed/skipped), attempts, `next_attempt_at`, `locked_at`,
  `last_error`, `sent_at`, `provider_message_id`. **UNIQUE (order_id, event, recipient)** = idempotency.
  Composite FK (order_id, seller_id) → marketplace_orders, so a notice can only ever concern its own seller's order.
- Enqueued **inside the same transaction that marks the order paid** (never on checkout start or pending payment), so a
  paid order always has its notices queued and an unpaid one never does.
- A worker (same lease/back-off pattern as `notificationWorker.js`) renders from the order **snapshot** + current item
  thumbnail, sends, records the outcome; repeated failures alert the owner (owner-alert service).
- Recipients: the company notification address (new `seller_profiles.notification_email`, verified) and active staff with
  `company.orders.fulfil` who opted in (`seller_staff_members` + per-member preference). Never another company's people.
- Content: title, description excerpt, inventory number, thumbnail (if any), confirmed sale price, order number,
  shipping/pickup, required next action, secure link, "estimated proceeds" labelled as an estimate. **No buyer contact
  details or ship-to address in any sale email** (owner, 2026-10-16) — fulfilment details only inside the authenticated,
  role-shaped seller dashboard; never payment data. (Already applied to the existing email: `marketplaceOrderNotifier`.)

### 2.2 Inventory numbers (migration; small)
- `marketplace_items.inventory_number TEXT` (≤ 64 chars, trimmed), searchable in the seller dashboard.
- Uniqueness **per seller** among live items: partial UNIQUE (seller_id, lower(inventory_number)) WHERE status IN
  ('draft','active','pending_purchase'); sold/removed items keep theirs (history), and two sellers may use the same number.
- Copied into the order snapshot (immutable), notices, statements and exports.

### 2.3 Bulk import (migrations; major deliverable)
- `inventory_import_jobs` (seller_id, created_by, source `csv|xlsx|shopify|etsy`, mapping JSON, mode `create|update|
  create_or_update`, status, counts, progress, resumable cursor, error report file) and `inventory_import_rows`
  (job_id, row number, parsed values, action, result, error, created/updated item id). Composite keys tie rows and created
  items to the job's seller.
- Pipeline: upload → column mapping (saved presets; Shopify/Etsy presets) → **dry run** (validation, duplicate detection
  by inventory number / source id / title+price, create-vs-update plan, GTIN check-digit, shipping completeness) →
  seller confirms → background run in batches (resumable) → completion report + downloadable error file.
- Imported items are **drafts**; shipping **off** unless the row carries complete shipping terms and the seller confirmed
  them; nothing publishes until the seller reviews. Updates only ever match the job seller's own items.
- Images: URLs fetched by a worker with size/type limits, stored through the existing upload service (never hot-linked),
  per-image provenance; only http(s), no private networks (SSRF guard).

### 2.4 Storefront ledger, payouts and statements (Milestone 3; migrations; transfers OFF)
- `storefront_ledger_entries` — append-only, double-entry style, integer cents, one currency: `id, seller_id, order_id,
  entry_type` (`sale_item`, `shipping_collected`, `tax_collected`, `platform_fee`, `refund_item`, `refund_shipping`,
  `refund_tax`, `fee_reversal`, `chargeback`, `chargeback_reversal`, `adjustment`, `tax_remitted_by_marketplace`,
  `payout_hold`, `payout_release`, `payout_transfer`), `amount_cents` (signed), `account` (`seller_payable`,
  `platform_revenue`, `tax_liability`, `held`, `transferred`), `stripe_object_id`, `created_at`, `created_by`, `reason`.
  Never updated or deleted (trigger); corrections are new reversing entries with a reason (no silent retroactive change).
  Composite FK (order_id, seller_id).
- `storefront_payout_batches` (seller, payout date, status, totals, destination account reference verified at batch time,
  Stripe transfer id, reconciliation status) and `storefront_payout_lines` (UNIQUE order_id — an order is paid once).
- Seller statement = a read model over the ledger per sale and per payout: gross item price, shipping collected, sales
  tax collected (and who remits it), 11% fee on item price, refunds/partial refunds, chargebacks, adjustments, held,
  eligible, actually transferred, payout date, Stripe reference, reconciliation status. CSV/spreadsheet export.
- **Sales tax is never assumed to belong in seller deposits**: tax collected posts to `tax_liability` and moves to the
  seller only where the seller is the verified remitting party for that transaction and jurisdiction.
- Daily and per-batch reconciliation: Stripe balance transactions ↔ ledger ↔ orders ↔ transfers, to the cent; any
  difference stops the batch and alerts the owner.

### 2.5 Tax responsibility (needs qualified review before checkout/payouts)
- Per order, store `tax_remitting_party` (`marketplace_facilitator` | `seller` | `undetermined`), jurisdiction details
  from Stripe Tax (the calculation's jurisdiction breakdown), and the rule/version that decided it.
- A `tax_responsibility_rules` table (jurisdiction, effective dates, remitting party, source/citation, reviewed_by,
  reviewed_at) maintained by an administrator **after** tax/legal review. Until a rule is verified the party is
  `undetermined`, which blocks payout of the tax portion (held), never guesses.
- No change to live Stripe Tax or payment configuration without owner authorisation; no filing or remittance by the system.

### 2.6 Seller legal and compliance profile (migration; restricted)
- `seller_compliance_profiles` (one per seller): legal name, DBA, entity type, business address, operating states,
  seller category (auction business, antique shop, estate sale company, sole proprietor, other), verification status,
  review dates. `seller_registrations` (type: state tax permit, auctioneer licence, business licence, other; issuing
  state; number **encrypted**; expiry; document id; verification status; reminder dates).
- Taxpayer id: prefer Stripe Connect's verified taxpayer status and a tokenised reference; if Advantage.Bid must hold a
  TIN, store it encrypted (application-level envelope encryption with a key outside the database), keep only last-4 in
  clear, and log every decrypt. Migrate the existing plain-text `seller_identity.ein` the same way.
- Access: a new platform permission (e.g. `compliance.view` / `compliance.manage`), every read logged; never exposed on
  public pages, SEO, widgets, feeds or ordinary seller emails. Retention and deletion policy to be confirmed.
- Requirements by category and state are **data**, confirmed by the owner/legal review — no universal EIN or licence rule.

### 2.7 Tax-time and financial reports (admin, on request)
- Generated on demand for a tax year / seller / state / jurisdiction / period from the ledger and orders: gross sales and
  counts, refunds/chargebacks/adjustments, platform fee revenue, shipping collected, tax collected by jurisdiction, tax
  remitted by verified party, payouts, balances and holds, seller verification status, information-return data.
- Validation and exception report (e.g. unreconciled items, undetermined tax party, missing seller tax status), audit log
  of who generated what, CSV/spreadsheet downloads. **No automatic filing, remittance or submission.**
- Information returns (e.g. Form 1099-K): who is the filer depends on the payment settlement entity arrangement (likely
  Stripe for Connect accounts) — to be confirmed by tax review before any filing feature is built.

## 3. Milestones and acceptance tests

| # | Milestone | Acceptance tests (automated unless stated) |
|---|---|---|
| N1 | Storefront notification outbox + paid-sale seller email (before live checkout) | notice queued only in the paid transaction (none for started/pending/failed checkout); exactly one per (order, event, recipient) under webhook replays and worker crashes; retries with back-off then owner alert; recipients only the order's own company (address + opted-in fulfilment staff); no payment data; buyer contact only to fulfil role; content includes inventory number + thumbnail when present; delivery audit row. |
| N2 | Inventory numbers | per-seller uniqueness among live items; two sellers may share a number; searchable; copied into order snapshot, notices, exports; preserved through edits, sale, refund. |
| P1–P3 | Seller policies, tabs, snapshots (roadmap §7.2–7.4) | as in §7.8. |
| M3a | Storefront ledger + statements (transfers OFF) | append-only; corrections only as reversing entries; every order's entries sum to its money columns; fee = 11% of item price only; tax never in seller payable unless seller is verified remitter; refunds/partials/chargebacks post correctly; seller sees only own statements; CSV export matches. |
| M3b | Payout batches + reconciliation (transfers OFF until approved) | one payout line per order; holds respected; batch totals = ledger; reconciliation to Stripe test-mode balance transactions to the cent; mismatch stops batch + alerts. |
| T1 | Tax responsibility model | undetermined party holds tax portion; rules require reviewer + citation; per-order party recorded immutably. |
| C1 | Compliance profile | encrypted numbers, last-4 only in clear; every read logged; never in public/widget/SEO/feeds; category-specific required fields are configurable data; expiry reminders. Includes migrating plain-text EIN. |
| R1 | Tax-time reports | totals reconcile to ledger; exception report; audit log; exports; no filing code path. |
| I1 | Bulk import | drafts only; shipping off unless complete + confirmed; dry run changes nothing; duplicates detected; updates only own items; resumable; error report; image fetch SSRF-safe; never another seller's records. |

## 4. Decisions for the owner (and qualified review)
1. **Sales tax remitting party** by state for storefront sales (marketplace facilitator vs seller) — needs tax/legal review; until then tax portions are held, never paid out.
2. **Information returns (1099-K)** — confirm the filer (Stripe as payment settlement entity for Connect accounts vs Advantage.Bid) before any reporting feature beyond exports.
3. **Taxpayer id handling** — rely on Stripe Connect verification (recommended) or hold encrypted TINs; approve migrating the existing plain-text EIN field.
4. **Compliance requirements by seller category and state** (licences, permits) — which are required, which optional.
5. **Retention/deletion** periods for compliance documents and financial records.
6. **Seller notification address** — use the company owner's email by default with an optional verified company address (recommended), and staff opt-in.
7. **"Estimated proceeds" in the sale email** — include (labelled estimate) or omit until the ledger exists.
8. Milestone 3 settlement decisions already pending (3-day hold, Thursday payouts/Wednesday cutoff, pickup confirmation, partial-refund fee, refunds after payout, carrier tracking, Connect account type).
