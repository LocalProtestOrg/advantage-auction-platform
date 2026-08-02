# PHASE 0 — Copy-and-paste prompt for VS Code Claude

**Status: READY TO SEND — after Commit 11 (Admin Review Queue UI) lands.**
**Scope: READ-ONLY. This phase produces documents, not code.**
**Baseline: Event Import Framework Commits 7, 8, 10, 12, 13 landed; Commit 11 in progress.**

Run this *after* Commit 11 merges. Commit 11 may add a new admin page, and
because tagging is automatic for anything under `public/` (AD-20), a new admin
page created after this verification pass would be auto-tagged by default —
exactly what AD-26 and §9.5 forbid. Running Phase 0 afterwards inventories and
excludes it in the same pass.

Everything between the rules below is the prompt. Paste it as-is.

---

You are working in the `advantage-auction-platform` repository (Railway, Express 5 + PostgreSQL). You are executing **Phase 0** of the AAC Analytics implementation.

**Read `docs/analytics/AAC_ANALYTICS.md` in full before doing anything else.** It is the authoritative architecture document. Do not re-derive its decisions and do not deviate from them; if you believe something in it is wrong, report the discrepancy rather than silently correcting it.

## Hard constraints for this phase

- **This is a READ-ONLY verification phase.** Do not modify, create, refactor, or delete any application code, configuration, migration, or environment variable.
- The only files you may create are the two output documents named below.
- Do not install packages. Do not run migrations. Do not deploy.
- Do not create a GA4 property, data stream, or GTM container — those are owner-executed console tasks, not code tasks.
- Do not touch: `src/services/analyticsService.js`, `src/routes/analytics.js`, `db/migrations/044_create_analytics_events.sql`, `public/widgets/shared/analytics.js`, `src/middleware/shareMeta.js`. Read them; do not edit them.
- Respect `agents/orchestration/ownership-matrix.md`. If a file you need to inspect is ownership-restricted, note it and continue — reading is permitted, editing is not.

## Why this phase exists

The v2.0 architecture document was written from an incomplete copy of this repository. At v2.1 the full tree was re-read from Desktop and many items were resolved — see §3.4 and §23.5, which list what is already ✅ and no longer needs establishing (`widgetFraming.js` CSP, the watchlist add endpoint, the Stripe webhook and its idempotency, auth error shapes, and confirmation that the first-party pipeline is untouched).

**What remains is still substantial**, and every claim in the document derived from a frontend `fetch()` call rather than from server source is still marked ⚠. Your job is to resolve every remaining ⚠ and ❌ against the working tree so that no implementation is built on an assumption.

**Do not treat any unverified endpoint as confirmed. Do not re-assert a v2.1 ✅ without checking it — if the code has moved since, say so.**

## Task 1 — Repository verification

Work through **§16 of `AAC_ANALYTICS.md`** — all 34 numbered items across §16.1 (route and contract verification), §16.2 (client-side inventory), and §16.3 (domain and configuration verification).

For each item record:

- Whether the file/target exists in the full tree
- For endpoints: **method, full path, auth requirement, success status code, response shape, and every error code/reason string** the client can receive
- For client-side inventory items: every call site with `file:line`, the event name, and the payload shape
- The resulting marker: ✅ verified · ⚠ still unverified (say why) · ❌ genuinely absent · plus 🔒 / 🧪 where §16 indicates

Pay particular attention to these, because implementation decisions depend on them:

1. **`src/routes/payments.js`** — which Stripe event types the webhook handles; exactly where a `stripe_webhook_events` row transitions to `processed`; and the precise insertion point for a Measurement Protocol send that sits **after** all business logic and **inside** the existing idempotency guard. Also record every Stripe `return_url` / `success_url`.
2. **`src/routes/lots.js`** — the bid endpoint's request and response contract, and every failure code, so bid-rejection reason *classes* can be mapped without ever echoing a submitted value.
3. **`src/routes/watchlist.js`** — the **add** endpoint. Only remove/list are visible from the shipped HTML.
4. **`src/routes/auth.js`** and **`src/routes/authBridge.js`** — auth error response shapes, and every redirect target in the identity bridge, including whether query strings survive and whether any path can land on `advantageauction.bid`.
5. **`src/middleware/widgetFraming.js`** — the exact CSP directives, specifically whether `script-src` is set.
6. **`public/widgets/shared/member-shell.js`** — whether it manipulates browser history or pushes virtual page views. This determines whether GA4 Enhanced Measurement would double-count on `/app.html`.
7. **`public/widgets/shared/auth-refresh.js`** — identify the single best insertion point where an authenticated bootstrap could later supply a pseudonymous analytics ID and an internal-traffic role flag. **Identify only. Do not implement.**

Also produce three complete inventories via full-tree grep:

- Every existing `window.dataLayer` push (event name, payload, `file:line`)
- Every `AAPAnalytics.track` / `.trackBatch` call (event type, metadata, context, `file:line`)
- Every `CustomEvent` / `dispatchEvent` and every `postMessage` send and listener, including origin validation

Cross-check all three against **§10.3** of the architecture document. **Any event found in code that is not in the §10 dictionary is a finding — list it explicitly.**

## Task 1b — Event Import Framework verification (new at v2.1)

Items 35–41 of §22.5. These did not exist when the architecture was first written.

1. **`src/routes/adminEventImports.js`** — confirm whether it is mounted in `server.js`. At the v2.1 baseline it was **not** present in any `app.use(...)` line, while every other admin router was. Report whether Commit 11 added the mount, or whether it is genuinely missing. Do not fix it — report it.
2. **Commit 11 Admin Review Queue UI** — identify exactly which files it added. Determine whether it is (a) a new standalone `public/*.html` page, (b) a view inside the member shell, or (c) something else. **If it is a new page under `public/`, it must be added to the §9.6 exclusion list**, because AD-20 makes tagging automatic and AD-26 requires admin surfaces stay out of marketing GA4. State the exact path.
3. **`src/services/eventImport/reviewQueue.js`** — record the status transitions and the timestamp columns that make `time_in_queue` and `expired_in_queue` computable (§22.4). If an imported event's approval timestamp is not recorded, say so — that metric would be unbuildable.
4. **`import_runs`, `import_run_items`, `event_sources`, `import_sources`** — full column inventory, so the §22.4 operational queries can be written against real columns rather than assumed ones.
5. **Commit 13 SEO / expiry behaviour** — this is the important one. The import plan §5.2 specifies, for `source='imported'` events past `end_at`: a minimal `{ expired: true }` payload, an expired-stub page, `<meta name="robots" content="noindex,follow">`, `getEventMeta()` returning `null`, sitemap removal, and `410 Gone` when `event_sources.sync_status = 'removed'`. At the v2.1 baseline **all four targeted surfaces still read as pre-change** — `publicEvents.js` `/events/:slug`, `shareMetaService.getEventMeta()`, the `shareMeta` event body injection, and `getSitemapEntries().events` (whose comment still says ended events are "safe to list"). Determine whether this landed, landed elsewhere, or is pending. Report factually; do not implement it.
6. **`public/event.html`** — confirm `attribution_source` and `attribution_url` are reliably available client-side, and identify the exact element that would carry an `attribution_source_clicked` handler in a later phase. Identify only.
7. **`/auth/bd/return`** (`src/routes/authBridge.js`) — confirm this route is **not** reachable by a middleware scoped to static HTML under `public/`. This page returns a signed JWT in an inline script; a tag-manager-loaded third-party script must never share that document. Note it as a required explicit exclusion regardless of what the routing currently makes possible.

## Task 2 — Domain reference audit

Full-tree grep the **complete** repository for each of these and report every occurrence with `file:line` and the exact string:

- `advantageauction.bid`
- `auctions.advantage.bid`
- `advantage.bid` (group results by hostname: apex, `www.`, `bid.`). **The owner has now fixed the canonical hosts: marketing = `https://www.advantage.bid`, application = `https://bid.advantage.bid` (AD-21 / AD-22).** Flag every apex-form reference that will need to become `www` — including `EVENT_ORIGINS` in `publicEvents.js`, the CORS allow-list, and the `frame-ancestors` list in `widgetFraming.js`.
- `vercel`
- `up.railway.app`

For every `res.redirect` and every static redirect rule in the repo, record whether the query string is preserved. This maps directly to §8.4 and §15.

## Task 3 — Outputs

Create exactly two files. Create nothing else.

**1. `docs/analytics/VERIFICATION_RESULTS.md`**

- The completed §16 table, every row marked
- The exact contract for every endpoint that §10.4 marks ⚠
- The three code inventories from Task 1
- The domain audit from Task 2
- **A "Discrepancies" section**: everything in `AAC_ANALYTICS.md` that the real repository contradicts. Be blunt. A wrong architecture document is far more expensive than a corrected one.
- **A "Not in dictionary" section**: every analytics event present in code but absent from §10

**2. `docs/analytics/PHASE_0_OWNER_RUNBOOK.md`**

A step-by-step console runbook the **owner** executes by hand in the GA4 and Google Search Console UIs. Derive it from §17.2 Phase 0 and §18.10. It must include, with exact menu paths and exact values:

- Data retention → 14 months
- All 20 event-scoped, 6 user-scoped, and 4 item-scoped custom dimensions and 7 custom metrics from §18.10, each with scope and parameter name — flagging clearly that these **do not backfill** and must exist before any event fires
- Unwanted referrals (§6.3), exact entries and match types
- Session timeout → 1 hour
- BigQuery export
- Search Console **domain property** verification and GA4 link
- The AI Search custom channel group with the source list from §8.2, and a note that the AI rule must sit **above** Organic Search and Referral in rule order
- Google Signals **off**; reporting identity **Observed**; data-sharing settings per §11.4
- Internal traffic filter created in **Testing** mode
- GTM container **created but NOT published**, GA4 Configuration tag only, all built-in Click/Form/Scroll/Element-Visibility triggers disabled, publish rights restricted to one named person

Each step needs a checkbox and a "verified by / date" field. Write it so a non-developer can follow it without reading the architecture document.

## Reporting back

Finish with a short summary containing:

1. Count of §16 items resolved ✅ / still ⚠ / confirmed ❌
2. The three most consequential discrepancies found
3. Any place where the real code makes a planned event impossible, unsafe, or already-existing
4. Anything you found that touches payments, bidding, or authentication that the architecture document did not anticipate
5. **Answers to Q-N** (is `adminEventImports.js` mounted?) and **Q-O** (did Commit 13's expiry/SEO behaviour land?) — both are open owner items in §20
6. The exact path of any new admin page from Commit 11 that must be added to the §9.6 exclusion list

**Then stop.** Do not begin Phase 1. Phase 1 requires the owner to read your verification results and clear the stop gate first.

---

*End of prompt.*
