# Seller-Type Business Rules & Enforcement Architecture — Planning Document

*Planning only. No implementation. Investigation requested before resuming Seller Context Navigation. Source of truth for a future implementation task; nothing here is executed yet. Specific rule under evaluation: **Estate Seller auctions must not allow pickup to begin less than 48 hours after auction close**, with the system preventing invalid configuration and explaining why.*

> **Headline findings (verified against current code, 2026-05-31):**
> 1. The `seller_type` enum is **`business | private | other`** (`db/migrations/001_create_schema.sql:29`). **There is no `estate` type** — the rule under evaluation references a seller type that does not yet exist.
> 2. `seller_type` currently drives **exactly one** behavior: business sellers bypass the post-submission edit lock (`src/routes/lots.js:59`). Everything else (capabilities) is schema-only and unenforced (see `project_seller_studio_known_defects` Defect 2).
> 3. **No scheduling validation exists anywhere.** `auctionService.createAuction` / `updateAuction` accept `start_time`, `end_time`, `preview_*`, and `pickup_window_*` as raw whitelisted fields with zero relationship checks; the route layer (`auctions.js`) validates only ownership + required title.
> 4. The CLAUDE.md constraint *"Pickup must begin at least 36 hours after auction end"* is **not enforced in code** — server or client. It is an aspirational rule with no implementation.
> 5. **No seller-type rules engine or validation framework exists.** The one seller-type check is an inline `if`.
>
> **Implication:** this task is not "add one rule to an existing engine" — it is "build the first scheduling-validation layer," with the Estate 48h rule as its first concrete rule and the existing 36h rule as the baseline it should also finally enforce.

---

## 1. Current seller-type architecture

### 1.1 Definition & storage

- **Column:** `seller_profiles.seller_type TEXT CHECK (seller_type IN ('business','private','other'))` — `db/migrations/001_create_schema.sql:29`. Nullable.
- **Ownership chain** (per `project_schema_and_lifecycle`): `users → seller_profiles (user_id) → auctions (seller_id) → lots`. So an auction's seller type is reached via `auctions.seller_id → seller_profiles.seller_type`.
- **Assignment today:** only by seed scripts — `scripts/seed-pilot-accounts.js:81` inserts all pilot sellers as `seller_type='private'`, `capabilities={}`. **There is no signup or admin UI that sets `seller_type`** (the admin capabilities endpoint writes the separate `capabilities` JSONB, not `seller_type`). New self-serve sellers get whatever default the create path assigns (effectively `private`/null).

### 1.2 Where seller_type drives behavior (complete inventory)

| Location | Behavior | Notes |
|---|---|---|
| `src/routes/lots.js:47–61` (`canMutateAuction`) | `seller_type === 'business'` → `business_seller_bypass`: business sellers may edit auctions **after** submission (others are locked). | The **only** behavioral use of `seller_type` in the codebase. |
| `src/routes/admin.js`, `public.js`, `sellers.js` | `seller_type` is **selected for display** (admin sellers list, auction cards, public detail) — read-only, no behavior. | Cosmetic. |
| `seller_profiles.capabilities` (JSONB) | Intended tier/capability gating — **unenforced** (Defect 2). `lots.js` has zero capability checks. | Not a rules system; do not build on it. |

**Conclusion:** `seller_type` is the platform's established (if barely-used) seller discriminator, and the one existing rule keys off it — not off `capabilities`. A seller-type rules framework should therefore key off `seller_type`, for consistency, not off the schema-only capabilities map.

---

## 2. Current enforcement points (scheduling / pickup)

### 2.1 Auction write path — no schedule validation

- **Create:** `POST /api/auctions` (`auctions.js:33–73`) → validates ownership + required `title` only → `auctionService.createAuction` (`auctionService.js:6–61`) inserts time fields raw (`start_time, end_time, preview_*, pickup_window_*`) with no relationship checks.
- **Update:** `PATCH /api/auctions/:id` and admin `PATCH /api/admin/auctions/:id` → `auctionService.updateAuction` (`auctionService.js:72–`) whitelists the same time fields and writes them raw. State transitions are gated; **times are not validated at all**.

### 2.2 Pickup *slot* service — post-close, unrelated to the gap rule

- `src/services/pickupScheduleService.js` generates pickup **sub-slots** after close (category A→B→C ordering, capacity, non-overlap — `_validateTimeSpacing`, `generateSubSlots`). It consumes `auction.pickup_window_start/end` **as given** and never checks them against `end_time`. It is not a place where the "pickup begins ≥ N hours after close" rule could naturally live (it runs post-close, after the window is already set).

### 2.3 Client side — none

No 36h/48h pickup validation in `seller-create.html`, `lot-builder.html`, or `dashboard/lots.html` (the only `pickup` hit is an unrelated A/B/C pickup-tier radio).

### 2.4 Net

The **single chokepoint** every auction schedule write passes through is `auctionService` (`createAuction` + `updateAuction`). That is the correct home for a server-side schedule-validation layer — consistent with CLAUDE.md *"Every important rule must be enforced server-side."*

---

## 3. Existing rule infrastructure

**There is none for business rules of this kind.** Inventory of what exists and why it doesn't fit:

| Candidate | What it is | Fit as a rules engine? |
|---|---|---|
| `lots.js` inline `if (seller_type==='business')` | One hard-coded branch | No — not extensible; it's the symptom this plan generalizes. |
| `permissionRegistry.js` (admin-center Phase A) | Planned RBAC permission atoms | No — **governance/RBAC, explicitly out of scope**; different domain (who-can-act, not how-an-auction-must-be-configured). |
| `seller_profiles.capabilities` JSONB | Admin-writable map | No — schema-only, unenforced (Defect 2); building rules on it would imply behavior that doesn't exist. |
| `pickupScheduleService._validateTimeSpacing` | Post-close slot ordering | No — wrong lifecycle phase; not seller-type aware. |
| `platform_settings` (migration 041) | Key/value platform config | Possible **future** home for tunable thresholds, but not a rules engine. |

So the framework must be **introduced**, small and code-first.

---

## 4. Recommended seller-type rules framework

**Principle:** the smallest thing that generalizes the one existing inline check and gives the Estate 48h rule a home — *not* a heavyweight engine. Code-as-source-of-truth (mirrors the platform's `permissionRegistry`-style discipline), no schema-only traps.

### 4.1 Shape — a declarative rule table + a pure validator

A new module, e.g. `src/services/sellerTypeRules.js`:

```
// Declarative, code-owned. Thresholds default here; may later read platform_settings.
const SELLER_TYPE_RULES = {
  estate:  { minPickupGapHours: 48 },
  default: { minPickupGapHours: 36 },   // the long-stated, never-enforced baseline
};

function rulesForSellerType(sellerType) {
  return SELLER_TYPE_RULES[sellerType] || SELLER_TYPE_RULES.default;
}

// Pure function — no DB. Returns structured violations with human messages.
function validateAuctionSchedule({ sellerType, endTime, pickupWindowStart }) {
  const rules = rulesForSellerType(sellerType);
  const violations = [];
  if (endTime && pickupWindowStart) {
    const gapH = (new Date(pickupWindowStart) - new Date(endTime)) / 3.6e6;
    if (gapH < rules.minPickupGapHours) {
      violations.push({
        rule: 'pickup_min_gap',
        sellerType: sellerType || 'default',
        requiredHours: rules.minPickupGapHours,
        actualHours: Math.round(gapH * 10) / 10,
        message: `${labelFor(sellerType)} auctions require pickup to begin at least `
               + `${rules.minPickupGapHours} hours after the auction closes. `
               + `This pickup starts ${Math.round(gapH)}h after close.`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}
```

Key properties:
- **Pure + DB-free** → trivially unit-testable (the platform values tests for business rules), reusable by both server and a `/dry-run` style preview.
- **Seller-type keyed**, with an explicit `default` so the **36h baseline finally gets enforced** for all seller types as a side benefit — but see §7 risk #1 (legacy data) before turning that on broadly.
- **Structured violations** carry the data needed to "explain why" in both API errors and UI.
- **Extensible**: new rules = new keys in the table + new checks in the validator (see §6).

### 4.2 Enforcement point

Call `validateAuctionSchedule` inside `auctionService.createAuction` and `updateAuction` (the chokepoint, §2.4), **after** resolving the auction's `seller_type` (join `seller_profiles`), **before** the INSERT/UPDATE. On violation, throw a structured error the routes translate to `422 Unprocessable Entity` with the violation messages.

**Validate only when the relevant fields are present/changing.** On `updateAuction`, only run the pickup-gap check when `end_time` or `pickup_window_start` is part of the update (or compute against the stored value for the field not being changed). This avoids blocking unrelated edits to legacy auctions (risk #1).

### 4.3 Admin override (required by CLAUDE.md)

CLAUDE.md: *"Admin override capability must be preserved across all major workflows."* Design:
- Seller writes: **hard-blocked** on violation (422 + explanation).
- Admin writes (`actorRole === 'admin'`): **not hard-blocked.** Recommended: admin receives the violation as a **warning** (returned in the response and written to `audit_log` as `schedule_rule_overridden` with the violation payload), but the write proceeds. This preserves full admin control while keeping an accountable record. (Alternative: require an explicit `override: true` flag from admin UI; recommend the warning+audit form as least-friction and consistent with existing admin-bypass patterns.)

### 4.4 Why a table, not a DB-driven engine

At current scale (a handful of seller types, one rule), a code-owned table is simpler, version-controlled, testable, and diff-reviewable — and avoids the schema-only-capability anti-pattern. Tunable thresholds can later be sourced from `platform_settings` without changing the validator's shape. A full DB rules engine is **not** justified now (and would drift toward governance scope, which is out of bounds).

---

## 5. Estate Seller 48-hour pickup rule — design

### 5.1 Prerequisite: the `estate` seller type must exist

The rule is meaningless until `estate` is a real type. Two options:

| Option | Mechanism | Trade-offs | Recommendation |
|---|---|---|---|
| **A. Extend the enum** | Migration altering the CHECK to `IN ('business','private','other','estate')` | Clean, explicit, consistent with the one existing `seller_type` behavior. One small migration. Needs a way to assign it. | **Recommended.** Keeps the established discriminator authoritative. |
| **B. Capability flag** | `capabilities.estate = true` | No migration, uses admin-writable capabilities endpoint. | **Not recommended** — capabilities are unenforced/schema-only; mixing the rule discriminator across two systems is inconsistent (the existing rule uses `seller_type`). |

**Assignment path (also a prerequisite):** there is no UI/endpoint that sets `seller_type` today. The plan must add a way for admins to mark a seller as `estate` — most cheaply, a small admin field on the existing seller-management surface (or extend the existing `/api/admin/sellers/:id/...` family with a `seller_type` setter). This is a dependency of the rule, called out explicitly.

### 5.2 Rule semantics

- Applies when `auctions.seller_id → seller_profiles.seller_type === 'estate'`.
- Constraint: `pickup_window_start ≥ end_time + 48h`.
- "Auction close" = `end_time` (the scheduled close). *(Open question §8: should the gap be measured from `end_time` or from the actual per-lot soft-close tail? Recommend `end_time` for configuration-time validation, since soft-close extensions are not known until live.)*
- Enforced server-side in `auctionService` per §4.2; mirrored client-side for UX per §6.4.

### 5.3 "Explain why" (the requirement)

- **Server (authoritative):** 422 with body `{ success:false, code:'SCHEDULE_RULE_VIOLATION', violations:[{ rule:'pickup_min_gap', requiredHours:48, actualHours:30, message:"Estate Seller auctions require pickup to begin at least 48 hours after the auction closes. This pickup starts 30h after close." }] }`.
- **Client (UX):** inline validation on the pickup-window field in the seller create/edit flow that shows the same message *before* submit, so invalid config is prevented, not just rejected. Server remains the source of truth.

---

## 6. Future extensibility for additional seller-type rules

The framework is designed so new rules are additive table entries + validator checks. Candidate future rules (illustrative, not committed):

| Rule | Table field | Validator check |
|---|---|---|
| Min preview duration per type | `minPreviewHours` | `preview_end - preview_start ≥ N` |
| Max auction duration | `maxAuctionDays` | `end_time - start_time ≤ N` |
| Min lead time before start | `minLeadHours` | `start_time ≥ now + N` (create only) |
| Estate-only required fields | `requiredFields: [...]` | presence check at submit |

### 6.1 Extensibility rules of the road
- One validator, many checks; each check emits its own structured violation. Routes always return the full `violations[]`.
- Thresholds live in the code table (optionally overridable via `platform_settings` later) — never hard-coded inside the check body.
- Every new rule ships with: a pure unit test, a `default` value, and a decision on admin-override behavior.
- Adding a seller type = one enum value + (optionally) one rules-table entry; absence falls back to `default`.

---

## 7. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Legacy auctions already violate the gap** (rule never enforced) → enabling validation blocks edits/operations on existing rows | High | High | Validate only when `end_time`/`pickup_window_start` are being set/changed; grandfather existing rows; never retro-validate on unrelated PATCHes. Consider enforcing the new 48h only for `estate` initially and treating the 36h `default` as warn-only until legacy data is audited. |
| 2 | **`estate` type doesn't exist / can't be assigned** | Certain (today) | Blocks the feature | §5.1 prerequisites: enum migration + an admin assignment path. Sequence these first. |
| 3 | Enforcing the long-dormant **36h default** surprises current sellers | Medium | Medium | Ship `estate` 48h first (explicit, new); make the `default` 36h warn-only or opt-in until validated against live data. |
| 4 | **Admin override removed by over-eager blocking** (violates CLAUDE.md) | Medium | High | §4.3: admin path warns + audits, never hard-blocks. Test asserts admin can still write a violating schedule. |
| 5 | **Timezone / clock skew** in gap math | Medium | Medium | Compute in UTC from stored timestamps; one helper, unit-tested with TZ cases; mirror exactly on client. |
| 6 | Measuring gap from `end_time` vs. actual soft-close tail | Low | Low | Use scheduled `end_time` for config-time validation; document the choice (§8 open question). |
| 7 | Schema change (enum) touches a core table | Low | Medium | Additive CHECK widening only (no data migration); reversible; standard migration discipline. Out of scope to alter anything else on `seller_profiles`. |
| 8 | Scope creep into RBAC/governance or the capabilities system | Medium | Medium | Explicit non-goal. This framework governs *auction configuration validity by seller type*, not *who may act* (RBAC) and not capabilities. |
| 9 | Duplicated threshold logic drifting between client and server | Medium | Low | Server is authoritative; client mirrors the message text via the same constants where practical, or simply renders the server's returned `violations[]` on failed submit. |

---

## 8. Open questions for approval

1. **Gap basis:** measure the 48h from scheduled `end_time` (recommended) or from the last lot's soft-close tail?
2. **36h default:** finally enforce it for all non-estate types (with legacy grandfathering), or keep it warn-only for now and hard-enforce only `estate` 48h?
3. **`estate` modeling:** confirm Option A (extend `seller_type` enum) over Option B (capability flag).
4. **Assignment UX:** add a `seller_type` setter to the existing admin seller-management surface, or handle estate designation another way?
5. **Admin override form:** warn+audit-and-proceed (recommended) vs. explicit `override:true` flag?
6. **Threshold location:** code constants now (recommended) vs. `platform_settings` for admin tunability from day one?

---

## 9. File-level implementation plan (for a future task — not executed)

> Sequence honors "migration leads code" and "prerequisites first." All server-authoritative per CLAUDE.md.

1. **`db/migrations/0XX_add_estate_seller_type.sql`** (+ `.down.sql`) — widen the `seller_profiles.seller_type` CHECK to include `'estate'`. Additive; reversible. *(Prerequisite, gated on §8 Q3.)*
2. **Admin `seller_type` assignment** — extend the existing `/api/admin/sellers/:id/...` family (and the Sellers-tab UI) with a `seller_type` setter, writing an `audit_log` event. *(Prerequisite, gated on §8 Q4. Pairs naturally with the just-shipped seller-management UI.)*
3. **`src/services/sellerTypeRules.js`** (new) — the declarative `SELLER_TYPE_RULES` table + pure `validateAuctionSchedule()` (§4.1). Ships with unit tests (`tests/sellerTypeRules.test.js`).
4. **`src/services/auctionService.js`** — in `createAuction` and `updateAuction`: resolve the auction's `seller_type`, call the validator on the relevant fields, throw a structured error for seller violations; for admin, attach warning + write `schedule_rule_overridden` audit (§4.2–4.3). *(Additive within the existing functions; no refactor of the field whitelist.)*
5. **`src/routes/auctions.js` (+ admin auction PATCH)** — translate the structured error to `422` with `violations[]`; pass admin warnings through in the response. 
6. **Client (`seller-create.html` / auction edit)** — inline pickup-window validation that renders the rule message before submit, and surfaces the server's `violations[]` on a rejected save. UX only; server stays authoritative.
7. **Tests** — unit tests for the validator (estate 48h, default 36h, boundary, missing fields, TZ); integration tests for seller-blocked vs admin-override-with-audit; a legacy-data regression asserting unrelated PATCHes aren't blocked.

No governance/RBAC change, no analytics, no change to the pickup *slot* service, no capability-system work.

---

## 10. Explicit non-goals

- ❌ Not an RBAC/governance change (this validates auction *configuration*, not *who may act*).
- ❌ Not built on the unenforced `capabilities` system.
- ❌ Not a heavyweight DB rules engine (code-owned table at current scale).
- ❌ Not a change to `pickupScheduleService` (post-close slotting is a different phase).
- ❌ Not analytics; not Tier 3 / Seller Context Navigation (that resumes after this).

---

*End of planning document. Awaiting approval and answers to §8 before any implementation begins. Seller Context Navigation remains paused pending this decision.*
