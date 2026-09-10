# Mission 10 — Next Proving Grounds (revised, non-publishing)

**Phase 3P.1 · 2026-09-10 · Runs after VS Code implements Mission 11. Nothing publishes; A9 and all destination gates stay OFF; every candidate is Owner-reviewed.**

## A. West University — revised candidate

**Keeps from C (the Owner's preferred):** the ENVIRONMENTAL_PHOTO banded family; an authentic environmental photograph; the red accent;
no synthetic merchandise; the navy band.

**Changes (every one traces to a recorded attribute):**

| Attribute | Change |
|---|---|
| authentic_environmental_photograph | Media Director runs the tier walk (Mission 2) and records the trail. Expected: IMG_0522 at tier 3 (the photograph the Owner preferred in C). The photograph bleeds to both side edges and holds 55–75% of the field. |
| event_type_prominence | Title unit **TYPE_LED**: "Estate Sale" is the largest text (≥ 4.8% of canvas height, ≥ 80% of the largest element); "West University" on the second line at 60–100% of it. "Exclusive On-Site" becomes a modifier at ≤ 45% of the type's cap height or moves to the support line. No orphan wraps. |
| advantage_bid_identity_prominence | Relationship line carries the **Advantage.Bid logo mark** beside "in conjunction with", cap height 2.2–3.0% of canvas height; lockup + line reach 60–90% of the seller identity's weight; band wordmark 5.2–6.5% cap height. Seller remains primary. |
| red_accent_use | One or two tasteful red elements: the rule under the title unit and either the date or "Estate Sale" set in red — never both a red type line and a red band. The "NOT FOR PUBLICATION" label moves off the canvas (a sidecar label), so red on the extreme is the same red as production would carry. |
| headline_capitalization | "Estate Sale", "West University", "Saturday, September 19"; place plate stays a small uppercase label or becomes "West University Area · Houston, TX" in title style. |
| synthetic_composition_unnecessary | No objects extracted, no collage, no tiles; one photograph. |

Facts from the production record only (title, date, hours, place; the street address is still omitted, not invented). Seller identity in
type unless a seller logo asset exists in production. Published graphic loaded as the negative anchor; similarity to it must stay above
τ_pub even though both now lead with "Estate Sale" — the layout, photograph, colour and type are different; the anchor check proves it.

Variants: **R1** TYPE_LED · **R2** TWO_LINE_UNIT ("West University" / "Estate Sale", type ≥ 80%) · **R3** calibration extreme of the
better of R1/R2 with **identity and event type at 1.3×** (nothing else enlarged), marked NOT FOR PUBLICATION in the packet, not on the
canvas.

Gates: media trail present; event-type and identity prominence checks pass; capitalization hygiene passes; anti-similarity (references,
published anchor, and the rejected WU-B negative signature); seller-mark gate (Lewis & Maese allowed as the brief's co-brand); score bar
≥ 70. Packet shows R1/R2/R3 beside the previous A and C for the Owner.

## B. Individual Seller acquisition — revised candidate

**Keeps:** the headline **"You Can Do This."** (OWNER_APPROVED_MESSAGE) in title style; the real Advantage.Bid logo; representative
items flagged "not lots"; a factual help line with the real phone number; the navy band. **Drops:** the screenshot-led execution
(negative signature), the contact card, sentence-case headlines.

**Rethinks the visual execution with the physical merchandise intelligence:**

1. Scene planning (Mission 5) from the representative set: primary anchor = the pair of wingback chairs (or a sofa if the asset set
   gains one); a side table BESIDE the chair at real-world scale (26 in against 46 in); the torchiere BEHIND and taller; vases ON the
   table; the silver bowl or a book stack as a foreground accent over a lower edge; a mirror or artwork hung above the anchor line if the
   field needs height (HANGS_ABOVE, behind). Rug UNDER the anchors if a rug asset exists.
2. Physical audit: zero THROUGH, zero protected-feature occlusion, scale within tolerance, every table-plane object supported.
3. Coverage fit (Mission 6): the cluster scaled uniformly to ≥ 80% of the field's width and ≥ 70% of its height; 45–65% coverage of the
   field; accidental void ≤ 8%; upper-field merchandise ≥ 25% — a tall object or hung art makes the height.
4. Identity: logo lockup at 30–40% of canvas width in the top zone; band wordmark at 5.2–6.5%.
5. Copy: "You Can Do This." (headline, title style) → one support line, sentence style, factual ("Create your own online auction on
   Advantage.Bid.") → one help line with the real phone → band. Three blocks. No card.

Variants: **P1** chairs + table + torchiere + vases + bowl (the corrected version of A's own objects) · **P2** a different anchor
arrangement (mirror hung above a console with a lamp, chairs beside) to show the planner is not a template · **P3** extreme: cluster
at the maximum the scale model allows, logo at 44%.

Success is judged on two things the Owner named: does it feel staged and believable (no impossible intersections; the judge's three
physical questions answer "no, no, yes"), and does it use the canvas confidently (coverage and extent inside the band with no accidental
void). The packet shows P1/P2/P3 beside the previous A and C, and the audit comparison image
(`reference/tests/comparison.jpg`) as evidence of what changed.

## C. Optional authentic-media test

Precondition: a production auction/event with a **seller-uploaded cover image** or a **seller-uploaded walkthrough video**. VS Code
queries production for events where `cover_image_asset_id` or `walkthrough_video_asset_ids` is set and the event is upcoming or live;
if none exists the test is deferred and the packet says so — it is not simulated.

When one exists: run the Media Director for that event and show the decision trail in full — every candidate (cover, frames, site
photographs, CLEAN objects), its gates and scores, the tier chosen, and the explicit line "collage considered: no — authentic media
ready at tier N" (or "yes — because …"). Render the chosen-media creative in the family that fits (ENVIRONMENTAL_PHOTO or a
photograph-led variant of the event's family) with the corrected hierarchy and identity rules. For a video event the shortlist of frames
is included so the Owner can see that the chosen frame beat the first frame on merit. If the cover turns out to be a composed graphic,
the packet shows it being routed to the anchor role rather than used — that is a valid outcome of the test.

No publishing, no audience, no spend; Owner review of the media choice is the point.

## What the Owner sees

For each proving ground, one review page: the new candidates first, the previous ones beside them, then the numbers (prominence
measures in canvas and feed-proxy pixels, event-type size ratio, coverage and void, physical-audit result, media trail). His words go into
the feedback ledger through Mission 1's record model; a GOOD with no required attributes makes a candidate eligible for the library with
Advantage.Bid provenance; "best of these" stays a set preference; Gold is only ever his explicit word.
