# Seller-Type Rules Framework — Phase A Planning Document

*Planning only. No implementation, no schema changes, no migrations, no endpoint changes in this phase. Builds on the approved `docs/seller-type-rules-architecture-plan.md` and the owner's 2026-05-31 decisions. Source of truth for the framework's design; later phases execute it.*

## Approved decisions (locked, drive this plan)

1. **Professional sellers configure their own pickup timing** — exempt from the pickup-gap minimum. Professional types: **Auction House, Estate Sale Company, Professional Liquidator**.
2. **Non-professional sellers obey a hard minimum:** `pickup_window_start ≥ auction_end + 48 hours`.
3. **Admins may override any rule.**
4. **Design principle (saved to memory):** any admin-visible setting must have an admin edit path. → if `seller_type` becomes admin-visible, it needs an admin setter.
5. **The documented 36-hour rule is NOT enforced and must NOT be retroactively enforced** in this phase. The only enforced gap is the new **48h for non-professionals**; there is no 36h baseline in this framework.

> **Note vs. the prior architecture plan:** the earlier draft proposed a `default: 36h` baseline. **Decision #5 removes it.** The validator enforces *only* the 48h non-professional minimum; professionals are exempt; nothing else (incl. 36h) is enforced.

---

## 1. Revised seller-type model

### 1.1 Current state (verified — see `project_seller_type_and_scheduling_enforcement`)

- `seller_profiles.seller_type TEXT CHECK (seller_type IN ('business','private','other'))`, nullable (`migration 001:29`).
- Drives exactly one behavior: `business` edit-bypass in `lots.js:~59` (out of scope here; must remain unchanged).
- No professional concept, no `estate`/professional types, no classification, no rules layer.

### 1.2 Recommended model — **single `seller_type` enum + code-owned classification** (Option B)

Keep `seller_type` as the one authoritative discriminator (consistent with the only existing rule, which keys on it). **Widen the enum additively** with the three professional types; **derive professional vs non-professional in code**, not in a second column.

```
seller_type ∈ {
  // existing (preserved, backward-compatible)
  'business', 'private', 'other',
  // new professional types (decision #1)
  'auction_house', 'estate_sale_company', 'professional_liquidator'
}
```

Classification (code-owned, lives beside the rules in `sellerTypeRules.js`):

```
PROFESSIONAL_SELLER_TYPES = { 'auction_house', 'estate_sale_company', 'professional_liquidator' }
isProfessional(sellerType) = PROFESSIONAL_SELLER_TYPES.has(sellerType)   // null / legacy → false
```

**Why a derived classification, not a `seller_class` column:**
- One source of truth (the enum) + one code map → no risk of `seller_class` drifting out of sync with `seller_type`.
- Mirrors the platform's code-as-source-of-truth discipline (and avoids the schema-only `capabilities` trap, Defect 2).
- Extensible: adding a professional type = one enum value + one set entry.

**Rejected alternatives:**
- *Two-field (`seller_class` + `seller_type`)* — redundant second source of truth, sync risk.
- *Capabilities flag (`capabilities.professional`)* — capabilities are unenforced/schema-only; wrong foundation.
- *DB classification lookup table* — overkill at this scale; drifts toward a config engine.

### 1.3 Professional vs. non-professional classification

| seller_type | Class | Pickup-gap rule | Notes |
|---|---|---|---|
| `auction_house` | **Professional** | Exempt — configures own timing | new |
| `estate_sale_company` | **Professional** | Exempt | new |
| `professional_liquidator` | **Professional** | Exempt | new |
| `private` | Non-professional | **48h minimum** | existing |
| `other` | Non-professional | **48h minimum** | existing |
| `business` | Non-professional *(open Q1)* | **48h minimum** *(pending)* | existing; ambiguous — see §8 |
| `NULL` (untyped) | Non-professional (safe default) | **48h minimum** | existing default; all current sellers |

**Safe-default principle:** anything not explicitly professional is non-professional and gets the hard 48h minimum. Since no seller is professional yet (no assignment path exists), **the 48h rule applies to all sellers until an admin designates a professional type** — the intended conservative default.

---

## 2. Validation architecture

### 2.1 Module — `src/services/sellerTypeRules.js` (new, pure, code-owned)

```
const PROFESSIONAL_SELLER_TYPES = new Set(['auction_house','estate_sale_company','professional_liquidator']);
const NON_PRO_MIN_PICKUP_GAP_HOURS = 48;   // decision #2 (constant; see §8 Q3)

function isProfessional(sellerType) { return PROFESSIONAL_SELLER_TYPES.has(sellerType); }

// Pure, DB-free, unit-testable. Professionals exempt (decision #1).
function validateAuctionSchedule({ sellerType, endTime, pickupWindowStart }) {
  const violations = [];
  if (endTime && pickupWindowStart) {
    // Minimal sanity floor for everyone (incl. professionals): pickup after close.
    if (new Date(pickupWindowStart) < new Date(endTime)) {
      violations.push({ rule:'pickup_after_close', message:'Pickup cannot begin before the auction closes.' });
    }
    if (!isProfessional(sellerType)) {
      const gapH = (new Date(pickupWindowStart) - new Date(endTime)) / 3.6e6;
      if (gapH < NON_PRO_MIN_PICKUP_GAP_HOURS) {
        violations.push({
          rule: 'pickup_min_gap',
          requiredHours: NON_PRO_MIN_PICKUP_GAP_HOURS,
          actualHours: Math.round(gapH * 10) / 10,
          message: `Pickup must begin at least 48 hours after the auction closes. `
                 + `This pickup starts ${Math.round(gapH)}h after close. `
                 + `(Professional sellers may set their own pickup timing — contact Advantage.)`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
```

- **Professionals:** exempt from the 48h gap; subject only to the basic `pickup_after_close` sanity floor (§8 Q4 confirms whether even this applies to pros — recommended yes, to prevent nonsensical config).
- **Non-professionals:** hard 48h.
- **No 36h anywhere** (decision #5).
- Returns structured violations carrying the data to "explain why" in both API and UI.

### 2.2 Enforcement point — `auctionService` chokepoint

Per the architecture finding, `auctionService.createAuction` + `updateAuction` are the single chokepoint all schedule writes pass through. The validator is called there, after resolving the auction's `seller_type` (join `seller_profiles`), **before** the INSERT/UPDATE.

- **Validate only when `end_time` or `pickup_window_start` is present/changing.** For updates, compute against the stored value of whichever field isn't in the patch. This preserves backward compatibility (legacy auctions aren't retro-validated on unrelated edits — §6, decision #5 spirit).
- **Server is authoritative** (CLAUDE.md). Client mirrors for UX only (§ Phase D).

### 2.3 Route translation

`auctions.js` (seller create/PATCH) and admin auction PATCH translate a seller violation to **`422 Unprocessable Entity`** with `{ success:false, code:'SCHEDULE_RULE_VIOLATION', violations:[…] }`. The UI renders `violations[].message` ("explain why").

---

## 3. Admin override architecture (decision #3)

| Actor | On violation | Record |
|---|---|---|
| **Seller** (non-admin) | **Hard block** — 422 + `violations[]` explanation | none (write rejected) |
| **Admin** (`actorRole==='admin'`) | **Proceed** — never blocked | `audit_log` event `schedule_rule_overridden` with `{ violations, actor_id, auction_id, before/after times }` |

- Preserves "admins may override any rule" (decision #3) and CLAUDE.md "admin override capability must be preserved" — while keeping an accountable, queryable record (and the override is immediately visible via the Tier 1 auction History panel already shipped).
- **Recommended form:** warn-and-proceed-with-audit (no extra friction). Alternative (explicit `override:true` flag from admin UI) noted in §8 Q5.
- Scope: per-write. No persistent override flag/column in Phase A.

---

## 4. Admin editing requirements (decision #4)

Decision #4 makes an admin **edit path for `seller_type`** a hard requirement (it will be admin-visible, so it must be admin-editable). **None exists today** — `seller_type` is only set by seed scripts.

- **Implementation phase** (not now): add an admin setter — extend the existing `/api/admin/sellers/:id/...` family with a `seller_type` update (validated against the enum), writing an `audit_log` event (`seller_type_changed`, before/after) — and a control on the **Sellers tab** (pairs with the just-shipped suspend/unsuspend + History UI). This closes the see→act→review loop for seller classification too.
- **Threshold (48h):** kept a **code constant** in Phase A (source of truth, testable). It is *not* surfaced in admin UI in this phase, so decision #4 doesn't yet require an editor for it. If a future phase surfaces the threshold to admins, decision #4 then requires an edit path (e.g., via `platform_settings`) — flagged in §8 Q3.

---

## 5. Migration strategy (documented; NOT executed this phase)

Per constraints (no schema/migrations yet), this is the **plan** for the implementation phase:

1. **`db/migrations/0XX_add_professional_seller_types.sql`** — additively widen the CHECK:
   `CHECK (seller_type IN ('business','private','other','auction_house','estate_sale_company','professional_liquidator'))`.
   - Additive only: every existing row remains valid; **no data backfill**.
   - **No `seller_class` column** (classification is code-derived) → smaller migration, fewer moving parts.
2. **`…0XX_add_professional_seller_types.down.sql`** — narrow the CHECK back to the original three values. Safe only if no rows use the new values; the down script should assert/no-op accordingly (documented caveat).
3. **Migration leads code:** the enum widening deploys and is verified before any code references the new types.

No other `seller_profiles` change. No change to `auctions`, `lots`, or pickup tables.

---

## 6. Backward compatibility strategy

- **Existing rows** (`business`/`private`/`other`/NULL) remain valid and are classified **non-professional** (pending §8 Q1 on `business`). No row is rewritten.
- **Existing `business` edit-bypass** (`lots.js`) is **untouched** — this framework only adds *schedule* validation; it does not alter edit-lock behavior. (A `business` seller keeps the post-submission edit bypass *and* becomes subject to the 48h pickup minimum — an intended, additive combination; flagged for confirmation in §8 Q1.)
- **Legacy auctions may already violate 48h** (never enforced). Mitigation: validate only on changed schedule fields; **grandfather** existing rows — never retro-validate on unrelated PATCHes (decision #5 spirit). No bulk backfill, no retro-rejection.
- **No professionals exist yet** → the 48h rule applies to everyone until an admin assigns a professional type. This is the conservative, correct default and requires no migration of existing sellers.
- **36h rule:** left exactly as-is (documented in CLAUDE.md, unenforced). This framework does not touch it.

---

## 7. File-level implementation plan (for later phases — NOT executed now)

| # | File | Change | Phase |
|---|---|---|---|
| 1 | `db/migrations/0XX_add_professional_seller_types.sql` (+ `.down.sql`) | Widen `seller_type` CHECK additively | B |
| 2 | `src/routes/admin.js` | New admin `seller_type` setter (enum-validated, audited) | B |
| 3 | `public/admin/moderation.html` (Sellers tab) | Admin control to set seller_type (decision #4 edit path) | B |
| 4 | `src/services/sellerTypeRules.js` (new) | Classification + `validateAuctionSchedule` (pure) | C |
| 5 | `tests/sellerTypeRules.test.js` (new) | Unit tests: pro exempt, non-pro 48h, boundary, sanity floor, TZ | C |
| 6 | `src/services/auctionService.js` | Call validator in create/update; seller block vs admin override+audit | C |
| 7 | `src/routes/auctions.js` (+ admin auction PATCH) | 422 translation + admin warning passthrough | C |
| 8 | `public/seller-create.html` / auction edit | Inline 48h validation + "explain why" before submit (UX mirror) | D |
| 9 | integration tests | seller-blocked, admin-override-audited, legacy-unrelated-PATCH-not-blocked | C/E |

No governance/RBAC, no analytics, no capability-system work, no change to `pickupScheduleService` (post-close slotting is a different phase), no change to the existing `business` edit-bypass.

---

## 8. Open questions for approval

1. **Legacy `business` type:** keep as **non-professional** (subject to 48h), or reclassify/migrate existing `business` sellers to one of the professional types? (Affects who the 48h newly binds. Recommend: keep non-professional; admins re-type the few that are truly professional via the new setter.)
2. **New self-serve seller default:** confirm new sellers default to `NULL`/`private` (non-professional, 48h applies) — i.e., professional status is admin-granted only, never self-selected. (Recommended.)
3. **48h threshold location:** code constant now (recommended) vs. admin-tunable via `platform_settings` (which, per decision #4, would then need an admin editor). 
4. **Sanity floor for professionals:** even though professionals set their own timing, enforce the minimal `pickup_after_close` floor (pickup_start ≥ end_time) for them too? (Recommended yes — prevents nonsensical config; pros are only exempt from the *48h gap*, not from basic validity.)
5. **Admin override form:** warn-and-proceed-with-audit (recommended) vs. explicit `override:true` flag from the admin UI.
6. **Gap basis:** measure 48h from scheduled `end_time` (recommended, known at config time) vs. actual per-lot soft-close tail (unknown until live).

---

## 9. Recommended implementation order (phased roadmap)

- **Phase A — Planning (this document).** Lock decisions + answer §8. *No code.*
- **Phase B — Type model + admin assignment.** Enum-widening migration (migration leads code) → admin `seller_type` setter endpoint + Sellers-tab control (decision #4). Verify on staging that admins can classify sellers; no validation yet, so zero behavioral risk.
- **Phase C — Validation + override (server, authoritative).** `sellerTypeRules.js` + `auctionService` enforcement: non-pro 48h block, pro exempt, admin override+audit. Validate only on changed schedule fields (grandfathering). Full unit + integration tests.
- **Phase D — Client UX.** Inline "explain why" validation in seller create/edit (mirror; server stays authoritative).
- **Phase E — Hardening / extensibility.** Staging sign-off with seeded identities; framework ready for future per-type rules (preview duration, lead time, etc.) as additive table entries.

Each phase gated on staging validation before the next, mirroring the platform's architecture→validation→implementation cadence. Migrations always lead code.

---

## 10. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Legacy auctions already violate 48h | High | High | Validate only on changed schedule fields; grandfather; no retro-enforcement (decision #5 spirit). |
| 2 | `business` classification ambiguity | Medium | Medium | §8 Q1 — default non-professional; admins re-type true professionals via the new setter. |
| 3 | No assignment path exists today | Certain | Blocks pro exemption | Phase B delivers the admin setter first (decision #4). Until then, safe default = everyone non-professional (48h). |
| 4 | Admin override accidentally hard-blocks admins | Medium | High | §3: admin path warns+audits, never blocks. Test asserts admin can write a violating schedule. |
| 5 | Timezone / clock-skew in 48h math | Medium | Medium | UTC math from stored timestamps; one helper; unit tests with TZ cases; client mirrors exactly. |
| 6 | Enum down-migration unsafe if new values in use | Low | Low | Down script asserts/no-ops when new-type rows exist; additive-only forward. |
| 7 | Scope creep into capabilities / RBAC / governance | Medium | Medium | Explicit non-goal. Framework governs auction *configuration validity by seller type* only. |
| 8 | Professionals set absurd timing (e.g., pickup before close) | Low | Low | Minimal `pickup_after_close` sanity floor for all (§8 Q4). |
| 9 | Threshold later surfaced to admins without an editor | Low | Low | Decision #4 principle (saved to memory) — if surfaced, add the edit path then. Keep code constant in Phase A. |

**Overall:** low-to-moderate, fully front-loaded into planning. The framework is additive, code-owned, server-authoritative, admin-overridable, and backward-compatible by construction.

---

## 11. Explicit non-goals

- ❌ No implementation, schema change, migration, or endpoint change in Phase A.
- ❌ No retroactive enforcement of the 36h rule (decision #5); no 36h logic in the framework at all.
- ❌ No `seller_class` column (classification is code-derived).
- ❌ No change to the existing `business` edit-bypass (`lots.js`) or to `pickupScheduleService`.
- ❌ No governance/RBAC, no analytics, no capabilities-system work.
- ❌ Not Seller Context Navigation (still paused; resumes after this track).

---

*End of Phase A planning document. Awaiting approval and answers to §8 before Phase B (the first phase that touches schema/code) begins.*
