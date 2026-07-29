# Widget Visual QA Fixtures — 2026-07

**Purpose:** temporary, clearly-marked production records so the Product Owner can place the three
marketplace event-feed widgets (All Events / Auctions Only / Estate Sales Only) into Brilliant
Directories and evaluate the real card design and interaction against populated data.

**Status:** LIVE in production (created 2026-07-29). **Do not clean up until the owner approves the
visual design.**

- **Marker (every record):** `widget_visual_qa_2026_07`
  - Auctions → `auctions.admin_notes->>'qa_marker'` (jsonb)
  - Estate sales → `events.attribution_source` (text)
- **Every visible title begins with `TEST — `.**
- **Create script:** `scripts/qa/create-widget-qa-fixtures.js` (idempotent; refuses to double-insert)
- **Cleanup script:** `scripts/qa/cleanup-widget-qa-fixtures.js` (dry-run by default; `--apply` to delete)
- **Prod endpoint guard:** both scripts refuse to run unless `DATABASE_URL` host matches `proud-leaf`.

## Safety design (why these fixtures cannot cause harm)

- **No lots** on any auction → nothing is biddable; no bids, no cards charged, no invoices.
- **End dates 7–30 days out** → the close scheduler never fires during QA → no seller-closeout emails,
  no `seller_payouts`, no settlements, no pickup workflows.
- **Direct DB INSERT** (not the publish/enroll services) → no follower fan-out, no notifications/emails/SMS.
- **Private-seller auctions stay anonymous** to buyers (company shown as null) via the platform's
  server-side branding rule — no fake company is attributed to a private record.
- **No real private street address** is stored (city/state/zip only; venue is labeled "(test venue)").
- **No native BD records** created — Railway remains the single source of truth; BD only embeds the feed.
- **Images** use only the platform's own branded placeholder (`/img/social-card.png`); some records are
  intentionally left imageless to exercise the card fallback. No customer or copyrighted photos.

## Auctions (6) — feed preset `auctions`

| # | Record ID | Title | Location | Status | Start → End (UTC) | Image | Seller association |
|---|-----------|-------|----------|--------|-------------------|-------|--------------------|
| 1 | `b4da1d65-61bc-4270-aee5-e249b3698291` | TEST — Downtown Adrian Estate Auction | Adrian, MI 49221 | active (featured) | 07-28 → 08-07 | branded placeholder | Advantage Estate Services (business, **branded**) |
| 2 | `902524b3-8f8c-43ed-bca8-c5bba32f9690` | TEST — Tecumseh Furniture & Décor Auction | Tecumseh, MI 49286 | active | 07-28 → 08-10 | none (fallback) | private (**anonymized**) |
| 3 | `88e00d7c-b910-4973-ae74-78e083cc8b33` | TEST — Ann Arbor Collectibles Auction | Ann Arbor, MI 48104 | published | 08-01 → 08-16 | branded placeholder | Advantage Estate Services (business, **branded**) |
| 4 | `3bf41aae-cf46-4366-90f1-5d40f724c6dd` | TEST — Detroit Equipment & Tools Auction | Detroit, MI 48226 | active | 07-28 → 08-05 | branded placeholder | private (**anonymized**) |
| 5 | `6062b718-b298-4628-a816-e5895a19e82d` | TEST — Chicago Decorative Arts Auction | Chicago, IL 60601 | published | 08-03 → 08-23 | none (fallback) | Advantage Estate Services (business, **branded**) |
| 6 | `f9492083-88cd-46fc-9ab3-68115d8f9834` | TEST — Houston Home Furnishings & Fine Estate Liquidation Collection (long title) | Houston, TX 77002 | active (featured) | 07-28 → 08-28 | branded placeholder | Advantage Estate Services (business, **branded**) |

## Estate sales (6) — feed preset `estate-sales`

| # | Record ID | Slug | Title | Location | Status | Start → End (UTC) | Image | Org association |
|---|-----------|------|-------|----------|--------|-------------------|-------|-----------------|
| 7 | `1a3fd930-146f-48ff-ad77-94eef46ae314` | test-adrian-estate-sale-1a3fd930 | TEST — Adrian Whole-Home Estate Sale | Adrian, MI 49221 | published (featured) | 07-31 → 08-02 | branded placeholder | Advantage Auction Company |
| 8 | `6d683709-0e71-48a5-b0f7-650cff10ae31` | test-tecumseh-estate-sale-6d683709 | TEST — Tecumseh Downsizing Sale | Tecumseh, MI 49286 | published | 08-04 → 08-05 | none (fallback) | AAC |
| 9 | `8aaa5ce8-8702-45c5-94d8-3962cd1f8ae5` | test-ann-arbor-estate-sale-8aaa5ce8 | TEST — Ann Arbor Mid-Century Estate Sale | Ann Arbor, MI 48104 | published | 08-08 → 08-10 | branded placeholder | Advantage Auction Company |
| 10 | `93bdaea8-febf-4d29-93b7-086ce4dd6e40` | test-detroit-estate-sale-93bdaea8 | TEST — Detroit Historic Home Estate Sale of Fine Antiques, Collectibles & Household Goods (long title) | Detroit, MI 48226 | published | 08-12 → 08-14 | branded placeholder | AAC |
| 11 | `c4daa21b-c0e5-4690-bff4-2ed3d3eef9db` | test-chicago-estate-sale-c4daa21b | TEST — Chicago Collector's Estate Sale | Chicago, IL 60601 | published | 08-18 → 08-20 | none (fallback) | Advantage Auction Company |
| 12 | `feaf6c08-1319-4989-8503-9695975774ce` | test-houston-estate-sale-feaf6c08 | TEST — Houston Luxury Estate Sale | Houston, TX 77002 | published (featured) | 08-26 → 08-28 | branded placeholder | AAC |

## Verified live results (2026-07-29)

- **Preset counts:** all-events = **12** (both types, no dupes) · auctions = **6** (auctions only) ·
  estate-sales = **6** (estate sales only).
- **Radius near Adrian, MI (41.8975, -84.0372):** 25 mi = 4 · 50 mi = 6 · 100 mi = 8 · nationwide = 12.
- **Sort = nearest** orders ascending by distance (Adrian 0 mi → Tecumseh 9 mi → Ann Arbor 31 mi → …).
- **Privacy:** the two private-seller auctions (Tecumseh #2, Detroit #4) render with **no company**;
  business auctions show "Advantage Estate Services".
- **Geocode proxy:** "Adrian, MI", ZIP "49221", "Michigan", "Chicago", "Houston, TX" all resolve.

## Card-design variety exercised

- Short titles (#1, #7) and long wrapping titles (#6, #10).
- Both badge types (Auction vs Estate Sale) via the two presets.
- Business-branded records (#1, #3, #5, #6, #7–#12) and anonymous private records (#2, #4).
- Records **with** image (#1, #3, #4, #6, #7, #9, #10, #12) and **without** image → fallback (#2, #5, #8, #11).
- Featured flag set on #1, #6, #7, #12.
- Geographic spread: Adrian / Tecumseh / Ann Arbor / Detroit MI, Chicago IL, Houston TX for distance sort.
- **Not** demonstrated: the "Ending soon" (<24h) urgency state — that would require an imminent close,
  which would trip the very close workflows these fixtures are designed to avoid.

## Cleanup procedure (run ONLY after owner approves the design)

```bash
# 1. Dry run — lists exactly what will be deleted, deletes nothing:
node -r dotenv/config scripts/qa/cleanup-widget-qa-fixtures.js

# 2. Apply — deletes ONLY the 12 marked records (event_images → events → auctions):
node -r dotenv/config scripts/qa/cleanup-widget-qa-fixtures.js --apply
```

The cleanup script aborts and deletes nothing if any candidate lacks the exact marker or the `TEST — `
title prefix, and re-scopes every DELETE to both the explicit id list and the marker predicate.

## Direct widget links (for the owner)

- All Events: `https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events`
- Auctions Only: `https://bid.advantage.bid/widgets/marketplace-feed.html?preset=auctions`
- Estate Sales Only: `https://bid.advantage.bid/widgets/marketplace-feed.html?preset=estate-sales`

BD copy-paste embed blocks: `docs/projects/bd-event-feed-widgets-install.md`.
