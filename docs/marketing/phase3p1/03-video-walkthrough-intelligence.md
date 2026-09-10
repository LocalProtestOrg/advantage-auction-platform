# Mission 3 — Video Walkthrough Intelligence

**Phase 3P.1 · 2026-09-10 · Tier 2 of the media hierarchy. Nothing here invents video content: the pipeline only selects, crops, straightens and colour-corrects frames that exist.**

## Provenance first

A video is a candidate only when the production event record links it: `walkthrough_video_asset_id`, uploader (seller account or a
seller-published page approved by the Owner), upload/retrieval time, rights, content hash, duration, frame rate, resolution. The
`event_id` binding is checked before a single frame is decoded. A video from another sale, a seller's showreel, or a general house tour
is not a candidate. The selected frame inherits the video's provenance plus `timestamp_ms`, `frame_index`, `selection_method`, and
`selection_scores`.

## Pipeline

```
ingest → decode metadata → sample candidates → per-frame measures → hard gates → diversity clustering → ranking → shortlist (≤ 8)
      → Director pick (highest score; Owner review on first three uses) → crop/straighten/exposure only → provenance record
```

**Sampling.** Scene-change detection (frame-difference peaks) plus uniform sampling at 1 frame per second, capped at 300 candidates;
the first and last 1.5 seconds are excluded by default (camera starting/stopping, hands, the floor). The first frame is never selected by
position — it must win on score like any other.

**Per-frame measures.**

| Measure | Method | Gate / use |
|---|---|---|
| Sharpness | Laplacian variance of luminance, normalised against the 90th percentile within this video | gate ≥ 0.30 |
| Motion blur | mean optical-flow magnitude between the frame and its neighbours (or frame-difference energy); directional blur estimate | gate ≤ 0.25 (normalised); score |
| Lighting | mean luminance 90–170, clipped highlights ≤ 6%, dark ≤ 25%; colour cast estimate (grey-world) | gate + score; white balance may be corrected |
| Merchandise visibility | object detector count and total area of furniture/art/decor classes (Mission 4 taxonomy); variety of classes | score (weight 20) |
| Obstruction | detector for person, hand, phone, door frame in the near field, reflection in mirrors/glass; any obstruction > 5% of frame area | gate |
| Text / logo contamination | OCR + logo template match; price tags allowed, signage and any seller/third-party mark not allowed | gate |
| Tilt | horizon / dominant vertical line angle; ≤ 3° after straightening | correct or reject |
| Aspect-ratio suitability | merchandise mass bounding region must fit a 4:5 and a 1:1 crop keeping ≥ 90% of its area; source height after crop ≥ 1080 or honest downscale (no upscaling beyond 1.25×) | gate |
| Representative value | cluster frames by scene (perceptual signature); prefer the frame whose scene cluster is largest (the room the video dwells on) and whose classes match the auction's category families | score (weight 15) |
| Factual relationship to event | frame scene must be consistent with the event's site photographs if any exist (perceptual similarity to at least one site photograph ≥ 0.4) — a sanity check against a mislinked video | flag for review if inconsistent |

**Diversity clustering.** Frames are grouped by scene so the shortlist shows different rooms, not eight near-duplicates. Within a cluster
the top frame by score represents it.

**Ranking.** Weighted score over the tier-2 criteria in `media-source-hierarchy.json` (sharpness 15, motion stability 10, exposure and
colour 10, merchandise visibility 20, obstruction-free 15, representative value 15, aspect suitability 15). Readiness 70.

**Director pick.** The highest-scoring ready frame; the shortlist and every score go into the packet's `media_decision`. The first three
tier-2 selections for any seller are Owner-review flagged so the Owner sees what the pipeline chooses before it runs unattended.

## What may be done to a selected frame, and what may not

Allowed: crop to the required formats, straighten ≤ 3°, exposure and white-balance correction, mild sharpening (radius ≤ 1px, amount ≤ 40%),
downscale. Not allowed: generative fill, object removal, inpainting, super-resolution beyond 1.25×, frame interpolation, HDR merging of
multiple frames, any change that adds detail the camera did not record. A frame that needs more than the allowed corrections is not ready.

## Packet record

```json
"video_frame_selection": {
  "video_sha256": "…", "event_id": "…", "duration_s": 94.2, "fps": 30, "candidates_sampled": 118,
  "shortlist": [ { "frame_index": 1842, "timestamp_ms": 61400, "scene_cluster": 3, "score": 81, "gates": {"sharpness": true, "motion": true, "lighting": true, "obstruction": true, "text": true, "aspect": true}, "measures": {"sharpness_norm": 0.72, "motion_blur": 0.08, "luminance": 138, "clipped_pct": 1.9, "objects": 9, "classes": ["sofa","side_table","table_lamp","painting","rug"]} } ],
  "selected_frame_index": 1842, "selection_method": "score-ranked, scene-diverse; first frame excluded by rule",
  "corrections_applied": ["crop 4:5", "white_balance"], "owner_review_required": true
}
```

## Tests VS Code implements

A video whose best frame is frame 0 by score is allowed, but a pipeline that returns frame 0 for three different videos fails. A frame
with a hand covering 8% of the area is rejected. A frame with seller signage text is rejected. A video not bound to the event is refused
before decoding. Corrections beyond the allowed list are refused by the asset pipeline (unit test on the correction whitelist).
