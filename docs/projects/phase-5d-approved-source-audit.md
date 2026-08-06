# Phase 5D — Approved-Source Audit for Autonomous Event Discovery

**Date:** 2026-08-06
**Author:** Engineering (Claude)
**Status:** AUDIT COMPLETE — implementation gated on an owner licensing/permission decision.

## Purpose

Phase 5D asks the twice-weekly Railway worker to replace frozen CSV snapshots with **fresh
autonomous discovery**: on each run, visit approved event-discovery websites, retrieve current
upcoming events, normalize/dedupe/gate, and publish qualifying events — with no local machine, CSV
handoff, or per-run approval.

Per the phase's own instruction ("**APPROVED-SOURCE AUDIT FIRST … Return a source matrix before
coding any source that is legally or technically uncertain … Do not fabricate permission … public,
non-authenticated access only**"), this audit is the gate. No connector was built or deployed against
any source pending the decisions below.

## Method

- Fetched each domain's `robots.txt` directly (public, non-authenticated).
- Retrieved each site's Terms of Service / Terms & Conditions and quoted the automated-access,
  scraping, reproduction, and reuse clauses verbatim.
- Checked for any official public API, data feed, RSS, or partner/licensed export program.
- No login, access control, or anti-bot measure was bypassed or tested.

## Source matrix

| Source | robots.txt (UA `*`) | ToS on automated retrieval / reuse | Official API / feed | Anti-bot | Host company on detail page | Verdict |
|---|---|---|---|---|---|---|
| **EstateSales.NET** (Vintage Software, LLC) | Disallows `/account /homepages /v2 /v3 /legacy /api/user-view-details`; listing/detail pages not disallowed; sitemap present | **§16.6 expressly prohibits** using "any engine, software, tool, agent … (including … browsers, spiders, robots, avatars, or intelligent agents) to harvest or otherwise collect information from the Service" without **express written permission**; bans storing/copying/redistributing content and compiling a database | **None disclosed** | Not observed on robots fetch, but ToS is dispositive | Yes (company name shown) | **NOT APPROVED** — requires written permission |
| **EstateSales.org** | `robots.txt` 301-redirects | **§4.1 prohibits** "copy, collect, scrape, harvest, or download any content … via robots, spiders, scripts, scrapers, crawlers, or any automated or manual equivalent"; API access only "**unless expressly authorized**"; **≤1,000 pages/24h**; **liquidated damages $0.25/page (scraping), $3,000/day (aggregation)** | **None** (authorized API only) | — | Yes | **NOT APPROVED** — explicit damages clause; permission required |
| **EstateSale.com** | Served behind **Imperva/Incapsula** bot defense (the `robots.txt` request itself returns an Incapsula challenge + `noindex,nofollow`) | Prohibits "collection, aggregation, copying, scraping … data mining, robots, spiders" | **None** | **Yes — active WAF/anti-bot access control** | Yes (directory of ~14k companies) | **NOT APPROVED** — automated retrieval requires defeating an access control (prohibited) |
| **BidSquare** (Intl. Auction Partners, Inc.) | Disallows `/search`, `/user`, and query-param listing/pagination (`?category= ?page= ?search= ?filters= ?sort=`); blocks many SEO bots; sitemap present | Grants only a **"personal, non-commercial"** view license; prohibits creating "a database … by systematically … downloading, caching … storing the material (by spidering, scraping or otherwise)"; prohibits reproduction/public display/derivative works | **None** (Bidsquare **Cloud** is white-label auction SaaS, not a listings data feed) | — | Yes (member auction houses) | **NOT APPROVED** — personal/non-commercial view-only; partnership/data agreement required |

## Conclusion

**None of the four historically-discussed discovery sources permit automated retrieval or
republication under their current Terms.** Two carry explicit liquidated-damages clauses
(EstateSales.org) or express written-permission requirements (EstateSales.NET); one is protected by
active anti-bot access control (EstateSale.com/Incapsula); one licenses only personal, non-commercial
human viewing (BidSquare). **None offers a public API, RSS, or licensed data feed.**

Building and deploying an autonomous scraper against any of these would (a) breach the site's Terms,
(b) for EstateSale.com require defeating an access control, (c) risk contract/CFAA/copyright and the
stated liquidated damages, and (d) violate this phase's own constraints ("do not fabricate
permission," "public, non-authenticated access only," "do not defeat access controls"). It is
therefore **not implemented**. This is a **licensing/permission (business + legal) decision**, which
is a standing stop condition — it cannot be resolved by writing code.

## Paths forward (owner decision required)

1. **License a real feed / written permission (per-source).** Obtain express written permission or a
   data-license/API agreement from one or more of the above (EstateSales.NET and EstateSales.org both
   contemplate authorized access; BidSquare would need a partnership). Once a signed, permitted access
   path exists, engineering builds the matching connector (`api`/`feed`/`jsonld`) and activates it.

2. **Opt-in host-company discovery (recommended, ToS-clean, genuinely autonomous).** Discover events
   from the **actual host companies' own** websites/feeds — the auction houses and estate-sale
   companies that are (or become) Advantage.Bid professional members. A company supplies a feed URL
   (RSS / JSON-LD / iCal) or posts directly; we ingest **their own data with their consent**. This
   matches the platform's canonical architecture (Railway = source of truth; companies = the verified
   hosts) and the phase's own "attribute to the verified host company, keep discovery source internal"
   policy — here there is no third-party discovery source to keep internal. Fully autonomous once a
   company is onboarded, with no third-party ToS exposure.

3. **Licensed events aggregator.** Contract a provider that licenses event data for redistribution
   (e.g., a commercial events API). Engineering builds an `api` connector to it.

The connector **framework** (registry beyond `kind='csv'`, generic fetch layer with descriptive
User-Agent, rate limiting, timeout, retry/backoff, page/event caps, content-type + response-size
validation, parser-version logging, format-change detection, circuit breaker, fetch-fresh-each-run)
is ready to be built the moment one approved source/feed exists under option 1, 2, or 3 — it should be
built against a **confirmed-usable** source, not speculatively against a prohibited one.

## Current production state (unchanged by this audit)

- Twice-weekly worker remains scheduled Mon & Thu 03:00 ET on Railway (Phase 5C), enabled, with
  gated auto-publish and monitoring/alerts active.
- The three active sources remain the frozen `kind='csv'` EstateSales.NET snapshots — exhausted and
  mostly expired; each run correctly finds 0 new (all duplicates) and republishes nothing expired.
- No expired events are republished; the public feed and map continue to reflect only current active
  inventory.
