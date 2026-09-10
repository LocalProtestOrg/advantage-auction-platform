# 4 — Notable Lot Contract and Authentic-Media Implications

**Phase 3P.2 · 2026-09-11 · Configs: `notable-lot-contract.json`, `authentic-media-alignment.json`**

## Notable Lot, clarified (I)

A Notable Lot advertisement is **one real item inside one real auction/event, used as a discovery hook for the larger catalog**. It is
not a general auction advertisement with luxurious imagery. The item gets visual dominance (≥ 45% of the merchandise field); the event
stays clearly identified (type, name/date at EVENT-profile prominence); the CTA leads to the real catalog or lot page.

The structure the engine may learn from REF-23: a "Notable Lot" label → lot number and item name → event type and date → catalogue size
(if true) → CTA → band; light ground; the lot's own photograph as the hero. The fact ladder is the lesson.

The facts in REF-23 — Lot 7, 19th Century Bronze Horse, Estate Auction April 2, Over 250 Lots — are **fictional**. They are recorded as
`FICTIONAL_TRAINING_FACT_NEVER_PRODUCTION` in the sidecar, `training_example: true` on the record, and the claim manifest rejects
each string. Production facts come only from the lot record (number, title, and attribution/material/age/provenance fields verbatim
where they exist) and the event record (name, type, date); the catalogue count is read live at generation and re-verified at publish;
estimates are never shown unless a production estimate field exists and the Owner has enabled it. Nothing is inferred from the
photograph — a bronze-looking horse is not "bronze" unless the lot record says so.

The hero image is the lot's own CLEAN photograph — either composed as a single object on the light stage (tier 5 with one object) or
used as a photographic hero with its own background when the photograph is strong (tier 3 for a lot). Representative objects never
appear in a notable-lot creative.

Ground: light by default. The Owner rejected the dark Bronze Horse treatment and preferred the light recreation, which retires the 3P.1
allowance of a dark SINGLE_LOT ground as a family default. Dark is now a documented exception for a lit, translucent or reflective
object with a recorded reason and Owner review on first uses.

"The Smarter Way to Bid." under the logo in REF-23 is not an approved slogan; the buyer slogan is "The Smarter Way to Shop."

## Authentic media (J)

The 3P.1 hierarchy is preserved without change: cover image → walkthrough-video frame → one strong environmental photograph → several →
editorial object composition → restrained factual creative; provenance-bound; composed seller graphics routed to the anchor role; the
first frame never chosen by position; corrections limited to crop, straighten, exposure and white balance.

Three clarifications the new material makes necessary:

1. **Catalogue/lot photography is an explicit source.** A strong lot photograph may anchor a notable-lot creative or supplement an
   environmental photograph. It joins tiers 3 and 5 as a named input.
2. **Generated and representative merchandise is confined to generic classes** — generic buyer acquisition, generic seller acquisition,
   conceptual brand creative, and any class that represents no real event or item. Every such asset carries `representative_not_lots`;
   the render carries the disclosure line; and the judge is asked whether the creative looks like it is showing real items from a
   specific sale — for a generic creative, "yes" fails. Nothing generated may masquerade as inventory.
3. **Geographic event creative for a real event uses the event's photographs.** REF-22's water tower and staged lawn are a generic
   promotion pattern (WHAT loudest, WHERE as an eyebrow plus a landmark cue). For a real Katy sale the Director walks the media ladder,
   uses the seller's photographs when they are ready, and adds WHEN — which REF-22 lacks and a real event may not.

The Owner's sentence from 3P.1 still governs: a real photograph taken by a person is more convincing than unnecessary synthetic
composition. The ten new references are synthetic by design because they represent no event; that is their proper use.
