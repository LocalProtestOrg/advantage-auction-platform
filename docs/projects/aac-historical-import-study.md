# AAC Historical Auction Import Study (Phase 1 — Discovery)

**Status:** RESEARCH ONLY. No code, no DB changes, no deployment. Staging-only if/when approved.
**Date:** 2026-06-18
**Constraint (owner):** Assume we do NOT have AAC's old auction software, exports, or original image library. **LiveAuctioneers (LA) is the only currently available source** of historical AAC data.

---

## 0. TL;DR / recommendation up front

- The public LA catalog pages **do** contain rich, extractable AAC auction + lot metadata and images, and the data maps cleanly to our `auctions` / `lots` / `lot_images` tables.
- **However, automated scraping of LiveAuctioneers is prohibited by their Terms** ("you will not use any robot, spider, scraper… without express written permission"; content is "proprietary or… licensed to LiveAuctioneers"). Realized prices are gated ("See Sold Price"), and bid counts are not published.
- **Recommended path is NOT public scraping.** The lawful way to use "LiveAuctioneers as the source" is **AAC's own authenticated LA seller account**, which retains AAC's historical catalogs, the images AAC uploaded, and the sold results — i.e., AAC accessing **its own data** through the platform, ideally via LA's seller export or with LA's written permission. That is self-access, not third-party scraping.
- For **images**: do not copy or hotlink LA-CDN images programmatically. Compliant options, in order of preference: (a) AAC-owned originals retrieved from AAC's LA seller account; (b) **metadata-only import using our existing SVG category tiles** as placeholders, with an **attribution link back** to the original LA catalog, until AAC-owned images are recovered.
- **Realized prices**: import only if obtained through AAC's own seller results (they are LA's gated product on public pages), and still apply our existing #20.1 privacy gate.

---

## 1. What data is publicly available from each catalog?

Probed the first catalog (`121461_fine-crystal-and-gem-auction-5-start-price`) live. Publicly rendered:
- **Auction metadata:** title ("Fine Crystal and Gem Auction $5 Start Price"), auction house ("Advantage Auction Company"), location ("Houston, TX, United States"), date ("2018-05-25"), total lot count (~231 across paginated catalog), and an auction description.
- **Lot-level:** lot number + title (e.g., `0001: 6.73 CT Russian Alexandrite Gemstone`), low/high **estimates** ("Est. $25 - $125"), and per-lot descriptions on the item pages.
- **Images:** present for lots, served from LA's CDN (`p1.liveauctioneers.com/<houseId>/<catalogId>/<imageId>_x.jpg`).
- **Realized prices:** **gated** — shown as "See Sold Price" (requires LA login/membership) or "Lot Passed" for unsold. Not cleanly public.
- **Bid counts:** **not displayed** in catalog or item view.

The 8 catalogs are all AAC sales (Houston TX, 2018-era), themes: fine crystal/gems, semi-precious gems, fine art & collectibles, fine art & furniture, fine collectibles estate, Steiff/Gund collectibles, no-reserve jewelry, designer accents/art/furniture.

## 2. Can auction metadata be extracted? 
**Yes (technically).** Title, house, date, location, description, lot count all render in the page DOM / Next.js data. *(Caveat: ToS — see §10.)*

## 3. Can lot-level data be extracted?
**Yes (technically).** Lot number, title, estimates, and description are present per lot/item page (paginated, ~24 lots/page).

## 4. Can images be extracted?
**Technically yes** (LA-CDN URLs are in the markup), **but this is the highest-risk item.** The images are hosted/served by LA and are subject to LA's ToS and third-party/consignor rights. Copying or hotlinking them programmatically is not advisable (see §10 and §"Image strategy").

## 5. Can realized prices be extracted?
**Not from public pages.** They are gated behind "See Sold Price" (LA login/membership) — LA treats prices-realized as a proprietary/licensed product (they even sell a "Prices Realized" data offering). Public extraction would be both technically gated and a ToS/data-rights violation. AAC's **own** sold results are available inside AAC's LA seller account.

## 6. Can bid counts be extracted?
**No.** Bid counts are not published on LA catalog/item pages. (Our `lots.bid_count` would have to be left null/omitted or sourced from AAC's own seller records if those expose it.)

## 7. Are there anti-scraping barriers?
- **ToS prohibition** on robots/spiders/scrapers without written permission (the primary barrier — see §10).
- **robots.txt:** `/catalog/` and `/item/` are not explicitly disallowed, but the data APIs **`/item-api/` and `/mainhost-api/` are Disallowed**, and a 10s crawl-delay is set for some agents. LA states the sites "contain robot exclusion headers."
- **Bot management:** LA is a large commercial marketplace that uses bot-mitigation (rate limiting / challenge on sustained automated traffic). A single fetch succeeded; bulk automated extraction across ~1,500+ lot pages would predictably trip mitigation.
- A single React/Next.js app — lot detail and prices load via internal APIs (the disallowed `*-api` paths), so deep extraction would mean hitting disallowed endpoints.

## 8. Are there API endpoints exposed?
Internal endpoints exist (`/item-api/`, `/mainhost-api/`, an Algolia-style search backend) but they are **robots-disallowed** and not a sanctioned public API. There is **no official public read API** for third parties to pull catalog data. (Third-party scrapers exist on Apify, but using them would violate LA ToS.)

## 9. Field mapping into Advantage.Bid tables

| LA source field | Advantage.Bid target | Notes |
|---|---|---|
| Catalog title | `auctions.title` | clean |
| Auction house ("Advantage Auction Company") | `auctions.seller_id` → a dedicated "Advantage Auction Company (Historical)" seller_profile | clean |
| Auction date | `auctions.end_time` (+ `start_time`) | clean; sets it as a past/closed auction |
| Location (Houston, TX) | `auctions.city` / `address_state` | clean |
| Catalog description | `auctions.description` | clean |
| Lot number | `lots.lot_number` | clean |
| Lot title | `lots.title` | clean |
| Lot description | `lots.description` | clean |
| Low/high estimate | (no exact column) → `lots.starting_bid_cents` could take the low estimate, or store estimates in description | partial |
| Category | `lots.category` | derive from theme/keywords; not a clean LA field |
| size/pickup category | `lots.size_category`/`pickup_category` (A/B/C) | must be inferred (default by category) |
| Realized/sold price | `lots.winning_amount_cents` (+ `current_bid_cents`) | **gated**; only via AAC seller results; still privacy-gated by #20.1 |
| Bid count | `lots.bid_count` | **unavailable** from LA public data |
| Lot image | `lots.thumbnail_url` + `lot_images` | **rights-restricted** (see image strategy) |
| State | `lots.state='closed'`, `auctions.state='closed'`, `is_archived=false` | per our Past Auctions model |

Mapping is clean for factual metadata; the three problem fields are **images (rights), realized prices (gated), bid counts (absent)**.

## 10. Legal / terms considerations

- **LA Terms & Conditions** (liveauctioneers.com/termsandconditions) prohibit automated access: *"you will not use any robot, spider, scraper, or other automated means to access the Sites for any purpose without our express written permission,"* and state much site content is *"proprietary or… licensed to LiveAuctioneers by users or third parties,"* with rights to take "technical and legal steps" against misuse. The sites carry robot-exclusion headers.
- **Realized prices** are part of LA's commercial data product; extracting them from gated pages is both a technical-bypass and data-rights problem.
- **Images** displayed on LA are subject to LA's license terms and consignor/photographer rights. Even though AAC originally supplied catalog photos for its own sales, **retrieving them by scraping LA's CDN is still governed by LA's ToS**, and republishing them on Advantage.Bid raises a licensing question that should go to counsel.
- **Ownership nuance (in AAC's favor):** the **factual catalog content of AAC's own sales** (auction title, date, lot titles, descriptions, estimates) is AAC's own business record; AAC accessing it through **its own LA seller account** is materially different from third-party scraping of LA's public site. The clean, low-risk route leans on that distinction.
- Third-party scraping tools (Apify, etc.) exist but their use would violate LA ToS; not recommended.
- **[COUNSEL REVIEW REQUIRED]** before any production use of LA-sourced images or realized prices.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ToS violation from scraping LA public pages | **High** | Don't scrape; use AAC's own LA seller-account export / written permission |
| Image copyright / LA license on reused images | **High** | Don't copy/hotlink LA images; use AAC-owned originals, link-back, or SVG tiles until recovered |
| Realized prices are LA-proprietary + gated | **High** | Only import via AAC seller results; keep #20.1 privacy gate |
| Bot mitigation blocks bulk extraction | Medium | Avoid bulk automation; manual/permitted export |
| Mislabeled/low-quality metadata (categories, sizes) | Medium | Inference + manual review; mark clearly as historical |
| Misrepresentation if demo + historical mixed unclearly | Medium | Clear "Historical AAC Results" labeling + attribution |

---

## Recommended approach (given "LA is the only source")

**Do not build a public-page scraper.** Instead, in priority order:

1. **AAC's own LiveAuctioneers seller account (preferred, lawful).** AAC ran these 8 auctions on LA, so AAC's seller dashboard retains the catalogs, the images AAC uploaded, and the sold results. Obtain a **seller export** (LA provides sellers their catalog/results data) or **written permission** from LA to pull AAC's own historical data. This satisfies "LA is the source" while being self-access, not scraping — and recovers AAC-owned images + realized prices legitimately.
2. **If no export is obtainable: metadata-only historical import.** Transcribe/enter the factual fields AAC authored (title, date, lot titles, estimates, descriptions) — small enough to do manually or via a one-time, permitted pull — and **omit LA images and gated realized prices**. Render lots with our **existing SVG category tiles** as placeholders, plus an **attribution link back to the original LA catalog** ("Originally sold via LiveAuctioneers — view catalog"). Backfill AAC-owned images later when recovered.
3. **Images compliance ladder:** (a) AAC-owned originals from the seller account → embed; (b) else **link back** to the LA catalog/lot (attribution, no copying); (c) else **SVG category tiles** (current behavior) until originals are recovered. Do **not** copy or hotlink LA-CDN image files programmatically, and do **not** use LA thumbnails as our own without confirmed rights.
4. **Realized prices:** import only from AAC's own seller results; continue to gate them via #20.1 (anonymous hidden, logged-in visible). If unavailable, omit price and show estimates only.

## Estimated effort

- **Path 1 (seller export):** mostly non-engineering — obtain export/permission from LA (days–weeks, external). Engineering: a one-off staging importer that reads the export file → ~1–2 days.
- **Path 2 (metadata-only):** data entry/transcription of ~8 catalogs (~1,500+ lots total — estimate below) is the bulk of effort; a staging importer reading a structured CSV/JSON we compile → ~1–2 days engineering + significant data-entry time (or a one-time permitted parse).
- Either path reuses the existing `auctions`/`lots`/`lot_images` schema, the Past Auctions surface, the SVG-tile fallback, and the #20.1 privacy gate — **no migrations, no new architecture.**

## Import architecture (proposed, when approved — staging only)

1. **Input = a structured file we control** (CSV/JSON) — produced from AAC's seller export (Path 1) or compiled transcription (Path 2). The importer does **not** fetch LA at runtime.
2. **Seller:** one dedicated `seller_profiles` row, e.g. "Advantage Auction Company (Historical)" (clearly historical), reused across all 8.
3. **`scripts/stg-import-aac-historical-auction.js`** (Phase 2): staging-guarded, idempotent (fixed UUID namespace per catalog), creates `auctions` (state=`closed`, `is_archived=false`) + `lots` (state=`closed`, `winning_buyer_user_id=NULL`, no payments/invoices/registrations, bidding impossible) + `lot_images` only when AAC-owned images are present (else tile + optional link-back).
4. **Attribution:** store the original LA catalog URL on the auction (e.g., in description or a field) and surface "Originally sold via LiveAuctioneers" with a link.
5. **Privacy/bidding:** realized prices gated by #20.1; closed lots reject bids (existing 422 path). No homepage/replacement changes in the POC.

---

## Sources
- [LiveAuctioneers Terms & Conditions](https://www.liveauctioneers.com/termsandconditions)
- [ATG / LiveAuctioneers Privacy Policy](https://www.liveauctioneers.com/privacy)
- [LiveAuctioneers robots.txt](https://www.liveauctioneers.com/robots.txt)
- Probed catalog: [Fine Crystal and Gem Auction $5 Start Price (AAC, 2018)](https://www.liveauctioneers.com/catalog/121461_fine-crystal-and-gem-auction-5-start-price/)
- Third-party scrapers exist but violate ToS (not recommended): [Apify LiveAuctioneers scrapers](https://apify.com/ivanvs/liveauctioneers-scraper)
