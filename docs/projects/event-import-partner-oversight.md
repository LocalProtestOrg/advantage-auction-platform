# Event Import Partner Oversight (Marketing Director)

Owner assignment, 2026-10-29. Builds on the member-neutral import architecture (`member-neutral-import-architecture.md`, 2026-09-24), which is unchanged.

## Responsibility
The Marketing Director (A1, capability `oversee_event_imports`) oversees the whole approved-partner event-import system:
- every live import source
- each member feed on Member Feed Sync
- each Event Partner with a recorded authorization

The goal is that approved partner events never silently disappear.

Code: `src/services/eventImport/partnerOversight.js`. The worker runs it from its existing hourly health check, at most once per Eastern day and after every scheduled cycle. There is no second monitoring system.

## What runs automatically
- **Per-partner sync results.** Each run records every member feed's own outcome in `import_runs.stats.partners`: `ok`, `empty`, `blocked`, `rate_limited`, `unreachable`, `parse_failure` or `no_feed_found`. A failing partner is therefore visible even when the other partners in the same source synced.
- **Bounded retries.** A rate-limited or unreachable feed gets the importer's existing retry policy (1h, 2h, 4h; at most 3 per window). A refusal or a format change is never retried around.
- **Findings.** Each finding names who acts:
  - `automatic`: the importer handles it.
  - `admin_review`: imported events are waiting in the Review Queue.
  - `investigate`: unusual, but not necessarily a failure. Examples: a partner with nothing upcoming, an unusual drop in event count, unclassified events, bad dates, off-site or missing links, duplicates.
  - `owner`: a person must act. Examples: missing consent, Member Feed Sync paused, a partner's firewall refusing access, a format change, repeated failures, a stale source, or a partner whose retired source has not been replaced.
- **History.** Each assessment is written to `audit_log` (`event_import_oversight`). Source health stays on `import_sources`, and runs stay in `import_runs`.
- **Alerts.** An email goes to info@advantage.bid only for NEW owner findings, and only while `EVENT_INVENTORY_ALERTS_ENABLED=true`.
- **Periodic report.** The partner section is appended to the existing post-run summary email.
- **Admin view.** `GET /api/admin/event-imports/oversight` returns the assessment as JSON plus the text report.

## What it never does
The Marketing Director never:
- bypasses a source's access restriction or presents a browser identity
- creates, edits or publishes events or photographs
- records, widens or revokes consent
- changes partner permissions, configuration, code or schema
- deploys anything

Bounded retries happen only through the importer's own retry policy.

## Classification and attribution (Member Feed Sync)
- **Sale type.** An item is an auction or an estate sale only when its own title or categories say so. If it says both or neither, the member's declared `sale_type` applies (optional, set at onboarding). Otherwise the event is held for review. Sale types are never guessed.
- **Time zone.** A member's `timezone` (IANA) converts its local calendar times correctly.
- **Attribution.** Items are attributed to the consenting member (`host_organization_id`, organizer name and site).
- **Repeats.** Repeated syncs match events by the feed's stable item ids (iCal UID, RSS guid, JSON-LD url), so they update events rather than duplicate them.

## Restoring Lewis & Maese
Checked 2026-10-29:
- There is no recorded consent for Lewis & Maese: no member-feed entry and no consent audit row.
- LMAuctionCo.com answers HTTP 403 "Access Denied" from its CloudFront firewall to the importer, for every page including `robots.txt`.
- No feed address is known.

Steps:
1. **Consent.** Lewis & Maese records its authorization. The record needs who granted it, when, and the written evidence, such as a signed form or an email.
2. **Website administrator.** Lewis & Maese's website administrator allows requests identifying as `AdvantageBidBot/1.0 (+https://bid.advantage.bid; lawful event discovery; contact info@advantage.bid)` to its event feed. They confirm the feed's address, or provide one of:
   - an iCal (.ics) calendar
   - an RSS feed
   - schema.org Event structured data (JSON-LD)
3. **Onboard the feed.** An owner-approved production change runs `POST /api/admin/event-imports/member-feeds` with:
   - `organization_id` `77c403f5-0c8c-4a5e-824a-cf113beb5217`
   - the feed `url`
   - `consent`
   - `timezone` `America/Chicago`
   - optionally `sale_type`

   This activates Member Feed Sync.
4. **Dry run.** Run a dry-run sync and check the oversight report. Then let the scheduled runs import automatically.

Alternatively, Lewis & Maese can publish its events itself through its member account.

The two currently missing events need either the feed (steps 1 to 3) or their source page details from Lewis & Maese. Their details are never invented.
