# AAC Analytics — Architecture, Measurement Plan & Governance

**Project:** Advantage.Bid (AAC)
**Document owner:** Analytics Director
**Version:** 2.1
**Date:** 2026-07-30
**Status:** `ARCHITECTURE APPROVED BY OWNER — IMPLEMENTATION NOT STARTED`
**Repository baseline:** Event Import Framework Commits 7, 8, 10, 12, 13 landed. Commit 11 (Admin Review Queue UI) in progress in VS Code Claude.

**Phase control in force.** No production code has been modified. No GTM
container has been published. No GA4 property or data stream has been created.
No Brilliant Directories code has been changed. No Railway environment variable
has been changed. No deployment has occurred.

---

## 0. How to read this document

| If you are… | Read |
|---|---|
| The owner, reviewing | §1 (what you approved, restated precisely), §19 (answers to the nine questions), §20 (what still needs you) |
| ChatGPT, reviewing | §1–§8 architecture, §9–§11 the plan, §20 unresolved items |
| VS Code Claude, implementing | §16 (verification checklist) **first**, then §17 (phases), then the Phase 0 prompt file. Do not start from §10. |
| Anyone checking a claim | §3.3 verification legend. Every factual claim about the codebase carries a marker. |

### 0.1 What changed in v2.0

- Owner decisions incorporated as binding, no longer proposals (§1).
- Governance Rule 7 amendment: **approved**; final text in §12.
- `advantageauction.bid` retirement: **approved**; full remediation scope in §15.
- New sections: identity & session model (§7), acquisition & UTM policy (§8), site-area measurement matrix (§9), canonical event dictionary (§10), privacy & prohibited-data matrix (§11), BD audit checklist (§14), repository verification checklist (§16).
- Every codebase claim now carries a verification marker (§3.3).
- Event names normalised to the owner-approved vocabulary (`bid_started`, `bid_submitted`, `payment_completed`, …). v1.0 used different names for several; §10.3 documents the rename.

### 0.2 What changed in v2.1

Owner decisions of 2026-07-30 (second round) recorded, and the architecture
re-verified against the **full** repository now that the Event Import Framework
has advanced.

- **Canonical hosts settled** (was the highest-priority open item, Q-A): marketing = `https://www.advantage.bid`, application = `https://bid.advantage.bid`. Applied throughout §6, §8, §15.
- New owner decisions recorded as **AD-21 … AD-27** (§1).
- **Repository caveat lifted.** The full tree is now readable; §3.4 replaced with a re-verification record. Many ⚠ items resolved to ✅.
- **New measurement surface:** Event Import Framework — imported events, source attribution, review queue, market resolution. Full addendum in **§22**.
- **New findings and risks** from Commits 10, 12, 13 in **§23** — including two that need action before Phase 0 completes.
- Phase 0 verification plan extended to cover the Admin Review Queue API and UI (§22.5, and the updated `PHASE_0_PROMPT.md`).

> v2.1 additions are appended as **§22 and §23** rather than woven through, so
> reviewers who read v2.0 can see exactly what is new without re-reading 2,000
> lines. Inline sections have been amended where a v2.0 statement became wrong.

---

## 1. Owner-approved architecture decisions

Settled. Restated in implementation-precise language so no downstream agent
re-derives them. Deviation requires the owner, not an implementer.

| # | Decision | Binding form |
|---|---|---|
| **AD-1** | One GA4 property | Property `Advantage.Bid` only. No second property, no roll-up. |
| **AD-2** | One web data stream for both hosts | Stream `15353439652` / `G-JM5JYGNJ6H` serves `advantage.bid` **and** `bid.advantage.bid`. |
| **AD-3** | One GTM container across both hosts | Single container. Same ID pasted into BD and injected by the Railway middleware. |
| **AD-4** | No separate stream for Railway | A second stream is a defect, not an option. |
| **AD-5** | Two hostnames = one continuous journey | Achieved by the shared registrable-domain cookie (`.advantage.bid`), not by cross-domain linking. |
| **AD-6** | Cross-domain measurement not required between the two hosts | Conditional on the §6.1 preconditions. Verified, not assumed, at the Phase 2 gate. |
| **AD-7** | Events originate in reviewed application code | Explicit `dataLayer.push()` in git. No exceptions. |
| **AD-8** | GTM is transport and configuration only | Built-in Click / Form / Scroll / Element-Visibility triggers stay **disabled**. No CSS-selector-based primary instrumentation. |
| **AD-9** | Never independently tag widget iframe documents | `/widgets/*` permanently excluded from injection. |
| **AD-10** | Parent page translates widget events | `postMessage` + `advantage:*` → parent-side `dataLayer.push()`. One translation point. |
| **AD-11** | Preserve the first-party pipeline | `analytics_events`, `analyticsService.js`, `AAPAnalytics`, Postgres reporting: unchanged. |
| **AD-12** | GA4 owns acquisition, attribution, funnel, content engagement, marketing performance | GA4 is never authoritative for money. |
| **AD-13** | Postgres is authoritative for records and money | Auctions, lots, bids, invoices, payments, seller revenue, fees, settlements, ops, reconciliation. |
| **AD-14** | Seller revenue and settlement reporting never rely solely on GA4 | Seller-facing figures come from Postgres, always. |
| **AD-15** | `purchase` is server-side only, after verified payment | Stripe webhook → GA4 Measurement Protocol. |
| **AD-16** | No client-side `purchase` | The tag must be **absent** from the container, not merely paused. |
| **AD-17** | Use the `analyticsTag.js` middleware pattern | No hand-editing of ~50 HTML files for the bootstrap. |
| **AD-18** | Follow the `shareMeta.js` fail-open pattern | Any error → `next()`. Tagging never breaks a page. |
| **AD-19** | Injection must be idempotent | Skip if the container ID is already present in the document. |
| **AD-20** | Cover existing and future application-served pages | Coverage by default; exclusion only by the explicit rules in §9.6. |

**Second round of owner decisions, 2026-07-30 — binding:**

| # | Decision | Binding form |
|---|---|---|
| **AD-21** | **Marketing canonical = `https://www.advantage.bid`** | `www` is canonical for all Brilliant Directories marketing, SEO, directory, city/state, article and company pages. The apex `advantage.bid` 301s to `www`. Resolves open item **Q-A**. |
| **AD-22** | **Application canonical = `https://bid.advantage.bid`** | Unchanged, now formally recorded. All auction, lot, estate-sale and member pages canonicalise here. |
| **AD-23** | Railway is the operational source of truth; Brilliant Directories is the marketing / SEO / CMS layer | Restates and confirms AD-13. No auction, lot, bid, invoice or event record is authoritative anywhere else. |
| **AD-24** | **PostgreSQL is the operational analytics source of truth. GA4 is behavioural analytics only.** | Sharper than v2.0's AD-12/13 split: GA4 answers *behaviour and acquisition*; every operational, financial or record-level number comes from Postgres. |
| **AD-25** | **Google Signals remains OFF** | No demographics, no cross-device modelling, no `ad_user_data` dependency. Avoids GA4 reporting thresholds at current volume. Revisit only by explicit owner decision. |
| **AD-26** | **Internal traffic suppression is role-first** | Authenticated user role is the primary mechanism; IP filtering is a **secondary safeguard only**. Confirms §7.4 layer ordering. |
| **AD-27** | **`analytics_uid` (HMAC) instead of internal UUIDs** | Approved. No internal database identifier is ever transmitted to GA4. §7.2 derivation stands; `ANALYTICS_UID_SECRET` handling still needs the storage decision (Q-I). |
| **AD-28** | **Four separate bid business events** | `bid_started`, `bid_submitted`, `bid_accepted`, `bid_rejected` remain distinct. The gap between `bid_submitted` and `bid_accepted` is the bid-failure rate and must stay measurable. |
| **AD-29** | **Bid rejections carry reason classes only** | Never an amount, never another bidder, never an identifier. Enumerated class list in §23.4. |
| **AD-30** | **No personally identifying information transmitted, anywhere** | §11.3 prohibited-data matrix is binding and enforced in code at two independent points. |
| **AD-31** | Canonical event taxonomy continues as designed | §10 stands. Extended, not revised, by §22 for imported events. |

**Owner objective as the acceptance standard:** the system must answer *where
users came from, what they engaged with, what they did, where they abandoned,
who became a buyer / bidder / purchaser / seller / repeat participant, and which
marketing effort produced verified revenue* — across both hosts, as one journey,
within consent and privacy limits, without collecting sensitive or identifying
data in GA4.

---

## 2. Authoritative configuration

| Field | Value |
|---|---|
| GA4 Property Name | `Advantage.Bid` |
| Primary website | `https://advantage.bid` |
| Stream Name | `Advantage.Bid Website` |
| Stream ID | `15353439652` |
| Measurement ID | `G-JM5JYGNJ6H` |
| GTM Container | **Not yet created** (Phase 0). ID lives in `GTM_CONTAINER_ID`; never committed. |
| MP API Secret | **Not yet created** (Phase 5). `GA4_API_SECRET`, server-side only, never in client code, never in GTM. |
| Properties | 1 |
| Web data streams | 1 |
| **Marketing canonical host** | `https://www.advantage.bid` (AD-21) — apex 301s to `www` |
| **Application canonical host** | `https://bid.advantage.bid` (AD-22) |
| Shared cookie domain | `.advantage.bid` (default `auto`) — covers both |

> **Standing rule.** `G-JM5JYGNJ6H` is the only measurement ID permitted anywhere
> in the estate. A second ID in a tag, template, widget, plugin, or BD setting is
> a defect and the primary cause of duplicate users.

Any property, stream, or measurement ID from an earlier document, browser
session, or Google account is out of scope.

---

## 3. Architecture as it actually exists

### 3.1 Topology

```
   ┌──────────────────────────────────────────────────────────────┐
   │  advantage.bid  /  www.advantage.bid       [Brilliant Dir.]  │
   │  Marketing · SEO · Directory · City & state pages · Articles │
   │  Company directory · Local events · Lead capture             │
   └───────────────┬──────────────────────────────────────────────┘
                   │  widget iframes (served from bid.advantage.bid)
                   │  canonical links
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  bid.advantage.bid                             [Railway]     │
   │  Express 5 · PostgreSQL · Socket.IO · Stripe · Cloudinary    │
   │  50 static HTML pages + JSON API                             │
   │  CANONICAL SOURCE OF TRUTH for auctions, lots, bids, money   │
   └──────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────┐
   │  advantageauction.bid         ⚠ TO BE RETIRED — see §15       │
   │  Separate registrable domain. Hard-coded live fallback.       │
   └──────────────────────────────────────────────────────────────┘
```

### 3.2 Verified facts

| Fact | Marker | Evidence |
|---|---|---|
| Canonical marketplace host is `bid.advantage.bid` | ✅ | canonical tags in all `public/*.html`; `CLAUDE.md:89` — "All auction records must live only in the Advantage Auction Platform at https://bid.advantage.bid" |
| Marketing hosts are `advantage.bid`, `www.advantage.bid` | ✅ | `src/routes/publicEvents.js:21-22` `EVENT_ORIGINS` default |
| Front end is **50 standalone static HTML files** | ✅ | `ls public/*.html \| wc -l` = 50; no template engine in `package.json` |
| No shared `<head>` partial exists | ✅ | all 50 carry their own head block |
| Fail-open pre-`express.static` head injection already proven | ✅ | `src/middleware/shareMeta.js`, mounted `server.js:164`; `express.static` at `server.js:381` |
| Helmet runs with CSP **disabled** | ✅ | `server.js:125` — `helmet({ contentSecurityPolicy: false })` |
| **Zero** GA4 / GTM / gtag / `G-` / `UA-` anywhere in the repo | ✅ | full-tree grep, zero hits |
| Two widgets already push to `window.dataLayer` behind a guard | ✅ | `public/widgets/marketplace-feed.js:31`, `public/widgets/featured-items.js:33` |
| First-party telemetry pipeline is production-grade | ✅ | migration 044, `analyticsService.js`, `routes/analytics.js`, `widgets/shared/analytics.js` |
| Stripe webhook at `/api/payments/webhook`, raw-body bypassed | ✅ | `server.js:388-391` |
| Webhook idempotency store exists (`stripe_webhook_events`) | ✅ | `server.js:566-568` health queries on `status='processed'` / `'failed'` |
| Soft-close / anti-snipe exists (`extended_until`) | ✅ | `src/routes/public.js:819`; `public/auction-view.html:1209,1285-1289`; `public/buyer-faq.html:244` (2-minute extension) |
| Seller following exists | ✅ | `/api/sellers/:id/follow`, `/api/sellers/following`; `seller-dashboard.html:1140` reads `followers_total`, `followers_7d`, `active_watchers` |
| Marketing package selection exists | ✅ | `/api/marketing/auctions/:id/package` |
| Public feedback endpoint exists | ✅ | `/api/public/feedback` |
| Terms acceptance flow exists | ✅ | `/api/terms/current`, `/api/terms/accept`, `/api/terms/me/acceptance` |
| Socket.IO events in use | ✅ | `lot:update`, `lot:winning`, `lot:outbid`, `auction:update`; join via `socket.emit('join…')` |
| `advantageauction.bid` hard-coded as live fallback | ✅ | `src/lib/publicUrls.js:16`; `.env.example:52` |
| `vercel.json` publishes `public/` to a second origin, `/` → `/demo.html` | ✅ | `vercel.json` |
| `auctions.advantage.bid` referenced as widget host | ✅ refs / ⚠ resolution | `widgets/shared/analytics.js:23`, `shared/config.js:25`, `featured-*.js` comments |
| `routes/analytics.js`, `analyticsService.js` ownership-restricted | ✅ | `agents/orchestration/ownership-matrix.md:45,47` |

### 3.3 Verification legend

Used throughout. **Do not treat an ⚠ item as confirmed.**

| Marker | Meaning |
|---|---|
| ✅ | Verified directly in source in the reviewed copy |
| ⚠ | Inferred from frontend `fetch()` calls or docs; server contract **not** verified |
| ❌ | Referenced but missing / not found in the reviewed copy |
| 🔒 | Requires owner, legal, or security approval before implementation |
| 🧪 | Requires staging verification before it can be marked ✅ |

### 3.4 Repository status — re-verified 2026-07-30 (v2.1)

**The v2.0 completeness caveat is lifted.** The full working tree is now
readable. All ~44 route modules, all services, all middleware and all client
shared scripts are present. Items that were ❌ in v2.0 because they were absent
from an incomplete upload are **not** defects — they existed all along.

Re-verified directly in source at this baseline:

| Previously | Now | Finding |
|---|---|---|
| `payments.js` ❌ | ✅ | Webhook at `POST /webhook` with `stripe.webhooks.constructEvent` signature verification; `charge-lot` and `charge-combined` both carry an `idempotency` middleware; `POST /:paymentId/refund` exists but is a stub |
| `watchlist.js` ❌ | ✅ | The add endpoint is **`POST /api/watchlist/add`** (v2.0 could not determine it) — plus `/remove` and `GET /` |
| `auth.js` ❌ | ✅ | `register` (400 validation, 409 duplicate), `login` (401 invalid, 403 suspended), `forgot-password`, `reset-password`, `me`. **New:** `GET /verify-email` — optional, non-blocking email confirmation that gates nothing |
| `authBridge.js` ❌ | ✅ | BD→App identity bridge, mounted only when `IDENTITY_BRIDGE_ENABLED === 'true'`. See §23.2 — it introduces a new analytics exclusion. |
| `widgetFraming.js` ❌ | ✅ | Sets **only** `frame-ancestors https://advantage.bid https://www.advantage.bid`. **No `script-src`.** §13.5 risk closed. |
| `lots.js`, `sellers.js`, `agreements.js`, `verification.js`, `invoices.js`, `terms.js`, `marketing.js`, `uploads.js`, `ai.js`, all `admin*.js` | ✅ | All present |
| `member-shell.js`, `bid-utils.js`, `auth-refresh.js` and other shared client scripts | ✅ | All present |

**New since v2.0** (Event Import Framework): `src/routes/adminEventImports.js`,
`src/services/eventImport/` (incl. `reviewQueue`), `src/services/discoveryService.js`,
`discoveryRankingService.js`, `bridgeIdentityService.js`, `bridgeCodeService.js`,
`bridgeHandlers.js`, `emailVerificationService.js`.

**Unchanged, as required by AD-11:** `src/services/analyticsService.js` and
`src/routes/analytics.js` both carry their original timestamps. The first-party
pipeline has not been touched. ✅

**⚠ markers still apply** to anything this document has not personally read at
this baseline. §16 remains the mechanism that closes them, now materially
smaller than it was in v2.0 — see §22.5 for the additions and §23.5 for what
Phase 0 no longer needs to establish.

---

## 4. What already exists — reuse, do not duplicate

### 4.1 The first-party pipeline (AD-11: preserve unchanged)

```
Widget / page
  └── AAPAnalytics.track()              public/widgets/shared/analytics.js      ✅
        └── POST /api/analytics/events  src/routes/analytics.js  (202, async)   ✅
              └── analyticsService       src/services/analyticsService.js        ✅
                    └── analytics_events db/migrations/044_...sql                ✅
```

| Component | Assessment |
|---|---|
| `analytics_events` + 7 tuned indexes | Production-ready. **Reuse. Do not migrate.** |
| `analyticsService.js` — PII key-strip, IP hashing, never throws | Production-ready. **Do not modify.** |
| `POST /api/analytics/events` — 100/IP/min, always 202, fire-and-forget | Production-ready. **Do not modify.** |
| `AAPAnalytics` client — `keepalive`, 30-min idle session TTL | Production-ready. **Do not modify.** |
| 10 existing event types | **Keep their names.** Do not rename to match GA4 (§10.3). |
| `docs/analytics-telemetry.md` naming discipline + `event_ver` | Reuse as the first-party half of one taxonomy. |
| Widget `dataLayer` pushes (`adv_*`, `adv_fi_*`) | **Already GTM-shaped.** Activate; do not rewrite. |
| DOM events `aap:*`, `advantage:feed:*`, `advantage:featured:*` | **Reuse as GA4 triggers.** No widget re-instrumentation needed. |

### 4.2 Division of responsibility (AD-12 / AD-13 / AD-14)

| | GA4 `G-JM5JYGNJ6H` | Postgres / `analytics_events` |
|---|---|---|
| Answers | Where demand came from, what it cost, whether it converted | What happened, to whom, for how much |
| Authoritative for | Channel, campaign, landing page, funnel step, content engagement | Auctions, lots, bids, invoices, payments, revenue, fees, settlements |
| Survives ad blockers | No (~10–30% loss) | **Yes** |
| Survives consent refusal | No | Yes (no PII, no cross-site identifier) |
| Retention | 14 months (GA4 ceiling) | Your policy: 90 days raw → aggregates |
| Joinable to your DB | Only via BigQuery export | Natively |

Every number a seller sees, every settlement, every reconciliation: Postgres.
GA4 never appears in a seller-facing or financial report (AD-14).

### 4.3 Explicitly not to be duplicated

1. Widget clicks — `advantage:feed:card_opened` and
   `advantage:featured:item_click` already fire. GA4 listens; it does not
   re-detect.
2. `analyticsService.js` must never emit to GA4. The Measurement Protocol sender
   is a **separate module** with no coupling to it.
3. No third session identifier. `AAPAnalytics` has one, GA4 has one; they are
   joined in BigQuery (§7.6), never merged at collection time.

---

## 5. Deployment architecture

### 5.1 GTM container design (AD-3, AD-7, AD-8)

One container, two hosts, three tag classes. Nothing else may exist in it.

| Class | Contents | Trigger source |
|---|---|---|
| **A. Configuration** | Exactly one GA4 Configuration tag (`G-JM5JYGNJ6H`) | Initialization — All Pages |
| **B. Event** | One GA4 Event tag per event name in §10 | Custom Event trigger matching a `dataLayer` event name |
| **C. Marketing** | Ads / Meta / LinkedIn conversion tags added later | Custom Event trigger only, never auto-triggers |

**Container rules — these are the AD-8 guardrails made concrete:**

1. All built-in variables for Click, Form, Scroll, Element Visibility, YouTube:
   **disabled**. If they are not enabled, nobody can build a fragile trigger.
2. No Custom HTML tag may fire on the money paths. A **global blocking trigger**
   matches `Page Path` against
   `/payment.html|/add-card.html|/invoices.html|/billing.html|/lot.html` and is
   attached as an exception to every Custom HTML tag. GA4 Event tags are
   allow-listed past it; arbitrary third-party HTML is not.
3. **No tag may fire on a `/widgets/*` URL** (AD-9). Second line of defence
   behind the middleware exclusion — belt and braces, because this failure mode
   is silent.
4. Publish rights: one named owner (§19 Q8). Everyone else gets Edit.
5. Every container version gets a description naming the phase and the event(s)
   added. A container with unexplained versions cannot be audited.
6. GTM loads **async**, in `<head>`, after preconnect hints — Core Web Vitals
   feed SEO, and SEO is a guiding principle.

### 5.2 `src/middleware/analyticsTag.js` (AD-17, AD-18, AD-19, AD-20)

New file. Modelled on `shareMeta.js` ✅, which the codebase already describes as
"fast, head-only, and FAIL-OPEN". **Do not extend `shareMeta.js` itself** — its
own header calls it "the highest-risk item in this codebase", and a tagging bug
must never be able to break share meta, canonical URLs, or JSON-LD.

| Property | Requirement |
|---|---|
| Mount order | After `shareMeta` (`server.js:164`), before `express.static` (`server.js:381`) |
| Scope | `GET` requests resolving to an `.html` document under `public/` |
| **Exclusions** | `/widgets/*` (AD-9) · any path in the §9.6 exclusion list · non-HTML responses |
| **Idempotency** (AD-19) | If the response body already contains the container ID, **skip**. Double injection becomes structurally impossible, not merely unlikely. |
| Injection point | Immediately after `<head>` opens, before other scripts, so the bootstrap is present before page scripts push to `dataLayer` |
| `dataLayer` init | The injected block creates `window.dataLayer = window.dataLayer \|\| []` **before** the container loads, so early pushes are never lost |
| Failure mode | Whole body in `try/catch` → `next()`. A tagging failure serves the untagged page. |
| Kill switch | `ANALYTICS_TAG_ENABLED=false` → middleware no-ops. **No deploy required**; effective on the next request. |
| Config | `GTM_CONTAINER_ID` env var. No ID in source control. |
| Caching | Templates read and cached at module load, exactly as `shareMeta.js` does |
| Future pages | Any new `public/*.html` is tagged automatically with zero developer action (AD-20) |

One file, one env var, every current and future page. That is the requirement
met without touching 50 files.

### 5.3 Widget bridge (AD-9, AD-10)

`public/widgets/marketplace-feed.html` and `featured-items.html` are served from
`bid.advantage.bid` and iframed into BD pages on `advantage.bid`. Tagging them
independently would produce, per BD page view: two `page_view` hits, a
`page_location` no human visited, and a self-referral session. All three are
invisible in casual QA and fatal to session metrics.

**The bridge, in one direction only:**

```
iframe (bid.advantage.bid/widgets/*)   — NOT tagged, never
   │  document.dispatchEvent('advantage:feed:*' | 'advantage:featured:*')   ✅ exists
   │  window.parent.postMessage({...}, targetOrigin)                        ✅ exists
   ▼
parent page (advantage.bid or bid.advantage.bid)
   │  marketplace-embed.js listener  ✅ exists — extend it
   ▼
   AdvDL.push(event, params)  →  dataLayer  →  GTM  →  GA4
```

**Bridge security requirements (🔒):**

- The parent listener must validate `event.origin` against an explicit allow-list
  (`marketplace-embed.js:17,29` ✅ already has an origin allow-list — extend, do
  not weaken it).
- Only an **allow-listed set of event names** is translated. An unknown event
  name from an iframe is dropped, not forwarded. A `postMessage` bridge that
  forwards arbitrary payloads into `dataLayer` is an injection vector.
- Payload fields are whitelisted by key and type-checked before forwarding. The
  §11.3 prohibited-key list applies here identically.

---

## 6. Cross-domain, referrals, and duplicate prevention

### 6.1 Cross-domain: not required, conditional on four preconditions (AD-6)

`advantage.bid` and `bid.advantage.bid` share the registrable domain
`advantage.bid`. With the default `cookie_domain: auto`, the Google tag writes
`_ga` on `.advantage.bid`, readable by every subdomain. Client ID and session
survive the hop with no `_gl` linker and no domain configuration.

**All four must hold. If any fails, AD-6 fails with it:**

1. Both hostnames run the **same measurement ID** (`G-JM5JYGNJ6H`). ✅ by AD-2.
2. No custom `cookie_domain`, `cookie_prefix`, or `cookie_flags` is set
   anywhere. Leave all three at default.
3. **Both hostnames are actually tagged.** An untagged hop creates a session gap
   that looks exactly like a broken cookie.
4. Redirects between the hosts **preserve the query string** (§8.4). A redirect
   that drops `?utm_*` / `?gclid` breaks attribution even though the cookie
   survives — different failure, same symptom.

Adding cross-domain measurement for these two hosts would be harmless but
pointless, and would append `?_gl=…` to internal links, cluttering URL-based
reporting.

🧪 **This is proven at the Phase 2 gate, not assumed.**

### 6.2 Boundary table

| Boundary | Same registrable domain | Treatment |
|---|---|---|
| `advantage.bid` → `bid.advantage.bid` | Yes | Nothing needed. Shared cookie. |
| `www.advantage.bid` → `advantage.bid` | Yes | Nothing needed. Pick one canonical, 301 the other (§8.4). |
| `bid.advantage.bid` → `advantageauction.bid` | **No** | **Retire the domain** (§15, approved). Until retired: unwanted referral + clean 301. |
| Page → Stripe 3-D Secure → back | No | Unwanted referral (§6.3). Not cross-domain — the return is a redirect, not a link, so `_gl` cannot help. |
| BD page → widget iframe | Yes | **Do not tag the iframe** (AD-9). |
| Anything → `*.up.railway.app` | No | Must not be user-facing in production. Unwanted referral as insurance. |
| Anything → `*.vercel.app` | No | §13.4 — confirm whether live at all. |

### 6.3 Unwanted referrals (referral exclusion)

**Admin → Data collection and modification → Data streams → `Advantage.Bid
Website` → Configure tag settings → List unwanted referrals.**

An unexcluded referral **starts a new session and overwrites its attribution**.
Each entry below prevents a specific, real misattribution.

| Match | Value | Prevents |
|---|---|---|
| contains | `advantage.bid` | Self-referral across `advantage.bid`, `www.`, `bid.`, and widget iframes. Costs nothing; blocks a whole class of silent breakage. |
| contains | `stripe.com` | `checkout.stripe.com`, `js.stripe.com` |
| contains | `hooks.stripe.com` | **The critical one.** 3-D Secure step-up redirects here and back. Without it, a card-authenticated purchase is attributed to `hooks.stripe.com / referral` and the true source loses the conversion. |
| contains | `advantageauction.bid` | Only while the domain is live (§15). Remove after retirement. |
| contains | `up.railway.app` | Staging/preview hops polluting production attribution |
| contains | `vercel.app` | Same, if §13.4 finds a live deployment |

**Do NOT exclude:** search engines, `chatgpt.com`, `perplexity.ai`, or any AI
surface — excluding them destroys the AI-referral data §18.7 depends on.
Never exclude `google.com`; it would break organic attribution entirely.

### 6.4 Session timeout

**Configure tag settings → Adjust session timeout: 30 minutes → 1 hour.**

Live bidding sessions routinely exceed 30 minutes while a user watches a lot
close without interacting. At the default, one bidding session becomes three,
tripling session counts and destroying engagement-rate reporting. Anti-snipe
extensions (`extended_until` ✅) make this worse, not better.

### 6.5 Duplicate prevention — standing checklist

**No duplicate page views**

| Control | Mechanism |
|---|---|
| One container per document | AD-19 idempotency guard |
| No GA4 in widget iframes | AD-9 middleware exclusion **plus** §5.1 rule 3 container-level block |
| No second tag from BD | §14 audit — mandatory before Phase 2 |
| No SPA double-count on `/app.html` ❌ | `member-shell.js` is missing from the reviewed copy. **Rule: Enhanced Measurement "History changes" stays ON, and the shell must not push a manual `page_view`.** 🧪 verified at the Phase 1 gate. |
| No duplicate hosting | §13.4 — Vercel origin must be resolved before Phase 1 |

**No duplicate users**

- One measurement ID (AD-2); default `cookie_domain: auto`, never overridden.
- No second data stream, ever (AD-4).
- `user_id` set only per §7, always the same pseudonymous ID for the same person.

**No duplicate events**

- One `dataLayer.push()` per business action, from one place in code (AD-7).
- Auto-triggers disabled (AD-8).
- `purchase` server-side only; the client-side tag is **absent** (AD-15, AD-16).
- Widget events translated by the parent only (AD-10).
- Every server-side event carries a deterministic `event_id` (§10.4) so
  duplicates are detectable after the fact rather than merely unlikely.

**No broken attribution**

- Unwanted referrals configured before any paid campaign (§6.3).
- Query strings preserved through every redirect and login handoff (§8.4).
- Session timeout at 1 hour (§6.4).
- `purchase` carries the checkout-time `session_id` (§7.5) so revenue lands on
  the originating session, not a new direct one.
- `advantageauction.bid` retired (§15).

---

## 7. User and session identity model

The most complete identity model that is permissible, and no more. The
constraint is not technical — it is that GA4 must never hold data that
identifies a person.

### 7.1 Identifier inventory

| Identifier | Scope | Where it lives | Sent to GA4 | Notes |
|---|---|---|---|---|
| GA4 `client_id` | Device + browser | `_ga` cookie on `.advantage.bid` | Yes (by the tag) | Anonymous. Spans both hosts (AD-5). |
| GA4 `session_id` | Session | `_ga_<STREAM>` cookie | Yes (by the tag) | 1-hour timeout (§6.4) |
| `AAPAnalytics` session token | Session | `localStorage`, 30-min idle TTL | **No** | ✅ existing. Not user-linked by design. Leave it that way. |
| Internal user UUID | Account | Postgres | **NEVER** | Raw DB identifier. Prohibited in GA4 (§11.3). |
| **`analytics_uid`** | Account | Derived server-side | **Yes, as `user_id`** | **New.** See §7.2. |
| Stripe customer / PaymentIntent ID | Payment | Stripe + Postgres | **NEVER** | Prohibited (§11.3) |
| Email, name, phone, address | Person | Postgres | **NEVER** | Prohibited (§11.3) |

### 7.2 `analytics_uid` — the pseudonymous account identifier 🔒

**Recommendation:** do not send the raw internal user UUID as GA4 `user_id`. Send
a derived, stable, non-reversible identifier:

```
analytics_uid = base64url( HMAC-SHA256( key = ANALYTICS_UID_SECRET,
                                        msg = internal_user_uuid ) )[0..21]
```

| Property | Rationale |
|---|---|
| Stable | Same user, same ID, forever — cross-device and cross-session joining works |
| Non-reversible | A GA4 export leak does not expose a database key |
| Not a DB key | Cannot be used to query, enumerate, or join against production data by anyone holding only GA4 access |
| Server-derived | Computed server-side, delivered to the client on session bootstrap. Never derived in browser JS, or the secret would be public. |
| Rotatable | Rotating `ANALYTICS_UID_SECRET` severs all historical linkage — the mechanism that satisfies a deletion request (§11.5) |
| Same value both hosts | So the authenticated journey is continuous across `advantage.bid` and `bid.advantage.bid` |

This directly satisfies the owner direction: *prefer a stable pseudonymous
analytics identifier; never send emails or names; never send raw internal
database identifiers if they create unnecessary exposure.*

🔒 Requires owner sign-off on the derivation and on where the secret is stored.
❌ The bootstrap that would deliver it (`auth-refresh.js` / `member-shell.js`) is
missing from the reviewed copy — §16 must locate the correct delivery point.

### 7.3 User properties (user-scoped, max 25)

Set **only** these. Every one is a low-cardinality behavioural class, not an
attribute of a person.

| Property | Values | Purpose |
|---|---|---|
| `user_type` | `anonymous` \| `buyer` \| `seller` \| `organizer` \| `both` | Segments every report by role |
| `seller_status` | `none` \| `enrolled` \| `agreement_signed` \| `payout_ready` \| `active` | Seller funnel stage as a durable property |
| `verification_status` | `none` \| `pending` \| `verified` | Explains `bid_rejected` reasons |
| `buyer_stage` | `visitor` \| `registered` \| `bidder` \| `purchaser` \| `repeat_purchaser` | The owner's core question, as one dimension |
| `first_market` | e.g. `TX-Dallas` | Cohorting by market of origin |
| `account_age_bucket` | `0-7d` \| `8-30d` \| `31-90d` \| `90d+` | Bucketed, never a signup date (a date plus behaviour is re-identifying) |

**Prohibited as user properties:** seller revenue, GMV, settlement balance,
payout status, fee tier, invoice totals, verification document type, or any
financial or sensitive account value. Stated explicitly in the owner direction
and repeated in §11.3.

### 7.4 Internal and admin traffic exclusion (required)

Admin behaviour stays in first-party operational analytics (§9.5), and internal
traffic must not pollute marketing reporting. **Three layers, because any single
one fails:**

| Layer | Mechanism | Catches |
|---|---|---|
| 1. IP filter | GA4 → Admin → Data streams → Configure tag settings → Define internal traffic → `traffic_type=internal`; then Data filters → Internal Traffic → **Testing mode first**, Active after 7 days of validation | Office / known static IPs |
| 2. Role-based suppression | When the authenticated session has an admin or staff role, the app sets `traffic_type: 'internal'` on the GA4 config. **This is the reliable layer** — it follows the person to any network. ⚠ depends on the auth bootstrap (§16) | Admin on any IP, including home and mobile |
| 3. Environment gate | `ANALYTICS_TAG_ENABLED=false` on staging; if ever true there, GA4 must use a **separate debug property**, never `G-JM5JYGNJ6H` | Staging, preview, local, CI |

Layer 2 is the one that matters. IP filters fail the moment an admin works from
home; a role-based flag does not.

Additionally: developer/test traffic is kept out by never pointing a non-production
environment at the production measurement ID. That is a hard rule, not a
preference.

### 7.5 Pre-login → authenticated stitching (what is actually supported)

The honest boundary, because the owner direction explicitly asks not to attempt
prohibited stitching:

| Scenario | Supported? | Mechanism |
|---|---|---|
| Anonymous browsing → login **in the same session, same device** | ✅ Yes | Same `client_id` throughout. When `user_id` is set mid-session, GA4 associates that session's events — including the pre-login ones — with the user. This is the normal, supported path and it covers most real registrations. |
| Anonymous on device A → login later on device A | ✅ Yes | `client_id` persists in `_ga`. Historical sessions on that device are attributable to the user in User-ID-enabled reporting. |
| Anonymous on device A → login on device B | ⚠ Partial | Only **after** login on both. GA4 unifies forward-looking activity by `user_id`. **Pre-login activity on device B cannot be retroactively attached.** |
| Cross-device attribution without login | ❌ No | Would require Google Signals (§11.4) or fingerprinting. Signals brings reporting thresholds; fingerprinting is prohibited. |
| Joining GA4 identity to a named person | ❌ Never | Out of scope by design. |

**Set `user_id` at every authenticated page load, not only at the login event.**
A user who returns already-authenticated never fires `login`, and if `user_id` is
only set on that event, their entire return session is anonymous. This is the
single most common User-ID implementation bug.

**Reporting identity:** set to **Observed** (User-ID, then device). Not Blended —
Blended's modelling needs Consent Mode plus volume neither of which exists at
launch, and it makes early numbers look more certain than they are.

### 7.6 Where the two identity systems meet

They do **not** meet at collection time (AD-11, §4.3). They meet in BigQuery:

- GA4 → BigQuery daily export supplies `user_pseudo_id` (client ID), `user_id`
  (`analytics_uid`), session, channel, campaign.
- Postgres supplies the authoritative record, keyed by internal UUID.
- The join key is `analytics_uid`, computable from Postgres with the same HMAC.

This keeps `analytics_events` exactly as designed — non-identifying, unlinkable
to a person from inside the analytics store — while still permitting authorised
full-journey analysis in the warehouse.

**Enable the BigQuery export in Phase 0.** It is free at this scale, it is the
only durable record past GA4's 14-month ceiling, and **it does not backfill** —
every day it is off is permanently lost.

---

## 8. Acquisition and attribution

### 8.1 Channel coverage

| Channel | GA4 detection | Action required |
|---|---|---|
| Organic search | Automatic | Link Search Console (§13.1) |
| **AI search / AI referrals** | **Not automatic** | Custom channel group (§8.2) |
| Direct | Automatic | Minimise false direct via §8.4 |
| Paid search | `gclid` auto-tagging | Link Google Ads; enable auto-tagging |
| Paid social | Manual | UTM policy (§8.3) |
| Organic social | Automatic (partial) | UTM where a link is controlled |
| Email (transactional + marketing) | **Manual** | UTM on every link; §15 changes these templates anyway — do both at once |
| Referral partners | Automatic | Review referral report monthly |
| **Seller websites** | Automatic (referral) | Give sellers UTM-tagged links so their traffic is attributable, not lumped into generic referral |
| **Embedded widgets on third-party sites** | Referral from host page | Widget outbound links must carry `utm_source=<host>&utm_medium=widget` |
| City / state pages (BD) | Internal | `content_group` (§9.1) + directory→marketplace handoff metric |
| Articles / Latest News | Internal | `content_group=article` |
| Marketplace discovery | Internal | `view_item_list` / `select_item` |
| Auction-company referrals | Automatic | UTM-tagged partner links |
| **QR codes** | Manual | Every QR encodes a UTM-tagged URL. An untagged QR is permanently unattributable. |
| Offline promotions | Manual | Vanity URL → 301 that **preserves** UTMs (§8.4) |

### 8.2 AI search / AI referral channel group

GA4 has no built-in AI channel. Build one in **Admin → Data display → Channel
groups → Create custom channel group**, matching `Source` against:

```
chatgpt.com · chat.openai.com · openai.com · perplexity.ai · claude.ai ·
gemini.google.com · bard.google.com · copilot.microsoft.com · bing.com/chat ·
you.com · poe.com · grok.com · x.ai · duckduckgo.com/aichat · mistral.ai ·
phind.com · andi.search · komo.ai
```

Place the AI rule **above** Organic Search and Referral in the rule order, or
those channels will claim the traffic first. Review the source list quarterly —
this space moves faster than GA4's defaults.

Crawler visibility (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`,
`CCBot`) is invisible to GA4 and must come from Railway logs. It belongs on the
AI dashboard (§18.7) as a leading indicator: crawl precedes citation, citation
precedes referral.

### 8.3 UTM naming policy — canonical and enforced

Inconsistent UTMs are the most common cause of unusable campaign reporting, and
they are unfixable retroactively.

**Rules**

1. **Lowercase always.** GA4 is case-sensitive: `Facebook` and `facebook` are two
   channels forever.
2. **Hyphens, never spaces or underscores**, in `campaign` and `content`.
3. **Never UTM-tag an internal link.** An internal UTM starts a new session and
   overwrites the original acquisition source — it destroys the very attribution
   it appears to create. Internal link tracking uses `dataLayer` events, never
   UTMs.
4. **Never manually tag a Google Ads link** — `gclid` auto-tagging handles it,
   and manual UTMs override and degrade it.

**Parameter conventions**

| Parameter | Allowed values | Example |
|---|---|---|
| `utm_source` | the specific platform or partner, lowercase | `facebook`, `mailchimp`, `estatesales-org`, `qr-yardsign` |
| `utm_medium` | **closed vocabulary — do not invent values** | `cpc`, `paid-social`, `organic-social`, `email`, `referral`, `widget`, `qr`, `print`, `affiliate`, `sms` |
| `utm_campaign` | `<audience>-<objective>-<yyyymm>` | `seller-acquisition-202608`, `buyer-dallas-launch-202608` |
| `utm_content` | creative or placement variant | `hero-a`, `footer-cta`, `card-3` |
| `utm_term` | paid keyword only | `estate+auction+dallas` |

**Audience prefix convention** (`utm_campaign` starts with one of):
`buyer-` · `seller-` · `organizer-` · `brand-` · `local-`
This single convention makes buyer CAC and seller CAC separable without any
additional configuration — do it from the first campaign.

**Governance:** maintain one campaign-URL builder sheet. Any URL not generated
from it is unsupported. 🔒 Owner names the person accountable for it.

### 8.4 Attribution-erasing hazards — audit list

Every item below silently converts an attributed session into `direct`. Each
must be checked (🧪) before Phase 6.

| Hazard | Why it erases attribution | Check |
|---|---|---|
| **`advantageauction.bid` fallback** ✅ exists | Different registrable domain → new cookie, new user, new session | §15 retirement |
| **Redirect stripping query strings** | `?utm_*` / `?gclid` lost → `direct` | Test every 301/302 on both hosts with a UTM-tagged URL |
| `vercel.json` `/` → `/demo.html` ✅ | Root redirect; confirm it preserves the query string | §13.4 |
| **Login handoff** ⚠ `authBridge.js` ❌ missing | A BD↔Advantage identity bridge that redirects can drop params and cause a self-referral | §16 |
| **Payment return URLs** ⚠ | Stripe return URL must return to the **same** registrable domain and preserve params | §16 + §6.3 |
| **3-D Secure via `hooks.stripe.com`** | New referral session over the purchase | §6.3 unwanted referral |
| BD template rewriting inbound URLs | Some BD themes normalise/strip query strings on redirect | §14 audit item 14 |
| `www` ↔ apex inconsistency | Two hostnames indexed and linked → split reporting, split SEO | Choose one canonical, 301 the other |
| Widget outbound links without UTMs | Third-party widget traffic lumped as undifferentiated referral | §8.1 |
| Email links on the old domain | Cross-domain hop plus a retired-domain redirect | §15 |
| QR / print without UTMs | Permanently unattributable | §8.3 |


---

## 9. Site-area measurement matrix

Every meaningful area of both sites, classified. This is the coverage contract.

### 9.1 Classification codes

| Code | Meaning |
|---|---|
| **PV** | Pageview / content measurement — automatic `page_view` + `content_group` |
| **ENG** | Engagement measurement — scroll, interaction, dwell, element-level events |
| **FUN** | Funnel measurement — an explicit step in a defined funnel |
| **CNV** | Conversion measurement — a GA4 key event |
| **OPS** | Operational-only — first-party / Postgres, **not** GA4 |
| **SRV** | Server-side authoritative — GA4 Measurement Protocol and/or Postgres truth |
| **EXC** | Excluded for privacy / security |
| **NYV** | Not yet verified — needs §16 confirmation before instrumenting |

**Content groups** (set on every page; this is what makes reporting legible):
`marketing` · `directory` · `article` · `company` · `marketplace` · `auction` ·
`lot` · `estate_sale` · `seller` · `account` · `checkout` · `legal` · `admin`

### 9.2 Public marketing & discovery

Host key: **BD** = `advantage.bid` · **APP** = `bid.advantage.bid`

| Area | Host | Class | Key events | Status |
|---|---|---|---|---|
| Homepage (BD) | BD | PV, ENG | `page_view`, `view_promotion` | 🧪 |
| Homepage / Living Map (`index.html`) | APP | PV, ENG, FUN | `page_view`, `map_opened`, `view_item_list` | ✅ |
| Search (`search.html`) | APP | PV, ENG, FUN | `search`, `view_search_results`, `search_no_results` | ✅ |
| Location search / near-me | APP | ENG, FUN | `location_set`, `location_failed`, `radius_changed` | ✅ |
| City pages | BD + APP | PV, ENG, FUN | `page_view` (`content_group=directory`), `city_page_viewed` | ✅ APP / 🧪 BD |
| State pages | BD | PV, ENG | `page_view` | 🧪 |
| Category pages (`browse-categories.html`) | Both | PV, ENG, FUN | `view_item_list`, `select_item` | ✅ |
| Location index (`browse-locations.html`) | APP | PV, ENG | `page_view`, `select_content` | ✅ |
| Latest News / Articles | BD | PV, ENG | `page_view` (`content_group=article`), scroll depth, `article_cta_clicked` | 🧪 |
| Company directory | BD | PV, ENG, FUN | `page_view` (`content_group=company`), `company_profile_viewed`, `company_contact_clicked` | 🧪 |
| Seller / company profile (APP) | APP | PV, ENG, FUN | `seller_profile_viewed`, `seller_followed` | ⚠ `/api/sellers/…` |
| Marketplace map | APP | ENG, FUN | `map_opened`, `map_interacted`, `map_marker_clicked` | ✅ |
| Marketplace list | APP | PV, ENG, FUN | `view_item_list`, `feed_filter_changed`, `feed_paginated` | ✅ |
| Estate sale feed | Both | PV, ENG | `view_item_list` (`list=estate_sales`) | ✅ |
| Auction feed | Both | PV, ENG | `view_item_list` (`list=auctions`) | ✅ |
| Featured auctions (`featured-auctions.html`) | Both | PV, ENG | `view_promotion`, `select_promotion` | ✅ |
| Featured marketplace items (widget) | BD via iframe | ENG | parent-translated `view_promotion` / `select_promotion` (AD-10) | ✅ |
| Ending soon (`ending-soon.html`) | APP | PV, ENG, FUN | `view_item_list`, `select_item` | ✅ |
| Ships nationwide (`shipping-available.html`) | APP | PV, ENG | `shipping_filter_toggled` | ✅ |
| Event / estate-sale detail (`event.html`) | APP | PV, ENG, FUN | `view_estate_sale` | ✅ |
| Auction detail (`auction-view.html`) | APP | PV, ENG, FUN | `view_auction`, `view_item_list`, `select_item` | ✅ |
| Lot detail (`lot.html`) | APP | PV, ENG, FUN | `view_item` | ✅ |
| Past auctions (`past-auctions.html`) | APP | PV, ENG | `page_view`, `view_item_list` | ✅ |
| Recent results | APP | PV, ENG | `view_item_list` (`list=results`) | 🧪 |
| Featured items crawl page (`/items`, SSR) | APP | PV | `page_view`; SEO surface | ✅ |
| Contact / lead generation | Both | FUN, **CNV** | `generate_lead` (form **submission only**, never contents) | 🧪 BD |
| Feedback (`/api/public/feedback`) | APP | ENG | `feedback_submitted` (no contents) | ⚠ |
| How it works / FAQ / guides | Both | PV, ENG | `page_view`, scroll depth | ✅ |
| Legal (`terms`, `privacy`, `buyer-terms`) | APP | PV | `page_view` only | ✅ |
| Sitemap page, `sitemap.xml` | APP | PV | no instrumentation needed | ✅ |

### 9.3 Buyer journey

| Step | Class | Event(s) | Status |
|---|---|---|---|
| Account creation started | FUN | `registration_started` | ⚠ `/api/auth/register` |
| Account creation completed | **CNV** | `registration_completed` → GA4 `sign_up` | ⚠ |
| Login | FUN | `login` | ⚠ `/api/auth/login` |
| **Authentication errors** | FUN | `auth_failed` with `reason` **class only** (`invalid_credentials` \| `locked` \| `expired` \| `unverified`). **Never** the submitted identifier. | ⚠ 🔒 |
| Password reset | FUN | `password_reset_requested`, `password_reset_completed` — no identifiers | ⚠ |
| Terms acceptance | FUN | `terms_accepted` with `terms_version` | ⚠ `/api/terms/accept` |
| Auction browsing | ENG, FUN | `view_item_list`, `select_item`, `view_auction` | ✅ |
| Search and filters | ENG, FUN | `search`, `feed_filter_changed`, `view_search_results` | ✅ |
| Map interaction | ENG | `map_opened`, `map_interacted`, `radius_changed` | ✅ |
| Auction card previews | ENG | `select_item` with `item_list_id` | ✅ |
| Lot views | FUN | `view_item` | ✅ |
| Watchlist add | **CNV** | `watchlist_added` → GA4 `add_to_wishlist` | ⚠ `bid-utils.js` ❌ missing |
| Watchlist remove / view | ENG | `watchlist_removed`, `view_wishlist` | ⚠ |
| Following sellers | ENG, FUN | `seller_followed`, `seller_unfollowed` | ⚠ `/api/sellers/:id/follow` |
| Bid initiation | FUN | `bid_started` | ✅ UI / ⚠ contract |
| Bid submission | FUN | `bid_submitted` (`bid_type`: `direct` \| `proxy_max`) | ⚠ `/api/lots/:id/bids` |
| Bid accepted | **CNV** | `bid_accepted` — the primary GMV leading indicator | ⚠ |
| Bid rejected | FUN | `bid_rejected` with `reason` class (`below_increment` \| `auction_closed` \| `not_verified` \| `auth_required` \| `server_error`) | ⚠ |
| Outbid | ENG, FUN | `user_outbid` ← Socket.IO `lot:outbid` | ✅ |
| Winning state | ENG | `bid_winning` ← Socket.IO `lot:winning` | ✅ |
| **Anti-snipe extension** | ENG | `auction_extended` (`extension_seconds`, `lot_id`) ← `extended_until` change. **A distinctive competitive signal — instrument it.** | ✅ field / 🧪 event |
| Ending-soon engagement | ENG | `ending_soon_viewed`, `countdown_engaged` | ✅ |
| Winning outcome | **CNV** | `auction_won` | ⚠ `/api/lots/:id/winner-status` |
| Losing outcome | ENG | `auction_lost` — the retention-opportunity signal | ⚠ |
| Invoice views | FUN | `view_invoice` (counts and totals only) | ⚠ `/api/invoices/mine/combined` |
| Checkout started | FUN | `checkout_started` → GA4 `begin_checkout` | ⚠ `/api/payments/charge-*` |
| Payment started | FUN | `payment_started` | ⚠ |
| Payment method added | FUN | `add_payment_info` (`payment_type` only) | ⚠ `/api/payments/card-on-file` |
| Payment failed | FUN | `payment_failed` with `reason_code` class only | ⚠ SRV preferred |
| **Payment completed / purchase** | **CNV, SRV** | `purchase` — **server-side only** (AD-15/16) | ⚠ `payments.js` ❌ |
| Pickup information | ENG | `pickup_info_viewed` | 🧪 |
| Repeat purchasing | CNV | `purchase` + `buyer_stage=repeat_purchaser` | SRV |
| Return visits | PV | automatic (returning user) | ✅ |

### 9.4 Seller journey

| Step | Class | Event(s) | Status |
|---|---|---|---|
| Start Selling (`start-selling.html`) | PV, FUN | `page_view`, `seller_cta_clicked` | ✅ |
| Seller education (`seller-faq`, `how-sellers-get-paid`, `seller-pilot`, `after-estate-sale`, `downsizing-liquidation`) | PV, ENG | `page_view` (`content_group=seller`), scroll depth | ✅ |
| Seller account creation | FUN | `registration_started` / `_completed` with `lead_type=seller` | ⚠ |
| Seller agreement viewed | FUN | `agreement_viewed` | ⚠ `/api/agreements/:id` |
| Seller agreement signed | **CNV** | `agreement_signed` (`hours_to_sign`) | ⚠ `/api/agreements/:id/sign` |
| Seller onboarding start | FUN | `seller_onboarding_started` (`entry_point`) | ⚠ `/api/agreements/onboarding-status` |
| Onboarding steps | FUN | `seller_onboarding_step` (`step_number`, `step_name`) | ⚠ |
| Seller type selection | FUN | `seller_type_selected` (`seller_type`) | ⚠ `/api/sellers/enroll` |
| Payout profile | FUN | `payout_profile_started`, `payout_profile_completed`. **Never** bank, tax, or account values. | ⚠ 🔒 |
| Verification | FUN | `verification_started`, `verification_submitted` (`document_count` only — **never** document type or contents) | ⚠ 🔒 |
| Onboarding complete | **CNV** | `seller_onboarding_completed` | ⚠ |
| Auction creation start | FUN | `auction_create_started` | ✅ page / ⚠ contract |
| Draft saving | FUN | `auction_draft_saved` (`auction_id`, `is_draft`) | ⚠ `POST/PATCH /api/auctions` |
| Lot creation | FUN | `lot_created` (`image_count`, `used_ai_description`) | ⚠ `POST /api/lots` |
| Image / video upload | ENG | `media_uploaded` (`media_type`, `count`) | ⚠ `/api/uploads/*` |
| AI description | ENG | `ai_description_generated` (`accepted`) | ⚠ `/api/ai/generate-description` |
| Auction submission | **CNV** | `auction_submitted` (`lot_count`) | ⚠ |
| Moderation status viewed | ENG | `moderation_status_viewed` (`status`) | ⚠ |
| Publishing | **CNV** | `auction_published` (`hours_draft_to_live`) | ⚠ / SRV preferred |
| Estate-sale submit / publish | FUN, CNV | `estate_sale_submitted`, `estate_sale_published` | ✅ `orgEvents.js` / `adminEvents.js` |
| Auction performance page | ENG | `seller_performance_viewed` | ✅ `seller-dashboard.html` |
| Seller analytics | **OPS** | Postgres — `followers_total`, `active_watchers` ✅ already built | ✅ |
| Invoice status (seller view) | **OPS** | Postgres | — |
| Settlement review / history | **OPS, EXC from GA4** | Postgres only. Financial data never enters GA4 (AD-14). | — |
| Marketing package selection | FUN, **CNV** | `marketing_package_selected` (`package_tier` — **name only, no price**) | ⚠ `/api/marketing/auctions/:id/package` |
| Seller retention / repeat listings | CNV | `auction_published` + `seller_status` cohorting | SRV |

### 9.5 Admin & operations — OPS, excluded from marketing GA4

Per owner direction, admin behaviour stays in first-party operational analytics.
Internal traffic is excluded from GA4 by the three layers in §7.4.

| Area | Class | Source of truth | Notes |
|---|---|---|---|
| Auction moderation | OPS | Postgres state transitions | ✅ `adminEvents.js` publish/reject/return-to-draft/archive |
| Invoice administration | OPS | Postgres | ❌ route missing |
| Settlement review | OPS, EXC | Postgres | Financial — never GA4 |
| Verification | OPS, EXC | Postgres | Identity documents — never GA4 |
| Agreements | OPS | Postgres | ❌ route missing |
| Member / buyer administration | OPS, EXC | Postgres | Personal data — never GA4 |
| Marketplace administration | OPS | Postgres | ❌ route missing |
| Event import administration | OPS | Postgres | See `event-import-framework-plan.md` |
| Import exceptions | OPS | Postgres + logs | Ops dashboard §18.9 |
| Feedback reports | OPS | Postgres | `/api/public/feedback` ⚠ |
| Support workflows | OPS | Postgres | — |

**Why not GA4:** these are *latency and throughput* questions ("how long does a
submission sit in the queue"), answered exactly by database timestamps and only
approximately by client events — and sending them to GA4 would require leaving
internal traffic unfiltered, which would corrupt every acquisition report. Both
reasons point the same way.

### 9.6 Excluded from GA4 measurement (AD-20 exceptions)

| Surface | Reason |
|---|---|
| `/widgets/*` iframe documents | AD-9 — duplicate pageviews and self-referrals |
| `/api/*` | Not user-facing documents |
| Admin pages / authenticated admin surfaces | §7.4 internal exclusion |
| Payment credential entry fields (`payment.html`, `add-card.html` inputs) | **Never** instrument field-level interaction on card inputs. Page-level and outcome events only. |
| Verification document upload contents | Identity documents |
| Settlement / payout figures | Financial (AD-14) |
| Private messages, support threads | Owner direction: prohibited |
| Free-form form contents anywhere | Owner direction: submission events only, never contents |
| `robots.txt`, `sitemap.xml`, feeds | Non-HTML |
| Staging / preview / local environments | Never point at `G-JM5JYGNJ6H` |
| **`/auth/bd/return`** (identity-bridge seed page) | **🔒 Security.** This route returns an HTML page containing a signed JWT in an inline script. Loading a tag-manager-fetched third-party script into that document places remote code in the same origin and document as a live bearer token. **Never tag it.** It is also a zero-value interstitial that would pollute landing-page reports. See §23.2. |
| `/api/admin/event-imports/*` and the Admin Review Queue UI | Admin surface — operational measurement only (§22.4) |
| `/org/events/new` (route-served, not static) | Seller/organiser authoring surface; instrument via the page it renders, not the route |

---

## 10. Canonical event taxonomy

### 10.1 The event dictionary contract

Every event in this taxonomy is defined by these eighteen attributes. To keep the
dictionary readable, **attributes that are globally constant are stated once here
rather than repeated per event** — repeating them eighty times invites drift.

| Attribute | Where defined |
|---|---|
| Event name | §10.4 tables |
| Business purpose | §10.4 tables |
| Trigger | §10.4 tables |
| Client-side or server-side origin | §10.4 tables (`C` / `S`) |
| Hostname | §10.4 tables (`BD` / `APP` / `both`) |
| Page or component | §9 matrix + §10.4 |
| Required parameters | §10.4 tables |
| Optional parameters | §10.4 tables |
| **Prohibited parameters** | **§11.3 — global, applies to every event without exception** |
| User-property dependencies | §7.3 — `user_type`, `buyer_stage`, `seller_status` set before any funnel event |
| GA4 destination | All events → GA4 unless marked OPS/EXC in §9 |
| First-party destination | §10.3 crosswalk |
| **Deduplication strategy** | §10.5 — global rules per origin class |
| **Testing procedure** | §10.6 — global procedure per phase |
| Data-retention considerations | §11.6 — 14 months GA4, BigQuery beyond |
| **Consent category** | §11.2 — every event is `analytics_storage`; none require `ad_storage` unless remarketing is enabled |
| Implementation status | §10.4 tables (`Status` column) |
| Verification status | §10.4 tables (§3.3 markers) |

### 10.2 Naming law

1. **One business action = exactly one event name.** No synonyms, ever.
2. `snake_case`, lowercase, `[noun]_[verb-past-tense]` — consistent with
   `docs/analytics-telemetry.md` ✅.
3. GA4 **recommended** names are used where one exists (they unlock built-in
   reports and Ads conversion import at no cost); everywhere else, custom.
4. Where the owner-approved vocabulary and a GA4 recommended name differ, the
   owner name is the **internal `dataLayer` event name** and GTM maps it to the
   GA4 recommended name. Both exist, in different layers, by design — the
   mapping is in §10.4.
5. New events require a dictionary entry **before** implementation. An event in
   code but not in the dictionary is a defect.

### 10.3 Normalisation of existing events

All pre-existing event vocabularies, reconciled. **The first-party names do not
change** (AD-11) — only the mapping is new.

| Existing (source) | Type | Canonical `dataLayer` event | GA4 event | Action |
|---|---|---|---|---|
| `widget_impression` (AAPAnalytics ✅) | FP | `promotion_viewed` | `view_promotion` | Keep FP name; add GA4 mapping |
| `widget_click` (FP ✅) | FP | `promotion_clicked` | `select_promotion` | Keep; map |
| `auction_view` (FP ✅) | FP | `auction_viewed` | `view_auction` | Keep; map |
| `featured_auction_click` (FP ✅) | FP | `promotion_clicked` | `select_promotion` | **Merge** — same business action as `widget_click`; distinguish by `promotion_name` |
| `seller_cta_click` (FP ✅) | FP | `seller_cta_clicked` | `generate_lead` | Keep; map |
| `radius_search` (FP ✅) | FP | `radius_changed` | `radius_changed` | Keep FP name; GA4 uses `radius_changed` |
| `shipping_filter_toggle` (FP ✅) | FP | `shipping_filter_toggled` | `shipping_filter_toggled` | Keep; map |
| `city_page_visit` (FP ✅) | FP | `city_page_viewed` | `city_page_viewed` | Keep; map |
| `seller_onboarding_start` (FP ✅) | FP | `seller_onboarding_started` | `seller_onboarding_started` | Keep; map |
| `seller_onboarding_complete` (FP ✅) | FP | `seller_onboarding_completed` | `seller_onboarding_completed` | Keep; map |
| `advantage:feed:loaded` ✅ | DOM | `feed_loaded` | `view_item_list` | Map |
| `advantage:feed:card_opened` ✅ | DOM | `item_selected` | `select_item` | Map |
| `advantage:feed:type_filter_changed` ✅ | DOM | `feed_filter_changed` | `feed_filter_changed` | Map |
| `advantage:feed:sort_changed` ✅ | DOM | `feed_filter_changed` | `feed_filter_changed` | **Merge**; `filter_type=sort` |
| `advantage:feed:radius_changed` ✅ | DOM | `radius_changed` | `radius_changed` | Map |
| `advantage:feed:location_submitted` ✅ | DOM | `location_set` | `location_set` | Map; `method=manual` |
| `advantage:feed:location_resolved` ✅ | DOM | `location_set` | `location_set` | **Merge** — resolved is the success case |
| `advantage:feed:location_resolution_failed` ✅ | DOM | `location_failed` | `location_failed` | Map |
| `advantage:feed:use_my_location` ✅ | DOM | `location_set` | `location_set` | **Merge**; `method=browser_geo` |
| `advantage:feed:page_changed` ✅ | DOM | `feed_paginated` | `feed_paginated` | Map |
| `advantage:feed:no_results` ✅ | DOM | `search_no_results` | `search_no_results` | Map |
| `advantage:featured:item_click` ✅ | DOM | `promotion_clicked` | `select_promotion` | **Merge** |
| `advantage:featured:impression` ✅ | DOM | `promotion_viewed` | `view_promotion` | **Merge** |
| `advantage:featured:items_rendered` ✅ | DOM | `feed_loaded` | `view_item_list` | **Merge** |
| `advantage:featured:pagination` ✅ | DOM | `feed_paginated` | `feed_paginated` | **Merge** |
| `advantage:featured:empty` ✅ | DOM | `search_no_results` | `search_no_results` | **Merge** |
| `adv_*` / `adv_fi_*` dataLayer pushes ✅ | DL | *(deprecate)* | — | **Replace** with canonical names. Keep the legacy push for one release for safety, then remove. |
| `aap:widget:loaded` ✅ | DOM | `feed_loaded` | `view_item_list` | Map |
| `aap:lot:click` / `aap:auction:click` ✅ | DOM | `item_selected` | `select_item` | Merge |
| `aap:cta:click` ✅ | DOM | `seller_cta_clicked` | `generate_lead` | Merge |
| `aap:widget:fallback` ✅ | DOM | `location_failed` | `location_failed` | Map (reason = geolocation/no-results) |

**Net effect: 30 existing event names collapse to 14 canonical business actions.**
That collapse is the point — synonyms are what make an event taxonomy unusable.

### 10.4 Event dictionary

Origin: `C` = client (`dataLayer`) · `S` = server (Measurement Protocol)
Status: `NEW` = to implement · `MAP` = exists, needs mapping only

#### Global / content

| dataLayer event | GA4 event | Origin | Host | Trigger | Required params | Optional | Status |
|---|---|---|---|---|---|---|---|
| *(auto)* | `page_view` | C | both | Page load | `page_location`, `page_title`, `content_group` | `city`, `state_code` | NEW ✅ |
| `promotion_viewed` | `view_promotion` | C | both | Featured rail visible | `promotion_name`, `creative_slot` | `items[]` | MAP ✅ |
| `promotion_clicked` | `select_promotion` | C | both | Featured card clicked | `promotion_name`, `creative_slot` | `items[]`, `auction_id` | MAP ✅ |
| `city_page_viewed` | `city_page_viewed` | C | both | City page load | `city`, `state_code` | `page_slug` | MAP ✅ |
| `article_cta_clicked` | `select_content` | C | BD | CTA in an article | `content_type`, `link_url` | — | NEW 🧪 |
| `company_profile_viewed` | `company_profile_viewed` | C | BD | Directory profile load | `company_id` | `city`, `state_code` | NEW 🧪 |
| `company_contact_clicked` | `generate_lead` | C | BD | Contact action on a profile | `lead_type=company_contact` | `company_id` | NEW 🧪 |
| `feedback_submitted` | `feedback_submitted` | C | APP | Feedback form submit | — (**no contents**) | `page_path` | NEW ⚠ |

#### Search, feed, geo

| dataLayer event | GA4 event | Origin | Host | Trigger | Required params | Optional | Status |
|---|---|---|---|---|---|---|---|
| `search_performed` | `search` | C | both | Query submitted | `search_term`, `search_type` | `result_count` | NEW ✅ |
| `view_search_results` | `view_search_results` | C | both | Results rendered | `result_count` | `filters_applied`, `sort_order` | NEW ✅ |
| `search_no_results` | `search_no_results` | C | both | Zero results | `search_term` | `filters_applied` | MAP ✅ |
| `feed_loaded` | `view_item_list` | C | both | Feed/grid rendered | `item_list_id`, `item_list_name` | `items[]`, `result_count` | MAP ✅ |
| `item_selected` | `select_item` | C | both | Card clicked | `item_list_id`, `items[]` | `card_position` | MAP ✅ |
| `feed_filter_changed` | `feed_filter_changed` | C | both | Filter or sort changed | `filter_type`, `filter_value` | `result_count` | MAP ✅ |
| `feed_paginated` | `feed_paginated` | C | both | Page changed | `page_number` | `result_count` | MAP ✅ |
| `map_opened` | `map_opened` | C | APP | Map view entered | `entry_point` | — | NEW ✅ |
| `map_interacted` | `map_interacted` | C | APP | Pan/zoom/marker (**throttled ≥1s**) | `interaction_type` | `zoom_level` | NEW ✅ |
| `location_set` | `location_set` | C | both | Location resolved | `method` | `city`, `state_code` | MAP ✅ |
| `location_failed` | `location_failed` | C | both | Geo/geocode failure | `reason` | — | MAP ✅ |
| `radius_changed` | `radius_changed` | C | both | Radius slider changed | `radius_miles` | `radius_miles_prev`, `result_count` | MAP ✅ |
| `shipping_filter_toggled` | `shipping_filter_toggled` | C | both | Ships-nationwide toggle | `enabled` | `result_count` | MAP ✅ |

#### Auction, lot, estate sale

| dataLayer event | GA4 event | Origin | Host | Trigger | Required params | Optional | Status |
|---|---|---|---|---|---|---|---|
| `auction_viewed` | `view_auction` | C | APP | `/auction-view.html` load | `auction_id`, `auction_state` | `lot_count`, `city`, `state_code` | MAP ✅ |
| `lot_viewed` | `view_item` | C | APP | `/lot.html` load | `items[]` (`item_id`, `item_name`, `price`) | `auction_id`, `lot_category` | NEW ✅ |
| `view_estate_sale` | `view_estate_sale` | C | APP | `/event.html` load | `event_slug` | `market`, `city`, `state_code` | NEW ✅ |
| `seller_profile_viewed` | `seller_profile_viewed` | C | APP | Seller profile load | `seller_id` | — | NEW ⚠ |
| `seller_followed` | `seller_followed` | C | APP | Follow succeeds | `seller_id` | `source` | NEW ⚠ |
| `seller_unfollowed` | `seller_unfollowed` | C | APP | Unfollow succeeds | `seller_id` | — | NEW ⚠ |
| `ending_soon_viewed` | `ending_soon_viewed` | C | APP | Ending-soon surface load | `result_count` | — | NEW ✅ |
| `auction_extended` | `auction_extended` | C | APP | `extended_until` advances (anti-snipe) | `lot_id`, `auction_id` | `extension_seconds` | NEW 🧪 |

#### Buyer account

| dataLayer event | GA4 event | Origin | Host | Trigger | Required params | Optional | Status |
|---|---|---|---|---|---|---|---|
| `registration_started` | `registration_started` | C | APP | Register form opened | `lead_type` | `entry_point` | NEW ⚠ |
| `registration_completed` | `sign_up` | C | APP | Registration 2xx | `method` | `lead_type` | NEW ⚠ |
| `login` | `login` | C | APP | Login 2xx | `method` | — | NEW ⚠ |
| `auth_failed` | `auth_failed` | C | APP | Auth non-2xx | `reason` **class only** | — | NEW ⚠ 🔒 |
| `password_reset_requested` | `password_reset_requested` | C | APP | Reset requested | — | — | NEW ⚠ |
| `terms_accepted` | `terms_accepted` | C | APP | Terms accepted | `terms_version` | — | NEW ⚠ |
| `verification_started` | `verification_started` | C | APP | Verification begun | — | — | NEW ⚠ 🔒 |
| `verification_submitted` | `verification_submitted` | C | APP | Documents submitted | `document_count` | — | NEW ⚠ 🔒 |

#### Watchlist & bidding *(Governance Rule 7 amended — §12)*

| dataLayer event | GA4 event | Origin | Host | Trigger | Required params | Optional | Status |
|---|---|---|---|---|---|---|---|
| `watchlist_added` | `add_to_wishlist` | C | APP | Watch added 2xx | `items[]`, `source` | `value`, `currency` | NEW ⚠ |
| `watchlist_removed` | `watchlist_removed` | C | APP | Watch removed 2xx | `items[]` | — | NEW ⚠ |
| `bid_started` | `bid_started` | C | APP | Bid input focused / modal opened | `lot_id`, `auction_id` | — | NEW ✅ |
| `bid_submitted` | `bid_submitted` | C | APP | Bid POST **issued** | `lot_id`, `auction_id`, `bid_type` | `bid_amount` | NEW ⚠ |
| `bid_accepted` | `bid_accepted` | C | APP | Bid POST **2xx** | `lot_id`, `auction_id`, `bid_amount`, `currency`, `is_first_bid` | `value` | NEW ⚠ |
| `bid_rejected` | `bid_rejected` | C | APP | Bid POST non-2xx | `lot_id`, `reason` **class only** | — | NEW ⚠ |
| `user_outbid` | `user_outbid` | C | APP | Socket `lot:outbid` | `lot_id`, `auction_id` | — | NEW ✅ |
| `bid_winning` | `bid_winning` | C | APP | Socket `lot:winning` | `lot_id` | — | NEW ✅ |
| `auction_won` | `auction_won` | C/S | APP | Winner confirmed | `lot_id`, `winning_amount`, `currency` | `value` | NEW ⚠ |
| `auction_lost` | `auction_lost` | C | APP | Lot closed, user not winner | `lot_id` | — | NEW ⚠ |

> `bid_submitted` and `bid_accepted` are deliberately **two** events. The gap
> between them is the bid-failure rate, and it is invisible if only one is
> recorded. Both fire **after** the request is issued/resolved and can never
> gate, delay, or alter a bid (§12).

#### Checkout & payment *(server-authoritative)*

| dataLayer event | GA4 event | Origin | Host | Trigger | Required params | Optional | Status |
|---|---|---|---|---|---|---|---|
| `view_invoice` | `view_invoice` | C | APP | Invoice list/detail load | `invoice_count` | `balance_due` | NEW ⚠ |
| `checkout_started` | `begin_checkout` | C | APP | Pay flow initiated | `items[]`, `value`, `currency` | `invoice_id` | NEW ⚠ |
| `payment_started` | `payment_started` | C | APP | Payment confirm submitted | `payment_type` | `invoice_id` | NEW ⚠ |
| `add_payment_info` | `add_payment_info` | C | APP | Card added / selected | `payment_type` | — | NEW ⚠ |
| `payment_failed` | `payment_failed` | **S** | — | Stripe failure webhook | `reason_code` **class only** | `value`, `currency` | NEW ❌ |
| **`purchase`** | **`purchase`** | **S** | — | Stripe `payment_intent.succeeded` | `transaction_id`, `value`, `currency`, `items[]` | `tax`, `shipping`, `seller_id` | NEW ❌ |
| `refund` | `refund` | **S** | — | Stripe refund (Phase 6) | `transaction_id`, `value`, `currency` | — | LATER |
| `pickup_info_viewed` | `pickup_info_viewed` | C | APP | Pickup details viewed | — | `auction_id` | NEW 🧪 |

#### Seller journey

| dataLayer event | GA4 event | Origin | Host | Trigger | Required params | Optional | Status |
|---|---|---|---|---|---|---|---|
| `seller_cta_clicked` | `generate_lead` | C | both | Sell-with-Advantage CTA | `lead_type=seller`, `cta_location` | `source_widget`, `headline` | MAP ✅ |
| `seller_onboarding_started` | `seller_onboarding_started` | C | APP | Onboarding begun | `entry_point` | `flow_variant` | MAP ⚠ |
| `seller_onboarding_step` | `seller_onboarding_step` | C | APP | Step completed | `step_number`, `step_name` | — | NEW ⚠ |
| `seller_type_selected` | `seller_type_selected` | C | APP | Enrol 2xx | `seller_type` | — | NEW ⚠ |
| `agreement_viewed` | `agreement_viewed` | C | APP | Agreement opened | `agreement_id` | — | NEW ⚠ |
| `agreement_signed` | `agreement_signed` | C | APP | Sign 2xx | `agreement_id` | `hours_to_sign` | NEW ⚠ |
| `payout_profile_started` | `payout_profile_started` | C | APP | Payout flow opened | — | — | NEW ⚠ 🔒 |
| `payout_profile_completed` | `payout_profile_completed` | C | APP | Payout saved 2xx | — (**no financial values**) | — | NEW ⚠ 🔒 |
| `seller_onboarding_completed` | `seller_onboarding_completed` | C | APP | Onboarding finished | `steps_completed` | `duration_seconds` | MAP ⚠ |
| `auction_create_started` | `auction_create_started` | C | APP | Create page opened | — | — | NEW ✅ |
| `auction_draft_saved` | `auction_draft_saved` | C | APP | Create/patch 2xx | `auction_id`, `is_draft` | — | NEW ⚠ |
| `lot_created` | `lot_created` | C | APP | Lot POST 2xx | `auction_id`, `lot_id` | `image_count`, `used_ai_description` | NEW ⚠ |
| `media_uploaded` | `media_uploaded` | C | APP | Upload 2xx | `media_type` | `count` | NEW ⚠ |
| `ai_description_generated` | `ai_description_generated` | C | APP | AI call returns | `accepted` | — | NEW ⚠ |
| `auction_submitted` | `auction_submitted` | C | APP | Submitted for review | `auction_id` | `lot_count` | NEW ⚠ |
| `moderation_status_viewed` | `moderation_status_viewed` | C | APP | Status surface viewed | `status` | — | NEW ⚠ |
| `auction_published` | `auction_published` | C/S | APP | Auction goes live | `auction_id` | `lot_count`, `hours_draft_to_live` | NEW ⚠ |
| `estate_sale_submitted` | `estate_sale_submitted` | C | APP | Org submit 2xx | `event_id` | `market` | NEW ✅ |
| `estate_sale_published` | `estate_sale_published` | **S** | — | Admin publish | `event_id` | `market`, `hours_in_queue` | NEW ✅ |
| `marketing_package_selected` | `marketing_package_selected` | C | APP | Package chosen | `package_tier` (**name only**) | `auction_id` | NEW ⚠ |
| `seller_performance_viewed` | `seller_performance_viewed` | C | APP | Seller dashboard load | — | — | NEW ✅ |

### 10.5 Deduplication strategy (global, by origin class)

| Origin class | Risk | Strategy |
|---|---|---|
| **Client, page-load events** | Double injection; SPA history | AD-19 idempotency; one config tag; `/app.html` rule (§6.5) |
| **Client, action events** | Double-bound handler; retry after failure | Single emission point per action in code (AD-7); emit on the **resolved** response, never in both the request and response path |
| **Widget-sourced** | Both iframe and parent emit | Parent-only translation (AD-10); iframe never tagged (AD-9) |
| **Server, Measurement Protocol** | Stripe webhook retries | Reuse the existing `stripe_webhook_events` idempotency table ✅. Send only when the row transitions to `processed` for the first time. Additionally set a deterministic `event_id` = `sha256(stripe_event_id)` so duplicates are detectable in BigQuery even if the guard fails. |
| **`purchase` specifically** | Client + server double-count | Client-side `purchase` tag **absent from the container** (AD-16). Not paused — absent. |
| **Cross-system** | GA4 and `analytics_events` both recording | Not a duplicate: different systems, different purposes (§4.2). Never sum across them. |

### 10.6 Testing procedure (global, by phase)

| Phase | Method | Pass condition |
|---|---|---|
| Authoring | GTM **Preview** on staging | Event fires once, all required params present and non-empty |
| Pre-merge | GA4 **DebugView** | Correct event name, correct GA4 mapping, no `(not set)` on required params |
| Post-deploy 24h | GA4 Realtime + Events report | Volume within an order of magnitude of the `analytics_events` equivalent |
| Post-deploy 7d | Reconciliation query vs Postgres | Within the tolerance in §17 per phase |
| Ongoing | Instrumentation-health tiles (§18.1) | On the executive dashboard, so a data outage is never invisible |

**Every event carries a `debug_mode` path in staging.** No exceptions: an event
that cannot be observed in DebugView cannot be signed off.


---

## 11. Privacy, consent and prohibited-data matrix

The owner direction is explicit: comprehensive analytics, **not** surveillance
without boundaries. This section is the boundary, written so an implementer never
has to guess.

> **Nothing in this section is legal advice.** Items marked 🔒 require the owner
> or a qualified adviser to decide. Where a legal conclusion would be required,
> the item is flagged rather than assumed.

### 11.1 Principles

1. **Pseudonymous by default.** GA4 receives behavioural classes and pseudonymous
   identifiers. It never receives a person.
2. **Outcome over content.** Record *that* a form was submitted, a bid rejected,
   a payment failed — never *what* was typed, offered, or charged to whom.
3. **Class over value** for anything sensitive. `reason=not_verified`, not the
   verification record. `payment_type=card_on_file`, not the card.
4. **Server-side for money.** Financial truth lives in Postgres; GA4 gets a
   transaction total and an ID, nothing more (AD-13, AD-14).
5. **Deny by default in the collector.** The §11.3 key list is enforced in code
   (`AdvDL` helper and the MP sender), not merely by policy. Policy drifts; code
   does not.

### 11.2 Consent categories

| Category | Applies to | Default (pre-decision) |
|---|---|---|
| `analytics_storage` | Every event in §10 | 🔒 Owner/legal decision — see below |
| `ad_storage` | Only if remarketing / Ads conversion tags are added | **Denied** until Ads is linked and disclosed |
| `ad_user_data`, `ad_personalization` | Google Signals / Ads audiences | **Denied** until §11.4 is decided |
| `functionality_storage`, `security_storage` | Not used by analytics | n/a |

**Google Consent Mode v2 — recommendation:** implement it in Phase 1, at
bootstrap, **before** any tag exists. Retrofitting after tags are live is
materially harder and error-prone. If there is genuinely no EEA/UK traffic and no
plan for it, deferring is defensible — but the decision must be recorded, and it
must be revisited before any international spend. 🔒

Regardless of consent mode: **the cookie policy and `public/privacy.html` must
disclose Google Analytics and any advertising tags before the container is
published.** That is a launch blocker (§17 Phase 2 gate). US state privacy
obligations (e.g. opt-out and "do not sell/share" style requirements where
applicable) are 🔒 — they depend on where users are and what is enabled, and are
for the owner or counsel to determine, not for this document to conclude.

### 11.3 Prohibited data — global, applies to every event without exception

**Never send to GA4, in any parameter, user property, page path, page title,
event name, or `items[]` field:**

| Prohibited | Includes |
|---|---|
| Contact identity | Email, name, username, phone, postal address, IP as a parameter |
| Credentials | Passwords, password hints, JWTs, session cookies, API keys, magic-link or reset tokens |
| Payment data | Card number, last-4, expiry, CVV, cardholder name, Stripe PaymentIntent / customer / payment-method IDs, bank or routing numbers |
| Government / identity | SSN, tax ID, driving licence, passport, verification document contents **or type** |
| Raw internal keys | Internal user UUID (use `analytics_uid`, §7.2), admin IDs, internal org IDs not already public |
| Free-form content | Any user-typed text other than `search_term`; message bodies, notes, descriptions, feedback text, support threads |
| Unrestricted DOM | Innerhtml scrapes, form serialisations, `dataLayer` dumps of page state |
| Private seller data | Payout balances, settlement figures, fee tiers, bank details, private agreement terms |
| Financial values as user properties | Seller GMV, buyer spend, outstanding balance — as *properties*; transaction `value` on `purchase` is permitted |
| Precise geolocation | Raw lat/long. Use `city` / `state_code` only. |
| Health, biometric, or other sensitive categories | Any |

**Enforcement:** the shared `AdvDL` client helper and
`ga4MeasurementProtocol.js` both strip this key list before dispatch, reusing the
same `PII_KEYS` discipline already implemented in `analyticsService.js` ✅. Two
independent enforcement points, both in code.

**Note on `search_term`:** it is permitted because it is the only way to measure
demand, but it is user-typed and can contain anything. Mitigations: never mark it
a key event, never join it to `user_id` in reporting, and review the top-terms
report periodically for accidental PII. 🔒 Owner acknowledges this trade-off.

### 11.4 GA4 platform settings

| Setting | Recommendation | Reason |
|---|---|---|
| **Google Signals** | **OFF at launch.** Revisit above ~1,000 daily users. | Signals adds demographics and cross-device, but triggers **data thresholding** — GA4 withholds rows from reports when they could identify someone. At launch volumes this hides most of your reports. It also requires the `ad_user_data` consent category. |
| Reporting identity | **Observed** (User-ID → device) | Blended's modelling needs Consent Mode plus volume; it makes early numbers look more certain than they are. |
| Granular location & device data | Keep on, US-region | Needed for market analysis; no precise geolocation is collected either way. |
| Data sharing with Google | 🔒 Owner decision. Recommend: **Technical support ON**, **Modeling contributions ON**, **Google products & services OFF** unless Ads is linked and disclosed. | Modeling contributions improve GA4's own modelling; the products/services toggle is the one with real data-sharing implications. |
| Advertising features / remarketing | **OFF** until Ads is linked, disclosed in privacy policy, and `ad_storage` consent is wired | Turning these on silently changes what the privacy policy needs to say. |
| Data retention | **14 months** (maximum), set day one | Not retroactive. BigQuery covers everything beyond. |
| IP handling | Automatic — GA4 does not log or store IPs | No configuration; do not attempt to send IP as a parameter (§11.3) |
| **Measurement Protocol secret** | `GA4_API_SECRET` in Railway env only. Never in client code, never in GTM, never in git, never in a browser-reachable endpoint. Rotate if exposed. | An exposed MP secret lets anyone inject events into your property — including fake revenue. |
| Internal traffic | §7.4, three layers | — |
| Developer/test traffic | Never point non-production at `G-JM5JYGNJ6H` | Hard rule |

### 11.5 Deletion and account-removal requests 🔒

| Request | Mechanism |
|---|---|
| Delete a user's GA4 data | GA4 **User Deletion** by `user_id` (`analytics_uid`) — requires that `analytics_uid` be derivable from the account, which §7.2 guarantees |
| Sever all historical linkage | Rotate `ANALYTICS_UID_SECRET` — all prior `analytics_uid` values become undecodable and unlinkable to any account |
| Account deletion in the product | Postgres deletion per your existing policy; GA4 user-deletion request raised in the same workflow |
| BigQuery export | **Deletion requests do not automatically propagate to BigQuery.** A deletion runbook must cover the export dataset explicitly, or the data survives there. |
| First-party `analytics_events` | Already non-identifying by design; nothing to delete against a person. Documented as such. |

🔒 A written deletion runbook is required before go-live. It does not exist yet.

### 11.6 Retention

| Store | Retention | Note |
|---|---|---|
| GA4 events | 14 months | Maximum available; set in Phase 0 |
| GA4 user-scoped data | 14 months | Same setting |
| BigQuery export | Owner-defined | The durable record. Set a table-expiry policy deliberately rather than accumulating forever. |
| `analytics_events` | 90 days raw → aggregates | Existing policy in `docs/analytics-telemetry.md` ✅ — unchanged |
| Postgres business records | Per financial/legal retention obligations | 🔒 Not an analytics decision |

---

## 12. Governance Rule 7 — amended (owner-approved)

`docs/analytics-telemetry.md` Governance Rule 7 currently reads:

> **Do not add analytics to payment or bidding flows** — these are critical paths.

**Approved replacement text:**

> **Rule 7 — Analytics in bidding and payment flows.**
>
> Analytics may record predefined funnel actions and verified outcomes in bidding
> and payment flows, but must not capture payment credentials, authentication
> data, personal information, unrestricted DOM content, private messages,
> free-form form contents, or sensitive user inputs. Events must originate from
> reviewed application code. GTM remains transport only. Financial outcomes must
> be confirmed against authoritative server-side records.
>
> **Operative constraints:**
> 1. Analytics must never gate, delay, block, retry, or alter a bid or a payment.
>    Emission is non-blocking, never awaited, and wrapped so that a failure is
>    invisible to the user and to the transaction.
> 2. Emission occurs **after** the relevant request has been issued or resolved —
>    never before, never inside a critical-path branch.
> 3. Only the events named in §10.4 may fire on these paths. Adding one requires
>    a dictionary entry and review.
> 4. `purchase` is emitted **server-side only**, from the Stripe webhook, after
>    verified payment success. No client-side `purchase` tag may exist.
> 5. Field-level interaction tracking on payment credential inputs is prohibited
>    outright. Page-level and outcome events only.
> 6. Reason codes on these paths are **classes, not values** — `not_verified`,
>    `below_increment`, `card_declined`. Never the amount offered by another
>    bidder, never a card detail, never an identifier.
> 7. Financial figures reported to sellers or used for reconciliation come from
>    Postgres, never GA4.

**Approved event allow-list for these paths:** `bid_started`, `bid_submitted`,
`bid_accepted`, `bid_rejected`, `user_outbid`, `watchlist_added`,
`registration_started`, `registration_completed`, `checkout_started`,
`payment_started`, `payment_failed`, `payment_completed` / `purchase`.

**Implementation note:** `docs/analytics-telemetry.md` is owned by
Bravo-Discovery per `agents/orchestration/ownership-matrix.md:71` ✅ (`OWN`).
The amendment must be applied by the owning agent or with an explicit ownership
exception — not edited unilaterally by whichever agent happens to be doing the
GA4 work.

---

## 13. Platform integrations and outstanding platform risks

### 13.1 Google Search Console — do this in Phase 0

Free, and its data only accrues once linked.

1. Verify a **Domain property** (`advantage.bid`) via DNS TXT — one verification
   covers `advantage.bid`, `www.advantage.bid`, and `bid.advantage.bid`, giving
   a single SEO view across the estate.
2. Link to GA4: **Admin → Product links → Search Console links**, then publish
   the two Search Console reports into GA4's report library (hidden by default).
3. Submit both sitemaps — the dynamic one at `/sitemap.xml` ✅ (`server.js:169`)
   and the BD-generated one.
4. Feed dashboard §18.6 via the Looker Studio Search Console connector.

Sequence this **before** heavy content production so time-to-first-click is
measurable for new city and article pages.

### 13.2 Google Business Profile

Relevant where Advantage.Bid has physical presence: pickup locations, on-site
estate sales, regional offices.

- GBP listings link to the **canonical `bid.advantage.bid`** location page, not a
  BD mirror, so link equity consolidates where the canonical tag already points.
- **UTM-tag every GBP link** — GBP traffic otherwise lands in `direct` and is
  invisible:
  `?utm_source=google&utm_medium=organic&utm_campaign=local-gbp&utm_content=<location>`
  (consistent with the §8.3 `local-` prefix).
- Track `map_opened`, outbound directions clicks, and phone taps as local-intent
  signals — **as events, never with the phone number as a parameter**.
- GBP Insights does not flow into GA4. Export monthly, or use the Business
  Profile Performance API, and blend into §18.6.
- Estate sales are time-and-place events; **GBP Posts plus event structured data
  are a real local-SEO advantage** here. Sequence right after Search Console.

### 13.3 Later integrations, in priority order

1. **Google Ads link** — required for `purchase` and `generate_lead` conversion import.
2. **BigQuery export** — enable in Phase 0 regardless; does not backfill (§7.6).
3. **Consent Mode v2** — before any EEA/UK spend (§11.2).
4. **Server-side GTM** — only if ad blockers or ITP measurably erode signal. Not now: added hosting cost and a new failure domain for no current gain.
5. **Looker Studio → Postgres connector** — for the Ops dashboard (§18.9).

### 13.4 ⚠ Risk — duplicate hosting via Vercel

`vercel.json` ✅ publishes the same `public/` directory to Vercel with an API
rewrite to Railway, and redirects `/` → `/demo.html`. If any Vercel deployment is
publicly reachable, identical tagged pages serve from a second origin: duplicate
pageviews on a hostname that is not `bid.advantage.bid`, plus a duplicate-content
SEO problem.

**Action before Phase 1:** determine whether Vercel is live. If not, delete
`vercel.json` or document it as dead. If it is, decide which origin is canonical
and make the other `noindex` **and** untagged. 🧪

### 13.5 ✅ RESOLVED — `widgetFraming.js` CSP

Read directly at the v2.1 baseline. `src/middleware/widgetFraming.js` sets
exactly one directive on `/widgets/*`:

```
frame-ancestors https://advantage.bid https://www.advantage.bid
```

It removes `X-Frame-Options` for those paths only and sets **no `script-src`**.
Helmet's CSP remains globally disabled. **Nothing in the current configuration
blocks analytics scripts anywhere**, and the widget iframes are unaffected
because AD-9 keeps GA4 out of them entirely.

One observation, not a risk: the `frame-ancestors` list permits **both** the
apex and `www`. With AD-21 making `www` canonical, the apex entry becomes
redundant once the 301 is live — harmless to keep as a safety margin, but worth
a deliberate decision rather than drift. Note also that the header is set with
`res.setHeader`, so if a global CSP is ever introduced this route would
**overwrite** rather than merge it. Not a problem today; a trap for whoever
enables CSP later.

### 13.6 ⚠ Risk — stale `auctions.advantage.bid` references

`widgets/shared/analytics.js:23`, `shared/config.js:25`, `featured-lots.js`,
`featured-near-you.js`, `featured-auctions.js` ✅ all document
`https://auctions.advantage.bid/...` as the widget script host. If a BD page
actually loads a widget from that hostname, it is a **third tagged subdomain**
nobody planned for.

**Action:** confirm whether `auctions.advantage.bid` resolves. If not, correct
the doc comments to `bid.advantage.bid` (comment-only, zero runtime risk). If it
does, add it to the §14 audit and the §15 remediation. 🧪

### 13.7 ⚠ Risk — `/app.html` member shell

`public/app.html` ✅ mounts a JS shell via `member-shell.js` ❌ (missing). If the
shell pushes virtual page views while Enhanced Measurement History-changes is on,
every in-shell navigation double-counts. Resolved by the Phase 1 gate, which
requires testing `/app.html` explicitly. 🧪

---

## 14. Brilliant Directories analytics audit checklist

**Mandatory before the GTM container is installed on BD (Phase 2 precondition).**

Purpose: find every existing analytics tag and either **remove** it or
**intentionally retain** it with a written reason. A leftover second tag is the
textbook cause of duplicate pageviews and doubled users, and it is very hard to
diagnose afterwards because both tags look correct in isolation.

Per BD's own documentation, GA4/GTM on BD is installed by pasting code — there is
**no native measurement-ID field** — so tags can be hiding in several places.

### 14.1 Locations to inspect

| # | Location | Path in BD | Looking for | Finding | Action |
|---|---|---|---|---|---|
| 1 | **Additional HEAD Code** | Settings → Design Settings → Custom CSS/HEAD | `gtag(`, `googletagmanager.com`, `google-analytics.com`, `G-`, `UA-`, `GTM-`, `dataLayer` | | |
| 2 | **Footer / body code** | Settings → Design Settings (footer script area) | Same patterns; also `<noscript>` GTM iframes | | |
| 3 | **GTM container widget** | Toolbox → Widget Manager → "Bootstrap Theme - Google Tag Manager Code" | An existing container ID | | |
| 4 | **Any other analytics widget** | Toolbox → Widget Manager → search `analytics`, `google`, `tag`, `pixel`, `tracking` | Any enabled widget injecting script | | |
| 5 | **Legacy Universal Analytics** | All of the above | `UA-` prefix, `analytics.js`, `ga(` | | Remove — UA no longer collects; it only adds weight and confusion |
| 6 | **Existing GA4 tags** | All of the above | Any `G-` **other than** `G-JM5JYGNJ6H` | | Remove |
| 7 | **Google Ads conversion / remarketing tags** | Head, footer, widgets | `AW-`, `gtag('config','AW-…')`, `conversion_id` | | **Retain or migrate deliberately** — removing a live Ads conversion tag breaks active campaigns. Migrate into GTM instead. |
| 8 | **Marketing pixels** | Head, footer, widgets | Meta `fbq(`, LinkedIn `_linkedin_partner_id`, TikTok `ttq`, Pinterest, Bing UET `uetq`, Reddit, X | | Inventory each; migrate into GTM |
| 9 | **Custom widgets** | Toolbox → Widget Manager (all custom/edited widgets) | Inline `<script>` with tracking calls | | |
| 10 | **Page-level code** | Individual page editors, especially the homepage and high-traffic city pages | Page-specific tracking snippets | | Page-level tags are the easiest to miss and the most likely to double-fire |
| 11 | **Theme code** | Theme templates / theme editor | Hard-coded analytics in the theme layer | | |
| 12 | **Plugins / integrations** | Marketplace plugins, e.g. a "Google Analytics Integration" partner plugin | Any plugin that injects analytics | | Disable before installing GTM, or its tag and yours both fire |
| 13 | **Iframe-specific analytics** | Any embedded iframe, widget embed page, or third-party embed | Analytics inside an embedded document | | Must be zero (AD-9) |
| 14 | **Consent / cookie scripts** | Head, footer, plugins | More than one CMP; duplicate cookie banners | | Two consent scripts fight each other and can block tags nondeterministically — resolve to exactly one |
| 15 | **URL handling** | Redirect settings, SEO settings, link templates | Whether `utm_*` / `gclid` survive BD redirects | | Test with a UTM-tagged inbound URL (§8.4) |
| 16 | **Existing BD-native stats** | BD's own analytics features | Whether BD stats are relied on for reporting | | Decide: retain as a cross-check, or retire to avoid two conflicting numbers |

### 14.2 Audit output required

For every finding, record: **location · exact tag/ID found · owner · decision
(remove / retain / migrate to GTM) · date actioned · verified by**.

**Sign-off condition:** after remediation, a page-source search on three BD page
types (homepage, a city page, a company profile) finds **exactly zero** analytics
tags. Only then is the new container installed.

🧪 This audit cannot be performed from Desktop — it requires BD admin access.

---

## 15. `advantageauction.bid` retirement checklist (owner-approved)

**Target architecture**

| Role | Canonical host |
|---|---|
| Marketing / directory | `https://www.advantage.bid` (or the approved canonical form — **§20 Q-A**, apex vs `www` must be fixed once and applied everywhere) |
| Auction application | `https://bid.advantage.bid` |
| `advantageauction.bid` | 301 → the corresponding canonical URL. **No independent application session.** |

**Why this matters:** `advantageauction.bid` is a **different registrable
domain**. Cookies do not cross it. Any user-facing link that resolves there
creates a new user, a new session, and destroys the original acquisition source —
exactly the broken journey the owner objective forbids.

### 15.1 Remediation scope

| # | Area | Specific target | Marker | Action |
|---|---|---|---|---|
| 1 | **`src/lib/publicUrls.js`** | `DEFAULT_BUYER_BASE = 'https://advantageauction.bid'` line 16 | ✅ | Change to `https://bid.advantage.bid`. **Sequence last** (see 15.2) — it is the safety net. |
| 2 | **Railway env** | `PUBLIC_BASE_URL` | ✅ referenced | Set **explicitly** in every environment (production, staging, preview). Never rely on the fallback. |
| 3 | **Railway env** | `FRONTEND_URL`, `ALLOWED_ORIGINS` | ✅ | Ensure the first origin is the canonical app host; remove the old domain from the allow-list **after** redirects are live |
| 4 | **Railway env** | `EMAIL_FROM` | ✅ `.env.example:52` | Move to the canonical domain. **Requires SPF/DKIM/DMARC on the new sending domain first** — changing the sender before DNS auth will land mail in spam. Sequence this early and independently. |
| 5 | **Transactional email templates** | Every template in `src/workers/notificationWorker.js` ✅ and any template store | ⚠ | All links built from `publicBaseUrl()`; verify none hard-code the old host. Add UTMs while editing (§8.3, `utm_medium=email`). |
| 6 | **Email link tracking** | Any link-wrapping or click-tracking layer | ⚠ | Confirm wrapping preserves query strings |
| 7 | **Brilliant Directories code** | Head/footer code, widgets, page content, menus, theme | 🧪 | Search BD for `advantageauction.bid`; replace with canonical |
| 8 | **Canonical URLs** | All 50 `public/*.html` `<link rel="canonical">` | ✅ already `bid.advantage.bid` | Verify none regressed |
| 9 | **`shareMeta.js` output** | `og:url`, `twitter:*`, canonical built from `publicBaseUrl()` | ✅ | Fixed automatically by items 1–2; verify rendered output |
| 10 | **Structured data** | JSON-LD `@id`, `url` fields in `shareMeta.js` (`Event`, `Product`, estate-sale) | ✅ | Same; verify with Google's Rich Results Test |
| 11 | **Social metadata** | OG/Twitter images and URLs, including `img/social-card.png` absolute path | ✅ | Same |
| 12 | **Sitemaps** | `/sitemap.xml` ✅ (`server.js:169`) + BD sitemap | ✅ / 🧪 | Must emit only canonical hosts. Resubmit both in Search Console after cutover. |
| 13 | **Redirects** | `advantageauction.bid/*` → `bid.advantage.bid/*` | 🧪 | **301, path-preserving, query-string-preserving.** A redirect to the homepage instead of the matching path destroys both SEO and attribution. |
| 14 | **Widget URLs** | `API_BASE` / script `src` in `marketplace-feed.js`, `featured-items.js`, `bd-auctions-init.js`, `events.js`, `marketplace-embed.js` | ✅ already `bid.advantage.bid` | Verify; also fix the stale `auctions.advantage.bid` doc comments (§13.6) |
| 15 | **`postMessage` origin allow-lists** | `marketplace-embed.js:17,29` ✅ | ✅ | Ensure the old domain is not an accepted origin after cutover |
| 16 | **Login redirects** | `authBridge.js` ❌, `return-to-auction.js` ❌, post-login `redirect`/`next` params | ❌ ⚠ | **Highest-risk unknown.** A login handoff that returns to the old domain re-creates the split journey on the most attribution-sensitive path. §16 must locate every redirect target. |
| 17 | **Payment return URLs** | Stripe `return_url` / `success_url` in `payments.js` ❌ | ❌ ⚠ | Must return to the canonical host **and** preserve query params (§8.4) |
| 18 | **CORS / Socket.IO allow-lists** | `allowedOrigins()` ✅ | ✅ | Remove the old domain **after** redirects are live, not before |
| 19 | **`EVENT_ORIGINS`** | `publicEvents.js:21-22` ✅ | ✅ | Align with the final canonical set |
| 20 | **DNS / TLS** | Old domain must keep a valid certificate while redirecting | 🧪 | A redirect that fails TLS is a dead link, not a redirect |
| 21 | **Search Console** | Old domain property | 🧪 | Keep it verified through the transition to monitor the redirect; use the Change of Address tool if the old domain has meaningful indexed pages |
| 22 | **GA4 unwanted referrals** | `advantageauction.bid` entry (§6.3) | — | Add now; remove once traffic to the old domain is zero |
| 23 | **QR codes / print / offline** | Anything already produced with the old domain | 🧪 | Cannot be recalled — the 301 must stay live indefinitely for these |
| 24 | **Any other repository reference** | Full-tree grep for `advantageauction` | ✅ 2 known hits | Re-run against the **full** repository — the reviewed copy is incomplete (§3.4) |

### 15.2 Safe sequencing

1. Stand up the 301 redirect on `advantageauction.bid` (path- and
   query-preserving). **Nothing else changes yet.** 🧪 Verify with UTM-tagged URLs.
2. Set `PUBLIC_BASE_URL` / `FRONTEND_URL` explicitly in **every** environment.
   This alone stops the fallback being reachable in practice.
3. Complete DNS email authentication for the new sending domain; then change
   `EMAIL_FROM`; then update templates.
4. Fix BD references, widget doc comments, login redirects, payment return URLs.
5. **Only then** change `DEFAULT_BUYER_BASE` in `publicUrls.js`.
6. After 30 days of zero traffic to the old domain: remove it from CORS
   allow-lists and from GA4 unwanted referrals. **Keep the 301 live indefinitely**
   (item 23).

> The fallback constant is changed **last**, not first. It is currently the only
> thing preventing broken links if an environment variable is missing. Changing it
> before step 2 converts a silent attribution problem into a visible outage.


---

## 16. Full-repository verification checklist for VS Code Claude

**Run this first, before any implementation.** Its purpose is to convert every ⚠
and ❌ in this document into ✅ or a documented correction. Output a completed
copy of this table into `docs/analytics/VERIFICATION_RESULTS.md`.

**This is a read-only task. Do not modify any file while completing it.**

### 16.1 Route and contract verification

For each: confirm the file exists, then record the **method, path, auth
requirement, success status code, response shape, and error codes**.

| # | Target | What to confirm | Current |
|---|---|---|---|
| 1 | `src/routes/payments.js` | Webhook handler; which Stripe event types are switched on; where `stripe_webhook_events` rows transition to `processed`; the exact insertion point for an MP send that is **after** business logic and inside the idempotency guard. Also `charge-lot`, `charge-combined`, `setup-intent`, `card-on-file`, `config`, and all Stripe `return_url` / `success_url` values. | ❌ |
| 2 | `src/routes/lots.js` | `POST /api/lots/:lotId/bids` request/response; success and every failure code; whether `max_bid_cents` and `amount` are distinct paths; `GET /:id/winner-status` shape | ❌ |
| 3 | `src/routes/watchlist.js` | The **add** endpoint (only remove/list are visible from HTML); method, path, response | ❌ |
| 4 | Bidding services | `bidService.applySoftClose` (referenced `notificationWorker.js:857` ✅) — how `extended_until` is set, and whether a client-observable signal exists for `auction_extended` | ❌ |
| 5 | `src/routes/auth.js` | `register`, `login`, `me`, `forgot-password`, `reset-password`; **error response shapes**, so `auth_failed` reason classes map to real codes and never echo the submitted identifier | ❌ |
| 6 | `src/routes/authBridge.js` | BD↔Advantage identity bridge: every redirect target, whether query strings survive, whether it can land on `advantageauction.bid` (§15 item 16) | ❌ |
| 7 | `src/routes/sellers.js` | `enroll`, `me`, `following`, `:id/follow` | ❌ |
| 8 | `src/routes/agreements.js` | `onboarding-status`, `by-token/:token`, `:id`, `:id/sign` | ❌ |
| 9 | `src/routes/verification.js` | `requests/mine`, `requests/:id/documents` — confirm **no** document type or content is exposed client-side in a form that could be sent to analytics | ❌ 🔒 |
| 10 | `src/routes/invoices.js` | `mine/combined`, `combined/:id/pdf` | ❌ |
| 11 | `src/routes/adminSettlements.js`, `sellerSettlements.js` | Confirm settlement data is **never** rendered into a client-readable global that instrumentation could accidentally capture | ❌ 🔒 |
| 12 | `src/routes/auctions.js` | Create/patch; the **publish** transition and whether it is client- or admin-triggered (§9.4 `auction_published` origin depends on this) | ❌ |
| 13 | `src/routes/marketing.js` | `auctions/:id/package` — confirm `package_tier` is a name, and that no price is required client-side | ❌ |
| 14 | `src/routes/terms.js`, `legal.js`, `config.js` | `terms_version` availability client-side | ❌ |
| 15 | `src/routes/admin*.js` (all) | Confirm every admin surface is behind `roleMiddleware(['admin'])`, so the §7.4 layer-2 role flag can be set reliably | ❌ |
| 16 | `src/middleware/widgetFraming.js` | Exact CSP directives, especially whether `script-src` is set (§13.5) | ❌ |
| 17 | `src/routes/orgEvents.js`, `adminEvents.js` | ✅ present — confirm the publish transition timestamp fields for `hours_in_queue` | ✅ |

### 16.2 Client-side inventory

| # | Target | What to record | Current |
|---|---|---|---|
| 18 | **Every existing `dataLayer` push** | Full-tree grep `dataLayer`. Known: `marketplace-feed.js:31`, `featured-items.js:33` ✅. Record event name, payload shape, call site. | ✅ partial |
| 19 | **Every `AAPAnalytics` call** | Grep `AAPAnalytics.track` / `.trackBatch` across `public/`. Record event type, metadata, context, call site. Cross-check against §10.3 — anything not listed there is an undocumented event. | ⚠ |
| 20 | **Every `analyticsService` call site** | Grep `insertEvent` / `insertBatch`. Confirm the **only** caller is `routes/analytics.js` ✅ — any other caller is a governance violation to report, not to fix silently. | ⚠ |
| 21 | **Every `postMessage` send and listener** | Grep `postMessage` / `addEventListener('message'`. Record origin validation, message shape, and which are analytics-relevant (§5.3). | ⚠ |
| 22 | **Every custom DOM event** | Grep `CustomEvent(` / `dispatchEvent(`. Reconcile against the §10.3 table; report any not listed. | ✅ partial |
| 23 | `widgets/shared/bid-utils.js`, `bid-status.js` | Watchlist add mechanism; bid submission helper; the correct hook points for `bid_submitted` / `bid_accepted` | ❌ |
| 24 | `widgets/shared/member-shell.js` | Whether it manipulates history / pushes virtual page views (§13.7) | ❌ |
| 25 | `widgets/shared/auth-refresh.js` | Where an authenticated bootstrap could deliver `analytics_uid` and the admin role flag (§7.2, §7.4) | ❌ |
| 26 | `return-to-auction.js`, `member-nav-config.js`, `utils.js` | Redirect targets and any hard-coded hosts | ❌ |
| 27 | All 50 `public/*.html` | Confirm none already contains an analytics snippet; confirm each has a `</head>` the middleware can anchor on | ✅ (grep clean) 🧪 |

### 16.3 Domain and configuration verification

| # | Target | What to confirm | Current |
|---|---|---|---|
| 28 | Full-tree grep `advantageauction` | Every occurrence, in the **complete** repository (§15 item 24) | ✅ 2 known |
| 29 | Full-tree grep `auctions.advantage.bid` | Every occurrence; and whether the host resolves (§13.6) | ✅ refs / 🧪 DNS |
| 30 | Full-tree grep `vercel` | Whether a Vercel deployment is live (§13.4) | ✅ config / 🧪 live |
| 31 | Railway env inventory | Whether `PUBLIC_BASE_URL`, `FRONTEND_URL`, `ALLOWED_ORIGINS`, `EMAIL_FROM` are explicitly set in **every** environment | 🧪 |
| 32 | `.gitignore` / secret hygiene | Confirm `.env` is ignored and no measurement ID, container ID, or API secret can be committed | ✅ file exists 🧪 |
| 33 | Redirect inventory | Every `res.redirect` and every static redirect rule; confirm query-string preservation (§8.4) | ⚠ |
| 34 | Ownership matrix | Re-read `agents/orchestration/ownership-matrix.md` and confirm which agent may touch each file in §17.1 | ✅ |

### 16.4 Output required

`docs/analytics/VERIFICATION_RESULTS.md` containing: the completed table with
every row marked ✅ / ❌ / corrected; the exact contract for each endpoint in
§10.4 that has an ⚠; a list of every discrepancy between this document and the
real repository; and a list of any event in code that is **not** in the §10
dictionary.

**Do not implement anything until this file exists and the owner has read it.**

---

## 17. Phased implementation plan with stop gates

Each phase is independently shippable and independently revertible. **Do not
compress phases.** The ordering exists so that when data looks wrong, the cause
is always the most recent change.

Every phase degrades to *no analytics*, never to *broken marketplace*.

### 17.1 Files in scope

**Must not be touched**

| File | Rule |
|---|---|
| `src/services/analyticsService.js` | No changes (AD-11). Ownership-restricted ✅. |
| `src/routes/analytics.js` | No changes. Ownership-restricted ✅. |
| `db/migrations/044_*.sql` | Applied. Never edit an applied migration. |
| `public/widgets/shared/analytics.js` | No changes. `AAPAnalytics` stays exactly as-is. |
| `src/middleware/shareMeta.js` | **Pattern reference only.** Do not extend (§5.2). |

**New**

| File | Purpose |
|---|---|
| `src/middleware/analyticsTag.js` | GTM injection (§5.2) |
| `public/widgets/shared/datalayer.js` | `AdvDL` helper: `dataLayer` init, key-strip enforcement (§11.3), never throws, never awaited |
| `src/services/ga4MeasurementProtocol.js` | Server-side GA4 sender (§10.5) |
| `docs/analytics/AAC_ANALYTICS.md` | This document |
| `docs/analytics/VERIFICATION_RESULTS.md` | §16 output |

**Modified**

`server.js` (one `app.use` line) · `.env.example` · `marketplace-embed.js` ·
the instrumented `public/*.html` pages per §9 · `src/routes/payments.js` (Phase 5) ·
`public/privacy.html` · `docs/analytics-telemetry.md` (§12, via its owning agent)

### 17.2 Phases

**Phase −1 — Repository verification** *(read-only)*
§16 in full → `VERIFICATION_RESULTS.md`.
> **STOP GATE:** owner has read the results. Every ⚠ on a Phase 1–4 item is
> resolved. Any discrepancy with this document is corrected here, in the
> document, before code is written.

**Phase 0 — Platform configuration** *(no code, nothing user-visible)*
1. GA4 data retention → 14 months.
2. Register every custom dimension and metric (§18.10) — **before any event fires**; they do not backfill.
3. Unwanted referrals (§6.3).
4. Session timeout → 1 hour (§6.4).
5. BigQuery export enabled (§7.6).
6. Search Console domain property verified and linked (§13.1).
7. AI Search custom channel group (§8.2).
8. Google Signals **off**; reporting identity **Observed**; data-sharing settings per §11.4.
9. Internal traffic filter created in **Testing** mode (§7.4 layer 1).
10. GTM container **created but not published**, containing only the GA4 Configuration tag; auto-triggers disabled; publish rights restricted.
11. UTM builder sheet created (§8.3).
> **STOP GATE:** nothing here can affect production. Owner confirms GA4 settings by screenshot. **Container is not published.**

**Phase 1 — Container plumbing, marketplace, staging only**
Files: `analyticsTag.js`, `server.js` (1 line), `.env.example`, `datalayer.js`.
Deploy to staging with `ANALYTICS_TAG_ENABLED=true` pointing at a **debug
property**, never `G-JM5JYGNJ6H`.
> **STOP GATE — all must pass:**
> - Exactly **one** `page_view` per load across ≥10 page types, including `/app.html` (§13.7)
> - **Zero** events from any `/widgets/*` URL (AD-9)
> - Every page still renders with `ANALYTICS_TAG_ENABLED=false`
> - Injection is idempotent: forcing a double-inject attempt produces one bootstrap (AD-19)
> - No Core Web Vitals regression on `/lot.html` and `/index.html`, ≥3 runs each

**Phase 2 — Production tagging, both hosts**
Precondition: **§14 BD audit complete and signed off**; `privacy.html` updated
(§11.2); §13.4 Vercel question resolved.
Publish the container; switch production `ANALYTICS_TAG_ENABLED=true`; paste into
BD head + the GTM `<noscript>` widget.
> **STOP GATE — this proves AD-5/AD-6 rather than assuming them:**
> - `advantage.bid` → `bid.advantage.bid` click-through is **one session, one user**; `session_start` fires exactly once
> - **Zero** self-referrals from any `*.advantage.bid` host over 48 hours
> - Page-source check on three BD page types finds exactly one analytics tag
> - A UTM-tagged inbound URL survives every redirect on both hosts (§8.4)

**Phase 3 — Read-only buyer and content events**
Files: `marketplace-embed.js`, feed/search/map/auction/lot/estate-sale pages,
`content_group` on all pages, watchlist.
No money-path events yet.
> **STOP GATE:** 48 hours of data. `(not set)` < 2% on `auction_id`, `lot_id`,
> `content_group`. Event counts within 10% of the equivalent `analytics_events`
> counts for the same window — **the first-party pipeline is the control group**
> that reveals GA4 under-collection.

**Phase 4 — Account and seller events**
Files: login/register, seller onboarding, agreements, creation, publishing.
Mark key events (§18.11). Build dashboards §18.1 and §18.9.
> **STOP GATE:** seller funnel reconciles against Postgres seller records within
> 5%. `user_id` present on **every** authenticated page view, not only on `login`
> (§7.5).

**Phase 5 — Money path** *(Governance Rule 7 as amended, §12)*
Files: `ga4MeasurementProtocol.js`, then `payments.js`, then the client
`client_id`/`session_id` capture.
Deploy the MP sender **first** and validate it in isolation against the GA4 MP
debug endpoint before any client change.
> **STOP GATE:** GA4 `purchase` count and value reconcile to Postgres paid
> invoices within **2%** over 7 days. **Zero** client-side `purchase` events
> exist. Payment success rate unchanged versus the prior 7 days. If
> reconciliation fails, revert `payments.js` only — nothing else depends on it.

**Phase 6 — Reporting and marketing activation**
Remaining dashboards; Google Ads link and conversion import; Consent Mode v2;
`refund`; GBP (§13.2).
> **STOP GATE:** §17.3 acceptance criteria all pass.

### 17.3 Acceptance criteria

| # | Criterion | Verified by |
|---|---|---|
| 1 | Exactly one GA4 measurement ID across the entire estate | repo grep + BD audit + GA4 Tag Diagnostics |
| 2 | One `page_view` per load, all page types, both hosts | DebugView, ≥10 page types |
| 3 | Zero GA4 events from `/widgets/*` | Pages report filtered to `/widgets/` returns nothing |
| 4 | `advantage.bid` → `bid.advantage.bid` = one session, one user | Live click-through in DebugView |
| 5 | Zero self-referrals from `*.advantage.bid` | Traffic acquisition, 7 days |
| 6 | All custom dimensions registered and populating, `(not set)` < 2% | Custom definitions + spot checks |
| 7 | GA4 `purchase` reconciles to Postgres within 2% | 7-day reconciliation query |
| 8 | No client-side `purchase` tag exists | Container audit |
| 9 | `analytics_events` ingestion unchanged from pre-GA4 baseline | Row counts by type, before vs after |
| 10 | **Every money-path page works with `ANALYTICS_TAG_ENABLED=false`** | Staging smoke test, tagging off |
| 11 | No Core Web Vitals regression | PageSpeed before/after, ≥3 runs |
| 12 | `privacy.html` discloses GA4 before the container is published | Manual review |
| 13 | No prohibited parameter (§11.3) appears in any event | BigQuery scan of one week of raw export |
| 14 | Internal/admin traffic excluded — admin sessions absent from acquisition reports | Filter validation |
| 15 | `advantageauction.bid` 301s cleanly and appears in no user-facing link | Crawl + repo grep |

**Criterion 10 is the one to take most seriously.** If the marketplace does not
work perfectly with analytics entirely switched off, the implementation is wrong
regardless of how good the data looks.

### 17.4 Rollback

| Phase | Rollback |
|---|---|
| −1, 0 | Nothing deployed. Leave registered custom dimensions in place. |
| 1 | `ANALYTICS_TAG_ENABLED=false` — **no deploy needed**, effective next request |
| 2 | Unpublish the container; remove BD head code |
| 3–4 | Revert the specific `public/*.html` commits; tagging keeps working |
| 5 | Revert `payments.js`. Payments unaffected — the MP call sits after the webhook's business logic and cannot alter it. |
| 6 | Unlink Ads; unpublish dashboards |


---

## 18. Dashboards, definitions and KPIs

### 18.0 Reporting architecture

| Layer | Tool | Why |
|---|---|---|
| Collection | GA4 via GTM + Measurement Protocol | §5 |
| Product / financial truth | Postgres | AD-13 |
| Warehouse | BigQuery (free GA4 export) | Breaks the 14-month wall; the only place GA4 and Postgres join (§7.6) |
| Dashboards | **Looker Studio** | Free; native GA4, Search Console and BigQuery connectors; shareable to people without GA4 access. GA4's own Explorations are analyst tools, not executive reporting. |
| Ad-hoc analysis | GA4 Explorations (funnel, path, segment overlap) | Analyst-facing |

> **Build order matters.** Build **§18.1 Executive** and **§18.9 Operations**
> first — they are the only two that reveal whether the instrumentation itself is
> working. The other seven are noise until ≥28 days of data exist, and building
> them early produces confident-looking dashboards full of nothing.

### 18.1 Executive KPIs
*Owner · weekly · decides where the next dollar and the next hour go*

- Headline: GMV · Net revenue · Take rate · New buyers · New sellers · Live auctions · Lots published
- GMV, 13 weeks, prior-period overlay
- Two-sided balance: lots published vs. active bidders on one axis
- Funnel: session → `view_item` → `bid_accepted` → `purchase`
- Key events by channel, 28 days
- **Instrumentation health traffic light (§18.12.6) — deliberately on the executive view**, so a data outage is never invisible

### 18.2 Marketing
*Marketing · weekly · decides which channel and campaign to scale or cut*

- Sessions, qualified sessions, key events, CAC, ROAS by `session_default_channel_group`
- Campaign table: source / medium / campaign → sessions, `bid_accepted`, `purchase`, revenue, ROAS
- Landing-page performance by `content_group`
- New vs returning by channel
- Cost per bidder and cost per seller lead by campaign
- **Last-click vs data-driven attribution side by side** — exposes channels that only ever assist
- UTM hygiene panel: sessions with an unrecognised `utm_medium` (§8.3) — should be zero

### 18.3 Marketplace Growth
*Owner + ops · weekly · decides which markets to open, seed or pause*

- Live auctions, lots published, lots with ≥1 bid, sell-through — trended
- Supply/demand heatmap by `state_code` / `city`: lots published vs. bidders
- Category performance: views, bids, sell-through, average value
- **Radius distribution from `radius_changed`** — how far buyers will actually travel; directly informs market spacing
- **`search_no_results` top terms** — demand with no supply behind it
- Estate sale vs auction mix
- `auction_extended` frequency — competitive intensity at close

### 18.4 Seller Growth
*Seller ops · weekly · decides where onboarding leaks*

- Full funnel with drop-off: `seller_cta_clicked` → `generate_lead` → `seller_onboarding_started` → `seller_type_selected` → `agreement_signed` → `payout_profile_completed` → `seller_onboarding_completed` → `auction_published`
- **`seller_onboarding_step` abandonment by `step_name`** — the most actionable chart here
- Time to first listing (median, P90); time to publish (median, P90)
- Seller cohort retention by enrolment month
- `ai_description_generated.accepted` vs listing completion
- Seller lead source: `cta_location` × `source_widget`
- `marketing_package_selected` mix by tier

### 18.5 Buyer Growth
*Growth · weekly · decides where buyer intent dies*

- Buyer funnel with per-step conversion (§18.12.2)
- **`bid_rejected` by `reason`** — the conversion-blocker chart. `not_verified` and `auth_required` here are product defects wearing a marketing costume.
- `bid_submitted` → `bid_accepted` gap — the pure failure rate
- Watchlist → bid conversion and time between
- **Outbid recovery:** users who re-bid after `user_outbid` ÷ users outbid
- `auction_lost` → return-visit rate — the retention opportunity
- New buyer activation curve: days from `sign_up` to first `bid_accepted`
- Repeat purchase rate and time to second purchase

### 18.6 SEO
*Marketing · weekly · decides what to publish next*

- Search Console: clicks, impressions, average position, CTR — trended
- Top queries and landing pages with GA4 behaviour joined
- **City-page yield:** organic entrances ÷ published directory pages
- **Directory → marketplace handoff rate** — proves whether the BD layer is doing its job
- Index coverage; new-page time-to-first-click
- Do canonical `bid.advantage.bid` auction and lot pages rank
- Core Web Vitals by page type — the reason GTM loads async (§5.1)
- Article performance: `content_group=article` → engagement → downstream `view_item`

### 18.7 AI Search / AI Referrals
*Owner + marketing · monthly · decides whether AI discovery deserves dedicated investment*

- AI referral sessions and share of total, trended (channel group §8.2)
- AI sessions by source
- **Landing pages receiving AI referrals** — reveals which content LLMs actually cite
- Engagement and key-event rate: AI vs organic vs direct. AI referrals typically convert at a **higher rate on lower volume**; if that holds here it argues for structured-data investment over ad spend.
- Entity coverage: do the JSON-LD `Event` / `Product` pages already emitted by `shareMeta.js` ✅ attract citations
- **Crawler visibility from Railway logs** (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`, `CCBot`) — invisible to GA4; crawl precedes citation, citation precedes referral

> The largest lever on AI discoverability — structured data — is **already
> built**. This dashboard measures whether it is paying off.

### 18.8 Revenue
*Owner + finance · weekly · decides pricing, fees and cash*

- GMV, net revenue, take rate — trended, **with GA4 vs Postgres reconciliation shown on the dashboard**
- Revenue by seller, category, market
- AOV and items per transaction
- `purchase` ÷ `checkout_started` — payment completion
- **`payment_failed` by `reason_code`** — directly recoverable revenue
- Invoice ageing and unpaid balance (Postgres)
- Refunds and chargebacks
- Revenue by acquisition channel — closes the loop with §18.2

### 18.9 Operations
*Ops · daily · source: Postgres and Railway, **not** GA4*

- Moderation queue depth and `hours_in_queue`, P50/P90 (from `adminEvents.js` state transitions ✅)
- Publish approval rate and rejection reasons
- **Stripe webhook health** — already exposed by `GET /api/health` ✅ (`server.js:559-574`): `last_webhook_received_at`, `webhook_failed_count_1h`, orphaned payment intents
- Measurement Protocol send success rate (new counter, §17.1)
- `analytics_events` ingestion volume and 429 rate
- API error rate and P95 latency
- Socket.IO connection health during live closes
- Verification queue depth and time to approve
- Event-import exceptions (per `event-import-framework-plan.md`)

### 18.10 Custom definitions registry

Register in **Admin → Data display → Custom definitions** in **Phase 0**.
Limits: 50 event-scoped, 25 user-scoped, 50 item-scoped. **Registering late means
no backfill.**

**Event-scoped dimensions (20)**

`auction_id` · `lot_id` · `event_id` · `auction_state` · `bid_type` ·
`is_first_bid` · `reason` · `city` · `state_code` · `market` · `filter_type` ·
`filter_value` · `search_type` · `entry_point` · `cta_location` ·
`source_widget` · `method` · `payment_type` · `step_name` · `package_tier`

**User-scoped dimensions (6)** — §7.3

`user_type` · `seller_status` · `verification_status` · `buyer_stage` ·
`first_market` · `account_age_bucket`

**Item-scoped dimensions (4)**

`lot_category` · `seller_id` · `auction_id` · `ships_nationwide`

**Custom metrics (7)**

`bid_amount` (currency) · `result_count` · `lot_count` · `image_count` ·
`duration_seconds` · `hours_in_queue` · `extension_seconds`

### 18.11 Key events (conversions)

GA4 renamed conversions to **key events**. Mark exactly these — marking more
makes the conversion report meaningless.

| Tier | Key event | Why |
|---|---|---|
| **Primary** | `purchase` | The business outcome. Import to Google Ads. |
| **Primary** | `seller_onboarding_completed` | Supply is the marketplace constraint. |
| **Primary** | `bid_accepted` | Strongest leading indicator of GMV. |
| Secondary | `sign_up` | Account creation |
| Secondary | `generate_lead` | Seller/organiser interest; Ads optimisation |
| Secondary | `auction_published` | Supply actually reaching the market |
| Secondary | `add_to_wishlist` | High-intent buyer signal; a usable Ads optimisation proxy while `purchase` volume is thin |

### 18.12 KPI definitions

Stated as formulas so two people cannot compute them differently.

**18.12.1 Marketplace health**

| KPI | Definition | Source |
|---|---|---|
| GMV | Σ `purchase.value` | **Postgres** (authoritative); GA4 for trend |
| Take rate | Platform fees ÷ GMV | Postgres |
| Net revenue | Σ platform fees + Σ buyer premiums | Postgres |
| Sell-through | Lots sold ÷ lots published | Postgres |
| Average lot value | GMV ÷ lots sold | Postgres |
| Bid depth | `bid_accepted` ÷ lots with ≥1 bid | GA4 + Postgres |
| Liquidity | Lots with ≥1 bid ÷ lots published | Postgres |

**18.12.2 Buyer funnel**

| KPI | Formula |
|---|---|
| Discovery → Detail | `view_item` sessions ÷ `view_item_list` sessions |
| Detail → Intent | (`add_to_wishlist` + `bid_started`) sessions ÷ `view_item` sessions |
| Intent → Submit | `bid_submitted` users ÷ `bid_started` users |
| **Bid success rate** | `bid_accepted` ÷ `bid_submitted` |
| Bid conversion rate | `bid_accepted` sessions ÷ total sessions |
| Bid → Win | `auction_won` users ÷ `bid_accepted` users |
| Win → Pay | `purchase` ÷ `auction_won` |
| **Payment completion** | `purchase` ÷ `checkout_started` |
| New buyer activation | Users with `bid_accepted` within 7 days of `sign_up` ÷ `sign_up` |
| Repeat buyer rate | Users with ≥2 `purchase` in 90 days ÷ purchasers |
| Outbid recovery | Users re-bidding after `user_outbid` ÷ users outbid |

**18.12.3 Seller funnel**

| KPI | Formula |
|---|---|
| Seller lead rate | `generate_lead` ÷ sessions with `content_group=seller` |
| Onboarding completion | `seller_onboarding_completed` ÷ `seller_onboarding_started` |
| Agreement conversion | `agreement_signed` ÷ `seller_type_selected` |
| Time to first listing | median hours, `seller_onboarding_completed` → first `auction_draft_saved` |
| Time to publish | median hours, `auction_create_started` → `auction_published` |
| Listing completion | `auction_submitted` ÷ `auction_create_started` |
| Lots per auction | mean `lot_count` at `auction_published` |
| Active seller rate | Sellers with ≥1 live auction ÷ enrolled sellers |
| Seller retention | Sellers publishing in 2 consecutive months ÷ month-1 publishers |

**18.12.4 Acquisition**

| KPI | Formula |
|---|---|
| Qualified session | Session with ≥1 of `view_item`, `bid_started`, `search`, `seller_cta_clicked` |
| Cost per bidder | Ad spend ÷ users with `bid_accepted` |
| CAC (buyer) | Buyer-campaign spend ÷ new purchasers |
| CAC (seller) | Seller-campaign spend ÷ `seller_onboarding_completed` |
| ROAS | `purchase.value` ÷ ad spend |
| Assisted conversions | Key events where a channel appears in the path but is not last |

*The `utm_campaign` audience prefix (§8.3) is what makes buyer CAC and seller CAC
separable. Without it, both numbers are unavailable — permanently, for any
campaign that ran without it.*

**18.12.5 SEO & discovery**

| KPI | Formula |
|---|---|
| Organic entrances | Sessions, channel = Organic Search |
| Indexed-page yield | Organic entrances ÷ indexed pages |
| City-page yield | Organic entrances to `content_group=directory` ÷ city pages published |
| Directory → marketplace handoff | Sessions reaching `bid.advantage.bid` ÷ sessions landing on `advantage.bid` |
| CTR | Search Console clicks ÷ impressions |
| AI referral share | AI-channel sessions ÷ total sessions |

**18.12.6 Instrumentation health — watch weekly**

| KPI | Healthy | If wrong |
|---|---|---|
| `page_view` per session | 1.5 – 8 | >2× expected ⇒ duplicate tagging |
| Self-referrals from `*.advantage.bid` | **0** | >0 ⇒ cookie domain or referral exclusion broken |
| `(not set)` on `auction_id` in `view_auction` | <2% | Parameter not being passed |
| GA4 `purchase` vs Postgres paid invoices | within 2% | >5% ⇒ Measurement Protocol failing |
| Monetary events missing `currency` | **0** | `value` unusable |
| `user_id` coverage on authenticated pageviews | >95% | §7.5 bug — set on every authenticated load, not only `login` |
| Sessions with unrecognised `utm_medium` | **0** | UTM policy not being followed (§8.3) |

---

## 19. Answers to the nine open questions from v1.0

Direct answers or recommended defaults, as requested. Items that **cannot safely
be inferred** are called out and repeated in §20.

**Q1 — Is `advantageauction.bid` live, and do you want to retire it?**
**Answered by owner: retire. Approved.** Full remediation scope and safe
sequencing in §15. *Still needs from you:* confirmation of whether the domain is
currently resolving and serving, which determines whether step 1 of §15.2 is a
change or a no-op. → §20 Q-B

**Q2 — Do you approve the Governance Rule 7 amendment?**
**Answered by owner: approved, narrow.** Final text in §12, with seven operative
constraints and a closed event allow-list. No further owner input needed.

**Q3 — Does BD already have an analytics tag installed?**
**Cannot be determined from Desktop** — it requires BD admin access. §14 is the
16-point audit checklist. **Recommended default: assume yes until proven
otherwise.** BD sites very commonly carry a legacy tag, and the cost of checking
is minutes while the cost of missing one is months of doubled data. → §20 Q-C

**Q4 — Is the Vercel deployment live and publicly reachable?**
**Cannot be determined from Desktop.** `vercel.json` ✅ exists and is configured;
whether a deployment is live is a Vercel-account question.
**Recommended default: treat as live until disproven.** Check the Vercel
dashboard; if there is no project, delete `vercel.json` in Phase 1 so the
question never recurs. → §20 Q-D

**Q5 — Does `auctions.advantage.bid` resolve?**
**Cannot be determined from Desktop** (no DNS resolution available here).
References exist only in doc comments ✅ (§13.6).
**Recommended default: assume it does not resolve, but verify with a single DNS
lookup before Phase 2.** If it does resolve and serves widgets, it becomes a
third tagged host and must be added to §14 and §15. → §20 Q-E

**Q6 — Is Consent Mode v2 in scope now?**
**Recommended default: implement in Phase 1**, at bootstrap, before any tag
exists. Retrofitting is materially harder. If there is genuinely no EEA/UK
traffic and no plan for it, deferring is defensible — but record the decision and
revisit before any international spend (§11.2). **This is a policy decision with
legal dimensions: 🔒 owner/counsel, not inferable.** → §20 Q-F

**Q7 — Is there a Google Ads account to link, and is spend live today?**
**Cannot be determined from Desktop.**
**Recommended default: assume no live spend, and sequence the Ads link into
Phase 6.** Two consequences if that assumption is wrong: (a) §14 item 7 becomes
urgent — removing a live Ads conversion tag from BD breaks active campaigns;
(b) auto-tagging must be confirmed on before Phase 2, or paid traffic lands in
`direct` from the moment tagging starts. → §20 Q-G

**Q8 — Who holds GTM publish rights?**
**Cannot be inferred — this is an accountability decision.**
**Recommended default: exactly one named publisher** (the owner or a single
delegate); everyone else gets Edit. §5.1 rule 4 assumes this. A container with
multiple publishers and no review is the fastest route to an unexplained
production change. → §20 Q-H

**Q9 — Sequence GBP now or after the first estate-sale markets launch?**
**Recommended default: after.** GBP's value is concentrated in physical presence
and local intent; before markets launch there is little to list and no local
demand to capture. **Exception:** if any pickup location or office already exists
publicly, claim and verify the listing now — verification takes time and is
independent of the analytics work. Do **not** defer Search Console (§13.1); that
one is Phase 0 regardless.

---

## 20. Open items requiring an owner decision

Nothing below can be safely inferred. Each blocks the phase named.

| ID | Decision needed | Blocks | Recommended default |
|---|---|---|---|
| ~~**Q-A**~~ | ~~Canonical marketing form~~ — **RESOLVED 2026-07-30 (AD-21):** marketing canonical is `https://www.advantage.bid`; apex 301s to `www`. Application canonical is `https://bid.advantage.bid` (AD-22). Apply universally: canonical tags, sitemaps, GBP, UTMs, email templates, `EVENT_ORIGINS`, CORS, `frame-ancestors`. | — | **Closed** |
| **Q-B** | Is `advantageauction.bid` currently resolving and serving an application? | §15 step 1 | Assume yes; verify |
| **Q-C** | BD analytics audit result (§14) | **Phase 2** | Assume a legacy tag exists until proven otherwise |
| **Q-D** | Is a Vercel deployment publicly live? (§13.4) | Phase 1 | Treat as live until disproven |
| **Q-E** | Does `auctions.advantage.bid` resolve? (§13.6) | Phase 2 | One DNS lookup |
| **Q-F** | 🔒 Consent Mode v2 scope; applicable privacy obligations; cookie/privacy policy wording | **Phase 2** (privacy disclosure is a hard gate) | Implement Consent Mode in Phase 1; policy text reviewed by the owner or counsel |
| **Q-G** | Google Ads account status and live spend | Phase 2 (auto-tagging), Phase 6 (link) | Assume none; confirm before Phase 2 |
| **Q-H** | Named GTM publisher | Phase 0 | Exactly one named person |
| **Q-I** | 🔒 Approve the `analytics_uid` derivation (§7.2) and where `ANALYTICS_UID_SECRET` is stored | Phase 4 | HMAC-SHA256, Railway env, rotatable |
| **Q-J** | 🔒 Accept the `search_term` trade-off (§11.3) | Phase 3 | Accept with the stated mitigations |
| **Q-K** | 🔒 GA4 data-sharing settings (§11.4) | Phase 0 | Technical support ON, modeling ON, Google products/services OFF |
| **Q-L** | 🔒 Written deletion runbook, including BigQuery (§11.5) | Before go-live | Must be authored; does not exist |
| **Q-M** | Owner accountable for the UTM builder (§8.3) | Phase 6 | One named person |
| **Q-N** | **Is `src/routes/adminEventImports.js` intentionally unmounted, or is the mount part of Commit 11?** (§23.1) | Phase 0 close-out | Assume Commit 11 adds it; confirm rather than assume |
| **Q-O** | **Did Commit 13's expired-stub / `noindex` / sitemap-removal behaviour land?** The four surfaces §5.2 of the import plan targets still read as pre-change (§23.3) | Phase 0 close-out, and §18.6 SEO dashboard | Confirm scope of Commit 13 before building SEO reporting on it |
| **Q-P** | Should imported-event **source attribution** be a reportable GA4 dimension? (§22.2) | Phase 3 | Yes — `event_source` and `attribution_source`; both are already public on the page |

---

## 21. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-07-30 | Initial architecture review, measurement plan, dashboards, work order. Awaiting approval. No code modified. |
| 2.1 | 2026-07-30 | Second round of owner decisions recorded as **AD-21…AD-31**: canonical hosts fixed (`www.advantage.bid` marketing, `bid.advantage.bid` application — closes Q-A), Postgres as operational analytics truth with GA4 behavioural-only, Google Signals off, role-first internal suppression, HMAC `analytics_uid`, four separate bid events, reason classes only, no PII. Architecture re-verified against the **full** repository at Event Import Framework Commits 7/8/10/12/13 — §3.4 completeness caveat lifted, §13.5 CSP risk closed, several ⚠ resolved to ✅. Added **§22** (Event Import Framework measurement addendum: `event_source` / `attribution_source` dimensions, `attribution_source_clicked`, Postgres-sourced review-queue ops metrics, seven Phase 0 verification additions) and **§23** (findings: `adminEventImports.js` unmounted; `/auth/bd/return` must never be tagged; Commit 13 SEO/expiry behaviour not visible in code; registration captures no acquisition data). Phase 0 readiness assessed **GREEN**. New open items Q-N, Q-O, Q-P. **No code modified. No container published. No GA4 property or stream created.** |
| 2.0 | 2026-07-30 | Owner decisions AD-1…AD-20 incorporated as binding. Governance Rule 7 amendment approved (§12). `advantageauction.bid` retirement approved with full remediation scope (§15). Added identity model (§7), acquisition & UTM policy (§8), site-area measurement matrix (§9), canonical event dictionary with 30→14 name normalisation (§10), privacy & prohibited-data matrix (§11), BD audit checklist (§14), repository verification checklist (§16), phased plan with stop gates (§17). Verification markers applied throughout. Nine v1.0 questions answered (§19); thirteen open owner items isolated (§20). **No code modified. No container published. No GA4 property or stream created.** |

---

## 22. Event Import Framework — measurement addendum (v2.1)

Commits 7, 8, 10, 12 and 13 introduce a genuinely new measurement surface: events
that Advantage did not author. This section **extends** the §10 taxonomy; it does
not revise it (AD-31).

### 22.1 Why this changes the analytics picture

Until now every event on the platform was authored by an organiser or an admin.
Imported events are different in three ways that matter to reporting:

1. **They are not owned demand.** An imported listing is inventory Advantage
   surfaced, not inventory Advantage won. Mixing the two makes marketplace-growth
   metrics meaningless — supply growth would look like organiser acquisition.
2. **They carry third-party attribution.** `attribution_source` and
   `attribution_url` are surfaced on the public page
   (`public/event.html:94` ✅, rendered as *"Listing sourced from … Not hosted or
   endorsed by Advantage"*). That is a public, non-sensitive field and therefore
   a legitimate GA4 dimension.
3. **They have an admin gate.** Nothing publishes without an explicit approval in
   the review queue (`adminEventImports.js` ✅). Time-in-queue is now an
   operational metric with real business consequence — an imported sale approved
   after it ends is wasted inventory.

### 22.2 New dimensions

Register alongside §18.10. All three are low-cardinality, non-identifying, and
already public.

| Dimension | Scope | Values | Purpose |
|---|---|---|---|
| `event_source` | Event | `imported` \| `organizer` \| `admin` | **The single most important new dimension.** Segments every estate-sale metric by provenance. Without it, imported and owned supply are indistinguishable. |
| `attribution_source` | Event | source name, e.g. `estatesales-org` | Which import source actually produces engagement — the input to source-level investment decisions |
| `market` | Event | `houston`, `nyc_tristate`, `national`, … | Already in §18.10; now carries the curated-market meaning from the import plan |
| `organizer_badge` | Event | derived from `source` ✅ (`eventsService.deriveOrganizerBadge`) | Whether the verified-organiser badge affects click-through — a directly testable trust question |
| `market_resolved_via` | **OPS only** | `radius` \| `zip` \| `city` \| `fallback` | **Postgres, not GA4.** A pipeline-quality metric, not a behavioural one. Belongs on §18.9. |

### 22.3 Event additions

No new event *names* — the existing estate-sale events simply carry the new
dimensions. That is deliberate: a separate `view_imported_estate_sale` would
fork every downstream report for no analytical gain.

| Existing event | Addition | Status |
|---|---|---|
| `view_estate_sale` | + `event_source`, `attribution_source`, `market`, `organizer_badge` | ✅ fields available in the public payload |
| `feed_loaded` / `view_item_list` (estate-sale presets) | + `event_source` mix in `items[]` | ✅ |
| `item_selected` / `select_item` | + `event_source`, `attribution_source` | ✅ |
| `estate_sale_submitted` / `estate_sale_published` | + `event_source` | ✅ |
| **`attribution_source_clicked`** *(new)* | Outbound click on the "source" link in the attribution line. `attribution_source` required. **Measures leakage** — traffic leaving to the originating site. | NEW ✅ |
| **`expired_event_viewed`** *(new, conditional)* | Fires on the expired-sale stub. `market` required. Measures wasted arrivals and justifies the redirect-to-active-events UX. | **Blocked on Q-O** — the stub may not exist yet (§23.3) |

`attribution_source_clicked` is worth calling out: an attribution link is a
deliberate, legally-motivated outbound path, and it is the one place where
imported inventory can send a visitor away. Measuring it tells you whether
imported events are a discovery asset or a leak.

### 22.4 Admin Review Queue — operational, not marketing (§9.5)

Per AD-24 and the §9.5 rule, the review queue is measured in **Postgres**, never
GA4. The API already produces everything needed, and admin traffic is suppressed
from GA4 anyway (AD-26), so GA4 events here would be discarded or would force
internal traffic to stay unfiltered.

Ops metrics for dashboard §18.9, sourced from `events`, `event_sources`,
`import_runs`, `import_run_items` and `audit_log`:

| Metric | Definition |
|---|---|
| Queue depth | Pending imported events, by source and market |
| **Time in queue** | P50 / P90 hours, import → approve/reject |
| **Approval rate** | approved ÷ (approved + rejected) — by source. A source below ~50% is costing more review time than it returns. |
| **Expired-in-queue** | Imported events whose `end_at` passed *before* approval. **The metric that matters most** — it is pure wasted inventory and it is invisible unless deliberately measured. |
| Bulk vs individual actions | Share via `bulk-approve` / `approve-all` — a review-effort signal |
| `approve-all` count-mismatch 409s | Concurrency friction; a rising rate means the queue is churning faster than admins can review it |
| Quality-gate rejections | `rejected_quality` in `import_run_items`, by reason — including the `end_at`-not-computable gate |
| Market resolution mix | `market_resolved_via` distribution; `fallback` share is the metro-discovery backlog |
| Source sync health | `event_sources.sync_status`, incl. `removed` |

All of these are already recorded by the import pipeline. **No new
instrumentation is required — only queries.** That is the cheapest dashboard in
this entire plan.

### 22.5 Phase 0 verification additions

Added to §16 and to `PHASE_0_PROMPT.md`:

| # | Target | Confirm |
|---|---|---|
| 35 | `src/routes/adminEventImports.js` | Whether it is mounted in `server.js`. **At this baseline it is not** (§23.1). |
| 36 | Commit 11 Admin Review Queue UI | Which file(s) it lands in; whether it is a new `public/*.html` page (→ AD-20 auto-tagging applies, so it needs an explicit §9.6 exclusion) or part of the member shell |
| 37 | `src/services/eventImport/reviewQueue.js` | The exact status transitions and timestamp columns that yield `time_in_queue` and `expired_in_queue` |
| 38 | `import_runs`, `import_run_items`, `event_sources`, `import_sources` | Column inventory for the §22.4 queries |
| 39 | Commit 13 SEO/expiry behaviour | Whether the expired-stub, `noindex` and sitemap-removal changes landed on all four surfaces (§23.3) |
| 40 | `public/event.html` | Whether `attribution_source` / `attribution_url` are reliably present client-side for `attribution_source_clicked` |
| 41 | `/auth/bd/return` | Confirm it is **not** reachable by the injection middleware, and add an explicit exclusion regardless (§23.2) |

---

## 23. v2.1 findings, changed recommendations and risks

### 23.1 🔴 `adminEventImports.js` is not mounted

`src/routes/adminEventImports.js` ✅ exists and is complete — queue listing,
detail, approve/reject, bulk operations, and an `approve-all` guarded by an
`expectedCount` optimistic-concurrency check. It is **not present in any
`app.use(...)` line in `server.js`** at this baseline.

Every other admin router is mounted (`/api/admin/agreements`,
`/api/admin/events`, `/api/admin/settlements`, and so on). `/api/admin/event-imports`
is absent.

**Most likely benign:** Commit 11 (the UI) presumably adds the mount alongside
the interface it serves. **But it should be confirmed, not assumed** — an
unmounted API is indistinguishable from a forgotten one until someone checks, and
if Commit 11 is being built against an endpoint that returns 404, that surfaces
late and expensively. → **Q-N**

*No analytics impact.* The review queue is Postgres-measured (§22.4), so this
does not block Phase 0. It is flagged because it was found while verifying, and
a finding withheld is a finding wasted.

### 23.2 🔒 New exclusion — `/auth/bd/return` must never be tagged

The identity bridge (`authBridge.js` ✅, enabled by `IDENTITY_BRIDGE_ENABLED`)
lands the browser on `GET /auth/bd/return?code=…`, which returns an HTML seed
page carrying **a signed JWT inside an inline script**.

Two independent reasons this page is excluded:

1. **Security (the real one).** GTM loads remote JavaScript. Placing it in a
   document that contains a live bearer token puts third-party-controlled code in
   the same origin and DOM as that token. Whatever the container is trusted to
   do today, it is a category of exposure with no upside.
2. **Data quality.** It is a zero-value interstitial. Tagged, it would appear in
   landing-page reports and fragment the login journey.

**Attribution is unaffected by excluding it.** Both hosts share the
`.advantage.bid` cookie (AD-5), so client ID, session and campaign attribution
survive the hop in the cookie — they were never carried in the URL. The bridge
redirect (`bridgeHandlers.js:43` ✅) passes only `code`, which is correct
behaviour and needs no change.

Because the route is served by Express rather than from `public/`, the §5.2
middleware would not reach it anyway. **Add the explicit exclusion regardless** —
defence that depends on a coincidence of routing is not defence.

### 23.3 ⚠ Commit 13's SEO/expiry behaviour is not visible in the code read

The Event Import Framework plan §5.2 specifies, for `source='imported'` events
after `end_at`: a minimal `{ expired: true }` payload, an expired-stub page,
`<meta name="robots" content="noindex,follow">`, `getEventMeta()` returning
`null`, sitemap removal, and `410 Gone` when `event_sources.sync_status =
'removed'`.

At this baseline, all four targeted surfaces still read as pre-change:

| Plan surface | Current code | Expected after Commit 13 |
|---|---|---|
| `GET /api/public/events/:slug` | `WHERE e.slug=$1 AND e.status='published'` — no expiry branch ✅ | `{ expired: true, … }` minimal payload |
| `shareMetaService.getEventMeta()` | Same filter; comment still reads *"ended events remain viewable for historical value, so they still get rich meta"* ✅ | `null` for expired imported events |
| `shareMeta` event body injection | Follows `getEventMeta()` | Skipped + `noindex` |
| `getSitemapEntries().events` | `status='published' AND slug IS NOT NULL`, comment still reads *"ended ones included … safe to list"* ✅ | Expired imported slugs excluded |

`public/event.html` contains the attribution line (Commit 12) but **no**
`robots`, `noindex` or expired-stub rendering.

**Three possible explanations, and I am not going to guess between them:** the
scope of "Commit 13" differs from plan §5.2; the change landed in files not read
at this baseline; or it is still pending. → **Q-O**

**Why it matters to analytics rather than only to SEO:** dashboard §18.6 measures
indexed-page yield and city-page yield. If expired imported events remain in the
sitemap, the indexed-page denominator inflates with pages that cannot convert,
and organic-yield metrics drift downward for a reason that has nothing to do with
content quality. The `expired_event_viewed` event (§22.3) is also blocked on
this. **Confirm the answer before building §18.6**, not after.

### 23.4 Bid rejection reason classes — now enumerable (AD-29)

With `auth.js` ✅ readable, the auth-side classes are concrete and can be mapped
without ever echoing a submitted value:

| HTTP | Condition | `reason` class |
|---|---|---|
| 400 | Missing/short credentials | `validation` |
| 401 | Bad credentials | `invalid_credentials` |
| 403 | Suspended account | `account_suspended` |
| 409 | Email already registered | `already_registered` |

Bid-side classes (`below_increment`, `auction_closed`, `not_verified`,
`auth_required`, `server_error`) are pending the `lots.js` read in Phase 0 —
**the enumerated list must come from the code, not from this document.** Any
class not present in the source is a guess, and a guessed reason class produces a
dashboard that quietly never fires.

### 23.5 What Phase 0 no longer needs to do

Resolved at this baseline; removed from the critical path:

- `widgetFraming.js` CSP — ✅ read; `frame-ancestors` only (§13.5)
- Watchlist add endpoint — ✅ `POST /api/watchlist/add`
- Stripe webhook existence, signature verification, idempotency middleware — ✅
- Auth error response shapes — ✅ (§23.4)
- Whether the first-party pipeline was disturbed — ✅ untouched
- Whether any analytics tag already exists in the repo — ✅ still zero

Phase 0's remaining weight sits where it should: the **Brilliant Directories
audit** (§14, which no code read can substitute for), the bid endpoint contract,
`member-shell.js` history behaviour, and the seven Event Import additions in
§22.5.

### 23.6 Registration captures no acquisition data — GA4 is the only record

`docs/roadmap-registration-attribution.md` ✅ confirms that `POST /register`
creates only a `users` row and captures **no acquisition or attribution data**;
a "How did you hear about us?" prompt is an explicit future roadmap item with no
implementation.

**Consequence:** until that ships, GA4 is the *sole* record of where a registered
user came from. That raises the stakes on two things already in this plan —
Phase 2's unwanted-referral configuration (§6.3) and the §8.3 UTM policy. A
campaign that runs untagged before Phase 2 produces registrations whose origin is
unrecoverable from any system.

It also strengthens the case for the roadmap item: a self-declared source
survives ad blockers, consent refusal and GA4's 14-month retention, and it is the
natural cross-check against GA4's channel attribution. Worth sequencing after
Analytics Phase 4, when there is a channel model to validate it against.

### 23.7 Recommendations that did NOT change

Stated explicitly, because "nothing changed" is itself a finding worth recording:

- The GTM / gtag decision (AD-3, §5.1) — unaffected by Commits 7–13
- The `analyticsTag.js` middleware pattern (AD-17, §5.2) — the new surfaces are still static pages under `public/`, so single-point injection still covers them automatically (AD-20)
- Cross-domain conclusion (AD-6, §6.1) — AD-21 fixing `www` as canonical **strengthens** it: one canonical marketing host means one fewer hostname pair that can self-refer
- Server-side `purchase` via Measurement Protocol (AD-15/16) — the webhook read at this baseline confirms it is the right insertion point, with `stripe_webhook_events` idempotency already in place
- The §10 event taxonomy — extended by §22, not revised
- Phase ordering and stop gates (§17) — unchanged; see §23.8

### 23.8 Phase 0 readiness assessment

**Phase 0 remains the correct next step, and it is still correct to run it after
Commit 11 lands.** Two reasons, and the second is the one that matters:

1. Phase 0 is read-only and produces documents. It cannot conflict with Commit 11.
2. Commit 11 will add at least one new admin surface, and possibly a new
   `public/*.html` page. Because AD-20 makes tagging automatic for anything under
   `public/`, **a new admin page created after the verification pass would be
   auto-tagged by default** — the opposite of what §9.5 and AD-26 require.
   Running Phase 0 after Commit 11 means the review-queue UI is inventoried and
   explicitly excluded in the same pass, rather than being discovered later as an
   admin page quietly reporting into marketing analytics.

**Readiness: GREEN, with two qualifications.**

| Item | State |
|---|---|
| Architecture decisions | ✅ Settled — AD-1…AD-31 |
| Canonical hosts | ✅ Settled — AD-21 / AD-22 |
| Governance Rule 7 | ✅ Amended and approved (§12) |
| Repository readable | ✅ Full tree |
| Phase 0 scope | ✅ Defined, extended for event imports (§22.5) |
| Phase 0 is read-only | ✅ No conflict with Commit 11 |
| **Q-N** (`adminEventImports` mount) | ⚠ Confirm during Phase 0 |
| **Q-O** (Commit 13 SEO/expiry) | ⚠ Confirm during Phase 0 — blocks §18.6 and `expired_event_viewed`, blocks nothing else |
| **Q-C** (BD analytics audit) | 🔴 Still the hard blocker for **Phase 2**, not Phase 0. Requires BD admin access; no code read substitutes for it. Start it in parallel with Phase 0. |
| **Q-F** (consent / privacy policy) | 🔒 Still required before Phase 2 |

Neither qualification blocks starting Phase 0. **Q-C is the one to start moving
on now**, because it is the only remaining blocker that depends on someone
outside this repository.

