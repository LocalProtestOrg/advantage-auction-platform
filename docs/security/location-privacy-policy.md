# Location Privacy & Anti-Circumvention Policy

## Purpose

This document defines how auction location data is handled across the Advantage Auction Platform. It covers what is safe to expose publicly, what must remain behind a payment gate, and how enforcement should be layered across the stack. It also records the anti-circumvention and seller withdrawal policies that will be formalized in seller agreements and onboarding flows.

---

## Why This Matters

Full address disclosure before payment creates compounding risks:

- **Seller privacy and estate security** — occupied homes, estates in transition, and storage facilities are targets for theft and trespass when addresses are widely accessible
- **Crowd control** — unpaid, unverified visitors arriving at a pickup site create operational and liability risk
- **Platform commission integrity** — buyers who know the full address can contact sellers directly to bypass the platform and avoid buyer premiums
- **Anti-circumvention** — direct side-dealing undermines seller and platform revenue
- **Fraud and no-shows** — non-winners who learn the address have no legitimate reason to attend

The platform must enforce location privacy as a business rule, not just a UI convention.

---

## Location Disclosure Rules

### Before Payment

Display only:

| Field | Example | Allowed |
|---|---|---|
| Street name (no number) | "Westheimer Rd" | ✅ |
| City | "Houston" | ✅ |
| State | "TX" | ✅ |
| Zip | "77098" | ✅ |
| General neighborhood | "Near River Oaks" | ✅ |
| Street number | "4521" | ❌ |
| Full address | "4521 Westheimer Rd" | ❌ |
| GPS coordinates | lat: 29.74, lng: -95.46 | ❌ |
| Building name / unit | "Unit 3B, Park Tower" | ❌ |

### After Payment (Winning Buyer Only)

Full pickup address is unlocked only after:

1. Payment `status = 'paid'`
2. `buyer_user_id` matches the authenticated user on the invoice
3. Request passes through the payment-verified address endpoint

Full address is accessible to:
- Winning buyer (via payment-gated endpoint)
- Admin (unrestricted)
- Seller (their own auction — authenticated)
- Internal pickup coordination flows

---

## Current State Audit (as of 2026-05-13)

### Schema (db/migrations/001_create_schema.sql + migration 036)

| Column | Type | Notes |
|---|---|---|
| `city` | TEXT | Safe for public display |
| `address_state` | TEXT | Safe for public display |
| `zip` | TEXT | Safe for public display |
| `street_address` | TEXT | Added in migration 036; plain-text; currently only returned to authenticated seller |
| `address_encrypted` | BYTEA | Encrypted full address; **never decrypted in any route** — critical gap |
| `lat` | NUMERIC | GPS latitude; exposed in geo-search endpoints |
| `lng` | NUMERIC | GPS longitude; exposed in geo-search endpoints |

### Public API Exposure (src/routes/public.js)

All public endpoints are unauthenticated. Current field exposure:

| Endpoint | Fields Returned | Status |
|---|---|---|
| `GET /api/public/auctions` | city, address_state, zip | Within policy — no street number |
| `GET /api/public/auctions/near` | city, address_state, zip, **lat, lng** | ⚠️ GPS coordinates — policy gap |
| `GET /api/public/auctions/:id` | city, address_state, zip | Within policy |
| `GET /api/public/featured-lots` | auction_city, auction_address_state | Within policy |
| `GET /api/public/featured-auctions` | city, address_state, zip, **lat, lng** (geo queries) | ⚠️ GPS coordinates — policy gap |
| `GET /api/public/featured-videos` | auction_city, auction_address_state | Within policy |
| `GET /api/public/locations` | city, address_state (aggregated) | Within policy |

### Authenticated Buyer Endpoints (src/routes/auctions.js)

| Endpoint | Fields Returned | Status |
|---|---|---|
| `GET /api/auctions/:id/summary` | city, address_state, pickup_window_start, pickup_window_end | ⚠️ Pickup dates exposed before payment; no payment gate |

### Seller-Owned Endpoints (authenticated)

| Endpoint | Fields Returned | Status |
|---|---|---|
| `GET /api/auctions/:id` | `SELECT a.*` — all columns including street_address | ✅ Auth-protected, seller/admin only |
| `GET /api/auctions/my` | `SELECT a.*` | ✅ Auth-protected, seller only |

### Critical Gap — Payment-Gated Address Decryption Not Implemented

`src/services/paymentService.js` contains three TODO comments:

```
// TODO: In route/seller view layer: IF payment.status !== 'paid' THEN hide auction.address_encrypted
// TODO: Decrypt and return full address ONLY after _ensurePaymentVerified() passes
// TODO: Add buyer invoice generation that includes address (only for paid payments)
```

**No endpoint currently decrypts `address_encrypted` for any user.** The encrypted field exists in the schema but the post-payment reveal path was never built. Winning buyers currently have no way to receive the full pickup address through the platform.

### Frontend Pages

| Page | Address Rendering | Status |
|---|---|---|
| `public/auction-view.html` | city, address_state from API | Within policy |
| `public/lot.html` | Requires auth; no address rendered | ✅ Safe |
| `public/dashboard/invoice.html` | No address fields rendered | ❌ Gap — paid winners should see address here |
| All marketing pages (index, how-it-works, etc.) | No address rendering | ✅ Safe |

---

## Staged Implementation Plan

Stages are ordered by risk reduction value, not implementation complexity. Do not skip stages or begin a stage while a prior stage has open items.

### Stage 1 — Documentation and Policy Baseline (No Code Changes)

**Status: In progress (this document)**

Deliverables:
- [x] Location privacy policy document (this file)
- [ ] Anti-circumvention and seller withdrawal language drafted (see below)
- [ ] Seller FAQ updated with pickup address disclosure language
- [ ] Seller agreement content drafted (held for implementation until onboarding flow is ready)

No code changes. No functionality at risk.

---

### Stage 2 — Close GPS Coordinate Leak ✅ COMPLETE (2026-05-13)

**Target files:**
- `src/routes/public.js` — `/api/public/auctions/near` and `/api/public/featured-auctions`

**Changes made:**
- Removed `lat` and `lng` from outer SELECT in `/api/public/auctions/near` (was line 169)
- Removed `a.lat` and `a.lng` from inner SELECT in `/api/public/auctions/near` (was lines 188–189)
- Removed `lat` and `lng` from outer SELECT in `/api/public/featured-auctions` geo branch (was line 452)
- Removed `a.lat` and `a.lng` from inner SELECT in `/api/public/featured-auctions` geo branch (was lines 469–470)
- Removed `a.lat` and `a.lng` from non-geo branch SELECT in `/api/public/featured-auctions` (was lines 520–521)
- Haversine distance calculations preserved — `a.lat`/`a.lng` still used inline in formulas and WHERE clauses
- `distance_km` computed result still returned in response (city/state area distance is fine; raw GPS is not)

---

### Stage 3 — Remove Pickup Window Dates from Pre-Payment Views (Medium Risk)

**Target files:**
- `src/routes/auctions.js` — `/api/auctions/:id/summary`

**Changes:**
- Remove `pickup_window_start` and `pickup_window_end` from the summary response
- These fields should only be returned after payment verification in the new pickup address endpoint (Stage 4)

**Frontend impact:**
- `public/auction-view.html` may display pickup windows — audit rendering logic before removing
- If pickup window is currently shown to all bidders, move it to the payment-gated auction detail view only

**Risk:** Medium. Auction view page may render pickup dates. Audit before deploying.

---

### Stage 4 — Implement Payment-Gated Address Endpoint (High Risk, Critical)

This is the most important implementation. It closes the critical gap identified in the audit.

**New endpoint:**
```
GET /api/buyer/auctions/:auctionId/pickup-details
```

**Authentication:** Requires valid buyer JWT

**Authorization logic (server-side, non-negotiable):**
```
1. Verify req.user is authenticated
2. Query: SELECT i.id FROM invoices i
          JOIN lots l ON l.id = i.lot_id
          WHERE l.auction_id = :auctionId
            AND i.buyer_user_id = :userId
            AND i.status = 'paid'
          LIMIT 1
3. If no paid invoice found → 403 Forbidden
4. If paid invoice found → decrypt address_encrypted and return full address + pickup window
```

**Response (only after gate passes):**
```json
{
  "full_address": "4521 Westheimer Rd, Houston, TX 77098",
  "city": "Houston",
  "address_state": "TX",
  "zip": "77098",
  "pickup_window_start": "2026-05-18T09:00:00Z",
  "pickup_window_end": "2026-05-19T17:00:00Z",
  "pickup_instructions": "..."
}
```

**Decryption:** Use the existing encryption key from environment config. The `address_encrypted` column is a BYTEA field — implement decryption in the route or a dedicated service method.

**Risk:** Medium-high. Requires implementing encryption/decryption. Do not touch existing public endpoints. This is an additive route only.

---

### Stage 5 — Update Invoice Page to Show Full Address for Paid Winners (Medium Risk)

**Target files:**
- `public/dashboard/invoice.html` (frontend)
- `src/routes/invoices.js` (backend)

**Changes:**
- Invoice detail route should call the new pickup-details endpoint (or replicate the payment gate inline)
- Invoice page should display full pickup address and pickup window for paid invoices
- Unpaid/pending invoices show city/state only

**Risk:** Medium. Invoice page is buyer-facing. Do not break existing invoice display logic. Additive only.

---

### Stage 6 — Seller Agreement and Onboarding Anti-Circumvention Language (No Code Risk)

**Content to be added to seller agreement and onboarding:**

```
Anti-Circumvention Policy

By submitting an auction through Advantage.Bid, the Seller agrees not to:
- Share the full property address with any registered bidder or buyer before payment is verified
- Facilitate, encourage, or permit direct sales of auction lots outside the platform
- Contact or solicit winning bidders for direct transactions
- Accept payment outside the platform for any lot listed through this auction

Lot Removal Policy

Lot removals requested after final submission may incur a discretionary removal fee at the
discretion of Advantage.Bid management. Fees are assessed based on operational impact,
auction timing, and marketing exposure already committed to the lot.

Seller Withdrawal Policy

Sellers who withdraw an auction after the live date or after buyer activity has begun
may be responsible for operational costs incurred, including but not limited to
photography, cataloging, marketing, and platform setup fees.
```

**Deliverables:**
- [ ] seller-faq.html — add FAQ items for address privacy, direct contact, lot removal fees
- [ ] Seller agreement page (held — depends on onboarding flow)
- [ ] Seller onboarding checklist item: "I understand that the full address will not be shared until payment is received"

---

### Stage 7 — Enforce `street_address` Exclusion from All Non-Admin Routes (Low Risk, Audit Only)

**Current status:** `street_address` is only returned via `SELECT a.*` in authenticated seller/admin endpoints. This is correct.

**Hardening:**
- Add explicit column exclusion in seller-facing queries — replace `SELECT a.*` with explicit column lists that exclude `street_address` and `address_encrypted`
- Only admin routes and the new pickup-details endpoint should ever return street address data
- This prevents future accidental exposure if query logic changes

**Risk:** Low. Refactoring SELECT columns in authenticated routes is safe and non-breaking.

---

## Enforcement Layers (Final State)

When all stages are complete, enforcement will be layered as follows:

| Layer | Mechanism | Status |
|---|---|---|
| Database | `address_encrypted` at rest; `street_address` excluded from non-admin queries | Partially in place |
| API — Public | Field allowlist in public.js excludes all address fields except city/state/zip | ✅ Currently safe (except GPS) |
| API — Buyer | Payment-gated endpoint — 403 if no paid invoice | ❌ Not built |
| API — Seller | Authenticated; returns own auction address only | ✅ Currently safe |
| API — Admin | Unrestricted | ✅ By design |
| Frontend — Public | auction-view.html renders city/state only | ✅ Currently safe |
| Frontend — Buyer | Invoice page shows full address only after paid status | ❌ Not built |
| Invoice | Full address included only in paid invoices | ❌ Not built |
| Pickup scheduling | Address shown only in verified pickup coordination flow | ❌ Not built |
| Seller agreement | Anti-circumvention terms accepted at submission | ❌ Not written |

---

## What Not to Do

- Do not add `!important` CSS to visually hide address fields — this is not enforcement, it is decoration
- Do not gate address visibility only on frontend state — the API must return nothing before payment
- Do not use the `street_address` plain-text column in any public or buyer-facing query
- Do not expose `lat`/`lng` in API responses even if they are used server-side for geo-filtering
- Do not include pickup window dates in pre-payment responses — they give away logistical information even without the address
