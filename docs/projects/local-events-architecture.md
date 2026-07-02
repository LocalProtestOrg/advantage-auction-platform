# Advantage.Bid — Organizations & Events Architecture

**Status:** Planning / decision record (pre-implementation — no code yet)
**Date:** 2026-07-02 (rev. 2 — Organization model + refinements)
**Scope:** The **Organization** business layer, with **Events** as its first Phase-1 product, surfaced on Brilliant Directories (BD) city pages. Railway/AAC is the source of truth.
**Launch markets:** Houston and NYC / Tri-State.

> Rev. 2 supersedes the original "local events" plan: events tables are renamed (no `local_` prefix), the moderation flow is simplified to 5 states, and `event_companies` is replaced by a foundational **Organization** model.

---

## 0. TL;DR (locked decisions)

- **The Organization is the foundational business entity.** `Users → Organizations → (Auctions, Events, Directory Listings, Advertising, Memberships, future Products)`. We are building the business ecosystem around the auction industry, not just an event feature.
- **Railway/AAC is the source of truth** for organizations, events, moderation, images, plans, and public feeds. **BD is display/marketing only** (embeds a read-only public API; owns nothing; no dependency).
- **Events are the first Phase-1 product** hung off organizations. Tables: **`events`, `event_images`, `event_categories`, `event_markets`** (no `local_` prefix — "local" is geography/filter, not a table name).
- **Moderation = 5 states:** `draft → submitted → published | rejected → archived`. Single admin action: **Approve & Publish**. (No separate "approved" state.)
- **Plans live at the org level** (`organization_plans`): free (10 imgs / 3 active events), standard (25 / 10), premium (50 / 25 / featured‑eligible). Enforced **server-side**.
- **Design-for-future, build-minimal:** recurrence columns, organizer **verification** (Verified / Community / Imported), and **geo coordinates** (evolving toward polygon markets) are in the schema now but **not implemented** in Phase 1.
- **Identity:** native Railway auth in Phase 1; optional one-way BD→Railway signed handoff later; migrate BD accounts into Railway long-term; **never** deep-sync two writable identity stores.
- **Not greenfield** — clones proven internal patterns: `widgets/featured-auctions.js`, `/api/public/*` conventions, the auction governance/`audit_log` lifecycle, and the Cloudinary pipeline.

---

## 1. The big picture — the Organization ecosystem

```
                 ┌─────────────┐
                 │    Users    │  (native Railway auth; source of truth)
                 └──────┬──────┘
                        │ organization_members (role: owner/admin/editor)
                 ┌──────▼───────┐
                 │ Organizations │  ← the heart of the platform (one business entity)
                 └──────┬───────┘
        ┌───────┬───────┼────────┬──────────┬─────────────┐
     Auctions  Events  Directory  Advertising  Memberships  Future products
   (existing)  (P1)    listings    (future)     (future)     (storefronts, services…)
```

- One organization is the **parent** of everything a business does on the platform, so we never have to reconcile separate business records per feature.
- **Railway becomes the true business platform; BD becomes a marketing front end.** This is what makes an eventual BD exit low-risk.
- **Phase 1 introduces the org layer for event organizers only.** Existing `seller_profiles`/auctions are **not** touched now; a later phase backfills `organization_id` onto sellers/auctions to bring them under the same parent. (Keeps Phase 1 additive and off the auction domain.)

---

## 2. Architecture — Railway = source of truth; BD = display only

Consistent with `docs/integration-contract-bd.md` and CLAUDE.md (platform independence; BD adapter-not-dependency; never depend on BD tables).

```
Organization user ─(BD "Create Event" deep link)─▶ Railway org portal (/org/events)
                                                    │ create → submit
                                                    ▼
                                     Railway = SOURCE OF TRUTH
                              (organizations, events, images, moderation, audit_log)
                                                    │ admin "Approve & Publish"
                                                    ▼
                               Public read-only API  /api/public/events?market=…
                                                    │ (JSON, allowlist, cache, CORS)
                                                    ▼
             BD city pages ◀── embeddable widget (/widgets/events.js  or  iframe fallback)
             (display only; no business logic; no ownership)
```

---

## 3. Organization model (foundational)

```sql
CREATE TABLE organization_plans (
  plan_tier          text PRIMARY KEY,          -- 'free','standard','premium'
  max_event_images   int  NOT NULL,
  max_active_events  int  NOT NULL,
  can_feature_events boolean NOT NULL DEFAULT false,
  -- room for future per-product limits (auctions, ads, listings, memberships) added later
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO organization_plans (plan_tier,max_event_images,max_active_events,can_feature_events) VALUES
  ('free',10,3,false),('standard',25,10,false),('premium',50,25,true)
ON CONFLICT (plan_tier) DO NOTHING;

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  type          text,                            -- descriptive: 'auction_company','estate_sale','antique_dealer','event_organizer','other'
  status        text NOT NULL DEFAULT 'active',  -- active|suspended
  plan_tier     text NOT NULL DEFAULT 'free' REFERENCES organization_plans(plan_tier),
  -- organizer verification (trust signal; anticipate now, minimal in P1)
  verification_status text NOT NULL DEFAULT 'unverified',  -- unverified|community|verified
  verified_at timestamptz, verified_by uuid REFERENCES users(id),
  -- profile / contact
  contact_email text, contact_phone text, website_url text, logo_url text, city text, state text,
  -- future link to the existing auction-seller identity (nullable; backfilled later)
  seller_profile_id uuid REFERENCES seller_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id),
  role            text NOT NULL DEFAULT 'owner',   -- owner|admin|editor|member
  status          text NOT NULL DEFAULT 'active',  -- active|invited|removed
  invited_email   text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_org_members_user ON organization_members(user_id);
```

- **Multi-user from day one** (`organization_members`), even if Phase-1 UI only exposes the owner. Future employees/roles need no migration.
- **Plans at the org level** — one plan governs all products; per-product overrides can be added later without restructuring.
- **Verification at the org level** — a single source; the event trust badge is *derived* (see §6).

---

## 4. Events domain (Phase-1 product)

```sql
CREATE TABLE event_markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL, name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true, sort_order int NOT NULL DEFAULT 0,
  -- geographic definition: radius now, polygon later (PostGIS) — evolve without renaming
  center_lat double precision, center_lng double precision, radius_km int,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO event_markets (slug,name,sort_order) VALUES
  ('houston','Houston, TX',1),('nyc_tristate','NYC / Tri-State',2) ON CONFLICT (slug) DO NOTHING;

CREATE TABLE event_categories (
  slug text PRIMARY KEY, name text NOT NULL, sort_order int NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true
);
INSERT INTO event_categories (slug,name,sort_order) VALUES
  ('auctions','Auctions',1),('estate_sales','Estate Sales',2),('art_antiques','Art & Antiques',3),
  ('collectibles','Collectibles',4),('markets_fairs','Markets & Fairs',5),('business_networking','Business / Networking',6),
  ('community','Community Events',7),('other','Other',8) ON CONFLICT (slug) DO NOTHING;

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  organization_id uuid REFERENCES organizations(id),   -- null for admin/imported
  source text NOT NULL DEFAULT 'organization' CHECK (source IN ('organization','admin','imported')),
  market_slug text NOT NULL REFERENCES event_markets(slug),
  category_slug text REFERENCES event_categories(slug),
  title text NOT NULL, description text,
  venue_name text, address text, city text, state text, zip text,
  lat double precision, lng double precision,          -- keep coords for future geo/polygon search
  start_at timestamptz NOT NULL, end_at timestamptz, timezone text NOT NULL DEFAULT 'America/New_York',
  -- recurrence (schema room only; NOT implemented in Phase 1)
  is_recurring boolean NOT NULL DEFAULT false,
  recurrence_type text,                                 -- 'none','daily','weekly','monthly','custom'
  recurrence_rule text,                                 -- iCal RRULE string (future)
  recurrence_parent_id uuid REFERENCES events(id),      -- materialized instances (future)
  external_url text,
  -- lifecycle (5 states)
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','published','rejected','archived')),
  submitted_at timestamptz, published_at timestamptz,
  reviewed_by uuid REFERENCES users(id), review_reason text,
  -- monetization scaffolding (Phase 1: columns only, never billed)
  is_featured boolean NOT NULL DEFAULT false, promo_tier text, promo_starts_at timestamptz, promo_ends_at timestamptz,
  -- third-party attribution (later phases)
  attribution_source text, attribution_url text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_market_status ON events(market_slug, status);
CREATE INDEX idx_events_start ON events(start_at);
CREATE INDEX idx_events_org ON events(organization_id);

CREATE TABLE event_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url text NOT NULL, position int NOT NULL DEFAULT 0, is_cover boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_images_event ON event_images(event_id);
```

**Migration:** `db/migrations/076_organizations_and_events.sql` (org + event tables + idempotent seeds), applied via the existing production-guarded runner. **Additive only** — no ALTER of auction/bid/payment/seller tables.

---

## 5. Geography & markets (evolvable)

- Keep `event_markets` (slug + name) as the near-term handle, **but store `lat/lng` on every event** and `center_lat/center_lng/radius_km` on markets.
- Near term, a market can optionally be defined by center+radius (so Houston can include Katy, Sugar Land, Pearland, The Woodlands via distance).
- Long term, replace the radius with **polygon markets (PostGIS geometry)** and geographic search — a data/columns change, **no table rename** (that's the point of dropping the `local_` prefix and keeping coordinates now).

---

## 6. Moderation, lifecycle & verification

**Lifecycle (5 states), every transition writes `auditService.logEvent`:**
```
draft ──submit(org)──▶ submitted ──Approve & Publish(admin)──▶ published ──archive(admin)──▶ archived
   ▲                        │
   └───return-to-draft──────┤──reject(admin, reason)──▶ rejected ──edit(org)──▶ draft
```
- Single admin action **"Approve & Publish"** (`submitted → published`). No "approved-but-unpublished" limbo.
- Org edits allowed **only** in `draft`/`rejected`. Nothing is public until an admin publishes.

**Organizer verification (trust signal — anticipate now, minimal in P1):** stored once on `organizations.verification_status`; the public **event badge is derived**:
| Condition | Public badge |
|---|---|
| `event.source = 'imported'` | **Imported Listing** (+ attribution) |
| `source='organization'` and org `verification_status='verified'` | **Verified Organizer** |
| `source='organization'` and org unverified/community | **Community Organizer** |
| `source='admin'` | **Advantage** (hosted) |
Phase 1 ships the column + an admin toggle only; the formal verification program comes later.

---

## 7. Public API & widget

- `GET /api/public/events?market=houston&category=&limit=&offset=` — **published**, upcoming/ongoing only; allowlisted fields; `PUBLIC_CACHE`; **restricted CORS**.
- `GET /api/public/events/:slug` · `GET /api/public/event-markets` · `GET /api/public/event-categories`.
- **CORS (net-new):** small middleware on `/api/public/events*` allowing `https://advantage.bid` (+ widget origins) only — never `*`.
- **Public allowlist:** id, slug, title, description, category, market, venue_name, city/state/zip, lat/lng, start_at/end_at, timezone, external_url, is_featured, **derived organizer badge**, cover + images[], organization{name,slug,logo_url,website_url,verification_status}, attribution_source/url. **Never** exposes moderation fields, `user_id`, membership, or plan internals.
- **`public/widgets/events.js`** (primary) + **`public/widgets/events.html?market=`** (iframe fallback) + **`public/event.html?slug=`** (public event detail page, Living Map design language) as the "View details" destination. CSS isolated to survive BD styles. Clones `featured-auctions.js`.

---

## 8. BD integration + embed snippets

JS widget (preferred):
```html
<div data-advantage-events data-market="houston" data-limit="12"></div>
<script async src="https://bid.advantage.bid/widgets/events.js"></script>
```
Iframe fallback:
```html
<iframe src="https://bid.advantage.bid/widgets/events.html?market=nyc_tristate"
        style="width:100%;border:0;min-height:900px" loading="lazy" title="Local events"></iframe>
```
BD "Create Event" (deep-link; market prefilled; lands on Railway login/signup if needed):
```html
<a href="https://bid.advantage.bid/org/events/new?market=houston">Create Event</a>
```
**SEO tradeoff (decision):** JS/iframe rendering is not crawlable by default; Phase 1 accepts this (no server-rendered BD SEO). Revisit later with a prerendered snapshot if city-page SEO becomes a priority.

---

## 9. Identity & login (phased)

- **Verified today:** Railway already owns identity natively (`/api/auth`, JWT). **No BD auth is built** (`bd-handoff` is contract-only).
- **Phase 1:** native Railway auth; org users create events after login; BD merely deep-links in.
- **Future (optional):** one-way **BD→Railway signed handoff** (signed, short-expiry, replay-protected token) + an `identity_links` mapping table (`platform_user_id, provider, provider_user_id, provider_email, linked_at`). BD becomes one provider; Railway still owns the user.
- **Long term:** migrate BD accounts into Railway; Railway is the single identity source. **Never deep-sync two writable stores.**
- **BD admin checklist** (verify before any BD bridge): API access + endpoints; webhooks + signing; SSO/custom-login; external-IdP support (likely none); member export (for future migration). None of this blocks Phase 1.

---

## 10. Phase-1 implementation plan (detailed)

**Routers** (mounted in `src/routes/index.js`; public in `public.js`).

**Org portal — `src/routes/orgEvents.js` → `/api/org`** (native `authMiddleware`; org-member-scoped)
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/org/profile` | Get/create-update the caller's organization (onboarding creates org + owner member) |
| GET | `/org/events` | List the org's events (all statuses) + plan usage |
| POST | `/org/events` | Create `draft` (active-event limit checked) |
| GET/PATCH | `/org/events/:id` | Get / edit (draft/rejected only) |
| POST | `/org/events/:id/submit` | `draft → submitted` |
| POST | `/org/events/:id/images` | Cloudinary upload (image limit enforced) |
| DELETE | `/org/events/:id/images/:imageId` | Remove image |
| POST | `/org/events/:id/archive` | Archive |

**Admin moderation — `src/routes/adminEvents.js` → `/api/admin/events`** (`authMiddleware` + `roleMiddleware('admin')`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/events?status=&market=` | Moderation queue |
| GET | `/admin/events/:id` | Full review record + audit trail |
| POST | `/admin/events/:id/publish` | **Approve & Publish** (`submitted → published`) |
| POST | `/admin/events/:id/reject` | `→ rejected` (reason) |
| POST | `/admin/events/:id/return-to-draft` | `→ draft` (reason) |
| POST | `/admin/events/:id/archive` | `→ archived` |
| POST | `/admin/events` · PATCH `/admin/events/:id` | Admin-created (`source='admin'`) / override |
| POST | `/admin/organizations/:id/verify` | Toggle org `verification_status` |

**Public — in `public.js` → `/api/public`:** the endpoints in §7 (+ CORS).

**Server-side services:** `organizationsService` (onboarding, membership, plan lookup), `eventsService` (slug, state-machine guards, plan-limit enforcement: `max_event_images`, `max_active_events` where active = `status IN ('submitted','published')`, `is_featured` gated by `can_feature_events`). All transitions → `auditService.logEvent`.

**Org portal pages (`public/org/…`, native auth):** `org/events.html` (list + statuses + plan usage + New Event), `org/event-new.html`, `org/event-edit.html?id=` (edit + image manager + Submit; shows rejection reason), `org/profile.html` (org profile + read-only plan/verification). Reuse `auth-refresh.js` + Cloudinary uploader; client guard → `/login.html?next=`.

**Admin pages (`public/admin/…`, admin auth):** `admin/events.html` (queue; Approve & Publish / Reject / Return / Archive), `admin/event-detail.html?id=` (full review + images + org + map + audit trail). Reuse `admin-nav.js`.

**Tests**
- *Jest:* slug generation; plan-limit enforcement (images + active events) per tier; 5-state transition guards; public allowlist (no field leakage); organizer-badge derivation.
- *Playwright e2e (staging, seeded identities; mirrors `governance-regression.spec.js`):* org onboarding → create draft → image-limit blocks 11th on free → submit → admin **Approve & Publish** → appears in `/api/public/events?market=houston` → widget renders; reject→edit→resubmit; active-event limit blocks 4th on free; public API returns only published + correct market; CORS header present; `audit_log` rows for submit/publish/reject.

**Rollout** (your standard process)
1. Branch `feat/organizations-events-phase1`.
2. Build: migration 076 → services/routes → org portal → admin moderation → public API+CORS → widget + iframe + public event page → seeds (markets/categories/plans + 1–2 sample events + 1 sample org).
3. **Staging:** apply 076 (guarded runner) → `railway up --service advantage-staging` → automated validation + e2e → product QA.
4. **Production:** review diff/scope → **fresh Neon backup** → apply 076 (guarded runner) → merge→deploy → validate URLs/API/widget → report (backup id, commit, validation).
5. **BD side (after prod):** paste the JS embed on Houston + NYC city pages; add the "Create Event" button.

---

## 11. Risks & guardrails

- **Additive only** — new tables only; **no ALTER** of auction/bid/payment/seller tables in Phase 1; no Stripe/bidding/settlement/tax changes.
- **Adapter-only on BD**; CORS scoped to advantage.bid.
- **Server-side enforcement** of plan limits and state transitions (never UI-only).
- **Moderation** — nothing public until admin publish; audit everything; org submissions untrusted.
- **Third-party/imported events** — attribution + "Imported Listing" badge; default draft; **no scraping** in Phase 1; respect source ToS.
- **Monetization/verification/recurrence/geo** — columns present, **behavior deferred**; no billing in Phase 1.
- **Identity** — native only in Phase 1; never deep-sync two writable stores.
- **Don't over-build** — org UI exposes owner-only for now; multi-member/roles ship when needed.

---

## 12. Phased roadmap

- **Phase 1:** organizations (+ owner member + plans) · events product · 5-state moderation · server-enforced limits · public API+CORS · JS widget + iframe + public event page · Houston + NYC · native auth.
- **Phase 2:** activate monetization (featured events, market spotlight, paid image/active-event upgrades, subscriptions) · richer widget (filters/map) · org multi-member/roles UI · JSON/RSS feeds · more markets.
- **Phase 3:** organizer **verification** program · **recurring events** (materialize from `recurrence_rule`) · third-party **API imports** (draft + approval + attribution; no scraping) · **geo/polygon markets** + distance search.
- **Phase 4:** link existing **sellers/auctions to organizations** (backfill `organization_id`) so auctions + events share one parent · directory listings · advertising.
- **Phase 5 (identity):** optional BD→Railway handoff · BD account **migration/consolidation** onto Railway.

---

## 13. Open questions (raised by the Organization model)

1. **Sellers ↔ organizations:** confirm Phase 1 leaves `seller_profiles`/auctions untouched and links them to `organizations` in a later backfill (recommended), vs. unifying now.
2. **Org onboarding:** auto-create an organization (creator = `owner`) on first event submission, or a distinct "create organization" step first? (Recommend auto-create with an editable profile.)
3. **One org per user in Phase 1**, or allow a user to belong to multiple orgs from the start? (Schema supports many; recommend UI-limit to one now.)
4. **Verification in Phase 1:** admin manual toggle only (recommended) — confirm criteria/process are deferred.
5. **Plan scope:** org-level plan governs all products (recommended) vs. per-product plans later.
6. **Markets:** confirm center+radius definitions for Houston / NYC Tri-State now, or slug-only until the geo/polygon phase.
7. **Canonical domain:** `bid.advantage.bid` for portal/API/widgets (per your answer) — confirm the org portal namespace `/org/…`.
8. **Event → org visibility:** public event shows the organization (name/logo/verification) — confirm that's desired for community organizers too.

---

## 14. Reusable existing assets (why this is low-risk)

- **Widgets/embed:** `public/widgets/featured-auctions.js/.html`, `bd-auctions-init.js`, `featured-lots.js`.
- **Public API + conventions:** `src/routes/public.js` (allowlists, `PUBLIC_CACHE`, `/config/widgets/:slug`).
- **Governance/moderation + audit:** auction lifecycle + `auditService.logEvent` (`e2e/governance-regression.spec.js`).
- **Images:** `cloudinaryService`. **Auth/roles:** `authMiddleware`, `roleMiddleware`, `optionalAuthMiddleware`. **Migrations:** `db/migrations/` (`0XX_*.sql`, guarded prod runner).
