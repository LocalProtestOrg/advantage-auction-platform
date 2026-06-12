# Production Promotion Plan — `launch-day-buyer-ux`
**Date:** 2026-06-12 · **Type:** PLAN ONLY — nothing executed. Held until an explicit "go." **Production stays on `main` @ `e0f005f`; Stripe stays TEST; no LIVE cutover.**

## 1. Current state summary
| | |
|---|---|
| **Staging code** | `launch-day-buyer-ux` @ `83ff1ba` (manual `railway up`) — live-validated A–H, 23/23 + 3/3 browser |
| **Production code** | `main` @ `e0f005f` (unchanged) |
| **Staging DB migrations** | `060–064` applied (+ `058/059` already applied earlier for Line B) |
| **Production DB migrations pending** | **`058, 059, 060, 061, 062, 063, 064`** — none recorded on prod. Columns `058/059/061/062/063/064` absent; **`060.password_hash` already present (drift) → `060` is a no-op that only records the ledger** |
| **Stripe mode** | **TEST** on both prod and staging (`sk_test`/`pk_test`); no LIVE keys present |
| **Known caveats** | (a) **Line B coupling — see below.** (b) Bid gate becomes enforced (existing buyers must accept terms + add card + register). (c) Time-based behaviors (#19 bar, anti-snipe firing, hide-closed) need a human/time-gated check. (d) `008/017/032` ledger-gap migrations are intentionally **excluded**. |

### ⚠️ Critical: Line B coupling (058/059 are a HARD prerequisite, not optional)
`launch-day-buyer-ux` is built on `deploy/seller-studio-1b` (`596dd08`, which merged **Line B**). Its `paymentService` reads `stripe_webhook_events.status/payload/attempt_count` (**058**) and `payments.refunded_amount_cents` (**059**). Therefore **deploying this code to prod requires 058/059 on the prod DB first** — otherwise the webhook/refund paths throw on missing columns. Line B Phase 1 staging validation already passed (S0–S10) **after DEFECT-LINEB-1 was fixed**, and that fix (`f441512`) is in this tree. So **058/059 are included in this promotion as a required dependency** (not kept separate). `008/017/032` are **not** included (not needed by the code; `missed_pickups`/008 is a pre-existing latent item to handle separately).

## 2. Production backup (before any prod migration)
1. **Neon Console** → project (endpoint **`ep-proud-leaf-an8pzkib`**) → Branches → **New Branch** from current prod head → name **`prod-pre-launchux-2026-06-DD`** → Create. **Record:** branch name, branch id, compute endpoint, parent, restore timestamp.
2. (API alt) `POST /projects/<PROJECT_ID>/branches` with `parent_id=<prod branch>`.
3. **Rollback path confirmed:** restore this branch (or PITR to its timestamp) is the deepest recovery. Because the migrations are additive, a *code-only* rollback usually suffices (see §8).
**Gate:** backup confirmed + recorded before applying any migration.

## 3. Production migrations (apply ONLY 058–064, guarded, in order)
Apply with **prod-guarded, N-only scripts** (mirror the staging `apply-0NN` scripts but **require `ep-proud-leaf-an8pzkib` and refuse staging**). **Do NOT use `run-migrations.js`** (it would also pull in `008/017/032`). Run **after backup**, **before code deploy** (migrations-before-code).

Order & effect (all **additive / rollback-safe**):
1. **058** `stripe_webhook_events` +5 cols + index (backfill `received→processed`).
2. **059** `payments.refunded_amount_cents` + `chk_refunded_amount_bounded` (+ backfill). **Pre-check:** read-only `SELECT count(*) FROM payments WHERE status='partially_refunded'` — if `>0`, reconcile vs Stripe per `sop-refunds.md` before applying (059 marks partial→full). *(staging count was 0)*.
3. **060** `users.password_hash` — **no-op on prod** (column exists); records ledger.
4. **061** `terms_versions` + `terms_acceptances` (+ seed Buyer Terms v1). *(Must precede 062.)*
5. **062** `auction_buyers` +`terms_acceptance_id/pickup_acknowledged/status` + `UNIQUE(auction_id,user_id)` + status check.
6. **063** `users.stripe_customer_id` + `card_verifications.stripe_payment_method_id`.
7. **064** `auctions.is_archived/archived_at/archived_by/archive_reason` + partial index.

After each: verify the expected object exists (information_schema / pg_constraint / pg_indexes) and that `schema_migrations` records it. **Do NOT** touch `008/017/032/058/059` beyond the 058/059 included here. **Explicitly:** `008, 017, 032` are **excluded** from this promotion.

## 4. Code promotion path (recommended)
**Recommended (matches the established flow; keeps git history coherent):**
1. **Merge `launch-day-buyer-ux` → `deploy/seller-studio-1b`** (10 ahead / 0 behind → clean; this also makes the validated staging build permanent and prevents the manual `railway up` from being overwritten by an auto-deploy).
2. **Fast-forward `main` → `deploy/seller-studio-1b` head** (`e0f005f` is an ancestor → FF; brings `213a9b8` pilot-ops docs + Line B + buyer-UX).
3. **Prod auto-deploys from `main`** on push. **Push `main` ONLY after §2/§3 (backup + migrations) are done** — migrations-before-code.

**Why not the alternatives:**
- *Manual `railway up` to production* — works but leaves prod running code that isn't on `main` (drift between `main` and the deployed image). Reject for prod.
- *Skip `deploy/seller-studio-1b`* — possible (merge `launch-day-buyer-ux`→`main` directly) but breaks the staging-line convention and orphans `deploy/seller-studio-1b`. Reject.

**Production-safety:** every step names prod explicitly only at the deploy; the worktree/merge steps are git-only. Production service is `advantage-auction-platform` (tracks `main`).

## 5. Production environment checks (read-only — all confirmed present)
| Var | Status |
|---|---|
| `DATABASE_URL` → prod (`ep-proud-leaf-an8pzkib`) | ✅ |
| `JWT_SECRET` | ✅ set |
| `STRIPE_SECRET_KEY` | ✅ **`sk_test_…` (TEST)** |
| `STRIPE_PUBLISHABLE_KEY` | ✅ **`pk_test_…` (TEST)** — required by `add-card.html` SetupIntent |
| SES/email config | ✅ present |
| Public base URL | `advantage-auction-platform-production.up.railway.app` (Railway). **No custom `bid.advantage.bid`** — `add-card.html` uses `location.origin`, so no `PUBLIC_BASE_URL` var is needed. Configure a custom domain separately later if desired. |
| LIVE Stripe keys | **None present — keep it that way.** |
No new env vars are required (new code uses only `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`).

## 6. Post-production-deploy validation (Stripe TEST) — A–O
Re-run the staging journey against **production** (TEST), using the same harness pattern pointed at the prod URL:
- **A Health** 200, `db_reachable`, `stripe_mode:test`, reconciliation block, workers boot.
- **B Public listings** load. **C Archived hidden** (summary/lots 404, absent from list). **D Completed visible but realized prices gated** (logged-out → prompt; logged-in → price).
- **E Buyer flow** login/create → accept terms → add **TEST** card (SetupIntent, no charge) → register → pickup ack → `can_bid:true`.
- **F Inline card bidding** · **G Lot-page bidding** (gate enforced: ungated→403, registered+card→200, too-low→human message).
- **H Staggered closing** (Lot 1 `start+60s`, Lot 2 `+120s`, `end_time=MAX`) · **I Anti-snipe** extends only that lot · **J Countdown bar** colors · **K Closed lots disappear while active** · **L Results mode returns all lots**.
- **M Admin archive/unarchive** + audit. **N Email/notification path** (worker booted; trigger a notification + check inbox). **O Payment still TEST** (`stripe_mode:test`).
**Gate:** A–O green on prod (TEST) before running the production TEST auction.

## 7. Production TEST auction runbook (Stripe TEST)
1. **Pilot seller:** sign in as `pilot-seller1@advantage.bid` (active, `private`); create a small auction with 1–2 lots + a near-future `start_time`; final submission.
2. **Admin:** publish (→ **#18 staggers** the lot closes; `end_time=MAX`).
3. **Test buyer:** create/login; **accept AAC Buyer Terms v1** (`/buyer-terms.html`); **add a TEST card** (`/add-card.html`, `4242 4242 4242 4242` — no charge); **register** for the auction (pickup acknowledgement) → `can_bid:true`.
4. **Bidding:** inline (auction-view card) + lot page; confirm next-min matches server, human errors, max-bid amount, countdown bar.
5. **Closing:** let lots close on the staggered schedule; verify per-lot anti-snipe, hide-closed-while-active, then **results mode** shows all lots.
6. **Realized-price privacy:** logged-out results hide sold prices; logged-in show them.
7. **Payment (TEST):** winning buyer pays at `/payment.html` with a Stripe **TEST** card → `payment_intent.succeeded` webhook → payment `paid`; invoice/receipt created; confirmation email sent.
8. **Admin review:** verify the close report / payout record; archive the TEST auction afterward (hide from public; no delete).
**Throughout:** Stripe remains **TEST**. No LIVE cutover.

## 8. Rollback plan
- **Code rollback:** Railway → `advantage-auction-platform` → Deployments → **Redeploy** the prior `e0f005f` build (or revert `main` to `e0f005f` and push). ~1–2 min.
- **DB / additive migrations:** `058–064` are **additive** (new columns/tables only). The old prod code (`e0f005f`) **does not read** them → **they can remain in place after a code rollback** (no breakage). No need to reverse them for a rollback.
- **When a backup-branch restore IS needed:** only on **data corruption / a half-applied migration** — chiefly `059`'s partial→full backfill if prod had `partially_refunded > 0` (mitigated by the §3 pre-check). Then restore `prod-pre-launchux-*` (or PITR to its timestamp).
- **If the registration/card/terms gate causes a launch issue:** (a) seed terms/registration/card-on-file for the affected pilot accounts (DB), or (b) **roll back code to `e0f005f`** — which removes the gate entirely while the additive migrations stay (safe). There is no runtime feature-flag to disable the gate without a code change, so code rollback is the fast mitigation.

## 9. Stop point
Plan drafted. **Do not execute.** On explicit approval I will, in order: (1) confirm the prod backup branch exists; (2) author + run prod-guarded **N-only** apply scripts for `058→064` (after the `partially_refunded` pre-check); (3) merge `launch-day-buyer-ux`→`deploy/seller-studio-1b`→FF `main`; (4) let prod deploy from `main`; (5) run §6 A–O on prod (TEST); (6) report. **No Stripe LIVE. Production TEST only.**

## GO checklist (must all be confirmed before production execution)
1. ☐ **Neon prod backup branch** `prod-pre-launchux-2026-06-DD` created and **recorded** (name, id, endpoint, parent, restore timestamp).
2. ☐ **Accept that 058/059 (Line B) promote with this release** — they are a **hard dependency** (the code reads those columns).
3. ☐ **Approve the merge path:** `launch-day-buyer-ux` → `deploy/seller-studio-1b`, then `deploy/seller-studio-1b` → `main` (prod deploys from `main`).
4. ☐ **Confirm Stripe remains TEST** through the production TEST auction (no LIVE keys, no LIVE cutover).
5. ☐ **Confirm no custom-domain cutover yet** (`bid.advantage.bid`) unless separately approved — prod uses the Railway domain.
6. ☐ **Confirm a final production TEST-mode auction will run** (and pass) **before** any Stripe LIVE cutover.

> Execution order once all six are ✅: backup (1) → prod `partially_refunded` pre-check → run prod-guarded `058→064` (migrations-before-code) → merge per (3) + push `main` → prod deploys → §6 A–O on prod (TEST) → §7 production TEST auction.

**Prepared (not run):** prod-guarded apply scripts `scripts/prod-migrate-058.js … prod-migrate-064.js` (+ `scripts/prod-migrate-core.js`). Each requires `ep-proud-leaf-an8pzkib`, refuses `ep-royal-dawn-anarou3f`, applies only its one migration, verifies `schema_migrations` + schema objects, and (059) runs the `partially_refunded` pre-check (stops if > 0 unless `ALLOW_PARTIAL_REFUNDED=1`). They do **not** call `run-migrations.js`.

---
*State at drafting: `launch-day-buyer-ux` @ `83ff1ba` (staging, live-validated); prod `main` @ `e0f005f`; prod DB pending `058–064`; Stripe TEST both envs.*
