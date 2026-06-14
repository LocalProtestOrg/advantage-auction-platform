# Admin + Buyer Backend Control Sprint — Audit & Plan

**Status:** PROPOSAL — audit complete, awaiting approval. No implementation, no production
deletion yet. **Stripe TEST; Buyer Terms v1; no premium/tax changes; migrations additive+gated only.**

## 0. Headline
Most of the backend already exists. The gaps are: (a) **Archive/Restore/Delete UI** in
moderation.html (archive/restore *endpoints* already exist), (b) a **safe admin hard-delete**
with money-guards (current seller `DELETE` has **no** safety checks and admins can call it — a
risk to fix), (c) **more admin filters** (archived, test/demo), (d) **buyer account editing**
(profile/password/notification-prefs/cards — mostly missing), (e) **back buttons** on 3 buyer
pages + a **shared admin nav** (moderation.html has none), (f) the **field matrix** below,
(g) the **cleanup list** (execute only after approval), (h) wire the **WINNING email** into the
real send queue (found during the prod TEST-auction validation).

## 1. What already exists (do NOT rebuild)
- **Archive/Restore:** `POST /api/admin/auctions/:id/archive` + `/unarchive` (sets/clears
  `is_archived, archived_at, archived_by, archive_reason`), audit-logged. Columns exist.
- **Public safety:** every public discovery query already filters `is_archived IS NOT TRUE`
  (auctions, search, categories, locations, ending-soon, recently-added, trending, featured) —
  verified live. Archived auctions already cannot appear publicly.
- **Admin edit:** `PATCH /api/admin/auctions/:id` (allowlisted fields), `/seller` (reassign),
  `/discovery` (priority/lat/lng), `/publish` (PATCH), `/close`, `/return-to-draft`, `/reject`.
- **Audit logging:** `auditService.logEvent` / `writeAuditLog` → `audit_log`. Already logs
  archive, unarchive, seller-reassign, state-change, field-update, lot create/update/withdraw,
  buyer suspend/reactivate, registration revoke/reinstate, card-on-file.
- **Bid-cancel prevention:** ✅ already compliant — no buyer endpoint/UI to cancel a bid,
  withdraw from a won lot, or void an invoice. Lot withdrawal is seller-only and blocked once
  bids exist. (Keep it this way; add explicit tests.)

## 2. Gaps to build (by requirement area)

### A. Archive / Hide / Restore (UI wiring — backend done)
- Add **Archive** and **Restore** buttons to each auction card in `moderation.html` (call the
  existing endpoints). Show archived badge; confirm prompt with optional reason. **Preferred safe
  cleanup action.**

### B. Hard Delete (NEW, safety-gated)
- Add `DELETE /api/admin/auctions/:id` (admin-only) with a **strong confirmation** (type the
  auction title) in the UI.
- **Block delete unless ALL true:** no rows in `payments` for the auction (any status beyond
  `created`/`canceled`), no `seller_payouts` row, no finalized settlement/invoice with balance,
  no active buyer obligation (unpaid invoice). If blocked → **recommend Archive** with the reason.
- Safe path deletes dependent draft/test records in FK order (bids, lot_proxy_bids, watchlists,
  auction_buyers, lots, then auction) inside one transaction; audit-log `auction.hard_deleted`
  with a snapshot.
- **Also fix existing risk:** the seller `DELETE /api/auctions/:id` → `deleteAuction()` has **no
  money-guard** and admins can call it. Route admin deletes through the new guarded path and add
  the same guard to `deleteAuction`.

### C. Admin "edit everything" — see Field Matrix (§3)
- Extend `updateAuction` admin allowlist + relax the closed-state guard for clearly-safe fields
  (e.g., `admin_notes`, location text, `cover/banner`) while keeping money/identity/lifecycle
  fields system-managed. Add an "Advanced Edit" panel exposing all admin-editable fields.

### D. Admin filters (moderation.html)
- Present: All/Draft/Submitted/Published/Active/Closed/Rejected, Needs-Review, Recently-Updated,
  title search, seller-email. **Add:** **Archived/Hidden**, **Test/demo/validation** (title regex +
  seeded test seller emails), and surface the existing seller-email filter prominently.

### E. Buyer account / profile editing (mostly missing)
- New endpoints + `account.html` UI: `PUT /api/buyers/me` (name, phone — additive `users` columns,
  gated migration), `POST /api/auth/change-password`, `GET/PUT /api/notification-preferences`
  (table exists; SMS opt-in stays **off by default**), `GET /api/payments/cards` +
  `DELETE /api/payments/cards/:id` (view/remove saved card). Audit-log each change.
- Keep bid-cancel/obligation-exit **impossible** (add regression tests).

### F. Back buttons / nav
- Add `buyer-nav.js` to `buyer-faq.html`, `how-to-buy.html`, `my-agreements.html`,
  `featured-auctions.html`. Create a **shared admin-nav** (Back + Moderation/Buyers/Audit + Logout)
  and apply to `moderation.html` (currently has no nav/back) and all admin pages.

### G. Audit logging completeness
- Ensure every new action (hard-delete, advanced field edits, buyer profile/password/prefs/card
  changes) writes `audit_log`. Optionally add buyer bid/payment audit rows (currently app-log only).

### H. Public safety (verify + lock in)
- Already enforced for archived. Add automated tests asserting archived/deleted auctions never
  appear in: current auctions, search, categories, locations, lot discovery, ending-soon,
  newly-added, featured. Add the same `is_archived IS NOT TRUE` guard to any new query.

### I. WINNING email enqueue (from validation finding)
- On `closeAuction`, enqueue a real `WINNING` row into `notifications_queue` for each winner (today
  only the legacy mock `notificationService.AUCTION_WON` fires; template renders correctly but is
  never queued for SES).

## 3. Admin Auction Field Matrix
Lifecycle legend: D=draft, S=submitted, P=published, A=active, C=closed.

| Field | Current editable | Public impact | Risk | Recommended admin control | Editable when |
|---|---|---|---|---|---|
| title | seller+admin (draft) | High (listing) | Low | Admin edit | D,S,P,A; lock C |
| subtitle | seller+admin (draft) | High | Low | Admin edit | D,S,P,A; lock C |
| description | seller+admin (draft) | High | Low | Admin edit | D,S,P,A; lock C |
| cover_image_url / banner_image_url | seller+admin (draft) | High | Low | Admin edit | D,S,P,A; lock C |
| public_auction_type | admin-only | Med (filtering) | Low | Admin edit | D,S,P,A |
| auction_terms | admin-only | Med | Med | Admin edit | any |
| start_time / end_time | seller+admin (draft) | High (close schedule) | **High** (live timing) | Admin edit w/ confirm; regenerates stagger | D,S,P; A w/ guard; lock C |
| pickup_window_start/end | seller+admin (draft) | Med | Med (48h rule) | Admin edit (rule-checked, override+reason) | D,S,P,A |
| preview_start/end | seller+admin (type-gated) | Low | Low | Admin edit | D,S,P,A |
| street_address/city/address_state/zip | seller+admin (draft) | Med (location/search) | Med | Admin edit | D,S,P,A; lock C |
| timezone | seller (draft) | Med | Med | **Add to admin allowlist** | D,S,P,A |
| shipping_available | seller+admin (draft) | Med | Low | Admin edit | D,S,P,A |
| default_starting_bid_cents | seller (draft) | Med | Med | **Add to admin allowlist** | D only |
| increment_ladder | seller (draft) | High (bidding) | **High** | **Add to admin allowlist, validated** | D,S,P; lock A,C |
| bid_increment_cents | admin-only | High | High | Admin edit (validated) | D,S,P; lock A,C |
| buyer_premium_bps | admin-only | High (price) | **High** | Admin edit (infra; NOT charged) | D,S,P; lock A,C |
| marketplace_priority | admin via /discovery | High (featuring) | Low | Keep (Featured Priority) | any |
| lat / lng | admin via /discovery | Med (near-me) | Low | Keep | any |
| admin_notes | admin-only | None (internal) | None | Admin edit | any incl. C |
| marketing_selection | admin (marketing) | Med | Low | Admin edit (marketing panel) | D,S,P,A |
| is_archived/archived_* | archive endpoints | High (visibility) | Med | Archive/Restore actions only | any |
| state | lifecycle endpoints | High | **High** | publish/close/return/reject only — never free-text | n/a |
| seller_id | /seller (reassign) | Med | Med | Reassign Seller (audited) | D,S,P,A; C w/ care |
| auction_house_id | system (BD link) | Low | Med | Read-only (system-managed) | n/a |
| address_encrypted | system (derived) | None | High | System-managed (never direct) | n/a |
| id, version, created_at, updated_at, submitted_at, published_at, revision_*, rejection_*, archived_* | system | n/a | n/a | **System-managed — not editable** | n/a |

## 4. Proposed Cleanup List (40 auctions; 30 test/demo candidates) — NO DELETION YET
Safety gate: `seller_payouts` row OR successful `payments` ⇒ **Archive** (not delete). Exact
re-check against `payments` happens at execution.

**Group 1 — SAFE TO HARD-DELETE (draft/submitted, 0 bids, no payout, test titles) — ~19:**
Browser Validation × 9, Pipeline Validation × 2, "Validation Test Auction …" × 3, Validation
Auction 1778434348, Toggle Hardening Test 144514, Test 1a, Test 2 auction, Test Rehearsal Auction
May 26, "Spring cleaning test auction number 1" (draft + submitted dupes), Test Mkt Auction,
Payment Test Auction (closed, 0 bids, no payout).

**Group 2 — ARCHIVE (closed WITH payout/settlement — never hard-delete) — 5:**
"Test Auction 2" (31 bids, payout), "Spring Cleaning Auction TEST" (28 bids, payout), "The
Whitfield Estate — Evanston, Illinois" (32 lots, payout), "Self-Serve Test Auction 132403"
(payout), "Rehearsal Live Auction" (payout).

**Group 3 — ALREADY ARCHIVED (active+archived; safe to hard-delete, no payout) — 2:**
"PROD TEST AUCTION v2", "PROD TEST AUCTION (delete-safe)".

(Full id/seller/state/lot/bid/payout detail captured in the audit run; reproduced in the approval
table in chat.)

## 5. Migrations
- **None for archive/delete** (`is_archived*` columns exist; hard-delete is physical).
- **One additive, gated** likely needed for buyer profile fields (`users.full_name`,
  `users.phone`) — only if we add profile editing. notification_preferences table already exists.

## 6. Sequencing (proposed)
1. **Admin auction controls** (priority): Archive/Restore UI → safe hard-delete + guard → filters →
   advanced field edits per matrix → shared admin nav/back. + public-safety tests.
2. **Cleanup execution** — only after you approve the list (Group 1+3 delete, Group 2 archive).
3. **Buyer account/profile + nav back-buttons + buyer audit** (second phase).
4. **WINNING email enqueue** fix.

## 7. Risks / constraints
- Editing live `start_time/end_time`/`increment_ladder` on active auctions affects live bidding —
  gate behind confirm + audit, lock after the auction goes active where noted.
- Hard delete is irreversible — strong confirm + money-guard + audit snapshot; archive is the
  default. Never hard-delete anything with payments/payouts/obligations.
- All work stays Stripe TEST; no Terms v2 / premium charging / tax changes; migrations additive+gated.
