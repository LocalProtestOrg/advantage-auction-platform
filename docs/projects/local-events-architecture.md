# Local Events — Architecture & Phase 1 Plan

**Status:** Planning / decision record (pre-implementation — no code yet)
**Date:** 2026-07-02
**Scope:** Company-created local events surfaced on Brilliant Directories (BD) city pages, with Railway/AAC as the source of truth.
**Launch markets:** NYC / Tri-State and Houston, TX.

---

## 0. TL;DR (locked decisions)

- **Railway/AAC is the source of truth for events.** BD does **not** own or manage events.
- **BD is display/marketing only** — it renders published events via an embed that consumes a read-only public API. No BD business logic, no dependency on BD tables.
- **Do not use BD-native event creation.** BD's "Create Event" deep-links into the Railway event portal.
- **Events are a first-class data type, separate from auctions** (separate tables, lifecycle, moderation queue, widget). They ride the *same rails* as auctions (public API + embeddable widget + governance/`audit_log` + Cloudinary).
- **Phase 1 uses Railway native auth.** No BD login integration required to ship events.
- **No deep two-way login sync — ever.** It is the one identity option to avoid.
- **Future (optional):** one-way BD→Railway signed handoff adapter; and/or a later one-time BD→Railway account migration to consolidate identity on Railway.
- This is **not greenfield** — it clones proven internal patterns: `widgets/featured-auctions.js/.html`, `/api/public/auctions`, the auction governance lifecycle, and the Cloudinary image pipeline.

---

## 1. Architecture — Railway as source of truth; BD as display only

Consistent with `docs/integration-contract-bd.md` ("BD is a presentation, discovery, and account-entry layer… adapter, not a platform dependency") and CLAUDE.md (platform independence; BD adapter-not-dependency; never depend on BD tables).

```
Company ──(BD "Create Event" deep link)──▶  Railway event portal (/company/events)
                                             │  create → submit
                                             ▼
                                   Railway = SOURCE OF TRUTH
                                   (local_events, images, moderation, audit_log)
                                             │  admin approve → published
                                             ▼
                              Public read-only API  /api/public/events?market=…
                                             │  (JSON, allowlisted fields, cache, CORS)
                                             ▼
      BD city pages ◀── embeddable widget (/widgets/events.js  or  iframe fallback)
      (display only; no business logic; no ownership)
```

- **Railway owns:** event records, images, image limits by plan/tier, moderation/approval, lifecycle, public feeds/widgets/API.
- **BD owns:** marketing/directory/city pages; it embeds and displays Railway events; it never writes or moderates them.
- **Auctions stay only on Railway/AAC** and remain a **separate data type** from events.

---

## 2. Identity & login

### Current state (verified in code)
- Railway already owns identity **natively** (`/api/auth` register / login / me / forgot-password / reset-password, JWT). Railway/AAC is already the de-facto identity source of truth.
- **No BD auth integration is built.** `bd-handoff` exists only as a recommendation in the BD contract — no code, no provider-mapping table, no SSO issuer.

### Decisions
1. **Phase 1: Railway native auth.** Companies click BD "Create Event" → land on Railway signup/login → create events. No BD login work required to launch.
2. **No deep two-way login sync.** Two writable identity stores fighting to stay consistent is the worst option; do not build it.
3. **Railway is the identity source of truth going forward** (it already is). Preferred end-state: **BD is unauthenticated marketing/directory that deep-links into Railway wherever login is needed** ("Option A").
4. **Future, optional — BD→Railway signed handoff (adapter).** Only if BD ever has member-gated content that must stay on BD. One-way: a BD member clicks → Railway trusts a **signed, short-expiry, replay-protected token** → creates/links a Railway user via an identity-mapping table (`platform_user_id, provider, provider_user_id, provider_email, linked_at`). BD remains one auth *provider*; Railway still owns the user record. Must be disable-able without breaking native login (per contract).
5. **Possible later — BD account migration into Railway.** Given low traffic + few accounts, a **one-time migration** of BD members into Railway (consolidating on a single identity system) is cleaner than sustained federation. Reduces BD to marketing pages that need no login.
6. **Avoid:** making BD an external IdP that Railway depends on; making BD's own login delegate to Railway (most BD plans can't consume external OIDC/SAML — not worth chasing).

### BD admin checklist (verify before designing any BD auth bridge)
Log into the BD admin and confirm on **your plan/version**:
- [ ] **API access** — is it enabled? Which endpoints (members, listings/events, categories)? Rate limits? Auth method (API key/OAuth)?
- [ ] **Webhooks** — available? Which events fire (member created/updated/login)? Signing/secret support?
- [ ] **SSO / login integration** — any native SSO, "single sign-on," or custom-login feature? Can BD *issue* a signed token/redirect we can verify?
- [ ] **External IdP support** — can BD's member login delegate to an external OIDC/SAML provider? (Likely no — confirm.)
- [ ] **Custom code injection** — can city pages embed a `<script>` tag (needed for the JS widget) or only an iframe/HTML block?
- [ ] **Member export** — can you export the member list (for a future migration)?
> None of these block Phase-1 events (native Railway auth). They only inform the *future, optional* handoff/migration.

---

## 3. BD integration method (display)

**Primary: JS script widget backed by a JSON API.** BD pastes `<script src="…/widgets/events.js"></script>` + `<div data-advantage-events data-market="houston"></div>`; the script fetches the public API and renders cards in the host page. Brand-cohesive, responsive, styleable, and it clones the existing `featured-auctions.js` pattern (lowest risk).

**Fallback: iframe** (`/widgets/events.html?market=…`) for BD pages that forbid `<script>` injection — isolated and simple, but weaker SEO/brand and harder sizing.

**Underlying JSON API** doubles as a feed; a JSON/RSS feed is a near-free later output.

**SEO tradeoff (decision needed):** JS/iframe-rendered events are **not crawlable by default**, so they add no fresh SEO content to BD city pages on their own. If SEO matters there, add a server-rendered snapshot (prerender/hydrate, or BD periodically pulls rendered HTML). Flagged as an explicit decision, not a default.

---

## 4. Data model (proposed)

Follows existing conventions (allowlisted public fields, `audit_log`, geocode pattern, lifecycle states). **Events are fully separate from auctions.**

- **`event_markets`** — table (not a hardcoded enum) so new markets are data, not migrations. e.g. `slug ('nyc_tristate'|'houston'), name, is_active`.
- **`event_companies`** — organizer org, linked to a platform user; `plan_tier`. *(Open Q: same entity as auction `seller_profile`, or separate?)*
- **`local_events`** — `id, slug, company_id (nullable), source ('company'|'imported'|'admin'), market, title, description, category, venue_name, address/city/state/zip, lat, lng, start_at, end_at, timezone, external_url, status, is_featured, promo_tier, promo_starts_at, promo_ends_at, attribution_source, attribution_url, reviewed_by, review_reason, submitted_at, approved_at, published_at, created_at, updated_at`.
- **`local_event_images`** — `event_id, url (Cloudinary), position, is_cover`.
- **`event_plan_limits`** — `plan_tier, max_images, max_active_events, can_feature, …` (config-driven; **enforced server-side**).
- **Reuse `audit_log`** for all moderation transitions.
- **Statuses:** `draft → submitted → approved → published → rejected → archived` (mirrors auction governance).

---

## 5. Public API & widget

- `GET /api/public/events?market=houston&status=published&limit=…` and `GET /api/public/events/:slug` — allowlisted fields, `Cache-Control` (reuse `PUBLIC_CACHE`), **plus restricted CORS** (net-new: allow `https://advantage.bid` origins only; the platform currently has no CORS).
- `/widgets/events.js` (script) + `/widgets/events.html?market=…` (iframe fallback) — clone `featured-auctions.js/.html`.
- BD copy/paste embed snippet + a documented **BD "Create Event"** deep-link URL.
- JSON/RSS feed = later, cheap secondary output of the same API.

---

## 6. Moderation, images, monetization scaffolding

- **Moderation (untrusted external companies):** approval required before `published`; reuse the auction governance pattern + `audit_log`; spam/abuse controls. Company-created events show the submitting company.
- **Third-party / public-source events (later phase):** default `imported → draft → admin approval`; **clear attribution** ("sourced from X; not hosted or endorsed by Advantage"); **no scraping in Phase 1**; respect source ToS/copyright.
- **Images:** Cloudinary; **per-plan limits enforced server-side** (never UI-only); supports more than BD's 10-image cap by tier.
- **Monetization (design now, build later):** schema carries `is_featured / promo_tier / promo_window` and `event_plan_limits` so paid promotions, featured placements, and company subscriptions are **additive later, not a rewrite**. No billing in Phase 1.

---

## 7. Risks & guardrails

- **Adapter-only on BD** — no BD tables/logic in any critical path (contract).
- **Legal exposure of third-party events** — attribution + "not hosted/endorsed"; approval-gated; no scraping in Phase 1.
- **Moderation** — external submissions are untrusted; approval before publish; audit everything.
- **Server-side enforcement** — image/active-event limits enforced in the API, not the UI.
- **CORS scope** — restrict to known origins, never `*`.
- **SEO tradeoff** of JS rendering — decide explicitly (see §3).
- **Separation** — events and auctions never share a table or moderation queue.
- **Don't over-build** — low traffic → keep Phase 1 minimal; promotions/SSO/imports come later; schema leaves room.
- **Identity** — never deep-sync two writable stores; keep Railway the source of truth.
- **Market gating** — hard-limit to the two launch markets initially.

---

## 8. Phased implementation

- **Phase 1 (MVP):** tables + company event portal (CRUD, draft→submit) + admin moderation queue + server-enforced tier image limits + public events API (+CORS) + one JS widget + iframe fallback + BD embed snippet + "Create Event" deep link + 2 markets + native Railway auth. Staging → validate → prod.
- **Phase 2:** activate promotions/featured/subscription scaffolding (paid placements), richer widget (filters/map), JSON/RSS feeds, more markets.
- **Phase 3:** third-party event **API imports** from approved sources (draft + approval + attribution). No scraping.
- **Phase 4 (identity):** optional BD→Railway SSO handoff adapter and/or one-time BD account consolidation onto Railway.

---

## 9. Phase 1 scope (first sprint)

Concrete, buildable, market-gated to NYC-Tri-State + Houston:
- **DB migrations:** `event_markets`, `event_companies` (or extension), `local_events`, `local_event_images`, `event_plan_limits`; reuse `audit_log`.
- **Company portal:** `/company/events`, `/company/events/new`, `/company/events/:id/edit` (draft→submit); Cloudinary upload with **server-enforced tier image limits**.
- **Moderation:** admin queue (approve / reject / return-to-draft) reusing the governance + `audit_log` pattern.
- **Public API:** `GET /api/public/events?market=` (+ `/:slug`), allowlisted fields, cache + **restricted CORS**.
- **Embed:** `/widgets/events.js` + `/widgets/events.html?market=` (iframe) + BD copy/paste snippet + "Create Event" deep-link.
- **Seed** the 2 markets + 1–2 sample events; staging validation; e2e for limits + moderation transitions.

**Explicitly out of Phase 1:** third-party imports, scraping, paid promotions/billing, SSO. (Schema leaves room for all.)

---

## 10. Open questions to answer before implementation

1. **Company = seller?** Is an "event company" the same entity as an auction `seller_profile`, or a separate `event_companies` model? *(Biggest schema fork.)*
2. **Markets:** exact definition of "NYC / Tri-State" (which counties/cities) and "Houston" (metro radius)? Table-driven markets OK?
3. **Who can create events in Phase 1:** any self-serve registered company, or admin-invited only? Is approval-before-publish always required?
4. **Plan tiers:** initial tier names + limits (max images, max active events, who can feature)? Is there a free tier?
5. **BD embed reality:** can BD city pages inject a `<script>` (→ JS widget) or only an iframe/HTML block? **Do events need to be SEO-crawlable** on BD pages?
6. **Canonical domain:** contract recommends `auctions.advantage.bid`, but live is `bid.advantage.bid`. Which domain hosts the event portal + public links + widget?
7. **Auth for "Create Event":** Railway native signup/login in Phase 1 (recommended), or must it be BD-handoff SSO from day one?
8. **Moderation ownership/SLA:** which admins approve events, and any turnaround target?
9. **Taxonomy:** reuse auction categories for events, or an event-specific category set?
10. **Monetization intent:** what promo/featured/subscription products are envisioned (to shape the schema)?

---

## 11. Reusable existing assets (why this is low-risk)

- **Widgets/embed:** `public/widgets/featured-auctions.js` + `featured-auctions.html`, `bd-auctions-init.js`, `featured-lots.js`.
- **Public API conventions:** `src/routes/public.js` (`/api/public/auctions`, `/featured-auctions`, `/config/widgets/:slug`, allowlists, `PUBLIC_CACHE`).
- **Governance/moderation:** auction lifecycle (draft→submitted→approved/rejected) + `audit_log` (see `e2e/governance-regression.spec.js`).
- **Images:** Cloudinary pipeline used by lots.
- **Auth:** native `src/routes/auth.js`.
