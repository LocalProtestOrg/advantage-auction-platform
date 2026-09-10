# Mission 4 — Physical Merchandise Intelligence

**Phase 3P.1 · 2026-09-10 · Config: `config/object-taxonomy.json` (54 classes), `config/relationship-rules.json` · Reference implementation: `reference/physical_audit.py` with tests.**

## The gap

The 3M.3 rule engine understands geometry: roles, planes, gravity (heavy objects need a baseline in the floor band), walls (wall objects
hang and never sit in front), surface/support bands, perspective ordering, protected regions, meaningful versus decorative overlap. It does
not know what a side table *is*. So Individual Seller A passed its audit with `violations: []` while a tilt-top table cut through a
wingback chair's seat and arm, a torchiere stood shorter than the chair, and a silver bowl was nearly the height of the table. The Owner
saw it immediately. The engine needs to know real-world objects — what they are, how big they are, what they rest on, what may overlap
what — and check a plan against that before rendering.

## Core principle (unchanged, extended)

HEAVY OBJECTS OBEY GRAVITY. WALL OBJECTS OBEY WALLS. FOREGROUND OBJECTS MAY OVERLAP BOTH. **OBJECTS ALSO OBEY BELIEVABLE RELATIVE
SCALE AND PHYSICAL RELATIONSHIPS.**

## Semantic object model

Every object in a brief carries a semantic record, resolved at catalogue time (category key + title/description keywords + optional image
classifier, with a confidence), and every class in the taxonomy carries:

| Attribute | Meaning | Example (side_table) |
|---|---|---|
| `semantic_class`, `family` | what it is | side_table, furniture |
| `size_class`, `typical_height_in`, `typical_width_in` | real-world default size; catalogue dimensions always win | M, 26 × 22 in |
| `plane` | floor / wall / table / shelf / pedestal / ground / ceiling | floor |
| `orientation` | upright / hung / flat / flat_group | upright |
| `spatial_role_candidates` | 3M.3 roles it may take | SURFACE_PROVIDER |
| `anchor_weight` | 0 accent … 3 primary anchor | 1 |
| `foreground_suitability` | 0 never … 3 ideal | 1 |
| `can_support` / `can_be_supported_by` | ON relations | supports lamp, vase, bowl, clock, figurine |
| `allowable_overlap` | what it may overlap as the nearer object; what may overlap it | as front: seating's lower outer edge when beside; as back: objects on top, foreground accents |
| `prohibited_relations` | THROUGH, FLOATING, ON:x, scale conditions, family exclusions | THROUGH chair/sofa; top wider than the seat without dimensions |
| `grouping` | single / pair / grouped tabletop / category composition | single |
| `protected_features` | never crossed or cropped | (chairs: seat, arms, wings; watches: dial) |
| `dominant_ground_object` | sets scene scale; only foreground accents may overlap its lower edge | tractor, vehicle |

The Owner's examples, as recorded in the taxonomy: sofa = major floor anchor (3); wingback chair = medium/large floor anchor (2) with
protected seat/arms/wings; side table = smaller companion to seating (BESIDE, never larger than the seat); dining table = major horizontal
anchor with chairs pushed in over its apron; table lamp = supported by table/console, never on the floor; floor lamp = floor-supported
vertical, taller than any chair; vase = tabletop/shelf/pedestal/foreground (a floor vase is its own class); painting = wall plane, hangs
above furniture, never in front of a floor object, no contact shadow; rug = ground plane under furniture, never over it, never vertical
unless a hung textile; cabinet = large rear vertical anchor, always grounded, always behind; jewellery = close-up category composition
only, never at room scale beside furniture; tool chest = heavy ground anchor; tractor = dominant ground object; sculpture = scale-dependent
(under 20 in → table/pedestal; over 36 in → floor); china = grouped tabletop/shelf treatment, never scattered on the floor.

## Relationship graph

Objects are nodes; edges are typed: **ON** (rests on a supporter's top band), **BESIDE** (same plane, adjacent, silhouettes touch at an
outer edge at most), **UNDER** (rug beneath), **HANGS_ABOVE** (wall object over a floor object, always behind), **IN_FRONT_OF** (closer
by at least one depth step; overlap only over the back object's lower-edge band), **FOREGROUND_ACCENT** (small object over the lower
edge of anything larger).

Valid: vase ON table · table BESIDE chair · rug UNDER furniture · small foreground object over the lower edge of a larger object ·
coffee table IN_FRONT_OF sofa · china ON dining table · painting HANGS_ABOVE console.

Invalid: chair THROUGH table · table THROUGH chair · painting floating on the floor · large cabinet floating · vase larger than sofa
without factual scale evidence · table lamp on the floor · wall object in front of a floor object · jewellery at room scale.

## Relative-scale model

`scene_scale (px/in) = primary anchor's rendered height ÷ its real height` (catalogue dimensions if present, else the class default).
Every other object's expected rendered height = its real height × scene_scale × depth factor (0.85 far … 1.25 near). Tolerance ±20% on
the same plane, ±35% for foreground accents. Catalogue dimensions are authoritative when they exist — a genuinely 40-inch vase may stand
beside a sofa; a vase with no dimensions may not be rendered taller than a chair. Category families (lineup, tile, hero) use category
scale and are exempt from room-scale checks.

## Collision versus intentional overlap

Overlap is not the enemy; impossible intersection is. For every pair of floor-plane objects whose masks intersect by more than 400 px:

- same depth (baselines within one depth step ≈ 6% of canvas height) **and** the intersection touches the back object's interior band
  (20–80% of its height) → **THROUGH** — hard fail;
- the front object is closer by a depth step **and** the intersection lies within the bottom 35% of the back object → layering — allowed;
- the front object is closer but crosses above that band → allowed only if it is a foreground accent (suitability ≥ 2); otherwise
  **deep-overlap** — hard fail;
- any intersection covering more than 15% of a protected feature (seat, arm, wing, dial, face, signature) → hard fail regardless of depth;
- table/shelf/pedestal-plane objects without an ON edge → **unsupported** — hard fail, unless declared a floor-vignette accent (small
  foreground decor only) or a floor-standing instance with dimensions ≥ 24 in;
- wall and ground rules from 3M.3 unchanged (wall never in front, no contact shadow, rug always behind).

## Proof against the Owner's example

`reference/physical_audit.py` was run on a reconstruction of Individual Seller A's layout using the same demo assets
(`tests/scene_is_a_as_rendered.json`). It reports: **side_table passes THROUGH wingback_chair** (same depth, interior crossing 6–78%),
side_table covers seat and arm, torchiere passes through the table, torchiere rendered 0.75× its expected height, side table 1.61×,
bowl 1.80×, vases 1.43×, bowl and vases unsupported — twelve violations for a creative the 3M.3 audit passed with none.

The same audit on a physically planned arrangement of the same five assets (`tests/scene_is_planned.json`: torchiere behind and taller,
table beside the chair at 26 in, vases on the table, bowl declared as a floor-vignette accent) reports **no violations**.
`tests/comparison.jpg` shows both side by side — audit evidence, not a creative; the planned cluster still needs Mission 6 to fill the
canvas.

## What the audit does not do

It does not shrink overlap globally, and it does not forbid overlap. It forbids the specific relationships a person recognises as
impossible, and it reports scale drift so the planner (Mission 5) can correct it before rendering.
