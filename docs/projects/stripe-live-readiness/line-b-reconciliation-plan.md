# Line B Financial-Integrity Reconciliation Plan
**Project:** Stripe LIVE Readiness · **Type:** implementation plan (planning only — no code/migration/deploy/commit).
**Date:** 2026-06-10 · **Production:** `e0f005f` (origin/main), Stripe TEST.

> Goal: land the missing Line B financial-integrity work onto the production line, reconciling the two absent commits (`b33d720`, `f03809b`) plus two net-new items (payout wiring, payout audit) the commits do not contain.

---

## 0. Source material & key constraint
- `b33d720` "settlement integrity hardening — webhook claim-after-process" (migration `046_extend_stripe_webhook_events`, `paymentService.js +419`, `payments.js`, `tests/webhook-state-machine.test.js`).
- `f03809b` "refund integrity + orphan PaymentIntent hardening" (migration `047_add_payments_refunded_amount`, `paymentService.js +504`, `server.js +36`, `admin.js`, `payments.js`, refund/orphan tests, `docs/sop-refunds.md`).
- **Hard constraint — staging-hook coupling:** `f03809b`'s `paymentService.js` `require`s `./stagingValidationHooks` (line 10) and calls it (lines 903, 925). That module is added by the **intentionally-excluded** commits `2fd8814`/`f1a589b`. **All `stagingValidationHooks` references must be stripped during reconciliation** (or the app will crash on `require`). These hooks are synthetic webhook failure/delay injectors for staging only.
- **Migration-number collision:** Line B's `046`/`047` collide with production-applied `046_add_users_is_active` / `047_add_auction_revision_columns`. Must renumber.

### Outcome → source mapping
| # | Required outcome | Source |
|---|---|---|
| 1 | Webhook claim-after-process integrity | `b33d720` |
| 2 | Extended `stripe_webhook_events` state machine | `b33d720` (migration 046) |
| 3 | Orphan PaymentIntent recovery | `f03809b` (`_handlePaymentIntentSucceeded` reconcile, `_handlePaymentIntentCanceled`, `createPaymentIntent` stale-orphan retirement, `server.js` health metrics) |
| 4 | `refunded_amount_cents` accounting | `f03809b` (migration 047) |
| 5 | Refund crash-window protection | `f03809b` (`_handleChargeRefunded` webhook reconcile to Stripe-authoritative `amount_refunded`) |
| 6 | Refund idempotency | `f03809b` (Idempotency-Key required → forwarded to Stripe; `REFUND_IN_PROGRESS` 409) |
| 7 | Partial refund support | `f03809b` (cumulative `refunded_amount_cents`, "Refund total would exceed" bound) |
| 8 | **Seller payout generation wiring** | **NET-NEW — not in either commit.** Wire `payoutService.createSellerPayoutRecord` into the close flow. |
| 9 | Financial auditability improvements | `f03809b` (health reconciliation surface, webhook `status`/`last_error`/`attempt_count`) **+ net-new** payout audit event when wiring #8 |

---

## A. Exact files requiring modification
**From `b33d720`:**
- `src/services/paymentService.js` — claim-after-process: insert event `status='received'` + `payload`; `_dispatchWebhookEvent` router; mark `processed`/`failed` (+`last_error`,`attempt_count`); `FOR UPDATE` locks.
- `src/routes/payments.js` — webhook handler returns **500 on handler error** (Stripe retries) instead of swallowing 200.
- `tests/webhook-state-machine.test.js` (new).

**From `f03809b`:**
- `src/services/paymentService.js` — `processRefund(…, idempotencyKey)` with cumulative bound + `REFUND_IN_PROGRESS`; `_handleChargeRefunded` (Stripe-authoritative reconcile); `_handlePaymentIntentSucceeded` orphan reconcile; `_handlePaymentIntentCanceled`; `createPaymentIntent(…, idempotencyKey)` two-phase with stale-orphan retirement. **STRIP** the `stagingValidationHooks` require + 2 call sites.
- `src/routes/admin.js` — `POST /api/admin/payments/:paymentId/refund`: add `idempotency` middleware, require `Idempotency-Key`, pass key to `processRefund`, map `REFUND_IN_PROGRESS`→409.
- `src/routes/payments.js` — `charge-lot`: capture `Idempotency-Key`, pass to `createPaymentIntent`.
- `server.js` — `/api/health` reconciliation surface (`last_webhook_received_at`, `last_webhook_processed_at`, `webhook_failed_count_1h`, `payments_orphaned_intent_count`) via `_safeQueryScalar`.
- `tests/refund-integrity.test.js`, `tests/payment-intent-orphan.test.js` (new); `docs/sop-refunds.md` (refund SOP + partial-refund reconciliation).

**NET-NEW (outcomes 8/9, not in commits):**
- `src/services/auctionService.js` (close path) — invoke `createSellerPayoutRecord(auctionId)` after successful close (idempotent via `seller_payouts UNIQUE(auction_id)`).
- `src/services/payoutService.js` — emit an audit event on payout-record creation.

**EXPLICITLY EXCLUDED (do not port):**
- `src/services/stagingValidationHooks.js`, `tests/staging-validation-hooks.test.js` (commits `2fd8814`/`f1a589b`). Strip all references.
- e2e specs `e2e/admin/admin-refund.spec.js`, `e2e/payments/payment-refund-execution.spec.js` are optional (bring only if the e2e harness is maintained).

## B. Exact migrations required (additive, idempotent)
1. **`db/migrations/058_extend_stripe_webhook_events.sql`** (from `b33d720`'s 046): `ALTER TABLE stripe_webhook_events ADD … status('received'|'processed'|'failed') DEFAULT 'received', payload JSONB, last_error TEXT, attempt_count INT DEFAULT 1, received_at TIMESTAMPTZ DEFAULT now()`; backfill existing rows → `status='processed'`; `CREATE INDEX idx_stripe_webhook_events_status_received`.
2. **`db/migrations/059_add_payments_refunded_amount.sql`** (from `f03809b`'s 047): `ALTER TABLE payments ADD refunded_amount_cents INT NOT NULL DEFAULT 0`; backfill `refunded`→full and `partially_refunded`→full (conservative); `ADD CONSTRAINT chk_refunded_amount_bounded CHECK (0 ≤ refunded_amount_cents ≤ amount_cents)`.

Both are `ADD COLUMN IF NOT EXISTS` / additive and **must run BEFORE** their code is deployed (the new code reads the new columns).

## C. Migration renumbering strategy
- `046_extend_stripe_webhook_events.sql` → **`058_extend_stripe_webhook_events.sql`**
- `047_add_payments_refunded_amount.sql` → **`059_add_payments_refunded_amount.sql`**
- Production `schema_migrations` is keyed by **filename**; highest applied = `057`. `058`/`059` are the next free numbers. No code references migration numbers, so renaming is safe.
- Update each file's internal `-- Migration: 0XX_…` header comment to match the new name. Preserve the deployment-order and rollback notes.
- Verify (read-only) before applying that prod does **not** already contain these objects (`stripe_webhook_events.status`, `payments.refunded_amount_cents`) — confirmed absent in the launch-gate audit.

## D. Expected merge conflicts
| File | Likelihood | Cause & resolution |
|---|---|---|
| `src/services/paymentService.js` (from `f03809b`) | **HIGH** | `f03809b` was authored on top of the skipped `2fd8814` (staging hooks). Cherry-picking it onto prod+`b33d720` conflicts around the `stagingValidationHooks` require/call sites. **Resolve by deleting those 3 references** and keeping the integrity logic. |
| `src/services/paymentService.js` (from `b33d720`) | **NONE** | `b33d720` is authored directly on the `51dc8c9` baseline; production `paymentService.js` is the unchanged baseline (Line A never touched it) → applies cleanly. |
| `src/routes/admin.js` (`f03809b`) | **MEDIUM** | Production `admin.js` has heavy Line A additions → context shift around the refund endpoint. The refund hunk likely applies with fuzz; **re-apply the idempotency change manually** if it rejects. |
| `server.js` (`f03809b`) | **LOW–MEDIUM** | Line A may have changed `server.js` (route mounts). The `/api/health` reconciliation block is self-contained; place it in the current health handler. |
| `src/routes/payments.js` (both) | **LOW** | Line A did not touch `payments.js`; `b33d720` then `f03809b` apply in order. |
| `db/migrations/058`,`059` | **NONE** (rename only) | New files; no content conflict. |
| tests (new files) | **NONE / adjust** | New files apply; but ported tests may `require('stagingValidationHooks')` or its injectors — **adjust those tests** to the stripped surface or exclude. |

## E. Recommended implementation sequence
> Primary: **cherry-pick `b33d720` (clean) → resolve-pick `f03809b` (strip staging hooks)**. Fallback: **re-author** `f03809b`'s production changes from the diff if conflicts are messy (highest control, avoids staging hooks entirely).

1. Branch `feat/line-b-financial-integrity` off `e0f005f`.
2. **Migrations:** add `058`/`059` (renamed copies of Line B's 046/047), update header comments.
3. **Land `b33d720`:** `git cherry-pick -x b33d720` → expect clean. Verify `paymentService.js` claim-after-process + `payments.js` 500-retry.
4. **Land `f03809b`:** `git cherry-pick -x f03809b` → resolve conflicts by **deleting all `stagingValidationHooks` references** (require + 2 call sites) and reconciling `admin.js`/`server.js`. (If conflicts are extensive, re-author from `git show f03809b` instead.)
5. **Strip-verify:** `grep -r stagingValidationHooks src/` returns nothing; `node --check` all changed files; ensure `stagingValidationHooks.js` is **not** present.
6. **Net-new outcome 8/9:** wire `createSellerPayoutRecord` into `auctionService` close (idempotent) + add payout audit event.
7. **Tests:** adjust ported tests to the stripped surface; `npx jest` green (allow the pre-existing `bid.test.js` failures).
8. **Self-review** against outcomes 1–9; then staging (§F).

## F. Staging validation plan (Stripe TEST)
**Pre-migration check (both staging & prod):** `SELECT COUNT(*) FROM payments WHERE status='partially_refunded';` — if > 0, plan a Stripe `amount_refunded` reconciliation pass (059's backfill conservatively marks them fully refunded). Document affected rows.
**Apply** `058` then `059` to staging (`ep-royal-dawn-anarou3f`, direct endpoint, prod-guarded fail-fast script pattern) **before** deploying the code. Deploy branch to staging.
**Scenarios:**
- **Claim-after-process (1/2):** inject a handler failure → event row → `status='failed'` + `last_error`; Stripe redelivery → reprocesses → `status='processed'`. Confirm no lost settlement. (Use the staging hooks **only on staging** if you keep a staging-only injector, or simulate via a test stub — not in prod code.)
- **Webhook replay/idempotency:** redeliver a processed event → deduped; `attempt_count` behavior correct.
- **Refund accounting (4/7):** full refund → `refunded_amount_cents=amount`; sequential partials sum correctly; **over-refund rejected** ("Refund total would exceed").
- **Refund idempotency (6):** same `Idempotency-Key` → single Stripe refund; concurrent → `REFUND_IN_PROGRESS` 409.
- **Refund crash-window (5):** `charge.refunded` webhook reconciles DB to Stripe-authoritative `amount_refunded`; echo of own refund is a no-op.
- **Orphan recovery (3):** `payment_intent.succeeded` with no DB row → reconcile; `payment_intent.canceled` → `pending`→`failed`; `createPaymentIntent` retires stale-orphaned pending; `/api/health` shows `payments_orphaned_intent_count`.
- **Payout wiring (8/9):** close a test auction → `seller_payouts` row created once (idempotent on re-close); payout audit event present.
- **Health (9):** `/api/health` reconciliation fields populate.
Run unit suites (`webhook-state-machine`, `refund-integrity`, `payment-intent-orphan`). Gate: all green + scenarios pass.

## G. Production promotion plan
1. **Neon backup branch** `prod-pre-lineb-<date>` from production.
2. **Pre-migration operator check** on prod: partially_refunded count (per §F); reconcile/ document before applying.
3. **Apply migrations** `058` then `059` to prod via a targeted, prod-endpoint-guarded, **direct-endpoint**, fail-fast script (pattern: `scripts/promote-046-057.js`) — **before** code deploy (migration headers require this).
4. **Verify** new columns/constraint/index exist (read-only).
5. **Merge** `feat/line-b-financial-integrity` → `origin/main` (FF or reviewed PR; promote via `origin/main`, never local `main`).
6. **Deploy** (prod auto-deploys `main`); confirm `e0f005f`→new commit `SUCCESS`, workers boot, `/api/health` green incl. reconciliation fields.
7. **Validate** in prod TEST mode (smoke: a refund idempotency check, a close→payout record, health metrics). **Stripe stays TEST.**
8. **Separate, later step:** Stripe LIVE cutover (LIVE keys + LIVE webhook + re-validate <$1 card verification) per `docs/stripe-live-cutover-prerequisites.md`.

## H. Rollback plan
- **Code:** Railway redeploy previous (`e0f005f`); or `git revert -m 1 <merge>` on `origin/main`. Old code ignores the new columns (additive) → safe to run against the migrated DB.
- **Migrations (additive, documented in each file):**
  - `059`: `ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_refunded_amount_bounded;` then `DROP COLUMN IF EXISTS refunded_amount_cents;`
  - `058`: `DROP INDEX IF EXISTS idx_stripe_webhook_events_status_received;` then `DROP COLUMN` for `status,payload,last_error,attempt_count,received_at`.
- **Data caveat:** `059`'s backfill marks `partially_refunded` rows as **fully refunded** (blocks further refunds). This is **not auto-reversible** — recovering true partial state needs a Stripe `amount_refunded` round-trip (see `docs/sop-refunds.md`). Capture the affected rows **before** applying.
- **Deepest:** restore the Neon backup branch (PITR to pre-migration timestamp).
- **Order on rollback:** revert code first (so it stops reading new columns), then optionally drop columns; or simply leave the additive columns in place (harmless) and only roll back code.

---

## Risks & notes
- **Staging-hook coupling is the #1 reconciliation hazard** — verify zero `stagingValidationHooks` references before deploy; the app crashes on a stray `require`.
- **`admin.js` divergence** (Line A) is the most likely manual-merge spot.
- **Outcomes 8 (payout wiring) and part of 9 (payout audit) are net-new** — they are not in `b33d720`/`f03809b`; scope and review them as fresh work, and ensure idempotency via the existing `seller_payouts UNIQUE(auction_id)`.
- The marketing-fee deduction work (`docs/planning/marketing-fee-settlement-integration.md`) should layer **after** this lands (it depends on the same settlement surface).
- This plan changes nothing; it is the blueprint for a separate implementation phase. Apply migrations before code, validate on staging in TEST, and keep Stripe in TEST until LIVE cutover is separately executed.

*Evidence: `git show b33d720 f03809b` (migrations, `paymentService.js`, `payments.js`, `admin.js`, `server.js`); production `e0f005f` payment surface; ancestry checks vs `e0f005f`. Related: `docs/stripe-live-cutover-prerequisites.md`, launch-gate financial audit, `docs/planning/marketing-fee-settlement-integration.md`.*
