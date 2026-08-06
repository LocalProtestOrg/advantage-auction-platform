# Phase 5E — Lawful Event Source Discovery Program

**Date:** 2026-08-06
**Type:** Research / audit / recommendation. **No implementation, no deployment.**
**Builds on:** Phase 5D audit (EstateSales.NET/.org/.com + BidSquare rejected for autonomous scraping).

## Executive summary

The goal is **lawful, repeatable event supply**, not "more sites to scrape." The research below
ranks ~50 candidate sources into four tiers. Three conclusions drive the recommendation:

1. **The cleanest, highest-volume lawful bulk source is U.S. government surplus** — federal data is
   CC0/public-domain and **GSA Auctions publishes an official JSON/XML API**. State/municipal open
   data adds more where it exists.
2. **The most *strategic* and infinitely-scalable source is the host companies themselves** —
   auction houses and estate-sale companies publishing to Advantage.Bid **directly** or via their own
   **RSS / iCal / JSON-LD** feeds with consent. This is ToS-clean (their data, their permission),
   SEO/AI-friendly, and matches the canonical architecture.
3. **The large commercial aggregators are partnership/license plays, never DIY scraping.** The
   industry already syndicates via APIs (Invaluable Catalog Upload API, LiveAuctioneers↔eBay), so the
   lawful route to their volume is a data agreement, not a crawler.

**Recommended architecture:** a layered ingestion stack — *member publishing → member feed sync →
public-domain government APIs → partner/licensed APIs → JSON-LD discovery of consenting hosts* — with
a per-source **authorization record** (public-domain / license / partner-agreement / member-consent)
required before any connector is activated.

### Legal grounding used throughout
- **U.S. federal works are not copyrightable and are CC0-dedicated** (Open Government Data Act 2018;
  api.data.gov is CC0). Federal auction/surplus data is lawfully reusable with attribution-optional.
- **robots.txt ≠ permission.** Every source is judged on ToS + published API policy, not robots alone.
- **Consent beats crawling.** A host's own feed offered for syndication carries explicit permission.

Evidence legend: **V** = verified this session (robots.txt/ToS/API doc read or authoritative search);
**K** = established industry knowledge, **confirm before build**.

---

## Tier 1 — Ready to pursue immediately (lawful now; no third-party permission needed)

These are public-domain government APIs/feeds, or the platform's own consent-based mechanisms.

| # | Source | Type | Discovery | ToS permits automated? | API | Feed | Vol | Coverage | Freshness | Difficulty | Strategic value | Why |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **GSA Auctions** (gsaauctions.gov) | Federal surplus | **JSON + XML API** (data.gov, api.data.gov key) **V** | **YES** (CC0/public domain) | ✅ | ✅ | High (nationwide federal assets: vehicles, equipment, machinery, vessels) | US-wide | Continuous | Easy | ★★★★★ | Official documented public API; lawful, structured, high volume. **Build first.** |
| 2 | **GSA Fleet Vehicle Sales** (autoauctions.gsa.gov / GSAFleet) | Federal vehicle auctions | HTML + gov data **K** | YES (public domain) | partial | ? | Medium-High (vehicles) | US-wide | Weekly+ | Medium | ★★★★☆ | Federal vehicle auctions; pairs with #1. Confirm feed/endpoint. |
| 3 | **IRS Seized Property Auctions** (irsauctions.treasury.gov) | Federal seized-asset | HTML public notices **K** | YES (public domain) | ❌ | ❌ | Low-Medium | US-wide | Irregular | Medium | ★★★☆☆ | Public government notices; lawful. Lower volume, HTML parsing. |
| 4 | **U.S. Treasury / Marshals forfeited-asset notices** (usmarshals.gov/assets) | Federal seized-asset | Public notices (auctions run via Bid4Assets) **V** | YES for the *notices* (public domain) | ❌ | ❌ | Low-Medium | US-wide | Irregular | Medium | ★★★☆☆ | The government notice is public; the auction *platform* (Bid4Assets) is separate (Tier 2). |
| 5 | **State surplus programs (own-hosted)** (e.g., TX Facilities Commission, CA DGS, etc.) | State surplus | HTML / open data **K** | YES where state-hosted public | varies | varies | Medium (per state) | Per-state | Weekly | Medium | ★★★★☆ | Public-agency data; many states self-host surplus listings. Build per-state as capacity allows. |
| 6 | **University surplus (public universities)** | Institutional surplus | HTML / RSS / open data **K** | YES where public-university self-hosted | rare | some RSS | Medium | Per-campus | Weekly | Medium | ★★★☆☆ | Public universities' own surplus pages are public records; some emit RSS. |
| 7 | **Municipal/County open-data portals** (Socrata / ArcGIS Hub) | Gov open data | **Socrata SODA API / ArcGIS REST / RSS** **V** | YES (open licenses) | ✅ (where present) | ✅ | Low-Medium (varies wildly) | Per-jurisdiction | Varies | Medium | ★★★☆☆ | Some portals publish surplus/auction/public-notice datasets with open APIs. Coverage patchy. |
| 8 | **Advantage.Bid Direct Member Publishing** (existing) | First-party | Native create flow | **YES (first-party)** | ✅ (internal) | n/a | Grows with members | US-wide | Real-time | Very Easy | ★★★★★ | Zero legal risk, canonical source of truth. The **foundation** of the whole strategy. |
| 9 | **Member RSS sync (opt-in)** — e.g., WordPress *The Events Calendar* RSS | First-party-by-consent | **RSS/XML** **V** | **YES (member consent)** | n/a | ✅ | Grows with members | US-wide | Per member's schedule | Easy | ★★★★★ | Member's *own* event feed, offered for syndication. Autonomous + ToS-clean. |
| 10 | **Member iCal sync (opt-in)** — Events Manager / Google Calendar / .ics | First-party-by-consent | **iCal (.ics)** **V** | **YES (member consent)** | n/a | ✅ | Grows with members | US-wide | Per member | Easy | ★★★★★ | Universal calendar standard; trivial to parse; explicit consent. |
| 11 | **Member JSON-LD sync (opt-in)** — schema.org `Event`/`SaleEvent` on host site | First-party-by-consent | **JSON-LD** **V** | **YES (member consent)** | n/a | ✅ | Grows with members | US-wide | Per member | Easy | ★★★★★ | Reads the host's own structured markup; SEO/AI-native both directions. |
| 12 | **Member CSV/API push (opt-in)** — first-party upload endpoint | First-party-by-consent | CSV / REST / webhook | **YES (first-party)** | ✅ (to build) | n/a | Grows with members | US-wide | Real-time | Easy | ★★★★☆ | Mirrors how houses already push to Invaluable/LiveAuctioneers — but to us. |

---

## Tier 2 — Requires partnership or license (real volume; pursue via BD/data agreements)

Commercial platforms and vendors with large, current inventories. **Automated access requires a
signed partnership/data license** — none permit DIY scraping (Phase 5D pattern holds). The prize is a
*feed/API by agreement*, which then becomes an easy connector.

| # | Source | Type | Discovery (if licensed) | ToS status | Vol | Coverage | Strategic value | Why partner |
|---|---|---|---|---|---|---|---|---|
| 13 | **HiBid / AuctionFlex** | Auction software + portal | Partner feed / API **K** | PARTNERSHIP REQUIRED | Very High | US/CA | ★★★★★ | Market-leading auction software; a vendor deal syndicates *thousands* of auctioneers at once. Highest-leverage partnership. |
| 14 | **Proxibid** | Auction marketplace | Partner API **K** | PARTNERSHIP REQUIRED | High | US | ★★★★☆ | Large live/timed inventory; industrial/collectible. |
| 15 | **LiveAuctioneers** | Auction marketplace | Partner API (already syndicates to eBay) **V** | PARTNERSHIP REQUIRED | Very High | US/intl | ★★★★☆ | Proven syndication model; fine art/antiques/collectibles. |
| 16 | **Invaluable / AuctionZip** | Auction marketplace | **Catalog Upload API** (inbound) **V** | PARTNERSHIP REQUIRED | Very High | US/intl | ★★★★☆ | Runs an API for houses to push lots; a reverse/partner feed is plausible. |
| 17 | **GovDeals (Liquidity Services)** | Gov/commercial surplus | Internal JSON endpoint; official = partner **V** | LICENSE/PARTNERSHIP REQUIRED | Very High (25k+ active) | US-wide | ★★★★★ | The dominant municipal/agency surplus channel. Data license = huge lawful gov volume. |
| 18 | **Public Surplus** | Gov surplus platform | Partner/export **K** | PARTNERSHIP REQUIRED | High | US-wide | ★★★★☆ | Government sellers; complements GovDeals. |
| 19 | **Municibid** | Gov/school surplus | Partner/export **K** | PARTNERSHIP REQUIRED | Medium-High | US-wide | ★★★☆☆ | Municipal & school district surplus. |
| 20 | **Bid4Assets** | Tax/foreclosure/USMS auctions | Partner feed **V** | PARTNERSHIP REQUIRED | High | US-wide | ★★★★☆ | Sheriff/tax-sale + USMS forfeiture auctions; underlying notices are public but the platform is commercial. |
| 21 | **RealAuction / GovEase** | Tax lien/deed auctions | Partner feed **K** | PARTNERSHIP REQUIRED | High | US-wide | ★★★☆☆ | County tax-lien/foreclosure auctions. |
| 22 | **Ritchie Bros / IronPlanet (rbauction)** | Industrial/equipment | Partner API **K** | PARTNERSHIP REQUIRED | Very High | US/intl | ★★★★☆ | Heavy equipment; global; strong data. |
| 23 | **Sandhills: AuctionTime / TractorHouse / EquipmentFacts** | Equipment auctions | Partner feed **K** | PARTNERSHIP REQUIRED | High | US | ★★★☆☆ | Farm/construction equipment auctions. |
| 24 | **MaxSold** | Estate/downsizing auctions | Partner API **K** | PARTNERSHIP REQUIRED | High | US/CA | ★★★★☆ | Directly on-theme (estate liquidation, timed online). Great fit for a data deal. |
| 25 | **AuctionNinja** | Estate/consignment auctions | Partner feed **K** | PARTNERSHIP REQUIRED | Medium | US | ★★★☆☆ | Estate-sale-adjacent online auctions. |
| 26 | **eBay (auction listings)** | General marketplace | **Official Browse/Buy API** (developer program) **K** | LICENSE (API terms) | Very High | US/intl | ★★★☆☆ | Legit developer API, but noisy for our niche; useful for specific categories. |
| 27 | **Copart / IAA** | Salvage vehicle auctions | Partner/dealer API **K** | PARTNERSHIP (often dealer-gated) | Very High | US | ★★☆☆☆ | Vehicle salvage; access often restricted to licensed dealers. |
| 28 | **Manheim / ADESA (Openlane)** | Wholesale vehicle auctions | Partner API **K** | PARTNERSHIP (dealer-gated) | Very High | US | ★★☆☆☆ | Dealer-only wholesale; limited public relevance. |
| 29 | **Charity auction platforms** (OneCause, Handbid, GalaBid, BiddingForGood) | Nonprofit auctions | Partner API/feed **K** | PARTNERSHIP REQUIRED | Medium | US | ★★★☆☆ | Charity/gala auctions; goodwill-friendly partners. |
| 30 | **Auction software vendors** (Wavebid, Bidwrangler, AuctionMethod, RezVault, GavelData) | Software syndication | Partner feed **K** | PARTNERSHIP REQUIRED | High (aggregate) | US | ★★★★☆ | Like HiBid: each vendor deal syndicates many auctioneers. Pursue the vendors, not the sites. |

---

## Tier 3 — Interesting future opportunities (strategic, longer horizon)

| # | Source | Type | Why it's future, not now |
|---|---|---|---|
| 31 | **National Auction Association (NAA)** | Industry association | Endorsement/partnership drives member auction houses to publish to us; not a data feed itself. |
| 32 | **American Society of Estate Liquidators (ASEL)** | Estate-sale association | Directory + credibility for estate-sale-company onboarding. |
| 33 | **State/regional auctioneer associations** | Associations | Local member-acquisition channels. |
| 34 | **JSON-LD discovery crawler (consenting hosts only)** | Structured-data discovery | Once a host opts in, crawl their schema.org `Event` markup at scale. Powerful, but only for consented domains. |
| 35 | **Museum deaccession programs** | Institutional | Deaccessions typically flow through auction houses (captured via #13–16); direct museum feeds are rare. |
| 36 | **Farm/estate auction networks** (regional) | Rural auctions | High-volume in agricultural regions; often on HiBid/Proxibid already. |
| 37 | **Restaurant/commercial liquidation firms** | Commercial liquidation | On-theme; usually small firms — best via member publishing (#8–11). |
| 38 | **Commercial real-estate liquidation** (Ten-X, RealINSIGHT) | CRE auctions | Partner APIs; niche but high-value lots. |
| 39 | **Bankruptcy trustee / §363 sale notices** | Legal notices | Public (PACER/court notices) but unstructured; consider a licensed legal-notice feed. |
| 40 | **Public-notice networks** (state press assoc. publicnoticeads.com) | Legal notices | Sheriff/foreclosure/estate notices; often licensed datasets. |
| 41 | **UCC foreclosure notices** | Legal notices | Public but state-by-state, unstructured; licensed aggregator preferable. |
| 42 | **Sheriff's sale listings (county, where lawful)** | Gov notices | Public records; fragmented; some via RealAuction/Bid4Assets (#20–21). |
| 43 | **County/city event calendars (iCal/RSS)** | Gov calendars | Occasionally list public auctions; low signal-to-noise; opportunistic. |
| 44 | **Licensed commercial events datasets** (e.g., events aggregators) | Licensed data | Buy a redistribution license for auction/estate categories if volume justifies. |
| 45 | **Open Data portals — state (data.ca.gov, michigan.data.socrata.com, etc.)** | Gov open data | Public-licensed; surplus datasets where published. |

---

## Tier 4 — Not recommended (do not build autonomous connectors)

| # | Source | Reason |
|---|---|---|
| 46 | **EstateSales.NET** | ToS §16.6 bars spiders/robots/agents harvesting; no reuse/DB-compile (Phase 5D). |
| 47 | **EstateSales.org** | ToS §4.1 bars scraping; liquidated damages $0.25/page + $3,000/day aggregation (Phase 5D). |
| 48 | **EstateSale.com** | Active Imperva/Incapsula anti-bot; ToS bars scraping — retrieval = defeating access control (Phase 5D). |
| 49 | **BidSquare** | Personal/non-commercial view-only license; bars systematic downloading (Phase 5D). |
| 50 | **Craigslist / Facebook Marketplace & Events** | ToS prohibit automated access; active anti-bot; hostile to redistribution. |

> Note: the Tier 4 sources may still become lawful via **partnership/license** (they'd move to
> Tier 2). What's ruled out is *unlicensed autonomous scraping*.

---

## Detailed attribute notes for the anchor sources

**GSA Auctions (Tier 1 #1)** — *Documentation:* data.gov dataset "GSA Auctions API"; GitHub
`GSA/auctions_api`; docs at gsa.github.io/auctions_api. *robots:* n/a (API). *ToS:* CC0 / public
domain; api.data.gov key + rate limits. *API:* GET, JSON **and** XML. *Volume:* thousands of active
lots. *Coverage:* nationwide. *Freshness:* continuous. *Images:* asset photos referenced in listings.
*Attribution:* selling federal agency (a public organization — no individual-privacy issue).
*Host link-back:* GSA Auctions lot page. *Verifiability:* high (government). *Difficulty:* Easy.
*Recommendation:* **Build the first `api` connector here.**

**Member feed sync (Tier 1 #9–11)** — *Discovery:* the member's own RSS (The Events Calendar exposes
an RSS feed), iCal (Events Manager exposes `.ics`), or schema.org `Event`/`SaleEvent` JSON-LD.
*ToS:* member consent recorded at onboarding — explicit permission, no third-party exposure.
*Attribution:* the member **is** the verified host. *Images:* provided by the host for their own
listings. *Verifiability:* the member is already identity-verified on-platform. *Recommendation:*
**Build the `feed`/`ical`/`jsonld` connector family here** — this is the scalable, trust-aligned core.

**GovDeals / Public Surplus / Municibid (Tier 2 #17–19)** — dominant government-surplus channels
(GovDeals alone: 25k+ active lots). *ToS:* commercial platforms; DIY scraping not permitted (third-
party scrapers on Apify confirm the restriction). *Path:* a data-license/partnership yields a lawful
feed and enormous public-sector volume. *Recommendation:* prioritize a GovDeals/Liquidity Services
conversation — highest lawful-volume partnership.

**HiBid/AuctionFlex + auction software vendors (Tier 2 #13, #30)** — the single highest-leverage
partnerships: one vendor agreement syndicates the events of *all* auctioneers on that platform, each
already the verified host. *Recommendation:* pursue vendor partnerships over marketplace scraping.

---

## Recommended long-term ingestion architecture

A **layered, lawful-first ingestion stack**, each layer a connector type behind one engine (the
existing dedupe / publication-gate / privacy / monitoring pipeline stays authoritative):

1. **Layer 0 — First-party publishing (foundation).** Direct member creation (built). Zero risk,
   canonical, real-time. Everything else supplements this.
2. **Layer 1 — Member feed sync (opt-in).** `rss` / `ical` / `jsonld` connectors that pull a member's
   *own* published feed with recorded consent. Autonomous, ToS-clean, SEO/AI-native. **Primary growth
   engine.**
3. **Layer 2 — Public-domain government APIs.** `api` connector to GSA Auctions first, then state/
   municipal open-data (Socrata/ArcGIS) and other federal surplus. Lawful bulk volume, no permission.
4. **Layer 3 — Partner & licensed feeds.** `api`/`feed` connectors activated as BD lands agreements
   (HiBid/AuctionFlex, GovDeals/Liquidity, Proxibid, LiveAuctioneers, Invaluable, MaxSold, Ritchie
   Bros, Public Surplus, Municibid, eBay). Each is an easy connector once the data path is licensed.
5. **Layer 4 — JSON-LD discovery at scale (future).** A crawler that reads schema.org `Event` markup
   **only from opted-in/consented domains** — extends Layer 1 without per-member feed setup.
6. **Cross-cutting — Industry partnerships.** NAA/ASEL/state associations to accelerate Layer 1
   member adoption and unlock Layer 3 vendor deals.

**Compliance gate (new source-model requirement):** every source carries an **authorization record**
with a `basis ∈ {public_domain, license, partner_agreement, member_consent, first_party}` plus
evidence (doc URL / signed agreement id / consent timestamp). **No connector activates without one.**
This makes lawfulness a structural property of the system, not a per-build judgment call, and gives
the owner an auditable trail — directly serving the "**most trusted** marketplace" positioning.

**Why this is the right strategy**
- **Scalable:** members + vendor partnerships compound; government APIs add lawful bulk.
- **Lawful:** every layer is permissioned by construction (first-party, consent, public-domain, or
  license); no unlicensed scraping ever ships.
- **SEO/AI-friendly:** JSON-LD in and out; every published event already gets crawlable HTML,
  canonical URL, OG, Event JSON-LD (built in prior phases). Ingesting structured data and re-emitting
  it makes Advantage.Bid a first-class citizen of the schema.org/AI-discovery ecosystem.
- **Trust-aligned:** verified hosts, no competitor branding, privacy-safe organizer attribution, and
  a visible lawful-sourcing posture — the foundation of "America's most trusted auction and
  estate-sale marketplace."

## Immediate next steps (when the owner is ready — no build performed here)
1. **Approve GSA Auctions** as the first Layer-2 connector (public-domain, documented API).
2. **Approve the member feed-sync connector family** (Layer 1: rss/ical/jsonld) — the scalable core.
3. **Open partnership conversations**, priority order: HiBid/AuctionFlex → GovDeals/Liquidity →
   MaxSold → Proxibid/LiveAuctioneers/Invaluable → Public Surplus/Municibid.
4. On approval, engineering builds the connector framework + the two approved connectors (GSA + member
   feeds) with the full test suite, dry-run, and the authorization-record gate.
