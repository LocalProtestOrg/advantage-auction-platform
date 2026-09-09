# Deliverable 3 — Per-Image Metadata (sidecar records)

**Phase 3P · 2026-09-09**

## What was created

One sidecar record per approved image, generated automatically from the visual inspection in Deliverable 1. The Owner entered nothing and
never needs to open these files.

| Where | What |
|---|---|
| `approved-creative-examples/<category>/<image>.reference.json` | 13 records, one beside each image, named after the image file |
| `approved-creative-examples/reference.schema.json` | The JSON-Schema contract every record was validated against (all 13 pass) |
| `approved-creative-examples/index.json` | Machine index aggregating the records (Deliverable 4) |

## Why this format

JSON sidecars beside the image, keyed by the image's content hash, were chosen over a single spreadsheet or a database-only record because:

- The Owner's only interface is the folder. A record that lives beside its image survives moves and renames (identity is the hash, the path is
  informational) and disappears cleanly when the image is deleted (indexer marks it RETIRED).
- VS Code can validate every record in CI with the schema, and the indexer can reconcile folders against records mechanically.
- A record is small enough to review in a diff, and `git blame` becomes the audit trail for every change of Owner status.
- Nothing about it requires the Owner to know JSON exists.

## Record contents (minimum required by the mission, and what was added)

| Mission requirement | Field(s) |
|---|---|
| filename / reference | `reference_id`, `identity.{sha256,current_path,original_filename,width,height,format_class,aspect_ratio}` |
| Owner approval status | `owner_status` (OWNER_APPROVED / OWNER_GOLD_STANDARD / OWNER_DO_NOT_USE / RETIRED), `owner_weight`, `status_history[]` with date, source and the Owner's words |
| campaign family | `classification.campaign_class_primary`, `campaign_class_secondary[]`, `owner_folder` (recorded as the Owner placed it, never overridden) |
| seller hierarchy | `classification.seller_hierarchy`, `source.seller`, `source.advantage_bid_visible` |
| visual family | `classification.visual_family` (how it is built) and `nearest_advantage_family` (which Advantage.Bid family it informs) |
| strongest attributes | `strongest_attributes[]` |
| transferable lessons | `transferable_lessons[]` — the only layer that may reach a creative brief |
| seller-specific elements that must NOT be generalized | `do_not_generalize[]` |
| merchandise treatment | `visual_read.merchandise_treatment`, `classification.merchandise_breadth`, `visual_read.overlapping_objects`, `visual_read.environmental_staged_composition` |
| text-density assessment | `visual_read.information_density`, `measured.text_block_count`, `text_density_assessment.{level,why_it_works_here,advantage_bid_budget_note}` |
| composition assessment | `composition_assessment.{spatial_logic,gravity_and_grounding,depth,scale_strategy,edge_handling}`, `visual_read.{composition_style,negative_space,ground}` |
| future retrieval / use cases | `retrieval.{use_cases,tags,avoid_for}` |
| (added) the full Part-1 inventory reading | `visual_read.*` — hierarchy, typography, branding, CTA, footer, photographic style, impact |
| (added) measurements | `measured.*` — pixel-computed light/dark/saturation/hues; visual-estimate merchandise and text shares and object count, labelled as estimates |
| (added) rights | `source.rights` — third-party seller artwork, calibration evidence only |
| (added) performance | `performance` — reserved, null; never affects Owner status or weight |
| (added) provenance | `provenance.{created_by,created_at,analysis_method,phase}` |

## Example (abridged) — REF-02, `auction/700078662_…_n.jpg.reference.json`

```json
{
  "schema_version": "1.0",
  "reference_id": "REF-02",
  "identity": { "sha256": "…", "current_path": "auction/700078662_1669701284699985_700289891861455729_n.jpg", "width": 1254, "height": 1254, "format_class": "square", "aspect_ratio": 1.0 },
  "owner_status": "OWNER_APPROVED",
  "owner_weight": 1.0,
  "status_history": [ { "date": "2026-09-09", "status": "OWNER_APPROVED", "source": "folder_placement_by_owner", "recorded_by": "Desktop Marketing — Phase 3P" } ],
  "classification": { "campaign_class_primary": "auction", "campaign_class_secondary": ["estate_sale"], "owner_folder": "auction",
                      "visual_family": "SCENE_EXTRACTED", "nearest_advantage_family": "CENTERED_WHITE", "merchandise_breadth": "broad", … },
  "transferable_lessons": [ "Title-at-bottom is an approved variation of the centered family when merchandise occupies the upper canvas", … ],
  "do_not_generalize": [ "Fleur-de-lis crest, gold rules and ornaments, navy border frame — seller identity", … ],
  "retrieval": { "use_cases": ["broad general auction", "estate auction with fine art and antiques", "CENTERED_WHITE family calibration"], "avoid_for": ["single-lot spotlights", "acquisition campaigns"] }
}
```

## Rules the records obey

1. Every line was determined by looking at the image. Event dates and titles are quoted only as they appear in the image.
2. `owner_folder` is never changed by the system. If the analyst's classification differs from the folder (e.g. REF-13 is filed under
   `notable-lot` but built as a category lineup), both are recorded: the folder as the Owner's intent, the classification as a secondary facet.
3. Nothing in a record is a coordinate, a colour value, a typeface name or a wording that a generator could reproduce. `do_not_generalize`
   names what must be stripped; `transferable_lessons` are written as principles.
4. All 13 are OWNER_APPROVED. No Gold Standard was assigned, because nothing in the folder or the brief distinguishes one image from another.
   Promotion is the Owner's (Deliverable 7 and 9).
