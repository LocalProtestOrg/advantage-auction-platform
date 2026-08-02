# GA4 Implementation Audit — Advantage.Bid

**Date:** 2026-08-02
**Method:** Live browser session (Chrome), real page loads, DOM inspection, network-request capture, plus the Commit-15 repository verification from Phase 0.
**Expected property:** `Advantage.Bid` — Measurement ID `G-JM5JYGNJ6H`, Stream ID `15353439652`

## FINAL STATUS: 🔴 NOT WORKING

**Root cause, in one sentence: the marketing site is sending its data to a
different GA4 property (`G-DBCGKMC9DQ`), and the marketplace application is
sending nothing at all.**

The property you are looking at has no data because nothing has ever sent data
to it. This is not a delay, not a filter, and not a reporting-identity problem.

**No changes were made.** The fixes require Brilliant Directories admin access
and a Railway deployment, both of which are gated by your own phase control, and
GA4 console changes require a signed-in session that I must not create.

---

## 1. The two findings that explain everything

### Finding A 🔴 — `www.advantage.bid` reports to the wrong property

Live evidence from `https://www.advantage.bid/`:

```
<script src="https://www.googletagmanager.com/gtag/js?id=G-DBCGKMC9DQ">
gtag('config', 'G-DBCGKMC9DQ')
```

| Expected | Actually installed |
|---|---|
| `G-JM5JYGNJ6H` | **`G-DBCGKMC9DQ`** |

Confirmed on `/`, `/auctions`, `/estate-sales`, `/login` — every page carries
`G-DBCGKMC9DQ`, and **`G-JM5JYGNJ6H` appears nowhere on the site.**

Cookies present in the browser: `_ga` and **`_ga_DBCGKMC9DQ`** — the session
cookie for the *other* property. There is no `_ga_JM5JYGNJ6H` cookie, because no
tag has ever created one.

Live `page_view` beacon captured:

```
POST https://www.google-analytics.com/g/collect
  ?v=2&tid=G-DBCGKMC9DQ … &en=page_view
  &dl=https%3A%2F%2Fwww.advantage.bid%2F
```

**`tid=G-DBCGKMC9DQ`.** That is where your marketing traffic has been going.

### Finding B 🔴 — `bid.advantage.bid` has no analytics whatsoever

Scanned live: `/`, `/search.html`, `/events.html`, `/event.html`,
`/auction-view.html`, `/lot.html`, `/browse-locations.html`, `/login.html`,
`/seller-dashboard.html`, `/account.html`, `/items`.

| Check | Result on every page |
|---|---|
| GA4 measurement ID | **none** |
| GTM container | **none** |
| `gtag/js` loader | **none** |
| `window.gtag` | `undefined` |
| `window.dataLayer` | `undefined` |
| `window.google_tag_manager` | `undefined` |

This matches the repository exactly: `src/middleware/analyticsTag.js` does not
exist, `ANALYTICS_TAG_ENABLED` does not exist, and Phase 1 was never
implemented. **The marketplace has never been tagged.**

`/auction-view.html` loads `/widgets/shared/analytics.js` (the first-party
`AAPAnalytics` helper) but never calls it — the dead include already recorded in
the Phase 0 findings. It is unrelated to GA4.

---

## 2. Answers to the audit questions

**1. Is GA4 installed correctly?** **No.** Installed on the marketing site with
the wrong measurement ID, duplicated; entirely absent from the application.

**2. Is GTM installed correctly?** **GTM is not installed at all.** No `GTM-`
container on either host. The BD site uses a direct `gtag.js` snippet.
`window.google_tag_manager` exists on the BD site, but its keys are
`G-DBCGKMC9DQ`, `dataLayer`, `tcf`, `pscdl` — that is the gtag.js runtime, which
shares the GTM namespace. It is not a container.

**3. Does the homepage fire `page_view`?** **Yes — to the wrong property.** One
`page_view` per load on `www.advantage.bid`, `tid=G-DBCGKMC9DQ`. A `scroll` event
(Enhanced Measurement) also fires.

**4. Does Railway fire `page_view`?** **No.** No tag exists on
`bid.advantage.bid`. Nothing fires, on any page.

**5. Does Realtime work?** **Not for `G-JM5JYGNJ6H`** — it will stay empty no
matter how many times you visit either site, because nothing sends to that ID.
Realtime for `G-DBCGKMC9DQ` should show marketing-site traffic (subject to item
6). I could not confirm this in the console: the Google Analytics tab in your
browser is **signed out**, and I must not sign in on your behalf.

**6. Are network requests reaching Google?** **Partly, and this needs your
eyes.** Requests are sent to `https://www.google-analytics.com/g/collect`, and
they are **not** blocked by CSP or an ad blocker — no CSP header, no CSP meta
tag, no console errors, no blocked requests.

However, all five `page_view`/`scroll` beacons captured from the live tag were
logged with **HTTP 503**. To test whether that was the endpoint, the measurement
ID, or something else, I sent six manual probes to the identical endpoint from
the identical browser and origin:

| Probe | Result |
|---|---|
| `tid=G-DBCGKMC9DQ` (the installed ID) | **204** ✅ |
| `tid=G-JM5JYGNJ6H` (the correct ID) | **204** ✅ |
| `tid=G-ZZZZZZZZZZ` (bogus control) | **204** ✅ |

So the endpoint is healthy, both real measurement IDs are accepted, and the 503
is specific to the beacons the tag itself emits. Two plausible explanations —
a transient Google-side rejection of that particular beacon shape, or the
browser extension mis-reporting the status of `keepalive`/`sendBeacon` requests,
which is a known reporting quirk. **Confirm this in Chrome's own DevTools →
Network → filter `collect`.** If DevTools also shows 503 consistently, it is a
second real problem worth raising with Google.

I have deliberately not concluded which it is. It is also secondary: even at 204,
the data lands in the wrong property.

**7. Is the correct property receiving data?** **No.** `G-JM5JYGNJ6H` has never
received a hit from either domain.

**8. Are custom marketplace events reaching GA4?** **No — they are not even
reaching `dataLayer`.** The widget code in `marketplace-feed.js:31` and
`featured-items.js:33` pushes `adv_*` / `adv_fi_*` events **only if
`window.dataLayer` already exists**:

```js
if (window.dataLayer && window.dataLayer.push) window.dataLayer.push(...)
```

On `bid.advantage.bid` there is no `dataLayer`, so the guard is false and nothing
is pushed. Impressions, item clicks, pagination, radius changes, map interactions
and search interactions are all **dead code today**. They reach neither
`dataLayer`, nor GTM, nor GA4.

**9. Is cross-domain configured correctly?** **Not applicable yet, and correctly
so.** `advantage.bid` and `bid.advantage.bid` share the registrable domain, so
cross-domain linking is not required — a shared first-party cookie is the right
design. That design is *already proven to work*: the `_ga` and `_ga_DBCGKMC9DQ`
cookies set on the BD site were readable on `bid.advantage.bid`. The cookie
architecture is sound; there is simply no tag on the second host to use it.

**10. Are referral exclusions correct?** **Unknown — cannot verify.** Requires
signed-in GA4 console access. For `G-JM5JYGNJ6H` it is moot until data flows.
Note that once `bid.advantage.bid` is tagged, an unwanted-referral entry for
`advantage.bid` becomes necessary, along with `hooks.stripe.com` (3-D Secure) —
the full list is in `AAC_ANALYTICS.md` §6.3.

**11. Any filters blocking traffic?** **No filter is responsible for the empty
reports.** A filter can only remove data that arrives, and no data arrives at
`G-JM5JYGNJ6H`. Property-side settings — internal traffic filters, developer
filters, hostname filters, reporting identity, data retention, stream URL,
Enhanced Measurement — **could not be verified**, because the GA console session
is signed out. Check them after data starts flowing, not before.

**12. Historical data explanation.** **Data was never collected for
`G-JM5JYGNJ6H`.** Not delayed, not filtered, not a reporting-identity artifact.

- The property/stream was created, producing a valid Measurement ID.
- No tag was ever deployed carrying that ID.
- The BD site was tagged separately — earlier and independently — with
  `G-DBCGKMC9DQ`.
- The Railway application was never tagged at all.

**Your historical marketing data is not lost — it is in the `G-DBCGKMC9DQ`
property.** The browser tab you had open pointed at property `a400985796p398986926`;
confirm whether that is the `G-JM5JYGNJ6H` property or the `G-DBCGKMC9DQ` one
before concluding anything about data loss. Marketplace history genuinely does
not exist anywhere, because that host has never been measured.

**13. Changes made.** **None.** See §3 for why, and §4 for exactly what to do.

**14. Remaining issues.** All of them — see §4.

**15. Final status: 🔴 NOT WORKING.**

---

## 3. Why I did not apply a fix

The instruction was to implement the smallest safe correction. In this case there
is no correction I can safely make:

| Fix | Why not |
|---|---|
| Change the measurement ID on the BD site | Requires Brilliant Directories admin access. I do not have it, and it is a production content change on your marketing site. |
| Tag `bid.advantage.bid` | That is Analytics **Phase 1**, which you have gated four times in this project, and whose prerequisites are still unmet — no GTM container exists, no debug property, no named publisher, the Vercel question is open, and the BD audit has not been run. |
| Change GA4 property settings | Requires signing into Google Analytics. The tab is signed out and I must not authenticate on your behalf. |

Applying a quick tag now would also create precisely the duplicate-tag situation
the architecture spends three sections preventing.

**One additional problem found while auditing, worth fixing at the same time:**
the BD site loads the gtag snippet **twice** — two `gtag/js` script tags and two
`gtag('config', …)` calls, on every page checked. Today this is benign (gtag
de-duplicates the loader and suppresses a second `config` for the same ID, and
only one `page_view` was observed per load), but it is a latent duplicate-pageview
fault that will bite the moment the two snippets carry different IDs or
parameters. Remove one while you are in there.

---

## 4. Exactly what to do, in order

### Step 0 — Decide what happens to `G-DBCGKMC9DQ` 🔒 *owner decision*

This is new information and it changes a decision you have already made.

`G-DBCGKMC9DQ` holds your **real marketing history**. `G-JM5JYGNJ6H` is empty.
Before repointing anything, open both properties and check:

- Which property is `a400985796p398986926` (the one your browser tab was opening)?
- How much history does `G-DBCGKMC9DQ` hold, and is it worth keeping as the
  primary?

Then choose:

| Option | Consequence |
|---|---|
| **A. Keep `G-JM5JYGNJ6H` as canonical** (matches AD-1/AD-2) | Clean start, one property, matches the approved architecture. Old history stays queryable in `G-DBCGKMC9DQ` but never merges — GA4 cannot merge properties. |
| **B. Adopt `G-DBCGKMC9DQ` as canonical instead** | Preserves history continuity. Requires updating `AAC_ANALYTICS.md` §2 and every downstream reference. Only worth it if that property holds substantial history *and* its configuration is sound. |

**Recommendation: A**, unless `G-DBCGKMC9DQ` turns out to hold a year or more of
meaningful traffic. Either way, decide before touching the tag — repointing
twice is worse than repointing once.

### Step 1 — Fix Brilliant Directories *(after Step 0)*

In `Settings → Design Settings → Custom CSS/HEAD → Additional HEAD Code`, plus
any theme widget or page-level code:

1. Find both gtag snippets.
2. **Delete one entirely.**
3. Update the remaining one to the chosen measurement ID.
4. Verify: view-source on three page types should show **exactly one**
   `gtag/js` loader and **exactly one** `gtag('config', …)`.

This is also the moment to complete the full BD analytics audit
(`AAC_ANALYTICS.md` §14) — the 16-point checklist that has been the standing
Phase 2 blocker. You now know at least one tag exists there; assume others may.

### Step 2 — Verify in Realtime

Sign in to GA4, open the chosen property → Reports → Realtime, then load
`https://www.advantage.bid/` in a normal window. You should appear within
seconds. If not, check property-side settings — internal traffic filter (your own
IP), data filters, and the stream's URL.

### Step 3 — Tag `bid.advantage.bid` — via Phase 1, not a shortcut

The marketplace still has no analytics, and that is the larger half of your
business. Run **Analytics Phase 1** as specified (`PHASE_1_PROMPT.md`) once its
prerequisites are met. Do not paste a snippet into 50 HTML files as a stopgap —
`analyticsTag.js` exists as a design precisely so that this is one file and one
environment variable, with an idempotency guard that makes the duplicate-snippet
problem you have on BD structurally impossible.

### Step 4 — Then, and only then, the custom events

Once `dataLayer` exists on `bid.advantage.bid`, the `adv_*` / `adv_fi_*` widget
pushes start firing on their own. Mapping them to GA4 events is Phase 3.

---

## 5. What could not be verified

| Item | Why |
|---|---|
| GA4 property settings — filters, retention, reporting identity, stream URL, Enhanced Measurement, internal/developer traffic | GA console signed out; I must not authenticate on your behalf |
| Whether `G-DBCGKMC9DQ`'s property still exists and is healthy | Same |
| How much history `G-DBCGKMC9DQ` holds | Same |
| Whether the 503s appear in Chrome's own DevTools | Needs your DevTools Network tab — see §2 item 6 |
| BD Additional HEAD Code / widgets / theme / plugins | Requires BD admin access (§14 audit) |

---

*Audit complete. No changes were made to either site, to the repository, or to
any GA4 property. Awaiting your decision on Step 0.*
