# Seller-Type Rules Framework — Phase C Implementation Plan (Validation + Override + Audit)

*Implementation plan for review. **No Phase C code is written yet** — this is the "smallest safe path" review the owner requested before coding. Builds on Phase A (`docs/seller-type-rules-framework-phase-a-plan.md`), Phase B (shipped: migration 051 + `sellerTypes.js` + admin assignment + `seller_type_changed` audit, commit `b938355`), and the locked decisions. Migration-first, staging-first, additive, server-authoritative. Does not touch bidding, payment, auction-close, or the AI Catalog Assistant.*

## Approved business requirements (locked)

- **Professional seller types** (exempt from the fixed pickup-gap rule; may configure pickup timing): `auction_house`, `estate_sale_company`, `professional_liquidator`.
- **Non-professional seller types** (`private`, `business`, `other`, and untyped/NULL): pickup must start **≥ 48 hours after auction close** (`pickup_window_start ≥ end_time + 48h`).
- **All sellers** (incl. professional): basic sanity floor — pickup may not start **before** close (`pickup_window_start ≥ end_time`).
- **Admin may override** any rule, but **must provide an override reason**, and **every override writes a `schedule_rule_overridden` audit event**.
- **Validation must be server-authoritative.** **Existing auctions are grandfathered.** **No production changes** in the plan phase. Migration-first / staging-first.
- *(Gap basis = configured `auction.end_time`; not soft-close tail / actual close / payment time — per Phase A Q6.)*

## Review of Phase A/B — what's already done vs. what Phase C adds

| Concern | Status |
|---|---|
| `seller_type` enum incl. 3 professional types + `DEFAULT 'private'` | ✅ Phase B migration 051 |
| `PROFESSIONAL_SELLER_TYPES` / `NON_PROFESSIONAL_SELLER_TYPES` / `isValidSellerType` | ✅ `src/constants/sellerTypes.js` (built for Phase C reuse) |
| Admin can assign `seller_type` + audit (`seller_type_changed`) | ✅ Phase B (`/api/admin/sellers/:id/seller-type`, Sellers-tab `<select>`) |
| Schedule validation at the write chokepoint | ❌ **Phase C** |
| Admin override + reason + `schedule_rule_overridden` audit | ❌ **Phase C** |
| Grandfathering of existing auctions | ❌ **Phase C** |

**Net:** Phase C is purely the enforcement layer. No schema change is required (the type model + audit infra already exist), so Phase C is **code-only** — the smallest, safest possible shape.

---

## Smallest safe implementation path

### 1. Pure validator — `src/services/sellerTypeRules.js` (new, no DB)

```
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');
const NON_PRO_MIN_PICKUP_GAP_HOURS = 48;   // decision; code-owned constant (no platform_settings, per Q4)

function isProfessional(sellerType) { return PROFESSIONAL_SELLER_TYPES.includes(sellerType); }

// Pure. Returns { ok, violations: [{ rule, requiredHours?, actualHours?, message }] }.
function validateAuctionSchedule({ sellerType, endTime, pickupWindowStart }) {
  const v = [];
  if (endTime && pickupWindowStart) {
    const gapH = (new Date(pickupWindowStart) - new Date(endTime)) / 3.6e6;
    if (gapH < 0) {
      v.push({ rule: 'pickup_after_close', message: 'Pickup cannot begin before the auction closes.' });
    } else if (!isProfessional(sellerType) && gapH < NON_PRO_MIN_PICKUP_GAP_HOURS) {
      v.push({ rule: 'pickup_min_gap', requiredHours: 48, actualHours: Math.round(gapH * 10) / 10,
        message: `Pickup must begin at least 48 hours after the auction closes. This pickup starts ${Math.round(gapH)}h after close. (Professional sellers may set their own pickup timing — contact Advantage.)` });
    }
  }
  return { ok: v.length === 0, violations: v };
}
```
- Professionals: only the sanity floor. Non-professionals (incl. NULL): 48h. **No 36h anywhere** (per decision). Unit-testable without a DB.

### 2. Enforce at the chokepoint — `src/services/auctionService.js`

Both write paths flow through here; this is where "server-authoritative" is satisfied.

- **`createAuction(data)`** — when both `endTime` and `pickupWindowStart` are present in the payload:
  - look up the seller's type: `SELECT seller_type FROM seller_profiles WHERE id = $sellerId` (sellerId IS the profile id),
  - run `validateAuctionSchedule`; on violation throw a structured `ScheduleRuleError(violations)`.
- **`updateAuction(auctionId, userId, updates, actorRole)`** — validate only when the patch **touches `end_time` or `pickup_window_start`**, OR when the patch transitions state to `submitted`/`published` (so a draft can't be submitted/published with a violating schedule). Reuse the existing `beforeRow` fetch (extend it to also read `end_time`, `pickup_window_start`, and the joined `seller_type`); compute **effective** values (`patch value ?? stored value`) and validate those.
  - **Grandfathering:** if the patch does **not** touch schedule fields and is not a submit/publish transition, **skip validation entirely** — unrelated edits to existing (even violating) auctions are never blocked.

### 3. Admin override + audit (decision: override allowed, reason required, always audited)

- **Seller** (`actorRole !== 'admin'`): a violation **hard-blocks** → route returns `422` with the `violations[]` (the "explain why").
- **Admin** (`actorRole === 'admin'`): a violation does **not** hard-block, **but** requires an `override_reason`:
  - if `override_reason` is provided → proceed with the write **and** `writeAuditLog({ event_type: 'schedule_rule_overridden', entity_type: 'auction', entity_id, auction_id, actor_id, metadata: { violations, override_reason, before/after schedule } })`.
  - if `override_reason` is missing → return `422` listing the violations + "admin override requires a reason" (admin can still override; they just must justify — preserves admin control while satisfying the audit requirement).
- `updateAuction` already receives `actorRole`; add an optional `options.overrideReason` arg threaded from the route body (`override_reason`). `createAuction` gains an optional `{ actorRole, overrideReason }` (the create route already distinguishes admin via `req.user.role`).

### 4. Route translation — `src/routes/auctions.js` (create + seller PATCH) and admin auction PATCH (`admin.js`)

- Catch `ScheduleRuleError` → `422 { success:false, code:'SCHEDULE_RULE_VIOLATION', violations:[…] }`.
- Admin PATCH passes `req.body.override_reason` into the service.
- No new endpoints; only error translation + threading the override reason. Existing seller create/edit error UIs surface the message ("explain why") with no UI rewrite required.

### 5. Migration

**None required.** The type model (051) and `audit_log` already exist; the override event reuses the existing audit writer. This is the key reason Phase C is the smallest safe step. *(If review later wants the override reason persisted on the auction row too, that would be a separate additive migration — not recommended now; the audit log is the system of record.)*

### 6. Tests

- **Unit (`tests/sellerTypeRules.test.js`):** professional exempt; non-professional 48h boundary (47.9h fail / 48h pass); sanity floor (pickup before close fails for everyone); NULL → non-professional; missing field → no validation (grandfather).
- **Integration:** seller create/PATCH with a violating schedule → 422 + violations; admin PATCH violating without reason → 422; with reason → 200 + `schedule_rule_overridden` audit; unrelated edit to a legacy violating auction → **not** blocked (grandfather); submit transition of a violating draft → blocked.
- **Regression:** existing auction create/update with valid (or absent) schedules behaves exactly as before.

---

## Prerequisites & sequencing (migration-first / staging-first)

1. **Verify migration 051 is applied on the target environment** before Phase C enforcement deploys. *(If 051 is not yet applied, the validator still behaves safely — every seller classifies as non-professional, so the 48h rule applies to all — but professional exemption only works once 051 + admin type-assignment are in place.)*
2. Land Phase C code behind the same staging-first discipline: deploy to staging → run the test suite + a manual matrix (seeded professional vs non-professional seller; valid/invalid schedules; admin override with/without reason; legacy grandfather) → sign-off → production.
3. **No production changes** during the plan phase.

## Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Retro-blocking edits to existing violating auctions | Medium | High | Grandfather: validate only when schedule fields change or on submit/publish; never on unrelated edits. |
| 2 | Admin override accidentally hard-blocked | Low | High | Admin path never hard-blocks on the rule itself; only requires a reason. Test asserts admin-with-reason succeeds on a violating schedule. |
| 3 | Draft assembled field-by-field then submitted invalid | Medium | Medium | Validate on submit/publish transition using effective stored schedule. |
| 4 | Timezone/clock-skew in the 48h math | Medium | Medium | Compute in UTC from stored timestamps; one helper; unit tests with TZ cases. |
| 5 | 051 not applied → professionals wrongly treated as non-pro | Low | Low | Safe-by-default (everyone non-pro = 48h); prerequisite check in §Prerequisites. |
| 6 | Scope creep into payment/close/bidding | Low | High | Out of scope; Phase C only reads `end_time`/`pickup_window_start`/`seller_type` and writes audit. |
| 7 | Override reason not captured → weak audit trail | Low | Medium | Reason is required for admin override; `schedule_rule_overridden` always written; reviewable via Tier 1 History. |

## Recommended implementation order (Phase C)

1. `sellerTypeRules.js` + unit tests (pure; no wiring) — prove the rule in isolation.
2. Wire into `auctionService` create/update (validation + grandfather + admin override/reason + audit).
3. Route 422 translation + thread `override_reason` (auctions.js + admin auction PATCH).
4. Integration + regression tests.
5. Staging validation matrix → sign-off. *(Optional follow-on: client-side "explain why" pre-validation in the seller create/edit form — UX polish; server remains authoritative.)*

## Phase C non-goals

- ❌ No migration / schema change (type model + audit already exist).
- ❌ No 36h enforcement (decision: not enforced, not retroactive).
- ❌ No `platform_settings` threshold (code constant per Q4).
- ❌ No change to bidding, payment, auction-close, pickup-slot service, or the AI Catalog Assistant.
- ❌ No production changes during planning.

---

## Future roadmap item (captured, NOT implemented in Phase C)

**Registration attribution — "How did you hear about us?" for buyers and sellers.** Already documented in `docs/roadmap-registration-attribution.md` (committed with Phase B). Re-affirmed here as a future item: capture an optional attribution answer at registration/onboarding, store it (schema TBD), make it admin-visible (and therefore admin-editable per the `feedback_admin_visible_settings_need_edit_path` principle). **Not** part of Phase C; tracked independently.

---

*End of Phase C implementation plan. Produced for review. No Phase C code written. Awaiting approval before implementation begins.*
