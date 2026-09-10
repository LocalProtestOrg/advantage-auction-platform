# 8 — VS Code Handoff (additive to the Phase 3P.1 contract)

**Phase 3P.2 · 2026-09-11 · Layer these changes onto the 3P.1 implementation contract (`phase3p1/11-vscode-handoff.md`). Nothing in 3P.1 is withdrawn. No production code was written here. Nothing published, activated or spent.**

> REFERENCE IMAGE ≠ TEMPLATE · GOLD STANDARD ≠ COPY THIS IMAGE · GOLD STANDARD = STRONG OWNER EVIDENCE ABOUT ATTRIBUTES

## 0. Files delivered

```
docs/marketing/phase3p2/
  00-README.md … 09-report.md
  config/logo-asset-system.json            registered asset hashes, variant selection, compositing stage, QA
  config/color-system.json                 light foundation / navy authority / red attention / logo-blue secondary / dark exception
  config/copy-density.json                 FEED_FAST · ACQUISITION_RICH · EVENT · NOTABLE_LOT · RESTRAINED_FACTUAL
  config/campaign-messages.json            approved / campaign-specific / philosophy / not-approved / reference-only rules
  config/notable-lot-contract.json         factual contract; training-example handling
  config/variation-requirements.json       structures, rotation, prop-checklist ban, template-echo
  config/authentic-media-alignment.json    clarifications to the 3P.1 hierarchy
  config/paid-growth-policy.json           Director authority, proposal shape, signal states, checkpoints, Owner report
  config/measurement-readiness-audit.json  18 items to verify in production
docs/marketing/approved-creative-examples/
  reference.schema.json                    v1.1 (additive; 1.0 sidecars remain valid)
  <10 new sidecars beside the new images>  REF-14 … REF-23
  index.phase3p2-preview.json              preview over all 23 (the indexer's reindex supersedes it)
  OWNER-CREATIVE-REFERENCE-INDEX.md        human index, 3P.2 state (regenerated on reindex)
  owner-decisions.jsonl                    + 7 lines: LIBRARY_EXPANSION, six OWNER_RULE
```

## 1. Authoritative logo asset consumption

- `brandAssets.js`: load `logo-asset-system.json`; verify each registered file's SHA-256 at boot; refuse any file not in the registry.
- Brief: `brand_frame.logo` becomes `{variant: primary_horizontal|primary_transparent|white_horizontal|ab_icon, box: {x,y,w,h}, clear_space_px}`; the family engines reserve the box before generation and mask it to the ground colour after.
- Remove every code path where a renderer draws a logo (the 3P proving-ground renderers drew the lockup in type — delete that; the footer band wordmark text stays as a brand-frame text element, not a logo).

## 2. Logo compositing stage

`logoStage.js` runs after layout and before QA: measure luminance/busyness under the box → select variant per config rules → composite
with uniform scale and position only → write `logo_composite {variant, sha256, box, scale}` to the result. The AB icon is refused for
advertisement placements (re-layout instead).

## 3. Logo QA (additive to 3P.1 prominence)

- `logo_source`: template match of the registered asset in the box ≥ 0.97; OCR reads ADVANTAGE.BID (+ GET THE ADVANTAGE for full variants); extra text in the box → fail.
- `rendered_logo_elsewhere`: OCR/template search across the canvas for logo-like marks or ADVANTAGE.BID strings outside the box → fail (regenerate with blank object surfaces).
- Width band for Advantage.Bid-led lockups: 30–50% (was 30–40%).
- The OCR engine and logo templates named BUILD BLOCKER in 3P.1 are now doubly required.

## 4. New campaign-class retrieval and Gold weighting

- Reindex the library (the ten new images have sidecars; the indexer must accept schema 1.1 and the new enum values `HERO_SINGLE_LIGHT`, `ACQUISITION`, `RESTRAINED_FACTUAL`; apply the `LIBRARY_EXPANSION` and `OWNER_RULE` ledger lines once).
- Gold weighting is live: individual_seller_acquisition (REF-14–17) and buyer_platform_growth (REF-18/19) — weight 2.0, always included, ACCEPT bar 75. professional_seller_acquisition has approved (1.0) references with `filename_signal` "gold-standard" — do NOT auto-promote; expose the pending promotion in the admin queue for one Owner click/word.
- Seller-identity stripping: Advantage.Bid's own references are exempt from stripping (they are the brand) but not from anti-copy (G11) or the prop-checklist ban.
- The principle extractor gains a `structures_seen[]` output and emits attribute RANGES only; it must never emit a mean layout, a prop list, or a logo-style lesson (lint the emitted calibration block for the collaborator prop names and for "logo" style words).
- Empty classes remain `closing_soon`, `general_brand` → LOW confidence + Owner review unchanged.

## 5. Campaign-class separation and messages

`campaign-messages.json` is the only source of approved copy: `approved_messages` (global by scope), `approved_campaign_specific_messages`
(bound to a class), philosophy lines, not-approved list, and the reference-only rule. The copy engine may draw a headline only from the
class's approved list or generate a new one that passes the copy-density and claim rules; the not-approved list is a hard block; every
claim goes through A2. Buyer creative may not use seller language and vice versa (lexicon lists in the config). REF-17 is retrieved for
imagery treatment only until the Owner answers the open question (§10).

## 6. Copy-density constraints

Replace the 3P.1 profile set with `copy-density.json` (FEED_FAST default for feed/mobile/awareness; ACQUISITION_RICH ceiling with its
conditions; EVENT; NOTABLE_LOT; RESTRAINED_FACTUAL). Hard fails: blocks over ceiling; two headline-class elements; benefit list inside a
headline. Judge v2 gains the readability question ("what is this ad asking me to do, in one sentence?" from headline + CTA alone). The
Director assigns surplus messages to waves.

## 7. Colour-preference handling

`color-system.json` → measurable checks: light-foundation luminance floors (hard), red element budget (hard: ≤ 3 above the band), red
share of saturated pixels band (soft), navy present in headline or band (soft), logo-blue permitted as secondary. SINGLE_LOT ground
default flips to light; `dark_hero` requires `reason` + Owner-review flag (brief validator). No red grounds or bands.

## 8. Notable Lot factual contract

`notable-lot-contract.json` → brief fields `lot_ref {auction_id, lot_id}`, `lot_facts` populated only from the lot record (verbatim
fields), `catalogue_count_live` with re-verification at publish, CTA destination from the event/lot record. A2 claim manifest extended:
every fact string in a notable-lot creative must resolve to a record field; the strings from REF-23 are on a permanent reject list.
`training_example: true` references are retrievable for structure only — the extractor strips every fact from their lessons.

## 9. Authentic-media hierarchy alignment

Unchanged pipeline plus: catalogue/lot photography registered as a source (tiers 3 and 5); `representative_not_lots` assets refused in
any class that represents a real event or item; judge question "does this look like real items from a specific sale?" → for generic
classes a "yes" fails; geographic real events require WHEN and prefer their own photographs.

## 10. Variation requirements

`variation-requirements.json` → `structure` enum on the brief (LEFT_COPY, CENTERED, RIGHT_COPY, TOP_COPY_BOTTOM_SCENE,
ENVIRONMENTAL_FULL_BLEED, HERO_OBJECT); rotation rule across consecutive creatives per objective; prop-checklist ban and
`template_echo` gate (≥ 3 collaborator props together → regenerate); G11 unchanged with Golds included in the reference distance set.

## 11. Regression tests using the newly approved references

1. All 23 sidecars validate under schema 1.1; the ten new ones carry `text_classification`; REF-23 has `training_example: true`.
2. Retrieval for individual_seller_acquisition returns REF-14–17 with weight 2.0 and `structures_seen` = {LEFT_COPY room, LEFT_COPY person landscape, LEFT_COPY exterior}; ACCEPT bar 75.
3. Retrieval for professional_seller_acquisition returns REF-20/21 at 1.0; `pending_promotion` flag present; nothing auto-promoted.
4. Extractor output for any class contains none of: "bronze horse", "blue-and-white", "category spine", "laptop", "mug", "chalkboard", any logo-style phrase, any hex/px/font (3P lint extended).
5. Scoring REF-14…REF-23 as candidates: G11 hard-fails each (a reference is never a candidate); `logo_source` fails each (rendered logos); `template_echo` flags REF-14/15/18–22.
6. A notable-lot brief containing "Lot 7" or "April 2" without matching record fields → A2 rejection.
7. A brief with `dark_hero` and no reason → validator rejection; with reason → Owner-review flag set.
8. A buyer-growth brief with seller lexicon ("sell", "list your items") → copy rule rejection; a seller brief with "The Smarter Way to Shop." → rejection.
9. A render with an ADVANTAGE.BID string on a laptop screen → `rendered_logo_elsewhere` fail; the same render with the string removed → pass.
10. Copy density: a 6-block FEED_FAST candidate fails; a 9-block ACQUISITION_RICH candidate with two headline-class elements fails; the same with one headline at 2.2× passes.
11. Colour: a candidate with a red band fails; one with four red elements above the band fails; copy-zone luminance 0.65 fails; 0.75 passes.
12. Assisted-service copy: any percentage or fixed price in an acquisition brief → claim rejection; the approved availability line passes.
13. The six 2026-09-09 renders keep their 3P.1 expected outcomes; B1/B2/B3 fixtures unchanged.

## 12. PAID GROWTH MEASUREMENT READINESS

**No paid campaign is fully ready merely because Meta or Google can accept an advertisement. Readiness = the Marketing Director can
measure the campaign's downstream Advantage.Bid outcomes and learn from them.**

- Perform the production audit in `measurement-readiness-audit.json`: for each of the eighteen items report VERIFIED / PARTIAL /
  MISSING with evidence (file, route, event name, diagnostics screenshot). Do not assume any item is present because behavioural
  intelligence (migration 146 social intelligence, `marketing_performance_facts`) exists — those measure organic posts and package
  fulfilment, not ad-click attribution.
- Implement whatever is MISSING from the minimum sets before any activation proposal can carry `measurement_ready: true`:
  first-party session attribution with click-id and UTM persistence; identity stitching at registration; the behavioural event
  catalogue including `auction_draft_created`, `auction_published`, `seller_inquiry`, `assisted_service_inquiry`, `watch_lot`, `bid`,
  `purchase`, `email_signup`; shared conversion definitions; consent gating for pixel, CAPI and first-party tracking; cost ingestion
  from Meta Ads and Google Ads; provider reconciliation against first-party outcomes; marketplace outcome attribution with the existing
  DELIVERED / MEASURED / INFLUENCED / ATTRIBUTION_UNAVAILABLE classes; suppression and retargeting audiences under consent; Director facts.
- Director: `paidGrowthDirector.js` implementing `paid-growth-policy.json` — proposal objects in the ten-field shape; ceiling and window
  caps; the six signal states with the thresholds and anti-overreaction rules; continuous checkpoints; bounded actions (PAUSE_LOSER,
  SHIFT_BUDGET, TEST_ALTERNATIVE, SCALE_WINNER, STOP, PROPOSE); every action logged with the state and evidence that triggered it.
- Owner report generator: weekly digest, state-change digest, monthly summary in the config's shape; confidential package economics
  structurally excluded (the report reads only the paid-growth ledger and first-party facts, never the package ledger).
- Assisted service: `assisted_service_availability` per market as platform config (Houston Metro, NYC Tri-State); `assisted_service_inquiry`
  event and destination; claim manifest permanently rejects any commission percentage or fixed price in creative or landing copy.
- Tests: proposal without a MISSING-free measurement set cannot activate; spend cap enforcement; LOSER cannot be called before 100
  sessions / $150; WINNER requires two checkpoints; report never contains package-economics fields (negative test on the generator's data
  sources); assisted pricing strings rejected.
- Activation stays an Owner decision (readiness ACTIVE per channel). Until the audit's minimum set is VERIFIED, the Director's
  recommended spend is zero and its proposals say "measurement not ready".

## 13. Dependency classes

| Item | Class |
|---|---|
| Logo registry + stage + QA; schema 1.1 + reindex; Gold retrieval; copy-density, colour, notable-lot, variation gates; message rules; tests 1–13 | BUILD BLOCKER for 3P.2 certification |
| OCR engine + logo templates | BUILD BLOCKER (carried from 3P.1) |
| Measurement readiness audit + missing instrumentation + Director + report | BUILD BLOCKER for any paid activation; not for creative certification |
| Real events/lots in Houston/NYC for proving grounds D/E | OWNER-PROVIDER DEPENDENCY (deferred honestly if absent) |
| Channel activation, spend | Owner-controlled; OFF |

## 14. Certification questions

Official asset composited, never rendered — every render passes `logo_source`? · Nothing published, activated or spent? · No fictional
notable-lot fact reachable by production? · No commission percentage anywhere in creative, landing or report copy? · Golds never closer
than τ_ref to any candidate? · Owner never edits a file? · Package economics absent from the Owner paid-growth report? · 3P/3P.1
regression anchors unchanged?
