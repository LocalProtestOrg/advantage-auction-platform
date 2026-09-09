# Deliverable 5 — Existing 3M.x Creative System Comparison

**Phase 3P · 2026-09-09 · Compared against:** Phase 3M (extraction lab + five demo ads), 3M.1 (white-canvas push), 3M.2 (centered
refinement + brand frame), 3M.3 (spatial composition: roles, planes, gravity, protected regions, text budget, category balance), the
supplemental "stage the merchandise" calibration, and the production creative-runtime specification as shipped in
`creative-runtime-handoff/` (`spatial.py`, `compose.py`, `comp_refine.py`, `comp_b.py`) and the Phase 3O contract
(`creative_brief.schema.json`, `creative_result.schema.json`, `enums.schema.json`).

Principle followed: **preserve good architecture, extend rather than replace.** Nothing below rewrites a locked decision; where the
library contradicts a rule, the recommendation is to scope the rule, not delete it.

## 1. Rules strongly validated by the Owner's references

| Existing rule | Evidence in the library | Status |
|---|---|---|
| White / very-light ground is the locked default; dark navy is a specialised treatment (3M.1) | 8/13 light; the only dark ground (REF-12) is a single lit hero object | **Validated, and the dark trigger is now specific** |
| Stage the merchandise, let the merchandise tell the story; editorial set-designer thinking (supplemental) | REF-02, REF-04, REF-05, REF-06 are exactly this | **Validated** |
| Spatial roles, believable visual world, gravity rule, depth planes, meaningful vs decorative overlap (3M.3) | REF-02 (three planes, wall art, grounded furniture, foreground objects); REF-06 (painting above table, urn in front); REF-04 | **Validated for scene families** |
| Merchandise rising beside the title into the upper half (3M.2 Version B) | REF-02 objects reach the presenter line; REF-04 painting and vase reach the top; REF-05/06 cabinet and painting at the top | **Validated** |
| Standard brand frame: navy footer band with the wordmark (3M.2 addendum) | 7/13 close with a URL band | **Validated as a device**; colour stays navy (seller bands vary — seller-specific) |
| Default copy set: presenter / title / city-state / date / time / footer (3M) | REF-02 (3 blocks), REF-13 (3), REF-04 (4) | **Validated**; the budget is a ceiling |
| Typography confidently uses space; minimal copy ≠ tiny type | Every reference has a large title; REF-05/06 use a huge numeral | **Validated** |
| Event-specific typography when truthful (GOLD in gold) | REF-13 is the cited example; REF-07/08, REF-10 extend it | **Validated** |
| Prefer the more colourful real object; colour from merchandise, not panels | REF-04 (vase, amethyst), REF-05 (red chairs), REF-01 (specimens) | **Validated** |
| Protected regions never cropped or occluded | REF-03 and REF-13 show every dial; edge crops in REF-02/04/06/08 never cut identifying detail | **Validated** |
| Intelligent edge cropping | REF-02 dining table, REF-04/06 cabinet, REF-08 vehicles | **Validated** |
| Merchandise breadth — tools/vehicles/outdoor are legitimate (supplemental) | REF-08 (bulldozer, boat, golf cart), REF-07, REF-11 (tools) | **Validated** |
| Standardize the frame, customize the event experience | REF-05/06 same frame, different composition | **Validated as a revealed preference** |
| Category-balance check flags a luxury-only read on a broad ad (`spatial.category_balance`) | The Owner's broad references mix furniture, art, bronzes, minerals, chairs | **Validated** |

## 2. Rules that need refinement (scope, not removal)

| Rule | Problem the library exposes | Refinement |
|---|---|---|
| "Clusters with depth rather than object lineups" | REF-13 is an approved lineup (watches) | Scope to scene families. Add LINEUP as a legitimate treatment inside CATEGORY_GROUP for homogeneous lot groups. |
| `TEXT_BUDGET` = 5 blocks flat | REF-03 and REF-07 carry 8 blocks and are approved because logistics are the sell | Keep 5 for CENTERED_WHITE / LEFT_THIRD_WHITE / SINGLE_LOT / ENVIRONMENTAL_PHOTO; add an opt-in LOGISTICS budget (≤7 blocks, icon-led, single column) for CATEGORY_GROUP and in-person events with previews/address. The brief must state the factual reason. |
| Gravity / wall / surface checks are universal in `spatial.audit` | REF-07/08 float objects; the Owner approves them as a catalogue spread | Keep the audit locked for scene families. Add a `CATALOG_SCATTER` family with its own audit profile: no gravity/wall/surface checks, uniform light shadow class, protected-region and thumbnail checks still mandatory, `decorative_overlaps` not penalised, rationed (see Deliverable 8). |
| "No Bid Now / Don't Miss Out lines without a factual reason" | Four references carry one quiet factual CTA | Allow exactly one factual CTA block (online-only → "Bid online at advantage.bid"; a real preview → "Preview available"), counted in the budget. Hype copy stays banned. |
| Centered family: title at the top | REF-02 puts the title at the bottom | Add `title_position: top | bottom` to CENTERED_WHITE as an approved variation, not a default; bottom allowed only when merchandise occupies the upper canvas (upper-half merchandise ≥ 35%). |
| "No piles of category labels" | REF-05/06/09 use one short category line | The "one short supporting line" slot may be a category line ≤ 6 words. |
| B3 calibration: merchandise 41.6%, text region 22.3% | Owner references in the same families estimate at 55–72% merchandise, 8–18% text | Treat as a calibration hypothesis: widen the scene-family merchandise band to ~50–65% and cap text region near 18%; verify on the West University proving ground before locking. |
| Object count "roughly 10–15 items when breadth allows" | REF-04 (5) and REF-06 (5) approved; REF-08 (12) approved | Object count is an outcome of scale and breadth, not a target. Express as a range 5–14 with the breadth check deciding the floor. |

## 3. Owner preferences missing from the current architecture

| Missing | Evidence | Proposed addition |
|---|---|---|
| An environmental-photograph family for on-site estate sales | REF-09, REF-10 — both estate-sale references show the actual house | New family `ENVIRONMENTAL_PHOTO`: legitimate site photograph(s) from the event record as the merchandise field; presenter/title panel or band; date pair; place plate. Never stock rooms. |
| Icon-led logistics rows (calendar / pin / hours) | REF-03, REF-07, REF-10 | Optional `logistics_block` element for on-site and in-person events, counted as one "essential event info" block when it is a single stacked group. |
| Multi-day date pair treatment | REF-09 (two columns), REF-10 (two rows) | `event.sessions[]` in the brief with a date-pair typographic component. |
| Place-name-led titles | REF-09 KATY, REF-10 PINE HAVEN | Title composition rule for on-site sales: place name may be the largest word. |
| Teaser wave with no logistics | REF-08 | LAUNCH-wave option `teaser: true` (presenter + title + footer only). Ties to the existing Wave enum. |
| Factual catalogue claims as hero type ("725+ lots") | REF-05/06 | Allowed when computed from the live catalogue at generation and re-verified at publish (A2 claim manifest entry). |
| Truthful material typography beyond gold | REF-13 | Already allowed in `event.typography_treatment`; add a validation that the material claim is supported by lot data. |
| Formal + script/italic title contrast | REF-10; 3M.3 italic Home | Already a principle; record script as an acceptable expression, never a default. |
| Reference calibration as a QA signal | none existed | Deliverables 6–7: retrieval + calibration score integrated into `creative_result`. |

## 4. Rules that are too rigid as written

- **Family enum without a photograph family.** `CreativeFamily` assumes extracted objects for everything except COBRANDED/CLOSING_DAYS.
  On-site sales need photographs.
- **`brand_frame.ground` = white | very_light only.** Fine for the scene families; the SINGLE_LOT dark trigger (REF-12) and the
  ENVIRONMENTAL_PHOTO family need `dark_hero` and `photograph` as family-scoped values.
- **Uniform `spatial.audit` for every family.** The audit should be selected by family profile (Deliverable 12 §5).
- **`objects.minItems: 1` with `fidelity: CLEAN` for every brief.** Acquisition and brand creative use representative imagery, not lots;
  the brief needs a `merchandise_mode: lots | representative | photograph | none` switch with its own gate (Deliverable 8).

## 5. Rules that may have been overfit to Heritage & Home

- **Specific counts and pixels** (14 objects, 11 categories, logo 250px, title y=160, floor band 0.70) are the calibrated demo, not Owner
  law. The library shows the Owner accepting 5 objects (REF-04/06) and 12 (REF-08), titles at the bottom (REF-02), and landscape 3:2
  where the floor band and footer proportions differ. Keep the constants for CENTERED_WHITE at 1080×1350; derive per-format constants
  rather than copying them.
- **The italic "Home" and red ampersand** were solutions to one title. The library generalises the *principle* (type may express contrast
  or material) and nothing else — the Owner said as much in 3M.3.
- **Red wingback chairs as hero anchors.** A Heritage & Home fact. The library's colour anchors are different objects every time (vase,
  amethyst, red cantilever chairs, pink geode). The rule is "one or two colour anchors chosen from the real catalogue", not "red chairs".
- **The left-panel proportion 1/3.** The Owner's left-panel references sit at 33–40%. Express as a range.

## 6. What stays exactly as is

The extraction spec and CLEAN/REVIEW/FAILED gate; `spatial.audit` for scene families; the navy band and wordmark; the real logo; red as
accent only; Quicksand for brand character; no invented merchandise; protected regions; the A2 claim manifest; publish gates OFF; the
Phase 3O obligation and evidence model. Phase 3P adds a reference layer around these; it does not reach inside them.
