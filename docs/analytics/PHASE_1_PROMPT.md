# ⛔ PHASE 1 — DO NOT SEND UNTIL PHASE 0 IS VERIFIED

**Status: HELD.**

Do not paste this prompt into VS Code Claude until **all** of the following are true:

- [ ] `docs/analytics/VERIFICATION_RESULTS.md` exists and the owner has read it
- [ ] Every ⚠ item in §16 that affects Phases 1–4 is resolved to ✅ or ❌
- [ ] Discrepancies found in Phase 0 have been reflected back into `AAC_ANALYTICS.md` (the document is corrected **before** code is written)
- [ ] `docs/analytics/PHASE_0_OWNER_RUNBOOK.md` has been executed by the owner, and GA4 configuration is confirmed by screenshot
- [ ] The GTM container exists but is **NOT published**
- [ ] A **separate debug GA4 property** exists for staging — staging must never point at `G-JM5JYGNJ6H`
- [ ] §20 Q-D (is a Vercel deployment publicly live?) is answered
- [ ] §20 Q-H (named GTM publisher) is answered

If any box is unchecked, sending this prompt means building on an assumption. That is the specific failure this phased plan exists to prevent.

---

Everything between the rules below is the prompt. Paste it as-is once the gate is cleared.

---

You are working in the `advantage-auction-platform` repository. You are executing **Phase 1** of the AAC Analytics implementation: **container plumbing only, staging only.**

Read `docs/analytics/AAC_ANALYTICS.md` (authoritative architecture) and `docs/analytics/VERIFICATION_RESULTS.md` (Phase 0 findings) in full before writing any code. Where they disagree, the verification results win — and say so in your report.

## Scope

**In scope — four files, nothing else:**

| Action | File | Purpose |
|---|---|---|
| CREATE | `src/middleware/analyticsTag.js` | GTM bootstrap injection (§5.2) |
| CREATE | `public/widgets/shared/datalayer.js` | `AdvDL` helper (§11.3 enforcement) |
| MODIFY | `server.js` | **Exactly one** `app.use(...)` line |
| MODIFY | `.env.example` | Document the new variables |

**Explicitly out of scope for Phase 1:** any event instrumentation, any `public/*.html` page edit, any payment or bidding code, `privacy.html`, Brilliant Directories, production deployment, publishing the GTM container.

## Hard constraints

- **Do not modify:** `src/services/analyticsService.js`, `src/routes/analytics.js`, `db/migrations/044_create_analytics_events.sql`, `public/widgets/shared/analytics.js`, `src/middleware/shareMeta.js`. Read `shareMeta.js` as a **pattern reference only** — its own header describes it as the highest-risk file in this codebase, and a tagging bug must never be able to break share meta, canonical URLs, or JSON-LD.
- No new npm dependencies. Node built-ins and existing deps only.
- No changes to payment, bidding, or authentication behaviour.
- Staging only. Do not deploy to production.
- Respect `agents/orchestration/ownership-matrix.md`.

## 1. `src/middleware/analyticsTag.js`

Model it on `src/middleware/shareMeta.js`: templates read and cached at module load, head-only, fail-open.

**Requirements — every one is a stop-gate condition:**

1. **Mount order:** after the `shareMeta` mount, before `express.static`.
2. **Scope:** `GET` requests resolving to an `.html` document served from `public/`. Everything else falls straight through to `next()`.
3. **Exclusions, non-negotiable:**
   - Any path under `/widgets/` — these are iframed into Brilliant Directories pages and tagging them causes duplicate pageviews and self-referral sessions. This exclusion is architectural (AD-9), not a preference.
   - Every path in the §9.6 exclusion list.
   - Any non-HTML response.
4. **Idempotency (AD-19):** if the response body already contains the container ID, skip injection. Double injection must be *structurally impossible*, not merely unlikely.
5. **Injection point:** immediately after `<head>` opens, before other scripts.
6. **`dataLayer` initialisation:** the injected block must create `window.dataLayer = window.dataLayer || []` **before** the GTM container script, so any early push from page code is never lost.
7. **Async:** the container loads async, after any preconnect hints. Core Web Vitals feed SEO.
8. **Fail-open (AD-18):** wrap everything in `try/catch`; on any error call `next()` so the untagged page still serves. It must never throw and never 500.
9. **Kill switch:** `ANALYTICS_TAG_ENABLED` — when not exactly `'true'`, the middleware is a no-op. This must take effect **without a redeploy**, on the next request.
10. **Config:** container ID from `GTM_CONTAINER_ID`. **Never hard-code an ID.** If the variable is absent or malformed, no-op silently.
11. **Future pages (AD-20):** any new `public/*.html` must be tagged automatically with zero developer action. Do not enumerate page names.

Write a header comment in the same style as `shareMeta.js` stating the design rules, so the next person cannot violate them by accident.

## 2. `public/widgets/shared/datalayer.js`

A small `window.AdvDL` helper. It will be the **only** way application code pushes to `dataLayer` in later phases.

- `AdvDL.push(eventName, params)` — initialises `dataLayer` if absent, then pushes `{ event: eventName, ...params }`
- **Prohibited-key enforcement:** strip any key matching the §11.3 prohibited list before pushing. Reuse the same `PII_KEYS` discipline already implemented in `analyticsService.js` — read it and mirror its approach rather than inventing a second one.
- Drop values that are objects/arrays other than a whitelisted `items[]`; cap string lengths
- **Never throws. Never returns a promise. Never awaited.** Same contract as `AAPAnalytics`.
- Works, harmlessly, if GTM never loads
- No dependencies, no build step, plain ES5-compatible JS matching the style of the existing files in `public/widgets/shared/`

**Do not add any event instrumentation in this phase.** Ship the helper unused.

## 3. `server.js`

Add **exactly one line** mounting the middleware in the correct position. Change nothing else in this file.

## 4. `.env.example`

Document, with comments and safe placeholder values only — **never real values**:

- `ANALYTICS_TAG_ENABLED` (default `false`)
- `GTM_CONTAINER_ID`
- `GA4_MEASUREMENT_ID`
- `GA4_API_SECRET` (note: server-side only; never in client code, never in GTM, never committed)

## 5. Tests

Add unit tests consistent with the existing Jest setup, covering:

- Non-HTML and non-GET requests pass through untouched
- `/widgets/*` is never injected
- Injection is idempotent — a document already containing the container ID is returned unchanged
- `ANALYTICS_TAG_ENABLED=false` results in a byte-identical response
- A malformed template or a thrown error results in `next()` being called and the original file being served
- `dataLayer` is initialised before the container script in the injected output
- `AdvDL.push` strips every prohibited key and never throws on hostile input

## 6. Staging verification you must perform and report

Deploy to **staging only**, with `ANALYTICS_TAG_ENABLED=true` pointing at the **debug** GA4 property.

| # | Check | Pass condition |
|---|---|---|
| 1 | GA4 DebugView across **≥10 different page types**, including `/app.html` | Exactly **one** `page_view` per load |
| 2 | Any `/widgets/*` URL | **Zero** GA4 events |
| 3 | `ANALYTICS_TAG_ENABLED=false` | Every page renders identically and correctly |
| 4 | Forced double-injection attempt | One bootstrap present, not two |
| 5 | PageSpeed on `/lot.html` and `/index.html`, ≥3 runs each, before vs after | No Core Web Vitals regression |
| 6 | Existing `analytics_events` ingestion | Unchanged from the pre-change baseline |

Check 1 on `/app.html` matters specifically: that page mounts a JS member shell, and if it manipulates history while GA4 Enhanced Measurement "History changes" is on, in-shell navigation will double-count. Report exactly what you observe there.

## Reporting back

Report: the diff summary; test results; the six staging checks with actual observed numbers, not assertions; anything in the real code that contradicted the architecture document; and any risk you see in proceeding to Phase 2.

**Then stop.** Phase 2 puts tagging on production and on Brilliant Directories, and it is gated on the BD analytics audit (§14) and the privacy-policy update — neither of which is a code task.

---

*End of prompt.*
