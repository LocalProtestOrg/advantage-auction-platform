# Mission 2 — Authentic Media-First Creative Director

**Phase 3P.1 · 2026-09-10 · Config: `config/media-source-hierarchy.json`**

## The rule the Owner stated, made operational

"A real photograph taken by a person is more convincing than unnecessary synthetic composition." For every event-specific campaign the
Director now evaluates the event's own media **before** it is allowed to plan a collage. Collage (tier 5) is what happens when the
event's real media is not good enough, or when object photography is the point (notable lot, category spotlight). A restrained factual
creative (tier 6) is an acceptable outcome; an implausible collage is not.

## Decision hierarchy

| Tier | Source | Ready when | Typical use |
|---|---|---|---|
| 1 | Seller/event **cover image** | it is a photograph (not a composed ad), event-bound, sharp, well exposed, subject intact in 4:5 and 1:1 crops, score ≥ 70 | on-site sales, auctions with a hero room |
| 2 | Seller-uploaded **walkthrough video frame** | a frame chosen by the Mission 3 pipeline passes the frame gates, score ≥ 70 | when no still photograph exists or the video shows the sale better |
| 3 | One strong **authentic environmental photograph** | event-bound, sharp, exposed, clutter-free enough, inviting, crops well, score ≥ 70 | on-site estate sales (West University A/C) |
| 4 | **Multiple** strong environmental photographs | ≥ 2 tier-3-ready photographs of distinct scenes | sequential creative across waves; primary + one secondary |
| 5 | **Individual merchandise images** composed editorially | ≥ 3 CLEAN objects with resolved semantic classes; scene plan passes the physical audit | online auctions without a site; notable lots; category spotlights |
| 6 | **Restrained branded factual** creative | always | when nothing above is ready |

Every tier has provenance as a hard gate: the asset must be bound to the campaign's `event_id` with an uploader or source page, a
retrieval time and rights. An asset that cannot be bound is excluded, not scored low. Media from another event, another seller, stock or a
generator is never a candidate.

## Cover images are often not photographs

The West University event's Facebook cover is Lewis & Maese's own finished advertisement (ESTATE SALE headline, three photo tiles, URL
band). It is exactly the kind of asset a naive "use the cover image" rule would put on top of a creative. The `is_photograph` gate
(headline-class text or a logo → not a photograph) routes composed graphics to the published-anchor role instead, where the
anti-similarity check uses them as something to be different from. VS Code's implementation note already treats the West University
cover this way; the config makes it the rule for every event.

## Quality and readiness criteria (per candidate)

Hard gates first (a failed gate means *not ready*, never "low score"): minimum long edge (1200px for a cover, 1080px for a room
photograph), sharpness floor, clipped highlights ≤ 6%, dark share ≤ 25%, text contamination (none, or watermark / price tags only),
subject integrity in the required crops. Then a 100-point score: sharpness, exposure and colour, merchandise visibility and variety,
clutter (each box, cable, bag, sticker, person or phone costs points), invitation (would a buyer walk in), aspect suitability, representative
value. Readiness = 70.

## Worked decision trail — West University (the eight photographs VS Code staged)

Measured from the files (Laplacian-variance sharpness, luminance statistics) and read visually. This is what the packet's decision trail
should look like; the Director produced no such trail on 2026-09-09 — candidate A used IMG_0520 and C used IMG_0522 without a recorded
comparison, and the Owner's preference for C's photograph is consistent with the ranking below.

| Photo | Sharp. (var) | Bright | Clipped | Dark | Clutter seen | Read | Gate | Est. score | Rank |
|---|---|---|---|---|---|---|---|---|---|
| IMG_0522 | 1040 | 151 | 2.7% | 1% | none material | Widest living-room view: sofa, yellow armchair, wingback, cabinet, two lamps lit, art on every wall, rug; inviting; crops well 4:5 and 1:1 | pass | ~86 | **1** |
| IMG_0520 | 1228 | 151 | 2.4% | 3% | cardboard box on the floor, cables, a rug pushed against the wall | Same room from the other end; sharp and bright; the box and cables sit in the foreground of any crop | pass | ~72 | 2 |
| IMG_0529 | 808 | 126 | 1.6% | 9% | foreground chair back cut by the frame; kitchen door open | Dining room from behind a chair; table setting visible | pass (subject integrity marginal in 4:5) | ~64 | 3 |
| IMG_0526 | 957 | 125 | 5.9% | 16% | window nearly blown out; a chair seat cut at the frame edge | Dining room toward the window; the bust and painting are good; window glare | pass (clip at the limit) | ~60 | 4 |
| IMG_0550 | 782 | 130 | 1.1% | 16% | busy mantel; dark fireplace | Mantel with masks, horse, carvings — distinctive but dense; crops poorly to 4:5 | pass | ~55 | 5 |
| IMG_0549 | 981 | 108 | 1.2% | 14% | two cardboard boxes, loose objects on the floor | Sitting room with fireplace; cluttered; dark | pass | ~48 | 6 |
| IMG_0546 | 795 | 119 | 3.2% | 19% | lamp shade blocks the left third; cardboard box under the sideboard | Sideboard with decanters; foreground obstruction | fail (obstruction) | — | — |
| IMG_0552 | 390 | 133 | 0% | 10% | soft focus | Shelf unit with ceramics and a carved bird; soft | fail (sharpness floor) | — | — |

Decision: tier 1 not available (the cover is a composed graphic → anchor). Tier 2 not available (no video on the event record). Tier 3:
IMG_0522 ready at ~86 → **selected**. Tier 4 available (0522 + 0520 are distinct enough) → reserved for a MID-wave creative, not a
3-tile grid. Tier 5 not built: the Owner's rule says do not manufacture a collage when a real photograph exists. Trail recorded.

## Director outputs (added to the packet and the brief)

```json
"media_decision": {
  "event_id": "…", "tier_selected": 3, "selected_asset_sha256": "…",
  "candidates": [ { "asset_sha256": "…", "tier": 3, "gates": {"sharpness": true, "clipped": true, "dark": true, "text": true, "subject_integrity": true}, "score": 86, "clutter_items": [], "notes": "…" } ],
  "override_reason": null,
  "collage_considered": false, "collage_reason": "authentic photograph ready at tier 3 (Owner rule)",
  "owner_review_required": false
}
```

The brief's `merchandise_mode` follows the tier: 1–4 → `photograph`, 5 → `lots`, 6 → `none`. The family selector reads
`media_decision.tier_selected` before anything else; ENVIRONMENTAL_PHOTO is the family for tiers 1–4.

## Never

Use media not bound to this event. Use a composed graphic as a photograph. Use stock or generated imagery. Default to collage because
objects exist. Take the first frame of a video by position. Enhance in a way that invents detail — crop, straighten, exposure and white
balance only; no generative fill; no upscaling beyond 1.25×.
