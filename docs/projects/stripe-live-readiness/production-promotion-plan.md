# Production Promotion Plan — Line B Financial Integrity
**Date:** 2026-06-11 · **Type:** PLAN ONLY — nothing in this document has been executed. No migration run, no production deploy, no merge to `main`, no Stripe LIVE, no Phase 2.
**Goal:** promote the validated Line B tree to production **in Stripe TEST mode**, run one final small production TEST-mode auction, and define the exact pass/fail gate that must clear **before** any future Stripe LIVE cutover.

## Confirmed inputs (read-only, 2026-06-11)
| Item | Value |
|---|---|
| Source (validated) | `deploy/seller-studio-1b` @ `596dd08` (PR #1 merged; staging health PASS) |
| Production line | `main` @ `e0f005f` (deploys to Railway service `advantage-auction-platform`) |
| Production DB endpoint | Neon **`ep-proud-leaf-an8pzkib`** (prod) — DDL must use the **direct** endpoint (strip `-pooler`) |
| Staging DB endpoint (reference only) | `ep-royal-dawn-anarou3f` (already has 058/059) |
| Migration files in prod tree (`main`) | `001`–`057` present |
| New migrations (in `deploy/seller-studio-1b`) | `058_extend_stripe_webhook_events.sql`, `059_add_payments_refunded_amount.sql` (net-new; absent on `main`) |
| Migration application mechanism | **Manual.** `package.json start = "node server.js"`; no Procfile/Railpack migration hook. Deploying code does **NOT** auto-apply migrations → migrations-before-code is enforced by sequencing, not automation. |
| Existing prod-guarded runner | `scripts/promote-046-057.js` (refuses any non-`ep-proud-leaf-an8pzkib` endpoint; idempotent via `schema_migrations`) — applies **046–057** to prod |
| Existing runbook | `docs/production-promotion-runbook.md` (align with it) |

> **Key open prerequisite:** production DB migration *application* state is **UNVERIFIED** in this plan (we did not touch prod). The existence of `promote-046-057.js` and prior notes indicate prod DB may lag the `main` tree on **045–057**. Step 1/2 resolve this read-only before anything else.

---

## STEP 1 — Confirm production DB current migration state (READ-ONLY)
**Action:** against prod (`ep-proud-leaf-an8pzkib`), read `schema_migrations` only.
```bash
railway run --service advantage-auction-platform --environment production \
  node -e "<read-only script>"   # SELECT filename FROM schema_migrations ORDER BY filename;
```
Read-only script must: hard-refuse unless `DATABASE_URL` contains `ep-proud-leaf-an8pzkib`; run only `SELECT`s; print the applied filename set, the highest applied number, and any gaps in `001`–`057`. **No writes.**
**Record:** full applied list + highest applied + gap list.
**Gate:** proceed to Step 2 with the gap list in hand.

## STEP 2 — Confirm production DB has migrations 045–057 applied
**Action (read-only):** from Step 1's output, verify each of `045`–`057` is present in `schema_migrations`.
- **If all 045–057 present:** prod DB is at `057`; skip to Step 3.
- **If any of 046–057 missing:** apply them with the existing **prod-guarded** runner (idempotent — already-applied are skipped):
  ```bash
  railway run --service advantage-auction-platform --environment production node scripts/promote-046-057.js   # expect: applied=<missing>, skipped=<present>
  ```
- **If `045_add_stripe_refund_id.sql` is missing:** `promote-046-057.js` starts at 046, so `045` is **not** covered — apply `045` first via `scripts/run-migrations.js` (or a one-off prod-guarded apply of `045`), then run `promote-046-057.js`. `059` and `045` both concern refund columns (`refunded_amount_cents` builds on the refund surface), so `045` must precede them.
**Gate:** prod DB confirmed at migration `057` (all 045–057 applied) before touching `058/059`. **Do not proceed otherwise.**

## STEP 3 — Create production Neon backup branch (BEFORE 058/059)
**Action (operator, Neon control plane):** create a backup branch of the **production** branch from current head:
- Name: `prod-pre-lineb-2026-06-DD` (set the actual date at execution).
- Neon Console → project (endpoint `ep-proud-leaf-an8pzkib`) → Branches → New Branch → parent = current prod branch, from current point → Create; **or** API `POST /projects/<PROJECT_ID>/branches`.
- **Record:** backup branch name, branch ID, backup compute endpoint, parent branch, restore timestamp.
**Gate:** backup confirmed and recorded. This backup is the rollback anchor for the non-auto-reversible `059` partial→full backfill. **Do not apply 058/059 until this is confirmed.**

## STEP 4 — Run production `partially_refunded` pre-check (READ-ONLY)
**Action (read-only, prod):**
```sql
SELECT count(*) FROM stripe_webhook_events;
SELECT count(*) FROM payments;
SELECT count(*) AS partially_refunded FROM payments WHERE status='partially_refunded';   -- MUST review if > 0
SELECT count(*) AS already_refunded   FROM payments WHERE status='refunded';
```
- **If `partially_refunded = 0`:** `059`'s partial→full backfill has nothing to rewrite — safe to proceed.
- **If `partially_refunded > 0`:** **STOP and reconcile.** Document each row; read Stripe's authoritative `amount_refunded` per `docs/sop-refunds.md`; plan a post-migration correction. `059` conservatively marks every `partially_refunded` row **fully refunded** (blocking further refunds) until an operator restores true partial state.
**Gate:** `partially_refunded` count reviewed; reconciliation planned if > 0.

## STEP 5 — Apply migrations 058/059 to production (BEFORE code)
**Action:** author a **production-guarded** runner `scripts/promote-058-059-prod.js`, modeled on `promote-046-057.js`:
- **Require** `ep-proud-leaf-an8pzkib`; **refuse** the staging endpoint `ep-royal-dawn-anarou3f` (mirror, inverse of the staging-only `promote-058-059.js`).
- Use the **direct** endpoint (`raw.replace('-pooler','')`); apply **058 then 059**; transaction per file; fail-fast; record each in `schema_migrations`; never print secrets.
```bash
railway run --service advantage-auction-platform --environment production node scripts/promote-058-059-prod.js   # expect: Applied 2, skipped 0
```
**Verify (read-only §2c):**
```sql
-- 058: 5 columns + index
SELECT column_name FROM information_schema.columns WHERE table_name='stripe_webhook_events'
  AND column_name IN ('status','payload','last_error','attempt_count','received_at');   -- expect 5
SELECT indexname FROM pg_indexes WHERE indexname='idx_stripe_webhook_events_status_received';  -- expect 1
-- 059: column + constraint
SELECT column_name FROM information_schema.columns WHERE table_name='payments' AND column_name='refunded_amount_cents';  -- expect 1
SELECT conname FROM pg_constraint WHERE conname='chk_refunded_amount_bounded';            -- expect 1
SELECT status, count(*), min(refunded_amount_cents), max(refunded_amount_cents) FROM payments GROUP BY status;  -- backfill sanity
```
**Gate:** all four object checks pass; **0** rows violate `[0, amount_cents]`. **Migrations are applied to prod DB BEFORE the new code is deployed.** Old prod code tolerates the additive columns, so this ordering is safe.

## STEP 6 — Promote code from `deploy/seller-studio-1b` to `main`
**Action:** advance `main` to the validated tree `596dd08`. `main` (`e0f005f`) is an **ancestor** of `deploy/seller-studio-1b`, so this is a fast-forward (or a no-conflict merge):
```bash
# review first: git log --oneline main..origin/deploy/seller-studio-1b
git checkout main && git merge --ff-only origin/deploy/seller-studio-1b   # FF main -> 596dd08
git push origin main
```
This brings the Line B set **and** `213a9b8` (pilot-ops/admin planning docs) into prod — both already present in the validated tree. Production service `advantage-auction-platform` deploys from `main` → pushing triggers the prod deploy.
**Gate:** `main` = `596dd08` on origin; prod build starts. (Migrations already applied in Step 5, so deploy order is correct.)

## STEP 7 — Validate production deployment health
**Action:** watch the Railway `advantage-auction-platform` deploy → **SUCCESS**; record image digest + commit.
```bash
curl -s https://<prod-domain>/api/health
```
**Confirm:** HTTP **200**; `status:ok`; `db_reachable:true`; reconciliation block present (`last_webhook_received_at`, `last_webhook_processed_at`, `webhook_failed_count_1h`, `payments_orphaned_intent_count`); both workers boot (`imageProcessingWorker`, `notificationWorker`); server listening; no `Cannot find module` / `stagingValidationHooks` errors. Read-only `pg_stat_activity` shows **0** webhook-acquire loop queries.
**Gate:** all health signals green.

## STEP 8 — Confirm production Stripe remains TEST
**Action (read-only):** `GET /api/health` → **`stripe_mode:test`**; confirm prod env `STRIPE_SECRET_KEY` is still `sk_test_…` and `STRIPE_PUBLISHABLE_KEY` is `pk_test_…` (mode check only — never print key values). **Do NOT** swap to LIVE keys, **do NOT** register a LIVE webhook endpoint, **do NOT** change the Stripe webhook secret.
**Gate:** `stripe_mode:test` confirmed on production. Any `live` indication → STOP.

## STEP 9 — Run final small production TEST-mode auction
**Action:** end-to-end smoke on production, Stripe **TEST**, using owner-controlled fixtures and Stripe test cards only:
1. Create a small auction with 1–2 lots (admin), publish, and run to close (or use a controlled closed lot with a winner).
2. Buyer pays the won lot with a Stripe **test** card → `payment_intent.succeeded` webhook → `stripe_webhook_events.status='processed'`; payment → `paid`; invoice + pickup assignment created.
3. Exercise Line B paths in prod:
   - **Refund accounting:** admin partial refund, then a second partial (sum in `refunded_amount_cents`), then an over-amount → rejected ("Refund total would exceed…"); `chk_refunded_amount_bounded` intact.
   - **Refund idempotency:** repeat with the same `Idempotency-Key` → one Stripe TEST refund.
   - **charge.refunded reconcile:** confirm DB == Stripe `amount_refunded`; self-echo no-op.
   - **Webhook integrity:** confirm dedup on replay; (optionally) a controlled stale-takeover check → `processed`, **no 502 / no acquire loop** (DEFECT-LINEB-1 regression guard).
   - **Orphan/health:** `payments_orphaned_intent_count` behaves; `webhook_failed_count_1h` stays at 0 for healthy traffic.
4. Record every Stripe TEST event/refund id and the before/after `stripe_webhook_events` + `payments` rows as evidence.
**Gate:** the full lifecycle completes with no errors, no 502/hang, no runaway loop.

## STEP 10 — Pass/fail criteria BEFORE any Stripe LIVE cutover
**PASS (all required):**
1. Prod DB at `057` confirmed (Steps 1–2); `058`+`059` applied and §2c-verified; **0** constraint violations.
2. Production backup branch `prod-pre-lineb-*` exists and is recorded (Step 3).
3. Prod `partially_refunded` pre-check reviewed (Step 4); reconciliation done if it was > 0.
4. Prod deploy healthy: `/api/health` 200, `db_reachable:true`, reconciliation block present, workers booted, **0** acquire-loop queries (Step 7).
5. Production **`stripe_mode:test`** confirmed; no LIVE keys/webhook/secret changes (Step 8).
6. Final TEST-mode auction completes the full lifecycle — payment + partial/full refund + over-refund rejection + idempotency + `charge.refunded` reconcile + webhook dedup/stale-takeover — with **no** errors, **no** 502/hang, **no** acquire loop, `webhook_failed_count_1h=0`, no orphan leakage (Step 9).

**FAIL (any one):** missing/failed predecessor migration; failed `058/059` apply or §2c mismatch; missing backup; unreconciled `partially_refunded > 0`; unhealthy prod deploy; any reconciliation field absent; any `stripe_mode` ≠ `test` / unintended LIVE exposure; any lifecycle break, 502/hang, or runaway loop in the TEST auction → **STOP, roll back per below, do NOT cut over to LIVE.**

**Only on PASS** does the project become eligible for the separate **Stripe LIVE cutover** gate (`docs/stripe-live-cutover-prerequisites.md` + `launch-readiness-gate-review.md` §C): LIVE keys, LIVE webhook endpoint registration + signature verification, business-rule spot-check, and final real-money signoff. **That cutover is out of scope here and is not authorized by this plan.**

---

## Rollback (per phase)
- **Migrations (058/059):** `ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_refunded_amount_bounded; DROP COLUMN IF EXISTS refunded_amount_cents;` then drop `058`'s index + columns; remove `058/059` rows from `schema_migrations`. Caveat: `059`'s partial→full backfill is **not auto-reversible** → restore from the `prod-pre-lineb-*` backup branch if true partial state existed.
- **Code:** redeploy the prior `main` (`e0f005f`) image on `advantage-auction-platform`. Additive columns can remain (old code ignores them).
- **Deepest:** restore the production Neon backup branch (Step 3) / PITR to its timestamp.

## Constraints (this plan)
Do NOT, as part of executing this plan: enable Stripe LIVE, register a LIVE webhook, swap to LIVE keys, begin Phase 2 payout wiring, implement marketing-fee settlement, or modify unrelated production data. Stripe stays **TEST** through Step 9. Production migrations run **before** code (Step 5 before Step 6). Every prod-touching script must hard-guard the `ep-proud-leaf-an8pzkib` endpoint.

---

# READY FOR PRODUCTION PROMOTION PLANNING COMPLETE
The promotion path is fully specified (Steps 1–10) with explicit gates, a prod-guarded migration approach (mirroring `promote-046-057.js`), backup-before-DDL, migrations-before-code, a TEST-mode production smoke auction, and an explicit pre-LIVE pass/fail gate. The one execution-time prerequisite to resolve first is the **production DB migration state (045–057)** — verified read-only in Steps 1–2 and remediated with the existing `promote-046-057.js` if any are missing. No step has been executed; nothing was deployed, migrated, merged, or switched to LIVE.
