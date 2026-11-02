# Site Watchdog Runbook

Owner assignment 2026-10-30, after the seller agreement page showed raw JavaScript instead of the agreement. The watchdog finds that kind of failure automatically: broken pages, broken scripts, script text visible on a page, missing content, failed requests and journeys that stop working. Migration 210.

It extends the existing architecture:
- a forked worker like the other workers;
- the platform email service for alerts;
- the existing admin navigation;
- the Marketing Director daily briefing;
- the isolated full-stack test environment (`tests/fullstack`);
- the shared browser inspector `src/services/watchdog/pageHealth.js`.

## Three layers

| Layer | Where it runs | What it may do | Code |
|---|---|---|---|
| **Server checks** | Inside production, in the watchdog worker | Read only: GET requests to the public site, and reading page files on disk | `src/services/watchdog/httpChecks.js`, `servedHtml.js`, `htmlAnalysis.js` |
| **Browser checks** | GitHub Actions, hourly, against production | Read only: open pages in Chromium, never submit a form. Third-party analytics and ad requests are blocked, so checks are not counted as visits. | `scripts/watchdog-browser.js` |
| **Isolated journeys** | GitHub Actions every 6 hours, and in `npm test` | Anything (register, sign in, bid, watch, sign agreements, import), but only in the isolated test environment: an in-memory database, no payment processor, no email provider | `tests/browser/*.browser.test.js` |

Production is never used for a state-changing check: no real transactions, legal signatures, bids, charges, published test inventory or emails to customers.

## What is checked

**Every page as served (critical, every 15 minutes).**
- Each HTML page under `public/` is passed through the server's real tag injection: the analytics tag and the help-button loader, via `src/lib/htmlInjection.js`.
- Every inline script must still be valid JavaScript, and every injected tag must be a real script element.
- This includes signed-in pages no outside monitor can open: the seller agreement, dashboards, admin.
- It is exactly the 2026-10-30 defect; the test suite proves this check catches the pre-fix page.

**Server checks** (GET only):

| Risk | Schedule | Checks |
|---|---|---|
| critical | 15 min | served pages; `/api/health` (status, database); homepage (content, SEO tags); sign-in/registration page (form fields present); marketplace feed API; signed-in pages redirect to sign-in when signed out |
| high | 60 min | password reset pages; search; marketplace items; Professional Seller onboarding page; an auction, a lot and an event page found through the sitemap (SEO; structured data on events); product page, storefront page and embedded storefront widget plus its data feed (skipped until something is published); marketplace counts; auctions and categories APIs; sitemap |
| normal | 6 h | information pages (how it works, FAQs, terms, privacy, Professional Sellers, events, ending soon) |

Each page is checked for:
- the HTTP status and the content type;
- an html/body structure and a closing tag;
- inline script syntax;
- script text visible in the page text;
- unfilled `{{placeholders}}`;
- expected content;
- a title;
- SEO tags: description, canonical and og:title, as warnings;
- JSON-LD validity, and `@type` on each entry;
- slowness over 8 s, as a warning.

**Browser checks** (desktop and phone), through `pageHealth.inspect`:
- **Pages:** homepage and navigation, sign in and registration (fields visible, nothing submitted), password reset request page, search with a filter, marketplace items, an auction, a lot and an event, and once published a product page, a storefront and its embedded widget.
- **Problems detected:** uncaught script errors, console errors, failed same-site requests, raw script text, missing content, placeholders, sideways scrolling on phones, SEO tags and structured data.

**Isolated journeys:**
- **This watchdog's own** (`site-journeys.browser.test.js`):
  - homepage and navigation, desktop and phone;
  - search and filtering;
  - registration through the form, sign in, buyer account access, and the password reset request;
  - auction and lot pages, then an eligible buyer bids and watches a lot (a seller cannot bid on their own auction);
  - product page, storefront page and embedded widget for a published item (both distribution channels);
  - the seller dashboard and inventory workspace;
  - administration: the site watchdog dashboard and run now, and the users page.
- **Seller agreement journey:** `seller-agreement.browser.test.js`.
- **Importer, category, photo and Post to the Market journeys:** added with those features.

## Severity, de-duplication and recovery
- **Severity:**
  - A critical problem takes the check's risk: **critical**, **high** or **normal**.
  - Lesser problems are **warnings**.
  - Only **critical** and **high** findings send email. Normal findings and warnings appear on the dashboard only.
- **One finding per problem.** The key is the check, the problem code, and the page, URL or viewport affected, so a lasting problem is one finding whose count grows.
- **Recovery is automatic:**
  - A finding resolves when its check passes again.
  - If it comes back, it re-opens and alerts again.
  - A check with nothing to check yet (for example, no published storefront) changes nothing.
- **Alerts:**
  - One email to info@advantage.bid lists the new and re-opened critical and high findings, each with what happened and how to reproduce it.
  - It is never repeated for the same finding.
  - If email is not configured, the alert stays pending and is retried.
  - With alerts switched off, findings are still recorded, and nothing is mailed later.

## Where to see it
- **Admin › Operations › Site Watchdog** (`/admin/site-watchdog.html`):
  - overall status and switches;
  - open problems with severity, feature, evidence, reproduction and status (open, or came back);
  - problems resolved recently;
  - every check with its schedule and last result;
  - recent runs;
  - **Run checks now** (read-only server checks).
- **API:** `GET /api/admin/watchdog` and `POST /api/admin/watchdog/run`, admin only.
- **Marketing Director:** `GET /api/admin/director/daily` carries `site_health`, a one-line status with a link to the dashboard. The details stay on the dashboard, with no second report.
- **GitHub Actions:** the "Site Watchdog" workflow shows red when a critical problem is found, and keeps the results as an artifact.

## Enabling it (owner steps)
1. **Migration:** run `railway run node scripts/prod-migrate-210.js --check`, then `--dry-run`, then apply. It adds three tables and changes nothing else. Rollback drops them; the statements are in the migration header.
2. **Railway variables:**
   - `WATCHDOG_ENABLED=true` starts the scheduled server checks (the worker is idle without it).
   - `WATCHDOG_ALERTS_ENABLED=true` turns on email alerts. Enable it after a day of watching the dashboard.
   - `WATCHDOG_INGEST_KEY=<random, at least 32 characters>` lets the browser job post results. Without it the ingest refuses everything (503).
3. **GitHub:** add the repository secret `WATCHDOG_INGEST_KEY` with the same value. Without it the workflow still runs and shows red or green, but posts nothing.
4. **GitHub schedule:** the scheduled runs (hourly production page checks, 6-hourly isolated journeys) are off until the repository variable `WATCHDOG_SCHEDULE_ENABLED=true` is set (owner approval). Manual runs (Actions, Site Watchdog, Run workflow) work without it.

## Adding a check
- **Server check:** add a `pageCheck(...)` or `apiCheck(...)` to `CHECKS` in `src/services/watchdog/httpChecks.js`, with an id, a feature name and a risk tier. It must use only `ctx.get` (GET). A test enforces this.
- **Browser check:** add a target to `targets()` in `scripts/watchdog-browser.js`, and its id and tier to `BROWSER_CHECKS` in `src/services/watchdog/registry.js`. The ingest refuses unknown ids.
- **State-changing journey:** add a `*.browser.test.js` under `tests/browser/` using `tests/fullstack/stack.js`. Never point it at production.
