# Admin Seller Management Actions — Planning Document

*Next increment under the "Admin UX Improvements" priority, following Tier 1 (auction audit visibility, `48b0b70`) and Tier 2 (seller audit visibility, `97836a2`). Does **not** touch governance, RBAC, analytics, schema, migrations, or endpoint design. Reuse-first: this is about exposing functionality that already exists server-side.*

> **Implementation status (S1 — DONE, 2026-05-29).** S1a + S1b implemented exactly as specified in §4.1, §4.2, and §6. The Sellers tab now displays a red **Suspended** badge from the existing `is_active` value, and each row has a state-aware **Suspend / Unsuspend** button that calls the existing `POST /api/admin/sellers/:id/{suspend,unsuspend}` endpoints via the proven Tier 1 prompt→confirm→reload pattern (reason optional, omitted from the body when blank; button disabled while in-flight). Two new handlers (`suspendSeller`, `unsuspendSeller`) plus a `reloadSellersPreservingSearch` helper were added next to the Tier 1 mutation handlers. No backend change, no `api()` change, no Tier 1/Tier 2 code touched. Single file: `public/admin/moderation.html` (+98 lines, additive). Verified via a self-contained headless-browser harness with a mutable suspension flag (16/16 checks: active shows Suspend/no badge; prompt-cancel fires no POST; suspend round-trips prompt+confirm→POST(reason)→badge+Unsuspend flip; unsuspend reverses; **Tier 2 History still works**; no mobile overflow; no JS errors). **S2 (capability editing) intentionally NOT implemented** — deferred per §4.3 (no capability is enforced server-side; an editor would imply non-existent behavior).*

> **Headline finding (verified against current code, 2026-05-29):** Two of the three seller-management endpoints are already complete, admin-gated, audit-writing, and **functionally enforced** — but have **no UI** and are operated only via curl. `suspend` / `unsuspend` set `users.is_active`, which the login path actively rejects (`src/routes/auth.js:62`, `src/services/authService.js:24`). The Sellers tab doesn't even **display** suspension status today. Surfacing suspend/unsuspend (plus a suspension badge) is pure exposure of working functionality — front-end-only, additive. The **third** endpoint (`capabilities`) writes successfully but is **enforced nowhere** (`lots.js` has zero capability checks — Defect 2 still stands), so exposing a capability editor would imply behavior that does not exist. This plan recommends shipping suspend/unsuspend now and **deferring** capability management until at least one capability is enforced.

---

## 1. Current workflow analysis

### 1.1 Sellers tab today (post-Tier 2)

Verified in `public/admin/moderation.html` (`loadSellers`, lines 1461–1519) and `GET /api/admin/sellers` (`src/routes/admin.js:733–761`).

1. Moderator opens `/admin/moderation.html` → **Sellers** tab → search box + **Show All**, both call `loadSellers(search)`.
2. Each seller renders as a `.row-item` showing:
   - `.row-title` → `s.email`
   - `.row-meta` → `seller_type · N auction(s) · <enabled capability keys, cosmetic> · joined <date>`
   - **Tier 2 History button** (per-row audit timeline).
3. **What's missing:** the row has **no suspend/unsuspend control**, and it does **not display `is_active`** — even though the endpoint returns it. A moderator literally cannot tell from the UI whether a seller is currently suspended, nor act on it without curl.

### 1.2 Suspend / unsuspend — fully functional, just hidden

- `POST /sellers/:sellerId/suspend` sets `users.is_active = false`.
- The login path enforces this: `auth.js:62` returns a clear rejection when `user.is_active === false`; `authService.js:24` mirrors it. So suspension is **real account lockout**, not cosmetic.
- `unsuspend` reverses it (`is_active = true`).
- Both are idempotency-aware (see §2), capture an optional `reason` to the audit log, and guard against redundant transitions (409 if already in target state).

**Conclusion:** this is working, enforced functionality with no front door. Exposing it is the highest-value, lowest-risk action in this task.

### 1.3 Capability management — writable but inert

- `POST /sellers/:sellerId/capabilities` merges an arbitrary key/value object into `seller_profiles.capabilities` (JSONB) and audits before/after.
- **No code reads capabilities to gate anything.** `grep` of `src/routes/lots.js` for `capabilities` / `reserve_visible` / `reserve_cents` → **no matches**. The capability system is schema-only (confirmed by `project_seller_studio_known_defects` Defect 2). The only consumers are (a) the cosmetic `caps.join(', ')` line in the seller row and (b) the Tier 2 audit diff.
- Therefore a generic capability editor would let a moderator toggle keys that change **nothing** in seller/buyer behavior — the same trap the known-defects memo warns about ("Do not present the existing reserve toggle UI as a working feature").

**Conclusion:** there is no capability *functionality* to expose yet — only a data field. Recommend deferring a capability-management UI (see §4.3 and §8).

---

## 2. Existing endpoints inventory

All under `src/routes/admin.js`, all `auth` + `role(['admin'])` + `idempotency` middleware, all write `audit_log` via the non-blocking `writeAuditLog`.

| Endpoint | Lines | Body | Behavior | Status codes | Audit event |
|---|---|---|---|---|---|
| `POST /api/admin/sellers/:sellerId/suspend` | 172–200 | `{ reason?: string }` | `users.is_active = false` (enforced at login) | 200; 404 no profile; 409 already suspended | `seller_suspended` |
| `POST /api/admin/sellers/:sellerId/unsuspend` | 205–233 | `{ reason?: string }` | `users.is_active = true` | 200; 404 no profile; 409 not suspended | `seller_unsuspended` |
| `POST /api/admin/sellers/:sellerId/capabilities` | 243–276 | object of `{ key: value }` (merged) | merges into `capabilities` JSONB; **not enforced anywhere** | 200; 400 non-object; 404 no profile | `seller_capabilities_changed` |
| `GET /api/admin/sellers` | 733–761 | — | list w/ `seller_profile_id, seller_type, capabilities, is_active, email, auction_count, …` | 200 | — (read) |

**`:sellerId` is `seller_profiles.id`** (not user id) across all three — the same value the Sellers list returns as `seller_profile_id` and the same `entity_id` the Tier 2 History panel already filters on.

### Idempotency contract (verified `src/middleware/idempotency.js`)

- **Opt-in.** No `idempotency-key` header → middleware calls `next()` (pass-through). The endpoints work without it.
- With a key: first call claims a slot; duplicate completed call replays the stored response; in-flight duplicate → 409 ("Request already in progress"); stale (>30s) slots are reclaimed.
- **UI implication:** sending an `Idempotency-Key` would prevent a double-click from creating two audit rows / hitting a 409 race. But the existing `api(method, url, body)` helper (`moderation.html:596`) sends only `Authorization` + `Content-Type` — it cannot pass a custom header without modification. To stay additive/no-refactor, either (a) skip idempotency and disable the button while in-flight, or (b) use a one-off `fetch` with the header inside the new handler. See §6.

---

## 3. Existing audit event inventory (already surfaced by Tier 2)

| Event | Written by | `metadata` | Already rendered? |
|---|---|---|---|
| `seller_suspended` | suspend endpoint | `{ user_id, email, reason }` | ✅ Tier 2 reason-box branch |
| `seller_unsuspended` | unsuspend endpoint | `{ user_id, email, reason }` | ✅ Tier 2 reason-box branch |
| `seller_capabilities_changed` | capabilities endpoint | `{ before, after, changed_keys }` | ✅ Tier 2 capability-diff branch |

**This is the clean synergy:** every action this task would expose is *already* audit-visible per-seller via the Tier 2 History button. Surfacing the action and surfacing its history close the loop — act, then immediately review, in the same row. No new audit work is required.

---

## 4. Recommended UI placement

### 4.1 Display suspension status (S1a) — pure additive display

Add a **Suspended** badge to the row (rendered only when `s.is_active === false`), next to the email or in `.row-meta`. Mirror the existing badge styling (the page already has `.badge` variants used for auction states). This alone is a meaningful fix: moderators can finally *see* who is suspended. Zero behavior, no endpoint call.

### 4.2 Suspend / Unsuspend control (S1b) — expose working functionality

Add one state-aware button per row in the same action area as the Tier 2 History button:
- `s.is_active === false` → **Unsuspend** button → `POST …/unsuspend`.
- otherwise → **Suspend** button → `POST …/suspend`.

Interaction pattern mirrors the **proven Tier 1 GOV-RET/GOV-REJ flow** (`returnToDraft` / `rejectAuction` in `moderation.html`): a `prompt()` collects an optional reason, a `confirm()` gates the access-blocking suspend, then the existing `api()` call fires and the list reloads (`loadSellers`) so the badge + button flip. Reason is optional server-side but recommended (it lands in the audit + Tier 2 History).

This is placement-consistent with Tier 1 (action button on the card/row) and Tier 2 (History button on the row), giving the Sellers tab a coherent **see status → act → review history** loop.

### 4.3 Capability management (S2) — recommend DEFER

Because no code enforces capabilities (§1.3), a capability editor would be a UI that *appears* to grant/revoke seller abilities while changing nothing. That violates the reuse-first principle (there is no *functionality* to reuse — only a data field) and repeats the documented "reserve toggle that does nothing" anti-pattern. **Recommendation: do not build a capability editor in this task.** Revisit only after at least one capability key is actually read + enforced server-side (a separate, larger piece of work). If the operator still wants write access sooner, the fallback is a clearly-labeled "Advanced (not yet enforced)" editor — but that is explicitly *not* recommended here.

---

## 5. Moderator/admin workflow mockup

**Sellers tab row — before (today):**
```
┌──────────────────────────────────────────────────────────────┐
│ jane.seller@example.com                            [ History ] │
│ private · 3 auctions · reserve_pricing · joined May 2, 2026    │
└──────────────────────────────────────────────────────────────┘
```

**After S1 (active seller):**
```
┌──────────────────────────────────────────────────────────────┐
│ jane.seller@example.com                 [ Suspend ] [ History ]│
│ private · 3 auctions · reserve_pricing · joined May 2, 2026    │
└──────────────────────────────────────────────────────────────┘
```

**After S1 (suspended seller):**
```
┌──────────────────────────────────────────────────────────────┐
│ jane.seller@example.com  [SUSPENDED]  [ Unsuspend ] [ History ]│
│ private · 3 auctions · joined May 2, 2026                      │
└──────────────────────────────────────────────────────────────┘
```

**Suspend interaction (mirrors Tier 1 reject flow):**
```
[ Suspend ] →
  prompt:  "Reason for suspending jane.seller@example.com? (optional —
            the seller does not see this; it is recorded for the audit log)"
  confirm: "Suspend jane.seller@example.com? They will be unable to log in
            until unsuspended."
  → POST /api/admin/sellers/<id>/suspend { reason }
  → reload sellers; row now shows [SUSPENDED] + [ Unsuspend ]
  → (Tier 2) clicking History shows the new seller_suspended entry with reason + actor
```

---

## 6. File-level implementation plan

> For a future implementation task. **Not executed here.** Single file; all changes additive. Mirrors the Tier 1/Tier 2 cadence and reuses existing helpers (`el`, `api`, `escText`, `showMsg`, badge styles, the `prompt`/`confirm`/reload pattern).

**`public/admin/moderation.html`** — the only file touched.

1. **Seller row builder** (`loadSellers`, ~1472–1517): after `main`/before or alongside the Tier 2 History button:
   - **S1a:** if `s.is_active === false`, append a **Suspended** badge (reuse a `.badge` variant) to `main` or the action area.
   - **S1b:** append a state-aware button — `Unsuspend` when `s.is_active === false`, else `Suspend` — guarded on `s.seller_profile_id`. Wire to `suspendSeller` / `unsuspendSeller`.
   - Keep the Tier 2 History button and its panel exactly as-is.
2. **New functions `suspendSeller(sellerProfileId, email)` and `unsuspendSeller(sellerProfileId, email)`** (placed near the Tier 1 `returnToDraft`/`rejectAuction` handlers for consistency):
   - `prompt()` for optional reason; for `suspend`, a `confirm()` first (access-blocking).
   - Disable the triggering button while in-flight (double-submit guard).
   - Call existing `api('POST', '/api/admin/sellers/<id>/{suspend|unsuspend}', { reason })`.
   - On success: `loadSellers(currentSearch)` to refresh badge + button; on 409/404/error: surface via `showMsg('sellers-status', …, true)` or inline status.
   - *(Optional hardening, not required):* to send an `Idempotency-Key`, use a one-off `fetch` with the header in this handler instead of `api()` — avoids refactoring `api()`. Default plan: rely on the in-flight button disable; idempotency optional.
3. **(Deferred) capability editor** — not implemented; documented in §4.3 / §8.

No backend, route, service, middleware, migration, schema, or test-fixture changes. No change to Tier 1 or Tier 2 code.

---

## 7. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Suspending blocks the seller's login entirely | Certain (intended) | High | This is the feature working as designed; reversible via Unsuspend. `confirm()` dialog + reason capture + immediate Tier 2 History visibility. |
| 2 | Suspending a user who is *also* an admin locks out admin access | Low | High | `users.is_active=false` blocks all logins for that user. Admins rarely have `seller_profiles` (only such users appear in the list). **Flag operationally**; do not add new enforcement (no RBAC changes permitted). Note in the confirm copy that suspension blocks all login for that account. |
| 3 | Double-click creates duplicate audit rows / 409 race | Medium | Low | Disable button while in-flight; optional `Idempotency-Key` via one-off fetch (§2/§6). The endpoint's 409-on-redundant-transition also protects against the second click changing state. |
| 4 | Exposing a capability editor implies non-existent functionality | — | High | **Avoided by deferring S2** (§4.3). The whole capability-editor surface is out of scope for this task. |
| 5 | New button/badge breaks `.row-item` flex layout / mobile overflow | Low | Low | `.row-item` is `flex-wrap:wrap`; buttons are `flex-shrink:0` (same pattern Tier 2 used successfully). Verify 390px no-overflow (existing page-wide test asserts this). |
| 6 | XSS via email/reason | Low | Medium | Reason is sent to the server and re-displayed only via the already-escaping Tier 2 History (`escText`). Badge/email rendered via `el(...textContent)` (auto-escaped). No raw `innerHTML` of user data. |
| 7 | Scope creep into governance/RBAC (e.g., "who may suspend whom") | Medium | Medium | Out of scope. The endpoint is already `role(['admin'])`-gated; this task only adds a button that calls it. No permission model changes. |
| 8 | Reloading the whole seller list after each action feels heavy | Low | Low | Matches Tier 1's reload-after-mutation pattern; list is capped at 50 and the call is cheap. Acceptable; can optimize later if needed. |

**Overall risk: low for S1, deliberately avoided for S2.** S1 is front-end-only exposure of enforced, audit-backed endpoints using patterns already proven in Tier 1/Tier 2.

---

## 8. Recommended implementation order

1. **S1a — display suspension status** (Suspended badge from `is_active`). Smallest, zero-behavior, immediately useful; ship first.
2. **S1b — Suspend / Unsuspend buttons + handlers** (reason prompt + confirm + reload), reusing the Tier 1 mutation pattern and the existing `api()`.
3. **Manual staging validation** — using seeded validation identities (`project_validation_identities`; no speculative credentials): suspend a seeded seller, confirm login is rejected, confirm the badge/button flip and the Tier 2 History entry appears with reason + actor; then unsuspend and confirm reversal. Verify mobile (390px) no-overflow.
4. **S2 — capability management: DEFER.** Revisit only after a capability key is actually enforced server-side. Documented here so the decision is explicit, not forgotten.

Each S1 step is independently shippable and revertable (a contiguous additive block in one file). Mirrors the established cadence: implement → mocked/headless self-check → staging sign-off.

---

## 9. Explicit non-goals (scope guard)

- ❌ No backend/endpoint change (suspend/unsuspend/capabilities + the sellers list all already exist and return what's needed).
- ❌ No schema, migration, governance, RBAC, or analytics work.
- ❌ No capability-enforcement logic and **no capability-editor UI** (deferred — no functionality to expose yet).
- ❌ No change to Tier 1 or Tier 2 code, and no change to `api()` (idempotency, if wanted, via a one-off fetch).
- ❌ No new audit writers or event types (the three seller events already exist and are already rendered).
- ❌ No buyer- or seller-facing change; this is admin-tab-only.
- ❌ Not Tier 3 global Activity view (still deferred, separate track).

---

*End of planning document. Awaiting approval before any implementation begins.*
