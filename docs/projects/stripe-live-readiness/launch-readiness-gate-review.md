# Launch Readiness Gate Review — Line B Financial Integrity
**Date:** 2026-06-11 · **Reviewer pass:** merge-readiness for `feat/line-b-financial-integrity → deploy/seller-studio-1b`.
**Type:** read-only review. Nothing merged, deployed, migrated, or promoted. This document only maps the exact remaining path from the current state to public launch.

## Reference commits (origin, fetched 2026-06-11)
| Ref | Commit | Notes |
|---|---|---|
| `feat/line-b-financial-integrity` | `e7b7216` | source branch (pushed, in sync) |
| `deploy/seller-studio-1b` | `213a9b8` | merge target → **auto-deploys to staging** |
| `main` (production) | `e0f005f` | prod is healthy, SES validated, Stripe TEST |
| merge-base(feat, deploy) | `e0f005f` | three-way merge (not fast-forward) |

---

## 1. Branch diff summary
- **feat is 6 commits ahead of `e0f005f`:** `f3fbba9` (webhook claim-after-process), `470c544` (refund integrity + orphan recovery), `812db18` (planning/validation docs), `c153356` (guarded staging migration runner), `f441512` (**DEFECT-LINEB-1 fix**), `e7b7216` (retest report).
- **`deploy/seller-studio-1b` is 1 commit ahead of `e0f005f`:** `213a9b8` (docs/operations + pilot/admin planning) — **not** in feat.
- **Merge type:** three-way (both sides diverged at `e0f005f`). A merge commit will be created; feat does not fast-forward the target.
- **Conflict check:** `git merge-tree --write-tree deploy/seller-studio-1b feat` → exit 0, **no CONFLICT markers**. `213a9b8` touches only `docs/operations/*` and two `docs/projects/*` files — disjoint from every file feat changes. **Merge is clean.**

## 2. Files changed (feat vs `e0f005f`) — 18 files, +2523 / −171
**Core code (4):** `src/services/paymentService.js` (+921/−… — the webhook state machine + refund/orphan logic, incl. the DEFECT-LINEB-1 fix), `src/routes/payments.js` (webhook route raw-body + 500/replay semantics), `src/routes/admin.js` (admin refund endpoint), `server.js` (+36 — `/api/health` reconciliation metrics).
**Migrations (2, new):** `058_extend_stripe_webhook_events.sql`, `059_add_payments_refunded_amount.sql`.
**Tests (3 new + 2 e2e):** `tests/webhook-state-machine.test.js` (+283), `tests/refund-integrity.test.js` (+228), `tests/payment-intent-orphan.test.js` (+271); `e2e/admin/admin-refund.spec.js`, `e2e/payments/payment-refund-execution.spec.js`.
**Tooling/docs (9):** `scripts/promote-058-059.js` (staging-guarded runner), `docs/sop-refunds.md` (+39/−…), and the 5 `docs/projects/stripe-live-readiness/*` planning/validation docs.
**Scope assessment:** changes are confined to payment/webhook/refund infrastructure + health + tests/docs. No schema changes outside the 2 additive migrations. No auth, bidding, close, seller, or BD-integration surface touched.

## 3. Migrations added
| File | Effect | Reversibility |
|---|---|---|
| `058_extend_stripe_webhook_events.sql` | adds `status, payload, last_error, attempt_count, received_at` + index `idx_stripe_webhook_events_status_received`; backfills pre-existing rows to `processed` | additive — drop columns/index to revert; old code tolerates the new columns |
| `059_add_payments_refunded_amount.sql` | adds `refunded_amount_cents` (NOT NULL DEFAULT 0) + CHECK `chk_refunded_amount_bounded`; backfills `refunded`/`partially_refunded` rows | additive — drop constraint then column; **partial→full backfill is not auto-reversible** (restore from backup if true partial state matters) |

- **Numbering:** production `main` has migrations through `057` (and 045/046/047). `058/059` are **net-new** — confirmed absent on both `main` and `deploy/seller-studio-1b`. No collision. (They were renumbered from the original Line B `046/047`, which prod already uses.)
- **Order rule:** migrations run **before** code on every environment (058 then 059). The new code reads `status`/`refunded_amount_cents`; old code ignores them.

## 4. Test coverage
- **Unit (jest):** full `tests/` → **10 suites pass, 1 fail** — the only red is the **pre-existing `tests/bid.test.js`** (unrelated to Line B; documented known-red). The three new financial suites + payment/webhook/refund all green (validated 24/24 on the targeted run after the fix).
- **DEFECT-LINEB-1 regressions added:** webhook-state-machine now asserts (9) stale-takeover uses a server-side `received_at < now() - interval` predicate and **never** `received_at = $2` (only `$1` bound), and (10) the acquire path is a bounded loop that terminates (no unbounded recursion).
- **e2e:** admin-refund and payment-refund-execution specs updated for the hardened refund flow.
- **Integration (staging, real deployment):** S0–S10 exercised against the deployed staging app (signed webhooks, admin JWT refunds, orphan/health) — see §5.

## 5. Validation evidence (Phase 1 staging)
Environment: staging branch `staging-2026-06-10`, endpoint `ep-royal-dawn-anarou3f`, Stripe **TEST**. Backup branch `staging-pre-lineb-2026-06-10` (`br-still-term-andxudcn`, endpoint `ep-green-grass-an3eli55`).
- **STEP 2 pre-checks:** PASS (`partially_refunded=0`; clean schema; no migration collision).
- **STEP 3 migrations:** PASS (`Applied 2, skipped 0`; §2c verification all green; 0 constraint violations).
- **STEP 4 staging deploy:** PASS (health reconciliation block present, both workers boot, `stripe_mode:test`).
- **STEP 5 S0–S10:** **PASS** after DEFECT-LINEB-1 remediation. Initial S3 FAILED (stale-takeover `received_at` ms/µs equality → unbounded recursion → HTTP 502); fixed in `f441512`, redeployed, retested — S3 + S1/S2/S4 + fresh-not-stolen all PASS, 0 acquire-loop activity.
- **Final Phase 1 status:** **PASS — READY FOR MERGE REVIEW.**
- Evidence docs: `phase-1-reconciliation-report.md`, `phase-1-staging-execution-plan.md`, `phase-1-staging-validation-report.md`, `scripts/promote-058-059.js`.

## 6. Production impact
- **Of the merge itself:** target `deploy/seller-studio-1b` auto-deploys to **staging**, not production. Merging has **no production impact**; it triggers a staging redeploy of already-validated code. Production (`main` @ `e0f005f`) is untouched by the merge.
- **Of an eventual production promotion (separate, later gate):** additive schema change (2 columns + 1 constraint + 1 index on `stripe_webhook_events`/`payments`); webhook handler returns 500 on handler failure (Stripe retries) instead of silently swallowing; refunds gain cumulative accounting + idempotency + overspend guard; `/api/health` gains a reconciliation block. Old behavior is a strict subset — additive and backward-tolerant. Stripe stays TEST until an explicit, separate cutover.
- **Data:** no destructive change; the only data writes are additive-column backfills (and on prod, `partially_refunded` rows — currently 0 on staging — must be reconciled against Stripe before 059, per `sop-refunds.md`).

## 7. Rollback strategy
- **Merge rollback (staging):** revert the merge commit on `deploy/seller-studio-1b`; staging redeploys the prior tree. Migrations are additive and old code tolerates them, so usually only a code revert is needed; deepest recovery = restore Neon branch `staging-pre-lineb-2026-06-10`.
- **Migration rollback:** `058`/`059` are additive — `DROP CONSTRAINT chk_refunded_amount_bounded; DROP COLUMN refunded_amount_cents;` then drop `058`'s index/columns; remove the rows from `schema_migrations`. Caveat: `059`'s partial→full backfill is not auto-reversible (restore from backup branch if true partial state matters).
- **Production rollback (future):** redeploy the prior `main` (`e0f005f`) image; additive migrations can remain in place (old code ignores them) or be reversed as above; deepest = restore the pre-promotion **production** Neon backup branch (must be created at promotion time).

---

## A. Is the branch ready to merge?
**YES.** Conflict-free three-way merge into `deploy/seller-studio-1b`; migrations net-new with no collision; Phase 1 staging validation PASS (S0–S10) with DEFECT-LINEB-1 fixed and retested; unit suites green except the pre-existing `bid.test.js`; scope confined to payment/webhook/refund infrastructure; no production impact from the merge. The merge is a staging-line integration, fully reversible.

## B. If merged, exact steps remaining before PRODUCTION promotion
1. **Confirm staging post-merge:** after merge, `deploy/seller-studio-1b` auto-deploys to staging — confirm `/api/health` 200 with reconciliation block, workers boot, Stripe still TEST. (Staging DB already has 058/059; runner is idempotent.)
2. **Advance the production line:** bring the validated tree to `main` (merge/FF `deploy/seller-studio-1b` → `main`, or cherry-pick the Line B set). Production deploys from `main`.
3. **Verify production DB migration state:** confirm the prod DB has all predecessors **045–057** applied (per `production-promotion-runbook.md` / prior promotion notes — prod DB may lag the `main` tree). Apply any missing predecessors first.
4. **Production backup:** create a prod Neon backup branch (analogue of `staging-pre-lineb-2026-06-10`); record restore timestamp.
5. **Prod pre-check:** run the read-only `partially_refunded` count on the **prod** DB; if > 0, reconcile against Stripe `amount_refunded` per `sop-refunds.md` before `059`.
6. **Apply migrations to prod (before code):** `058` then `059` against the prod endpoint (a prod-guarded runner — not the staging-only `promote-058-059.js`).
7. **Deploy code to production** from `main`; post-deploy validation: health reconciliation block present, smoke-test a webhook + refund in **TEST**, workers boot.

## C. If promoted to production, exact steps remaining before STRIPE LIVE
1. Production backup — done in B.4.
2. Production migration execution (058/059) — done in B.6.
3. Production deployment validation (health + TEST smoke) — done in B.7.
4. **Stripe LIVE cutover checklist** (`docs/stripe-live-cutover-prerequisites.md`):
   a. Swap prod env to **LIVE** keys: `STRIPE_SECRET_KEY=sk_live_…`, `STRIPE_PUBLISHABLE_KEY=pk_live_…`.
   b. Register the **LIVE** webhook endpoint (Stripe LIVE dashboard → prod `/api/payments/webhook`); set `STRIPE_WEBHOOK_SECRET` to the LIVE signing secret.
   c. Verify a LIVE webhook delivers + signature-verifies (health `stripe_mode` flips to `live`; reconciliation metrics update).
   d. Confirm business rules under LIVE: card-only acceptance, buyer card verification (temp <$1 charge), live buyer-premium display, tax-after-close.
5. **Final real-money readiness signoff** (human go/no-go).

## D. Launch blockers remaining (as of now)
1. **Merge not done** — this PR is open-only (intended).
2. **Production promotion not done** — backup + prod-DB migration-state verification + 058/059 apply + `main` deploy (B.1–B.7).
3. **Stripe LIVE cutover not done** — LIVE keys + LIVE webhook endpoint registration + signature verification (C.4).
4. **Real-money signoff pending** (C.5).
5. **Seller payout settlement (Phase 2) not implemented** — known remaining `reportingService` payout-insert wiring blocker; **marketing-fee settlement deduction** also unbuilt (planning doc only on `deploy/seller-studio-1b`). These gate the **full seller-settlement cycle**, not buyer-facing bidding/payment.
6. **Pre-existing `tests/bid.test.js` red** — unrelated, documented; not a Line B blocker but should be tracked.

## E. Shortest remaining path to public launch
1. **Merge** `feat/line-b-financial-integrity → deploy/seller-studio-1b`; confirm staging redeploy green (B.1).
2. **Promote to production:** verify prod DB migration state → backup prod → prod `partially_refunded` pre-check → apply 058/059 → deploy `main` → validate health (B.2–B.7).
3. **Stripe LIVE cutover:** LIVE keys + LIVE webhook endpoint + signature verify + business-rule spot-check (C.4).
4. **Real-money signoff** (C.5) → buyer-facing public launch (bidding + card payment + refunds) is live.
> **Caveat:** steps 1–4 enable the **buyer-facing** launch. The **seller-payout settlement cycle (Phase 2 + marketing-fee deduction)** remains a separate, later gate and must be completed before sellers are paid through the platform. If "public launch" means buyers can discover/bid/pay (sellers settled manually meanwhile), steps 1–4 suffice; if it means full automated settlement, Phase 2 is also required.

---

# CLASSIFICATION

## Merge gate: **READY TO MERGE**
Evidence: conflict-free three-way merge (`merge-tree` exit 0); 058/059 net-new (no collision); Phase 1 staging S0–S10 PASS with DEFECT-LINEB-1 fixed + retested; unit suites green except pre-existing `bid.test.js`; merge has zero production impact (target auto-deploys to staging).

## Launch gate: **PUBLIC LAUNCH BLOCKED**
Evidence: production promotion (backup + prod-DB migration verification + 058/059 apply + `main` deploy), Stripe LIVE cutover (LIVE keys + LIVE webhook endpoint + signature verification), and final real-money signoff are all outstanding; seller-payout settlement (Phase 2) + marketing-fee deduction remain unimplemented. Shortest buyer-facing path is the 4-step sequence in §E; full automated settlement additionally requires Phase 2.

*Constraints honored: nothing merged, deployed, migrated, or promoted; production untouched; Stripe remains TEST; no Phase 2 work; no new features. Review only.*
