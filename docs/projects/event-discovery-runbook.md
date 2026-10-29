# Event Discovery Runbook (provider-neutral, consent-based)

Built 2026-10-29 on branch `feat/provider-neutral-event-discovery`. The design is in `provider-neutral-event-discovery-design.md`, and the owner approved executing all phases. Migration 208.

## What it does
1. **Authorize.** A company authorizes once and gives its website.
   - **Members:** the "Import My Events" page (`/org/event-promotion.html`; API `/api/org/event-distribution`). This is trust-ladder Path C, statement v2.
   - **Non-members:** the existing Event Partner flow.
2. **Discover.** Advantage.Bid checks the website honestly, as a dry run. The steps, in order:
   1. robots.txt
   2. home page and optional events page
   3. declared feeds
   4. schema.org JSON-LD and microdata
   5. platform endpoints from the reviewed registry (`src/services/eventDiscovery/platformRegistry.js`)
   6. linked event pages and sitemaps
   7. a proposed generic HTML profile

   It records what it found, including every refusal with its evidence (`event_discovery_probes`).
3. **Confirm.** An administrator confirms each new collection method once, from its preview (`event_collection_channels`). Collection then runs on the existing schedule, through the generic `discovery` connector.
4. **Push.** When a website cannot be read, the company can send its events instead, with a sending key: `POST /api/intake/v1/events`. It accepts schema.org Event JSON, iCal, or the simple JSON shape, and each event must link to the company's own site. Posting on Advantage.Bid always works.
5. **Oversight.** The Marketing Director oversees all of it (`partnerOversight` + `discoveryOversight`), in the same report, history and alerts.

## Switches (all OFF until the release is approved)
| Switch | Where | Effect |
|---|---|---|
| Migration 208 | `scripts/prod-migrate-208.js --check \| --dry-run \| (apply)` | Tables for channels, probes and keys. Without it the routes return errors and the oversight skips discovery. |
| `EVENT_DISCOVERY_ENABLED=true` | Railway env | The worker runs due probes: new authorizations, monthly re-checks, and re-checks after 3 failed reads. A seller's "check again" runs at once. |
| `event_partners.collection_enabled = true` | `platform_config` | A confirmed channel's company source becomes active, so scheduled imports collect and publish through the publication gate. Pushed events publish only while this is on; otherwise they wait as drafts. |
| `EVENT_INTAKE_ENABLED=true` | Railway env | `/api/intake/v1` accepts submissions. Off: 503. |

## Safeguards (enforced in code, with tests)
- **Honest identity, always:** `AdvantageBidBot/1.0 …`. A caller cannot change it.
  - robots.txt is read first on every host. A refused or challenged robots.txt stops all further requests.
  - No browser identity, no challenge solving, no requests to other hosts.
- **Network protection:** public addresses only, and the connection is pinned to the checked address (DNS rebinding cannot redirect it). Redirects stay on the same site, with a size cap and a timeout.
- **Bounded crawling:** 40 requests per probe, 3 s spacing (or the site's Crawl-delay), and a 1 MB parse cap with linear-time scanning.
- **Two permissions, kept separate:**
  - the company's distribution authorization (`authorized_event_sources`);
  - each channel's host access basis: `robots_and_terms_permit` / `host_written_permission` / `platform_partnership` / `company_push`.

  Listing platforms whose terms forbid automation are never contacted (EstateSales.NET, HiBid, EstateSale.com, LiveAuctioneers, Invaluable marketplace).
- **Domain claims:**
  - A member may authorize only a site matching its recorded website or its email domain. Anything else waits as `prospective` until an administrator confirms it with evidence: `POST /api/admin/event-discovery/:id/approve-domain`.
  - A whole shared-hosting platform can never be authorized; a sub-site there covers that exact host only.
- **Accuracy:**
  - Dates come only from explicit event fields or labeled sale dates, never from publication, preview or pickup dates.
  - The sale type comes only from what the item says, otherwise the channel's confirmed hint, otherwise the event is held.
  - The organizer is always the authorized company.
- **Duplicates:**
  - The same event seen through two channels stays one event, matched by its page URL.
  - A company's source can never update another company's event, or a native one. Such a match becomes a "possible duplicate".
- **HTML profiles:** events stay in review until 10 have been published after review. Collection pauses itself when pages stop matching the confirmed profile.
- **Revocation:** withdrawing or revoking retires every channel and stops every sending key in the same transaction.

## Operating it (Admin › Operations › Event Discovery, `/admin/event-discovery.html`)
- **Check website now:** a dry-run probe.
- **Confirm and collect:** confirm a channel. Set the sale type only if every item is one type; set the time zone if the site omits it.
- **Preview next sync:** a dry run of the company's source.
- **Pause / Retire:** stop a channel, with a reason.
- **Sending keys:** create (shown once) or revoke.
- **Confirm website:** approve a pending member authorization.
- **Oversight report:** at the top of the page. The same report goes to info@advantage.bid after scheduled runs, and new owner items are emailed once.

## Release (once approved)
1. `railway run … node scripts/prod-migrate-208.js --check`, then `--dry-run`, then apply.
2. `node scripts/migrate-member-feeds-to-discovery.js`, then `--apply`. Production has no member feeds, so this only retires the shared source.
3. Push `main` and verify the deployment.
4. Set `EVENT_DISCOVERY_ENABLED=true` and `EVENT_INTAKE_ENABLED=true` (a service restart), then `event_partners.collection_enabled = true`.
5. Corrections:
   - `scripts/fix-org-website-encoding.js`: report, then `--apply`.
   - `scripts/attribute-retired-source-events.js --source lmauction-lewis-maese --org 77c403f5-0c8c-4a5e-824a-cf113beb5217`: report, then `--apply --evidence "…" --actor <admin>`.

## Rollback
- **Code:** revert the release commits, or redeploy the previous `main` (`a3b2b22`).
- **Switches:** turn them off: env vars false, `collection_enabled` false. Collection and intake stop at once; nothing else changes.
- **Schema:** migration 208 is additive. Its header lists the DROP statements, safe while no channel, probe or key exists. Neon backup branch first, as for 206 and 207.
- **Corrections:** both scripts audit every change with the old value (`organization.website_url_decoded`, `event.host_attributed`), so each can be reversed from the audit log.

## Lewis & Maese (verified 2026-10-29)
- **The block.** A live probe of lmauctionco.com made **one request**: `robots.txt` answered 403 from the hosting provider's edge (`server: CloudFront`), classified `host_firewall_refusal`. Nothing else was requested.
- **External dependency.** Automatic reading needs the hosting provider (Invaluable) to allow the importer. The questions are in `lm-invaluable-restoration-plan.md`.
- **Working alternatives now:**
  - a sending key (push) for any tool Lewis & Maese controls;
  - posting on Advantage.Bid.
- **Who authorizes.** The Lewis & Maese organization's only member is its BD-bridge owner identity, so its owner authorizes from the dashboard. The domain verifies automatically against the organization's recorded website, which is decoded on read.
