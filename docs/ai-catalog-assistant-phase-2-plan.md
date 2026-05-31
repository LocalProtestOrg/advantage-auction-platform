# AI Catalog Assistant — Phase 2: Seller Verification Layer (Planning Document)

*Planning only. No implementation. Designs a button-driven seller-verification layer on top of the existing AI description generator. **Not** a chatbot, **not** conversational, **no** seller typing. Builds on the working Phase 1 pipeline; additive and server-authoritative.*

> **Verified current state (2026-05-31):**
> - `POST /api/ai/generate-description` (`src/routes/ai.js`) takes `{ imageUrl }`, calls Claude **`claude-haiku-4-5-20251001`** vision (`src/services/aiDescriptionService.js`), and returns `{ title, description, category, pickup_category }`. It is **stateless** — nothing is persisted; the UI (`dashboard/lots.html` `generateAiDescription`) just fills `lot-title` / `lot-desc` / `lot-category` and calls `saveDraft()`.
> - `lots` columns relevant here: `title, description, category, condition, material, era, maker_artist, weight, size_category, dimensions(JSONB)`. **No `metadata` JSONB, no AI columns** — there is nowhere today to store AI output, seller confirmations, or provenance.
> - **History/trust constraint (Defect 4):** a dormant `SAMPLES`/`fallback()` once returned random samples masquerading as AI output, causing a real incident. This layer must **never fabricate**; every stored fact must be a real AI output or a real seller selection, and "AI unavailable" must stay an explicit error (the existing `AIUnavailableError` → 503 pattern).

---

## 1. Workflow design

Approved flow (no typing, no conversation, multi-select only):

```
1. Seller uploads photo  ──► (existing) Cloudinary URL
2. Seller clicks "Generate AI Description"
      └─► POST /api/ai/generate-description { imageUrl }
          returns: v1 { title, description, category, pickup_category }
                 + clarification_schema  ◄── NEW: the relevant button groups for THIS item
3. UI renders relevant clarification button GROUPS (multi-select chips) below the description.
   Only groups relevant to the detected category appear (e.g. Fine Art → Artwork + Condition).
4. Seller taps any applicable buttons across groups (multi-select; nothing required).
5. Seller clicks "Update Description"
      └─► POST /api/ai/refine-description { imageUrl, v1, selections }  ◄── NEW
          returns: v2 description (regenerated, honoring confirmations;
                   MORE CONSERVATIVE for any group where "Not Sure" was chosen)
6. UI replaces the description with v2. Seller may re-select and Update again (idempotent).
7. Seller clicks Save (existing lot save)
      └─► the full verification bundle is persisted (v1, schema, selections, v2, final). NEW
```

Design rules enforced by this flow:
- **Buttons only, no typing** for verification. (The existing free-text description field remains seller-editable as today — but the *verification signal* is 100% button-derived.)
- **Multiple selections before a single Update** — Update is an explicit action, not per-tap.
- **Only relevant categories appear** — driven by the AI-detected category → a code-owned category map (§8).
- **"Not Sure" makes AI more conservative, not more specific** (§7) — a hard prompt + server rule.
- **Re-entrant** — Update can run repeatedly; each run is recorded (append-only, §5).

---

## 2. Data model

A new append-only table captures the full provenance bundle. `lots` is **not** widened (keeps the hot table lean; provenance is write-rarely/read-rarely).

```
lot_ai_verifications (
  id                 UUID PK default gen_random_uuid(),
  lot_id             UUID REFERENCES lots(id) ON DELETE CASCADE,   -- nullable until the lot is saved (see §5.1)
  draft_correlation  TEXT,                 -- client-generated id linking pre-save generate/refine events to the lot
  seller_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  image_url          TEXT NOT NULL,        -- the analyzed image (Cloudinary URL)
  ai_model           TEXT NOT NULL,        -- e.g. 'claude-haiku-4-5-20251001'
  prompt_version     TEXT NOT NULL,        -- bump when the prompt/schema changes (learning segmentation)
  event_type         TEXT NOT NULL CHECK (event_type IN ('generate','refine','final')),
  ai_title           TEXT,
  ai_description     TEXT,                  -- the AI output for THIS event (v1 on generate, v2 on refine)
  ai_category        TEXT,
  clarification_schema JSONB,              -- the groups/options presented to the seller for this item
  seller_selections    JSONB,              -- { groupKey: [selectedOptionKeys...] } as confirmed by the seller
  final_description    TEXT,               -- set on the 'final' event = what was actually saved to the lot
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

- **Append-only**: one row per `generate` / `refine` / `final` event. Never updated/deleted (dispute integrity — mirrors the `audit_log` philosophy). The "current" view for admin = latest `final` (or latest event) for a `lot_id`.
- **Queryable columns** (`ai_model`, `prompt_version`, `event_type`, category) + **JSONB** (`clarification_schema`, `seller_selections`) → good for both admin display and bulk export for learning (§7).
- **`seller_selections` shape** (closed, code-validated against §8 registry):
  ```
  { "artwork": ["print","signed"], "condition": ["good"], "_not_sure": ["artwork"] }
  ```
  (Represent "Not Sure" either as a reserved option per group or a `_not_sure` list of group keys — finalize in implementation; the registry §8 defines valid keys.)

**Optional convenience pointer (not required):** `lots.latest_verification_id UUID` for O(1) admin lookup. Recommend deferring — a `SELECT … WHERE lot_id=$1 ORDER BY created_at DESC` is fine at current scale and avoids touching `lots`.

---

## 3. Seller UX

- After **Generate**, render the returned `clarification_schema` as labeled **groups of multi-select chip buttons** beneath the description (reuse the existing chip/badge styling already in the studio; no new component framework).
- Each group: a heading (e.g. "Artwork", "Condition") + its option buttons. Tapping toggles `selected` (visual press state). Multiple buttons across multiple groups may be active at once.
- **"Not Sure"** appears as an option in groups where it's appropriate (per registry). Selecting it visually de-emphasizes/locks the other options in that group (optional UX nicety) to signal "I'm declining to assert this."
- A single **"Update Description"** button triggers the refine call; a status line shows progress (reusing the existing `ai-gen-status` pattern). The description textarea is replaced with v2.
- No free-text is required or introduced by the verification step. The seller can still manually edit the description field afterward (existing behavior) — but the *stored selections* are button-only.
- **AI-unavailable** stays an explicit error (existing 503 surfacing), never a silent fabrication.
- Mobile-first: chips wrap; matches the studio's existing responsive patterns (verify 390px).

---

## 4. Admin UX

Admin must see, per lot: **AI-generated description (v1)**, **seller selections**, **final description**.

- Surface in the admin lot view reachable today via Moderation → Auctions → **Open Lot Studio** (admin already has full lot access), or a dedicated read panel. Recommended (reuse-first): a read-only **"AI Verification" panel** on the admin lot view that fetches the lot's verification bundle and renders:
  - v1 AI description + detected category + model/prompt version + timestamp
  - the clarification schema presented and the seller's selections (pretty-rendered, including any "Not Sure")
  - the final saved description, with a visual diff vs v1 if practical
- Reuse the established audit pattern: also write an `audit_log` event `lot_ai_verification_recorded` (entity_type `lot`, `lot_id`, metadata summary) so the verification shows up in the existing Tier 1 auction History timeline and is queryable with the audit tooling already shipped.
- Admin override preserved: admin can still freely edit the lot description (existing capability); their edit is itself audited via the existing `lot_updated` path.

---

## 5. Storage architecture

### 5.1 Linking pre-save events to a lot (the key sequencing problem)

AI generate/refine run **while the seller is composing the lot, before the lot row necessarily exists** (the studio uses a client draft). Two clean options:

- **Option A (recommended) — persist at Save, with in-flight correlation.** Generate/refine return their bundles to the client (as today) and the client holds them in memory keyed by a `draft_correlation` id. On lot Save, the client posts the accumulated bundle (v1 + schema + selections + v2 + final) and the server writes the `lot_ai_verifications` rows with the now-known `lot_id`. Simplest; one persistence point; no orphans.
- **Option B — persist each event immediately** with `draft_correlation` and a null `lot_id`, then backfill `lot_id` on Save. More robust for learning (captures abandoned attempts) but creates orphan rows needing cleanup.

**Recommendation: Option A** for Phase 2 (no orphans, minimal surface); revisit Option B if abandoned-attempt data proves valuable for learning.

### 5.2 Authority & integrity
- Server-authoritative: the server re-attaches `ai_model` / `prompt_version` / timestamps; the client cannot forge provenance.
- Append-only writes; no update/delete (dispute integrity).
- `seller_selections` validated server-side against the §8 registry (reject unknown group/option keys) so stored data stays clean for learning.

### 5.3 Privacy / retention
- Stored `image_url` is a Cloudinary URL (already public-ish within the platform); no new PII class. **Guard:** descriptions/selections must never capture address/seller-identity PII (the prompt already focuses on the item; keep it that way).
- Retention aligns with auction records; export for learning uses de-identified bundles.

---

## 6. Audit / dispute workflow

- The append-only `lot_ai_verifications` rows are the dispute record: for any lot they show **what the AI asserted (v1)**, **what the seller confirmed (selections)**, and **what was published (final)** — with model/prompt version and timestamps.
- Plus an `audit_log` event per recorded verification (reuse existing `writeAuditLog`), so disputes can be investigated through the same admin audit tooling shipped in Tier 1/Tier 2.
- Dispute scenario: "the listing said *original painting* but it's a print" → admin pulls the bundle: if the seller selected **Print** or **Not Sure** and the description still claimed "original," that's a generation defect (fix prompt); if the seller selected **Original Painting**, the seller asserted it (accountability is recorded). Either way the record is unambiguous.

---

## 7. AI learning architecture

- **Capture, don't train (yet).** Phase 2 only *stores* clean, versioned bundles; no training/fine-tuning is built now. The schema is designed to be the dataset.
- Each bundle carries `ai_model` + `prompt_version` so future analysis can segment by model/prompt and measure: how often sellers correct the AI, which categories get the most "Not Sure," which AI claims sellers most often override.
- **Export shape:** a simple admin/export query over `lot_ai_verifications` yields `(image_url, ai_v1, schema, selections, final)` tuples — directly usable for eval sets, prompt regression tests, or future fine-tuning. De-identified.
- **Feedback loop (future):** aggregate "AI said X, seller corrected to Y" pairs to refine the prompt and the category registry. Out of scope to build the loop now; the data makes it possible.
- **Conservative "Not Sure" rule (core trust behavior):** when a group is marked Not Sure (or the authenticity dimension is unconfirmed), the refine prompt must **drop or hedge** that attribute (e.g., never assert "original oil painting"; use "presented as" / omit) rather than guess. Implemented as: (a) explicit prompt instructions, and (b) an optional server-side guard that strips high-confidence claim phrases for unconfirmed dimensions. Note honestly: LLM adherence isn't guaranteed → see risk #3.

---

## 8. Category system design

A **code-owned registry** (consistent with `permissionRegistry` / `sellerTypes` discipline; not DB config), the single source of truth for groups, options, and which categories show which groups.

```
// src/constants/clarificationCategories.js  (NEW)
CLARIFICATION_GROUPS = {
  artwork: {
    label: 'Artwork', multiSelect: true,
    options: ['original_painting','print','lithograph','photograph',
              'signed','unsigned','antique','vintage','contemporary','not_sure'],
  },
  condition: {
    label: 'Condition', multiSelect: true,
    options: ['excellent','good','fair','poor','untested','not_sure'],
  },
  // furniture/material/era groups added as categories warrant…
}

// AI category (the rich one: 'Fine Art', 'Furniture', …) → ordered group keys
CATEGORY_CLARIFICATIONS = {
  'Fine Art':              ['artwork','condition'],
  'Furniture':            ['condition'],          // + material/era groups later
  'Jewelry':              ['condition'],
  'Clocks & Timepieces':  ['condition'],          // 'untested' is meaningful here
  // … fallback:
  '_default':             ['condition'],
}
```

- The **generate** endpoint maps the AI's detected `category` → the relevant group keys → returns a `clarification_schema` (groups + options + labels) for the client to render. Only relevant groups appear (requirement #5).
- **"Not Sure" availability** is per-group in the registry (requirement #6) — present where appropriate (e.g., authenticity/artwork, condition), omitted where it makes no sense.
- **"Untested"** lives in `condition` and is meaningful for mechanical/electrical items (clocks, tools) — shown "when appropriate" via the category map.
- The frontend needs the labels too; expose the registry to the client either via the generate response (embed the schema — recommended, keeps one source) or a small `GET /api/ai/clarification-schema` — recommend embedding in the generate response so the client never hard-codes options.
- **Contradiction handling:** options like `original_painting` vs `print`, or `signed` vs `unsigned`, are multi-select per spec; the refine prompt must reconcile conservatively (if both/none/Not Sure → hedge). The registry can annotate mutually-exclusive sets to help the prompt and optional UI hinting.

---

## 9. File-level implementation plan (for later phases — NOT executed now)

| # | File | Change |
|---|---|---|
| 1 | `db/migrations/052_create_lot_ai_verifications.sql` | New append-only `lot_ai_verifications` table (§2). Additive; no change to `lots`. Forward-only/idempotent per repo convention. |
| 2 | `src/constants/clarificationCategories.js` (new) | `CLARIFICATION_GROUPS` + `CATEGORY_CLARIFICATIONS` + helpers (`schemaForCategory`, `isValidSelection`). Source of truth (§8). |
| 3 | `src/services/aiDescriptionService.js` | (a) `generate` also computes `clarification_schema` from the detected category; (b) new `refineDescriptionFromSelections({ imageUrl, v1, selections })` with the conservative "Not Sure" prompt rules; stamp `ai_model` + `prompt_version`. Keep `AIUnavailableError` semantics. |
| 4 | `src/routes/ai.js` | Extend `generate-description` response with `clarification_schema`; add `POST /api/ai/refine-description` (auth: seller/admin); validate `selections` against the registry. |
| 5 | `src/routes/lots.js` (or new `verifications` route) | Persist the verification bundle on lot Save (Option A, §5.1); write the `lot_ai_verification_recorded` audit event; admin read endpoint `GET /api/admin/lots/:lotId/ai-verification`. |
| 6 | `public/dashboard/lots.html` | Render clarification chip groups after generate; multi-select state; "Update Description" → refine; carry the bundle + `draft_correlation` into Save. Reuse existing chip styling; no typing. |
| 7 | Admin lot view (moderation/lot studio surface) | Read-only AI Verification panel (v1 / selections / final) (§4). |
| 8 | `tests/` | Registry unit tests (schema-for-category, selection validation); refine-prompt conservative-behavior tests (mocked AI); persistence + admin-read integration; append-only invariant. |

No governance/RBAC, no analytics platform work, no change to bidding/payment/close. Reuses the audit infra and admin surfaces already shipped.

---

## 10. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Pre-save sequencing: AI runs before the lot exists → orphan/unlinked provenance | High (by design) | Medium | Option A (§5.1): hold bundle client-side under `draft_correlation`, persist at Save with the real `lot_id`. No orphans. |
| 2 | Contradictory multi-select (original + print, or both authenticity + Not Sure) | Medium | Medium | Registry marks mutually-exclusive sets; refine prompt reconciles conservatively (conflict/none/Not Sure → hedge). Optional UI hinting. |
| 3 | LLM ignores "be conservative on Not Sure" and still asserts specifics | Medium | High (trust) | Explicit prompt rules + optional server guard stripping high-confidence claim phrases for unconfirmed dimensions; eval tests on the refine prompt; this is a core trust requirement, test it hard. |
| 4 | Re-introducing a silent fabrication (Defect 4 regression) | Low | High | Never fall back to samples; `AIUnavailableError` → 503 stays; refine requires a real prior AI result + real selections. |
| 5 | Wrong category detected → wrong/empty clarification groups | Medium | Low | Always include `condition` via `_default`; admin can edit; category is a hint, not a gate. |
| 6 | Two AI calls per lot (generate + refine) — cost/latency | Medium | Low | Haiku is fast/cheap; refine only on explicit Update; cache v1; acceptable at pilot scale. Monitor. |
| 7 | Stored bundles bloat / retention | Low | Low | Append-only but small JSONB; align retention with auction records; export then prune if needed. |
| 8 | Scope creep into a conversational/typed flow | Low | High (explicitly forbidden) | Hard constraint: buttons only, no free-text in the verification path; reviewed against this doc. |
| 9 | Selections forged/garbage from client | Low | Medium | Server validates `selections` against the registry; rejects unknown keys; server stamps provenance. |
| 10 | PII leaking into descriptions/stored data | Low | Medium | Item-focused prompt; no address/identity capture; de-identified export. |

---

## 11. Recommended implementation order

1. **Foundation — data model + category registry** (Migration 052 + `clarificationCategories.js`). No behavior; everything else builds on these. *(Migration leads code.)*
2. **Backend — generate schema + refine endpoint** (extend `aiDescriptionService` + `ai.js`), with the conservative Not-Sure rules and registry-validated selections. Unit/eval tests for the prompt behavior.
3. **Persistence + admin read** (bundle write on Save via Option A; `lot_ai_verification_recorded` audit; admin read endpoint). Verifies the dispute/learning record exists before sellers use it.
4. **Seller UX** (clarification chips + multi-select + Update Description) in the studio.
5. **Admin UX** (AI Verification panel; reuse the audit timeline).
6. **Tests + staging validation** (seeded identities; no speculative credentials): photo → generate → relevant groups appear → multi-select incl. Not Sure → Update → v2 more conservative → Save → bundle stored → admin sees v1/selections/final; mobile no-overflow.

Each step is additive and independently shippable; the feature is dark until the UX lands, so backend/data can deploy first safely.

---

## 12. Explicit non-goals

- ❌ No conversational/chatbot UI; no seller typing in the verification path.
- ❌ No AI training/fine-tuning now (Phase 2 *captures* the dataset only).
- ❌ No change to bidding, payment, close, or the seller-type framework.
- ❌ No silent fallback/fabrication (Defect 4 must not recur).
- ❌ No `lots` table widening (provenance lives in its own table).
- ❌ No governance/RBAC/analytics-platform work.

---

*End of planning document. Awaiting approval before any implementation. Phase C of the Seller-Type Rules Framework remains paused/not started, per instruction.*
