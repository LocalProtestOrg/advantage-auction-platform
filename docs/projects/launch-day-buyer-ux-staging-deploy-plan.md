# Staging Deploy Readiness — `launch-day-buyer-ux`
**Date:** 2026-06-12 · **Type:** PLAN ONLY — nothing deployed/pushed. Held until an explicit "go deploy staging."
**Branch:** `launch-day-buyer-ux` @ `1f90206` · **Target:** Railway service **`advantage-staging`** (env `production`), Neon `ep-royal-dawn-anarou3f`, Stripe **TEST**. **Production (`advantage-auction-platform`, `main` @ `e0f005f`) must remain untouched.**

## 1. Current git status
- **Branch:** `launch-day-buyer-ux`; **0 behind / 10 ahead** of `origin/deploy/seller-studio-1b`.
- **Commits (10):** `0f84f86` buyer-UX P0/P1 · `b6b6532` #16 · `a71cb43` #17 · `6615604` #18/#5/#7/#19 · `46d7312` #060 schema-drift · `47294a8` #20.1 realized-price · `4c6000a` #21 terms · `ff6912f` #20 registration+gate · `0d38e6a` #20 STEP4 card-on-file · `1f90206` #22 archive.
- **Migrations added (5):** `060_add_users_password_hash`, `061_create_terms`, `062_extend_auction_buyers_registration`, `063_add_stripe_customer_and_pm`, `064_add_auction_archive`.
- **Uncommitted (tracked):** only `.claude/settings.local.json` (local IDE settings — **not** part of the deploy). Untracked working files are not committed and not uploaded from a clean worktree.
- **Risk from staging DB already at 060–064:** **None.** All five are **additive** (new columns/tables only). The *old* code currently running (`596dd08`) tolerates them (it never reads them); the *new* code expects them — so deploying the new code **aligns code↔DB**. Migrations are **not** run during deploy (`start = node server.js`, no auto-migrate step), so the deploy executes **no** DDL.

## 2. Deployment method (safest)
**Use `railway up` from a clean detached worktree — no push, no PR, no merge, no branch retarget** (the exact method used for the Line B staging deploy):
```bash
# from the repo (already linked); create a clean tree at the branch head
git worktree add --detach ../aap-stg-deploy launch-day-buyer-ux   # = 1f90206
cd ../aap-stg-deploy
railway link --project e327dbb4-... --environment 2c7710b4-... --service 949b7a08-...  # advantage-staging
railway up --service advantage-staging --environment production --ci
# watch → "Deploy complete"; then remove the worktree
```
- **Branch push required?** **No.** `railway up` uploads the local working tree directly.
- **Auto-deploy vs manual:** staging **auto-deploys** from its tracked branch `deploy/seller-studio-1b`. `railway up` is a **manual one-off** upload that does **not** change the tracked branch. ⚠️ Consequence: a later push to `deploy/seller-studio-1b` would auto-deploy and **replace** this manual build. To make it permanent, later merge `launch-day-buyer-ux` → `deploy/seller-studio-1b` (separate, approved step).
- **Production safety:** target `--service advantage-staging` explicitly. Production is a **different** service (`advantage-auction-platform`); it is never named in any deploy command. No migration runs against prod.

## 3. Pre-deploy checks (all green now)
| Check | Status |
|---|---|
| Syntax (`node -c`) on all new/changed JS + `server.js` | ✅ OK |
| Playwright (static-serve + mocked `/api`) | ✅ **41/41** |
| Jest `tests/` | ✅ 11 suites pass; only pre-existing `tests/bid.test.js` red (4) |
| Migration status (staging) | ✅ `060–064` recorded in staging `schema_migrations`; prod has none |
| **Env vars — no new vars needed.** New code uses only `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` — all present on staging | ✅ |

**Required env (all confirmed present on `advantage-staging`):**
- `DATABASE_URL` → staging (`ep-royal-dawn-anarou3f`) ✅
- `JWT_SECRET` ✅ · `STRIPE_SECRET_KEY` = `sk_test_…` ✅ · `STRIPE_PUBLISHABLE_KEY` = `pk_test_…` ✅
- SES/email keys present ✅ · `RAILWAY_PUBLIC_DOMAIN` auto (used for the public URL) ✅
- **No `PUBLIC_BASE_URL` needed** — `add-card.html` builds its SetupIntent return URL from `location.origin` (client-side); the publishable key is returned by `/api/payments/setup-intent`.

## 4. Post-deploy live validation checklist (browser journey on staging)
> **Prerequisite:** publish a fresh **TEST** auction with ≥2 lots and a `start_time` ~a few minutes out (this triggers #18 stagger). Use owner-controlled fixtures + Stripe test cards. URL base: `https://advantage-staging-production.up.railway.app`.

**A. Health** — `GET /api/health` → `status:ok`, `db_reachable:true`, `stripe_mode:test`, `email_configured:true`, reconciliation block present; both workers boot in logs.

**B. Public browsing** — listings load; **archived auctions hidden** from listings; an archived auction's `/auction-view.html?auctionId=…` shows unavailable (summary 404 + lots 404); completed auctions visible but **realized prices hidden when logged out** ("Log in … to view realized prices").

**C. Buyer account** — create/login a test buyer (`/login.html`); accept **AAC Buyer Terms v1** (`/buyer-terms.html` → Accept); **add a TEST card** (`/add-card.html`, Stripe Elements/SetupIntent, `4242 4242 4242 4242`, no charge); **register** for the auction (Register to Bid → pickup acknowledgement); confirm `GET /api/auctions/:id/registration-status` → `can_bid:true`.

**D. Bidding** — inline bid from an auction lot card; bid from the lot page; invalid bid → human message; **max bid confirmation includes the amount** ("Max bid placed: $X"); current/next-min display correct and equal to server (`next_min_bid_cents`).

**E. Timed closing** — confirm staggered `closes_at` on publish (Lot 1 ≈ `start_time + 60s`, Lot 2 ≈ `+120s`, `end_time = MAX(closes_at)`); a late bid extends **only that lot**; countdown bar retracts green→amber→red in the final 60s; closed lots **disappear while active**; **all lots return in results mode** once the auction closes.

**F. Realized-price privacy** — logged-out results hide sold prices (prompt); logged-in results show "Sold for $X".

**G. Admin** — admin can still see an archived auction (admin auction detail returns `is_archived`); `POST /api/admin/auctions/:id/archive` + `/unarchive` work; `audit_log` records `auction.archived` / `auction.unarchived`.

**H. Email** — registration/outbid/etc. still send via the SES/staging path (check logs / a real inbox); no errors in the email worker.

> **Expected behavior change to call out:** once deployed, the **server bid gate is enforced** — existing staging test buyers cannot bid until they (re)accept terms + add a card + register. This is intended and is exercised in step C.

## 5. Rollback plan
- **Code rollback:** Railway → `advantage-staging` → Deployments → **Redeploy** the prior `deploy/seller-studio-1b` deployment (`596dd08`); or `railway up` from a `deploy/seller-studio-1b` checkout. ~1–2 min.
- **DB / migrations:** `060–064` are **additive** → the old code (`596dd08`) **tolerates** them (ignores the new columns/tables). **Rollback is safe with the migrations left in place** — no need to reverse them. (Only if you truly want a pristine pre-Line-of-work DB would you drop the added columns/tables; not required for rollback.)
- **Manual cleanup of validation test data** (optional, staging only):
  - `DELETE FROM users WHERE email LIKE '%@example.com' AND role='buyer'` (cascades `terms_acceptances`, `auction_buyers`, `card_verifications`).
  - Archive or delete any TEST auctions you created (archive preferred — `is_archived=true`; or `DELETE FROM auctions WHERE id='…'` cascades its lots/bids/payments — staging only).
  - Optionally delete the Stripe **TEST** customers created (Stripe dashboard, test mode), and any leftover `evt_lineb_*` / `recon060-smoke` rows from earlier.

## 6. Stop point
Plan prepared. **Do not deploy.** Awaiting an explicit **"go deploy staging."** When given, I will: create the detached worktree, `railway up` to `advantage-staging` only, watch for SUCCESS, run checklist §4 (A–H), and report — **no push, no PR, production untouched, Stripe TEST.**

---
*State: branch `launch-day-buyer-ux` @ `1f90206`, 10 ahead of `deploy/seller-studio-1b`; staging DB at `060–064`; staging app still old code (`596dd08`); production `main` @ `e0f005f` untouched.*
