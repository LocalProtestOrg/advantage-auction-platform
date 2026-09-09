# Deliverable 13 — Production Implementation Report (VS Code)

**Phase 3P · 2026-09-09 · Implemented additively on the Phase 3O spine and the ported 3M.3 runtime. Nothing published, sent, spent or activated.**

## What was built

| Layer | Production module | Notes |
|---|---|---|
| Library identity + schema + lint | `src/services/creativeReference/library.js` | sha256 identity, JPEG/PNG/WebP dimension parsing, focused draft-2020-12 validator for `reference.schema.json`, coordinate/colour/typeface/seller-mark lint |
| Indexer | `src/services/creativeReference/indexer.js` | reconciles folders ↔ sidecars by hash (add → stub + task; rename/move → path + folder-driven status; delete → RETIRED; `gold-standard/` / `do-not-use/` sub-folders), applies `owner-decisions.jsonl` once per line, recomputes weights, writes `index.json` + `OWNER-CREATIVE-REFERENCE-INDEX.md`, upserts `marketing_creative_references`. Runs at server boot and on `POST /api/admin/marketing-runtime/creative-references/reindex` — adding approved images needs no software change |
| Retriever | `retriever.js` | Deliverable 6 §2: weight × relevance × weighted-Jaccard facets, top-5, `avoid_for` exclusion, Gold always included, DO_NOT_USE as negatives, empty class → LOW + review + neutral lessons at 0.25, seller-concentration strip |
| Principles | `principles.js` | `brief.calibration` (ranges + qualities + do-not-copy); string-scanned for hex/px/typeface/seller strings — a leak throws |
| Families | `creative-engine/adb_engine/families/{brand,environmental_photo,acquisition}.py` via `creative-engine/calibrate.py` | Pillow renderers (no browser): ENVIRONMENTAL_PHOTO banded/panel (+ calibration extreme), ACQUISITION A/B/C; every drawn string is returned for the seller-mark gate; brand frame constants derived per format |
| Signatures | `creative-engine/adb_engine/signature.py` + `engineBridge.distance` | perceptual 12×12 luminance/saturation/edge signature, cosine distance; reference images are read only here and by the indexer |
| Gates | `gates.js` | G11 anti-similarity (τ_ref/τ_self/τ_pub from config), G12 seller-mark leak (drawn strings; OCR/logo templates reported unavailable honestly), G13 provenance, G14 Owner-review hold, text-budget profiles |
| Scorer + judge | `scorer.js`, `judge.js` | 60 measurable points (bands from the library profile ∩ brand frame ∩ C6 hypothesis) + 40 judged points (vision model, two runs, disagreement flag; never a reference image; unavailable = reported, never fabricated) + hard checks; ACCEPT ≥ 70 (75 with a Gold), REGENERATE 50–69, FALLBACK < 50, extremes NOT_FOR_PUBLICATION |
| Family selection + brief checks | `familySelector.js`, `briefValidator.js` | Deliverable 6 §6 rules incl. CATALOG_SCATTER rationing and ENVIRONMENTAL_PHOTO eligibility; merchandise-mode cross-checks, mixed auction ids, representative-only-in-acquisition, LOGISTICS reason, dark_hero, library hash as asset |
| Feedback ledger | `feedbackLedger.js` | Owner words → SET_STATUS / CALIBRATION_NOTE / AMBIGUOUS; Owner sources only; review rows; approved generated creative → library with Advantage.Bid provenance + reindex. Admin API: `GET/POST /api/admin/marketing-runtime/creative-reviews` |
| Proving grounds | `provingGround.js`, `packet.js`, `scripts/run-proving-grounds.js` | classify → retrieve → principles → brief → render → audit → gates → judge → score → persist → Owner review packet; never creates a publish/destination job |
| Schema pack | `docs/marketing/phase3o/schemas/*` | additive: families ENVIRONMENTAL_PHOTO / CATALOG_SCATTER / ACQUISITION; brief calibration/merchandise_mode/site_photographs/representative_assets/sessions/profile/cta; result calibration fields + decisions |
| Database | migration 147 | `marketing_creative_references`, `_reference_decisions`, `_calibrations`, `_layout_signatures`, `_owner_reviews`; calibration constants in `platform_config` |

## Certification questions (Deliverable 12 §14)

Real merchandise only, never invented — **YES** (event-bound site photographs with provenance; Advantage.Bid-owned representative assets visibly disclosed). Nothing published — **YES**. No external account connected — **YES**. No money spent — **YES**. Reference images never reached a generator or a publish job — **YES** (renderers have no path to the library; the judge receives only the candidate). Owner never required to edit a metadata file — **YES**. Performance never changed an Owner weight — **YES** (schema enum + ledger source check). 3M.3 fixtures still reproduce exactly — **YES** (full regression green; the 3M.3 runtime is untouched).

## Known limitations recorded honestly

- No OCR engine or seller logo templates exist in the runtime image: G12 checks every string the renderer draws exactly; photograph content (e.g. signage inside a room photo) is not OCR'd.
- The vision judge scores portrait and square renders independently; two runs are averaged and a disagreement > 8 is flagged.
- The Facebook cover stored on the West University event is the seller's own composed advertisement; it is used only as the published negative anchor, never as a photograph.
