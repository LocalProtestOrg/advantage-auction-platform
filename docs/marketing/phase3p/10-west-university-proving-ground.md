# Deliverable 10 — West University Proving-Ground Plan (first production creative test)

**Phase 3P · 2026-09-09 · Runs only AFTER VS Code implements the reference system (Deliverable 12).**

## The case

| | |
|---|---|
| Event | Exclusive West University On-Site Estate Sale |
| Date | September 19, 2026 |
| Seller | Lewis & Maese (Professional Seller) |
| Status | Live in production with a graphic that was **created externally and selected by the Marketing Agency** |
| What the test asks | Can the production creative engine make a **new** advertisement for this event, from production facts and legitimate event images, calibrated by the Owner's references — that the Owner would put beside his approved examples? |

## Non-negotiables

- **Nothing is published.** A9 and every destination gate stay OFF; the job runs with `dry_run = true` and produces a review packet only.
- **The published graphic is not reused, reproduced or referenced by the generator.** It is loaded once, by the scorer only, as a
  *negative anchor* (`published_anchor`) so the anti-similarity check can prove the new creative is different.
- **No reference image reaches the generator.** Retrieval returns principles.
- **Facts come from production.** Title, date, session times, place name / neighbourhood, city-state, online/on-site mode — from the event
  record as it exists. If a fact is missing (e.g. hours), the creative omits it; nothing is invented.
- **Images come from the event.** Site photographs attached to the production event record with provenance, and/or CLEAN extracted lot
  objects belonging to this event's auction id. No stock, no other event, no reference artwork.
- **Seller branding comes from production.** Lewis & Maese's logo from `cobrand.seller_logo_asset_id`; the seller leads, Advantage.Bid is
  visibly associated but subordinate ("In Conjunction with Advantage.Bid" or "Advantage.Bid Presents" per the relationship line as configured);
  navy Advantage.Bid band at the bottom.

## Procedure

**Step 0 — Preconditions (VS Code confirms in the packet).** Reference index built and validated; scorer regression anchors recorded;
event record readable; site photographs and/or CLEAN objects enumerated with provenance; published graphic staged as the negative anchor
with its hash.

**Step 1 — Classification.** `campaign_class = estate_sale`; `seller_hierarchy = seller_led_cobranded`; `event_mode = on_site`;
`wave = MID` (the sale is already announced) or `ANY`; `merchandise_mode = photograph` if site photographs exist, else `lots`;
formats `portrait_1080x1350` + `square_1080x1080` (thumbnail check applies to both).

**Step 2 — Retrieval (expected result, to be verified).** Primary: REF-09, REF-10. Secondary: REF-04, REF-05, REF-06, REF-02.
Excluded by `avoid_for`: REF-07, REF-08, REF-11, REF-12, REF-13. Seller-identity stripping active (100% one seller). Confidence HIGH for
the environmental family, MEDIUM for extracted families. `owner_review_required = true` in any case — this is a proving ground.

**Step 3 — Principle profile (expected).** Presenter (Lewis & Maese) leads; one place-led title where the place name may be the largest
word; date larger than time; one category line ≤ 6 words or none; date pair / session block; neighbourhood plate on the photograph edge
allowed; no taglines; no words on merchandise; light panel; navy Advantage.Bid band; text budget GENERAL (5) unless preview logistics are
in the record (then LOGISTICS, reason recorded).

**Step 4 — Generate three variants.**

| Variant | Family | Purpose |
|---|---|---|
| **A** | ENVIRONMENTAL_PHOTO, banded portrait (REF-09 lineage) | The on-site estate-sale family the Owner selected twice |
| **B** | ENVIRONMENTAL_PHOTO, left panel (REF-10 lineage) — or LEFT_THIRD_WHITE with ≥ 5 CLEAN objects if no usable site photograph exists | The second estate-sale layout; tests the panel + co-brand hierarchy |
| **C** | Same family as the higher-scoring of A/B, **CALIBRATION EXTREME — NOT FOR PUBLICATION**: merchandise/title pushed ~15% past band | So the Owner can say "come back 10%" instead of "make it bigger" |

Each variant: different photograph or object selection where the record allows; each must clear the anti-similarity check against the
other two, against REF-09/REF-10, and against the published anchor.

**Step 5 — Audit and QA.** Family audit profile (environmental: text-over-photo legibility, no copy over merchandise except the place
plate, band/logo at spec; or the full 3M.3 audit for LEFT_THIRD_WHITE). Existing gates G0–G9. New gates G10 calibration, G11
anti-similarity, G12 seller-mark leak (Lewis & Maese marks are *allowed* here because it is the brief's cobrand seller; any other seller
mark fails).

**Step 6 — Score.** Calibration score with per-principle evidence; judge runs ×2; hard checks; similarity numbers to REF-09, REF-10 and
the published anchor.

**Step 7 — Packet to Desktop Marketing → Owner.** Contents:

1. The three renders in both formats plus 281px thumbnails, labelled A / B / C (C marked NOT FOR PUBLICATION).
2. The published graphic shown *beside* them for comparison only, labelled "currently published — external — not generated".
3. The brief (facts, merchandise mode, assets with provenance, calibration block).
4. Retrieved references (ids only, with their transferable lessons) — not the images.
5. Audit results, metrics, calibration score breakdown, similarity distances, claim manifest.
6. One-line honest statement of anything omitted for lack of a production fact.

**Step 8 — Owner review (visual first, analysis after).** The Owner looks at A/B/C and the published graphic and says what he thinks
in his own words. Desktop Marketing records it through the feedback model (Deliverable 9): a "good"/"love this" creative may enter the
library as the first Advantage.Bid-provenance, co-branded reference; "come back X%" becomes a band proposal; "don't use" becomes negative
evidence.

**Step 9 — Report.** `CALIBRATION_REPORT` (Desktop → VS): whether the C6 hypothesis (merchandise 50–65%, text ≤ 18%) held; whether the
co-brand relationship line read correctly; which family the Owner preferred; any rule refinements as RULE_PROPOSALs. Nothing publishes.

## Pass / fail for the *system* (independent of the Owner's taste verdict)

| Check | Pass condition |
|---|---|
| Facts | every text element traces to the event record; nothing invented |
| Images | every pixel of merchandise traces to an event-bound asset with provenance |
| Reuse | similarity to the published graphic below τ_pub; no pixel or crop of it in any variant |
| Copy | no seller string other than Lewis & Maese; no reference wording; budget within profile |
| Hierarchy | seller leads, Advantage.Bid subordinate, navy band present |
| Publish | A9 asserted OFF in the packet; no destination job created |
| Score | ≥ 70 on at least one of A/B (C is exempt) |

If the system passes and the Owner says "not yet", that is a calibration result, not a failure — it is exactly what the proving ground
exists to surface.
