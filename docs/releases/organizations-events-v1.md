# Organizations & Events — v1 Production Release Notes

**Status:** LIVE in production · **Released:** 2026-07-04 (platform) / 2026-07-05 (routing) · **Migration level:** 076
**Production commit:** `f0a7648` · **Platform merge:** `81cc4df` (PR #11) · **Routing merge:** `f0a7648` (PR #12)

---

## Executive summary
Organizations & Events adds a foundational business layer to the Advantage platform: `Users → Organizations → Events`. Organizations are first-class entities that own events (and, in future, directory listings, advertising, memberships). Events flow through a 5-state moderation lifecycle and surface on a public marketplace page and a public API consumed by embeddable widgets on Brilliant Directories (BD). The release is additive and presentation-safe — no changes to auctions, bidding, payments/Stripe, seller settlement, or tax logic. Validated end-to-end (Tier 1 services 9/9, Tier 2 staging 31/31) and audited in production (14/14).

## Business purpose
Extend the platform beyond auctions into a **local discovery marketplace**: let community organizations publish local estate-sale / auction **events** that Advantage moderates and displays, funneling discovery traffic from BD city pages into the Railway platform. Railway owns the data and workflow; BD is a marketing/presentation surface. This creates CRM value, a content moat, and a path to memberships/advertising — without depending on BD for core operations.

## Architecture overview
- **Users → Organizations → Events** (with `organization_members`, `organization_plans`, `event_markets`, `event_categories`, `event_images`).
- Server-side business rules in `eventsService` / `organizationsService`; routes return `{success, code, message}` via `apiError`.
- Three route surfaces: `/api/org` (organizer portal, native auth), `/api/admin/events` (moderation, admin-only), `/api/public` events feed (no auth, allowlisted, restricted CORS).
- Static portal/admin/public pages under `public/`; embeddable widgets under `public/widgets/`.

### Railway as the system of record
Railway/PostgreSQL is the **single source of truth** for organizations, events, members, plans, images, moderation state, and audit history. All identity, authorization, business rules, and state transitions are enforced server-side on Railway. The platform is fully operational without BD.

### Brilliant Directories as the presentation layer
BD is a **display/marketing adapter only**. It renders published events via the Railway widget/iframe and links organizers back to Railway to create events. BD never owns event data or workflow. Automated BD access is currently **read-only REST API** (`X-Api-Key`); there is no BD MCP and no page-edit automation — BD city-page embeds are applied manually.

## Organizations foundation
- One organization per user, **auto-onboarded** on first event (or profile POST); creator becomes `owner` in `organization_members`.
- **Plan tiers** (`organization_plans`, seeded free / standard / premium) govern active-event and image limits and feature flags.
- **Verification status** (`unverified` / `community` / `verified`) drives the organizer badge; verification workflow is schema-only (deferred).
- Ownership enforced in the service layer (`assertOwner`); responses allowlisted.

## Events platform
- **5-state moderation lifecycle:** `draft → submitted → published | rejected → archived`, with a single **Approve & Publish** admin action, plus reject / return-to-draft (reason required) / archive.
- **Plan-limit enforcement (server-side):** active-event cap enforced at **submit**; image cap enforced at **attach** (free = 3 active / 10 images) → `422 ACTIVE_EVENT_LIMIT` / `422 IMAGE_LIMIT`.
- Owner editing restricted to draft/rejected; every transition writes an `audit_log` row.
- **Organizer badge** derived: Imported Listing / Advantage / Verified Organizer / Community Organizer.

## Public APIs
- `GET /api/public/events?market=&category=&limit=&offset=` — published + not-ended only; market validated (`400` on unknown); allowlisted.
- `GET /api/public/events/:slug` — single published event + images.
- `GET /api/public/event-markets` (houston, nyc_tristate) · `GET /api/public/event-categories` (8).
- **Restricted CORS** override (`EVENTS_ALLOWED_ORIGINS`, default includes `https://www.advantage.bid` + `https://advantage.bid` + localhost); disallowed origins fall back to the primary and are not reflected. `/api/public/auctions` remains `*`.

## Widget architecture
- **`/widgets/events.js`** — CSS-isolated **Shadow-DOM** widget; reads `data-advantage-events data-market data-limit data-category`; derives its base URL from its own script origin; fetches `/api/public/events`; renders cards linking to `/event.html?slug=`.
- **`/widgets/events.html`** — iframe fallback (`?market=`), `target="_top"` links, posts height to parent.
- **`/widgets/events-embed.html`** — copy-paste reference (JS widget / iframe / Create-Event deep-link) with live preview.
- BD CSP is permissive (`script-src https:`, `connect-src *`, `frame-src *`) → both embed methods are compatible.

## Migration 076
`db/migrations/076_organizations_and_events.sql` — **7 additive tables**: `organization_plans`, `organizations`, `organization_members`, `event_markets`, `event_categories`, `events`, `event_images`. Seeds: plans 3, markets 2 (houston, nyc_tristate), categories 8. Idempotent via `schema_migrations` ledger. Guarded runners: `scripts/stg-migrate-076.js`, `scripts/prod-migrate-076.js`.

## Tier 1 validation (9/9)
Isolated Neon scratch branch (076 applied), Jest integration (`tests/events/events-integration.test.js`): migration seeds, onboarding + one-org-per-user, event create/slug/validation, attach + image limit, submit + active-event limit, admin moderation transitions/guards/reasons, ownership guards, badge derivation. **9/9 passing.** (Found + fixed: `adminReject`/`adminReturnToDraft` made `async` so their reason guards reject uniformly.)

## Tier 2 validation (31/31)
Deployed to `advantage-staging` (076 applied via guarded runner). HTTP battery **27/27** (auth, authz, onboarding, real Cloudinary upload → attach, submit, moderation publish/reject/resubmit, public listing/detail + allowlist, plan limits 422s, audit_log) + **CORS** + **browser widget 4/4**. **31/31 passing.**

## Production deployment history
| Date | Change | Merge | Migration | Backup |
|---|---|---|---|---|
| 2026-07-04 | Organizations & Events platform (PR #11) | `81cc4df` | 076 applied to prod (PASS: 7 tables, 3/2/8 seeds) | Neon `prod-pre-events-launch-2026-07-02` = `br-shy-frog-anl9f2hg` |
| 2026-07-05 | `/org/events/new` redirect (PR #12) | `f0a7648` | none | n/a (route-only) |

## Production validation results
- **Post-platform (2026-07-04):** read-only 18/18 + CORS + widget mount/fetch 200.
- **Final release audit (2026-07-05):** **14/14** — onboarding, portal, event creation/editing, public page + detail, public API, widgets (browser mount + fetch 200 + 0 errors), Create-Event redirect (302, query preserved), plan enforcement (seeds live), image uploads (gated), admin moderation (gated), CORS, audit_log.

## Rollback information
- **Database:** restore from Neon backup **`prod-pre-events-launch-2026-07-02` (`br-shy-frog-anl9f2hg`)**, parent production `br-icy-forest-an7yv486`. Migration 076 is additive (7 new tables) — rollback is rarely needed; the tables can also be dropped + the ledger row removed.
- **Code:** revert merge `81cc4df` (platform) and/or `f0a7648` (redirect), then redeploy. Feature is additive + gated (no published events until organizations create them), so rollback risk is low.

## Deferred features
Verification workflow, recurring events, imports (BD/native events), paid promotions / monetization (all schema-only); seller ↔ organization backfill + capability-based upload authz; BD embed placement (needs BD page-edit access); BD MCP / page-edit automation; admin-created events / admin overrides.

## Future roadmap
See `docs/projects/launch-content-roadmap.md` (next phase: Houston + NYC/Tri-State launch content, initial org onboarding + event population, AAC launch events, BD widget rollout, imports, unified auth). Blueprint: `docs/projects/local-events-architecture.md`.

---

### Production Routing Changes
- **`/org/events/new` redirects to `/org/event-new.html`** — a server-side `302` alias added so BD "Create Event" links can use the clean `/org/events/new` path while the create page is served statically as `event-new.html`.
- **Query parameters are preserved** — e.g. `/org/events/new?market=houston` → `/org/event-new.html?market=houston`, and `?market=nyc_tristate` likewise; the no-query case redirects to `/org/event-new.html`.
- **Merge commit:** `f0a7648` (PR #12).
- **Production validation completed successfully:** all three cases return `302` with the correct `Location` and preserved query; the final target resolves `200`.
- Additive, auth-free, no DB/migration/Stripe/payment/seller/tax impact.
