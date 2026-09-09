# Deliverable 6 — Reference Retrieval Model (production retrieval contract)

**Phase 3P · 2026-09-09**

## The flow

```
Campaign Need
  → Campaign Classification              (class, seller hierarchy, event mode, wave, formats, merchandise mode)
  → Retrieve Relevant Owner References   (index.json; ≤5; weighted; seller-identity stripped)
  → Extract Transferable Principles      (principle profile + do-not-copy list → brief.calibration)
  → Event / Seller Facts                 (production event record; cobrand logo asset from production)
  → Real Merchandise Images              (CLEAN objects of THIS auction, or legitimate site photographs, or flagged representative imagery)
  → Creative Brief                       (existing creative_brief + calibration block)
  → Creative Generation                  (family engine: compositor / photo-layout / scatter)
  → Existing 3M.3 Spatial Rules          (family-selected audit profile; unchanged for scene families)
  → Creative QA                          (existing gates + G10 calibration, G11 anti-similarity, G12 seller-mark leak)
  → Reference Calibration Score          (0–100 with per-principle evidence)
  → Accept / Regenerate / Fallback
  → Publish only when separately authorized (A9 and destination gates untouched; Owner review flags respected)
```

Reference images are read by the retriever and the scorer. **They are never an input to generation.** The generator receives principles,
bands and a do-not-copy list; it never receives a reference image, a layout signature, a colour value, a typeface name or wording from a
reference.

## Step 1 — Campaign classification

Input: the obligation / campaign need (feature key, package, wave), the auction or event record, the seller record.

| Output field | Values | Source |
|---|---|---|
| `campaign_class` | one of the nine classes | feature key + campaign intent (`notable_lot_spotlight` → notable_lot; `creative_closing_days` → closing_soon; `creative_collage_general` → auction or estate_sale by event type; acquisition/brand campaigns by campaign type) |
| `seller_hierarchy` | seller_led_cobranded / advantage_bid_led / advantage_bid_only | seller type (Professional Seller → cobranded, seller leads; Individual Seller → Advantage.Bid led) |
| `event_mode` | online_only / in_house_or_online / on_site / not_an_event | event record |
| `wave` | LAUNCH / MID / FINAL / ANY | obligation |
| `merchandise_mode` | lots / photograph / representative / none | lots when CLEAN objects exist for this auction; photograph when the event record holds legitimate site photographs; representative only for acquisition/brand campaigns; none for text-only formats |
| `formats` | existing CreativeFormat enum | obligation |
| `requested_family` | optional | Director may request; otherwise family selection (Step 6) decides |

## Step 2 — Retrieval

```
candidates = index.references
  .filter(owner_status ∈ {OWNER_APPROVED, OWNER_GOLD_STANDARD})
  .filter(campaign_class ∉ avoid_for)
score(ref) = owner_weight
           × relevance(ref, campaign_class)         primary 1.0 · secondary 0.5 · family-compatible-only 0.25 · else 0
           × facet_similarity(ref, need)           weighted Jaccard over event_mode, merchandise_breadth, format_class,
                                                    nearest_advantage_family (if requested), seller_hierarchy, tags   (0..1)
take top 5 with score > 0; always include at least one OWNER_GOLD_STANDARD of the class if one exists
negatives = index.references.filter(owner_status == OWNER_DO_NOT_USE and class matches)   → anti-pattern list only
```

Empty class (score list empty): return `[]`, set `calibration_confidence = LOW`, `owner_review_required = true`, and load the
`global_transferable_profile` plus any references tagged for the need's neutral facets (e.g. `breadth`, `warm-light`) at 0.25.

Seller concentration: if one `source.seller` supplies > 60% of the returned set (always true today), set `strip_seller_identity = true`.

## Step 3 — Principle extraction → `brief.calibration`

```json
"calibration": {
  "campaign_class": "estate_sale",
  "reference_ids": ["REF-09", "REF-10", "REF-04"],
  "reference_versions": { "REF-09": "<sha256 of sidecar file>", "…": "…" },
  "confidence": "HIGH | MEDIUM | LOW",
  "owner_review_required": false,
  "principle_profile": {
    "hierarchy": ["presenter leads", "one event title 2-5 words; place name may be largest for on-site sales", "date larger than time", "close with navy band"],
    "merchandise": { "mode": "photograph", "share_band_pct": [50, 65], "treatment": "environmental — the actual house; no extraction; no stock" },
    "copy": { "budget_blocks": 5, "supporting_line": "category line ≤ 6 words or none", "cta": "none or one factual", "logistics_block": "allowed: date pair + neighbourhood" },
    "typography": { "expressive_allowed": true, "rule": "one element may express contrast or material when truthful" },
    "ground": "white | very_light",
    "composition": { "families_allowed": ["ENVIRONMENTAL_PHOTO", "LEFT_THIRD_WHITE"], "title_position": ["top", "panel"] },
    "variation_required_from": ["<layout signatures of last 5 creatives for this seller/class>", "<published-graphic anchor if any>"]
  },
  "do_not_copy": {
    "seller_marks": ["Lewis & Maese", "LMAuctionCo", "fleur-de-lis crest"],
    "palettes": "any reference palette", "typefaces": "any reference typeface", "ornaments": "flourishes, decorative frames, stars",
    "wording": ["Trusted. Experienced. Results.", "Houston's Premier", "Quality. Heritage. Timeless Style.", "Bid • Discover • Own"],
    "layout_signatures": ["<signature per retrieved reference>"]
  }
}
```

The profile is built by union-ing `transferable_lessons` of the retrieved references, intersecting with the family's
`principle_profiles_by_advantage_family` bands, and applying the Advantage.Bid brand-frame constants (which always win over any reference).

## Step 4 — Facts and merchandise (unchanged sources, one new assertion)

Event facts come only from the production event record. The seller logo for a co-brand comes only from the production seller asset
(`cobrand.seller_logo_asset_id`), never cropped from a reference. Every object in the brief must satisfy `lot.auction_id == brief.auction_id`
(new hard assertion). Site photographs must be linked to the event record with a provenance row (uploader, date, rights) before they can be
used.

## Step 5 — Brief

The existing `creative_brief.schema.json` plus:

- `calibration` (above);
- `merchandise_mode`;
- `event.sessions[]` (multi-day date pairs), `event.place_name`, `event.neighbourhood`, `event.online_only` (bool, drives the factual CTA);
- `site_photographs[]` (asset id, provenance row id) when `merchandise_mode = photograph`;
- `representative_assets[]` (asset id, rights, "representative — not lots" flag) when `merchandise_mode = representative`;
- `text_budget.profile`: `GENERAL (5)` | `LOGISTICS (7, reason required)` | `TEASER (3)`;
- `family_options.title_position`, `family_options.teaser`.

## Step 6 — Family selection (before generation)

| Condition | Family |
|---|---|
| `merchandise_mode = photograph` and event on_site | ENVIRONMENTAL_PHOTO (variants: banded portrait like REF-09; left panel like REF-10) |
| ≥ 8 CLEAN objects across ≥ 4 category families, broad auction | CENTERED_WHITE (default) or LEFT_THIRD_WHITE |
| 3–7 CLEAN objects, broad | LEFT_THIRD_WHITE with large scale |
| homogeneous category group | CATEGORY_GROUP (LINEUP or TILE_GRID treatment) |
| one hero object; lit / translucent / reflective | SINGLE_LOT, dark ground permitted |
| one hero object otherwise | SINGLE_LOT, light ground |
| themed / eclectic auction, LAUNCH wave, breadth ≥ 6 families | CATALOG_SCATTER (rationed: at most 1 in 5 creatives per seller per quarter; never for fine estate or closing waves) |
| acquisition / brand | non-collage: single message + small representative cluster or product screenshot (Deliverable 11) |
| closing_soon | CLOSING_DAYS (existing) with the FINAL-wave date treatment; no class references yet → Owner review |

## Step 7 — Generation, spatial rules, QA, score, decision

Generation runs the family engine. The 3M.3 audit runs with the family's audit profile (scene families: full audit; CATEGORY_GROUP lineup:
baseline alignment + protected regions; CATALOG_SCATTER: protected regions + thumbnail only; ENVIRONMENTAL_PHOTO: text-over-photo legibility +
no text over merchandise except a place plate; acquisition: text budget + no lot claims). Then the calibration scorer (Deliverable 7) and the
new gates (Deliverable 12 §6).

Decision:

| Outcome | Rule |
|---|---|
| **ACCEPT** (→ CREATIVE_READY, or → OWNER_REVIEW when required) | audit violations = [] ∧ text budget ok ∧ thumbnail ok ∧ A2 ok ∧ no hard fail ∧ calibration ≥ 70 |
| **REGENERATE** (same family, new seed/selection; then a different allowed family) | calibration 50–69, or a soft failure; at most 3 attempts per family, 2 families |
| **FALLBACK** | attempts exhausted → the family's certified default (CENTERED_WHITE B-style for broad auctions; LEFT_THIRD_WHITE for few objects; SINGLE_LOT for one) generated with the same facts, then scored; if still < 50 → BLOCKED_CALIBRATION with the packet for Desktop Marketing |
| **HARD FAIL** (never accepted) | seller-mark leak, similarity above threshold to any reference or the published-graphic anchor, an object from another auction, invented merchandise, representative imagery in a lot-based campaign, text budget over profile |

Publishing remains a separate authorization (A9 + destination gates + Owner review flags). This model changes nothing about it.

## Anti-copy mechanics (summary; detail in Deliverable 8)

- Layout signature = normalised vector of (text-block boxes, merchandise mask coarse grid 12×12, panel side, band presence, title position).
  A candidate must sit at distance ≥ τ_ref from every retrieved reference signature and ≥ τ_self from the seller/class's last five
  creatives. Initial τ values are proposed in Deliverable 12 and tuned on the proving grounds.
- OCR of the final render must contain no string from `do_not_copy.seller_marks` or `wording` unless it is the brief's own cobrand seller.
- Logo/crest detector (template match against the reference seller marks) on the final render.
