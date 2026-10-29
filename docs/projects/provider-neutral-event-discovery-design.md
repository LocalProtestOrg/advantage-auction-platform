# Provider-Neutral, Consent-Based Event Discovery: Design and Acceptance-Test Plan

Status: DESIGN FOR OWNER REVIEW, 2026-10-29. Nothing here is built, deployed or activated.

Related decisions:
- `event-partner-self-service-verification.md` (Owner policy, 2026-09-12)
- `member-neutral-import-architecture.md` (Owner decision, 2026-09-24)
- `event-import-partner-oversight.md` (Marketing Director oversight, live 2026-10-29)
- `lm-invaluable-restoration-plan.md`

---

## 1. The problem this resolves

The 2026-09-12 policy promises that a company is never asked to "select an importer technology, configure a feed, upload events or understand structured data". Collection today cannot keep that promise:
- A partner source may use only the `feed` connector: RSS, iCal, or JSON-LD on the one page given.
- There is no reader for sitemaps or linked event pages.
- There is no way for a company to send us events, so a company whose host blocks automated reading has no automatic path.
- Member Feed Sync (2026-09-24) is a second, separate consent store: a JSON list on one shared source with a shared create cap.

**Goal.** A company authorizes and gives its website. Advantage.Bid works out, honestly and automatically, how that company's public events can be collected. When the website cannot be read, Advantage.Bid says exactly why and offers a supported alternative. One generic system serves every company; there is no per-company code.

---

## 2. Principles (non-negotiable, carried forward)

1. **Consent first.** Nothing about a company's website is fetched before a recorded, versioned authorization exists. This keeps the Phase 1 partner rule.
2. **Honest identity.** Every request identifies as `AdvantageBidBot` with a contact address. No browser identity, no challenge solving, no CAPTCHA services, no rotating IPs, and no headless browser used to get past a block.
3. **Two separate permissions** (section 4): the company's permission to distribute its events, and the host's permission to read the website. Neither stands in for the other.
4. **One generic path.** No company-specific connector, code branch or exception. Per-company differences are data (channels, hints, confirmed settings), never code.
5. **Accuracy over coverage.**
   - An event is published only when its own title, its own event date and its own link were read from the source.
   - A publication date is never an event date.
   - Anything ambiguous is held for review.
6. **Existing safeguards unchanged:**
   - verified-host attribution (`host_organization_id`, `authorized_source`)
   - stable-id deduplication
   - the publication gate and Review Queue
   - audit rows for every grant, change and revocation
   - the Marketing Director's oversight

---

## 3. Seller experience (target)

**Step 1: Authorize** (one screen, every path of the 2026-09-12 trust ladder unchanged).
- A member sees one button in its dashboard: "Promote my events from my website". It shows the website on file and the versioned statement (section 4). That is trust-ladder Path C, an existing trusted relationship.
- A non-member uses the existing public request and one-click authorization (Paths A, B and D).

**Step 2: Nothing.** Advantage.Bid probes the site automatically (section 5) and shows a status in plain language:
- "We're collecting your events automatically. 6 upcoming events found." with a link to view them.
- "We found your events. An Advantage.Bid team member is confirming them before they go live." This is the first-time confirmation.
- "Your website's host does not allow automated reading, so we can't collect from it directly." Then:
  - [Post your events on Advantage.Bid]
  - [Send us your events automatically] — a guided connection for the company's own tools (section 7)
  - [Ask your website provider to allow us] — a pre-written request naming the exact identity and pages
- "We couldn't find any upcoming events on your website. If you list them on a separate page, tell us its address." This is a single optional field, not configuration.

The company never chooses a technology, writes a feed or sees a format name. Choosing "Send us your events automatically" walks them through connecting their own tool to an address we give them. It is the only step with any technical flavour, and it is optional.

---

## 4. Two kinds of permission (requirement 8)

| | Distribution authorization | Access permission |
|---|---|---|
| Who grants it | The company (the event owner) | Whoever controls the website or platform being read: the company itself for its own hosting; Invaluable, EstateSales.NET, HiBid etc. for theirs |
| What it allows | Advantage.Bid may show the company's public events, attributed to it and linked to its pages | Our software may automatically request those pages from that host |
| Where recorded | `authorized_event_sources` (existing, versioned statement, evidence, revocable) | `event_collection_channels.access_basis` (new, per channel, section 8) |
| Evidence | Statement version + the single-use authorization action (existing) | One of: `robots_and_terms_permit` (checked automatically and recorded); `host_written_permission` (document reference); `platform_partnership` (agreement reference); `company_push` (the company sends the data itself, so no third-party access is involved) |

**Rules:**
- A company's distribution authorization never authorizes reading a third-party platform whose terms forbid automated collection. EstateSales.NET §16.6 and HiBid §9 forbid it.
- A company's own domain, where the company is the site owner, is covered by its authorization. A blocking edge firewall operated by its hosting provider is a separate access matter.
- A refused or challenged request is a recorded fact, never an obstacle to work around.

**Statement v2 (needs Owner approval).** The current statement (`2026-09-11.v1`) covers only "events your company posts publicly on your own website". v2 adds one line: "…and events you choose to send to Advantage.Bid directly." The other lines stay the same. v1 records stay valid for website collection. Push needs v2, or a member's acceptance inside its account.

---

## 5. Automatic discovery: how a website is read (requirement 2)

A **discovery probe** runs after authorization, again on a schedule (monthly, and whenever a channel fails structurally), and on admin request. It always runs as a dry run: it writes channel candidates and a preview, never events.

### 5.1 Safety envelope (every request)
- **Robots.** `robots.txt` is fetched and evaluated for `AdvantageBidBot` and `*` before any other path, and `Crawl-delay` is honored. A disallowed path is never requested.
- **Network guard (SSRF).** https or http only. Public IPs only, re-checked after DNS. Redirects capped at 5 and must stay on the authorized domain, except a recorded calendar or catalog host. 25 s timeout, 5 MB per response.
- **Budget.** At most 40 requests per probe, at least 3 s apart, same site only.
- **Block classifier.** Every non-2xx response is classified from the response itself:

| Classification | Signal | Meaning |
|---|---|---|
| `host_firewall_refusal` | 401/403 with an edge marker such as `Server: CloudFront`, `x-amzn-waf-*`, Cloudflare or Akamai headers | The host refuses our honest identity |
| `bot_challenge` | 202/403/503 carrying a challenge: `x-amzn-waf-action: challenge`, Incapsula `_Incapsula_Resource`, Cloudflare "Just a moment" | Needs a browser; never attempted |
| `robots_disallow` | Our own robots evaluation | |
| `rate_limited` | 429 | Transient; bounded retry |
| `unreachable` | Network error or 5xx | Transient |
| `login_required` | Redirect to a login form | |
| `not_found` | 404/410 | |
| `terms_prohibit` | The host is in the **platform registry** (5.4) with a recorded prohibition | |

  The classification, status, URL and decisive header are stored as evidence. Oversight shows it in plain language.

### 5.2 Candidate generation (no per-company code)
In order, stopping early when a high-confidence channel is confirmed:
1. **Home page and the optional events page the company gave.**
   - `<link rel="alternate">` RSS/Atom and calendar links.
   - Schema.org Event in JSON-LD **and microdata/RDFa** (`itemprop="startDate"`), new.
   - `og:type=event` hints.
2. **Sitemaps.** `Sitemap:` lines in robots, then `/sitemap.xml`, `/sitemap_index.xml` and `/wp-sitemap.xml`. Select URLs whose path or title suggests an event: auction, catalog, estate, sale, event, calendar.
3. **Navigation links** on the home page with event words (same site only, depth ≤ 2).
4. **Platform-recognised well-known endpoints.** These are data in the platform registry, not code per company. They are tried only when the home page identifies the platform. Examples:
   - WordPress: `/feed/`, `/events/feed/`, `/?ical=1`, `/wp-json/tribe/events/v1/events` (The Events Calendar)
   - Squarespace: `?format=ical` on an events collection
   - Wix: the events sitemap

### 5.3 Readers (generic, shared by every company)
| Reader | Exists today | Change |
|---|---|---|
| iCal | yes (`feedConnector.parseIcal`) | reuse |
| RSS/Atom with event dates | yes | reuse (publication dates already excluded) |
| JSON-LD Event on a page | yes (one page) | reuse |
| **Microdata / RDFa Event** | no | new, small |
| **Linked event pages** (listing page or sitemap, then each event page, then JSON-LD or microdata) | no | new; caps, robots, same site |
| **Generic HTML extraction** | no | new, gated (section 6) |
| Platform JSON endpoints (e.g. The Events Calendar REST) | no | new, generic per platform |

### 5.4 Platform registry (data)
A small, version-controlled list of hosting and listing platforms: Invaluable/ConnectWP, EstateSales.NET, EstateSale.com, HiBid, LiveAuctioneers, AuctionZip, WordPress, Wix, Squarespace and others. For each it records:
- how to recognise it (generator meta, script hosts, headers)
- well-known event endpoints
- recorded terms (link and clause) and any prohibition
- the supported alternative to offer

It is data, reviewed by a person, never a per-company exception.

### 5.5 Choosing channels
- **Score.** Each candidate is scored for: future dates, own titles, own same-site links, items consistent across two probes, and sale type stated or inferable.
- **Channel kinds.** The top channel per **event kind** becomes the collection plan. Sites that publish auctions and estate sales differently get two channels, each with a sale-type hint (requirement 9). Example: catalogs on a listing page, estate sales as blog posts.
- **First-time confirmation.** An admin sees a preview of up to 10 events with title, dates, location, link and sale type, and confirms each new channel once. After that, sync is automatic.

---

## 6. Generic HTML extraction: assessment (requirement 3)

**Can it be safe and reliable without a scraper per site?**
- **Partly.** It is safe for producing review-queue candidates.
- **Not reliable enough to auto-publish**, unless the site's own pages are consistent and an admin confirms them.

**Why plain HTML is hard:**
- Dates appear in many forms and contexts: preview dates, sale dates, pickup dates, "ends" times, multi-day schedules, past-sale lists.
- Time zones are often implicit.
- A page may list several sales.
- A heuristic that guesses wrongly publishes the wrong date, the one failure this platform must not have.

**Design: "confirmed extraction profiles", learned as data, never coded.**
1. Only **detail pages** (one event per page), found through 5.2. Never extract several events from one listing page.
2. From each page, take:
   - **Title:** `og:title`, then a single `<h1>`, then `<title>`, the first that is unique.
   - **Event date:** only a date/time found next to an explicit label ("Auction begins", "Bidding closes", "Sale dates", "Preview" is excluded), or in a `<time datetime>` element. More than one competing candidate means no date.
   - **Location:** a postal-address pattern, or `itemprop=address`.
   - **Link:** the page URL.
3. **Timezone.** The channel's confirmed timezone; otherwise the event is held.
4. **First confirmation.** The first time, an admin compares 5 pages' extracted values with the pages themselves and confirms. The confirmed label vocabulary and positions are stored as the channel's **profile** (data).
5. **Trust ramp.** Profile events go to the Review Queue until 10 consecutive events pass review unchanged. Then they follow the normal publication gate.
6. **Drift.** Any drop in extraction confidence (missing label, two dates, date in the past on a future listing) suspends the profile and alerts oversight with `FORMAT_CHANGED`.

**Recommendation:**
- Build structured readers first (Phases 2 and 3).
- Measure, on authorized companies only, how many sites have no structured data.
- Build HTML profiles (Phase 4) only if that share justifies it.

---

## 7. When the website cannot be read: supported alternatives (requirement 7)

Ordered by automation:
1. **Company push (automatic, host-independent).** The company's own tools send events to Advantage.Bid. Outgoing traffic is not affected by its host's incoming firewall.
   - **Intake API.** `POST /api/intake/v1/events` with a per-company **intake key**. Bodies:
     - schema.org Event JSON (one or a list)
     - an iCal file
     - a simple JSON shape: title, start, end, url, address, sale_type
   - **Calendar link.** Any iCal URL the company controls, such as a public Google Calendar. It is recorded as a channel with `access_basis = company_push`, because the company publishes it to us.
   - **Guided connections.** Templated recipes for common automation tools (Zapier/Make "new post", "new calendar event", "new form entry"), and documented export targets for auction-management software (the Wavebid/AuctionFlex roadmap items use the same endpoint).
2. **Post on Advantage.Bid** (manual, always available): the existing member event editor and Review Queue.
3. **Ask the host** (provider cooperation): the system drafts the exact request with identity, paths, volume and contact. The Marketing Director prepares it; a person sends it.
4. **Not offered:** browser impersonation, challenge solving, scraping a third-party platform against its terms, or a "share" button that captures pages in the company's browser. That last one is honest, but it is a capture tool; it is excluded unless the Owner chooses it later.

---

## 8. Data model and migrations (requirement 11)

### 8.1 Unify consent
- **One authorization model.** `authorized_event_sources` becomes the single authorization record for members and non-members alike.
  - Members authorize through Path C in their dashboard (`authorization_method = 'admin_recorded'` or a new `'member_account'`).
  - The Member Feed Sync `config.feeds[].consent` JSON is migrated into rows here, preserving each original `granted_*` value as recorded, never re-dated.
- **One source per company.** `import_sources` gets one per authorized company (`partner-<slug>`, owner = the company, as `partnerSourceService` already does). The shared `member-feeds` source is retired with history (`retired_reason`), like `lmauction-lewis-maese`.

### 8.2 New tables (migration 208, additive)

**`event_collection_channels`**
- id, authorization_id, organization_id, import_source_id
- `kind`: `ical | rss | jsonld | microdata | linked_pages | platform_endpoint | html_profile | push_api | push_calendar | manual`
- url (nullable for push and manual)
- sale_type_hint, timezone
- `status`: `candidate | previewed | confirmed | active | paused | blocked | retired`
- `access_basis`: `robots_and_terms_permit | host_written_permission | platform_partnership | company_push`
- access_evidence jsonb
- block_class, block_evidence jsonb
- profile jsonb (HTML profiles only)
- confirmed_by, confirmed_at
- discovered_at, last_probe_at
- health fields mirroring `import_sources`: consecutive_failures, last_success_at, next_retry_at, …
- created_at, updated_at
- UNIQUE(authorization_id, kind, url)

**`event_discovery_probes`**
- id, authorization_id, trigger (`authorized | scheduled | admin | failure`)
- started_at, finished_at
- requests int, robots jsonb, platform text
- candidates jsonb (scored), blocks jsonb
- outcome (`channels_found | blocked | nothing_found | error`)

**`partner_intake_keys`**
- id, authorization_id
- key_prefix (shown), key_hash (sha256; the key is shown once)
- created_by, created_at, last_used_at
- revoked_at, revoked_by
- scopes (`events:write`)

**Unchanged:** `import_runs` and `import_run_items` keep recording every run. `stats.partners` becomes `stats.channels`.

### 8.3 Engine
- **New connector `discovery`**, generic. For a company source it iterates that company's **active channels**, dispatching to the readers in 5.3.
  - Each item is tagged with its channel, so duplicate matching and oversight are per channel.
  - Fetch rules: honest identity, robots, network guard.
- **Push.** Intake writes into the same pipeline (normalize → dedupe → host attribution → publication gate) as a channel run with trigger `push`, and is recorded in `import_runs`.
- **Duplicates across channels.** The same event may arrive by iCal and JSON-LD. Matching order:
  1. normalized canonical URL
  2. source id within the channel
  3. the existing fingerprint (organizer + address + date)

  When the same event arrives from two channels, the channel with the richer record wins, and each channel keeps its own provenance.
- **Sale type.**
  1. The item says it itself (title or categories).
  2. Otherwise the channel hint.
  3. Otherwise held.

  This keeps the current rule.
- **Partner allowed connectors.** `partnerSourceService.ALLOWED_CONNECTORS` becomes `['feed', 'discovery']`. `feed` remains for the transition.

### 8.4 APIs
| Who | Endpoint | Purpose |
|---|---|---|
| Member | `POST /api/org/event-distribution/authorize` | Path C authorization (website on file, statement v2) |
| Member | `GET /api/org/event-distribution` | plain-language status, events found, alternatives |
| Member | `POST /api/org/event-distribution/events-page` | optional "my events are on this page" |
| Member / partner | `POST/DELETE /api/org/event-distribution/intake-keys` | create (shown once) / revoke |
| Company tools | `POST /api/intake/v1/events`, `GET /api/intake/v1/events`, `DELETE /api/intake/v1/events/:id` | push, list own, withdraw |
| Admin | `POST /api/admin/event-discovery/:authorizationId/probe` | dry-run probe |
| Admin | `GET /api/admin/event-discovery/:authorizationId` | probes, candidates, previews, blocks |
| Admin | `POST /api/admin/event-discovery/channels/:id/(confirm\|pause\|retire)` | channel lifecycle (audited) |
| Admin | `GET /api/admin/event-imports/oversight` | existing, extended per channel |

---

## 9. Marketing Director oversight (requirement 6)

This extends the live `partnerOversight` service. No second monitor.

| Stage | Findings (who acts) |
|---|---|
| Onboarding | `AUTHORIZED_NOT_PROBED` (automatic); `PROBE_BLOCKED` with block class (owner and seller alternative offered); `NOTHING_FOUND` (investigate, seller prompted for an events page); `AWAITING_CHANNEL_CONFIRMATION` (admin_review) |
| Sync | existing per-partner codes, now per channel: `BLOCKED`, `FORMAT_CHANGED`, `RETRYING` (bounded retry 1h/2h/4h), `FAILING`, `STALE`, `COUNT_DROP` |
| Coverage | `NO_UPCOMING` (investigate, never assumed failure); `PUSH_SILENT` (a push company sent nothing for 45 days: investigate); `FORMER_SOURCE_PARTNER` (existing); `EVENTS_MISSED`: an event visible on a confirmed channel during a probe but absent from Advantage.Bid (technical) |
| Quality | `UNCLASSIFIED`, `BAD_DATES`, `MISSING_LINK`, `OFF_SITE_LINKS`, `DUPLICATES`, `AWAITING_REVIEW` (existing) |
| Re-discovery | the monthly probe finds a better channel (`BETTER_CHANNEL_AVAILABLE`, admin_review); a profile drifts (`FORMAT_CHANGED`) |

**What it may and may not do:**
- **Automatic:** probes as dry runs, bounded retries, history (`audit_log` + `event_discovery_probes`), reports, and alerts only for new owner items.
- **Drafts only:** the message to a company explaining its host's block and the alternatives, and the host-cooperation request. A person sends them, consistent with the A15 no-send rule.
- **Never:** creates, edits or publishes an event; records or widens consent; confirms a channel; changes access basis; deploys anything.

---

## 10. Security considerations

| Area | Control |
|---|---|
| Probing arbitrary URLs (SSRF) | Public-IP check after DNS and after each redirect; protocol allowlist; same-site redirects; size and time caps; no credentials or cookies sent |
| Honest identity | One identity string (`http.js DEFAULT_UA`), asserted by a test across every reader; no header overrides permitted (test) |
| Robots and terms | Robots evaluated by code before any path; platform-registry prohibitions block channel creation; the evidence is stored |
| Intake keys | 32-byte random, shown once, sha256 at rest, prefix for support, per-company scope, revocable, `last_used_at`, rate limit (60/min, 1,000/day), 1 MB body, strict schema |
| Domain binding | Pushed or collected events must link to the authorized domain, or to a domain recorded on the authorization (e.g. the company's Invaluable catalog host). Otherwise they are held as `OFF_SITE_LINKS` |
| Content safety | Text fields stripped of markup; length caps; images `link_only` by default; no page HTML stored beyond a 2 KB excerpt per item |
| Data minimization | Only event fields. No visitor or buyer data; no contact emails or phones taken from pages (the authorization already holds the company contact) |
| Revocation | Revoking the authorization disables channels and keys at once (same transaction) and stops collection at the next run. Published events follow the existing revocation behavior |
| Audit | Authorization, probe, channel confirm/pause/retire, key create/revoke, access-basis change, and every attribution, each with actor and evidence |

---

## 11. Acceptance tests (per phase; all run on real Postgres via the PGlite harness plus fixtures)

**Phase 1: foundations**
1. **Robots.** A disallowed path is never requested (spy on fetch). `Crawl-delay` is honored (fake clock).
2. **Network guard.** Private, loopback and link-local addresses, DNS rebinding and an off-site redirect are all refused before any request.
3. **Block classifier.** Recorded fixtures for CloudFront/WAF 403, a WAF challenge 202, Incapsula, a Cloudflare challenge, 429, a login redirect and 404 each map to the right class. None leads to a retry with a different identity.
4. **Identity.** Every reader's requests carry the same honest identity, and no code path sets another User-Agent (source scan plus runtime spy).
5. **Consent migration.** Member Feed Sync consent moves into `authorized_event_sources` with its original values unchanged. A feed without consent becomes no authorization (dry run first, idempotent).
6. **No consent, no fetch.** Probing or syncing a company without a live authorization makes zero requests.

**Phase 2: discovery and structured readers**
7. **Feed links.** A site with `<link rel=alternate>` to an iCal yields an iCal channel. The preview events are correct in the confirmed time zone.
8. **Linked pages.** A WordPress-shaped fixture (sitemap, then event posts with JSON-LD) yields a `linked_pages` channel. Its events carry their own dates, never post dates.
9. **Two event types.** Auctions on a listing page plus estate sales as posts give two channels, each with the right sale-type hint.
10. **Microdata.** `itemprop="startDate"` events are read.
11. **Unstructured site.** A site with no structured data gives `nothing_found` and the seller prompt, never invented events.
12. **No duplicates across channels.** The same event present in iCal and JSON-LD gives one event with two provenance rows. A repeated sync updates it in place.
13. **Confirmation.** A channel stays `previewed` until an admin confirms it. Confirming is audited. Before confirmation, nothing is published.
14. **Platform registry.** Hosts with a recorded prohibition (EstateSales.NET, HiBid) never become channels; the alternative is offered.

**Phase 3: push**
15. **Keys.** A key is shown once and stored hashed. Using a revoked key gives 401. A key can write only its own company's events.
16. **Payloads.** schema.org JSON, iCal and the simple JSON shape all normalize identically. Oversized or invalid payloads give 400 with no partial write.
17. **Domain binding.** Pushed events off the authorized or recorded domains are held, not published.
18. **Idempotence.** The same push twice gives one event. A changed push updates it. A withdraw archives it.
19. **Silence.** No push for 45 days raises `PUSH_SILENT` (investigate), not a failure.

**Phase 4: HTML profiles (only if approved)**
20. **Labeled dates only.** A date is taken only from a labeled context. Two competing dates give no date. A "Preview" date is never the sale date.
21. **Trust ramp.** Profile events stay in review until 10 pass unchanged.
22. **Drift.** Drift suspends the profile and raises `FORMAT_CHANGED`.

**Throughout**
23. **Oversight.** Every new failure class appears in the oversight report with the right "who acts". Owner alerts fire once per new problem.
24. **Revocation.** Revoking an authorization disables its channels and keys in the same transaction, and nothing more is collected.
25. **Regression.** The existing importer suites and the full regression run stay green. GSA and Gaston & Sheehan behaviour is unchanged.

---

## 12. Implementation sequence and migration strategy

| Phase | Content | Production steps (each needs Owner approval) | Size |
|---|---|---|---|
| 0 | Owner decisions in section 14; statement v2 wording; platform registry seed list | none | — |
| 1 | Robots module, network guard, block classifier, migration 208 (tables), member Path C authorization, consent migration script (dry run first), oversight per channel | migration 208; run the consent migration; deploy | M |
| 2 | Discovery probe + structured readers (feed links, sitemaps, linked pages, microdata, platform endpoints), admin preview/confirm, seller status page | deploy; enable probes (flag `EVENT_DISCOVERY_ENABLED`) | L |
| 3 | Push intake (keys, endpoint, calendar-link channel), seller alternatives UI, guided connection recipes | deploy; enable intake (flag `EVENT_INTAKE_ENABLED`) | M |
| 4 | HTML profiles, review-only with trust ramp: **decide after Phase 2 coverage data** | deploy behind a flag | M–L |
| 5 | Platform cooperation: auction-software export destinations (Wavebid/AuctionFlex) via the Phase 3 endpoint; host-allowance requests (e.g. Invaluable) | agreements | — |

**Migration from the existing importer:**
- **Government and original-host sources** (`gsa-auctions`, `txauction-gov`) are not partner sources and are unchanged.
- **Member Feed Sync** (`member-feeds`, currently paused with no feeds):
  - Its code path keeps working through Phase 1.
  - Consent rows migrate to `authorized_event_sources`.
  - Each company gets its own source and channels.
  - The shared source is then retired with history. No production feed is lost; there are none today.
- **Event Partner sources** (`partner-<slug>`, none active; 10 invited) gain channels when they authorize.
- **Retired** `lmauction-lewis-maese` stays retired, untouched, as history.
- **Rollout:** probes ship as dry run only. Collection through channels is enabled per company only after channel confirmation. Global flags default off.

---

## 13. Lewis & Maese under this design (requirement 12)

1. **Authorize.** Lewis & Maese authorizes through its member account (Path C). The written authorization you described is recorded with its true date.
2. **Probe.**
   - `robots.txt` on lmauctionco.com returns 403 from CloudFront, which the classifier records as `host_firewall_refusal`. Because robots cannot be read, no other path is requested. Probing stops.
   - The platform registry recognizes Invaluable from the stored evidence and the organization's known catalog links. It records that invaluable.com answers with `bot_challenge` and offers no read API.
   - Third-party listings on EstateSales.NET and HiBid are `terms_prohibit`; EstateSale.com is `bot_challenge`. None become channels.
3. **Seller status:** "Your website's host does not allow automated reading." Alternatives:
   - **Post on Advantage.Bid:** works now, including the two missing events.
   - **Send us your events automatically:** works without Invaluable if Lewis & Maese's own tools can send outgoing data: a WordPress automation plugin, an email-to-automation recipe, or a calendar link it maintains. Whether its limited admin role allows a plugin is still to be checked by you.
   - **Ask your website provider:** the drafted Invaluable request from `lm-invaluable-restoration-plan.md`.
4. **Oversight:** reports `PROBE_BLOCKED` (host firewall, evidence attached), and `NO_UPCOMING` until one alternative is active.

**Impossible without Invaluable's cooperation:** automatic reading of lmauctionco.com or invaluable.com by any honest client. Every path is refused at their edge, or needs a browser challenge solved.

**Possible without Invaluable:**
- push from Lewis & Maese's own tools, if its admin role allows
- a company-maintained calendar link
- posting on Advantage.Bid

**Not yet known:** what the Lewis & Maese admin role can install or export, and whether Lewis & Maese sends sale announcements from an email tool.

---

## 14. Reconciling the 2026-09-12 and 2026-09-24 decisions (requirement 13)

| Decision element | Verdict | Detail |
|---|---|---|
| 09-12 "participation must feel nearly effortless"; company gives name, website, requester, email only | **Preserve** | Authorization collects the same four facts; discovery is automatic |
| 09-12 trust ladder Paths A–E; authorization is a single-use, evidence-backed action; statement versioned | **Preserve** | Unchanged. Members use Path C inside their account |
| 09-12 "never asked to … configure a feed, upload events, understand structured data" | **Reconcile, needs explicit Owner confirmation** | Still true by default. When the host blocks reading, the company is *offered* optional alternatives in plain language. Proposed wording: "never *required* to …; offered a plain-language alternative only when its website cannot be read automatically" |
| 09-12 "never asked to create an account / choose a password" | **Preserve for non-members** | A non-member's intake key is issued through the authorization confirmation, with no account. Members already have accounts |
| 09-12 statement v1 ("events your company posts publicly on your own website") | **Revise, new version, Owner approval** | v2 adds "and events you choose to send to Advantage.Bid directly". v1 records stay valid for website collection |
| Phase 1 partner rule: robots and terms checked by human attestation | **Revise, Owner approval** | Robots become an automatic, recorded check per request (stronger). Terms attestation stays human for the company's own site; prohibitions on platforms come from the reviewed platform registry |
| 09-24 no dedicated member connector, no crawler or browser-identity exception, no special crawler permission | **Preserve** | One generic `discovery` connector. Per-company differences are data. No identity exceptions |
| 09-24 "the same paths for every Professional Seller" | **Preserve** | Every company, member or not, uses authorization, discovery, channels and alternatives |
| 09-24 Member Feed Sync as the ONE member path, consent in `config.feeds` on one source | **Revise, Owner approval** | It becomes per-company channels under the unified authorization record. Consent is migrated with original values; the shared source is retired with history |
| 09-24 `getConnector` fails closed on unknown selectors; retired sources stay retired | **Preserve** | `discovery` is added to the registry; nothing else changes |
| 09-24 supply shortfalls reported as DEGRADED, never hidden | **Preserve** | Oversight extends this per channel |
| `partnerSourceService.ALLOWED_CONNECTORS = ['feed']` ("never a bespoke scraper") | **Revise, Owner approval** | Add `discovery` (generic, no bespoke code). The "no bespoke scraper" intent is preserved; HTML profiles are data-driven, review-gated, and only if Phase 4 is approved |

**Owner decisions requested before development:**
1. Approve statement v2 wording.
2. Approve the reconciled 09-12 wording ("never required…, offered an alternative when unreadable").
3. Approve unifying Member Feed Sync consent into `authorized_event_sources`, retiring the shared source.
4. Approve automatic robots evaluation replacing human robots attestation.
5. Decide whether Phase 4 (HTML profiles) is in scope now or only after Phase 2 coverage data. Recommended: after.
6. Decide whether a browser "share" capture tool is ever acceptable. Recommended: no, for now.
7. Approve the platform registry approach, and its initial entries with their recorded terms.
