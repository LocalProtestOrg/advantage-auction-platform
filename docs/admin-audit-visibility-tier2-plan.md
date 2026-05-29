# Admin Audit Visibility — Tier 2 Planning Document (Per-Seller Audit History)

*Second increment under the "Admin UX Improvements" priority, following Tier 1 (commit `48b0b70`, shipped + pushed). Supersedes the high-level Tier 2 sketch in §3/§5 of [`docs/admin-audit-visibility-plan.md`](./admin-audit-visibility-plan.md) with verified, file-level detail. Does **not** touch governance, RBAC, analytics, schema, or any endpoint design.*

> **Implementation status (Tier 2 — DONE, 2026-05-29).** Implemented exactly as specified in §4 and §6 — including the optional §4.3 `prettyAdminMetadata` polish branches. A per-seller **History** button now appears on every Sellers-tab row (when `seller_profile_id` is present), wired to a new thin `toggleSellerAudit()` that calls the **existing** `GET /api/admin/audit-log?entity_type=seller_profile&entity_id=<id>` and reuses the **existing** `prettyAdminMetadata()`/`escText()`/`api()`. `toggleAuditLog` and all Tier 1 code are untouched (no refactor). Three additive `prettyAdminMetadata` branches render `seller_suspended`/`seller_unsuspended` (reason box) and `seller_capabilities_changed` (before→after diff). Single file touched: `public/admin/moderation.html` (+97 lines, additive). Verified via a self-contained headless-browser harness (13/13 checks: History on seller rows, seller-scoped audit populates, both metadata branches render, reason XSS escaped, toggle off, **Tier 1 auction History still works**, no mobile overflow with panel open, no JS errors). **Tier 3 remains deferred.** No backend change was required.*

> **Headline feasibility finding (verified against current code, 2026-05-29):** Tier 2 can be delivered with **zero backend changes**. `GET /api/admin/sellers` already returns `seller_profile_id`, and every seller audit event is written with `entity_type = 'seller_profile'` and `entity_id = <seller_profiles.id>`. Those two ids are the *same value*, so `GET /api/admin/audit-log?entity_type=seller_profile&entity_id=<seller_profile_id>` — an already-supported query on the existing OPS-4 endpoint — returns exactly the seller's history. The work is front-end-only and additive: a **History** button per seller row plus a thin seller-scoped fetch wrapper that reuses the existing `prettyAdminMetadata()` renderer.

---

## 1. Workflow analysis (Sellers tab, as it exists today)

Verified in `public/admin/moderation.html` (`loadSellers`, lines 1394–1422) and `src/routes/admin.js` (`GET /api/admin/sellers`, lines 733–761).

### 1.1 Current Sellers tab journey

1. Moderator opens `/admin/moderation.html` → **Sellers** tab (`data-tab="sellers"`).
2. The tab presents a search form (`#seller-search`) and a **Show All** button; both call `loadSellers(search)`.
3. `loadSellers` fetches `GET /api/admin/sellers?search=<q>` and renders one `.row-item` per seller:
   - `.row-title` → `s.email`
   - `.row-meta` → `seller_type · N auction(s) · <enabled capabilities> · joined <date>`
4. **There are no per-row action buttons today.** The Sellers tab is read-only display. Suspend / unsuspend / capabilities are real endpoints (`POST /api/admin/sellers/:id/{suspend,unsuspend,capabilities}`) but have **no UI surface** in this tab — they are operated out-of-band (curl/API). *(Surfacing those write actions is explicitly out of scope for Tier 2 — this task is audit visibility only.)*

### 1.2 The gap Tier 2 closes

Seller-scoped audit events (`seller_suspended`, `seller_unsuspended`, `seller_capabilities_changed`) are written with `auction_id = NULL`. Tier 1's card-level History button filters by `auction_id`, so **these events are invisible from every existing UI path**:
- The auction History panel (Tier 1) filters `?auction_id=…` → never returns NULL-auction rows.
- The Sellers tab renders no audit affordance at all.

Result: today there is **no way in the admin UI** to answer "when was this seller suspended, by whom, and why?" or "who changed this seller's capabilities?" — even though the data is captured and an endpoint already serves it. Tier 2 surfaces it.

---

## 2. Seller audit event inventory

Verified writers in `src/routes/admin.js`. All three use the non-blocking `writeAuditLog` helper (`src/lib/auditLog.js`), `entity_type = 'seller_profile'`, `entity_id = :sellerId` (the route param, which is `seller_profiles.id`), `actor_id = req.user.id` (the acting admin).

| Event type | Source | `entity_id` | `metadata` shape | Notes |
|---|---|---|---|---|
| `seller_suspended` | `POST /sellers/:sellerId/suspend` (admin.js:189) | `seller_profiles.id` | `{ user_id, email, reason }` | `reason` is optional (nullable) |
| `seller_unsuspended` | `POST /sellers/:sellerId/unsuspend` (admin.js:222) | `seller_profiles.id` | `{ user_id, email, reason }` | `reason` optional |
| `seller_capabilities_changed` | `POST /sellers/:sellerId/capabilities` (admin.js:265) | `seller_profiles.id` | `{ before, after, changed_keys }` | `changed_keys` is the array of merged keys |

**Actor surfacing:** the audit-log read endpoint LEFT JOINs `users` on `actor_id`, so each of these rows returns `actor_email` = the admin who performed the action. This is admin-facing internal UI, so showing the responsible admin's email is correct and desirable for accountability.

**Not in this inventory (intentionally):** auction-scoped events (`auction_*`, `lot_*`) already surface via Tier 1's auction History and are keyed by `auction_id`, not `seller_profile`. Tier 2 is strictly the three `seller_profile`-entity events above.

---

## 3. Existing audit data sources (reuse map)

| Asset | Location | Reused by Tier 2 how |
|---|---|---|
| `audit_log` table | migration 013 | Read-only; no schema change |
| `GET /api/admin/audit-log` | `src/routes/admin.js:26–61` | Called with `?entity_type=seller_profile&entity_id=<id>` — **already supported filters** (admin.js:34–41); no endpoint change |
| `GET /api/admin/sellers` | `src/routes/admin.js:733–761` | Already returns `seller_profile_id` in each row — the exact `entity_id` value needed; no endpoint change |
| `prettyAdminMetadata(eventType, metadata)` | `moderation.html:1351` | Reused verbatim as the render brain; the three seller events currently fall through to its safe JSON fallback |
| `escText()` / `escAttr()` | `moderation.html:1300-ish` | Reused for escaping |
| `api(method, url, body)` | `moderation.html:596` | Reused for the fetch |
| `.btn .btn-sm` styles | `moderation.html` CSS | Reused for the History button |

**Confirmed match:** audit `entity_id` (UUID written by suspend/unsuspend/capabilities) === `seller_profile_id` (UUID returned by `/api/admin/sellers`). No id translation, lookup, or join is needed client-side.

---

## 4. Recommended UI placement

### 4.1 Placement — a per-row **History** button + full-width audit panel

`.row-item` is `display:flex; align-items:center; gap:1rem; flex-wrap:wrap` (moderation.html:372–381). This layout makes the placement clean:

- Add a right-aligned **History** button as a flex item after `.row-main`.
- Add a `.audit-log-panel` as a child of the row with `width:100%` (or `flex-basis:100%`); because the row already has `flex-wrap:wrap`, a full-width child wraps onto its own line **below** the seller's content, visually attached inside the same card. `display:none` by default; toggled on click.

This mirrors Tier 1's "button reveals a scoped panel" pattern and keeps each seller's history inside that seller's card (no detached panels, no layout fight with the flex row).

### 4.2 Reuse strategy — thin seller-scoped wrapper, not a new viewer

The existing `toggleAuditLog(container, auctionId)` hardcodes `?auction_id=${auctionId}` in its fetch URL (moderation.html:1319), so it cannot be called directly for a seller filter. Two options were considered:

- **Option A (recommended) — additive thin wrapper.** Add `toggleSellerAudit(container, sellerProfileId)`: structurally parallel to `toggleAuditLog`, but its only differences are (a) the query string (`entity_type=seller_profile&entity_id=…`) and (b) the empty-state copy. It **reuses `prettyAdminMetadata`, `escText`, and `api`** — the actual rendering logic. Touches no existing function, so **zero regression risk to Tier 1**. Cost: ~15 lines of fetch/render glue duplicated from `toggleAuditLog`.
- **Option B (rejected for this task) — generalize `toggleAuditLog`** to accept a query/filter argument and have both auction and seller callers share it. Cleaner DRY, but it changes an existing function's signature and Tier 1's call site → a **refactor**, which the constraints forbid. Documented here only as a possible future consolidation; not proposed now.

Option A honors "additive only / no refactors" while still being reuse-first: the **rendering** (the asset worth reusing) is shared; only a thin filter-specific fetch wrapper is added, exactly parallel to the auction one. This is not "a second audit viewer" in any meaningful sense — it is the same renderer with a different filter.

### 4.3 Optional additive polish — three `prettyAdminMetadata` branches

`prettyAdminMetadata` is an extensible `if (eventType === …)` dispatcher with a JSON fallback. The three seller events currently hit that fallback (safe, information-complete, but raw JSON). Adding three branches is **additive** (new cases on an extensible dispatcher — not a refactor):

- `seller_suspended` / `seller_unsuspended` → render `reason` in a bordered box (reuse the existing reason-box style already used for `auction_rejected`); optionally note the affected email.
- `seller_capabilities_changed` → render `changed_keys` and a compact `before → after` per changed key.

This polish is **independent and optional** — the feature works without it (JSON fallback). Recommend shipping it together with the button for a clean first impression, but it can be split.

---

## 5. Moderator experience mockup (per-seller history)

*This is an admin-facing surface; "seller experience" here means the moderator's experience viewing a seller's history. No buyer- or seller-facing change is introduced.*

**Before** (read-only row, no history affordance):
```
┌──────────────────────────────────────────────────────────────┐
│ jane.seller@example.com                                        │
│ private · 3 auctions · reserve_pricing · joined May 2, 2026    │
└──────────────────────────────────────────────────────────────┘
```

**After** (one-click History on every seller row):
```
┌──────────────────────────────────────────────────────────────┐
│ jane.seller@example.com                            [ History ] │
│ private · 3 auctions · reserve_pricing · joined May 2, 2026    │
│ ──────────────────────────────────────────────────────────────│
│ Audit Log (2 entries)                                          │
│                                                                │
│ seller_capabilities_changed                                    │
│ May 27, 2026 11:20 AM · admin@advantage.bid                    │
│   changed: reserve_pricing                                     │
│   reserve_pricing: false → true                                │
│                                                                │
│ seller_suspended                                               │
│ May 20, 2026 8:05 AM · admin@advantage.bid                     │
│   ┌────────────────────────────────────────────────────────┐  │
│   │ Repeated late pickup coordination                       │  │
│   └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```
*(Header, timestamp, and actor lines are produced by the same render loop as Tier 1; the indented metadata lines are the optional §4.3 branches. Without those branches, the same two events render via the compact-JSON fallback.)*

Empty state (seller with no audited admin actions):
```
│ Audit Log                                                      │
│ No recorded admin actions for this seller yet.                 │
```

---

## 6. File-level implementation plan

> For a future implementation task. **Not executed here.** Single file; all changes additive.

**`public/admin/moderation.html`** — the only file touched.

1. **Seller row builder** (`loadSellers`, ~lines 1406–1420): after appending `.row-main`, add:
   - a `History` button (`el('button', 'btn btn-sm', 'History')`), wired to `toggleSellerAudit(auditContainer, s.seller_profile_id)`;
   - a card-scoped `auditContainer` holding a `.audit-log-panel` (`display:none`, `width:100%`/`flex-basis:100%` so it wraps below within the flex row), appended to `row`.
   - Guard: only render the button when `s.seller_profile_id` is present (it always is per the endpoint, but defensive).
2. **New function `toggleSellerAudit(container, sellerProfileId)`** (placed next to `toggleAuditLog`, ~line 1346): parallel to `toggleAuditLog` but fetches `GET /api/admin/audit-log?entity_type=seller_profile&entity_id=${encodeURIComponent(sellerProfileId)}&limit=50` and uses seller-appropriate empty-state copy. Reuses `prettyAdminMetadata`, `escText`, `api` verbatim.
3. **(Optional, §4.3) `prettyAdminMetadata`** (~line 1351): add three additive `if (eventType === …)` branches for the seller events. Independent of steps 1–2.

No backend, route, service, migration, schema, or test-fixture changes. No change to `toggleAuditLog`, the auction card builder, or any Tier 1 code.

---

## 7. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | `toggleSellerAudit` duplicates ~15 lines of `toggleAuditLog`'s render loop | Certain (by design) | Very low | Accepted, additive trade-off to honor "no refactors." Rendering brain (`prettyAdminMetadata`) is still shared. Future consolidation noted (§4.2 Option B) but out of scope. |
| 2 | `entity_id` UUID vs. text cast in the audit-log query | Low | Medium | Same `al.<col> = $n` string-param pattern Tier 1 uses successfully for `auction_id`; Postgres casts the text param to the column type. Verify on staging that a `seller_profile` query returns rows before sign-off. |
| 3 | Seller with no audited actions shows confusing empty panel | Low | Low | Explicit empty-state copy ("No recorded admin actions for this seller yet."). |
| 4 | Full-width panel breaks the flex `.row-item` layout / mobile overflow | Low | Low | `flex-wrap:wrap` already on `.row-item`; a `width:100%` child wraps cleanly. Verify mobile (390px) shows no horizontal overflow (existing test asserts this page-wide). |
| 5 | Exposes data a moderator shouldn't see | Very low | Medium | No new data path — endpoint is already `role(['admin'])`-gated and already returns these rows. Tier 2 only adds a filtered call + button. |
| 6 | XSS via metadata (esp. capability keys / reason) | Low | Medium | Reuse `escText` for every rendered value, exactly as Tier 1 and `prettyAdminMetadata` already do. No raw unescaped `innerHTML` of metadata. |
| 7 | Scope creep into surfacing suspend/capabilities *write* actions | Medium | Medium | Explicitly out of scope — Tier 2 is read-only audit visibility. Write-action UI is a separate, future decision. |
| 8 | Touching `prettyAdminMetadata` reads as a refactor | Low | Low | Adding event-type branches is the function's designed extension pattern (additive), not a refactor of existing branches. Optional and separable. |

**Overall risk: low.** Front-end-only, additive, reuses an already-admin-gated endpoint and the existing renderer; no Tier 1 code is modified.

---

## 8. Recommended implementation order

1. **Step 1 + 2 (button + `toggleSellerAudit`)** — delivers the full feature using the existing JSON fallback for rendering. Smallest shippable unit that closes the visibility gap.
2. **Manual staging validation** — using seeded validation identities (see `project_validation_identities`; no speculative credentials): suspend/unsuspend or change capabilities on a seeded seller via the existing endpoints, then confirm the Sellers-tab History button surfaces those events with correct actor + timestamp. Confirm risk #2 (entity_id query returns rows) and risk #4 (mobile, no overflow) here.
3. **Step 3 (optional `prettyAdminMetadata` branches)** — ship with Step 1+2 for polish, or immediately after. Verify reason/changed_keys render and remain escaped.

Each step is independently shippable and revertable (contiguous additive blocks in one file). Mirrors the Tier 1 cadence: implement → mocked/headless self-check → staging sign-off.

---

## 9. Explicit non-goals (scope guard)

- ❌ No backend/endpoint change (the `entity_type`/`entity_id` filters and `seller_profile_id` field already exist).
- ❌ No schema, migration, governance, RBAC, or analytics work.
- ❌ No change to `toggleAuditLog` or any Tier 1 code (no refactor).
- ❌ No new audit writers or event types.
- ❌ No surfacing of suspend/unsuspend/capabilities **write** actions in the UI (audit visibility only).
- ❌ No buyer- or seller-facing change; the AUD-EXP seller endpoint stays as-is.
- ❌ Not Tier 3 (global Activity view) — still deferred.

---

*End of Tier 2 planning document. Awaiting approval before any implementation begins.*
