# Phase 1 — Implementation Checklist (Line B Reconciliation)
**Project:** Stripe LIVE Readiness · **Type:** execution checklist (preparation only — nothing run yet).
**Date:** 2026-06-10 · **Base:** production `e0f005f` (origin/main), Stripe TEST.

**Phase 1 scope (exactly four items):** reconcile `b33d720`; reconcile `f03809b`; remove `stagingValidationHooks` dependencies; renumber migrations `046/047 → 058/059`.
**Out of scope for Phase 1:** payout wiring (outcome 8), payout audit (part of 9), marketing-fee work — later phases.

> Conflict map is **verified** via read-only `git apply --check` against `e0f005f`:
> `b33d720` paymentService.js + payments.js → **CLEAN**; `f03809b` admin.js + server.js + payments.js → **CLEAN**; **`f03809b` paymentService.js → CONFLICT** (staging-hook coupling, ~line 672). This is the only expected conflict.

---

## 1. Exact cherry-pick strategy
Use **`git cherry-pick -n` (no-commit)** so migrations can be renumbered and staging hooks stripped **before** committing — producing clean, reviewed commits.

```bash
# Pre-flight (read-only)
git fetch origin
git rev-parse origin/main                       # expect e0f005f...
git status --short                              # ensure a clean tree (stash unrelated edits if needed)

# Step 1 — feature branch off production
git checkout -b feat/line-b-financial-integrity e0f005f

# Step 2 — reconcile b33d720 (CLEAN), staged but not committed
git cherry-pick -n b33d720
#   brings: src/services/paymentService.js, src/routes/payments.js,
#           db/migrations/046_extend_stripe_webhook_events.sql, tests/webhook-state-machine.test.js
git mv db/migrations/046_extend_stripe_webhook_events.sql db/migrations/058_extend_stripe_webhook_events.sql
#   edit header line in the file: "-- Migration: 046_..." -> "058_..."
git add -A
git commit -m "feat(payments): webhook claim-after-process integrity (reconcile b33d720); migration 046->058"

# Step 3 — reconcile f03809b (CONFLICT in paymentService.js only)
git cherry-pick -n f03809b
#   CLEAN: src/routes/admin.js, server.js, src/routes/payments.js,
#          db/migrations/047_add_payments_refunded_amount.sql, tests/*, docs/sop-refunds.md
#   CONFLICT: src/services/paymentService.js  (resolve per Section 3)
#   -> resolve the paymentService.js conflict by STRIPPING the 3 stagingValidationHooks references
git mv db/migrations/047_add_payments_refunded_amount.sql db/migrations/059_add_payments_refunded_amount.sql
#   edit header line: "-- Migration: 047_..." -> "059_..."
#   strip-verify (see Section 2/3)
git add -A
git commit -m "feat(payments): refund integrity + orphan recovery (reconcile f03809b, staging hooks stripped); migration 047->059"
```

Notes:
- `-n` means cherry-pick does **not** auto-commit; on the `f03809b` conflict it stages what applied and leaves conflict markers in `paymentService.js` to resolve before the manual commit.
- Do **not** cherry-pick `2fd8814` or `f1a589b` (staging hooks) — that is the whole point of "remove stagingValidationHooks dependencies."
- Migrations are renamed **before committing** so the repo never carries two `046_*`/`047_*` files in a committed state.

## 2. Exact files to modify
**Cherry-pick brings (verify each):**
| File | Source | Action |
|---|---|---|
| `src/services/paymentService.js` | b33d720 + f03809b | Apply integrity logic; **strip 3 staging-hook refs** (Section 3) |
| `src/routes/payments.js` | b33d720 (webhook 500-retry) + f03809b (charge idempotency-key passthrough) | Keep as cherry-picked (CLEAN) |
| `src/routes/admin.js` | f03809b (refund endpoint: idempotency middleware + key) | Keep as cherry-picked (CLEAN) |
| `server.js` | f03809b (`/api/health` reconciliation surface) | Keep as cherry-picked (CLEAN) |
| `db/migrations/046_extend_stripe_webhook_events.sql` | b33d720 | **Rename → `058_…`**, update header |
| `db/migrations/047_add_payments_refunded_amount.sql` | f03809b | **Rename → `059_…`**, update header |
| `tests/webhook-state-machine.test.js` | b33d720 | Keep |
| `tests/refund-integrity.test.js`, `tests/payment-intent-orphan.test.js` | f03809b | Keep; **adjust any `stagingValidationHooks` import** to the stripped surface |
| `docs/sop-refunds.md` | f03809b | Keep (refund SOP incl. partial-refund reconciliation) |

**Manually edited to strip staging hooks — `src/services/paymentService.js`, remove exactly:**
- `const stagingValidationHooks = require('./stagingValidationHooks');`  (≈ line 10 in f03809b's version)
- `await stagingValidationHooks.maybeDelayDispatch(event.id);`  (≈ line 903)
- `stagingValidationHooks.maybeThrowSyntheticWebhookFailure(intent && intent.id);`  (≈ line 925)

**Must NOT appear in the result (do not create/port):**
- `src/services/stagingValidationHooks.js`
- `tests/staging-validation-hooks.test.js`

**Strip-verify command (must return nothing):**
```bash
grep -rn "stagingValidationHooks" src/ tests/        # expect: no output
test -f src/services/stagingValidationHooks.js && echo "ERROR present" || echo "absent (good)"
node --check src/services/paymentService.js && node --check src/routes/payments.js \
  && node --check src/routes/admin.js && node --check server.js
```

## 3. Exact conflicts expected
| File | Predicted (verified by `git apply --check`) | Resolution |
|---|---|---|
| `src/services/paymentService.js` (f03809b) | **CONFLICT** — patch fails ~line 672; root cause = the skipped `2fd8814` staging-hook lines that f03809b's context expects | In the conflict region, **take the f03809b side but delete the 3 `stagingValidationHooks` lines** (require + `maybeDelayDispatch` + `maybeThrowSyntheticWebhookFailure`). Keep `_dispatchWebhookEvent`, `_handlePaymentIntentSucceeded/Failed/Canceled`, `_handleChargeRefunded`, claim-after-process, and refund accounting intact. |
| `src/services/paymentService.js` (b33d720) | **CLEAN** | none |
| `src/routes/payments.js` (b33d720, f03809b) | **CLEAN** | none |
| `src/routes/admin.js` (f03809b) | **CLEAN** | none (better than earlier estimate) |
| `server.js` (f03809b) | **CLEAN** | none |
| `db/migrations/058`, `059` | new files (rename) | no content conflict — just `git mv` + header edit |
| `tests/refund-integrity.test.js`, `payment-intent-orphan.test.js` | apply clean, but may **reference staging hooks at runtime** | adjust those test hooks to the stripped surface, or mark the injection cases skipped |

After resolution, run the unit suites (`webhook-state-machine`, `refund-integrity`, `payment-intent-orphan`); the only acceptable red is the pre-existing unrelated `bid.test.js`.

## 4. Exact staging validation sequence
Staging DB endpoint `ep-royal-dawn-anarou3f`; **migrations BEFORE code** (both migration headers require this).

```bash
# 4a. Pre-migration operator check (BOTH staging and, later, prod)
#     059's backfill marks partially_refunded rows as FULLY refunded.
railway run --service advantage-staging --environment production node -e "require('./src/db').query(\"SELECT count(*)::int n FROM payments WHERE status='partially_refunded'\").then(r=>{console.log('partially_refunded:',r.rows[0].n);process.exit(0)})"
#     If > 0: document those rows + plan a Stripe amount_refunded reconciliation before applying 059.

# 4b. Apply 058 then 059 to staging (targeted, endpoint-guarded, DIRECT endpoint, fail-fast)
#     Use a scripts/promote-058-059.js modeled on scripts/promote-046-057.js, guarded to ep-royal-dawn-anarou3f.
railway run --service advantage-staging --environment production node scripts/promote-058-059.js   # expect: Applied 2

# 4c. Verify schema (read-only)
#     stripe_webhook_events has status/payload/last_error/attempt_count/received_at + index
#     payments has refunded_amount_cents + chk_refunded_amount_bounded

# 4d. Deploy branch to staging (push feat/line-b-financial-integrity to the staging-tracked branch or trigger a staging deploy), watch SUCCESS.
```

**Functional scenarios (Stripe TEST):**
- [ ] **Claim-after-process (1/2):** force a handler error → event row `status='failed'` + `last_error`; redeliver → reprocesses → `status='processed'`; no lost settlement. (Use a **staging-only** injector or a test stub — NOT prod code.)
- [ ] **Replay/idempotency:** redeliver a processed event → deduped; `attempt_count` correct.
- [ ] **Refund accounting (4/7):** full refund → `refunded_amount_cents = amount`; sequential partials sum; over-refund → "Refund total would exceed".
- [ ] **Refund idempotency (6):** same `Idempotency-Key` → one Stripe refund; concurrent → `REFUND_IN_PROGRESS` (409).
- [ ] **Crash-window reconcile (5):** `charge.refunded` webhook reconciles DB to Stripe `amount_refunded`; echo of own refund = no-op.
- [ ] **Orphan recovery (3):** `payment_intent.succeeded` with no DB row → reconcile; `payment_intent.canceled` → `pending`→`failed`; `createPaymentIntent` retires stale-orphaned pending; `/api/health.payments_orphaned_intent_count` populated.
- [ ] **Health (9):** `/api/health` reconciliation fields populate.
- [ ] **No staging-hook leakage:** `grep -rn stagingValidationHooks src/` empty; app boots without the module.

**Gate:** all scenarios pass + unit suites green → proceed to a separate production-promotion phase (not Phase 1).

## 5. Exact rollback sequence
**During implementation (branch-level — nothing deployed):**
```bash
# Abort a mid-cherry-pick
git cherry-pick --abort
# Discard the whole branch attempt
git checkout deploy/seller-studio-1b   # or your working branch
git branch -D feat/line-b-financial-integrity
# Production is untouched (origin/main stays e0f005f); no rollback needed there.
```

**If validated on staging then needs reverting (staging only):**
```bash
# Code: redeploy the prior staging commit (Railway → advantage-staging → previous SUCCESS deployment).
# Migrations (additive; drop CONSTRAINT before COLUMN):
#   059: ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_refunded_amount_bounded;
#        ALTER TABLE payments DROP COLUMN IF EXISTS refunded_amount_cents;
#   058: DROP INDEX IF EXISTS idx_stripe_webhook_events_status_received;
#        ALTER TABLE stripe_webhook_events
#          DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS payload,
#          DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS attempt_count,
#          DROP COLUMN IF EXISTS received_at;
```
**Caveats:**
- `059`'s backfill (partially_refunded → fully refunded) is **not auto-reversible** — restoring true partial state requires a Stripe `amount_refunded` round-trip (`docs/sop-refunds.md`). **Snapshot affected rows before 4b.**
- Old code tolerates the new columns (additive), so usually only a **code** rollback is needed; dropping columns is optional.
- Take a Neon staging branch snapshot before 4b for a clean restore point.

---

## Execution order summary (tick as you go)
- [ ] Pre-flight: clean tree, `origin/main == e0f005f`.
- [ ] Branch `feat/line-b-financial-integrity` off `e0f005f`.
- [ ] `cherry-pick -n b33d720` (clean) → rename `046→058` + header → commit.
- [ ] `cherry-pick -n f03809b` → resolve `paymentService.js` (strip 3 hook refs) → rename `047→059` + header → commit.
- [ ] Strip-verify (`grep stagingValidationHooks` empty; `node --check` all 4 files).
- [ ] Adjust ported tests off the staging-hook surface; run unit suites.
- [ ] Staging: partially_refunded pre-check → apply `058/059` → verify schema → deploy → run all scenarios.
- [ ] Gate pass → hand off to production-promotion phase (separate).

*Nothing has been run. No code, migration, deployment, or commit performed. Conflict map verified read-only via `git apply --check`. References: `docs/projects/stripe-live-readiness/line-b-reconciliation-plan.md`, `docs/stripe-live-cutover-prerequisites.md`.*
