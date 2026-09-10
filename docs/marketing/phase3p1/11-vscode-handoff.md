# Mission 11 — VS Code Implementation Handoff: Physical Creative Intelligence

**Phase 3P.1 · 2026-09-10 · Design handoff on top of the production-certified Phase 3P system (`13-production-implementation.md`). No production code was written. Nothing published, sent, spent or activated.**

Everything Phase 3P certified stays: anti-copy (G11), seller-identity stripping, factual QA (A2 claim manifest, G13 provenance),
provenance records, Owner-review holds (G14), the 3M.3 rule engine and fixtures, the reference library and its indexer. Phase 3P.1
adds around them.

## 0. Files delivered

```
docs/marketing/phase3p1/
  00-README.md … 11-vscode-handoff.md                     the eleven missions
  owner-feedback-2026-09-10.jsonl                          seven attribute-level records (also appended to the ledger)
  config/feedback-record.schema.json                       Mission 1 contract
  config/approved-messages.json                            message ledger (You Can Do This. = OWNER_APPROVED_MESSAGE)
  config/media-source-hierarchy.json                       Mission 2 tiers, gates, scoring, Director algorithm
  config/object-taxonomy.json                              Mission 4: 54 classes with physical attributes
  config/relationship-rules.json                           Mission 4: edge types, valid/invalid, collision + scale model
  config/coverage-bands.json                               Mission 6 bands, gates, fit procedure
  config/prominence-rules.json                             Missions 7–8: brand identity + event type + text hygiene
  config/capitalization-rules.json                         Mission 9 rules + 12 tests
  reference/physical_audit.py                              Mission 4/5 reference implementation (port; keep thresholds in config)
  reference/title_case.py                                  Mission 9 reference implementation (12/12 pass)
  reference/tests/scene_is_a_as_rendered.json              fixture: Individual Seller A layout → 12 violations
  reference/tests/scene_is_planned.json                    fixture: planned layout → 0 violations
  reference/tests/comparison.jpg                           audit evidence image (not a creative)
approved-creative-examples/owner-decisions.jsonl           + 7 lines (CREATIVE_REVIEW ×6, OWNER_RULE ×1)
```

## 1. Owner feedback persistence (Mission 1)

- `feedbackLedger.js` learns two actions: `CREATIVE_REVIEW` and `OWNER_RULE`, validated against `feedback-record.schema.json`.
  Unknown actions are preserved and reported as unapplied — never dropped.
- New table `marketing_creative_feedback_attributes` (record_id, subject job/variant, render_sha256, attribute, polarity, severity,
  scope, note, evidence, ts) and `marketing_creative_feedback_messages` (text, status, scope, role, decided_on). Both are written only
  from ledger records whose `source` is an Owner source.
- Effects: `verdict.negative_signature = true` → the render's layout signature enters `marketing_creative_layout_signatures` with
  `polarity = negative` for the class; `library_admission = eligible_after_revision` sets a flag on the job, nothing else; `gold_standard`
  is a `const false` in the schema (a Gold write needs an explicit `SET_STATUS` with Owner words, unchanged from 3P).
- Retriever: negative signatures for the class are loaded; a candidate within τ_neg (config, initial 0.30) of one is penalised; within
  τ_neg/2 it hard-fails G11.
- Copy engine: only `OWNER_APPROVED_MESSAGE` entries from `approved-messages.json` may be labelled approved copy in a brief.

## 2. Attribute-level learning

Attributes with severity `required` or `strong` and scope `campaign_class` / `family` / `global` become scorer rules in v2 (below);
`this_creative` attributes attach to the job only. The mapping table lives in config so a new attribute vocabulary entry needs no code
change beyond a rule implementation.

## 3. Authentic media source hierarchy (Mission 2) — `mediaDirector.js`

Inputs: event record media (cover, videos, site photographs), CLEAN objects, provenance rows. Steps: provenance gate → `is_photograph`
(OCR + logo template; composed graphics → anchor role) → per-tier hard gates → per-tier scoring → tier walk 1→6 → override rule with
recorded reason → `media_decision` written to the packet and the brief (`brief.media_decision`, additive). `familySelector.js` reads
`media_decision.tier_selected` first: tiers 1–4 → ENVIRONMENTAL_PHOTO with `merchandise_mode = photograph`; 5 → scene families with
`lots`; 6 → RESTRAINED_FACTUAL (new family, brand frame + facts, optional single inset). Measures per `scoring_normalisation` in the
config; clutter and invitation via the vision judge with the named item list.

## 4. Cover-image quality scoring

Tier-1 criteria and gates as configured. Add `event.cover_image_is_photograph` (bool, computed) and `event.cover_image_media_score` to
the event's marketing metadata so the Director does not re-score on every job; re-score when the asset hash changes.

## 5. Video-frame selection (Mission 3) — `creative-engine/adb_engine/video_frames.py`

Decode metadata → sample (scene-change + 1 fps, cap 300, exclude first/last 1.5 s) → measures (Laplacian sharpness, frame-difference
motion, luminance/clipping/dark, detector counts for merchandise and obstruction classes, OCR, tilt, crop-fit, scene clustering by
signature) → gates → ranking per tier-2 weights → shortlist ≤ 8, scene-diverse → selected frame + `video_frame_selection` record.
Correction whitelist enforced in the asset pipeline (crop, straighten ≤ 3°, exposure, white balance, mild sharpen, downscale). First
frame never selected by position (test). No generative operations exist in the path (test: the module imports no inpainting/upscale code).

## 6. Semantic object taxonomy (Mission 4) — `objectTaxonomy.js` / `adb_engine/taxonomy.py`

Loads `object-taxonomy.json`; strips parenthesised annotations in support lists; resolves a lot to a class via `category_key` →
keyword rules → optional classifier, storing `semantic_class`, `confidence`, `dims_source` (catalogue | class_default). Extends the
object record in `creative_brief.objects[]` with `semantic_class`, `size_class`, `plane`, `anchor_weight`, `foreground_suitability`,
`protected_features`, `dims_in` (from the catalogue when present). Unresolved class in an anchor position → Owner-review flag.

## 7. Relative-scale model and physical relationship graph — `adb_engine/physical_audit.py`

Port `reference/physical_audit.py`: scene scale from the primary anchor; expected heights with depth factor; tolerances from config;
support edges; same-plane THROUGH / deep-overlap / lower-edge layering; protected-feature occlusion; wall and ground rules; declared
floor-vignette accents. Output: `violations[]` (id, kind, message) and `notes[]`. Runs as part of the family audit profile for every
family that places objects; category families skip the room-scale block.

## 8. Scene planning (Mission 5) — `adb_engine/scene_planner.py`

Replaces "place then audit" in the compositor job: classify → scale → anchors → planes → typed edges → secondary fill → foreground
accents → physical audit → 3M.3 audit → coverage fit → render. The plan JSON (Mission 5 shape) is persisted with the job and feeds the
layout signature. Violations return to the responsible step (config maps violation kind → step). The certified hand-placed B1/B2/B3
layouts are converted to plans as fixtures; the planner must reproduce their audits exactly.

## 9. Collision versus intentional overlap

Implemented in §7; the distinction is the typed edge plus the depth step and the lower-edge band. The judge v2 asks the three physical
questions (Mission 5) and a "yes" to through/wrong-size is a hard fail independent of the numeric audit.

## 10. Space utilization (Mission 6) — `adb_engine/coverage.py`

Merchandise field from reserved copy regions; coverage, cluster extent, accidental void (declared regions excluded), upper-field share;
family bands and gates from `coverage-bands.json`; the seven-step fit procedure; panel-content rule (≥ 55% of panel height). Hard floors
and caps replace the 3P soft bands in the scorer's measurable block; both field-based and canvas-based numbers are reported.

## 11. Logo prominence QA (Mission 7) — `prominence.js`

Feed-proxy render (240px) + 281px thumbnail; template match for the logo mark, OCR for the wordmark; size bands, clear space, contrast,
zone; co-brand weight ratio. Violation → REGENERATE with the identity block enlarged one step (never by shrinking the headline first).
Brand-frame constants: logo lockup band 30–40% of width for Advantage.Bid-led families (derived per format); relationship line with the
logo mark at 2.2–3.0% cap height for co-brand. The 3O `brand_frame.logo_width_px: const 250` becomes a per-family range in the 3P.1
schema revision (additive; the 3M.3 CENTERED_WHITE fixtures keep 250 and remain pixel-identical).

## 12. Event-type prominence (Mission 8)

`EVENT_TYPE` becomes a text role in the brief (`event.event_type`, from the production record; `event_type_missing` flag when absent)
and in the drawn-text list. Size floors, the title-unit patterns, modifier demotion and the no-orphan rule are enforced at layout time;
the comprehension test runs in judge v2 at the feed proxy. `event.title` is decomposed into `event_title` (place/name) and modifiers by
the copy engine using the event-type vocabulary; nothing is inferred from imagery.

## 13. Capitalization (Mission 9) — `titleCase.js`

Port `reference/title_case.py` with the config; run on every drawn string at brief assembly by role; post-render hygiene check on OCR'd
headlines (all-caps or all-lowercase headline → violation). Kicker and footer wordmark excluded (locked constants).

## 14. Scorer v2 and judge v2

- Hard fails added: physical audit violations (through, deep-overlap, protected-occluded, unsupported, scale); coverage floor / void cap
  (config); prominence violations; event-type violations; capitalization hygiene; negative-signature proximity; screenshot-as-hero in an
  acquisition creative (family rule from the IS-B attribute).
- Measurable block re-weighted: merchandise coverage (field-based) 12, void 6, hierarchy incl. event type 10, identity prominence 8,
  physical audit clean 8, copy 6, depth/planes 6, light ground 2, brand frame 2 (= 60).
- Judge v2 (prompt `p3p1-judge-v2`): items 1–10 from 3P kept, item 2 replaced by the three physical questions, plus the three
  comprehension questions and "can you name the platform at a glance". Two runs; disagreement flag unchanged.
- Regression: the six 2026-09-09 renders re-scored with v2 must produce: WU-A ≥ 70 with event-type and prominence violations listed
  (→ REGENERATE); WU-B hard fail (void, hierarchy); WU-C as WU-A; IS-A hard fail (physics); IS-B hard fail (screenshot-as-hero, negative
  signature); IS-C hard fail (coverage). B1/B2/B3 fixtures: pass with no physical violations (the demo layouts were hand-placed by the
  rules) — if they fail, fix the port, not the fixtures.

## 15. Provenance additions

Per job: `media_decision` (full trail), `video_frame_selection` when used, scene plan JSON, physical audit output, coverage measures,
prominence measures (canvas + feed proxy), event-type measures, capitalization changes applied (before → after per string), judge v2
outputs, negative signatures compared, feedback records consulted (ids). Reference images and rejected renders are never stored with the
job — only hashes.

## 16. Tests (minimum, in addition to Phase 3P's)

1. Feedback: the seven records validate; a record with `gold_standard: true` is rejected by schema; IS-B's message is retrievable as approved while its signature is negative; WU-C is `eligible_after_revision`, never admitted.
2. Media Director: composed-graphic cover → anchor role; an asset without event binding → excluded; tier walk selects tier 3 for the West University set with IMG_0522 first and IMG_0546/0552 gated out; override without reason → rejected.
3. Video: first frame never chosen by position across three synthetic videos; hand > 5% → rejected; signage text → rejected; disallowed correction → refused.
4. Taxonomy: loader strips annotations; every `can_support` reference resolves; unresolved anchor → review flag.
5. Physical audit: `scene_is_a_as_rendered.json` → 12 violations including `through` and `protected-occluded`; `scene_is_planned.json` → none; a painting with a floor baseline → `wall-too-low`; a vase taller than the sofa without dims → `scale`; the same vase with catalogue dims → pass.
6. Planner: violation kinds route to the mapped step; B1/B2/B3 plans reproduce the expected audits exactly.
7. Coverage: IS-C fails the ACQUISITION floor; WU-B fails the panel void cap; B3 passes CENTERED_WHITE; the fit procedure never enlarges a small object beyond its scale tolerance (unit test on step 5).
8. Prominence: 250px lockup at 1080 fails Advantage.Bid-led; 360px passes; co-brand line without the logo mark fails; weight ratio 0.95 fails (competes); 0.7 passes.
9. Event type: WU-A's subtitle pattern fails; TYPE_LED with "Estate Sale" at 5% canvas height passes; an orphaned "Sale" fails; a brief without `event_type` sets the flag and the creative carries no invented type.
10. Capitalization: the twelve config tests; an all-caps OCR'd headline fails hygiene.
11. Scorer v2 regression on the six renders and the three fixtures as in §14.
12. Publish isolation unchanged: every proving-ground run asserts A9 OFF and creates no destination job.

## 17. Revised proving grounds (Mission 10)

A — West University R1/R2/R3 with the media trail, TYPE_LED / TWO_LINE_UNIT title units, identity at spec, extreme on identity and event
type only. B — Individual Seller P1/P2/P3 with "You Can Do This.", scene plan, physical audit, coverage fit, logo at 30–40%. C —
conditional authentic-media test on a real production event with a cover or video; deferred honestly if none exists. Packets show new
candidates beside the previous ones; Owner review through the Mission 1 record model.

## 18. Dependency classes

| Item | Class |
|---|---|
| Feedback actions + tables; Media Director (tiers 1, 3, 4, 5, 6); taxonomy + physical audit + planner + coverage; prominence, event-type and capitalization checks; scorer/judge v2; tests | BUILD BLOCKER for 3P.1 certification |
| Video-frame pipeline (tier 2) | BUILD BLOCKER for the module; proving ground C depends on a real video existing |
| OCR engine and logo template assets in the runtime image (needed by is_photograph, text contamination, prominence recognition, capitalization hygiene) | BUILD BLOCKER — Phase 3P recorded their absence; 3P.1 requires them |
| Object detector for merchandise/obstruction classes | BUILD BLOCKER for tiers 2–3 clutter/obstruction; the vision judge may stand in with the named item list until a detector ships (recorded as such) |
| Seller logo assets in production; seller-uploaded covers/videos | OWNER-PROVIDER ACTIVATION DEPENDENCY |
| Any publishing | Not part of this phase; Owner-controlled and OFF |

## 19. Certification questions (answer YES/NO)

Real merchandise / real event media only, never invented or generated? · No frame or photograph enhanced beyond the correction
whitelist? · Nothing published, no external account, no spend? · Reference images and rejected renders never reached a generator? ·
Owner never required to edit a file? · No Gold Standard set from a review record? · "You Can Do This." carried as approved copy while
IS-B's layout is negative evidence? · Every one of the six 2026-09-09 renders now fails or regenerates for the reason the Owner gave? ·
3M.3 fixtures still reproduce exactly?
