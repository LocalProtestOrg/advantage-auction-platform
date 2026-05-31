# Seller-Type Rules Framework — Phase B Planning Document

*Builds on the approved Phase A plan (`docs/seller-type-rules-framework-phase-a-plan.md`) and the owner's locked answers to the Phase A open questions. Phase B is **type model + admin assignment + audit only** — it deliberately ships **no validation** (that is Phase C), so it has zero behavioral effect on auctions/pickup.*

> **Implementation status (Phase B — DONE in working tree, 2026-05-31; migration pending staging apply).** Implemented per this plan:
> - **Migration `051_expand_seller_type.sql`** — widens the `seller_type` CHECK to the six values and `SET DEFAULT 'private'` (Q2). Forward-only/idempotent per repo convention (no `.down.sql`; rollback documented as a comment). **Not yet applied to a DB** — staging apply via `scripts/run-migrations.js` is the operator step (migration leads code).
> - **`src/constants/sellerTypes.js`** (new) — single source of truth (`SELLER_TYPES`, `PROFESSIONAL_SELLER_TYPES`, labels, `isValidSellerType`); reused by Phase C.
> - **`POST /api/admin/sellers/:sellerId/seller-type`** (`admin.js`) — admin-gated, validated against `SELLER_TYPES`, writes the value, records `seller_type_changed` (before/after) only on an actual change.
> - **Sellers-tab `<select>` editor** + `setSellerType` handler (decision #4) + a `seller_type_changed` `prettyAdminMetadata` branch.
> - **Verification:** offline checks (backend `node --check`, constants assertions, inline-script syntax) + a headless harness (14/14: select reflects current value, change→confirm→POST→reload flip, cancel reverts with no POST, audit renders in History, "(unset)" placeholder for legacy NULL, S1/Tier 2 controls intact, no JS errors, no mobile overflow). Jest baseline unchanged (22 pass; 4 pre-existing `bid.test.js` failures, unrelated).
> - **No Phase C behavior:** no validator, no pickup enforcement, no override. Assigning a professional type has no functional effect yet.

## Locked decisions carried into Phase B

| # | Decision | Phase B consequence |
|---|---|---|
| Q1 | Legacy `business` sellers stay **non-professional** | No reclassification/backfill of `business`. |
| Q2 | New sellers default to **`private`** until an admin assigns a professional type | Realized as a **DB column DEFAULT** (see §1 — there is no app-level creation path to attach it to). |
| Q3 | Professionals exempt from 48h but pickup must still be **after close** | Phase C validator concern; noted, not enforced in B. |
| Q4 | Thresholds live in code (`sellerTypeRules.js`); **no `platform_settings`** | Phase B introduces a shared valid-types constant only; no config table. |
| Q5 | Admin overrides require a **reason** + `schedule_rule_overridden` audit | That override event is Phase C; Phase B adds the **`seller_type_changed`** audit event. |
| Q6 | Gap basis = `auction.end_time` | Phase C concern; noted. |

> **Decisive Phase B finding (verified 2026-05-31):** registration (`auth.js:22–25`) creates only a `users` row with `role='buyer'`; **no code in `src/` ever inserts `seller_profiles`** (only `scripts/seed-demo-data.js` — NULL type — and `scripts/seed-pilot-accounts.js` — `'private'`). There is no self-serve seller-onboarding/profile-creation path. **Therefore Q2's `private` default cannot live in application code — it belongs as a DB `DEFAULT 'private'` on the column**, which covers every future insert (seed or a future onboarding flow) automatically. This is the cleanest, decision-honoring home and is additive/backward-compatible.

---

## 1. seller_type migration design (Migration 051 — designed, NOT executed)

Latest migration on disk is **050**; Phase B is **`051`**. The existing constraint is an inline column CHECK (`migration 001:29`), which Postgres auto-names **`seller_profiles_seller_type_check`**.

### 1.1 Forward — `db/migrations/051_expand_seller_type.sql`

```sql
-- 1. Widen the allowed set additively (existing rows remain valid).
ALTER TABLE seller_profiles DROP CONSTRAINT IF EXISTS seller_profiles_seller_type_check;
ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_seller_type_check
  CHECK (seller_type IN (
    'business','private','other',                                  -- existing (preserved)
    'auction_house','estate_sale_company','professional_liquidator' -- new professional types
  ));

-- 2. Realize Q2: new inserts default to 'private' (there is no app creation path
--    to attach this to). Affects FUTURE inserts only; existing rows untouched.
ALTER TABLE seller_profiles ALTER COLUMN seller_type SET DEFAULT 'private';
```

- **Additive & backward-compatible:** every existing row (`business`/`private`/`other`/NULL) stays valid. No data rewrite.
- **No `seller_class` column** — professional/non-professional is code-derived (Phase A decision).
- **Constraint name:** confirm `seller_profiles_seller_type_check` at implementation time via `information_schema.table_constraints` before relying on it; the `DROP … IF EXISTS` + re-`ADD` pattern is safe regardless.

### 1.2 Down — `db/migrations/051_expand_seller_type.down.sql`

```sql
ALTER TABLE seller_profiles ALTER COLUMN seller_type DROP DEFAULT;
ALTER TABLE seller_profiles DROP CONSTRAINT IF EXISTS seller_profiles_seller_type_check;
ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_seller_type_check
  CHECK (seller_type IN ('business','private','other'));
```

- **Caveat (documented):** the down migration will **fail if any row already holds a professional type**. Rollback procedure: re-type those sellers to a legacy value first, then run down. This is the expected one-way-ish nature of an enum widening once used.

### 1.3 Existing-NULL rows — leave as-is (recommended)

Existing rows with `seller_type IS NULL` (e.g., demo-seed sellers) are **already classified non-professional** by the Phase A code map (NULL → non-professional), identical in behavior to `'private'`. A backfill `UPDATE … SET seller_type='private' WHERE seller_type IS NULL` is **optional cosmetic cleanup**, not required, and is a data change — recommend **not** doing it in 051 to keep the migration purely structural/additive. (If desired later, it's a trivial separate step.)

---

## 2. Admin assignment workflow

### 2.1 New endpoint (designed) — set a seller's type

Mirror the existing, proven admin seller-mutation pattern (`POST /api/admin/sellers/:sellerId/capabilities`, `/suspend`, `/unsuspend`): `auth` + `role(['admin'])` + `idempotency`, audit on success.

```
POST /api/admin/sellers/:sellerId/seller-type      (admin.js, new handler)
  middleware: auth, role(['admin']), idempotency
  body: { seller_type: string }
  1. Validate seller_type ∈ SELLER_TYPES (the 6 valid values) → 400 if not.
  2. SELECT id, seller_type FROM seller_profiles WHERE id = :sellerId → 404 if none.
  3. If unchanged → 200 no-op (or 409 'already that type'); recommend idempotent 200.
  4. UPDATE seller_profiles SET seller_type = $1 WHERE id = :sellerId RETURNING id, seller_type.
  5. writeAuditLog({ event_type:'seller_type_changed', entity_type:'seller_profile',
                     entity_id: sellerId, actor_id: req.user.id,
                     metadata: { before, after } }).
  6. Respond { success:true, data:{ seller_profile_id, seller_type } }.
```

- **Valid-types source of truth:** introduce a tiny shared constant module **`src/constants/sellerTypes.js`** exporting `SELLER_TYPES` (all six) — imported by this endpoint in Phase B and **reused by `sellerTypeRules.js` in Phase C** (which adds `PROFESSIONAL_SELLER_TYPES`). One list, no drift. *(This module is the only new server file in Phase B.)*
- **Verb:** `POST …/seller-type` chosen for consistency with the sibling seller-mutation endpoints (all `POST`). A `PATCH` on the seller resource would be equally valid but diverges from the established family.
- **No validation side effects:** changing a seller's type in Phase B does **not** trigger any auction/pickup validation (Phase C wires that). So this endpoint is behaviorally inert beyond the type write + audit — minimal risk.

### 2.2 Who can be assigned what

- Any of the six values is assignable by an admin (admins have unrestricted control — Product Priority #1).
- Professional designation is **admin-only** (Q2): there is no self-serve path to professional. New sellers are `private` by DB default.

---

## 3. Seller-type editing in Admin (Sellers tab)

Decision #4 (saved to memory: *admin-visible settings need an admin edit path*) makes this mandatory — `seller_type` is already **displayed** in the Sellers tab (`loadSellers` row meta) but is **read-only** today.

### 3.1 UI design (designed, not implemented)

In the seller row action area (alongside the shipped **Suspend/Unsuspend** and **History** controls), add a compact **seller-type editor**:

- A `<select>` pre-set to the seller's current `seller_type` (reusing `s.seller_type` already in the loaded row), listing the six values with friendly labels and a visual professional/non-professional grouping, e.g.:
  - *Non-professional:* Private, Business, Other
  - *Professional:* Auction House, Estate Sale Company, Professional Liquidator
- On change → a `confirm()` ("Change <email> to <Type>? Professional types are exempt from the 48-hour pickup rule.") → `setSellerType(sellerProfileId, newType, selectEl)` posts to the new endpoint, disables the control while in-flight, then `reloadSellersPreservingSearch()` (the helper already added for S1) so the row reflects the new value.
- On failure: revert the `<select>` to the prior value and surface via `showMsg('sellers-status', …, true)`.

This makes the setting **visible and editable in one control** (decision #4), mirrors the existing row-action patterns, and reuses the S1 reload helper. The new `seller_type_changed` audit event is then immediately reviewable via the **Tier 2 History** button on the same row (which already filters `entity_type=seller_profile`).

### 3.2 Why a `<select>`, not a prompt

Suspend/unsuspend used `prompt`/`confirm` because they collect free-text reasons. Seller-type is a closed set of six values → a `<select>` is the correct, lower-error control and makes the current value visible at a glance (serving decision #4 better than a hidden prompt).

---

## 4. Audit logging for seller-type changes

- **Event:** `seller_type_changed`, `entity_type='seller_profile'`, `entity_id=<seller_profiles.id>`, `actor_id=<admin>`, `metadata={ before, after }` — same shape/family as the existing `seller_capabilities_changed` / `seller_suspended` events, written via the non-blocking `writeAuditLog`.
- **Auto-surfaced:** because it is a `seller_profile`-entity event, the **Tier 2 per-seller History panel already displays it** (the panel filters `entity_type=seller_profile&entity_id=…`). No History-wiring work needed.
- **Optional polish (additive):** add one `prettyAdminMetadata` branch for `seller_type_changed` (render `before → after`), mirroring the Tier 2 `seller_capabilities_changed` branch. Without it, the event renders via the safe JSON fallback. Recommend including it for a clean first impression — it's a 1-branch additive change, the same pattern already shipped.
- **No reason required for type changes** (unlike suspend). Q5's *reason* requirement is specifically for **rule overrides** (`schedule_rule_overridden`, Phase C), not for type assignment.

---

## 5. Backward compatibility strategy

| Concern | Outcome |
|---|---|
| Existing rows (`business`/`private`/`other`/NULL) | Remain valid; not rewritten. NULL behaves as non-professional (== private). |
| Legacy `business` edit-bypass (`lots.js:~59`) | **Untouched.** Phase B adds no behavior to lot/auction mutation. |
| Existing `GET /api/admin/sellers` response shape | Unchanged (already returns `seller_type`); the UI editor consumes the existing field. |
| Auction/pickup behavior | **No change in Phase B** — no validator is wired until Phase C. Assigning a professional type has no functional effect yet. |
| New inserts | Default to `'private'` via the column DEFAULT (Q2). |
| CHECK widening | Additive; forward-safe. Down migration documented (fails if professional rows exist — re-type first). |
| Tier 1 / Tier 2 / S1 features | Unaffected; the new editor and audit event are additive siblings. |

**Net:** Phase B is a quiet, additive enablement layer — it makes the type model and the admin assignment path real, with zero change to any existing behavior. The 48h rule does nothing until Phase C.

---

## 6. File-level implementation plan for Phase B (for a later task — NOT executed now)

> Order honors "migration leads code." All changes additive; no refactor of existing handlers.

| # | File | Change |
|---|---|---|
| 1 | `db/migrations/051_expand_seller_type.sql` (+ `.down.sql`) | Widen CHECK to 6 values; `SET DEFAULT 'private'` (§1). Deploy + verify on staging **first**. |
| 2 | `src/constants/sellerTypes.js` (new) | Export `SELLER_TYPES` (the six valid values) + friendly labels. Single source of truth; reused by Phase C. |
| 3 | `src/routes/admin.js` | New `POST /sellers/:sellerId/seller-type` handler (auth+admin+idempotency): validate against `SELLER_TYPES`, update, `writeAuditLog('seller_type_changed', {before,after})` (§2). |
| 4 | `public/admin/moderation.html` | Sellers row: add the `<select>` type editor + `setSellerType()` handler (reuse `reloadSellersPreservingSearch`); add the optional `seller_type_changed` `prettyAdminMetadata` branch (§3, §4). |
| 5 | `tests/` (+ e2e) | Migration test (CHECK accepts new values, rejects junk; DEFAULT applies). Endpoint test (valid set, 400 on junk, 404 on missing profile, audit row written). UI/headless check (select renders current value, change → POST → reload → audit visible via History). |

No change to `auctionService`, `lots.js`, `pickupScheduleService`, governance, RBAC, analytics, or `platform_settings`. **No validation logic** (Phase C).

---

## 7. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | CHECK constraint name differs from `seller_profiles_seller_type_check` | Low | Low | `DROP CONSTRAINT IF EXISTS` + verify via `information_schema` at implementation; re-`ADD` is name-stable. |
| 2 | Down migration fails because a professional-type row exists | Medium (after use) | Low | Documented rollback: re-type affected sellers to a legacy value first. Expected for enum widening. |
| 3 | DEFAULT `'private'` unexpectedly changes existing NULL rows | None | — | `SET DEFAULT` affects future inserts only; existing NULLs unchanged (and already behave as non-professional). |
| 4 | Admin mis-assigns a professional type → seller would later be 48h-exempt | Low | Medium | Confirm dialog naming the consequence; `seller_type_changed` audit + Tier 2 History give full traceability/reversal. Validation impact only lands in Phase C anyway. |
| 5 | Valid-types list drifts between endpoint (B) and rules module (C) | Medium | Medium | Single shared `src/constants/sellerTypes.js` imported by both. |
| 6 | Row UI crowding on mobile (select + existing buttons) | Low | Low | `.row-item` is `flex-wrap:wrap`; the select wraps like the existing controls. Verify 390px no-overflow (headless check). |
| 7 | Assigning type implies the 48h rule is already active (it isn't, until C) | Low | Low | Confirm-dialog/label wording can note rules take effect with the framework; keep expectations accurate. Sequencing B→C is internal. |
| 8 | Scope creep into onboarding/profile-creation (none exists) | Medium | Medium | **Out of scope.** Phase B uses the DB DEFAULT for new inserts; building a self-serve seller-onboarding/profile-creation flow is a separate, larger effort (flagged below, not in B). |

**Note flagged for the owner (not Phase B work):** the absence of any application-level `seller_profiles` creation path is a real gap — today only seeds create seller profiles. Phase B's DB DEFAULT makes the eventual onboarding flow "just work" for the `private` default, but the onboarding flow itself remains unbuilt. Worth a future track; out of scope here.

---

## 8. Recommended implementation order (within Phase B)

1. **Migration 051** (CHECK widen + DEFAULT `'private'`) → deploy to staging, verify existing logins/sellers unaffected, verify new values accepted and junk rejected. *Migration leads code.*
2. **`src/constants/sellerTypes.js`** → the shared valid-types list.
3. **Admin endpoint** `POST /sellers/:id/seller-type` (validate + update + `seller_type_changed` audit).
4. **Sellers-tab editor** (`<select>` + `setSellerType` + optional pretty branch).
5. **Tests + staging validation** with seeded identities (`project_validation_identities`; no speculative credentials): assign each professional type to a seeded seller, confirm the value persists, the audit event appears in the Tier 2 History panel, and no auction/pickup behavior changes (since Phase C isn't wired). Confirm mobile no-overflow.

Each step is additive and independently revertable. Phase B exit criteria: admins can classify any seller via the UI, every change is audited and visible in History, and **no existing behavior has changed** — leaving Phase C (validation + override) to be the first behavioral change.

---

## 9. Explicit non-goals (Phase B scope guard)

- ❌ No validation logic, no `sellerTypeRules.js` validator, no `auctionService`/pickup enforcement (Phase C).
- ❌ No `schedule_rule_overridden` override flow (Phase C, Q5).
- ❌ No `platform_settings` / admin-tunable thresholds (Q4 — thresholds stay in code, introduced in C).
- ❌ No change to the `business` edit-bypass, `pickupScheduleService`, governance, RBAC, or analytics.
- ❌ No self-serve seller-onboarding / profile-creation flow (gap noted; separate track).
- ❌ No retroactive 36h enforcement (Q-A5); no data backfill of legacy rows.
- ❌ Not Seller Context Navigation (still paused; resumes after this framework track).

---

*End of Phase B planning document. Awaiting approval before Phase B implementation (Migration 051 first). Phase C (validation + admin override) will be planned after Phase B is approved/landed.*
