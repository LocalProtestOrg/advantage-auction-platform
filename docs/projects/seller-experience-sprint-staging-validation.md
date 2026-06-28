# Seller Experience Sprint — Staging Validation Report

**Date:** 2026-06-28
**Scope:** STAGING ONLY — no production deployment, no Stripe LIVE, no Buyer Premium / settlement / tax changes, no DB migrations
**Branch:** `feat/phase2-invoice-system`
**Validated against:** Staging Neon DB (`ep-royal-dawn-anarou3f`) + staging secrets, via `railway run --service advantage-staging`

---

## 1. What was implemented

### Backend
1. **Server-side self-bidding guard** (`src/services/bidService.js`, `createBid`)
   Inside the locked bid transaction, walks `lot → auction → seller_profile → user_id`
   and throws `SELF_BID_FORBIDDEN` ("You cannot bid on your own auction.") when the
   bidder owns the auction. Covers every caller of `createBid`.

2. **Self-service seller enablement** (`POST /api/sellers/enroll`, `src/routes/sellers.js`)
   Buyer → seller in one step. Creates the `seller_profile` (idempotent), promotes
   `users.role` buyer → seller, auto-sends the seller agreement, and returns a fresh
   `role=seller` JWT. No application, no approval queue, no waiting period, no identity
   verification at onboarding. Self-serve is limited to non-professional seller types
   (`private`, `business`, `other`); professional types remain admin-assigned.

3. **Agreement template fallback** (`src/services/agreementService.js`)
   `resolveActiveTemplateId()` falls back to any active general seller agreement when no
   type-specific template exists, so self-serve works for all enabled seller types with
   the single agreement currently authored on staging.

4. **`charge-lot` role gate** now allows `seller` in addition to `buyer`/`admin`
   (`src/routes/payments.js`). Prevents a buyer-turned-seller from silently losing the
   ability to pay for lots they win in *other* sellers' auctions. (Self-payment is
   impossible — self-bidding on one's own auction is blocked server-side.)

### Frontend
5. **Create Auction page** (`public/seller-create.html`)
   - Removed the **Auction End Time** field (`end_time` is derived at publish).
   - `endTime` no longer sent in the create payload.
   - Added an optional **Apartment / Suite / Unit / Building / Storage Unit** field,
     appended to `street_address` client-side (e.g. `123 Main St, Unit 7`). No migration.
   - Replaced the two-button "Save Draft" + "Submit to Advantage for Review" with a
     single **"Create Auction & Add Lots"** that saves a draft and routes into Lot Studio.

6. **New self-service enrollment page** (`public/become-seller.html`)
   Profile form → `POST /api/sellers/enroll` → adopt seller JWT →
   `sign-agreement.html?onboarding=1` → dashboard. Redirects existing sellers straight
   to their dashboard / pending agreement. "Create Seller Account" CTAs on
   `start-selling.html` now point here.

7. **Copy cleanup** removing application / approval / pending language across the seller
   experience (`start-selling.html`, `seller-faq.html`) and the manual line
   *"Most sellers complete their entire auction catalog in an afternoon."*

> The seller dashboard's existing **auction** "Submit to Advantage for review" action was
> intentionally left in place — that is the auction lifecycle ("Advantage publishes
> auctions, not sellers"), distinct from the removed *onboarding* application gate.

---

## 2. Validation results

### Automated end-to-end (staging DB + secrets) — `scripts/stg-validate-seller-experience.js`
Local code run against the staging database/environment; throwaway accounts + auction
created and deleted afterward. **27 / 27 PASS.**

**Buyer**
- ✅ Registration creates an account with `role=buyer`
- ✅ Second buyer registers (used as an independent bidder)
- ✅ Buyer has no seller profile pre-enroll (404)

**Seller enablement**
- ✅ `POST /enroll` creates the seller profile (201)
- ✅ Enroll returns a `role=seller` JWT
- ✅ Enroll reports agreement required / dashboard not yet accessible
- ✅ Enroll auto-sent an agreement to sign
- ✅ `GET /api/sellers/me` now returns the profile
- ✅ Auction creation is **blocked before signing** (403 `AGREEMENT_REQUIRED`)
- ✅ Signing the agreement succeeds (PDF stored)
- ✅ Dashboard access enabled immediately after signing (`reason: signed`)
- ✅ Seller dashboard endpoint reachable post-sign (200)
- ✅ Re-enroll is idempotent (200, same profile, no duplicate row)

**Create auction / address / end time**
- ✅ Create auction succeeds (201)
- ✅ Auction has **no `end_time` on create**
- ✅ Apartment/Unit appended to `street_address` (`742 Evergreen Terrace, Unit 7B`)
- ✅ Two lots added
- ✅ `publishAuction` **derives `end_time` automatically** (verified on the persisted DB row)

**Self-bidding guard**
- ✅ Seller **cannot** bid on their own lot — `createBid` throws `SELF_BID_FORBIDDEN`
- ✅ A different buyer **can** bid on the same lot
- ✅ Seller is also blocked from bidding on their own auction via the HTTP bid route

**Admin**
- ✅ Admin can list auctions including the new one
- ✅ Admin can see the new seller in the roster
- ✅ Admin publish succeeds (200, `state=published`)

### Unit suite — `npx jest tests/`
- ✅ **29 suites, 280 tests, all passing** (run with a bogus `DATABASE_URL` so no real DB
  is touched; the prod endpoint is the default local `.env` target).

---

## 3. Observations / notes (non-blocking)

- **`publishAuction` response staleness (pre-existing):** the publish handler returns the
  auction row captured *before* its own `end_time` UPDATE, so the API *response* shows a
  stale `end_time` while the persisted row is correct. Derivation works; only the returned
  payload lags. Not introduced by this sprint — flagged for a future cleanup.
- **Business/other agreement templates:** only a `private` template is active on staging.
  The new fallback lets business/other sellers accept that general agreement today;
  type-specific templates can be authored later by an admin without code changes.
- **Role model:** enablement sets `users.role = 'seller'` (consistent with seeded sellers,
  required for Lot Studio AI / marketing / payout-prefs). The `charge-lot` relaxation keeps
  such users able to purchase, preserving the dual buy/sell marketplace behavior.

---

## 4. Deployment status — DEPLOYED TO STAGING, STOPPED before production

- **Isolated staging deploy completed (2026-06-28).** To avoid shipping the unrelated
  in-progress working-tree changes on this branch, the deploy was built from a temporary
  git worktree at the committed base (`909542d`) overlaid with **only this sprint's 10
  files** (verified byte-identical; worktree `git status` showed exactly those 10 paths).
  Deployed via:
  `railway up -p e327dbb4-… -e production -s advantage-staging` → **Deploy complete**.
- **Live smoke test against the deployed staging URL**
  (`https://advantage-staging-production.up.railway.app`): **27/27 PASS** — re-ran the full
  validation against the live service; new `become-seller.html` serves (200), new
  "Create Auction & Add Lots" CTA present, old "Submit to Advantage for Review" gone (0).
- **Health:** `/`, `/api/public/config`, `/start-selling.html` all return HTTP 200.
- **Not** promoted to production. No Stripe LIVE, settlement, Buyer Premium, tax, or
  migration changes were made. The unrelated working-tree changes were **not** shipped.
