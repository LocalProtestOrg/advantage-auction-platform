# 3 — Official Logo Architecture

**Phase 3P.2 · 2026-09-11 · Authority: `brand-assets/logos/README.md` (Owner) · Contract: `config/logo-asset-system.json`**

## The rule, exactly as the Owner set it

The creative generator never redraws, regenerates, approximates, typesets, hallucinates or reconstructs the Advantage.Bid logo when a
logo treatment is required. The system may choose which approved variant is appropriate for the placement and background; it may not
redesign the logo. Production sequence: composition → merchandise/environment → typography → layout → **choose approved variant →
composite the actual asset** → prominence/legibility QA → alteration check.

## The registry

Four approved files with their SHA-256 registered in the contract: primary horizontal (white rectangle, preferred for light/neutral
placements), primary transparent (for compositing over approved backgrounds), white horizontal (navy band, dark photographic areas,
dark panels — never on light grounds), and the AB icon (avatars, compact and square placements — never a substitute for the full logo
where there is room). A file that appears in the folder later is not authoritative until the Owner identifies it and it is added to the
registry. The full lockups carry the tagline GET THE ADVANTAGE; campaign slogans are separate text and are never baked into the asset.

## How 3P.1's prominence architecture consumes the assets

3P.1 measured prominence (feed proxy, size bands, clear space, contrast, zone, co-brand weight ratio) but had nothing to say about where
the pixels came from — the proving-ground renderers drew the logo themselves. 3P.2 inserts a **logo stage** between layout and QA:

1. **Reserve.** The layout reserves a logo box before generation — width per the prominence band (Advantage.Bid-led 30–50% of canvas
   width; co-brand relationship line per 3P.1), clear space ≥ 1× logo cap height. The generator is told the box is off-limits.
2. **Select.** Variant by background luminance and busyness measured under the box: light/neutral → transparent (or primary on pure
   white); dark or busy → white, with the layout supplying a quiet dark area (never by editing the logo); co-brand → transparent in the
   relationship line, white on the band. The AB icon never answers "not enough room" in an advertisement — the layout is re-planned.
3. **Composite.** Uniform scale and position only. No stretch, skew, rotation, crop, recolour, opacity, added shadow/outline, tagline
   change or slogan insertion.
4. **QA.** Template match of the registered asset inside the box ≥ 0.97; OCR of the box reads ADVANTAGE.BID (and GET THE ADVANTAGE for
   the full variants); the 3P.1 feed-proxy recognition test; and a **rendered-logo detector** over the rest of the canvas — a logo-like
   mark or an "ADVANTAGE.BID" string on a laptop screen, mug or box outside the box fails (the references do this constantly; production
   may not). Failure → regenerate with the box enlarged or relocated; the headline is never shrunk first.

## What the references teach about the logo — and what they do not

Every one of the ten new references carries an image-model rendering of the logo; REF-14 typesets a serif "Advantage.Bid™"; REF-21 draws
the seller slogan where the asset's tagline belongs; five render the logo again on a laptop screen. The sidecars record this under
`logo_treatment_in_reference`, and the principle extractor is barred from emitting any "logo style" lesson. The only logo lessons the
library may teach are **placement zone** (top-left or centered top; occasionally the band) and **prominence** (near half the width in
the Owner's own creative).

## Additive change to 3P.1

`prominence-rules.json` `advantage_bid_led.logo_lockup_width_pct_of_canvas` widens from [30, 40] to [30, 50]; a new
`logo_source` check (`asset_sha256`, `template_match`, `rendered_logo_elsewhere`) joins the QA list. Nothing else in the prominence
model changes.
