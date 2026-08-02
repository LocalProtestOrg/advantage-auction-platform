# Analytics Phase 0 — Verification Results

**Project:** Advantage.Bid (AAC)
**Phase:** 0 — read-only verification
**Date:** 2026-07-30
**Repository baseline:** Event Import Framework feature-complete through **Commit 15**
**Companion document:** `docs/analytics/AAC_ANALYTICS.md` v2.1
**Status:** `PHASE 0 COMPLETE — AWAITING OWNER REVIEW`

**Nothing was implemented.** No application code, configuration, migration or
environment variable was modified. No GA4 property, data stream or GTM container
was created. No Brilliant Directories change was made. Nothing was deployed.
Phase 1 has not begun.

---

## 0. Scope, method and limits

### 0.1 What was verified, and how

Verification was performed by reading source files and directory listings from
the working tree on 2026-07-30, at the Commit-15 baseline. Every finding below
carries a file path and, where useful, a line number. Where a claim could not be
established from source, it is marked ⚠ and listed in **Appendix A** rather than
asserted.

| Marker | Meaning |
|---|---|
| ✅ | Verified directly in source at this baseline |
| ⚠ | Not established from source — see Appendix A |
| 🔒 | Requires owner, legal or security decision |
| 🧪 | Requires staging or live verification (cannot be established from code) |

### 0.2 Honest limits of this pass

Three classes of item **cannot** be verified from the repository, by their
nature, and remain open regardless of how thorough this pass was:

1. **The Brilliant Directories side.** No code read can tell you what is pasted
   into BD's Additional HEAD Code, its widgets, its theme, or its plugins. §14 of
   the architecture document is the checklist; it requires BD admin access. This
   is the single largest remaining unknown and it is a **Phase 2** blocker.
2. **Live DNS and hosting facts.** Whether `advantageauction.bid`,
   `auctions.advantage.bid` or a Vercel deployment currently resolve and serve.
3. **Runtime behaviour.** Anything requiring a browser, a real session, or a
   deployed environment (marked 🧪).

Additionally, a small number of files were not read individually in this pass;
they are named in Appendix A so the gap is explicit rather than implied.

---

## 1. Verified existing analytics state

### 1.1 Google analytics tooling — clean slate confirmed ✅

| Item | Finding |
|---|---|
| Existing GA4 code | **None.** Zero `gtag(`, zero `googletagmanager`, zero `google-analytics.com`, zero `G-` measurement ID anywhere in the tree. |
| Existing GTM code | **None.** Zero `GTM-` container reference. |
| Legacy Universal Analytics | **None.** Zero `UA-` property, zero `analytics.js`, zero `ga(` calls. |
| Existing consent logic | **None for analytics.** The only `consent` matches are (a) ESIGN/UETA checkboxes in `public/sign-agreement.html:66,218`, (b) SMS consent in `src/workers/notificationWorker.js:41,48,385`, (c) legal prose in `privacy.html` / `terms.html`. **No cookie banner, no CMP, no Consent Mode.** |
| Existing cross-domain configuration | **None.** No `cookie_domain`, no linker, no `_gl` handling. |
| Existing referral exclusions | **None.** No GA4 property exists yet. |
| Existing conversion definitions | **None.** |

**This is the ideal starting condition.** There is no legacy tag to reconcile, no
half-migrated Universal Analytics, and no competing container — on the Railway
side. The BD side is unverified and must be assumed dirty until §14 is run.

### 1.2 Existing `dataLayer` usage ✅

Exactly **two** call sites, both defensive and both currently inert:

| File:line | Code | Behaviour |
|---|---|---|
| `public/widgets/marketplace-feed.js:31` | `if (window.dataLayer && window.dataLayer.push) window.dataLayer.push(Object.assign({ event: 'adv_' + event }, payload));` | Pushes `adv_<name>` only if a `dataLayer` already exists |
| `public/widgets/featured-items.js:33` | `… push(Object.assign({ event: 'adv_fi_' + event }, payload));` | Pushes `adv_fi_<name>` under the same guard |

Because no container exists, `window.dataLayer` is never created and **neither
push ever fires today**. This is pre-built, unused instrumentation — the
codebase was written anticipating GTM, exactly as recorded in AD-3's rationale.

### 1.3 Existing custom analytics helper ✅

`window.AAPAnalytics` v1 — `public/widgets/shared/analytics.js`.

| Property | Finding |
|---|---|
| Transport | `POST /api/analytics/events`, `keepalive: true` |
| Session | Random token in `localStorage`, 30-minute idle TTL, not user-linked |
| Server | `src/routes/analytics.js` → `src/services/analyticsService.js` → `analytics_events` (migration 044) |
| Response | Always `202 Accepted`, returned **before** the DB write |
| Privacy | IP hashed (16-char SHA-256 prefix); `PII_KEYS` stripped at insert |
| Callers of `insertEvent` / `insertBatch` | **Exactly one** — `src/routes/analytics.js`. No service, worker or agent emits directly. ✅ Governance intact. |
| **Modification status** | **Untouched.** `analyticsService.js` and `routes/analytics.js` both retain pre-analytics-project timestamps. **AD-11 is satisfied.** ✅ |

**Notable:** despite `AAPAnalytics` being fully built and documented, a tree-wide
search found **no `AAPAnalytics.track(...)` call site outside the helper's own
file and its doc comments**. The client exists; nothing calls it yet.
`public/auction-view.html` loads the script (`<script src="/widgets/shared/analytics.js">`)
but does not invoke it.

> **This matters for Phase 3's control-group plan.** The architecture document
> proposes comparing GA4 event volumes against equivalent `analytics_events`
> counts as a sanity check. **That control group does not currently exist** —
> the table will be empty because nothing writes to it. Either the first-party
> instrumentation is wired up in parallel, or the Phase 3 gate needs a different
> pass condition. See §10, Risk R-5.

### 1.4 Existing DOM-event vocabulary ✅

| Namespace | Source |
|---|---|
| `advantage:feed:*` | `public/widgets/marketplace-feed.js` |
| `advantage:featured:*` | `public/widgets/featured-items.js` |

`aap:*` events documented in `docs/analytics-telemetry.md` were **not** found as
live `dispatchEvent` call sites in this pass — see Appendix A.

### 1.5 `postMessage` bridges ✅

| File:line | Role |
|---|---|
| `public/widgets/marketplace-feed.js:55,97` | Child → parent send; parent-message listener |
| `public/widgets/featured-items.js:46,73` | Same pattern |
| `public/widgets/marketplace-embed.js:126,131` | **Parent-side** listener and resize request, with an `ORIGIN` target constant |

`marketplace-embed.js` is confirmed as the correct and only place to implement
the AD-10 parent-side translation.

---

## 2. Conflicts, duplicates and legacy code found

**No analytics conflicts, no duplicate instrumentation, and no legacy analytics
code exist in the repository.**

Four items are worth recording as *pre-existing conditions* rather than
conflicts:

| # | Item | Assessment |
|---|---|---|
| C-1 | `adv_*` / `adv_fi_*` `dataLayer` names | Not a conflict — they are inert. They will become a duplicate vocabulary the moment a container is published, because they do not match the §10 taxonomy. **Plan:** map them in GTM for one release, then remove the legacy pushes. |
| C-2 | `docs/analytics-telemetry.md` documents 10 event types and an `aap:*` DOM vocabulary that have no live call sites | Documentation is ahead of implementation. Not harmful; do not treat the doc as an inventory of live events. |
| C-3 | `public/auction-view.html` loads `analytics.js` but never calls it | Dead include. Harmless. Leave it — it is the natural hook point later. |
| C-4 | `vercel.json` still present, publishing `public/` to a second origin | Unchanged from v2.0. Still unresolved (§10, R-6). |

---

## 3. Current surface inventory

Verified from directory listings at the Commit-15 baseline.

### 3.1 Structural finding — all admin surfaces are static pages under `public/admin/` ✅

This is the most consequential structural fact for the analytics rollout.

`public/admin/` contains **15 files**: `index.html`, `moderation.html` (122 KB),
`imported-events.html` (58 KB), `invoices.html`, `invoice-detail.html`,
`settlement-review.html`, `users.html`, `buyers.html`, `verification.html`,
`agreements.html`, `events.html`, `event-detail.html`,
`marketplace-config.html`, `launch-readiness.html`, `events-admin.js`.

Because AD-20 makes injection automatic for every `.html` under `public/`,
**every one of these would be tagged by default.** They must be excluded as a
directory, not file-by-file.

There are also `public/org/`, `public/dashboard/` and `public/prototype/`
directories requiring the same treatment.

### 3.2 `robots.txt` already defines the exact boundary ✅

`public/robots.txt` disallows `/admin/`, `/org/`, `/dashboard`,
`/seller-dashboard`, `/app.html`, `/api/`, `/demo.html`, and every authenticated
buyer/seller page (`/watchlist.html`, `/invoices.html`, `/payment.html`,
`/add-card.html`, `/payout-profile.html`, `/seller-settlements.html`,
`/login.html`, `/sign-agreement.html`, `/verify-documents.html`, and others). It
additionally names `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `anthropic-ai`,
`PerplexityBot` and `Google-Extended`, allowing them on public content and
blocking them on private surfaces.

> **Recommendation R-A: derive the §9.6 analytics exclusion list from
> `robots.txt`.** The two lists answer the same question — *is this surface
> public?* — and maintaining them independently guarantees they drift. Any page
> disallowed to crawlers should be excluded from marketing analytics, with two
> deliberate exceptions: `/login.html` and `/become-seller.html`, which are
> `Disallow`ed for SEO reasons but are **essential funnel steps** and must remain
> tagged. Document those two exceptions explicitly so the divergence is a
> decision rather than an oversight.

The robots policy is also a genuine asset for dashboard §18.7 — AI crawler
access to public content is already deliberate and explicit.

### 3.3 Surface classification

Classification codes per `AAC_ANALYTICS.md` §9.1: **PV** pageview · **ENG**
engagement · **FUN** funnel · **CNV** conversion · **OPS** operational-only ·
**SRV** server-authoritative · **EXC** excluded.

**Public marketing — `www.advantage.bid` (BD) unless noted**

| Surface | Class | Notes |
|---|---|---|
| Homepage (BD) | PV, ENG | 🧪 BD-side |
| Homepage / Living Map — `public/index.html` (92 KB) | PV, ENG, FUN | ✅ |
| Search — `public/search.html` | PV, ENG, FUN | ✅ |
| All Events — `public/events.html` | PV, ENG, FUN | ✅ |
| Auctions — `featured-auctions.html`, `ending-soon.html`, `past-auctions.html` | PV, ENG, FUN | ✅ |
| Estate Sales — feed presets + `event.html` | PV, ENG, FUN | ✅ |
| Company directory | PV, ENG, FUN | 🧪 BD-side + `marketplace-profile.js` |
| Professional directory | PV, ENG | 🧪 BD-side, **not verifiable from this repo** |
| City / state pages | PV, ENG, FUN | ✅ APP (`browse-locations.html`) / 🧪 BD |
| Articles & CMS pages | PV, ENG | 🧪 BD-side |
| Seller marketing — `start-selling.html`, `seller-pilot.html`, `seller-faq.html`, `how-sellers-get-paid.html`, `after-estate-sale.html`, `downsizing-liquidation.html` | PV, ENG, FUN | ✅ |

**Public application — `bid.advantage.bid`**

| Surface | Class | Notes |
|---|---|---|
| Auction discovery — `browse-categories.html`, `browse-locations.html`, `shipping-available.html` | PV, ENG, FUN | ✅ |
| Auction detail — `auction-view.html` (91 KB) | PV, ENG, FUN | ✅ |
| Lot detail — `lot.html` (94 KB) | PV, ENG, FUN | ✅ |
| Estate-sale event detail — `event.html` | PV, ENG, FUN | ✅ |
| **Imported event detail** — same `event.html`, distinguished by `source` | PV, ENG, FUN | ✅ — see §9 |
| Marketplace views — `marketplace-feed.js`, `featured-items.js` | ENG, FUN | ✅ via AD-10 parent bridge |
| Map interactions | ENG | ✅ |
| Search & filters | ENG, FUN | ✅ |
| **External-source CTA clicks** | ENG | ✅ `public/event.html:94` renders the attribution link — see §9 |
| `/items` SSR crawl page | PV | ✅ `server.js:256-362` |

**Authenticated buyer**

| Surface | Class | Notes |
|---|---|---|
| Registration / login — `login.html`, `forgot-password.html`, `reset-password.html` | FUN, CNV | ✅ `src/routes/auth.js` |
| Email verification — `GET /api/auth/verify-email` | FUN | ✅ optional, non-blocking, gates nothing |
| Watchlist — `watchlist.html` | ENG, CNV | ✅ `POST /api/watchlist/add`, `/remove`, `GET /` |
| Bid started / submitted / accepted / rejected | FUN, CNV | ✅ endpoint · ⚠ reason codes — **see R-3** |
| Purchase & invoice — `invoices.html`, `my-bids.html` | FUN | ✅ |
| Payment — `payment.html`, `add-card.html`, `billing.html` | FUN, SRV | ✅ |
| Notifications & messages | **OPS / EXC** | `notificationWorker.js` — message content is never analytics data |
| Member shell — `app.html` + `member-shell.js` (71 KB) | PV | ✅ — **see R-2** |

**Authenticated seller**

| Surface | Class | Notes |
|---|---|---|
| Become a seller — `become-seller.html` | FUN, CNV | ✅ |
| Agreement acceptance — `sign-agreement.html`, `my-agreements.html` | FUN, CNV | ✅ |
| Event creation — `/org/events/new` (`server.js:518`) | FUN | ✅ |
| Auction creation — `seller-create.html` (43 KB) | FUN | ✅ |
| Lot creation — `lot-builder.html` (29 KB) | FUN | ✅ |
| Draft submission / publishing | FUN, CNV | ✅ |
| Seller analytics — `seller-dashboard.html` (49 KB) | **OPS** | Postgres — `followers_total`, `followers_7d`, `active_watchers` |
| Settlement workflows — `seller-settlements.html`, `payout-profile.html` | **OPS / EXC** | Financial — never GA4 (AD-14) |

**Admin — all OPS, all excluded from GA4**

| Surface | File | Class |
|---|---|---|
| Admin shell | `public/admin/index.html` | EXC |
| Event moderation | `public/admin/moderation.html`, `events.html`, `event-detail.html` | OPS |
| **Imported Events Review Queue + Run History** | `public/admin/imported-events.html` ✅ **Commit 11 confirmed** | OPS |
| Verification | `public/admin/verification.html` | OPS, EXC |
| Agreements | `public/admin/agreements.html` | OPS |
| Invoices | `public/admin/invoices.html`, `invoice-detail.html` | OPS, EXC |
| Settlements | `public/admin/settlement-review.html` | OPS, EXC |
| Marketplace admin | `public/admin/marketplace-config.html` | OPS |
| Users / buyers | `public/admin/users.html`, `buyers.html` | OPS, EXC |

`public/admin/imported-events.html` already carries
`<meta name="robots" content="noindex, nofollow">` (line 6) and performs a
client-side admin check by decoding the JWT role claim (line 237). It contains
both the **Review Queue** and **Run History** tabs (lines 148–203) and calls
`const API = '/api/admin/event-imports'` (line 241).

---

## 4. Recommended canonical event taxonomy

**No change is recommended to the §10 taxonomy.** It survives verification
intact. Two confirmations and one correction:

### 4.1 Confirmed — the four bid events stay separate (AD-28) ✅

`bid_started`, `bid_submitted`, `bid_accepted`, `bid_rejected` remain four
distinct business events. Verification strengthens the case: the bid endpoint
(`src/routes/lots.js:161`) can fail in at least six distinct ways, so collapsing
submit and accept into one event would make the failure rate unmeasurable.

### 4.2 Confirmed — reason classes only (AD-29), but the source data is not ready ⚠

See **R-3**. The endpoint returns free-text `message` strings, not codes.

### 4.3 The fifteen proposed Event Import event names — recommendation: **none of them go to GA4**

The candidate names were offered for architectural review, and the review is
that they should not enter the GA4 taxonomy. The reasoning is specific, not
reflexive:

1. **They are admin actions.** Under AD-26, admin traffic is suppressed from
   GA4. These events would be collected and then discarded — or worse, would
   create pressure to leave internal traffic unfiltered, corrupting every
   acquisition report.
2. **Every one of them is already recorded server-side, authoritatively.**
   Verified: `writeAuditLog` emits `event.import.approved` and
   `event.import.rejected` with `actor_id`, entity, and metadata
   (`reviewQueue.js:252,273`); `writer.publishImported` emits `event.published`
   with `via: 'import'` (`writer.js:140`); `import_runs` and `import_run_items`
   record every run and every record outcome (`runLog.js`). GA4 would be a
   lower-fidelity duplicate of data Postgres already holds perfectly.
3. **AD-24 makes this explicit** — Postgres is the operational analytics source
   of truth; GA4 is behavioural only.

| Candidate | Disposition | Where it is already measured |
|---|---|---|
| `import_approved` | **Postgres** | `audit_log.event_type = 'event.import.approved'` ✅ |
| `import_rejected` | **Postgres** | `audit_log.event_type = 'event.import.rejected'` ✅ |
| `import_bulk_approved` / `import_bulk_rejected` | **Postgres** | Same audit rows; bulk-ness derivable from actor + timestamp clustering, or add a `bulk: true` flag to the existing audit metadata |
| `import_approve_all_completed` | **Postgres** | Same audit rows |
| `import_approve_all_count_mismatch` | **Postgres** | 409 `APPROVE_ALL_COUNT_MISMATCH` — currently returned to the client but **not persisted**. Worth logging server-side; it is a real concurrency-friction signal. |
| `import_manual_dry_run_started` / `_completed` | **Postgres** | `import_runs.trigger = 'manual'`, `status`, `started_at`, `finished_at`, `duration_ms` ✅ |
| `import_manual_apply_started` / `_completed` | **Postgres** | Same, distinguished by whether writes occurred ✅ |
| `import_scheduled_run_results` | **Postgres** | `import_runs.trigger = 'scheduled'` ✅ |
| `import_queue_viewed` | **First-party (optional)** | Not currently recorded anywhere |
| `import_detail_reviewed` | **First-party (optional)** | Not currently recorded anywhere |
| `import_run_history_viewed` / `import_run_detail_viewed` | **First-party (optional)** | Not currently recorded anywhere |
| `import_approve_all_attempted` | **First-party (optional)** | Attempt (as distinct from outcome) is not persisted |

**The five "optional" items are genuinely new information** — they measure admin
*attention* rather than admin *action*, which no database table captures. If you
want them, route them to the existing first-party `analytics_events` pipeline,
never to GA4. That respects AD-24 and AD-26, needs no new infrastructure, and
uses a table that already exists and is currently empty.

**Naming, if implemented:** the existing house convention is
`[noun]_[verb-past-tense]` (`docs/analytics-telemetry.md`). The proposed names
already comply. Use `import_queue_viewed`, `import_detail_reviewed`,
`import_run_history_viewed`, `import_run_detail_viewed`,
`import_approve_all_attempted` — five names, not fifteen. **This is not
authorisation to implement them.**

---

## 5. Identity and privacy findings

### 5.1 HMAC `analytics_uid` — design validated, insertion point found ✅

`public/widgets/shared/auth-refresh.js` wraps `window.fetch` and already
maintains an authenticated bootstrap, including a coalesced `GET /api/auth/me`
re-verification (`auth-refresh.js:37-46`). **This is the correct and only clean
insertion point** for delivering a server-derived `analytics_uid` and an
internal-traffic role flag to the client.

*Identified only. Nothing was implemented.*

| Requirement | Status |
|---|---|
| No raw internal UUID sent to GA4 | ✅ Design holds — `analytics_uid` is HMAC-derived server-side |
| Derivation never happens in browser JS | ✅ Required — the secret must never reach the client |
| Same value on both hosts | ✅ Achievable via the same bootstrap |
| Rotatable for deletion requests | ✅ `ANALYTICS_UID_SECRET` rotation severs all linkage |
| Secret storage | 🔒 **Still open (Q-I)** — Railway env recommended |

### 5.2 No PII to GA4 — one concrete new hazard found

The prohibited-data matrix (§11.3) holds, but verification surfaced two specific
fields that must be named explicitly because an implementer could plausibly send
them by accident:

| Field | Location | Ruling |
|---|---|---|
| **`import_run_items.raw_excerpt`** | `runLog.js:29-34` — stores a JSON excerpt of the **raw third-party source payload** | **Never to GA4, under any circumstance.** It is unbounded, externally controlled, and may contain organiser names, addresses, phone numbers or emails from the source listing. It is correct for provenance and debugging; it is disqualifying as analytics data. |
| **`err.message` on bid failure** | `src/routes/lots.js:202` — `return res.status(400).json({ success: false, message: err.message })` | **Never pass through to GA4.** This is an unbounded service-generated string that may include bid amounts or increment values. See R-3. |

Also confirmed safe to use: `attribution_source` and `attribution_url` are
already rendered publicly on the event page (`public/event.html:94`), so using
them as GA4 dimensions exposes nothing that is not already public.

### 5.3 Google Signals OFF (AD-25) ✅

No GA4 property exists, so nothing to disable yet. Recorded as a Phase 0 console
task. The rationale stands: at launch volume, Signals' data thresholding would
withhold rows from most reports, and it would introduce an `ad_user_data` consent
dependency that nothing else requires.

---

## 6. Internal-traffic suppression recommendation

**Confirmed: role-first, IP secondary (AD-26).** Verification makes the
recommendation sharper and simpler than v2.1 anticipated, because the admin
surface turns out to be cleanly separable by path.

**Three layers, in priority order:**

| # | Layer | Mechanism | Catches |
|---|---|---|---|
| **1** | **Path exclusion** *(new — strongest and simplest)* | `analyticsTag.js` never injects into `/admin/*`, `/org/*`, `/dashboard/*`, `/prototype/*`. **No tag, no data, nothing to filter.** Verified viable: every admin surface is a static page under `public/admin/`. | All admin and org pages, unconditionally |
| **2** | **Role flag** | When the authenticated session carries an admin or staff role, set `traffic_type: 'internal'` on the GA4 config. Delivered via the `auth-refresh.js` bootstrap (§5.1). | An admin browsing **public** pages — the case Layer 1 cannot catch |
| **3** | **IP filter** *(secondary safeguard only)* | GA4 internal-traffic definition + data filter, created in **Testing** mode first | Office network; fails the moment anyone works from home |

Layer 1 did not appear in v2.1 because the admin directory structure had not been
verified. It is now the primary mechanism: **an untagged page cannot pollute
anything**, which is a stronger guarantee than any filter.

Layer 2 remains necessary and is the reason AD-26 says "role-first" — an admin
who browses a city page or an auction detail is indistinguishable from a buyer
unless the role flag is set.

**Environment guard (unchanged):** non-production environments must never point
at `G-JM5JYGNJ6H`. Staging uses a separate debug property or
`ANALYTICS_TAG_ENABLED=false`.

---

## 7. Cross-domain / subdomain configuration recommendation

**GA4 cross-domain linking is NOT required between `www.advantage.bid` and
`bid.advantage.bid`.** Shared first-party cookie configuration is sufficient and
is the correct choice.

**Why:** both are subdomains of the registrable domain `advantage.bid`. With
`cookie_domain` left at its default (`auto`), the Google tag writes `_ga` on
`.advantage.bid`, which every subdomain reads. Client ID and session survive the
hop with no `_gl` linker parameter. Enabling cross-domain measurement here would
be harmless but pointless, and would append `?_gl=…` to internal links, cluttering
URL-based reporting for no benefit.

**Exact required configuration:**

| Setting | Value |
|---|---|
| Measurement ID | `G-JM5JYGNJ6H` — the same ID on **both** hosts |
| Data streams | **One.** A second stream is a defect, not an option (AD-4). |
| `cookie_domain` | Default (`auto`). **Do not set explicitly.** |
| `cookie_prefix`, `cookie_flags` | Default. Do not set. |
| Cross-domain "Configure your domains" | **Leave empty** for these two hosts |
| Session timeout | **1 hour** (default 30 min splits live bidding sessions; anti-snipe extensions make this worse) |
| Enhanced Measurement → **History changes** | **OFF** — see R-2 |

**Unwanted referrals (Admin → Data streams → Configure tag settings → List
unwanted referrals):**

| Match | Value | Prevents |
|---|---|---|
| contains | `advantage.bid` | Self-referral across `www.`, `bid.`, apex and widget iframes |
| contains | `stripe.com` | `checkout.stripe.com`, `js.stripe.com` |
| contains | `hooks.stripe.com` | **Critical** — 3-D Secure step-up redirects here and back; without it, card-authenticated purchases are attributed to Stripe |
| contains | `advantageauction.bid` | Until retired (§15 of the architecture document) |
| contains | `up.railway.app` | Staging hops |
| contains | `vercel.app` | If R-6 finds a live deployment |

**Session continuity — verified mechanics:**

- **Railway ↔ BD navigation:** ordinary links. Cookie carries identity. No action needed.
- **Identity bridge:** `src/routes/authBridge.js` lands the browser on
  `GET /auth/bd/return?code=…` (`bridgeHandlers.js:43`). Only `code` is passed —
  no UTM or `gclid`. **Attribution is unaffected**, because campaign data lives in
  the cookie, not the URL. ✅
- **The bridge seed page must never be tagged.** Verified: it returns HTML with a
  signed JWT in an inline script. It already carries
  `<meta name="robots" content="noindex,nofollow">` (`bridgeHandlers.js:58,71`).
  Add an explicit analytics exclusion regardless — defence that relies on a
  coincidence of routing is not defence.
- **Widget iframes:** never tagged (AD-9). `widgetFraming.js` sets only
  `frame-ancestors https://advantage.bid https://www.advantage.bid` and no
  `script-src`, so nothing blocks or complicates this. ✅ With AD-21 making `www`
  canonical, the apex entry in that list is now redundant — harmless, but worth a
  deliberate decision.

**🧪 This is proven at the Phase 2 gate, not assumed:** one click-through from
`www.advantage.bid` to `bid.advantage.bid` must show one session, one user, and
exactly one `session_start`, with zero self-referrals over 48 hours.

---

## 8. PostgreSQL versus GA4 boundary

**Confirmed and unchanged (AD-13, AD-14, AD-24).** Verification found that
Postgres already records every operational fact on the owner's list, in more
detail than GA4 could.

### 8.1 PostgreSQL — authoritative, never GA4

| Fact | Verified source |
|---|---|
| Import-run counts | `import_runs` — `fetched`, `eligible`, `created`, `updated`, `skipped_duplicate`, `skipped_quality`, `skipped_ambiguous`, `images_queued`, `failed` ✅ |
| Source success / failure | `import_runs.status`, `last_error`, `duration_ms` ✅ |
| Weekly caps | `import_sources.weekly_cap`; `import_runs.capped`, `remaining_available` ✅ |
| Duplicate counts | `import_runs.skipped_duplicate`; `import_run_items.outcome` ∈ `unchanged`/`duplicate`, `match_via` ✅ |
| Review-queue volumes | `events WHERE source='imported' AND status='draft'` (`reviewQueue.js:22`) ✅ |
| Approval / rejection totals | `audit_log` — `event.import.approved`, `event.import.rejected` ✅ |
| Connector errors | `import_run_items.error`, `reason`; `import_runs.last_error` ✅ |
| Scheduler status | `import_runs.trigger`, `scheduled_for`, `status`; worker gated by `EVENT_IMPORT_WORKER_ENABLED` ✅ |
| Settlement & financial truth | Settlement tables ✅ — **never GA4** |
| Bid acceptance & transaction truth | `bids`, `lots`, `invoices`, `payments`, `stripe_webhook_events` ✅ |

### 8.2 GA4 — behavioural only

Acquisition source, channel, campaign, landing page, content engagement, funnel
step, on-site search, map and radius interaction, and conversion attribution.

### 8.3 The one deliberate overlap

`purchase`, sent server-side from the Stripe webhook via Measurement Protocol
(AD-15). GA4 receives `transaction_id`, `value`, `currency` and `items[]` **for
attribution purposes only**. Postgres remains the financial record. The two are
reconciled weekly; a >2% divergence is an instrumentation alarm, never a
correction to the books.

> **GA4 must not become the source of truth for any operational or financial
> fact.** Concretely: no seller-facing report, no settlement, no reconciliation,
> and no invoice figure may be sourced from GA4 — not even temporarily, and not
> even when GA4's number is more convenient to fetch.

---

## 9. Event Import Framework — analytics additions

**Client-side (GA4): three new dimensions, one new event. No new page types.**

| Addition | Detail | Status |
|---|---|---|
| `event_source` dimension | `imported` \| `organizer` \| `admin` — segments every estate-sale metric by provenance. Without it, imported inventory and won inventory are indistinguishable and supply-growth metrics are meaningless. | ✅ field available |
| `attribution_source` dimension | Import source name; already public on the page | ✅ `event.html:94` |
| `organizer_badge` dimension | Derived from `source` via `eventsService.deriveOrganizerBadge` — lets you test whether the verified-organiser badge affects click-through | ✅ |
| `attribution_source_clicked` event | Outbound click on the source link. **Measures leakage** — the one path where imported inventory sends a visitor away. Anchor element confirmed at `public/event.html:94`. | ✅ hook point identified |
| `expired_event_viewed` event | **Blocked** — see R-4; the expired stub does not exist in the code read |

**No new event names for the imported/organiser distinction.** A separate
`view_imported_estate_sale` would fork every downstream report for no analytical
gain. The existing `view_estate_sale` carries the new dimensions.

**Server-side (Postgres): no new instrumentation required.** Every operational
metric in §22.4 of the architecture document is computable from existing columns.
Verified computability:

- `time_in_queue` = `events.published_at − events.created_at` ✅
  (`writer.publishImported` sets `published_at = now()`, `writer.js:137`)
- Rejection latency = `audit_log` timestamp for `event.import.rejected` ✅
  (`rejectOne` sets only `updated_at`, so the audit row is the reliable source)
- `expired_in_queue` = pending imported events whose `end_at` has passed ✅ —
  **the single most valuable import metric**, and pure wasted inventory
- Approval rate by source, run outcomes, cap saturation, market-resolution mix —
  all from `import_runs` / `import_run_items` ✅

**Recommendation:** build the import operations dashboard from Postgres in
Phase 4. It requires queries only — no instrumentation, no code, no risk.

---

## 10. Risks and blockers

Ordered by consequence.

### R-1 🔴 `adminEventImports.js` is not mounted — the Review Queue UI cannot reach its API

**Verified at Commit 15.** `src/routes/adminEventImports.js` exists, is 13,980
bytes, and carries the newest mtime in the route directory. But:

- There is **no `require(...)` of it** anywhere in `server.js` or `src/`
- There is **no `app.use('/api/admin/event-imports', …)`** line — while all
  twelve other admin routers are mounted (`server.js:469-481`)
- `src/routes/index.js` is empty and mounts nothing
- `public/admin/imported-events.html:241` calls `const API = '/api/admin/event-imports'`

**Consequence:** every request the Review Queue UI makes would fall through to
the `/api/admin` catch-all or the 404 handler. The queue would not load, and
approve/reject would fail.

**This is not an analytics issue** — it is a wiring defect found while verifying,
and reporting it is more useful than filing it neatly. It does not block Phase 0
or Phase 1. **It was not fixed**, per the read-only constraint.

*Caveat:* Commit 15's 1,184 tests pass, which suggests the route is tested
directly rather than through the mounted app. That is consistent with the mount
being the missing piece.

### R-2 🟠 `member-shell.js` uses `replaceState` — turn Enhanced Measurement "History changes" OFF

**Verified:** `public/widgets/shared/member-shell.js:125` and `:856` call
`history.replaceState(null, '', '#' + item)` on every in-shell navigation.

GA4's Enhanced Measurement "page changes based on browser history events" fires
on `replaceState`. With it enabled, **every tab click inside `/app.html` would
emit an additional `page_view`**, inflating pageviews, destroying pages-per-session,
and corrupting engagement rate for authenticated users.

**Recommendation — this changes v2.0's guidance.** v2.0 said "leave History
changes ON and forbid manual `page_view` pushes." That was written before the
shell's behaviour was verified. The correct setting is:

> **Enhanced Measurement → "Page changes based on browser history events" → OFF.**

The rest of the estate is multi-page static HTML and gains nothing from it. This
is a **console setting, not a code change** — zero risk, zero deploy, and it
removes the problem at the source. 🧪 Confirm at the Phase 1 gate.

### R-3 🟠 The bid endpoint has no machine-readable reason codes

**Verified** — `src/routes/lots.js:161` returns free-text messages:

| Status | Message | Proposed class |
|---|---|---|
| 404 | `Lot not found` | `not_found` |
| 403 | `Lot is not open for bidding` (withdrawn) | `lot_withdrawn` |
| 422 | `Lot is not accepting bids` | `lot_not_open` |
| 422 | `Bidding has not opened for this auction yet` | `auction_not_started` |
| 422 | `Lot has closed and is no longer accepting bids` | `lot_closed` |
| 403 | `lockErrorMessage(gate.reason)` | `gate_blocked` |
| 400 | **`err.message`** — unbounded service string | ⚠ **unsafe** |
| 401 | via `authMiddleware` | `auth_required` |

**Two problems.** First, HTTP status alone cannot distinguish reasons — 422 covers
three. Second, and more seriously, the 400 branch returns `err.message` verbatim,
which is generated by `bidService` and **may contain bid amounts or increment
values**. Forwarding it to GA4 would violate AD-29 and AD-30.

**Recommendation:** implement `bid_rejected` with a **client-side allow-list
mapping** of the five known messages above to fixed classes, and map anything
unrecognised — including every 400 — to `reason: 'other'`. Never forward the raw
message. Cleaner long-term: add a stable `code` field to the endpoint's error
responses; that is a code change for a later phase, not Phase 0, and it should
be raised with whoever owns `lots.js` rather than bundled into analytics work.

### R-4 🟠 Commit 13's expiry / `noindex` / 410 behaviour is not present in the gating files

**Verified at Commit 15.** A tree-wide search for `410`, `expired` and `noindex`
in `src/` returns matches only in the identity bridge, auth token handling, and
`server.js`'s `index,follow` tags. Specifically:

| Plan §5.2 surface | Current state | File |
|---|---|---|
| `GET /api/public/events/:slug` | `WHERE e.slug = $1 AND e.status = 'published'` — **no expiry branch, no 410** | `publicEvents.js:94-99` ✅ read |
| `shareMetaService.getEventMeta()` | Same filter; comment still reads *"ended events remain viewable for historical value, so they still get rich meta"* | `shareMetaService.js` ✅ read |
| `shareMeta` event body injection | Follows `getEventMeta()` | ✅ |
| `getSitemapEntries().events` | `status='published' AND slug IS NOT NULL`; comment still reads *"ended ones included … safe to list"* | ✅ |

Both files are **byte-identical to the Commit-13 baseline** (unchanged mtimes),
so they were not touched by Commits 14 or 15 either.

**I am not going to guess** whether this means the scope of Commits 12/13 differs
from plan §5.2, whether it landed somewhere not read in this pass, or whether it
is outstanding. → **Q-O remains open.**

**Analytics impact:** dashboard §18.6 measures indexed-page yield. If expired
imported events remain in the sitemap, the denominator inflates with pages that
cannot convert, and organic-yield metrics drift downward for reasons unrelated to
content quality. `expired_event_viewed` is also blocked. **Resolve before
building §18.6** — it blocks nothing earlier.

### R-5 🟡 The Phase 3 control group does not exist

The architecture document's Phase 3 gate compares GA4 event counts against
equivalent `analytics_events` counts, treating the first-party pipeline as a
control for GA4 under-collection. **Verification found no live `AAPAnalytics.track`
call site** — the table will be empty.

**Recommendation:** replace that gate condition. Compare GA4 counts against
**Postgres business records** instead — `view_item` against lot page loads is not
available, but `bid_accepted` against `bids` rows, `sign_up` against `users` rows,
and `auction_published` against `events`/`auctions` rows all are, and they are
authoritative. Adjust the Phase 3 gate to use those three.

### R-6 🟡 Unresolved from v2.0 — Vercel duplicate hosting

`vercel.json` still publishes `public/` to a second origin with `/` → `/demo.html`.
Whether a deployment is live is a Vercel-account question, not a code question.
**Blocks Phase 1** (Q-D).

### R-7 🔴 Brilliant Directories audit — the real Phase 2 blocker

Unchanged and unchangeable by code review. §14's 16-point audit requires BD admin
access. **Assume a legacy tag exists until proven otherwise.** Start this now, in
parallel — it is the only remaining blocker that depends on someone outside this
repository.

### R-8 🔒 Privacy policy and consent posture

`public/privacy.html` contains no disclosure of Google Analytics or any
advertising tag — correctly, since none exists. **It must be updated before the
container is published** (Phase 2 gate). Consent Mode v2 scope remains 🔒 (Q-F).

---

## 11. Exact prerequisites for Phase 1

Phase 1 is: `analyticsTag.js` + `datalayer.js` + one `server.js` line +
`.env.example`, deployed to **staging only**, against a **debug** GA4 property.

**Must be true before Phase 1 begins:**

| # | Prerequisite | Owner | Status |
|---|---|---|---|
| 1 | Owner has read this document | Owner | ⬜ |
| 2 | **Phase 0 console runbook executed** — GA4 property settings, 14-month retention, all custom dimensions registered (they do not backfill), unwanted referrals, 1-hour session timeout, BigQuery export, Search Console link, AI channel group, Signals OFF, reporting identity Observed, internal-traffic filter in Testing mode | Owner | ⬜ |
| 3 | **Enhanced Measurement "History changes" set to OFF** (R-2) | Owner | ⬜ |
| 4 | **GTM container created but NOT published** — GA4 Configuration tag only; all built-in Click/Form/Scroll/Element-Visibility triggers disabled | Owner | ⬜ |
| 5 | **Separate debug GA4 property exists for staging** — staging must never point at `G-JM5JYGNJ6H` | Owner | ⬜ |
| 6 | **Named GTM publisher decided** (Q-H) | Owner | ⬜ |
| 7 | **Vercel question answered** (R-6 / Q-D) | Owner | ⬜ |
| 8 | **Exclusion list finalised** from `robots.txt` (R-A), including the `/login.html` and `/become-seller.html` exceptions | Owner + implementer | ⬜ |
| 9 | `ANALYTICS_UID_SECRET` storage decision (Q-I) — *needed by Phase 4, not Phase 1; decide early* | Owner | ⬜ |

**Not prerequisites for Phase 1** (commonly confused): the BD audit (Phase 2),
the privacy-policy update (Phase 2), Consent Mode (Phase 1–2), the
`advantageauction.bid` retirement (independent), R-1, R-3 and R-4.

---

## 12. Is Phase 1 ready to begin?

**Not yet — but only because of owner console tasks, not because of anything in
the repository.**

| Dimension | Verdict |
|---|---|
| Architecture settled | ✅ AD-1 … AD-31 |
| Repository verified | ✅ At Commit 15 |
| Existing analytics conflicts | ✅ None found |
| Exclusion boundary defined | ✅ `robots.txt` + `/admin/`, `/org/`, `/dashboard/`, `/prototype/`, `/auth/bd/return`, `/widgets/*` |
| Identity insertion point found | ✅ `auth-refresh.js` |
| Event taxonomy | ✅ Unchanged; import candidates reconciled to Postgres |
| Cross-domain answer | ✅ Definitive — shared cookie, no linking |
| Postgres/GA4 boundary | ✅ Definitive |
| **Phase 0 console runbook** | ⬜ **Not executed — this is the gate** |
| **Debug GA4 property** | ⬜ Not created |
| **Vercel question** | ⬜ Unanswered |

**Verdict: Phase 1 is blocked on §11 items 2–7 only.** All of those are owner
console actions requiring no code, no deploy, and no risk to production. Once
they are complete, Phase 1 may begin immediately.

Two things to start **now, in parallel**, because they have the longest lead
times and both are outside this repository:

1. **The Brilliant Directories audit (R-7)** — the Phase 2 blocker.
2. **The privacy-policy update (R-8)** — also a Phase 2 gate, and it may need
   review by someone other than you.

---

## Appendix A — Not verified in this pass

Stated explicitly so the gap is a known quantity rather than an implied
completeness.

**Not verifiable from the repository at all:**

- Everything on the Brilliant Directories side (§14) — requires BD admin access
- Whether `advantageauction.bid`, `auctions.advantage.bid`, or a Vercel
  deployment currently resolve and serve — requires DNS/account access
- All 🧪 items — require a browser or a deployed environment

**Files not read individually in this pass:**

- `src/routes/admin.js` (68 KB), `adminUsers.js`, `adminBuyers.js`,
  `adminSettlements.js`, `sellerSettlements.js`, `adminAgreements.js`,
  `adminVerification.js`, `adminCrm.js`, `adminPickup.js`, `adminMarketplace.js`,
  `adminLaunchReadiness.js` — all admin, all excluded from GA4, so their contracts
  do not affect the analytics implementation
- `src/services/paymentService.js` (68 KB) — the webhook's business logic. The
  route-level webhook, signature verification and idempotency were verified;
  the **exact Measurement Protocol insertion point inside the service** must be
  confirmed before Phase 5, not Phase 1
- `src/services/eventImport/connectors/`, `normalize/`, `geocode.js`,
  `validate.js`, `rateLimit.js`, `dedupe.js`, `marketResolver.js` — pipeline
  internals; the run ledger they write to was verified, which is what analytics
  needs
- Individual `public/*.html` bodies — surfaces were classified from the file
  inventory and from targeted greps, not from full reads. Per-page event hook
  points are Phase 3 work, not Phase 0.

**Open owner questions carried forward:** Q-C, Q-D, Q-F, Q-G, Q-H, Q-I, Q-J, Q-K,
Q-L, Q-M, Q-N (now answered: **not mounted**, R-1), Q-O (still open, R-4), Q-P.

---

*End of Phase 0 verification results. No implementation has occurred. Awaiting owner review.*
