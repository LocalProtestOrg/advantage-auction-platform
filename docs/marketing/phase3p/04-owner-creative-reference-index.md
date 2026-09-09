# Deliverable 4 — Owner Creative Reference Index

**Phase 3P · 2026-09-09**

The authoritative index lives in the library itself, where the images are:

| File | Purpose |
|---|---|
| `approved-creative-examples/OWNER-CREATIVE-REFERENCE-INDEX.md` | The human master index: library at a glance, both taxonomies, the reference register, one retrieval card per image, calibration bands, weighting |
| `approved-creative-examples/index.json` | The machine index the production retriever reads: counts, weighting, taxonomy with populated/empty flags, `class_map`, `visual_family_map`, `advantage_family_map`, `principle_profiles_by_advantage_family`, `global_transferable_profile`, one summary row per reference |

This document explains the design of that index so VS Code can own the builder.

## Retrieval taxonomy

Two independent axes, so that "what is being advertised" never gets confused with "how it is built":

**Axis 1 — campaign class** (what the campaign is for). The nine classes the mission required, all present in the taxonomy whether or not
populated:

| Class | Populated by | Notes |
|---|---|---|
| `estate_sale` | REF-09, REF-10 (primary); REF-02, 04, 05, 06 (secondary) | On-site sales primary; estate *auctions* secondary |
| `auction` | REF-01…08 (primary); REF-12, 13 (secondary) | Broad, category, themed |
| `professional_seller_acquisition` | — | **empty** |
| `individual_seller_acquisition` | — | **empty** |
| `buyer_platform_growth` | — | **empty** |
| `notable_lot` | REF-12, REF-13 (primary); REF-01, REF-03 (secondary) | REF-13 filed here by the Owner; it is also a category lineup |
| `closing_soon` | — | **empty** |
| `geographic_event_promotion` | REF-11 (primary); REF-07, 09, 10 (secondary) | Regional identity, neighbourhood naming |
| `general_brand` | — (secondary only: REF-08, REF-11) | No primary example |

Empty classes are kept in the taxonomy and flagged `populated: false`. Nothing was forced into them.

**Axis 2 — visual family** (how the creative is built): SCENE_EXTRACTED, LEFT_PANEL_EXTRACTED, PHOTO_STILL_LIFE, ENVIRONMENTAL_ROOM,
TILE_GRID, LINEUP, CATALOG_SCATTER, HERO_SINGLE_DARK, ATMOSPHERIC_SCENE — each mapped to the nearest existing Phase 3O `CreativeFamily`
(CENTERED_WHITE, LEFT_THIRD_WHITE, CATEGORY_GROUP, SINGLE_LOT, CLOSING_DAYS, COBRANDED) or to one of the two families Phase 3P proposes
(ENVIRONMENTAL_PHOTO, CATALOG_SCATTER).

**Facets** used for ranking inside a class: `format_class`, `information_density`, `ground`, `event_mode`, `merchandise_breadth`,
`seller_hierarchy`, `nearest_advantage_family`, `tags`, `avoid_for`.

## Worked retrieval — "Create a Professional Seller estate-sale advertisement"

1. Classify: campaign class `estate_sale`; seller hierarchy `seller_led_cobranded`; event mode from the event record (`on_site` for the
   West University sale); format(s) requested.
2. Primary hits: REF-09, REF-10 (estate_sale primary, on_site, ENVIRONMENTAL_ROOM). Effective weight 1.0 × 1.0 × facet similarity.
3. Secondary hits: REF-04, REF-05, REF-06, REF-02 (estate_sale secondary, extracted-object families) at 0.5 × facet similarity — used
   only if the event has no legitimate site photography or the requested family is an extracted one.
4. Excluded: REF-11 (`avoid_for` any estate-sale creative), REF-12, REF-13, REF-07, REF-08 (`avoid_for` estate sale).
5. Result: an ordered list of at most five references with their `transferable_lessons`, the family's principle bands, and the
   `do_not_generalize` union — **no image, no coordinates**. Because 100% of hits are one seller, the seller-identity stripping rule fires.

## Worked retrieval — "Individual Seller acquisition"

1. Classify: `individual_seller_acquisition`. Class is empty.
2. Fallback: `global_transferable_profile` (hierarchy, merchandise-forward, light ground, restrained copy, band close) plus the
   class-neutral lessons tagged for warmth and breadth (REF-11 tools/work culture; REF-08 breadth), each at relevance 0.25.
3. Flag: `class_references: 0 → owner_review_required: true`, calibration confidence LOW. See Deliverable 11.

## Keeping the index honest

- The index is a build artifact. It is regenerated from the sidecars by the indexer, never edited by hand.
- `owner_folder` is what the Owner did; `campaign_class_primary` is what the analyst read. Both are kept; retrieval uses the class but the
  Owner can always find his file by his own folder.
- Identity is the content hash. A file moved into `gold-standard/` keeps its record; the indexer updates `current_path` and
  `owner_status`, appends to `status_history`, and recomputes `owner_weight`.
- The library is small on purpose. The index must never be "improved" by importing historical creative; only Owner decisions add entries.
