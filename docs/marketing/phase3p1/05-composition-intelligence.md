# Mission 5 — Composition Intelligence (scene planning before rendering)

**Phase 3P.1 · 2026-09-10**

The engine currently places objects and then audits them. It should reason about the scene first, produce a plan, audit the plan, and
only then render. A plan is a small JSON scene graph; the renderer becomes the last step, not the place where composition happens.

## The planning pipeline

```
Identify Merchandise        CLEAN objects of THIS auction (or the representative set for acquisition/brand); catalogue dimensions; category families
  → Classify Objects        semantic_class + attributes from the taxonomy; confidence; unresolved → generic-by-size + review flag if it would anchor
  → Estimate Relative Scale primary anchor → scene_scale (px/in); expected height per object; flag objects whose catalogue dimensions contradict class defaults (they win, but are logged)
  → Select Anchors          1 primary (anchor_weight 3, else the largest 2) + 0–2 secondary; a tall structure if the field needs height; colour anchor preference from 3M (the more colourful real object)
  → Establish Planes        floor line (baseline band), wall plane (art hangs above the anchors' top line), support surfaces (tables/consoles/pedestals expose top bands), ground patch (rug beneath anchors)
  → Establish Relationships typed edges: ON / BESIDE / UNDER / HANGS_ABOVE / IN_FRONT_OF / FOREGROUND_ACCENT — every object gets at least one edge to the graph (nothing floats)
  → Fill Secondary Space    secondary anchors and supporting objects placed by their edges; wall art distributed above; tall verticals link lower and upper field
  → Add Foreground Accents  small objects (foreground_suitability ≥ 2) over lower edges, closest depth, largest depth factor
  → Collision / Scale Audit physical_audit (Mission 4) + 3M.3 spatial audit (family profile) + coverage fit (Mission 6)
  → Render                  compose.render with the plan's layers; metrics; QA
```

Planning is iterative: an audit violation returns to the step that caused it (a THROUGH → re-place by its edge; a scale violation →
re-size to the scale model; an unsupported object → assign a supporter or demote it to a floor accent if allowed; a void → coverage fit).
The renderer is never asked to "fix" a plan by nudging pixels.

## The scene plan (what the planner outputs)

```json
{
  "family": "ACQUISITION", "field": {"x": 0, "y": 430, "w": 1080, "h": 690},
  "scene_scale_px_per_in": 10.65, "primary_anchor": "chairs",
  "planes": {"floor_baseline_band": [1010, 1110], "wall_top_line": 560, "supports": {"table": {"top_band": [787, 811]}}},
  "objects": [
    {"id": "chairs", "semantic_class": "wingback_chair", "role": "HERO", "plane": "floor", "x": 330, "y": 580, "w": 688, "z": 2, "baseline": 1080, "dims_source": "class_default", "edges": []},
    {"id": "torchiere", "semantic_class": "torchiere", "role": "TALL", "plane": "floor", "x": 40, "y": 266, "w": 215, "z": 1, "baseline": 990, "edges": [{"type": "BESIDE", "to": "chairs"}, {"type": "BEHIND", "to": "table"}]},
    {"id": "table", "semantic_class": "side_table", "role": "SURFACE_PROVIDER", "plane": "floor", "x": 150, "y": 823, "w": 229, "z": 3, "baseline": 1100, "edges": [{"type": "BESIDE", "to": "chairs"}]},
    {"id": "vases", "semantic_class": "vase", "role": "SURFACE", "plane": "table", "support": "table", "z": 4, "edges": [{"type": "ON", "to": "table"}]},
    {"id": "bowl", "semantic_class": "bowl", "role": "FOREGROUND", "plane": "floor", "floor_accent": true, "z": 5, "edges": [{"type": "FOREGROUND_ACCENT", "to": "chairs"}]}
  ],
  "intentional_negative_space": [],
  "audit": {"physical": [], "spatial": [], "coverage": {"coverage_pct": 58.1, "cluster_extent_w": 0.92, "largest_accidental_void_pct": 4.9}}
}
```

Every render stores its plan; the plan is the provenance of the composition and the input to the anti-similarity signature.

## Relationship reasoning, in the Owner's terms

- A **sofa** is placed first; a **coffee table** goes in front of it, overlapping only its lower edge; **side tables** go beside its arms
  at arm height; a **table lamp** sits on a side table; **art** hangs above the sofa's back; a **rug** goes under all of it.
- A **wingback chair** takes a **side table** beside it — touching the outer arm edge at most — never across its seat; a **floor lamp**
  stands behind or beside it and is taller than it.
- A **dining table** takes **chairs** pushed in over its apron and **china** grouped on top; a **cabinet** stands behind, grounded.
- **Small objects** (bowl, figurine, book stack) come last, in front, over lower edges — or on a support.
- **Jewellery, watches, coins** never enter a room scene; they get the category families.

## Intentional layering versus impossible intersection

The planner is asked to layer deliberately: coffee table over sofa base, chair over table apron, foreground bowl over a chair's lower
edge, tall lamp behind a chair with the chair overlapping its base. The audit permits every one of those and forbids the ones a person
would reject: a table crossing a seat, a lamp shorter than a chair standing in front of it, a vase larger than a chair, a painting on the
floor, a rug over a table. Reducing overlap globally would throw away the first list to avoid the second; the typed edges are what make
the distinction computable.

## Judge prompt additions (vision judge v2)

Three named questions replace the vague "staged by a set designer" item: (1) Is any object passing through another object? Name them.
(2) Is any object the wrong size for what it is, relative to the largest piece? Name it. (3) Does every small object rest on something or
sit clearly in front? A "yes" on (1) or (2) is a hard fail independent of the numeric audit — the two systems check each other.

## What this replaces and what it keeps

Keeps: the 3M.3 roles, planes, gravity, wall, support and protected-region rules; hand-placed calibrated layouts as fixtures. Replaces:
"place then audit" with "plan, audit, render". Adds: the semantic layer, typed edges, real-world scale, and the planner's obligation to
return to the failing step rather than shrink everything.
