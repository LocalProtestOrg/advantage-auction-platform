# Mission 1 — Owner Feedback Record Model

**Phase 3P.1 · 2026-09-10 · Source: the Owner's review of the six proving-ground creatives of 2026-09-09, read against the renders and the packets VS Code produced.**

## What was recorded

Seven records in `owner-feedback-2026-09-10.jsonl` (six creative reviews and one global rule), validated against
`config/feedback-record.schema.json`, and appended to `approved-creative-examples/owner-decisions.jsonl` with the new action
`CREATIVE_REVIEW` / `OWNER_RULE`. The Owner's words are verbatim. Nothing was upgraded: no creative was admitted to the library, nothing was
marked Gold Standard, and "best of the three" is stored as a set preference (rank 1 of 3) with `explicitly_not_gold: true`.

| Creative | Overall | Set preference | Library admission | Negative signature | Required fixes |
|---|---|---|---|---|---|
| West University A | GOOD | — | eligible after revision | no | event-type prominence; Advantage.Bid identity prominence |
| West University B | NO | — | none | **yes** | (composition rejected as a whole; attributes recorded) |
| West University C | GOOD | **1 of 3** | eligible after revision | no | event-type prominence; Advantage.Bid identity prominence |
| Individual Seller A | OK / NEEDS WORK | — | none | no | identity prominence; composition intelligence; impossible intersection; scale believability |
| Individual Seller B | NO | — | none | **yes** | (visual execution rejected; message approved) |
| Individual Seller C | OK / NEEDS WORK | — | none | no | merchandise coverage; accidental white space; identity prominence |
| Global rule | GLOBAL_RULE | — | — | — | headline capitalization |

## Why attribute-level

A verdict on a whole creative is one bit; the Owner gave far more than that. The schema keeps four things apart so none of them
contaminates the others:

1. **Verdict** — GOOD / OK_NEEDS_WORK / NO, plus set preference. Drives library admission and the negative-signature set only.
2. **Attributes** — each with polarity, severity (required / strong / note), scope (this creative / class / family / global) and the
   evidence seen in the render. Drives scorer rules and judge items.
3. **Messages** — copy the Owner explicitly judged, with its own status. Drives the copy engine.
4. **Rules** — global statements with examples and a config reference.

So Individual Seller B is `NO` with a negative signature, **and** carries `"You Can Do This."` as `OWNER_APPROVED_MESSAGE` for
`individual_seller_acquisition`. The message survives the rejection; the screenshot-led layout does not. West University C is `GOOD`,
rank 1 of 3, **and** carries two `required` negative attributes; it cannot enter the library until a revised version is approved without
required fixes.

Message statuses are deliberately narrow: only `OWNER_APPROVED_MESSAGE` may be presented as approved copy. "It's Built to Be Easy." is
recorded as `OWNER_AUTHORED_PHILOSOPHY` (the Owner wrote it in the 3P brief; he did not judge it this round) and "Help Is Here." as
`USED_NOT_EVALUATED`. The Owner listed all three as capitalization examples, which is a statement about capitalization, not about the
messages — the records do not read approval into it.

## Attribute ledger (what the system now knows, by polarity)

**Positive**
- `authentic_environmental_photograph` (estate_sale, strong ×2): a real room photograph taken by a person beats manufactured composition.
- `red_accent_use` (global, strong): a tasteful Advantage.Bid red accent is liked. Recorded with a caution: in C the red also came from the
  "CALIBRATION EXTREME — NOT FOR PUBLICATION" label band, which is not a design element; the learning is "one or two red accents", not "a red band".
- `headline_message` "You Can Do This." (individual_seller_acquisition, strong).
- `headline_capitalization` (global, required): title-style capitalization.
- `merchandise_coverage` (note, IS-A): a cluster that spans the canvas width was not objected to.

**Negative**
- `event_type_prominence` (estate_sale, required ×3): the event type was a subtitle in every West University candidate.
- `advantage_bid_identity_prominence` (global, required ×6): every one of the six was too small.
- `impossible_intersection`, `object_scale_believability`, `composition_intelligence` (required, IS-A): the table through the chair.
- `merchandise_coverage`, `accidental_white_space`, `contact_card_dominance` (required/strong, IS-C).
- `layout_side_panel_void`, `photo_crop_subject_integrity`, `title_wrapping` (strong, WU-B).
- `screenshot_led_execution` (strong, IS-B).
- `synthetic_composition_unnecessary` (estate_sale, strong, from C's words).

## Scorer versus Owner — the post-mortem that drives the rest of this phase

The scorer accepted everything the Owner rejected. That is the most useful data this round produced.

| Creative | Scorer (portrait / square) | Owner | Why the scorer missed it | Closed by |
|---|---|---|---|---|
| WU-A | 94.6 / 88.3 | GOOD + 2 required | No event-type metric; `brand_frame.logo: false` not penalised because band + wordmark passed; no prominence measure | Mission 7, Mission 8 |
| WU-B | 82.4 / 79.9 → accept band | **NO** | `largest_empty_pct` 16.6 / 17.2 scored a partial loss instead of failing the panel-family cap (≤ 10); `hierarchy_ratio` 1.43 (floor 2.2) scored partial; no crop-integrity or text-wrap check | Mission 6 (hard void cap), Mission 8 (hierarchy floor), new wrap/orphan and crop-integrity checks |
| WU-C | 92.7 / 88.1 (extreme) | BEST, still 2 required | Extreme was 1.15× on title and photo — not on the two things the Owner wanted larger | Mission 10-A (extreme targets event type and identity at 1.3×) |
| IS-A | 90.5 / 89.0 | NEEDS WORK | Judge item 2 ("staged by a set designer") scored 3/4 despite a table through a chair; no collision or scale audit exists — the 3M.3 audit checks gravity, wall, support, perspective, protected regions, but not same-plane intersection or real-world scale | Mission 4, Mission 5 |
| IS-B | 89.7 / 92.5 | **NO** (message approved) | Judge rewarded "clean"; a UI screenshot as hero has no rule against it; representative objects overlapping a screen panel not detected | Mission 1 attribute → family rule; Mission 5 |
| IS-C | 72.5 / 76.3 → accept | NEEDS WORK | `merchandise_pct` 12.4 / 16.6 lost points but the ACQUISITION family had no coverage floor; `upper_half_merch` 0 not a hard check; card void not measured | Mission 6 |

Three structural conclusions: measured bands must become **hard floors and caps** where the Owner treats the failure as disqualifying
(coverage, void, hierarchy); the judge must be asked **specific physical and comprehension questions** (is anything passing through
anything; what is the event; can you name the platform at a glance) rather than aesthetic ones; and **prominence** is a first-class metric.

## How the records are used

| Consumer | Uses | Never uses |
|---|---|---|
| Scorer v2 (Mission 11) | `attributes` with severity ≥ strong become hard checks or weighted items per scope | verdicts as scores |
| Copy engine | `messages` with `OWNER_APPROVED_MESSAGE` | philosophy or unevaluated lines as "approved" |
| Retriever | `negative_signature` renders in the class's negative set (distance < τ_neg → penalty; < τ_neg/2 → reject) | negative renders as positive references |
| Library | `library_admission` only after a revised creative is reviewed GOOD with no required attributes | set preference as Gold |
| Judge prompt v2 | attribute vocabulary as named items | free-form aesthetics |

## The Owner's vocabulary, extended

| Owner says | Verdict | Effect |
|---|---|---|
| good · approved (with "but…") | GOOD | eligible after revision; required attributes must be cleared first |
| ok · needs work | OK_NEEDS_WORK | attributes recorded; nothing admitted |
| no · treat as negative evidence | NO | negative signature + attributes |
| best of these · prefer that one | set preference | never Gold; recorded rank |
| do not mark gold | `explicitly_not_gold` | blocks any Gold write for that render |
| "the message is good" / "keep that line" | message status | independent of the visual verdict |
| a rule stated as a rule | OWNER_RULE | config change proposal with the Owner's examples as tests |
