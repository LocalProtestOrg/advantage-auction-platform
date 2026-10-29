# Lewis & Maese Import Restoration on Invaluable (plan)

Prepared 2026-10-29. Builds on Member Feed Sync (member-neutral, 2026-09-24) and the Marketing Director oversight (live 2026-10-29). No production change was made while preparing this plan.

## What was verified
- **The site.** LMAuctionCo.com is WordPress plus Invaluable's catalog integration (the "ConnectWP" widget). The retired connector's notes (2026-08-25) record it as served through Invaluable's CloudFront edge.
  - Upcoming auctions are at `/auctions/upcoming-auctions/`.
  - Catalogs are at `/auction-catalog/{slug}_{REF}`.
  - Estate sales are WordPress posts, for example `/exclusive-west-university-on-site-estate-sale-september-19-2026/`.
- **The block.** The edge firewall answers the importer's honest identity with HTTP 403 on every path, including `robots.txt`, the WordPress feed `/feed/` and the WordPress API `/wp-json/`. A normal browser gets HTTP 200, so this is a bot rule at the edge, not something a site admin setting controls.
- **Invaluable's own site.** invaluable.com sits behind AWS WAF too. A Lewis & Maese house page answered `202` with `x-amzn-waf-action: challenge`, a JavaScript challenge meant for browsers. Solving it automatically would be evading it, so it is not an option. Its `robots.txt` does not disallow auction-catalog or auction-house pages, but the challenge still applies.
- **No documented read feed or API.**
  - Invaluable's only documented API is the Catalog Upload API. It pushes lots INTO Invaluable, and is offered only through auction-management software partners.
  - Private Label plans list no RSS, iCal, export or embed feature.
  - The Gold plan does advertise control of schema.org structured data.
- **Consent.** Nothing is recorded for Lewis & Maese: no Member Feed Sync entry and no consent audit row. The organization (`77c403f5-0c8c-4a5e-824a-cf113beb5217`) has:
  - a BD-imported shell (2026-07-06)
  - professional provisioning (2026-08-05)
  - lifecycle state `claimed`, contact `tyler@lmauctionco.com`
  - no linked seller profile
  - one member-submitted event, rejected as past dated

  The retired connector's note "Owner explicitly authorized this source by name" was Advantage's own discovery authorization. It is not the member's feed consent, and it must not be backdated into one.

## Ranked options
1. **Recommended: Invaluable support allows Advantage.Bid's importer and confirms a structured source. Fully automatic.**
   - Invaluable adds a firewall exception for the importer on lmauctionco.com, and confirms what the pages publish:
     - schema.org Event JSON-LD, or
     - an iCal or JSON calendar of the house's upcoming sales.
   - With JSON-LD Events on the upcoming-auctions page, or an iCal URL, Member Feed Sync reads it as it is: no new code, no special-purpose scraper.
   - Estate-sale posts need an event date in structured data. A plain WordPress post feed only carries the publication date, which is now deliberately never used as the sale date.
   - If the structured data exists only on each catalog page, not on the listing page, Member Feed Sync would need one generic addition: follow event links listed on a member's own page. Build that only once Invaluable confirms that layout.
2. **Interim, and the fallback: Lewis & Maese publishes its events through its Advantage.Bid member account.** Manual per event, but immediate and accurate. The Marketing Director oversight stops flagging Lewis & Maese as soon as it publishes upcoming events itself. This needs the Lewis & Maese organization linked to its seller account; you said you will convert `tyler@lmauctionco.com` yourself.
3. **A calendar Lewis & Maese maintains elsewhere** (for example a public Google Calendar iCal URL) and registers in Member Feed Sync. Automatic sync, but each event is still entered by hand, so it is no better than option 2.
4. **Not acceptable:**
   - presenting a browser identity
   - solving the WAF challenge
   - reading invaluable.com pages around the challenge

## What you can do yourself (limited Invaluable admin)
- Record the consent: a written statement from a person with authority at Lewis & Maese (see below).
- Check the Invaluable admin for any "calendar", "feed", "export", "SEO / structured data" or "bot protection / firewall" setting, and send us what you find.
- Open a support ticket with the questions below.
- Use option 2 now for the two missing events.

## What needs Invaluable support
- Any firewall or bot-control exception on lmauctionco.com.
- Confirmation of the structured data or calendar the pages publish, or enabling it.

## Questions for Invaluable support
Account: Lewis & Maese Antiques & Auctions, lmauctionco.com.
1. Our site's edge firewall (CloudFront / AWS WAF) returns HTTP 403 to the event-listing service we authorize. Can you allow requests whose User-Agent is `AdvantageBidBot/1.0 (+https://bid.advantage.bid; lawful event discovery; contact info@advantage.bid)`, to these paths only:
   - `/auctions/upcoming-auctions/`
   - `/auction-catalog/*`
   - our estate-sale posts, or `/feed/`
   - `robots.txt`

   If you require it, we can also give you the service's outbound IP addresses. Traffic is light: a few requests twice a week.
2. Do our upcoming-auction and catalog pages publish schema.org `Event` (or `SaleEvent`) JSON-LD with the sale name, start date and time, end date, location and page URL? If not, can it be enabled under our plan's schema.org / SEO controls?
3. Does the platform offer an iCal (.ics), RSS-with-event-dates or JSON calendar of our upcoming sales, or an export endpoint we can authorize for a partner?
4. Do our estate-sale posts carry structured event dates (not only the post's publication date)? If not, is there a supported way to add them?
5. Is there a supported read API for an auction house's own upcoming sales (not the Catalog Upload API)? What is required to use it?

## Consent workflow (no invention, no backdating)
- **Who grants it.** A person with authority at Lewis & Maese sends a short written authorization from an @lmauctionco.com address to info@advantage.bid, for example: "Lewis & Maese authorizes Advantage.Bid to read and list our publicly advertised auctions and estate sales from lmauctionco.com, attributed to Lewis & Maese, until we revoke it."
- **Conflict of interest.** If the grantor is also an Advantage.Bid principal, state that person's capacity at Lewis & Maese in `granted_by`.
- **The record.** Use the existing audited onboarding: `POST /api/admin/event-imports/member-feeds` (`member_feed.registered` audit row, admin actor):
  - `granted_by`: name and capacity
  - `granted_at`: the date of that email, not an earlier date
  - `evidence`: sender, date and subject or message id, plus where it is kept
  - `organization_id`: `77c403f5-…`
  - the feed `url`, or `site`
  - `timezone`: `America/Chicago`
  - `sale_type`: leave unset unless every item is one type; items are classified from their own titles
- **When.** Registration needs a fetchable feed address, so it happens after Invaluable's answer. The consent email can be sent now and recorded then, with its true date.

## Activation scope
- Registering a feed switches the single Member Feed Sync source from paused to active. It currently has no other feeds, and every feed is fetched only with its own recorded consent, so no unrelated partner feed is enabled.
- **Auto-publish.** The source has `auto_publish = true` and production has `EVENT_IMPORT_AUTOPUBLISH_ENABLED=true`. Imported Lewis & Maese events would therefore publish through the publication gate (date, location, attribution and quality rules). For a review-first start, ask for a dry-run sync first.
- After activation, the oversight reports Lewis & Maese per sync: blocked, format changed, nothing upcoming, events waiting for review, and so on.

## Correction plans (prepared, dry run by default, not run)
| Issue | Fix | Production step (needs approval) |
|---|---|---|
| 7 organizations, all from the BD import and including Lewis & Maese, have website addresses stored form-encoded (`https%3A%2F%2F…`) | `bdDirectoryService.cleanWebsite` decodes at the source. The daily sync then corrects unclaimed listings by itself. | `node scripts/fix-org-website-encoding.js` (report), then `--apply`. It decodes only still-encoded rows and audits each one (`organization.website_url_decoded`). Claimed listings need this script. |
| 3 past Lewis & Maese events (`5eb00c47…`, `38aed25b…`, `61fe9759…`) have no host and sit under the importing organization | Use the existing audited attribution service (`admin_verified`, with evidence). The operating organization, content and status are unchanged, and a different host is never overwritten. | `node scripts/attribute-retired-source-events.js --source lmauction-lewis-maese --org 77c403f5-0c8c-4a5e-824a-cf113beb5217` (report), then `--apply --evidence "…" --actor <admin id>` |

## Local changes (branch `feat/lm-invaluable-restoration-prep`)
- Feed items never take a post's publication date as their event date.
- Directory website decoding, plus the two dry-run-first correction scripts.
- The oversight alert key for a former partner stays stable through attribution. Deploying it re-sends the Lewis & Maese alert once, because the stored key changes from `FORMER_SOURCE_PARTNER:-` to `FORMER_SOURCE_PARTNER:lewismaese`.

## Status 2026-10-29 (provider-neutral discovery built)
- **Live probe.** The provider-neutral probe ran live against lmauctionco.com with the honest identity. It made one request: `robots.txt` returned 403 from the provider's edge (CloudFront), classified `host_firewall_refusal`, and nothing more was requested.
- **Remaining external dependency.** The hosting provider must allow the importer.
- **Working alternatives** once released: a sending key (push) for any tool Lewis & Maese controls, and posting on Advantage.Bid.
