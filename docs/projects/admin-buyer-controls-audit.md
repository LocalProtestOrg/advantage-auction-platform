# Admin Buyer/Account Controls — Audit

**Status: AUDIT ONLY.** No code change. Grounded in current code.

## Headline
**There is no admin buyer-management surface.** Every `src/routes/admin.js` endpoint is scoped to auctions, sellers, payments, videos, or marketing. The only account-control endpoints (`suspend`/`unsuspend`) are **keyed on `seller_profiles.id`** and JOIN through `seller_profiles`, so a **pure buyer** (a `users` row with no seller profile) **cannot be reached by any admin endpoint**. The admin UI has zero buyer screens. The **data model is ready**, just unexposed.

## Capability matrix
Legend — Status: ✅ exists · ⚠️ partial · ❌ missing. Priority: **B** launch blocker · **L** before Stripe LIVE · **S** soon · **F** future.

| Capability | API | Admin UI | Status | Priority |
|---|---|---|---|---|
| Search / list buyers | ❌ (only `GET /admin/sellers`, sellers-only) | ❌ | ❌ | **B** (ops can't find a buyer) |
| View buyer profile (email/role/is_active/created) | ❌ for buyers | ❌ | ❌ | **B** |
| Per-auction registration status (`auction_buyers.status`) | ❌ | ❌ | ❌ | S |
| Card-on-file status (no card details) | ❌ | ❌ | ❌ | S |
| Terms acceptance (`terms_acceptances`) | ❌ | ❌ | ❌ | S |
| Pickup acknowledgement (`auction_buyers.pickup_acknowledged`) | ❌ | ❌ | ❌ | S |
| Suspend / block / activate a buyer (`users.is_active`) | ⚠️ seller-keyed only (`admin.js:189/222`) → 404 for pure buyers | ⚠️ sellers tab | ⚠️ unreachable for buyers | **B** (no way to discipline an abusive buyer) |
| Manage auction eligibility (revoke registration → `status='revoked'`) | ❌ (schema supports it; no endpoint) | ❌ | ❌ | L |
| View bidder history (a user's bids) | ❌ admin; self-only (`lots.js:192`) | ❌ | ❌ | S |
| View watchlist / my-bids for support | ❌ admin; self-only (`watchlist.js:60`) | ❌ | ❌ | S |
| Tax-exemption status | ❌ not modeled | ❌ | ❌ | L (with tax system) |
| Audit log of buyer changes | ⚠️ `GET /admin/audit-log` exists but **no buyer events are ever written** | ⚠️ | ⚠️ | S |
| View any buyer's invoices | ✅ `GET /api/invoices/:buyerId` (admin bypass `invoices.js:35`) | ❌ (needs known UUID) | ⚠️ only existing buyer-data path | S |

## Schema readiness (data exists, just unexposed)
- `auction_buyers` (062): `status` (active|revoked), `pickup_acknowledged`, `terms_acceptance_id`, `paddle_number`, `registered_at`.
- `terms_acceptances` (061): per-user ledger w/ `accepted_at`, `ip_address`, `user_agent`.
- `card_verifications` (001) + `users.stripe_customer_id` (063): a `'verified'` row is a safe card-on-file marker (no PAN).
- `users.is_active` (046): the suspension lever — already login-enforced (`auth.js:62`, `authService.js:24`).
- `audit_log` (013): generic append-only; just needs buyer event types emitted.

## Gaps / recommendation
**Minimum admin buyer controls (recommend for public launch — operational safety):**
1. **Buyer search + profile view** (list `users` where role='buyer'; view profile incl. is_active, registrations, card-on-file marker, terms, pickup ack — all read-only, no card details).
2. **Suspend / activate a buyer keyed on `user_id`** (relax the seller_profiles JOIN, or add a user-id-keyed endpoint) — currently impossible for pure buyers.
3. **Revoke / reinstate a per-auction registration** (`auction_buyers.status`), audit-logged.

**Soon after launch:** admin read of bid history/watchlist for support; emit buyer audit events. **Before Stripe LIVE / with tax:** tax-exemption status view + revoke (see tax doc).

**Classification:** buyer **search/view + suspend/activate** = **Required before public launch** (you cannot currently find or discipline a buyer). Eligibility revoke = before LIVE. Read views + audit events = soon. All are endpoint+UI work on an already-ready schema (no migration needed except possibly buyer audit event emission).
