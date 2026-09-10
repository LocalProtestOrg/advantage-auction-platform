# 1 — New Owner Material: Inventory

**Phase 3P.2 · 2026-09-11 · Everything below was determined by opening the files; nothing from filenames alone.**

## What changed on disk since Phase 3P.1 was committed

| Where | Found | Added after 3P.1? |
|---|---|---|
| `approved-creative-examples/individual-seller/gold-standard/` | 4 PNGs (all distinct by hash) | yes |
| `approved-creative-examples/buyer-growth/gold-standard/` | 2 PNGs | yes |
| `approved-creative-examples/professional-seller/` | 2 PNGs (filenames contain "gold-standard"; placed in the plain folder) | yes |
| `approved-creative-examples/geographic-event/` | 1 PNG (plus the 3P Labor Day reference) | yes |
| `approved-creative-examples/notable-lot/` | 1 PNG (plus the two 3P references) | yes |
| `brand-assets/logos/` | 4 PNGs + README.md | yes (icon file carries an older timestamp; the README and three lockups are new) |
| `approved-creative-examples/owner-decisions.jsonl` | 8 lines — the 3P baseline + the seven 3P.1 records; **no new Owner ledger entries** | no |
| `approved-creative-examples/index.json`, `OWNER-CREATIVE-REFERENCE-INDEX.md` | still the 13-reference build of 2026-09-09; **the indexer has not run** since the new files arrived; none of the ten new images has a sidecar | stale |
| `phase3p1/` | unchanged since delivery | no |
| `Claude outputs/` | the two phase ZIPs and handoffs the Owner copied there | no |

Ten new creative images. All are Advantage.Bid-led, 1254×1254 except one landscape (1374×1145), image-model-assisted, made by the Owner and his creative collaborator. Two are the same concept in two treatments (REF-14/REF-15). None has a sidecar; all are now recorded (REF-14…REF-23).

## Status as placed by the Owner

| Ref | File | Folder | Status | Note |
|---|---|---|---|---|
| REF-14 | individual-seller/gold-standard/…turn-items-into-cash-gold-standard.png.png | gold-standard | **OWNER_GOLD_STANDARD** | "Have Items to Sell? / Turn Your Items Into Cash." — typeset serif wordmark, navy/red |
| REF-15 | individual-seller/gold-standard/…turn-items-into-cash-gold-standard.png | gold-standard | **OWNER_GOLD_STANDARD** | same concept; logo lockup; uppercase headline; logo-blue accent |
| REF-16 | individual-seller/gold-standard/…turn-items-into-opportunity-gold-standard.png | gold-standard | **OWNER_GOLD_STANDARD** | "Sell With Confidence"; representative person at a laptop; landscape |
| REF-17 | individual-seller/gold-standard/…outreach-turn-your-estate-items-into-cash-at-auction.png | gold-standard | **OWNER_GOLD_STANDARD** | "Estate Sale / Online Auction" with buyer-facing copy — see open question |
| REF-18 | buyer-growth/gold-standard/buyer-outreach-gold-standard.png | gold-standard | **OWNER_GOLD_STANDARD** | "Amazing Finds Delivered to Your Inbox." + email signup |
| REF-19 | buyer-growth/gold-standard/buyer-outreach-email-sign-up-gold-standard.png | gold-standard | **OWNER_GOLD_STANDARD** | "Bid Today. Discover Tomorrow." + Join for Free (filenames of 18/19 appear swapped relative to content) |
| REF-20 | professional-seller/sell-with-advantage-bid-gold-standard.png | plain | OWNER_APPROVED | centered "Sell More With Advantage.Bid" |
| REF-21 | professional-seller/become-a-seller-advantage-bid-gold-standard.png | plain | OWNER_APPROVED | "From Inventory to Results." serif, left copy |
| REF-22 | geographic-event/geogrpahical-event-for-Katy-TX.png | plain | OWNER_APPROVED | Katy, TX estate sale / online auction with the water tower |
| REF-23 | notable-lot/notable-lot-advantage-bid.png | plain | OWNER_APPROVED · **training example** | "Notable Lot — Lot 7 — 19th Century Bronze Horse — Estate Auction April 2" (fictional facts); the light version the Owner preferred |

Rule applied: the library convention (README) makes a `gold-standard/` sub-folder Gold and a plain class folder Approved. REF-20/21 carry "gold-standard" in their filenames but sit in the plain folder; the 3P.2 brief says the Owner "approved multiple Professional Seller examples". They are recorded as OWNER_APPROVED with `filename_signal` noted — promotion is one Owner word ("yes, gold") or a folder move away. Nothing else was promoted by inference.

## Campaign classes now represented

| Class | Before 3P.2 | Now (primary) | Gold |
|---|---|---|---|
| estate_sale | 2 (L&M) | 2 | — |
| auction | 8 (L&M) | 8 | — |
| professional_seller_acquisition | **empty** | 2 | — (filename-signalled) |
| individual_seller_acquisition | **empty** | 4 | 4 |
| buyer_platform_growth | **empty** | 2 | 2 |
| notable_lot | 2 (L&M) | 3 | — |
| closing_soon | **empty** | **empty** | — |
| geographic_event_promotion | 1 (L&M holiday) | 2 | — |
| general_brand | secondary only | secondary only | — |

Still lacking a primary Owner example: **closing_soon** and **general_brand**. Both stay "Owner review required" as in 3P.

## The official logo system (inventory)

| File | Pixels | Alpha | Contents |
|---|---|---|---|
| advantage-bid-primary.png | 1983×793 | no (white rectangle) | gavel + ADVANTAGE.BID (navy/blue) + GET THE ADVANTAGE |
| advantage-bid-transparent.png | 1983×793 | yes | same lockup, transparent |
| advantage-bid-white.png | 1983×793 | yes | white lockup for navy/dark |
| advantage-bid-icon-primary.png | 1254×1254 | no (white rounded square) | gavel + AB mark |

Sampled colours: wordmark navy ≈ #001025, "BID" blue ≈ #0252ba. README rules preserved in `config/logo-asset-system.json` (with the four files' SHA-256 registered).

## What every new reference has in common (and why that matters)

All ten share one collaborator template: logo top-left (REF-20 centered), "SELL • SHOP • DISCOVER" top-right, a left copy column with headline → support → 3–4 icon rows → CTA, a navy band with three icon items and a "You Can Do This." script, a footer tagline strip, one handwritten script phrase inside the scene, and a recurring prop set (bronze rearing horse in 9 of 10, blue-and-white vase in 8, category-spine books in 8, a laptop showing the logo in 5, a script mug/board/box in 8). Every logo inside them is an image-model rendering, not the official asset.

That is exactly the situation the Owner warned about in section 13: a library that could be averaged into one template. The sidecars therefore carry the shared devices under `do_not_generalize`, the props are banned as a checklist (`variation-requirements.json`), and the logo lesson is limited to placement and prominence (`logo-asset-system.json`).
