# Admin Seller Context Navigation — Planning Document

*Planning only. No code changes proposed for execution. Next increment under the "Admin UX Improvements" priority, following Tier 1 (auction audit visibility, `48b0b70`), Tier 2 (seller audit visibility, `97836a2`), and Seller Management Actions S1 (suspend/unsuspend, `4636d70`). Does **not** touch governance, RBAC, analytics, schema, migrations, or endpoint design. Reuse-first: this exposes information that already exists rather than building new infrastructure.*

> **Headline finding (verified against current code, 2026-05-29):** The seller→auctions navigation can be delivered with **zero backend changes** and almost no new front-end logic, because the target already exists end-to-end. `GET /api/admin/auctions?seller_email=<email>` already filters auctions by seller (exact, case-insensitive — `admin.js:96–99`). The Auctions tab already drives itself entirely from a URL-hash filter: `loadAuctions()` reads `currentAuctionFilters()`, fetches with `buildAuctionFiltersQS()`, and syncs the chips + seller input via `syncAuctionFilterChips()` (`moderation.html:878–902`). A seller row only needs a small **View Auctions** button that persists a `seller_email` filter into the hash and switches to the Auctions tab — the existing tab does the rest.

---

## 1. Workflow analysis

### 1.1 The gap

Verified in `public/admin/moderation.html` (`loadSellers`, lines 1531–1620 post-S1) and `GET /api/admin/sellers` (`src/routes/admin.js:733–761`).

- Each Sellers-tab row shows `email`, `seller_type`, an **auction count** ("N auction(s)"), enabled capability keys (cosmetic), join date, a **Suspended** badge (S1a), a **Suspend/Unsuspend** button (S1b), and a **History** button (Tier 2).
- The auction count is **purely informational** — there is no way to act on it. To actually see *which* auctions a seller owns, a moderator must switch to the **Auctions** tab and manually type the seller's email into the `Seller email` filter box. The two tabs are not linked.

### 1.2 What the moderator does today (the manual path)

1. On the **Sellers** tab, note a seller's email and that they have, say, 3 auctions.
2. Switch to the **Auctions** tab.
3. Type/paste the email into `#auctions-filter-seller`.
4. Click **Apply** → `applyAuctionFilters()` → `loadAuctions()` fetches `?seller_email=…`.

This works (the filter exists and is used), but it's a manual, error-prone copy step across tabs. **Seller Context Navigation closes that gap with a one-click jump** that pre-fills exactly the same filter the operator would have typed.

### 1.3 Why the Auctions tab is the right destination

Filtering the existing Auctions tab by seller gives the moderator the seller's auctions **with full existing admin tooling already attached to each card**: state badge, Publish/Close, View, Open Lot Studio, Edit, and the Tier 1 auction History. No new auction-rendering surface is needed — the richest, already-built view is reused verbatim.

---

## 2. Existing data sources

| Source | Where | What it gives |
|---|---|---|
| `GET /api/admin/sellers` | `admin.js:733–761` | Per seller: `seller_profile_id`, `email`, `seller_type`, `is_active`, `capabilities`, `user_created_at`, and **`auction_count`** (`COUNT(a.id)` via `LEFT JOIN auctions a ON a.seller_id = sp.id`). |
| `GET /api/admin/auctions?seller_email=` | `admin.js:75–128` | The seller's auctions, each row with `id, title, state, created_at, updated_at, lot_count, seller_email, seller_type`. Filter is `LOWER(u.email) = LOWER($n)` — exact, case-insensitive. |

**Count vs. list consistency:** `auction_count` is counted by `seller_id`; the filtered list matches by the seller's `email`. For the normal ownership chain (one user → one `seller_profile` → N auctions) these agree. They could only diverge if a single user held multiple `seller_profiles` — not the norm; noted as a minor caveat in §7, not a blocker.

---

## 3. Existing endpoint inventory (all reused as-is)

| Endpoint | Auth | Relevant params | Reused for |
|---|---|---|---|
| `GET /api/admin/sellers` | `auth` + `role(['admin'])` | `search` | Already powers the Sellers tab; provides the `email` to navigate by. No change. |
| `GET /api/admin/auctions` | `auth` + `role(['admin'])` | `seller_email`, `state`, `search`, `submitted_only`, `recently_updated`, `limit`, `offset` | The navigation target. `seller_email` already implemented (`admin.js:96–99`). No change. |

**No new endpoint, no endpoint change, no new query parameter.** The `seller_email` filter is the entire backend contract this feature needs, and it already ships.

### Front-end machinery already present (reused, not modified)

| Function | Line | Role |
|---|---|---|
| `currentAuctionFilters()` | 1028 | Parses the `#auctions=…` hash into a filter object (includes `seller_email`). |
| `persistAuctionFilters(f)` | 1042 | Writes the filter object back to the hash. |
| `buildAuctionFiltersQS(f)` | 1053 | Builds the query string `loadAuctions` fetches with. |
| `syncAuctionFilterChips(f)` | 1062 | Reflects the filter into chips + the `#auctions-filter-seller` input. |
| `loadAuctions()` | ~878 | Reads `currentAuctionFilters()`, fetches filtered, calls `syncAuctionFilterChips()` (line 902). |
| `switchTab(name)` | 666 | Switches tab; calls the loader once per tab via the `loadedTabs` set. |

The navigation reuses all six. The only new code is a tiny function that sets `seller_email`, clears the `loadedTabs` flag so a reload fires, and calls `switchTab('auctions')`.

---

## 4. Recommended UI placement

### 4.1 A per-row **View Auctions** button (recommended)

Add one button to the seller row action area, alongside the existing Suspend/Unsuspend and History buttons:

- Label: **View Auctions** (optionally suffixed with the count, e.g. `View Auctions (3)`, reusing `auction_count` the row already has).
- Rendered only when `s.auction_count > 0` (nothing to navigate to otherwise; the row's "0 auctions" meta already conveys the empty case).
- On click → a new `viewSellerAuctions(email)` that:
  1. builds a clean filter `{ seller_email: email }` (clearing state/search/toggles so the operator sees *all* of that seller's auctions, not a stale narrower view),
  2. `persistAuctionFilters(f)`,
  3. `loadedTabs.delete('auctions')` (force a reload with the new filter),
  4. `switchTab('auctions')` (renders the Auctions tab, which reads the hash and self-populates the seller input + chips).

This mirrors the established button-on-row pattern (Tier 2 History, S1 Suspend) and the established cross-state hash-filter behavior. The seller's email lands in the Auctions filter box exactly as if typed, so the operator can further refine or **Clear** using the controls already there.

### 4.2 Rejected alternative — clickable count in `.row-meta`

Making the "N auctions" text itself a link would require restructuring the `.row-meta` line, which is currently a single joined text string (`metaParts.join(' · ')`). That touches existing display code for no functional gain over a button. **Not recommended** (less surgical).

### 4.3 Return path

No new "back" control is needed: the Auctions tab already has a **Clear** button (`clearAuctionFilters`) and the Sellers tab is one click away in the nav. The hash persistence means a refresh keeps the seller-scoped view, consistent with existing behavior.

---

## 5. Admin workflow mockup

**Seller row — after (active seller with auctions):**
```
┌──────────────────────────────────────────────────────────────────────────┐
│ jane.seller@example.com        [ View Auctions (3) ] [ Suspend ] [ History]│
│ private · 3 auctions · joined May 2, 2026                                  │
└──────────────────────────────────────────────────────────────────────────┘
        │ click "View Auctions (3)"
        ▼
  switches to Auctions tab, seller filter pre-filled:
┌──────────────────────────────────────────────────────────────────────────┐
│ Filters:  [ search… ]  [ Seller email: jane.seller@example.com ] [Apply][Clear]
│ ── Auctions ───────────────────────────────────────────────────────────── │
│  Estate of a Collector — Downsizing            [ SUBMITTED ]               │
│  May 24, 2026 · 42 lots · jane.seller@example.com                          │
│  [ Publish ] [ View ] [ Open Lot Studio ] [ Edit ] [ History ]            │
│                                                                            │
│  Spring Garden Clearout                        [ CLOSED ]                  │
│  Apr 30, 2026 · 18 lots · jane.seller@example.com                          │
│  [ View ] [ Open Lot Studio ] [ History ]                                  │
│  … (1 more)                                                                │
└──────────────────────────────────────────────────────────────────────────┘
```
*(The Auctions cards, filter box, chips, and per-card tools are all existing UI — the only new thing is the one-click jump that pre-fills the seller filter.)*

Seller with zero auctions → no **View Auctions** button (the "0 auctions" meta already states it).

---

## 6. File-level implementation plan

> For a future implementation task. **Not executed here.** Single file; all changes additive; reuses existing helpers and the existing Auctions tab.

**`public/admin/moderation.html`** — the only file touched.

1. **Seller row builder** (`loadSellers`, in the `sellers.forEach` block, near the S1 Suspend button ~line 1570): add a **View Auctions** button when `s.auction_count > 0`, styled with the existing `.btn .btn-sm`, `flex-shrink:0`, wired to `viewSellerAuctions(s.email)`. Place it before the Suspend/Unsuspend button (primary navigation reads left-to-right: navigate → act → review).
2. **New function `viewSellerAuctions(email)`** (placed near the other auction-filter helpers, ~line 1080, or near `loadSellers`): builds a clean `seller_email`-only filter object, `persistAuctionFilters(f)`, `loadedTabs.delete('auctions')`, `switchTab('auctions')`. ~8 lines. Reuses `persistAuctionFilters`, `loadedTabs`, `switchTab` verbatim.

No backend, route, service, middleware, migration, schema, or test-fixture changes. No change to `api()`, `loadAuctions`, the filter helpers, or any Tier 1 / Tier 2 / S1 code (the row builder gains one more additive button alongside the existing ones).

---

## 7. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | `auction_count` (by `seller_id`) ≠ filtered list (by `email`) if a user has multiple `seller_profiles` | Very low | Low | Not the normal ownership chain (1 user → 1 profile). The button only navigates; the Auctions tab shows the authoritative filtered list regardless of the count label. Acceptable; note for QA. |
| 2 | Stale Auctions filter from a prior session bleeds into the seller view | Low | Low | `viewSellerAuctions` sets a **clean** filter (clears state/search/toggles) before persisting, so the operator always sees the full seller-scoped list. |
| 3 | Tab doesn't reload because Auctions was already loaded | Medium (without guard) | Low | `loadedTabs.delete('auctions')` before `switchTab('auctions')` forces `loadAuctions()` to run with the new hash (same pattern `applyAuctionFilters` uses). |
| 4 | New button breaks `.row-item` flex layout / mobile overflow | Low | Low | `.row-item` is `flex-wrap:wrap`; button is `flex-shrink:0` (same pattern S1/Tier 2 used successfully). Verify 390px no-overflow. |
| 5 | Email with characters needing encoding in the hash | Low | Low | `persistAuctionFilters` already `encodeURIComponent`s `seller_email`; `currentAuctionFilters` decodes. No new handling needed. |
| 6 | Scope creep into a new seller-detail page / new endpoint | Medium | Medium | Out of scope. Reuse the existing Auctions tab + `seller_email` filter only. No new infrastructure. |
| 7 | XSS via email injected into the hash/DOM | Low | Medium | Email is placed into the hash (encoded) and into the existing `#auctions-filter-seller` input `.value` (not `innerHTML`); the Auctions list renders email via existing escaped paths. No raw `innerHTML` of the email. |

**Overall risk: low.** Front-end-only navigation that reuses an already-shipped filter, endpoint, and tab. No backend or data-shape change.

---

## 8. Recommended implementation order

1. **Add `viewSellerAuctions(email)`** (the ~8-line navigation helper). Pure reuse of existing filter + tab machinery.
2. **Add the View Auctions button** to the seller row (count-gated), wired to the helper.
3. **Manual staging validation** — using seeded validation identities (`project_validation_identities`; no speculative credentials): from a seeded seller with ≥1 auction, click **View Auctions**, confirm the Auctions tab opens pre-filtered to that seller, the seller input box shows the email, and the listed auctions match. Confirm a 0-auction seller shows no button. Verify mobile (390px) no-overflow.

Both steps are a single contiguous additive change in one file, independently revertable. Mirrors the established cadence: implement → mocked/headless self-check → staging sign-off.

---

## 9. Explicit non-goals (scope guard)

- ❌ No backend/endpoint change (`seller_email` filter + sellers list already exist).
- ❌ No new endpoint, no new query parameter, no schema/migration change.
- ❌ No new seller-detail page or new auction-rendering surface (reuse the Auctions tab).
- ❌ No change to `loadAuctions`, the filter helpers, `api()`, or any Tier 1 / Tier 2 / S1 code beyond adding one additive row button.
- ❌ No governance, RBAC, or analytics work.
- ❌ No buyer- or seller-facing change; admin-tab-only.
- ❌ Not capability editing (still deferred) and not Tier 3 global Activity view.

---

*End of planning document. Awaiting approval before any implementation begins.*
