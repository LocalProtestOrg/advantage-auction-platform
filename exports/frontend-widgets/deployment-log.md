# Frontend Widget Deployment Log

Authoritative operational ledger for all Advantage widget deployments.
Every production deployment, staging deployment, and rollback must be logged here.

**Maintained by:** Frontend Operations  
**Reviewed by:** Engineering (on escalation or major version changes)  
**Source of truth for:** What is live, where, at what version, and who deployed it

---

## Governance Rules

### Frontend Operators Must

1. **Verify `version.json`** in the export package before deploying — confirm status is `stable`, not `planned`
2. **Read the full package `README.md`** before deploying — do not skip mobile, accessibility, or cache sections
3. **Complete the pre-deployment checklist** below before touching any production page
4. **Log every production deployment** in this file on the day it deploys
5. **Log every staging deployment** in this file before promoting to production
6. **Log every rollback** immediately — include reason and engineering notification status
7. **Never modify widget source code** — changes to `/public/widgets/` require engineering
8. **Never modify export package files** — changes to `/exports/frontend-widgets/` require engineering
9. **Never embed widgets that call non-public API endpoints** — only `/api/public/*`
10. **Never pass auth tokens or credentials** in widget embed code

### Engineering Guarantees

- Widget source code in `/public/widgets/` is the authoritative runtime
- API endpoint compatibility is maintained across MINOR and PATCH versions
- MAJOR version changes are communicated before release with a migration guide
- `version.json` status `stable` means the package has passed full Playwright validation
- Rollback to any prior stable version is safe at the BD page level (swap embed code)

### Version Discipline

- Only deploy packages with `"status": "stable"` in `version.json`
- Do not deploy `"planned"` or `"beta"` packages to production without engineering sign-off
- If `version.json` was updated since your last deployment, read the changelog before proceeding
- MAJOR version bumps require engineering review of the migration guide before deployment

---

## Pre-Deployment Checklist

Complete before every production deployment. Check off in your local notes — do not modify this master list.

```
PRE-DEPLOYMENT — [Widget] [Version] → [Target Page] — [Date]

Version verification:
  [ ] Opened version.json — confirmed status: "stable"
  [ ] Noted version number and release_date
  [ ] Read the changelog[] array — no breaking changes for this deployment

Documentation review:
  [ ] Read the full package README.md
  [ ] Confirmed data-api-base is set to https://auctions.advantage.bid
  [ ] Identified the correct embed variant (standalone vs. full platform layer)
  [ ] Confirmed data-* attributes match deployment intent

Rollback preparation:
  [ ] Saved the current HTML of the section being replaced (paste below in entry)
  [ ] Confirmed rollback target version (prior version or static HTML)
  [ ] Confirmed rollback procedure understood (README.md rollback section)

Staging validation:
  [ ] Deployed to staging page first
  [ ] Verified no JS errors in browser console (DevTools → Console)
  [ ] Verified widget renders within 3 seconds
  [ ] Verified layout at 1100px+ viewport (desktop)
  [ ] Verified layout at 375px viewport (mobile)
  [ ] Verified empty/error state renders correctly if no live data
  [ ] Confirmed analytics events firing (if applicable)
  [ ] Logged staging deployment in this file

CORS / domain:
  [ ] Confirmed BD domain is on the Advantage CORS allowlist
  [ ] (If new domain: submitted to engineering for allowlisting before deployment)
```

---

## Post-Deployment Validation Checklist

Complete within 30 minutes of every production deployment.

```
POST-DEPLOYMENT — [Widget] [Version] → [Target Page] — [Date]

  [ ] Hard refreshed the live page (Ctrl+Shift+R / Cmd+Shift+R)
  [ ] Widget renders correctly on desktop (1100px+)
  [ ] Widget renders correctly on mobile (375px)
  [ ] No JavaScript errors in browser console
  [ ] No layout shift or CSS collision with BD page styles
  [ ] Cards are clickable and link to correct lot/auction pages
  [ ] Analytics events verified (browser DevTools → Event Listener or GTM preview)
  [ ] CTA card visible and linked correctly (if configured)
  [ ] Deployment logged in this file with status: active
  [ ] Deployment-log.md committed to repository
```

---

## Rollback Checklist

Complete immediately when a rollback is needed. Do not delay logging.

```
ROLLBACK — [Widget] [Version] on [Target Page] — [Date]

Diagnosis:
  [ ] Identified rollback trigger (JS error / layout break / blank widget / wrong data)
  [ ] Checked browser console for specific error message
  [ ] Checked DevTools → Network for API response (status code, response body)
  [ ] Determined: config error OR widget bug OR CORS error OR data issue

Rollback execution:
  [ ] Located rollback snapshot HTML in this deployment log
  [ ] Removed widget <div> container from BD page
  [ ] Removed widget <script> tag(s) from BD page
  [ ] (If full platform layer: removed shared scripts — only if no other widgets remain)
  [ ] Pasted rollback snapshot HTML back into the BD page
  [ ] Hard refreshed — confirmed page looks correct
  [ ] Verified at desktop and mobile viewports

Post-rollback:
  [ ] Logged rollback entry in this file (status: rolled back)
  [ ] Notified engineering (if cause was widget bug, not config error)
  [ ] Submitted bug report to engineering with: page URL, embed code used, console error, screenshot
```

---

## Engineering Escalation Process

Escalate to engineering when:

| Situation | Escalation required |
|---|---|
| Widget shows JS error in console that is not a config issue | Yes — submit bug report |
| API endpoint returns error (non-200) | Yes — check `/api/public/*` health |
| BD domain blocked by CORS | Yes — request CORS allowlisting |
| Widget behavior does not match README documentation | Yes — documentation or widget bug |
| You need a new data-* attribute not currently supported | Yes — submit engineering feature request |
| A MAJOR version is published and migration is needed | Yes — review migration guide with engineering before deploying |
| Any doubt about whether a config change is safe | Yes — ask engineering before touching live pages |

**What does NOT require escalation:**
- Wrong `data-limit`, `data-lat`, `data-lng`, or other `data-*` attribute values — fix in embed code
- Empty widget (no featured lots available) — data issue, contact ops to feature lots
- Analytics not firing — listener attachment issue, fix on BD page
- CSS styling mismatch — use `widget.css` override layer, no engineering needed

**How to escalate:**
Document the issue clearly: page URL, embed code used, browser/version, console error text,
network response body. Add this to the engineering request or issue tracker.

---

## Operator Responsibilities

**Frontend Operator role:**
- Deploys widget packages into BD pages, landing pages, scenario pages, partner sites
- Maintains this deployment log — the ledger is only as good as the operator's discipline
- Owns BD page presentation — widget config, placement, copy around the widget
- Does not own widget logic, APIs, or infrastructure

**What the frontend operator does NOT control:**
- What data appears in the widget (controlled by which lots/auctions are "featured" in admin)
- Widget JS behavior (controlled by engineering via `/public/widgets/` source)
- API response shape or performance (controlled by engineering)
- CDN cache TTL for widget scripts (controlled by engineering infrastructure)

---

## Deployment Entry Template

Copy this template for each new entry. Paste at the top of the Deployment Index section.

```markdown
### DEP-[NNN] — [Widget Package] v[X.Y.Z] → [Target Page Name]

| Field | Value |
|---|---|
| Entry ID | DEP-[NNN] |
| Widget package | [package-name] |
| Widget version | [X.Y.Z] |
| Deployment target | [Page name / URL identifier] |
| Environment | staging / production |
| Deployment date | YYYY-MM-DD |
| Deployed by | [Operator name] |
| Status | active / staging / rolled back / retired |
| Embed variant | standalone / full platform layer |
| Rollback target | [DEP-NNN of prior entry] / pre-widget static HTML |
| Rollback snapshot | [paste prior section HTML here, or "no prior widget"] |
| API dependencies | GET /api/public/[endpoint] |
| Config keys used | [list of data-* attrs and/or AAPConfig keys set] |
| Notes | [anything notable about this deployment] |

**Validation completed:** [date and initials]
```

---

## Deployment Index

Summary table for quick status scanning. Add one row per deployment entry.
Full entries are in the **Deployment Entries** section below.

| ID | Date | Package | Version | Target | Env | Status | Deployed By |
|---|---|---|---|---|---|---|---|
| DEP-003 | 2026-05-11 | featured-near-you | 1.0.0 | AAP Homepage — Near You section | staging | staging | ops-example |
| DEP-002 | 2026-05-11 | featured-lots | 1.0.0 | AAP Homepage — Featured Lots section | production | active | ops-example |
| DEP-001 | 2026-05-11 | featured-lots | 1.0.0 | Staging validation page | staging | retired | ops-example |

*Most recent entries at top. Update Status column when a deployment is rolled back or retired.*

---

## Deployment Entries

Full entries, most recent first.

---

### DEP-003 — featured-near-you v1.0.0 → AAP Homepage (Near You section) [EXAMPLE — STAGING]

| Field | Value |
|---|---|
| Entry ID | DEP-003 |
| Widget package | featured-near-you |
| Widget version | 1.0.0 |
| Deployment target | Advantage.Bid homepage — "Auctions Near You" section |
| Environment | **staging** |
| Deployment date | 2026-05-11 |
| Deployed by | ops-example |
| Status | staging |
| Embed variant | full platform layer (shared with DEP-002 on same page) |
| Rollback target | Remove widget — section did not previously exist |
| Rollback snapshot | *(no prior HTML — new section)* |
| API dependencies | `GET /api/public/featured-auctions`, `GET /api/public/auctions/near` |
| Config keys used | `data-api-base`, `data-limit="6"`, `data-use-geolocation="true"` |
| Notes | Staged alongside DEP-002 — both widgets load shared platform layer once. Geolocation auto-detect enabled. Will promote to production after validation at 375px and 1100px. |

**Validation completed:** Pending

**Embed code deployed:**
```html
<div
  id="aap-featured-near-you"
  data-api-base="https://auctions.advantage.bid"
  data-limit="6"
  data-use-geolocation="true"
></div>
<script src="https://auctions.advantage.bid/widgets/featured-near-you.js" defer></script>
```

---

### DEP-002 — featured-lots v1.0.0 → AAP Homepage (Featured Lots section) [EXAMPLE — PRODUCTION]

| Field | Value |
|---|---|
| Entry ID | DEP-002 |
| Widget package | featured-lots |
| Widget version | 1.0.0 |
| Deployment target | Advantage.Bid homepage — "Featured Lots" primary section |
| Environment | **production** |
| Deployment date | 2026-05-11 |
| Deployed by | ops-example |
| Status | active |
| Embed variant | standalone |
| Rollback target | DEP-001 staging confirmed — no prior production widget; rollback to static HTML below |
| API dependencies | `GET /api/public/featured-lots` |
| Config keys used | `data-api-base`, `data-limit="6"`, `data-auction-state="published"`, `data-seller-cta-url` |
| Notes | Replaced a static "Featured Auctions" image block. Seller CTA configured to point to seller onboarding page. Validated at 375px and 1440px before deploying. |

**Validation completed:** 2026-05-11 — ops-example

**Rollback snapshot (prior static HTML):**
```html
<!-- Previous static featured section — restore if rollback needed -->
<section class="featured-static">
  <h2>Featured Auctions</h2>
  <p>Browse our latest estate and liquidation auctions.</p>
  <a href="/auctions" class="btn-primary">View All Auctions</a>
</section>
```

**Embed code deployed:**
```html
<div
  id="aap-featured-lots"
  data-api-base="https://auctions.advantage.bid"
  data-limit="6"
  data-auction-state="published"
  data-seller-cta-url="https://auctions.advantage.bid/seller-create.html"
  data-seller-cta-headline="Consigning an Estate?"
  data-seller-cta-label="Learn More"
></div>
<script src="https://auctions.advantage.bid/widgets/featured-lots.js" defer></script>
```

---

### DEP-001 — featured-lots v1.0.0 → Staging Validation Page [EXAMPLE — STAGING / RETIRED]

| Field | Value |
|---|---|
| Entry ID | DEP-001 |
| Widget package | featured-lots |
| Widget version | 1.0.0 |
| Deployment target | Internal staging page — `/staging/widget-test.html` |
| Environment | staging |
| Deployment date | 2026-05-11 |
| Deployed by | ops-example |
| Status | **retired** |
| Embed variant | standalone |
| Rollback target | N/A — staging page only |
| API dependencies | `GET /api/public/featured-lots` |
| Config keys used | `data-api-base`, `data-limit="4"` |
| Notes | Initial smoke test. Validated widget loads, renders 4 cards, no console errors. Promoted embed code to DEP-002. Staging page retired after production deployment. |

**Validation completed:** 2026-05-11 — ops-example

---

## Rollback Entry Template

```markdown
### ROLLBACK-[NNN] — Rolled back DEP-[NNN] on [Target Page]

| Field | Value |
|---|---|
| Rollback ID | ROLLBACK-[NNN] |
| Rolled back entry | DEP-[NNN] |
| Widget package | [package-name] |
| Widget version rolled back from | [X.Y.Z] |
| Rollback date | YYYY-MM-DD |
| Rolled back by | [Operator name] |
| Trigger | JS error / layout break / blank widget / wrong data / other |
| Root cause | config error / widget bug / CORS error / data issue / unknown |
| Engineering notified | yes / no |
| Restored to | DEP-[NNN] / pre-widget static HTML |
| Console error | [exact error text if applicable] |
| Network response | [API status code and brief response if applicable] |
| Notes | [anything else relevant] |
```

---

### ROLLBACK-001 — Rolled back DEP-002 on AAP Homepage [EXAMPLE — ROLLBACK]

| Field | Value |
|---|---|
| Rollback ID | ROLLBACK-001 |
| Rolled back entry | DEP-002 |
| Widget package | featured-lots |
| Widget version rolled back from | 1.0.0 |
| Rollback date | YYYY-MM-DD |
| Rolled back by | ops-example |
| Trigger | Widget shows blank — no cards rendered |
| Root cause | data issue — no lots currently marked as featured in admin |
| Engineering notified | no — data issue, not a widget bug |
| Restored to | pre-widget static HTML (from DEP-002 rollback snapshot) |
| Console error | none |
| Network response | `GET /api/public/featured-lots` returned `{ success: true, data: [] }` |
| Notes | Contacted Advantage ops team to feature at least 3 lots before re-deploying. Widget itself is functioning correctly. Re-deployment planned once featured lots are available. |

*Note: DEP-002 status updated from `active` to `rolled back` in the Deployment Index.*

---

## Log Maintenance Rules

1. **Never delete entries.** Mark them `rolled back` or `retired` in the Status column.
2. **Most recent entries go at the top** of both the Index table and the Entries section.
3. **IDs are sequential and never reused.** DEP-001, DEP-002 … ROLLBACK-001, ROLLBACK-002 …
4. **Commit this file to the repository** after every entry. The git history is the audit trail.
5. **Do not abbreviate entry fields** — a future operator or engineer must be able to reconstruct exactly what was deployed and why without asking anyone.
6. **The rollback snapshot is required** for every deployment that replaces existing page content. If there was no prior content, write "no prior widget" or "new section".

---

*Log initialized: 2026-05-11*  
*This file is operational governance infrastructure — not runtime code.*
