# Analytics Integration Specification — post-recovery

**For:** VS Code Claude
**From:** Analytics Director (architecture verification only — no code written, committed, or deployed)
**Date:** 2026-08-02
**Scope:** re-applying `analyticsTag` to the recovered `server.js`. Page views only.

---

## 0. BLOCKER — resolve before applying anything

**The `server.js` in the working tree does not match the recovery described, and does
not match what is running in production.** This must be reconciled first; the
insertion points below cannot be applied safely until it is.

### 0.1 What the working-tree `server.js` actually contains

Read directly from `server.js` (35,859 bytes, mtime 2026-08-02 ~17:07 local). A
literal search for each named system returns **zero matches**:

| System the recovery is said to preserve | Present in working-tree `server.js`? |
|---|---|
| `htmlAuthGate` | ❌ not mounted, not referenced |
| `canonicalHost` | ❌ not mounted, not referenced |
| logout route | ❌ no `logout` reference |
| admin event-import routes (`/api/admin/event-imports`) | ❌ not mounted |
| `eventImportWorker` | ❌ not started |
| `sessionCookie` | ❌ not referenced |
| `analyticsTag` | ❌ not mounted (expected — intentionally unwired) |

The middleware **files** exist on disk and are committed
(`src/middleware/htmlAuthGate.js`, `canonicalHost.js`, `analyticsTag.js`). They are
simply not wired into this `server.js`.

### 0.2 What production is actually serving

Verified live against `https://bid.advantage.bid`, unauthenticated:

| Probe | Result | Implies |
|---|---|---|
| `/app.html`, `/my-bids.html`, `/invoices.html`, `/billing.html`, `/add-card.html`, `/seller-create.html`, `/lot-builder.html`, `/admin/imported-events.html`, `/admin/moderation.html`, `/org/event-new.html` | **all redirect** (`opaqueredirect`, no HTML body) | `htmlAuthGate` **is live** |
| `GET /api/admin/event-imports/queue` | **401**, not 404 | the admin event-import router **is mounted** |

**Production is running a build that contains `htmlAuthGate` and the event-import
routes. The working-tree `server.js` is not that build.**

### 0.3 What this means

One of these is true, and VS Code Claude must establish which before touching
`server.js`:

1. The rollback reverted further than intended and the working tree has genuinely
   lost `htmlAuthGate`, `canonicalHost`, logout, event-import mounting and the
   worker. **Deploying this file as-is would remove a live security control** —
   every private HTML page would be served by `express.static` with no server-side
   gate.
2. The recovery landed on a different branch/commit and the staged working copy is
   simply not it.

**Do not apply the analytics integration until the working-tree `server.js`
contains the same auth wiring production is running.** Analytics is not urgent;
an ungated `/admin/*` is.

---

## 1. Does the original design still hold?

**The `analyticsTag` module design remains valid and requires no changes to its
logic. The integration points must change — and not only because of the
recovery.**

The original two-line spec was written against a `server.js` that had **no
`htmlAuthGate`**. At that time, "mount `serve` immediately before
`express.static`" was safe by accident: nothing gated HTML, so nothing could be
bypassed. With `htmlAuthGate` in the architecture, mount position becomes
**security-critical**, not merely stylistic:

> If `analyticsTag.serve` is mounted **before** `htmlAuthGate`, it will read the
> private HTML file off disk and return it with `200` to an unauthenticated
> visitor — bypassing the auth gate entirely for every page in `MEMBER_PAGES`,
> `SELLER_PAGES`, `/admin*`, `/dashboard/*` and `/org/*`.

That is the single most important line in this document.

So: same module, same behaviour, **stricter ordering contract**.

---

## 2. Required `server.js` insertion points

Two mounts. Expressed relative to named anchors rather than line numbers, because
line numbers will move.

### Mount A — `analyticsTag.patch`

```js
app.use(require('./src/middleware/analyticsTag').patch);
```

**Position:** after `canonicalHost`, after `helmet`, after `widgetFraming`, after
the CORS block — and **immediately before** the `shareMeta` mount.

**Why there:** `shareMeta` calls `res.send()` for `/auction-view.html`,
`/lot.html` and `/event.html` and never falls through to `express.static`. Mount A
wraps `res.send` so those three pages — the most valuable pages on the site — are
tagged on the way out. It also covers the `/items` SSR page, which is registered
after `shareMeta` and likewise responds via `res.send`. `shareMeta` itself is not
modified.

**It must be after `canonicalHost`** so the `308` alias redirect is issued before
any analytics code runs.

### Mount B — `analyticsTag.serve`

```js
app.use(require('./src/middleware/analyticsTag').serve);
```

**Position: after `htmlAuthGate`, and immediately before
`app.use(express.static(...))`.** Nothing may sit between Mount B and
`express.static`.

**Why there:** `express.static` streams files and never calls `res.send()`, so
Mount A cannot reach the ~47 plain static pages. Mount B injects into the file
instead. Placing it **after** `htmlAuthGate` means an unauthenticated request has
already been redirected before Mount B can read anything from disk, and placing it
after the pre-static redirect routes (`/app`, `/account`, `/dashboard`,
`/seller-dashboard.html`, `/watchlist.html`, `/how-it-works.html`) means those
302/301s are issued untouched.

---

## 3. Required middleware order

```
 1. canonicalHost                     308 alias → canonical host
 2. helmet                            security headers
 3. widgetFraming                     frame-ancestors for /widgets/* only
 4. CORS block
 5. analyticsTag.patch          ←  MOUNT A
 6. shareMeta                         res.send() for auction/lot/event
 7. /sitemap.xml                      route
 8. /items                            SSR route (res.send)
 9. /how-it-works, /how-it-works.html route + 301
10. pre-static redirects              /app, /account, /dashboard, /seller-dashboard.html, /watchlist.html
11. htmlAuthGate                ←  MUST precede Mount B
12. analyticsTag.serve          ←  MOUNT B
13. express.static
14. logger
15. JSON body parser (Stripe webhook path excluded)
16. /api/* route mounts
17. logout route
18. 404 + error handlers
```

**Invariants that must hold, in priority order:**

1. `htmlAuthGate` **before** `analyticsTag.serve`. Non-negotiable — security.
2. `analyticsTag.serve` **immediately before** `express.static`, with nothing in
   between.
3. `analyticsTag.patch` **before** `shareMeta`, **after** `canonicalHost`.
4. Both mounts **before** the JSON body parser and **before** every `/api/*`
   mount — they never see API traffic at all.
5. Neither mount goes near the Stripe webhook path, uploads, or Socket.IO.

---

## 4. Interaction analysis

| Component | Interaction | Verdict |
|---|---|---|
| **`shareMeta`** | Mount A wraps `res.send`; `shareMeta` builds and sends exactly as today, tag appended into its `<head>`. Per-entity OG/Twitter/JSON-LD untouched. `shareMeta.js` is **not modified**. | ✅ safe |
| **`htmlAuthGate`** | Mount B sits after it. Unauthenticated → already redirected. Authorised → `next()` → Mount B serves the tagged file. `htmlAuthGate`'s `Cache-Control: no-store` header is set via `res.set` and survives, because Mount B only sets `Content-Type` and calls `send()`. | ✅ safe **only in this order** |
| **`express.static`** | Mount B may respond first for HTML. Consequence: ETag/Last-Modified/304 handling is bypassed for tagged HTML pages. Acceptable — these are small, no-cache documents. Every non-HTML asset falls straight through. | ✅ acceptable, noted |
| **`canonicalHost`** | Uses `res.redirect(308, …)`. Mount A is downstream, so the redirect is already sent. Even if reached, `res.redirect` emits a body with no `<head>`, and `inject()` returns `null` for any document lacking `<head>`. | ✅ safe |
| **CORS** | Mounts sit after the CORS block; neither reads nor writes CORS headers. | ✅ no interaction |
| **Authentication** | Neither mount reads cookies, tokens, sessions or roles. Neither can grant or deny access. Mount B's only reachability change is that it can serve a file — which is why it must sit behind the gate. | ✅ safe in the specified order |
| **Static assets (JS/CSS/images)** | `htmlFileFor()` returns non-null only for `/` and `*.html`. Everything else falls through untouched. | ✅ no interaction |
| **API / JSON** | Both mounts are registered before every `/api/*` mount, so API requests pass through Mount A (which only wraps `res.send`) and Mount B (which returns `next()` for non-`.html` paths). Mount A's guard requires `Content-Type: …html` **or** a body starting `<!doctype`/`<html>`; a JSON body matches neither. | ✅ cannot alter JSON |
| **Uploads** | `POST`/`PUT` only. Both mounts bail on any method other than `GET`/`HEAD`. | ✅ no interaction |
| **Stripe** | Webhook is `POST` with a raw body, mounted after both. Method guard alone excludes it. | ✅ no interaction |
| **Logout** | Whatever method/redirect logout uses, `inject()` requires a `<head>` and Mount B requires a `.html` path. A logout redirect has neither. | ✅ no interaction |
| **Redirects generally** | `res.redirect` sets `Content-Type: text/html` and a `<p>Found. Redirecting…</p>` body. Mount A's `looksHtml` test passes, `inject()` then returns `null` (no `<head>`), and the original body is sent unchanged. Safe today — see §5 for a recommended explicit guard. | ✅ safe |

---

## 5. Files that must change

| File | Change | Notes |
|---|---|---|
| `server.js` | **+2 lines** (Mount A, Mount B) per §2 | Only after §0 is resolved |
| `src/middleware/analyticsTag.js` | **2 small hardening changes** — see below | Both optional for correctness, recommended for robustness |
| `.env.example` | Already carries the two variables | No change if already committed |
| `src/middleware/shareMeta.js` | **None** | Do not touch |
| `src/middleware/htmlAuthGate.js` | **None** | Do not touch |
| `src/services/analyticsService.js`, `src/routes/analytics.js`, `public/widgets/shared/analytics.js`, migration 044 | **None** | First-party pipeline stays untouched |

### 5.1 Recommended hardening to `analyticsTag.js`

Two changes, both small, both defensive. Neither alters the design.

**(a) Skip non-200 responses in `patch`.** Currently redirects are safe only
because `inject()` finds no `<head>`. With `htmlAuthGate` now issuing a redirect on
every unauthenticated private-page request, make that explicit rather than
incidental: in the wrapped `res.send`, return the original body immediately unless
`res.statusCode === 200`.

**(b) Handle the extensionless `/how-it-works` canonical.** `server.js` serves it
via `res.sendFile`, which is neither `res.send` (so Mount A misses it) nor reached
by Mount B (the route responds first). Result: **`/how-it-works` would be the one
public marketing page with no tag.** Cheapest correct fix is to register Mount A
before that route *and* have the route use `res.send` — but that changes
`server.js` behaviour. Preferred instead: leave `server.js` alone and accept the
gap for now, or extend `htmlFileFor()` to map `/how-it-works` → `how-it-works.html`
and mount B before the route. **Flag this to the Product Owner rather than deciding
it unilaterally** — it is a real coverage gap, not a bug.

---

## 6. Tests to re-run

| Test | Expectation |
|---|---|
| `tests/analyticsTag.test.js` (committed, 18 assertions) | All pass |
| Full `npm test` (93 suites / 1,184 tests) | No regressions |
| `npm run test:governance` (Playwright governance regression) | No regressions |

**New tests that should be added before this ships** — the recovery created a risk
the existing suite does not cover:

1. **Auth-gate ordering test.** With `ANALYTICS_TAG_ENABLED=true` and **no**
   session cookie, `GET /app.html`, `/invoices.html`, `/seller-create.html` and
   `/admin/imported-events.html` must each return a **302 to `/login.html`** and a
   body containing **no** HTML page content and **no** `gtag/js`. This is the
   regression test for the one failure mode that matters.
2. **Authorised path test.** With a valid session, the same pages return 200 **and**
   contain exactly one `gtag/js` loader.
3. **Redirect integrity test.** `GET /how-it-works.html` still returns 301 to
   `/how-it-works`; `GET /watchlist.html` still 302s to `/app.html#watchlist`.
4. **API immunity test.** `GET /api/public/marketplace` returns unmodified JSON
   with `ANALYTICS_TAG_ENABLED=true`.

---

## 7. Environment variables

| Variable | Staging | Production (initial) | Notes |
|---|---|---|---|
| `ANALYTICS_TAG_ENABLED` | `true` | **`false`** | Ship disabled. Flip to `true` only after staging verification. Takes effect on the next request — no redeploy. |
| `GA4_MEASUREMENT_ID` | debug property ID | `G-JM5JYGNJ6H` | Staging **must not** use `G-JM5JYGNJ6H`. A malformed value is treated as absent, so a typo degrades to "no analytics", never a broken page. |

No other variables. No GTM container ID — the marketing site uses direct
`gtag.js` and the marketplace matches it (one implementation).

---

## 8. Production verification

Run in this order. Stop at the first failure.

**Before enabling (`ANALYTICS_TAG_ENABLED=false`, deployed):**

1. `/app.html`, `/invoices.html`, `/admin/imported-events.html` unauthenticated → still redirect. **Auth unchanged.**
2. `GET /api/admin/event-imports/queue` → 401, not 404. **Event-import routes still mounted.**
3. `/how-it-works.html` → 301; `/watchlist.html` → 302. **Redirects intact.**
4. Homepage, `/lot.html`, `/auction-view.html`, `/event.html` → 200 with correct per-entity OG meta. **`shareMeta` intact.**
5. `GET /api/public/marketplace` → valid JSON. **APIs untouched.**
6. Stripe webhook health via `GET /api/health` → unchanged.

**After enabling (`ANALYTICS_TAG_ENABLED=true`):**

7. Repeat 1–6. Every result must be **identical**.
8. Exactly **one** `gtag/js` loader and **one** `gtag('config', 'G-JM5JYGNJ6H')` on: `/`, `/search.html`, `/events.html`, `/event.html`, `/auction-view.html`, `/lot.html`, `/login.html`, `/items`.
9. **Zero** GA output on any `/widgets/*` URL.
10. **Zero** GA output on any `/admin/*` or `/org/*` URL.
11. GA4 Realtime shows `page_view` from `bid.advantage.bid`.
12. Click `www.advantage.bid` → `bid.advantage.bid`: **one session, one user, one `session_start`**, zero self-referrals.
13. Core Web Vitals on `/lot.html` and `/` — no regression versus pre-deploy.

**Rollback:** set `ANALYTICS_TAG_ENABLED=false`. Effective on the next request, no
deploy, no revert. If that does not fully restore behaviour, remove the two
`server.js` lines — nothing else depends on them.

---

## 9. Statement of design validity

The original analytics design remains valid. Only the integration points must be
re-applied to the recovered `server.js` — **with one substantive change**: because
`htmlAuthGate` now exists, `analyticsTag.serve` must be mounted **after** it, not
merely immediately before `express.static`. In the earlier `server.js` those were
the same position; they are no longer. Mounting it in the old position would
bypass the auth gate for every private HTML page.

Everything else — the module's logic, its fail-open behaviour, its idempotency
guard, its exclusion list, the kill switch, and the two-mount `patch`/`serve`
split — is unchanged and correct.

---

*No code written, committed, or deployed. Awaiting Product Owner direction.*
