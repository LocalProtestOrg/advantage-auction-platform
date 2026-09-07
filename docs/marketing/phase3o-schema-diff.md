# Phase 3O SCHEMA_DIFF — migration 140 (live) vs Phase 3O schema pack

Comparison of the LIVE Marketing Package foundation (migration 140) against the 16-schema Phase 3O pack
(`docs/marketing/phase3o/schemas`). Principle: **extend safely, map deliberately, no destructive migration.**
Working production tables are not remodeled merely to make names identical.

## Obligation (`obligation.schema.json`)
| Contract field | Live (mig 140) | Resolution |
|---|---|---|
| `state` UPPERCASE (PLANNED…NEEDS_OWNER) | `state` lowercase (planned…needs_owner) | **Map at boundary** (DB stays lowercase; contract renders UPPERCASE). No table remodel. |
| `state_history` (append-only) | — | **ADD** `marketing_obligation_events` (append-only). |
| `feature_key` (from 32-catalogue) | `obligation_key` (free text) | **ADD** `feature_key` column; existing key maps. |
| `ladder_id` | — | **ADD** column. |
| `wave` | — | **ADD** column. |
| `window.{earliest,latest,must_start_by}` | — | **ADD** `window_earliest`, `window_latest`, `must_start_by` columns. |
| `attempts` (array) | — | **ADD** `attempts` int + attempt detail in events. |
| `purchase_ref{kind,id}` | `purchase_kind`,`purchase_id` | Map (already present). |
| `evidence_refs` | `proof` jsonb | Reuse `proof` + evidence rows. |
| BLOCKED metadata (reason, previous_state, retry cadence, deadline) | — | **ADD** `blocked_reason`,`previous_state`,`retry_after`,`deadline_at`. |
| NEEDS_OWNER metadata (reason, options, deadline) | — | **ADD** `needs_owner_reason`,`needs_owner_options` jsonb. |
| terminal immutability | (none) | **ADD** `terminal_at`; enforce in service (no retro-edit). |

## Purchase snapshot (`purchase_snapshot.schema.json`)
| Contract | Live | Resolution |
|---|---|---|
| `payment_ref` (NOT NULL) | `stripe_payment_intent_id` | Map. |
| `currency` const USD | `currency` (not stored on pkg table) | Emit `USD` at export. |
| `direct_authority_cents` | `internal_authority_cents` | Map. |
| `growth_base_cents` | — | Derive = amount − authority at export. |
| `terms_snapshot.non_refundable_sentence` const | (non-refundable by design) | Emit const at export. |
| `identity` UPPERCASE | `package_key` lowercase | Map at boundary. |
No table change required — snapshot is immutable + already frozen; contract shape is produced by the exporter.

## Readiness (`readiness.schema.json`)
6 states `NOT_CONFIGURED/CONFIGURED_UNVERIFIED/SHADOW_CERTIFIED/ACTIVE/PAUSED/REVOKED`. Live
`channelReadinessService` used `available/gated/unavailable`. **ADD** `marketing_channel_readiness` table +
extend the service to the 6 contract states; internal channels → ACTIVE, gated externals → SHADOW_CERTIFIED
(software built) or NOT_CONFIGURED.

## Interface message / bridge (`interface_message.schema.json`)
New. **ADD** `marketing_desktop_messages` (direction, type, body, schema_valid, applies_via, status) +
`marketing_runtime_exports`. `contains_production_credentials`/`contains_recipient_data` const false enforced
by validator + anonymized exporter.

## Feature/recipe/ladder catalogues (`features.json`,`recipes.json`,`ladders.json`)
32 features / 8 recipes / 11 ladders. **Read from the pack** (authoritative artifact) via `phase3oContract`
— NOT duplicated into the DB (per mission: do not commit unnecessary extracted duplicates).

## Director decision (`director_decision.schema.json`)
New record type. Bounded `DirectorDecision` enum has **no** REFUND/HIDE/REPRICE/OVERRIDE_SUPPRESSION — the
validator structurally rejects them (negative test).

## Fields that must NOT be added (already represented elsewhere)
- Internal economics / Growth Pool / ledger: already in mig 126 (`marketing_allocations`,`marketing_ledger`,
  `growth_pool`). The paid-allocation bridge LINKS to these — no new economics table.
- Creative provenance/QA: already mig 126 (`marketing_creative_*`,`marketing_qa_reviews`).
- Campaign lifecycle: `marketing_campaigns` (mig 126).
- Homepage reservations: `marketing_homepage_reservations` (mig 140).

## Deliberate deviations
1. **DB state casing stays lowercase**; contract UPPERCASE is a boundary mapping (avoids remodeling a live
   table + its CHECK constraint). 2. **Catalogues read from the pack**, not duplicated to DB. 3. **Snapshot
   contract shape is produced by the exporter** from the immutable mig-140 row (no snapshot table remodel).
