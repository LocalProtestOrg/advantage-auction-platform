# Deliverable 12 — VS Code Production Handoff: Owner Creative Reference System

**Phase 3P · 2026-09-09 · Design handoff. No production code was written. Nothing was published, sent, spent, activated or modified in
production.** Implement additively on the Phase 3O spine and the ported 3M.3 runtime; do not reinterpret either.

## 0. Scope in one paragraph

Add a *reference layer* around the existing creative runtime: a library indexer, a retriever, a principle extractor that writes a
`calibration` block into the creative brief, a calibration scorer that reads the render and the brief, three new QA gates, an Owner
feedback ingester, and two new family engines (ENVIRONMENTAL_PHOTO, CATALOG_SCATTER). The 3M.3 rule engine, the extraction gate, the brand
frame, the A2 claim manifest, the obligation model and every publish gate stay exactly as they are.

## 1. File / index architecture

```
docs/marketing/approved-creative-examples/            ← the library (Owner's folder; source of truth for Owner decisions)
  README.md                                           ← Owner-facing instructions (plain English)
  reference.schema.json                               ← sidecar contract (delivered)
  index.json                                          ← BUILD ARTIFACT of the indexer (delivered as reference implementation output)
  OWNER-CREATIVE-REFERENCE-INDEX.md                   ← BUILD ARTIFACT, human view
  owner-decisions.jsonl                               ← append-only ledger of Owner decisions (create empty)
  <category>/<image>                                   ← Owner drops images here
  <category>/<image>.reference.json                    ← sidecar, generated; never Owner-edited
  <category>/gold-standard/                            ← Owner moves an image here to promote it
  <category>/do-not-use/                               ← Owner moves an image here to mark negative evidence
docs/marketing/phase3p/                                ← this handoff and Deliverables 1–11
```

Categories (folder names, fixed): `auction`, `estate-sale`, `notable-lot`, `geographic-event`, `individual-seller`, `professional-seller`,
`buyer-growth`, plus `closing-soon` and `brand` (create empty). Folder → default `owner_folder`; campaign class is read from the sidecar.

Runtime module (`marketing/creative_reference/`, or the equivalent package in the platform's language):

| Module | Responsibility |
|---|---|
| `indexer` | Walk the library; hash every image; reconcile with sidecars by hash (new → stub record + task; moved → update `current_path`, status from folder; missing → RETIRED); apply `owner-decisions.jsonl` entries not yet applied; validate all sidecars against the schema; lint `transferable_lessons`/`do_not_generalize` for coordinate-like content (px, %, #hex, font names); write `index.json` and the .md view; upsert `marketing_creative_references`. Run on commit (CI) and on demand (admin button). |
| `retriever` | Deliverable 6 §2. Deterministic given the index version. |
| `principles` | Deliverable 6 §3. Builds `brief.calibration`; enforces seller-identity stripping; the output is schema-validated to contain no hex, px, font or seller strings. |
| `scorer` | Deliverable 7 Part B. Metrics from `compose.metrics` + new text-box measurements; vision judge; hard checks; layout signatures. |
| `feedback` | Deliverable 9. Ledger ingestion; admin API for buttons; "add generated creative to library". |
| `families/environmental_photo`, `families/catalog_scatter` | New engines (§5). |

Database (additive; reuse mig-126 creative/QA tables; no remodel):

| Table | Purpose |
|---|---|
| `marketing_creative_references` | sha256 PK, reference_id, current_path, owner_status, owner_weight, campaign_class_primary, secondary[], visual_family, nearest_advantage_family, seller, sidecar jsonb, sidecar_hash, index_version, updated_at |
| `marketing_creative_reference_decisions` | mirror of the ledger (ts, source, owner_words, resolved_ref/job, action, payload, recorded_by, applied_at) |
| `marketing_creative_calibrations` | creative_job_id, index_version, retrieved[] (id, weight, sidecar_hash), principle_profile jsonb, do_not_copy jsonb, metrics jsonb, judge jsonb (×2), hard_checks jsonb, similarity jsonb, score, decision, scorer_version, judge_model, prompt_version |
| `marketing_creative_layout_signatures` | creative_job_id or reference sha256, family, signature vector, created_at |

## 2. Metadata schema

`reference.schema.json` as delivered (draft 2020-12; `additionalProperties: false`). Key contract points VS Code must honour:

- Identity = `identity.sha256`; `current_path` is informational.
- `owner_status` ∈ {OWNER_APPROVED, OWNER_GOLD_STANDARD, OWNER_DO_NOT_USE, RETIRED}; `owner_weight` recomputed by the indexer from status.
- `status_history[].source` is the closed set of Owner channels; no other writer may change status (negative test).
- `transferable_lessons` is the only field that may be read by `principles`; `do_not_generalize` and `source.seller` feed `do_not_copy`.
- `performance` is reserved and never read by retrieval or scoring.

Sidecar for a generated creative admitted to the library (auto-generated): same schema; `source.seller = "Advantage.Bid"`,
`source.origin = "generated by the production creative engine, job <id>, Owner-approved"`, `provenance.analysis_method = "derived from brief, audit and metrics"`.

## 3. Retrieval rules

As Deliverable 6 §2–3. Implementation notes:

- Facet similarity: weighted Jaccard — event_mode 0.25, nearest_advantage_family (if requested) 0.25, merchandise_breadth 0.2, format_class
  0.1, seller_hierarchy 0.1, tags 0.1.
- `avoid_for` is a hard exclusion by class name match.
- Top-5 cap; ties broken by reference_id for determinism.
- Empty result → `confidence = LOW`, `owner_review_required = true`, global profile at 0.25 relevance.
- Seller concentration > 0.6 → `strip_seller_identity = true` (log it).
- Retrieval output is persisted with the index version so the same brief can be replayed.

## 4. Weighting

Deliverable 7 Part A. Constants live in config, not code: `OWNER_APPROVED 1.0`, `OWNER_GOLD_STANDARD 2.0`, `OWNER_DO_NOT_USE -1.0`,
`RETIRED 0`; relevance 1.0 / 0.5 / 0.25; ACCEPT bar 70, raised to 75 when the class has a Gold Standard; REGENERATE band 50–69.

## 5. Creative-runtime integration

**Brief (additive to `creative_brief.schema.json`; bump `$id` to a 3P version, keep 3O fields unchanged):**

- `calibration` (object, required from 3P on) — shape in Deliverable 6 §3.
- `merchandise_mode` enum `lots | photograph | representative | none` (required).
- `objects` becomes required only when `merchandise_mode = lots`; add `objects[].auction_id` (required, must equal `auction_id` — schema
  cannot express equality, enforce in the validator).
- `site_photographs[]` `{asset_id, provenance_row_id}` required when `photograph`.
- `representative_assets[]` `{asset_id, rights, representative_not_lots: const true}` required when `representative`; permitted only when
  `campaign_class ∈ {individual_seller_acquisition, professional_seller_acquisition, buyer_platform_growth, general_brand}`.
- `event.sessions[]` `{day_label, date, start, end}`, `event.place_name`, `event.neighbourhood`, `event.online_only` (bool).
- `text_budget.profile` enum `GENERAL | LOGISTICS | TEASER` with `max_text_blocks` 5 / 7 / 3; `logistics_reason` required for LOGISTICS.
- `family` enum gains `ENVIRONMENTAL_PHOTO`, `CATALOG_SCATTER`; `family_options` `{title_position: top|bottom|panel, teaser: bool, ground: white|very_light|dark_hero|photograph}` with family-scoped validation (dark_hero only for SINGLE_LOT; photograph only for ENVIRONMENTAL_PHOTO).
- `cta` `{kind: none|factual, text, fact_ref}` — at most one; `fact_ref` must resolve in the claim manifest.

**Result (additive to `creative_result.schema.json`):** `calibration_score` (number), `calibration_breakdown` (object),
`similarity` `{max_reference: {reference_id, distance}, self_history_min_distance, published_anchor_distance|null}`, `seller_mark_leak`
(bool), `owner_review_required` (bool), `decision` enum gains `REGENERATE`, `FALLBACK_DEFAULT_FAMILY`, `BLOCKED_CALIBRATION`, `OWNER_REVIEW`.
`x-gate` becomes: CREATIVE_READY requires the 3O condition ∧ `calibration_score ≥ bar` ∧ ¬`seller_mark_leak` ∧ similarity within thresholds
∧ (¬`owner_review_required` ∨ an Owner review row with status ≥ approved).

**Audit profiles by family (select before calling the rule engine):**

| Family | `spatial.audit` | `text_budget_audit` | `category_balance` | Extra |
|---|---|---|---|---|
| CENTERED_WHITE, LEFT_THIRD_WHITE, COBRANDED | full (unchanged) | profile budget | yes | title_position bottom requires upper_half_merch ≥ 35 |
| CATEGORY_GROUP (LINEUP / TILE_GRID) | baseline alignment + protected regions only | profile | no | reflections or shadows consistent |
| SINGLE_LOT | protected regions; dark ground allowed only with `dark_hero` | profile | no | object ≥ 45% of canvas height |
| CATALOG_SCATTER | protected regions + thumbnail; gravity/wall/surface/perspective skipped; overlaps not penalised | TEASER or GENERAL | breadth ≥ 6 families required | rationing counter per seller × quarter |
| ENVIRONMENTAL_PHOTO | photograph legibility: no copy over merchandise except a place plate ≤ 6% area; contrast ≥ 4.5:1 for copy on the panel/bands | profile | n/a | photograph provenance bound to event |
| Acquisition / brand | no spatial audit; representative flag; no lot claims | TEASER/GENERAL | n/a | screenshot provenance if used |

**Brand frame** unchanged (`logo 250px`, kicker, `120px` navy band, `64px` wordmark, red accent, ground white/very_light) for 1080×1350;
derive per-format constants proportionally (band ≈ 8.9% of height) rather than copying pixel values into 1200×628.

**Generation order:** classify → retrieve → principles → facts/assets → brief → family select → generate → audit profile → QA → score →
decide. Publishing untouched.

## 6. QA integration (new gates, after existing G0–G9)

| Gate | Check | Fail → |
|---|---|---|
| **G10 Reference calibration** | score ≥ bar; per-principle evidence stored | REGENERATE / FALLBACK per §4 |
| **G11 Anti-similarity** | layout-signature distance ≥ τ_ref (every library reference), ≥ τ_self (last 5 accepted, same seller × class), ≥ τ_pub (published anchor when supplied) | HARD FAIL |
| **G12 Seller-mark leak** | OCR (any engine) + logo template match on the final render against the seller-mark blocklist minus the brief's own cobrand seller | HARD FAIL |
| **G13 Merchandise provenance** | every object `auction_id` = brief; every photograph/representative asset has a provenance row; representative only in acquisition/brand classes | HARD FAIL |
| **G14 Owner review** | classes with zero references, first 3 creatives of any new family, and every proving ground require an Owner review row before CREATIVE_READY | hold in OWNER_REVIEW |

Initial thresholds (tune on the proving grounds, record changes as CONFIG_PROPOSAL): signature = concat(text-box map 12×12, merchandise
mask 12×12, one-hot panel side / band / title position), cosine distance; τ_ref 0.35, τ_self 0.25, τ_pub 0.40.

## 7. Calibration scoring

Deliverable 7 Part B. Implementation notes: measurable principles use `compose.metrics` (merchandise_pct, text_region_pct,
largest_empty_pct, upper_half_merch_pct), the audit summary (planes, meaningful/decorative overlaps) and the rendered text boxes (sizes
for hierarchy and date>time). The judge is a vision model call with the render, the principle profile text and the family — never a
reference image; prompt and model version are recorded; two runs; disagreement > 8 → flag. Bands per family come from
`index.json → principle_profiles_by_advantage_family` intersected with the Advantage.Bid brand-frame constraints and the C6 hypothesis
(scene merchandise 50–65%, text ≤ 18%) until the first proving ground confirms or adjusts them.

## 8. Provenance

Every creative job stores: brief hash; `index_version` and the sha256 of every retrieved sidecar; principle profile and do-not-copy
list as used; family and audit profile; object/photograph/representative asset ids with provenance rows; fonts bundle hash; scorer
version; judge model + prompt version + both judge outputs; similarity distances and the signatures compared; hard-check results; decision;
and, when present, the Owner review row id and the Owner's words. Reference images are never stored with the job — only their hashes.

## 9. Learning boundaries

Implement the twelve mechanisms in Deliverable 8 as code, with the listed tests. In particular: the compositor asset loader must have no
path to the library directory; `owner_status` writes are limited to the schema's four sources; the learning service has no write access to
sidecars or the ledger; CATALOG_SCATTER carries a rationing counter; representative mode is schema-blocked outside acquisition/brand classes.

## 10. Tests (minimum)

1. **Schema:** all sidecars validate; a sidecar with a hex colour in `transferable_lessons` fails lint; a `status_history.source` outside the enum fails.
2. **Indexer:** add / move (to gold-standard, to do-not-use, rename) / delete → correct status, path, history, weight; hash stable across moves; foreign file outside a category is reported, not indexed; ledger entries applied once (idempotent).
3. **Retrieval:** deterministic top-5 for a fixed index; `avoid_for` exclusion; empty class → LOW + review flag; seller concentration → strip flag; Gold Standard always included for its class.
4. **Principles:** output contains no hex/px/font/seller strings (string scan) with a 100% single-seller retrieval.
5. **Brief validation:** merchandise_mode cross-checks; mixed auction ids rejected; representative outside acquisition rejected; LOGISTICS without reason rejected; dark_hero outside SINGLE_LOT rejected.
6. **Audit profiles:** B1/B2/B3 fixtures still reproduce `expected/*_audit.expected.json` exactly under CENTERED_WHITE (no regression); scatter profile skips gravity; environmental profile flags copy over merchandise.
7. **Scorer regression:** B1/B2/B3 scored against the delivered index → stored baseline; scorer changes must re-run.
8. **G11:** a library reference submitted as a candidate HARD FAILS; five re-runs of one brief are pairwise ≥ τ_self.
9. **G12:** "LMAuctionCo" in a non-L&M brief fails; passes in an L&M cobranded brief; a crest template match fails.
10. **G13:** object from another auction fails; representative asset in an auction class fails.
11. **Family selection:** 3 objects → LEFT_THIRD_WHITE only; 1 object → SINGLE_LOT; online-only + photographs → not ENVIRONMENTAL_PHOTO; scatter rationing enforced.
12. **Feedback:** "gold standard" ledger entry → weight 2.0 and history row; "don't use" → negative retrieval; generated-creative approval → new sidecar with Advantage.Bid provenance and index rebuild.
13. **Publish isolation:** proving-ground dry run asserts A9 OFF and creates no destination job; a creative result referencing a library hash as an asset fails validation.

## 11. First proving-ground procedure (West University) — Deliverable 10, executable summary

1. Confirm preconditions and stage the published graphic as `published_anchor` (hash recorded; scorer-only access).
2. Run classification → retrieval → principles for the production event; persist the brief.
3. Generate variants A (ENVIRONMENTAL_PHOTO banded), B (ENVIRONMENTAL_PHOTO panel, or LEFT_THIRD_WHITE if no usable site photograph), C (CALIBRATION EXTREME of the better of A/B, labelled NOT FOR PUBLICATION) in 1080×1350 and 1080×1080.
4. Run audit profile, G0–G14, scorer; C exempt from the score bar.
5. Assemble the review packet (renders, thumbnails, published graphic beside for comparison, brief, reference ids + lessons, audit, metrics, score breakdown, similarity, claim manifest, omissions statement, A9 status).
6. Send as `CREATIVE_REVIEW_REQUEST` to Desktop Marketing; Owner reviews visually; decisions recorded via the feedback model; `CALIBRATION_REPORT` back to VS Code. No publish.

## 12. Second proving-ground procedure (Individual Seller Acquisition) — Deliverable 11, executable summary

1. Classification `individual_seller_acquisition`; retrieval returns empty → LOW confidence, review required; global profile + class-neutral lessons at 0.25 listed in the packet.
2. Assets: Advantage.Bid-owned/licensed representative items flagged `representative_not_lots`; optional real create-auction screenshot captured from production with provenance; optional consented team photograph if one exists — otherwise the help element is copy/fact only. No stock, no generated people.
3. Generate concepts A ("Your things, your auction"), B ("You can do this", product-forward), C ("Help is here"), each in both formats, plus a CALIBRATION EXTREME of the strongest.
4. Acquisition audit profile; G10–G14 (G12 must be clean of every library seller); scorer with the global profile and the acquisition judge framing.
5. Packet as in §11 with an explicit "zero class references" statement; Owner review; an approved concept seeds the `individual-seller` folder with the first Advantage.Bid-provenance reference. No publish, no audience, no spend.

## 13. Dependency classes

| Item | Class |
|---|---|
| Indexer, retriever, principles, scorer (metrics part), gates G10–G14, brief/result schema extensions, feedback ledger, tests | BUILD BLOCKER for Phase 3P certification |
| Vision judge model access | BUILD BLOCKER (any capable vision model; version recorded) |
| Admin "Creative References" page with buttons | NOT REQUIRED FOR SOFTWARE CERTIFICATION (paths 1 and 2 of the feedback model suffice) |
| Site photographs / consented team photograph in production | OWNER-PROVIDER ACTIVATION DEPENDENCY (the proving grounds run with whatever exists; omissions are stated, never invented) |
| Any publishing | Not part of this phase; remains Owner-controlled and OFF |

## 14. Certification questions (answer YES/NO in the implementation report)

Real merchandise only, never invented? · Nothing published? · No external account connected? · No money spent? · Reference images never
reached a generator or a publish job? · Owner never required to edit a metadata file? · Performance never changed an Owner weight? ·
3M.3 fixtures still reproduce exactly?
