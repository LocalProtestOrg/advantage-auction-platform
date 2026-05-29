# Admin Audit Visibility — Planning Document

*This is the first task under the "Admin UX Improvements" priority. It does **not** touch governance infrastructure (migrations 047–050, the regression suite, or the RBAC architecture in `docs/admin-center-rbac-architecture.md`), all of which are complete and out of scope per the current directive.*

> **Implementation status (Tier 1 — DONE, 2026-05-29).** Tier 1 ("promote the audit trigger out of the edit form onto the card action row") has been implemented exactly as specified in §3 and §5. A card-level **History** button now appears on every auction card in all states, wired to the **existing** `toggleAuditLog()` renderer (which uses the existing `prettyAdminMetadata()` and the existing `GET /api/admin/audit-log` endpoint). The closed-auction dead-end is closed: closed cards retain History even though Edit stays hidden. The edit-form Audit Log button/panel is preserved unchanged. Single file touched: `public/admin/moderation.html` (+24 lines, additive). Verified via a self-contained headless-browser harness (12/12 checks: History present on closed + submitted cards, closed card has History but no Edit, audit panel populates with event + reason metadata, toggles off, edit-form panel still works, no JS errors). **Tier 2 and Tier 3 remain deferred** per the approved scope.*

---

*Planning content below is retained as the approved source of truth.*

**Author's headline finding:** the audit *data* and the audit *read endpoint* already exist and work. This is **not** a "build audit visibility" task — it is a "surface the audit that's already there" task. The audit log is currently reachable only by a moderator who (1) opens the Auctions tab, (2) clicks **Edit** on a card, (3) clicks the **Audit Log** button inside the edit form. That path is two clicks deep, coupled to edit mode, and **completely unreachable for closed auctions** (the Edit button is hidden once `state === 'closed'`). The least-invasive, highest-value work is to decouple the existing audit panel from the edit form and raise its discoverability — not to write new backend.

---

## 1. Workflow analysis

### 1.1 Moderation states and transitions

Verified against `src/routes/admin.js`, `src/services/auctionService.js`:

| From state | Action | Endpoint | Audit event written |
|---|---|---|---|
| draft → submitted | Seller submits | (seller flow → `auctionService.updateAuction`) | `auction_submitted` (with `changed_fields` diff) |
| submitted → published | Admin **Publish** | `PATCH /api/admin/auctions/:id/publish` | `auction.published` |
| submitted/under_review → draft | Admin **Return to Draft** (GOV-RET) | `POST /api/admin/auctions/:id/return-to-draft` | `auction_returned_to_draft` (`from_state`, `reason`) |
| submitted/under_review → rejected | Admin **Reject** (GOV-REJ) | `POST /api/admin/auctions/:id/reject` | `auction_rejected` (`from_state`, `reason`) |
| published → closed | Admin **Close** | `POST /api/admin/auctions/:id/close` | `auction.closed` |
| any (non-closed) | Admin **Edit** | `PATCH /api/admin/auctions/:id` | `auction_updated` (`changed_fields` diff) |
| — | Admin edits lots | `src/routes/lots.js` | `lot_added`, `lot_updated`, `lot_withdrawn` |
| (scheduler) | Per-lot soft close | `src/workers/notificationWorker.js` | `lot_auto_closed` |

Seller-scoped moderation actions (entity_type = `seller_profile`, **`auction_id` is NULL**):

| Action | Endpoint | Audit event |
|---|---|---|
| Suspend seller (OPS-3) | `POST /api/admin/sellers/:id/suspend` | `seller_suspended` (`reason`) |
| Unsuspend seller | `POST /api/admin/sellers/:id/unsuspend` | `seller_unsuspended` (`reason`) |
| Change capabilities (OPS-2) | `POST /api/admin/sellers/:id/capabilities` | `seller_capabilities_changed` (`before`, `after`, `changed_keys`) |

Walkthrough-video moderation (`POST /api/admin/videos/:id/reject`, approve) is a separate queue and does **not** currently write to `audit_log` (it mutates video state via `walkthroughVideoService`). Noted as a gap; **not** in scope for this task.

Payment lifecycle events (`payment.created`, `payment.paid`, `payment.refunded`) are written by `paymentService` and carry `payment_id` + `auction_id`.

### 1.2 The moderator's actual journey today

1. Moderator opens `/admin/moderation.html`, lands on the **Queue** tab (walkthrough videos).
2. To review auctions, switches to the **Auctions** tab — a filterable card list (state chips, search, seller email, "Needs Review", "Recently Updated").
3. Each card shows: title, created date, lot count, seller email/type, a state badge, and an action row (Publish / Close / View / Open Lot Studio / **Edit**).
4. **The only path to audit history** is: click **Edit** → the inline form lazy-loads → click the **Audit Log** button → a `<div class="audit-log-panel">` toggles open and fetches `GET /api/admin/audit-log?auction_id=<id>&limit=50`.
5. Closed auctions hide the Edit button entirely (`if (a.state !== 'closed')`), so **there is no way to view a closed auction's audit trail from the UI** — even though closed auctions are exactly the ones where "what happened and who did it" matters most for disputes/payouts.

### 1.3 Friction summary

- **Buried:** audit is behind edit-mode, two clicks deep.
- **Coupled to edit:** viewing history is conceptually read-only, but it's gated behind an editing affordance.
- **Dead-ends on closed auctions:** the highest-stakes records are unreachable.
- **No seller-scoped view:** `seller_suspended` / `_unsuspended` / `_capabilities_changed` have `auction_id = NULL`, so the auction-scoped query never returns them. The **Sellers** tab has no audit affordance at all.
- **No cross-cutting view:** there is no "recent platform activity" or "what did admin X do" view. The endpoint *supports* an unfiltered query (it just omits the WHERE clause), but nothing in the UI calls it that way.

---

## 2. Existing audit data sources

### 2.1 Storage

- **Table:** `audit_log` (introduced migration 013 per `src/lib/auditLog.js` header). Append-only, indexed by `auction_id` and `created_at` for fast operator timelines.
- **Columns (verified via writers):** `id`, `event_type`, `entity_type`, `entity_id`, `auction_id`, `lot_id`, `payment_id`, `actor_id`, `metadata` (JSONB), `created_at`.
- *(Note: the Phase A RBAC architecture proposes extending this table with `actor_ip`, `before_value`, `after_value`, `outcome`, etc. — that is governance Phase A work and is **not** assumed here. This plan uses only columns that exist today.)*

### 2.2 Writers (two, intentionally distinct)

| Writer | File | Semantics |
|---|---|---|
| `writeAuditLog(...)` | `src/lib/auditLog.js` | **Non-blocking, post-commit.** Failure logs a warning and returns null — never aborts the business operation. Used by admin route handlers (return-to-draft, reject, suspend, capabilities). |
| `logEvent(client, ...)` | `src/services/auditService.js` | **Transactional.** INSERT shares the parent transaction; if it fails, the whole change rolls back. Used inside services (publish, close, payments). |

This duality is deliberate and stable — **do not refactor it** (see `feedback_surgical_fixes`). The read side does not care which writer produced a row.

### 2.3 Read endpoints (both already exist)

| Endpoint | Auth | Filters | Notes |
|---|---|---|---|
| `GET /api/admin/audit-log` | `auth` + `role(['admin'])` | `auction_id`, `entity_type`, `entity_id`, `limit` (≤500), `offset` | OPS-4. LEFT JOINs `users` to surface `actor_email`; falls back to `system` when `actor_id` is NULL. **Returns global feed when no filter is passed.** |
| `GET /api/sellers/me/audit` | `auth` (seller) | `auction_id`, `limit`, `offset` | AUD-EXP. Strict event allow-list; ownership enforced by join; never 403s on a foreign id (returns empty). Maps actor to `you`/`advantage`/`system`. |

The admin endpoint is the one this task builds UI on. It is already capable of every view this plan recommends; no new query parameters are strictly required for the recommended scope.

### 2.4 Event-type catalog (complete, as written today)

```
auction_submitted            auction_updated            (underscore — carry changed_fields diff)
auction.published            auction.closed             (dot notation — auctionService)
auction_returned_to_draft    auction_rejected           (from_state, reason)
seller_suspended             seller_unsuspended         seller_capabilities_changed   (auction_id = NULL)
lot_added                    lot_updated                lot_withdrawn   (changed_fields, lot_number, actor_role)
lot_auto_closed              (winning_amount_cents, had_bid)
payment.created              payment.paid               payment.refunded
```

> **Observation (not a task):** event-type naming is inconsistent (`auction.published` vs `auction_submitted`). The UI's `prettyAdminMetadata()` already handles both forms by matching exact strings, so this is cosmetic. Renaming would rewrite history semantics and is explicitly **out of scope** — flagged only so it isn't mistaken for a bug during implementation.

### 2.5 Existing presentation layer (already built — reuse, don't rebuild)

`public/admin/moderation.html` already contains:
- `toggleAuditLog(container, auctionId)` — fetches and renders the per-auction timeline panel.
- `prettyAdminMetadata(eventType, metadata)` (AUD-EXP) — renders high-signal labels per event type: return-to-draft/reject (from_state + reason box), auction_updated/submitted (collapsible field diff), lot events, lot_auto_closed (sold/unsold), with a compact-JSON fallback for unknown types.

These two functions are the workhorses. **Every recommendation below reuses them unchanged.**

---

## 3. Recommended UI placement

Three placements, ranked by value-per-invasiveness. **Recommendation: do Tier 1 now; defer Tier 2/3 unless the operator asks.**

### Tier 1 (recommended now) — promote the audit trigger out of the edit form

**Move (or duplicate) the "Audit Log" trigger from inside the edit form to the card action row** (`card-actions`), so it sits beside View / Open Lot Studio / Edit and is reachable in **one click for every auction regardless of state**, including closed.

- The panel itself stays where it renders well; simplest implementation keeps the `.audit-log-panel` div on the card and toggles it directly, decoupled from `toggleEditForm`.
- Closed-auction gap is closed: the audit button is rendered unconditionally (it's read-only and safe in every state).
- Zero backend change. Reuses `toggleAuditLog` + `prettyAdminMetadata` verbatim.

**Why this is the least-invasive high-value move:** it touches only the card-rendering block and the trigger wiring in `moderation.html`. No endpoint, no migration, no service. It directly fixes the two worst gaps (buried + closed-auction dead-end).

### Tier 2 (optional, small) — per-seller audit on the Sellers tab

Add a **History** toggle to each row in the Sellers tab that calls
`GET /api/admin/audit-log?entity_type=seller_profile&entity_id=<sellerProfileId>` and renders with the **same** `prettyAdminMetadata`. This surfaces `seller_suspended` / `_unsuspended` / `_capabilities_changed`, which are invisible from the auction-scoped path because their `auction_id` is NULL.

- Backend already supports `entity_type` + `entity_id` filters — **no change needed**.
- `prettyAdminMetadata` currently has no branch for the three seller events, so they'd hit the JSON fallback. A *small, additive* enhancement (three more `if` branches) would render them cleanly. This is the only net-new presentation code in the whole plan, and it's additive.

### Tier 3 (defer) — a global "Activity" view

A dedicated tab calling `GET /api/admin/audit-log` with no entity filter (global recent feed), optionally with a client-side actor/event filter. Genuinely useful for "what happened today / what did admin X do," but it is net-new surface area (a tab, its own render loop, pagination UX) and is **not** required to close the discoverability gap. Recommend deferring until the operator validates Tier 1 in practice. (When built, it overlaps conceptually with the future RBAC "Audit Log" UI in Phase D of the admin-center architecture — worth aligning then, not now.)

### Placement decision rationale

- Aligns with `feedback_surgical_fixes`: smallest change that removes the friction.
- Aligns with `project_product_philosophy`: this is internal ops UI, not buyer-facing — but the philosophy's "no SaaS clutter / no unnecessary complexity" still applies, which argues *against* the Tier-3 tab until proven needed.
- Reuses the AUD-EXP presentation investment rather than duplicating it.

---

## 4. Moderator experience mockup

### 4.1 Auction card — before vs. after (Tier 1)

**Before** (audit unreachable without entering edit mode; absent on closed):
```
┌────────────────────────────────────────────────────────────┐
│ Estate of a Collector — Downsizing        [ SUBMITTED ]      │
│ May 24, 2026 · 42 lots                                       │
│ jane.seller@example.com · private                            │
│ [ Publish ] [ View ] [ Open Lot Studio ] [ Edit ]           │
└────────────────────────────────────────────────────────────┘
        (audit only appears after Edit → Audit Log)
```

**After** (one-click audit on every card, all states):
```
┌────────────────────────────────────────────────────────────┐
│ Estate of a Collector — Downsizing        [ SUBMITTED ]      │
│ May 24, 2026 · 42 lots                                       │
│ jane.seller@example.com · private                            │
│ [ Publish ] [ View ] [ Open Lot Studio ] [ Edit ] [ History ]│
└────────────────────────────────────────────────────────────┘
                                                      │ click
                                                      ▼
   ┌──────────────────────────────────────────────────────┐
   │ Audit Log (4 entries)                                  │
   │ ───────────────────────────────────────────────────── │
   │ auction.published                                      │
   │ May 26, 2026 2:14 PM · admin@advantage.bid             │
   │                                                        │
   │ auction_returned_to_draft                              │
   │ May 25, 2026 9:02 AM · admin@advantage.bid             │
   │   from submitted                                       │
   │   ┌──────────────────────────────────────────────┐    │
   │   │ Please add measurements to the dresser lots.   │   │
   │   └──────────────────────────────────────────────┘    │
   │                                                        │
   │ auction_updated                                        │
   │ May 24, 2026 4:41 PM · jane.seller@example.com         │
   │   ▸ 3 field(s) changed                                 │
   │                                                        │
   │ auction_submitted                                      │
   │ May 24, 2026 3:10 PM · jane.seller@example.com         │
   └──────────────────────────────────────────────────────┘
```
*(Rendering is exactly what `toggleAuditLog` + `prettyAdminMetadata` already produce — the mockup reflects current output, only the trigger location changes.)*

### 4.2 Sellers tab — Tier 2 (optional)

```
┌────────────────────────────────────────────────────────────┐
│ jane.seller@example.com · private · 3 auctions              │
│ [ Suspend ] [ Capabilities ] [ History ]                    │
└────────────────────────────────────────────────────────────┘
                                         │ click
                                         ▼
   ┌──────────────────────────────────────────────────────┐
   │ seller_capabilities_changed                            │
   │ May 27, 2026 11:20 AM · admin@advantage.bid            │
   │   enabled: reserve_pricing                             │
   │                                                        │
   │ seller_suspended                                       │
   │ May 20, 2026 8:05 AM · admin@advantage.bid             │
   │   Reason: repeated late pickup coordination            │
   └──────────────────────────────────────────────────────┘
```
*(Requires the three additive `prettyAdminMetadata` branches; otherwise these render as compact JSON.)*

---

## 5. File-level implementation plan

> Listed for a future implementation task. **Not executed here.** Every item below is additive or a trigger relocation; none touches backend behavior, migrations, services, or the governance suite.

### Tier 1 — promote audit trigger (the only thing recommended for the next task)

**`public/admin/moderation.html`** — the single file touched.

1. **Card action row** (~lines 941–986, `loadAuctions` card builder): add a `History` button to the `actions` row, rendered for **all** states. Wire its `onclick` to a new lightweight `toggleCardAudit(card, auctionId)`.
2. **Card audit panel**: add a sibling `<div class="audit-log-panel" style="display:none">` directly on the card (next to the existing `editContainer`), so audit is independent of the edit form being built.
3. **`toggleCardAudit(card, auctionId)`**: ~10-line function that mirrors the body of the existing `toggleAuditLog`, but targets the card-level panel rather than the edit-form-scoped one. (Alternative: generalize `toggleAuditLog` to accept the panel element; either way the fetch + render logic is reused verbatim.)
4. **Leave the existing in-edit-form "Audit Log" button intact** to avoid disturbing the OP-A edit flow and its tests — or remove it once Tier 1 is validated, operator's call. Default: leave it (purely additive, zero regression risk).

No other files. No server, route, service, migration, or test-fixture changes.

### Tier 2 — per-seller history (optional, additive)

**`public/admin/moderation.html`** only:
1. Sellers tab row builder (`loadSellers`, ~line 1382+): add a `History` button per row → `toggleSellerAudit(row, sellerProfileId)`.
2. `toggleSellerAudit`: fetch `GET /api/admin/audit-log?entity_type=seller_profile&entity_id=<id>`, render with `prettyAdminMetadata`.
3. `prettyAdminMetadata`: add three additive branches for `seller_suspended`, `seller_unsuspended`, `seller_capabilities_changed` (reason / changed_keys). Fallback already handles them, so this is polish, not a prerequisite.

No backend change (the `entity_type`/`entity_id` filters already exist in the OPS-4 endpoint).

### Tier 3 — global activity tab (deferred; documented for completeness)

If/when approved:
1. New `<nav>` tab button + `<div class="tab-panel" id="tab-activity">` in `moderation.html`.
2. `loadActivity()` calling `GET /api/admin/audit-log?limit=100` (no entity filter), client-side actor/event-type filter chips, "load more" via `offset`.
3. Reuse `prettyAdminMetadata`; each row links back to its `auction_id` card.

Optional future backend (only if Tier 3 needs it): an `actor_id` query param and/or a `since` timestamp filter on the OPS-4 endpoint. Additive, but **not** part of this plan's recommended scope.

---

## 6. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Tier-1 change breaks the existing OP-A edit-form audit button / tests | Low | Medium | Leave the in-form button untouched; add the card-level trigger alongside it. The two share read-only logic and cannot interfere. |
| 2 | Audit panel exposes data a moderator shouldn't see | Very low | Medium | No new data is exposed — the OPS-4 endpoint is already admin-gated (`role(['admin'])`) and already returns these rows. Tier 1 only changes *where the button is*, not *what is returned*. |
| 3 | Seller-scoped events render as raw JSON (Tier 2 before the pretty branches land) | Medium | Low | The JSON fallback is already safe and information-complete; the three pretty branches are polish, shippable separately. |
| 4 | Larger audit history on long-lived auctions slows the panel | Low | Low | Endpoint caps `limit` at 500 and the UI requests 50; pagination via `offset` already supported if needed. |
| 5 | Closed auctions now expose history that previously had no UI path — could surprise operators | Very low | Low (positive) | This is the intended fix, not a regression. Closed-auction audit is exactly the dispute/payout-relevant record. |
| 6 | XSS via metadata rendered in panel | Low | Medium | `prettyAdminMetadata`/`escText`/`escAttr` already escape all rendered values; reuse them unchanged — do not introduce raw `innerHTML` of unescaped metadata. |
| 7 | Scope creep into governance/RBAC audit work | Medium | Medium | Explicitly bounded: this task uses only existing columns and endpoints. Any `audit_log` schema extension belongs to admin-center Phase A, not here. |
| 8 | Event-type naming inconsistency tempts a "cleanup" rename | Low | High | **Do not rename.** History rows are immutable records; `prettyAdminMetadata` already matches both forms. Flagged in §2.4 to prevent accidental in-scope drift. |

**Overall risk: low.** Tier 1 is a front-end-only trigger relocation reusing audited, escaped, admin-gated read logic. No server, no DB, no business rule, no governance surface is touched.

---

## 7. Recommended implementation order

1. **Tier 1 — promote the audit trigger to the card action row** (front-end only, `moderation.html`). Closes the two worst gaps (buried + closed-auction dead-end) with the smallest possible change. *Ship and let the operator validate before anything else.*
2. **Manual validation** by the operator on staging: confirm the History button appears on draft/submitted/published/closed/rejected cards and renders the expected timeline (reuse seeded validation identities from `project_validation_identities`; do not probe with speculative creds).
3. **Tier 2 — per-seller history on the Sellers tab** + the three additive `prettyAdminMetadata` branches. Only after Tier 1 is confirmed and if the operator wants seller-scoped visibility surfaced.
4. **Tier 3 — global Activity tab** — defer until there's a demonstrated need; revisit alongside admin-center Phase D so the two audit UIs don't diverge.

Each tier is independently shippable and independently revertable (a tier is a contiguous additive block in one file). No tier blocks auction operations, payments, or governance.

---

## 8. Explicit non-goals (so scope doesn't drift)

- ❌ No `audit_log` schema changes (that's admin-center Phase A).
- ❌ No new audit *writers* and no new event types.
- ❌ No event-type renaming or normalization.
- ❌ No changes to `writeAuditLog` / `logEvent` duality.
- ❌ No walkthrough-video audit wiring (separate gap, separate task).
- ❌ No governance/RBAC, no migrations 047–050 territory, no regression-suite changes.
- ❌ No buyer-facing or seller-facing changes (the AUD-EXP seller endpoint stays as-is).

---

*End of planning document. Awaiting approval before any implementation begins.*
