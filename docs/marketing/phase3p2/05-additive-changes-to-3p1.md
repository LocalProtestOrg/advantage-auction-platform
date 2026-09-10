# 5 — Audit of Phase 3P.1 Against the New Evidence: Additive Changes Only

**Phase 3P.2 · 2026-09-11**

Phase 3P.1 is not rewritten. Everything it got right stays: the feedback record model, the authentic-media hierarchy, video-frame
selection, the 54-class taxonomy and relationship rules, the physical audit and scene planner, coverage bands, prominence measurement,
event-type roles, capitalization, and the scorer/judge v2 design. The table lists only what the new Owner evidence requires to be
layered on.

| Area | 3P.1 as designed | Change required | Type |
|---|---|---|---|
| Logo source | prominence measured; renderers drew the logo | Logo stage: reserve box → select registered variant → composite actual asset → alteration + rendered-logo checks (`logo-asset-system.json`) | **add** |
| Logo size band (Advantage.Bid-led) | 30–40% of width | 30–50% | widen |
| Gold Standard retrieval | designed in 3P (always included; ACCEPT bar 75); no Golds existed | now live for individual_seller_acquisition (4) and buyer_platform_growth (2); the extractor must emit ranges and the structure list, never a mean layout (`variation-requirements.json`) | activate + guard |
| Campaign classes | 3 empty acquisition classes → LOW confidence / Owner review | individual seller, buyer growth, professional seller now populated; closing_soon and general_brand remain empty and keep the review hold | update |
| Class separation | classes as retrieval keys | buyer vs seller language rule; REF-17's buyer copy in the seller Gold folder recorded as an open question, not a precedent (`campaign-messages.json`) | add |
| Text-budget profiles | GENERAL 5 / LOGISTICS 7 / TEASER 3 | FEED_FAST 5 (default for feed/mobile/awareness), ACQUISITION_RICH 9 (ceiling with conditions), EVENT 7, NOTABLE_LOT 7, RESTRAINED_FACTUAL 4 (`copy-density.json`) | extend |
| Colour | brand frame: white/very_light ground, navy band, red accent | light-foundation floor; red budget and roles; logo-blue secondary accent; dark demoted to an exception (`color-system.json`) | extend |
| SINGLE_LOT ground | dark_hero permitted for the family | light default; dark_hero needs a recorded reason + Owner review | change (Owner evidence) |
| Words on merchandise | none (3M) | one scene-integrated script accent allowed in Advantage.Bid-led generic creative; never a claim; never on real lots | loosen (Owner evidence) |
| Icon/benefit rows | none (3M "no icon piles") | 3–4 rows allowed inside ACQUISITION_RICH slots only | loosen (Owner evidence) |
| Representative people | forbidden (my 3P.1 safeguard) | allowed in generic acquisition/brand creative with disclosure; never a testimonial; never in event creative; a new likeness each time | loosen (Owner evidence) |
| Capitalization | title style for headlines | title style default; uppercase display permitted as a deliberate short-headline choice; support lines never uppercase | add exception |
| Notable Lot | SINGLE_LOT family; facts from production | full factual contract; training-example flag; fact-source table; light ground (`notable-lot-contract.json`) | add |
| Media hierarchy | tiers 1–6 | catalogue/lot photography named as a source; generated merchandise confined to generic classes; "masquerade" judge question (`authentic-media-alignment.json`) | clarify |
| Slogans | not modelled | seller/buyer slogans as separate text elements; never inside the asset; a third slogan variant rejected (`campaign-messages.json`) | add |
| Variation | anti-similarity + structure rotation not modelled | structure vocabulary, rotation across consecutive creatives, prop-checklist ban, template-echo flag (`variation-requirements.json`) | add |
| Sidecar schema | 1.0 | 1.1 additive: `text_classification`, `logo_treatment_in_reference`, `owner_gold_reason`, `filename_signal`, `training_example`, `content_reads_as`; `HERO_SINGLE_LIGHT`; `ACQUISITION`/`RESTRAINED_FACTUAL` families | extend |
| Feedback ledger | CREATIVE_REVIEW / OWNER_RULE | + `LIBRARY_EXPANSION` action; six OWNER_RULE lines for the 3P.2 statements | extend |
| Paid growth | out of scope | Director paid-growth authority, measurement chain, readiness audit (`06-paid-growth-and-measurement-readiness.md`) | add |

Nothing in the physical intelligence, scene planning, coverage fit, prominence measurement or event-type hierarchy changes. The six
2026-09-09 renders remain regression anchors with the outcomes 3P.1 specified.
