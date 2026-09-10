# 2 — Durable Owner Preferences Added (and what they change)

**Phase 3P.2 · 2026-09-11 · Configs: `color-system.json`, `copy-density.json`, `campaign-messages.json`, `variation-requirements.json`**

## New durable preferences (E)

| # | Preference | Source | Recorded in |
|---|---|---|---|
| E1 | Light/white backgrounds are the normal advertising environment; warm interiors and soft photographic grounds are fine when the creative stays bright and readable | Owner statement; the dark Notable Lot rejected, light preferred | color-system.json `light_foundation`; SINGLE_LOT ground default changed to light |
| E2 | Red is the attention colour — CTAs, underlines, event-type emphasis, key words; selective, never flooding | Owner statement; 6/8 new Advantage.Bid-led references use a red CTA, all use a red rule or swash | color-system.json `red_attention` (budget ≤ 3 red elements above the band) |
| E3 | Formula preference: light foundation + navy authority + red attention + merchandise colour; do not over-constrain to navy-only | Owner statement | color-system.json `formula`, `roles` |
| E4 | Logo-derived blue is acceptable as a secondary accent (three approved references use it); red stays the attention colour | REF-15/16/17 Gold + Owner's earlier "no app blue as primary" | color-system.json `logo_blue_secondary` (bounded default) |
| E5 | Fast comprehension: one primary idea, one strong headline, short support, one CTA; extra information must earn its space; spread messages across waves | Owner statement (wordy buyer creative rejected) | copy-density.json `FEED_FAST` default for feed/mobile/awareness |
| E6 | Acquisition creative may be rich (up to 9 structured blocks) when one headline dominates and merchandise holds ≥ 45% | REF-14/15/18–21 Gold/approved are 8–9 blocks | copy-density.json `ACQUISITION_RICH` (a ceiling, not a target) |
| E7 | Seller acquisition can be visually rich, merchandise-led, approachable and aspirational without looking like software advertising | REF-14/15 Gold; Owner brief §3 | sidecar lessons; variation-requirements |
| E8 | A product screen may appear as ONE supporting prop in a scene, never as the hero | REF-19 Gold vs 3P.1 IS-B rejection | copy/variation configs; scorer rule kept |
| E9 | A representative person may appear in GENERIC acquisition/brand creative when disclosed as representative and never presented as a specific customer or testimonial | REF-16 Gold (this loosens a safeguard I wrote in 3P.1, which was not an Owner rule) | sidecar REF-16; authentic-media-alignment |
| E10 | Compositional variety is wanted: centered, asymmetric, environmental and merchandise-led structures are all valid; do not average Golds into one template | Owner brief §8, §13; REF-20 centered vs REF-21 left | variation-requirements.json |
| E11 | Seller slogan "The Smarter Way to Sell."; buyer slogan "The Smarter Way to Shop."; slogans are separate text, never baked into the logo | logo README | campaign-messages.json; logo-asset-system `slogans` |
| E12 | "Have Items to Sell?" / "Turn Your Items Into Cash." are the approved individual-seller acquisition concept | Owner brief §3; REF-14/15 | campaign-messages `approved_campaign_specific_messages` |
| E13 | Event-type headline for generic estate creative: "Estate Sale" + "Online Auction" stacked | REF-17/22 | prominence rules (3P.1) confirmed; TYPE_LED pattern |
| E14 | Geographic creative: WHAT loudest, WHERE twice (eyebrow + landmark/environment), WHEN mandatory for a real event | Owner brief §9; REF-22 | authentic-media-alignment; copy-density EVENT |
| E15 | Notable Lot = one real item in one real event as the hook to the larger catalog; facts only from production; the Bronze Horse is training only | Owner brief §10; REF-23 | notable-lot-contract.json |
| E16 | Uppercase display headlines are acceptable as a deliberate design choice for short punchy headlines; title style stays the default; support lines never uppercase | REF-15/17/18/19/20/22 use uppercase headlines; logo README: "unless a specific approved design calls for it" | capitalization rule note (additive to 3P.1) |
| E17 | One handwritten script accent phrase inside the scene is acceptable in Advantage.Bid-led creative; it carries no claim and is reference-only text | 9/10 new references | copy-density ACQUISITION_RICH conditions |

## Where the new evidence bends an earlier rule (recorded, not hidden)

| Earlier rule | New evidence | Resolution |
|---|---|---|
| 3M: "no words printed onto merchandise" | Golds carry a script phrase on a box, mug or chalkboard | One scene-integrated script accent allowed in Advantage.Bid-led generic creative; never on real lots in event creative; never a claim |
| 3M: "no piles of category labels / icon piles" | Golds carry 3–4 benefit/category icon rows | Allowed inside ACQUISITION_RICH slots only; FEED_FAST has none |
| 3P.1: "no stock people, no generated faces" (my safeguard) | REF-16 Gold has a representative person | Loosened per E9 with disclosure and no-testimonial conditions; never in event creative |
| 3P.1: SINGLE_LOT may use a dark hero ground | Owner rejected the dark Notable Lot | Light default; dark only for a lit/translucent object with a recorded reason and Owner review |
| 3P.1: logo lockup 30–40% of width | new references sit near 50% | Band widened to 30–50% |
| 3M: "no app blue as primary brand blue" | REF-15/16/17 use logo blue as the accent | Blue = secondary accent from the logo; red remains attention; navy remains authority |
| 3P.1 capitalization: title style for headlines | six new references use uppercase display headlines | Title style default; uppercase permitted as a deliberate short-headline choice (E16) |

## Copy-density changes (G)

`copy-density.json` replaces the single 3P.1 text-budget profile set with five: FEED_FAST (5, the feed/mobile/awareness default and the Owner's stated preference), ACQUISITION_RICH (9, a ceiling with conditions), EVENT (7, WHEN mandatory), NOTABLE_LOT (7), RESTRAINED_FACTUAL (4). Hard fails: blocks over the ceiling, two headline-class elements, a benefit list inside a headline. The readability test at feed size: "what is this ad asking me to do, in one sentence?" must be answerable from headline + CTA alone. Extra messages go to LAUNCH / MID / FINAL waves.

## Colour-system changes (H)

`color-system.json`: light-foundation floor (canvas luminance ≥ 0.60 excluding the band; copy zone ≥ 0.72); navy as structure (headline, band, sub-type); red as attention with a budget (one headline word/line, the CTA, one rule/swash; icon discs as one group; red share of saturated pixels 35–65% in the copy zone, measured 50–60% across the new references); logo blue as a secondary accent; merchandise colour unchanged; dark treatments demoted to a documented exception. Sampled brand values from the official asset: navy #001025, blue #0252ba; band navy #182e45 and red #d62828 unchanged.

## Message rules

`campaign-messages.json` separates approved messages (slogans, "You Can Do This.", the event types), approved campaign-specific messages (the six headlines the Owner approved inside Golds, each bound to its class), Owner-authored philosophy lines, and reference-only text — with a claims list ("Get Top Dollar", "Low Seller Fees", "Join for Free", "Over 250 Lots", …) that goes through the A2 claim manifest or is omitted. "The Smarter Way to Bid." (REF-23) is not an approved slogan.
