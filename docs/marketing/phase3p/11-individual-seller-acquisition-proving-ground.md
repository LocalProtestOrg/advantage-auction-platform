# Deliverable 11 — Individual Seller Acquisition Proving-Ground Plan (second test)

**Phase 3P · 2026-09-09 · Runs after Deliverable 10, or in parallel once the reference system is implemented.**

## Why this test is different

The West University test asks the engine to do, for a real event, what the Owner's references already show. This test asks it to carry
the Owner's taste into a place the library has **no example of**: persuading an ordinary person with things to sell to create their own
online auction on Advantage.Bid. The `individual-seller` folder is empty. If the system can only imitate, this test will show it.

## Objective and philosophy (from the mission, verbatim in spirit)

Encourage ordinary people with items to sell to use Advantage.Bid to create their own online auction. Communicate ease, opportunity and
accessibility. "It's built to be easy." "You can do this." Human help remains visibly available where appropriate.

## Non-negotiables

- Nothing publishes. Dry run. Owner review mandatory (empty class → `owner_review_required = true`, confidence LOW).
- **No lots.** `merchandise_mode = representative`: objects shown are representative of what people sell, sourced from Advantage.Bid-owned or
  licensed photography, flagged "representative — not lots", never taken from a seller's catalogue, never implied to be in any auction.
- **No fabricated people.** If a "human help" element is visual, it uses a real Advantage.Bid team photograph that exists in production
  with consent; otherwise human help is a line of copy ("Real people help you every step." style — exact words are the engine's, factual),
  a real phone/chat fact, or a real product screenshot showing the help entry point. No stock people, no generated faces.
- **Product truth.** If a screen is shown it is a real screenshot of the current Advantage.Bid create-auction flow, captured by the job
  from production at generation time and stored with provenance.
- **Advantage.Bid leads.** `seller_hierarchy = advantage_bid_only`; real logo; red accent; navy band; Quicksand character; light ground.
- **Text budget:** TEASER (3) or GENERAL (5) — one primary message, one support line, one help line, footer. No feature lists, no icon
  piles, no steps-as-numbered-boxes unless the Owner asks.

## Classification and retrieval (expected)

`campaign_class = individual_seller_acquisition` → no primary or secondary references. Fallback loads the `global_transferable_profile`
(hierarchy, merchandise-forward, light ground, restrained copy, band close, confident type) and class-neutral lessons at 0.25:
REF-08 (breadth — ordinary property is worth showing), REF-11 (warmth; tools and work culture), REF-02 (grounded, believable staging),
REF-13 (truthful expressive type). The packet must list exactly which lessons were used and that no class reference existed.

## Three concept directions to generate (one render each in 1080×1350 and 1080×1080, plus a CALIBRATION EXTREME of the strongest)

| Concept | What it shows | What it tests |
|---|---|---|
| **A — "Your things, your auction"** | A small, believable cluster (5–7) of ordinary sellable items on the white stage — for instance a lamp, a bicycle, a toolbox, a dining chair, a guitar, a box of collectibles — staged with the 3M.3 spatial rules (grounded, one anchor, one foreground object). Primary message "It's built to be easy." Support line naming the action (create your own online auction on Advantage.Bid). One help line. Navy band. | Whether the scene principles transfer to non-lot, everyday merchandise without reading as an auction announcement |
| **B — "You can do this" (product-forward)** | One real screenshot of the create-auction screen on a device, beside two or three real representative items, light ground. Primary message "You can do this." Support line about listing in minutes only if the product fact supports it. Help line. Band. | Whether the engine can lead with the product truthfully and keep the copy restrained |
| **C — "Help is here" (human-forward)** | The help promise as the primary message, with the merchandise cluster secondary; if a consented team photograph exists in production it may be used, else the help element is copy and the real contact fact. | Whether accessibility can be communicated without stock people or slogans |

Copy the engine may draw on (facts only, phrasing is the engine's): the two philosophy lines; that sellers create their own auction; that
help is available (whatever channel production actually offers). Nothing about fees, reach, results or speed unless a production fact
supports it (A2 claim manifest).

## Audit, QA, score

Family audit profile for acquisition: text budget, no lot claims, representative flag present, protected-region check not applicable,
thumbnail legibility, brand frame at spec. Gates G10–G12 apply (seller-mark leak must be clean of every seller in the library). The
calibration score runs with the global profile; the judge is told the class is acquisition so "merchandise-forward" is read as
"representative items present and grounded", not "auction lots".

## Success criteria

| Question | Evidence in the packet |
|---|---|
| Does it still look like the Owner's taste? | Hierarchy clarity, light ground, restrained copy, grounded staging, confident type (judge items 1–8) |
| Did it transfer rather than imitate? | Zero class references; similarity to every library reference below τ_ref; no estate-sale vocabulary or logistics devices |
| Is it honest? | Representative flag on every asset; no lot claims; screenshot provenance; claim manifest passes |
| Is help visible where appropriate? | The help element is present in A/B/C, factual, and not a stock person |
| Would the Owner put one in the `individual-seller` folder? | His words, recorded through the feedback model. A "good" or "love this" seeds the empty class with an Advantage.Bid-provenance reference — the first calibration evidence for acquisition creative |

## What this test deliberately does not do

It does not run the acquisition ad anywhere, does not choose an audience, and does not measure performance. Those are separate,
Owner-authorized steps that come after the Owner has said the creative is right.
