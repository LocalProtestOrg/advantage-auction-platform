# AAC Organization Reconciliation

**Status:** DEFERRED — future master-data governance project. **Documentation only; no reconciliation performed.**
**Recorded:** 2026-07-30 · **Owner decision:** duplicate AAC organizations are intentionally left as-is.
**Not part of:** the Event Import Framework. That framework uses one approved canonical owner and touches
none of the records described here.

---

## 1. Why this document exists

While identifying the canonical organization that should own imported events, an audit of the Railway
`organizations` table surfaced **three overlapping "AAC / Advantage Auction Company" identities** plus a
BD stock-sample record. The owner reviewed the finding and decided that consolidating them is a **separate
governance project**, not something the import work should attempt. This document preserves the exact
landscape as discovered so the future project starts from facts, not re-discovery.

**Explicitly out of scope here and deferred:** merging, deleting, or archiving any organization; migrating
events; updating foreign keys; changing `bd_listing_id`; reconciling the `bd_listing_id` unique constraint.

---

## 2. Current AAC organization landscape (as discovered 2026-07-30, read-only)

Prod endpoint `ep-proud-leaf-an8pzkib`. All four rows have `status='active'`.

| # | Organization ID | name / slug | type | lifecycle_state | source | bd_listing_id | verification | plan | events (published) | match_key |
|---|---|---|---|---|---|---|---|---|---|---|
| **1 (canonical)** | `a9a2f8c6-5929-4335-a453-ffef96270e5c` | Advantage Auction Company / `advantage-auction-company` | auction_company | active_partner | **admin** | NULL | **verified** | premium | **13 (13)** | `advantageauctioncompany:` |
| 2 | `6a89e8f7-fab4-40d1-a194-0ee98b37a123` | Admin User - Blog Author / `admin-user-blog-author` | auction_company | inactive | bd_import | **5** | unverified | free | 0 | `adminuserblogauthor:ny` |
| 3 | `6f93e182-5db5-4e97-9536-6cc67e321479` | AAC / `aac` | auction_company | inactive | bd_import | **28** | unverified | free | 0 | `aac:ny` |
| 4 | `ab303fcb-b693-4a20-aa42-b22d1c5598f4` | AAC / `aac-2` | NULL | active_partner | onboarding | NULL | unverified | free | **14 (13)** | `aac:` |

**Approved canonical owner of imported events:** **Row #1** (`a9a2f8c6…`) — verified, premium,
active_partner, admin-created, already owns published events. (Confirmed by the owner 2026-07-30.)

### Related BD member identities (for context; not Railway rows)
Verified live against advantage.bid (site 15779):
- **BD Member ID 5** — "Admin User - Blog Author", `sample3@sample.com`, empty company, New York NY. A
  Brilliant Directories **stock sample** record (sibling of user_id 4 "Sample General User"). Shadowed in
  Railway by **row #2**. **Not AAC.**
- **BD Member ID 28** — company **"AAC"**, `tylerwitt2015@gmail.com`, Estate Liquidator, New York NY,
  `/united-states/new-york/estate-liquidator/aac`. The apparent real AAC **public directory** profile.
  Shadowed in Railway by **row #3**.

A `company contains "Advantage"` scan of all 347 BD members returned zero rows. Across all 338 Railway
organizations, exactly one row carries `bd_listing_id='5'` and exactly one carries `bd_listing_id='28'`.

---

## 3. Why the duplicates exist

Each row was created by a **different path**, and no dedup ever ran across them (their `match_key`s differ,
so the marketplace matcher treated them as distinct):

- **Row #1** — created by an **admin** action (`source='admin'`) as the platform's canonical partner org;
  `match_key='advantageauctioncompany:'`.
- **Rows #2 and #3** — created by the **BD directory sync** (`source='bd_import'`), one row per BD member
  (5 and 28); `match_key` keyed on `name:state` (`…:ny`), hence separate from #1 and #4.
- **Row #4** — created through the **onboarding/signup** flow (`source='onboarding'`) as a second "AAC";
  `match_key='aac:'` (no state suffix), so it never collided with row #3's `aac:ny`.

Net effect: three legitimate creation paths produced three "AAC-ish" records, and the BD sample account
added a fourth unrelated row. This is ordinary master-data drift, not corruption.

---

## 4. Why reconciliation was intentionally deferred

1. **The Event Import Framework does not need it.** Imported events are owned by the single approved
   canonical org (#1). The importer ignores BD member IDs entirely and never reads or writes the duplicate
   rows. Reconciliation would add risk with zero benefit to the import feature.
2. **`bd_listing_id` is uniquely constrained** (`uq_organizations_bd_listing … WHERE bd_listing_id IS NOT NULL`).
   `'28'` is currently held by row #3. Linking the BD-28 identity to the canonical org would require first
   clearing/reassigning row #3 — a destructive-adjacent write that must not happen implicitly.
3. **Multiple live dependencies.** Rows #1 and #4 already own published events (13 and 14). Any merge must
   preserve event ownership, seller relationships, BD sync linkage, and audit history — a controlled,
   separately-reviewed migration, not an inline fix.
4. **Master-data governance is its own discipline.** Choosing the surviving record, its canonical URL, and
   how history is preserved are product/governance decisions, not engineering conveniences.

---

## 5. Risks of premature merging (why "just merge them" is unsafe)

- **Event-ownership loss / breakage:** rows #1 and #4 own 27 events combined. Repointing
  `events.organization_id` without a controlled, audited migration risks orphaned or mis-attributed events,
  and changes public attribution on live pages.
- **Canonical-URL / SEO regression:** organizations and their events resolve to canonical Railway URLs
  (slugs `advantage-auction-company`, `aac`, `aac-2`). Collapsing slugs can 404 or soft-404 indexed pages
  and lose accrued SEO/AI-discoverability — directly against the platform's SEO guarantees.
- **BD synchronization drift:** rows #2/#3 are `bd_import` mirrors keyed to BD members 5/28 via
  `bd_listing_id` (unique) and `match_key`. Deleting or repointing them can desync the daily BD directory
  sync or resurrect the rows on the next run.
- **Seller-relationship damage:** `linked_seller_profile_id` / `seller_profile_id` (currently NULL on these
  rows, but the schema supports it) and capability/plan links could be severed by a naive merge.
- **Audit / history loss:** `audit_log`, `bd_metadata`, `crm_stage`, and creation provenance would be
  ambiguous after a merge unless explicitly preserved.
- **FK cascade surprises:** other tables reference `organizations(id)` (events, marketplace links, plans,
  capabilities). A merge must enumerate and remap every referencing FK deliberately.

---

## 6. Proposed future reconciliation strategy (for the deferred project — NOT executed)

A controlled, reversible, audited sequence — to be planned and approved on its own:

1. **Decide the surviving canonical record.** Recommend row #1 (`advantage-auction-company`) — verified,
   premium, admin-created, canonical name.
2. **Enumerate every FK** referencing `organizations(id)` and produce a per-table repoint plan for the
   losing rows (#3, #4, and — separately — the BD sample #2, which likely should simply stay a BD mirror).
3. **Repoint dependent rows** (events, marketplace links, plans, capabilities, seller links) to the survivor
   in a single guarded, transactional migration with a full backup first, one audit row per repoint, and a
   verified before/after count. No data deleted in this step.
4. **Preserve history:** retain the losing rows' identity in a `bd_metadata` / provenance field on the
   survivor (or an `organization_aliases` record) so prior slugs/BD linkage remain traceable; add 301
   redirects for retired slugs to preserve SEO.
5. **Resolve `bd_listing_id`** as an explicit, separate decision: whether BD Member 28 should ultimately map
   to the survivor (requires clearing #3's value first, honoring the unique constraint), or remain a
   distinct BD directory mirror. This is the master-data question the owner deferred.
6. **Retire the duplicates** (archive, not hard-delete) only after all dependents are repointed and verified.
7. **Reversibility:** every step has a scripted rollback and is preceded by a fresh Neon backup, per the
   house production-promotion rule.

**Guiding constraints (unchanged):** Railway is the canonical source of truth; BD is the marketing/directory
layer; preserve production data, SEO, and AI discoverability; never silently mutate production data.

---

## 7. Do-not-touch list (until this project is separately approved)

- Do not merge, delete, or archive organizations `a9a2f8c6…`, `6a89e8f7…`, `6f93e182…`, `ab303fcb…`.
- Do not change any `bd_listing_id` (do not move or clear BD Member 28).
- Do not migrate events or repoint any foreign key.
- Do not run the BD sync in a mode that could rewrite these rows as part of import work.
