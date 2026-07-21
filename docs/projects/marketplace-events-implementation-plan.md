# Advantage.Bid — Marketplace Events: Implementation Plan

**Status:** Design / implementation plan (read-only investigation complete; **no code, no migrations, no production/BD/DB changes**)
**Date:** 2026-07-20
**Author role:** Lead Architect (design deliverable only — implementation is NOT authorized yet)
**Companion docs:** `docs/projects/native-event-system-design.md` (prior audit), `docs/projects/local-events-architecture.md` (foundation spec, rev. 3 "decisions locked"), `docs/integration-contract-bd.md` (BD contract — authoritative), `docs/bd-integration-architecture.md` (subordinate impl spec), `docs/security/location-privacy-policy.md` (auction address-privacy pattern).

> **Framing (owner direction, 2026-07-20).** This is **product evolution, not migration** — there are **no production BD Event records to migrate**. The BD Event experience is the **approved product specification**; Advantage.Bid becomes the **storage + logic source of truth**; BD remains the **presentation/discovery layer** (marketing site, directory, city/state pages, SEO, editorial, `/all-events`, public widgets consuming Advantage APIs). Preserve every **business rule**; remove only **BD platform limitations**. Extend — do not rebuild — the substantial native Event foundation that already exists.

> **Investigation ceiling.** Items marked **[BD-EXPORT]** are BD-admin-internal (custom PHP, Widget Manager config, seller form field config, exact Hide-Address option wording, weekly-email mechanics) and are **not reachable** from the read-only REST API (`event`/`category`/`tags` return 403; no Widget/content/page/template API endpoints exist). Items marked **[OWNER]** are product/business decisions. Everything else is repo-verified or observed on the live BD pages and cited.

---

## 0. Finalized owner decisions (2026-07-20 — DECISIONS LOCKED)

The owner approved all 12 decisions. These are now the binding specification; where they differ from the analysis below, **these win**.

1. **Membership plans — FOUR tiers, keep existing names** (they already exist across the platform + marketing): **Gold Retailer · Silver Retailer · Individual · Appraiser**. (Note: this replaces the earlier three-tier `gold/silver/individual` sketch — **Appraiser is a fourth tier**.)
2. **Enforcement (listing limits only; NO payment now):**
   - **Gold Retailer:** unlimited event listings · unlimited photos.
   - **Silver Retailer:** **1 listing / month** · $35 additional listing = **FUTURE payment workflow, do NOT implement** · 125 photos.
   - **Individual:** **one owner-managed sale** (single active listing) · 125 photos.
   - **Appraiser:** **NO Marketplace Event listings** (0).
3. **Image limits:** Gold unlimited · Silver 125 · Individual 125; every permitted image selectable in a **single** upload (no BD 10-at-a-time restriction).
4. **Bulk uploader:** drag-drop · hundreds simultaneous · progress · retry · drag-reorder · cover selection · background processing · direct cloud uploads · automatic optimization · thumbnail generation.
5. **Hide Address Until:** preserve BD default — **full address published 24 hours prior to sale start**; build for future flexibility but ship the current approved experience first.
6. **Event schedules:** duplicate BD initially (single Start + single End); per-day daily hours is a **future** enhancement.
7. **Authentication:** **NO shared login / no SSO.** Seller logs into `bid.advantage.bid`, creates/manages events there; BD only displays public event data via Advantage APIs.
8. **Marketplace ownership:** events become first-class Advantage.Bid records (Advantage owns records/images/publishing/moderation/APIs); BD owns marketing/directory/city pages/SEO presentation/widgets displaying Advantage data.
9. **Weekly email promotion:** **Build Later** — separate project; does NOT block Marketplace Events.
10. **SEO:** event detail pages become **canonical on `bid.advantage.bid`** with JSON-LD + Open Graph + sitemap + canonical URLs; BD promotes/links to them.
11. **BD event parity:** document every existing BD event feature before implementation; preserve business rules, eliminate platform limitations; no intentional feature removal without owner approval.
12. **Implementation order (approved):** (1) BD parity audit + finalize spec → (2) extend native Event foundation → (3) seller event creation → (4) bulk image uploader → (5) Hide Address Until → (6) public event pages → (7) marketplace APIs → (8) unified marketplace integration → (9) BD widget integration → (10) future enhancements. **§15 below is re-sequenced to this order.**

**Consequences for this plan:** membership modeling (§6, §12) uses the four named tiers with `appraiser` = zero listings; weekly-email (§12) is explicitly deferred but its `weekly_email_promo` capability flag is still provisioned so tiers are complete; the `$35` fee is a future Stripe-gated workflow and is NOT built (quota enforced, charging not); auth (§4) is settled as native-only (no cookies/SSO); SEO (§9) is confirmed platform-owned for canonical event pages.

---

## Table of contents

1. Complete inventory of the current BD Marketplace Event implementation
2. Complete inventory of the existing Advantage native Event foundation
3. Gap analysis between the two
4. Authentication strategy (Advantage.Bid ↔ Brilliant Directories)
5. Final Marketplace Event architecture
6. Database model
7. API design
8. Seller workflow
9. Public Event pages
10. Unified Marketplace integration
11. Image upload architecture
12. Membership enforcement (GOLD / SILVER / INDIVIDUAL)
13. Hide Address Until implementation
14. Widget replacement strategy
15. Implementation increments in logical order
16. Risks and owner decisions requiring approval

---

## 1. Complete inventory of the current BD Marketplace Event implementation

Sources: live BD pages `www.advantage.bid/all-events` and `.../all-events/massive-antique-estate-sale-test` (fetched raw HTML 2026-07-20), the BD read-only API probe, and prior BD-agent statements. **Observed** = seen rendered; **[BD-EXPORT]** = admin-internal.

### 1.1 Event record & fields (Observed)
- **Title** (H1).
- **Dates:** a single **"Start"** and **"End"** datetime span — e.g. *"Start: September 5, 2026 at 4:43 PM / End: September 7, 2026 at 4:43 PM"*. **BD does not render per-day hours** — the sale is one continuous span. (Important: multi-day *daily hours* is therefore NOT an existing BD feature — see §3, §16.)
- **Description / "About":** rich-text body (`.the-post-description`).
- **Company attribution:** each listing links to a **company directory profile** (e.g. `/united-states/new-york/estate-liquidator/aac`, "Posted by AAC"). Events are tied to a company profile.
- **Category / event type** taxonomy (full list is **[BD-EXPORT]**; the owner's target types are Estate Sales, In-Person Auctions, Tag Sales, Moving Sales, Business Liquidations, Other).
- **Contact** (email/website) block on detail. **[BD-EXPORT for exact fields]**
- **"Required Field"** markers on the create form. **[BD-EXPORT for the exact required set]**
- **Membership tier signal:** listings carry a `member-level-N` CSS class on the search-result row (`member-level-1` observed) and a `data-activefavorite="Gold Retailers"` group marker — **tier drives card rendering/placement**.

### 1.2 Image / Photo-Album architecture (Observed + [BD-EXPORT])
- Detail gallery uses **RoyalSlider** (`class="royalSlider rsDefault"`, `rsImg`/`rsTmb`), captioned "Photo #1…N".
- Two derivatives per image: **`/photos/main/<hash>.webp`** (full) and **`/photos/display/<hash>.webp`** (thumbnail).
- Backed by BD **Photo Album** tables `users_portfolio_groups` → `users_portfolio` linked via `data_type=4` (event) + `data_id` (this event). **[BD-EXPORT: the portfolio schema, ordering, cover semantics.]** — This is a **BD platform implementation detail**, to be replaced by a first-class native gallery (owner's explicit instruction).
- **Observed defect:** the `/all-events` **search-result card contains NO `<img>` element** despite the event having 3 photos — the Photo-Album cover is not bound into the card image slot. A concrete example of BD template fragility that a native `is_cover` + always-computed `cover_image_url` eliminates.
- **BD upload limitation (the target to remove):** users may only upload **10 images at a time**. This is a platform limitation, not a business rule.

### 1.3 Hide Address Until (Observed — the approved behavior to replicate)
- While the address is hidden, the detail page renders a **styled notice box** (blue, `#5f7ea3`): *"The full address will be published **24 hours prior to the sale start time**. Please check back closer to the start time. If you want reminders for sales in your area, register for email notifications."*
- **Server-side withholding:** while hidden, the **exact address and any event map are entirely absent from the HTML** — this is not CSS `display:none`; the data is not sent. (Matches the auction privacy policy's "the API must return nothing before reveal.")
- **Reveal trigger observed:** time-based — **24 hours before sale start**. Whether the 24h window is fixed or seller-configurable, and whether other triggers exist (on-registration, on-approval), is **[BD-EXPORT]**.
- **Email-reminder CTA** is part of the hidden-state UX ("register for email notifications").
- **Detail-page map:** the Google Maps code present on the page is the **site-search location autocomplete** (Google Places Autocomplete + visitor reverse-geocoding), **not** an event-location map. No event map renders while the address is hidden. Map-on-reveal behavior is **[BD-EXPORT / unverifiable]**.

### 1.4 Search / listing behavior (Observed)
- `/all-events` renders a vertical list of `search_result` rows with **schema.org `ListItem` microdata** (BD-owned SEO), posted date, company attribution link, favorite/LIKE button, truncated description, "View More" → detail.
- **`member-level-N` class** on each row is the tier→placement mechanism. Ordering/facet/category-filter config is **[BD-EXPORT]** (only one live event, so ordering couldn't be observed).
- `/all-events` **already embeds the Advantage.Bid auction widget** — a `Featured Live Auctions` section with `<div id="featured-auctions-feed"></div>` (populated by our `bd-auctions-init.js`). The unified-marketplace direction is therefore **already partly live**.

### 1.5 Widgets / PHP / JS / CSS (mostly [BD-EXPORT])
- **Widget IDs/names, custom PHP templates, Widget Manager config, seller form config, category management, weekly-email mechanics** all live in BD admin and are **not API-accessible** (verified: no widget/content/page/template/module endpoints exist). These must be **exported by the BD agent** to serve as the definitive spec; the observable pages above are the best proxy.
- Observable client tech: RoyalSlider (gallery), Google Maps JS (search autocomplete), Bootstrap 3 + DataTables (layout/list), Froala (`fr-view`) content regions.

### 1.6 Membership plans (owner-provided business rules — authoritative)
GOLD / SILVER / INDIVIDUAL, detailed in §12. These are **business rules to enforce server-side**, replacing reliance on BD.

---

## 2. Complete inventory of the existing Advantage native Event foundation

**The native Event system is ~70% built** (migration `076`, spec `local-events-architecture.md`). Repo-verified:

### 2.1 Schema (`db/migrations/076_organizations_and_events.sql`)
- **`events`** (`:114-160`): `id, slug, organization_id, source(organization|admin|imported), market_slug, category_slug, title, description, venue_name, address, city, state, zip, lat, lng, start_at, end_at, timezone, is_recurring/recurrence_* (deferred), external_url, status(draft|submitted|published|rejected|archived), submitted_at, published_at, reviewed_by, review_reason, is_featured, promo_tier/promo_starts_at/promo_ends_at (scaffold), attribution_*, created_at, updated_at`.
- **`event_images`** (`:163-171`): `id, event_id, url, position, is_cover, created_at`.
- **`event_categories`** (`:96-111`): seeded `auctions, estate_sales, art_antiques, collectibles, markets_fairs, business_networking, community, other`.
- **`event_markets`** (`:78-93`): seeded `houston`, `nyc_tristate` (+ reserved geo columns).
- **`organizations`** / **`organization_members`** / **`organization_plans`** (ownership + tiers).
- **No** address-privacy, multi-day-schedule, contact-email, or event-type columns. `lat/lng` exist but nothing geocodes them.

### 2.2 Service (`src/services/eventsService.js`)
- Full **5-state lifecycle** (`draft→submitted→published|rejected→archived`), audit-logged; `EDITABLE_STATES={draft,rejected}`; `ACTIVE_STATES={submitted,published}`.
- Plan enforcement via `getPlanForOrg` (`:50-57`): **`max_active_events`** at submit (`:149-154`, 422 `ACTIVE_EVENT_LIMIT`), **`max_event_images`** on upload (`:185-189`, 422 `IMAGE_LIMIT`).
- `deriveOrganizerBadge` (`:42-48`), slug gen, admin transitions (`adminPublish/adminReject/adminReturnToDraft/adminArchive`).
- `assertCanFeature` exists but is **not called** (featured placement is scaffolding).

### 2.3 Routes
- **Public** `src/routes/publicEvents.js`: `GET /api/public/events?market=&category=&limit=&offset=` (+ `/:slug`, `/event-markets`, `/event-categories`); strict serializer allowlist (`:46-62`) that **omits `address`**; **restricted BD-origin CORS** (`EVENTS_ALLOWED_ORIGINS`). Filters: market + category only (**no text/city search, no ranking sort** — lags auctions).
- **Org portal** `src/routes/orgEvents.js` (`authMiddleware` + `resolveActingOrg`): CRUD, submit (gated `requireOrgCapability('events')`), archive, image upload (`POST /api/org/upload-image`, multer memory 10 MB → `cloudinaryService.uploadBuffer`) + attach/detach. **One-file-at-a-time.**
- **Admin** `src/routes/adminEvents.js`: moderation queue + publish/reject/return-to-draft/archive + audit trail.

### 2.4 UI
- `public/org/event-new.html` (create) + `event-edit.html` (edit + one-at-a-time photos) + `public/org/events.html` (list). Admin queue `public/admin/events.html`. Public `public/event.html?slug=` + `public/events.html`.

### 2.5 Widgets
- `public/widgets/events.js` (shadow-DOM city-page widget → `/api/public/events`) with a card renderer; `public/widgets/bd-auctions-init.js` (auctions grid, GLOBAL + ORG modes).

### 2.6 Reusable adjacent infrastructure (auctions)
- **Address privacy (to port):** `src/services/geocoding/{index,publicCoordinates,mapboxProvider}.js` + `db/migrations/090_auction_geocoding.sql` — precise `internal_lat/lng` never exposed, deterministic ~0.10-mile HMAC public offset, street-name-only, payment-gated full reveal (`docs/security/location-privacy-policy.md`).
- **Marketplace feed/cards:** `src/routes/public.js` `GET /api/public/auctions` (eligibility `state IN('published','active') AND marketplace_status='syndicated'`, text `q`/city/state filters, ranking sort via `discoveryRankingService.auctionScoreSQL`); `public/marketplace-components.js` `makeAuctionCard`; `src/services/marketplace/companyImage.js`.
- **Capability entitlements:** `capabilities`/`organization_capabilities`/`plan_capabilities` (migrations 077/078) + `capabilityService` + `requireOrgCapability`.
- **Image pipeline:** `cloudinaryService.uploadBuffer` + `image_processing_jobs` worker (URL transforms/`explicit()`; **no signed direct upload — TODO only**).
- **Auth:** stateless JWT bearer (see §4).

---

## 3. Gap analysis between the two

| Approved BD behavior | Business rule or platform limitation? | Native status | Action |
|---|---|---|---|
| Event record tied to a company/seller | Rule | Exists (`events`+`organizations`) | Reuse |
| 5-state moderation + publish workflow | Rule | Exists (`eventsService`,`adminEvents`) | Reuse |
| Category/event-type taxonomy | Rule | Partial (`event_categories`; single `category_slug`, no `event_type`) | Extend (add `event_type`; add owner's 6 types) |
| Single Start→End date span | Rule | Exists (`start_at`/`end_at`) | Reuse (baseline) |
| Per-day hours (multi-day) | **Not a BD feature** | N/A | **[OWNER] optional enhancement — do not assume** |
| About / description | Rule | Exists | Reuse |
| Contact email/website | Rule | Partial (`external_url` only) | Extend (add `contact_email`) |
| Company profile integration | Rule | Partial (org exists; link to marketplace card) | Extend |
| Photo Album (RoyalSlider, main+display webp) | **Platform detail** | Exists (`event_images` first-class) | **Replace BD album with native gallery** |
| 10-images-at-a-time upload | **Limitation** | N/A | **Remove — build bulk uploader (§11)** |
| Per-tier photo caps (125 / unlimited) | Rule | Partial (`max_event_images` 10/25/50) | Extend (tier values + unlimited sentinel) |
| Hide Address Until (24h-before-start reveal, server-withheld, email CTA) | **Rule (critical)** | **Missing on events** (auctions have the pattern) | **Port auction two-tier model + reveal trigger (§13)** |
| Event-location map | Rule | Missing on events (auctions geocode) | Wire geocoding + MapLibre (§9) |
| Search-result list + placement by tier | Rule | Partial (event feed has no search/sort/tier) | Extend to auction parity + tier ranking (§10,§12) |
| SEO (JSON-LD/OG/sitemap on listings) | Rule | **BD-owned today** | **Build platform SEO for canonical event pages (§9)** |
| Weekly email promotion | Rule (perk) | **Does not exist in platform** | **Build subscriber+scheduler+digest (§12) — large** |
| Company/Gold badge, lead generation | Rule (perk) | Missing | Add capabilities (§12) |
| Membership tiers (GOLD/SILVER/INDIVIDUAL) | Rule | Partial (free/standard/premium) | Reconcile/extend plans (§12) |
| `/all-events` unified feed | Rule/direction | Partial (auction widget already embedded) | Add event feed via widget (§10,§14) |
| Bearer-token auth | Platform | Exists (JWT) | Reuse; add shared-auth path (§4) |

**Net:** ~14 reuse, ~7 extend, ~5 genuine builds. The five real builds: **Hide-Address-Until, bulk uploader (signed direct upload), tiered membership enforcement, platform SEO for event pages, and weekly-email promotion.**

---

## 4. Authentication strategy (Advantage.Bid ↔ Brilliant Directories)

**Current reality (repo-verified).** Auth is **stateless JWT bearer**: login returns a signed JWT (`{id, role}`, HS256 via `JWT_SECRET`, `24h`, sliding-renewal via `X-Refreshed-Token`) **in the JSON body only** — `src/routes/auth.js:99-104`. **No cookies are set anywhere** (no `res.cookie`, no `cookie-parser`), so nothing is scoped to `.advantage.bid`. The browser stores the token in **`localStorage['token']`** and sends `Authorization: Bearer` (`authMiddleware.js:9-10`). Org context resolves per-request via `resolveActingOrg` (`X-Acting-Org-Id` or primary org through `organization_members`). **No BD SSO/handoff exists** — `bd-handoff` is contract/planning text only (`docs/integration-contract-bd.md:109`, `local-events-architecture.md:248` "No BD auth is built"). All live BD integration is read-only, one-way (Railway→BD widgets; daily BD-directory pull).

**Key architectural insight.** The two user journeys have very different auth needs:
- **Displaying** events on BD pages (`/all-events`, city pages) is **anonymous** — the widgets read public feeds; **no auth needed** (this already works for auctions).
- **Creating/managing** an event is **authenticated** and happens on **`bid.advantage.bid`** natively.

So "sign in once, works everywhere" only bites if we embed the **authenticated create/manage** experience inside a BD-presented page. The cleanest architecture avoids that entirely:

**Recommended strategy — native create, widget display, SSO-handoff as future polish:**
1. **Event creation/management is a native Advantage.Bid experience** (`bid.advantage.bid/org/*`), reached from BD via a **deep link** (the `/org/events/new?market=…` redirect already exists per `bd-events-embed-integration.md`). The seller authenticates once on `bid.advantage.bid`; the existing JWT/localStorage model works with **zero change**. This fully satisfies "the seller should never think about which platform owns their Event" because creation always happens on the platform that owns it.
2. **BD pages only display** events via anonymous widgets (§14) — no auth crosses the boundary.
3. **Future SSO (option 3 below)** — if the owner wants a BD-logged-in member to click "Create Event" and land already-authenticated on `bid.advantage.bid`, build the documented **one-way BD→Railway signed handoff**: BD signs a short-lived (≤5 min), nonce-protected token; a new `POST /api/auth/bd-handoff` verifies it, upserts the user, records an `identity_links` row, and mints a **native** Advantage JWT (reusing `authService.jwt.sign`). Railway stays the single writable identity store (honors "never deep-sync two writable identity stores"). Requires: new route + service + `identity_links` migration + shared secret + nonce store + kill-switch, **and BD must expose member SSO** (flagged "to verify" — **[BD-EXPORT]**).

**Options considered (with trade-offs):**
- **A. Bearer-in-iframe** (embed `bid.advantage.bid` create UI in BD): zero backend change, but third-party storage partitioning (Safari ITP/Chrome) isolates the iframe's `localStorage`, so first-visit users see no session; also needs `helmet` frame-ancestors relaxed for the BD origin. **Weak UX; not recommended for the create flow.**
- **B. Shared `.advantage.bid` cookie**: natural cross-host SSO, but requires adding cookies + `Access-Control-Allow-Credentials` + `SameSite=None` + **CSRF protection** (currently zero CSRF surface because there are no cookies), and **conflicts** with the contract's *"session boundaries between BD and the auction platform must remain distinct"* (`integration-contract-bd.md:149`). **Not recommended.**
- **C. Signed SSO handoff** (recommended future): consistent with the docs and the stateless model; most work; depends on BD SSO capability. **Target long-term.**

**Recommendation:** ship with **native create + deep link + widget display** (option 1, no auth changes). Add **SSO handoff (C)** only if/when the owner wants BD-member→platform auto-login, and only after BD's SSO capability is confirmed. Do **not** pursue shared cookies (B).

---

## 5. Final Marketplace Event architecture

```
                         ADVANTAGE.BID (source of truth — Railway/PostgreSQL)
  Users ─ organization_members ─ Organizations ─┬─ Auctions (existing)
                                                 └─ Marketplace Events (this plan)
                                                      • events (+ privacy, event_type, contact)
                                                      • event_images (bulk gallery, cover, order)
                                                      • sale_event_days (OPTIONAL, owner-gated)
                                                      • event_address_reveals (Hide-Address logic)
                                                      • organization_plans + capabilities (tiers)
        native auth (JWT)         create/manage            moderation (admin)
        ────────────────►  bid.advantage.bid/org/*  ──► draft→submitted→published
                                        │ geocode-at-publish (internal precise + public offset)
                                        ▼
        Public read-only APIs:  /api/public/events (search/sort parity) · /api/public/marketplace
                                        │  (JSON allowlist · privacy-safe · CORS)
                                        ▼
                 BRILLIANT DIRECTORIES (presentation/discovery only)
   marketing site · company directory · city/state pages · editorial · SEO · /all-events
   embeds Advantage widgets (events.js + bd-auctions-init.js) → live feed, zero duplicate records
```

**Principles:** (1) one canonical Event record on Advantage.Bid; (2) BD displays via live widgets, never stores events; (3) reuse organizations, seller accounts, moderation, images, maps, geocoding, address-privacy, marketplace cards; (4) preserve business rules, remove platform limits; (5) additive, non-destructive migrations; (6) no auction/bid/payment schema touched.

---

## 6. Database model

**Additive only. Do NOT put events in the auction table (they are already separate).** All new columns nullable/defaulted so existing rows stay valid.

**Extend `events`:**
- `event_type TEXT` — `estate_sale | in_person_auction | tag_sale | moving_sale | business_liquidation | other` (owner's target types). Keep `category_slug` for cross-cutting categories. **[OWNER: confirm type list + whether multi-category needed.]**
- `contact_email TEXT`, `contact_phone TEXT` (BD Contact parity).
- **Address privacy:** `address_privacy_mode TEXT NOT NULL DEFAULT 'exact'` CHECK(`exact|approximate|hidden_until`); `address_reveal_trigger TEXT DEFAULT 'none'` CHECK(`none|on_date|hours_before_start|on_registration|on_approval`); `address_reveal_at TIMESTAMPTZ`; `address_reveal_hours_before INT` (default 24 to match BD); `internal_lat DOUBLE PRECISION`, `internal_lng DOUBLE PRECISION` (precise, never public); reuse public `lat/lng` as the offset marker; `location_fingerprint TEXT`, `geocoding_status TEXT`, `geocoding_source TEXT`, `coordinates_manually_overridden BOOLEAN DEFAULT FALSE` (mirror auctions).
- `archived_at TIMESTAMPTZ` (auto-archive on expiry).

**Reuse `event_images`** as the native gallery (replaces BD Photo Album). Optionally add `width/height/bytes` if the signed-upload flow returns them; `position` + `is_cover` already support ordering/cover.

**Optional `sale_event_days`** (ONLY if owner approves per-day hours — **not** in BD today):
`id, event_id FK, sale_date DATE, opens_at TIME, closes_at TIME, note TEXT, position INT`. `events.start_at/end_at` remain canonical span for feed sort + reveal math.

**New `event_address_reveals`** (audit/notify support, optional): tracks computed reveal time + whether the reminder email fired, for the "register for reminders" CTA.

**Membership (see §12) — extend `organization_plans`:** add rows `gold/silver/individual` and columns: `max_event_images` (125 / 125 / unlimited-sentinel), `max_listings_per_month INT`, `max_categories INT`, `search_placement_tier INT`, plus map boolean perks (`weekly_email_promo`, `company_badge`, `lead_generation`, `company_profile`) through the existing **`plan_capabilities`** table. Use `NULL` or `-1` as the "unlimited" sentinel and update the `>=` checks in `eventsService.js:151,187`.

**`identity_links`** (ONLY if SSO handoff, §4 option C): `platform_user_id, provider, provider_user_id, provider_email, linked_at`.

One migration (or a small ordered set), additive; no changes to auction/bid/payment/seller tables.

---

## 7. API design

**Reuse + extend existing:**
- `GET /api/public/events` — **bring to auction parity:** add `q` (text), `city`, `state`, `event_type`, and a **ranking sort** (tier-aware, mirroring `auctionScoreSQL`). Extend serializer with `event_type`, `contact_email`, `schedule_days[]` (if enabled), `address_privacy_mode`, resolved reveal status, and **privacy-safe** location (offset `lat/lng` + city/state/zip; exact `address` **only** after reveal). **Never** emit `internal_lat/lng`. Reconcile CORS posture with `/api/public/auctions` (currently events use a restricted BD allow-list; auctions use `*`) — **[OWNER decision]**.
- `GET /api/public/events/:slug` — same privacy-safe rules.
- Org portal (`orgEvents.js`): keep CRUD/submit/archive; add the bulk-image + schedule + privacy fields.
- Admin (`adminEvents.js`): unchanged lifecycle; surface privacy/schedule in the moderation view.

**New endpoints:**
- `POST /api/uploads/signature` — Cloudinary signed direct-upload payload (ownership-scoped folder `event-images/<event_id>`); secret never leaves server (§11).
- `POST /api/org/events/:id/images/bulk` — attach an array of uploaded `secure_url`s in one call.
- `PATCH /api/org/events/:id/images/order` — persist reordered `position[]` + `is_cover`.
- `PUT /api/org/events/:id/schedule` — replace `sale_event_days[]` (only if enabled).
- `POST /api/public/events/:slug/reminders` — subscribe an email to the Hide-Address reveal / reminder (feeds §13 CTA + §12 weekly digest audience).
- (Internal) `geocodeEventSafe(event)` at publish; `POST /api/admin/events/:id/geocode` + `setManualCoordinates`.
- (SSO, optional) `POST /api/auth/bd-handoff` (§4 option C).

---

## 8. Seller workflow

Preserve the familiar BD flow; change only the storage + upload experience. Reuse `public/org/event-new.html` → `event-edit.html`, extended:
1. **Sign in** on `bid.advantage.bid` (native JWT; org auto-created on first event).
2. **Create event:** title*, event_type*, category, "About", contact email/website, Start/End datetime (timezone-aware — reuse `TimezoneUtils.localToUtcIso`). Same fields the seller uses today. **[BD-EXPORT: exact required-field set to match "Required Field" markers.]**
3. **Photos (new bulk uploader, §11):** select hundreds (GOLD) or up to 125 (SILVER/INDIVIDUAL) at once, background upload with progress/retry/cancel, drag-reorder, pick cover. Business-rule caps enforced server-side; the 10-at-a-time limit is gone.
4. **Address privacy (§13):** choose reveal mode/trigger; default **hidden-until, 24h before start** for estate-type events to match BD. **[BD-EXPORT to confirm options + defaults.]**
5. **(Optional) per-day hours** — only if owner approves the enhancement.
6. **Submit for review** → plan active-listing + monthly-quota checks (§12) → admin **Approve & Publish** → geocode fires → event goes live and flows to every BD display surface automatically.

Edit-lock preserved (edits only in `draft`/`rejected`). All visible copy honors CLAUDE.md public-language + no-vendor-name rules ("Uploading photo…", not "Cloudinary").

---

## 9. Public Event pages

Canonical detail page on `bid.advantage.bid` (extend `public/event.html?slug=`; consider a pretty `/events/:slug` route — **[OWNER]**):
- Header (title, event_type, organizer/company badge), About, Contact.
- **Dates:** the Start→End span (BD parity). Per-day schedule block **only if** enabled.
- **Gallery:** a self-hosted, CSP-safe multi-image gallery/lightbox (RoyalSlider-equivalent, no external CDN) fed by `event_images`, cover first.
- **Hide-Address-Until:** when hidden, render the **exact BD-style notice** ("full address published 24 hours prior to sale start") + the **email-reminder subscribe** control; withhold exact address + precise map from the payload (§13). When revealed, show full address + MapLibre exact pin.
- **Map:** MapLibre (self-hosted, privacy-safe) — offset marker while hidden, exact pin after reveal. Removes BD's Google-Maps dependency.
- **SEO (net-new — BD owns SEO today):** because the canonical record moves to Advantage.Bid, the platform must emit **JSON-LD (`@type: Event`), OpenGraph, and a sitemap entry** for event detail pages to preserve discovery. Today only `shareMetaService` (basic OG) exists. **[OWNER: confirm platform now owns SEO for event pages; reconcile with `bd-integration-architecture.md` §7 which currently assigns SEO to BD.]**

---

## 10. Unified Marketplace integration

Goal: `/all-events` evolves into one feed of **Live Auctions + Estate Sales + In-Person Auctions + Tag Sales + Moving Sales + Business Liquidations**.
- **Cards:** add `makeEventCard` beside `makeAuctionCard` in `marketplace-components.js` (event serializer already emits card-ready `cover_image_url/title/city/state/start_at/organizer_badge`). Events slot into the same grid.
- **Search parity:** extend `/api/public/events` with `q`/`city`/`state`/`event_type` + tier-aware ranking sort (§7) so events filter/sort like auctions.
- **Feed on `/all-events`:** drive the event grid from `public/widgets/events.js` exactly as `bd-auctions-init.js` drives `/auctions` (the auction widget is **already embedded** there). BD then holds **zero duplicate event records** — satisfying the CLAUDE.md canonical-distribution rule (which names events).
- **Tenant scoping:** company/estate-sale-company websites get a tenant-scoped widget filtered by stable `organization_id` UUID (never company-name text), mirroring the auction ORG mode.
- Owner action: embed the events-widget snippet on `/all-events` + city pages (BD page-edit access; Widget Manager is not API-accessible).

---

## 11. Image upload architecture (remove the 10-at-a-time limit; keep the caps)

**Today:** every byte flows browser → `multer` memory (10 MB/file, **one file per request**) → `cloudinaryService.uploadBuffer` → Cloudinary; caps 10/25/50 enforced in `eventsService.addImage`. **No signed/direct upload exists (TODO only).** Railway is a throughput/memory bottleneck for hundreds of images.

**Target:**
1. **Signed direct-to-object-storage.** New `POST /api/uploads/signature` calls `cloudinary.utils.api_sign_request({folder:'event-images/<event_id>', timestamp, …}, api_secret)` and returns signed params (secret never leaves the server); the browser uploads **directly** to Cloudinary — bytes never touch Railway.
2. **Bulk client uploader** (extend the drag-drop/thumbnail/reorder JS from `public/lot-builder.html`, adding what it lacks):
   - `<input multiple>` + drag-drop of **hundreds** of files.
   - **Concurrency-limited** queue (e.g. 4–6 parallel), **per-file progress**, **retry w/ backoff**, **cancel** (per-file + all).
   - **Drag-reorder** + **cover selection**; client-side type/size guard.
3. **Bulk attach** via `POST …/images/bulk` (one call records all URLs + order + cover).
4. **Tiered caps enforced server-side (business rule preserved):**
   - **GOLD:** unlimited (no cap; select hundreds at once; background processing).
   - **SILVER / INDIVIDUAL:** select all at once, **system enforces the 125-photo cap** (reject/trim past 125 with a clear message).
   Update the `>=` checks in `eventsService.js:187` to read the tier's `max_event_images` (with unlimited sentinel).
5. **Processing (optional):** reuse `image_processing_jobs` for `q_auto,f_auto` derivatives; or transform at Cloudinary delivery-URL time (no job needed for MVP).

**Security:** the signature endpoint verifies event ownership (org owner) or seller/admin, scopes the folder, and enforces type/size via the preset.

---

## 12. Membership enforcement (GOLD / SILVER / INDIVIDUAL)

**Enforce server-side (not via BD).** Build on the existing two-mechanism model: **numeric limits** in `organization_plans` (read by `getPlanForOrg`) + **boolean perks** in the `plan_capabilities`/`capabilityService`/`requireOrgCapability` catalog (077/078).

**Tier → rule mapping (FOUR tiers — finalized §0):** plan_tier keys `gold_retailer | silver_retailer | individual | appraiser`.

| Perk | Gold Retailer | Silver Retailer | Individual | Appraiser | Mechanism |
|---|---|---|---|---|---|
| Event listings | Unlimited | **1 / month** (+ $35 addl — future) | **1** (owner-managed) | **0 (none)** | `max_listings_per_month` (NULL=unlimited) + monthly counter; Individual = 1 active; Appraiser blocked at create |
| Photos / sale | Unlimited | 125 | 125 | — | `max_event_images` (NULL / 125 / 125 / 0), enforced `eventsService.addImage` |
| Search placement | Tier 1 | Tier 2 | Marketplace promotion | — | `search_placement_tier` → ranking sort (§10) |
| Weekly email promotion | Yes | Yes | — | — | `weekly_email_promo` capability (flag provisioned; **system Build-Later per §0.9**) |
| Company badge | Gold badge | (company profile) | — | — | `company_badge` capability + badge render |
| Company profile | Yes | Yes | — | Yes | `company_profile` capability |
| Lead generation | Yes | — | — | — | `lead_generation` capability |
| Marketplace listing | Yes | Yes | Yes | — | eligibility in the marketplace feed |

**Enforcement rules:**
- **Appraiser** → `max_listings_per_month = 0` and `max_event_images = 0`; the create endpoint rejects with a clear "your plan does not include Marketplace Event listings" message (new guard in `eventsService.createDraft`).
- **Individual** → 1 active listing total (reuse `max_active_events = 1`).
- **Silver** → **1 per calendar month** — a new **monthly-quota counter** (count listings created in the current month for the org), distinct from `max_active_events`; overage is where the future **$35 workflow** attaches (**NOT built now** — Stripe-gated, §16).
- **Gold** → unlimited (NULL sentinel; `>=` checks skip when limit is NULL).

**Implementation:** (a) add the four rows to `organization_plans` + numeric columns (`max_listings_per_month`, `search_placement_tier`; keep `max_active_events`, `max_event_images` with NULL=unlimited); (b) add capability keys (`weekly_email_promo`, `company_badge`, `company_profile`, `lead_generation`) + `plan_capabilities` rows per tier; (c) `grantPlanCapabilities` already re-grants on plan change; (d) add the monthly-listing counter + the Appraiser create-guard; (e) update the `>=` checks in `eventsService.js:151,187` to treat NULL as unlimited.

**Explicit carve-outs requiring owner + financial approval (STOP conditions):**
- SILVER's **"additional listing fee"** and any **paid plan upgrade / self-serve billing** are **financial flows** — **out of scope for this plan**; they require owner approval and touch Stripe (a governance stop condition). This plan enforces the *quota*; it does **not** build charging. **[OWNER + Stripe-gated]**
- **Weekly email promotion does not exist in the platform today** (transactional `emailService` only; no scheduler; `marketingService` is a TODO stub; "email campaign" is seed copy in `marketing_packages`). Delivering it as a GOLD/SILVER perk is a **net-new build**: a subscriber/audience source (partly fed by the reveal-reminder CTA, §13), a **scheduled worker** (none exists — the three workers are all event-driven), a digest template, and the `weekly_email_promo` flag to select promoted orgs. **[OWNER: confirm scope + priority — this is the single largest new subsystem.]**

**Reconciliation:** existing tiers are `free/standard/premium`. **[OWNER decision]:** map GOLD←premium / SILVER←standard / INDIVIDUAL←free (rename + re-value), or add the three as new tiers alongside. Recommend **renaming/re-valuing** to the owner's three so there is one membership vocabulary.

---

## 13. Hide Address Until implementation

**Replicate the approved behavior exactly — not a `hide_address` boolean.**

**Observed BD behavior to preserve:** while hidden, show the notice *"The full address will be published 24 hours prior to the sale start time…"* + an **email-reminder subscribe** CTA; **withhold** exact address + precise map from the payload; reveal automatically **24h before sale start**; then show full address + map.

**Native design (ports the proven auction two-tier model):**
- **Storage:** `address_privacy_mode` (`exact|approximate|hidden_until`), `address_reveal_trigger` (`none|on_date|hours_before_start|on_registration|on_approval`), `address_reveal_at`, `address_reveal_hours_before` (default **24**), `internal_lat/lng` (precise, never public), public `lat/lng` = deterministic **~0.10-mile HMAC offset** (reuse `src/services/geocoding/publicCoordinates.js`, keyed on eventId + `location_fingerprint`).
- **Business rule:** compute the reveal moment server-side (`start_at − address_reveal_hours_before`, or `address_reveal_at`, or on-registration/on-approval). Default for estate-type events = `hidden_until`, 24h before start (BD parity). **[BD-EXPORT: confirm whether the 24h is fixed or seller-set, and the full option list/wording.]**
- **Display logic (server-side gate, all surfaces):**
  - *Search card:* never show exact address; show city/state (+ "Address revealed soon").
  - *Detail page, hidden:* render the BD-style notice + reminder CTA; MapLibre shows the **offset** marker only; exact `address` absent from the payload.
  - *Detail page, revealed:* full `address` + exact MapLibre pin.
  - *API:* the serializer emits exact `address`/precise coords **only** after the computed reveal — mirroring the auction policy ("the API must return nothing before reveal"). `internal_lat/lng` **never** serialized.
- **Reveal timing:** a lightweight scheduled check (or compute-on-read) flips the state at reveal time; the **reminder email** (to `event_address_reveals` subscribers) fires at reveal. Compute-on-read avoids needing a new scheduler for the gate itself; the reminder email needs the scheduler from §12.
- **Widgets/PHP/JS/CSS (BD side):** the BD notice box + reveal are **BD template logic** we are **replacing**, not porting — **[BD-EXPORT]** the exact PHP/option config for fidelity, but the native implementation is server-authoritative and does not depend on BD.
- **Reuse:** `docs/security/location-privacy-policy.md` rationale (occupied homes/estates are theft targets) applies directly; the auction geocoding service, offset math, and street-name-strip are reused.

---

## 14. Widget replacement strategy

**BD widgets → Advantage widgets (display-only, live feed).** BD keeps zero event records.

| BD responsibility | Native replacement |
|---|---|
| Event search-results grid (`/all-events`) | `public/widgets/events.js` feed + `makeEventCard` (unified grid, §10) |
| Event detail (RoyalSlider gallery, map, address) | Canonical `bid.advantage.bid` event page (§9) linked from BD |
| City/state pages event list | `events.js` with `data-market`/`data-category` (tenant/market scoped) |
| Company profile events | Tenant-scoped `events.js` filtered by stable `organization_id` |
| Featured Live Auctions on `/all-events` | `bd-auctions-init.js` (**already embedded**) |

**[BD-EXPORT] to fully retire BD widgets:** the Widget Manager inventory (IDs/names), custom PHP, and any JS/CSS so the owner can swap each BD event widget for the Advantage snippet without losing layout. Owner performs the BD-side embed (page-edit access; Widget Manager is not API-accessible). Treat the exported widgets as **documentation of desired behavior**, per owner instruction.

---

## 15. Implementation increments (logical order)

Each is additive, independently shippable, behind the existing moderation gate. **No coding until owner approval; several increments are gated on [BD-EXPORT] or [OWNER] decisions.**

1. **Exports + decisions (no code).** Obtain BD exports (field config + required set, Hide-Address option list/defaults, category/type taxonomy, weekly-email mechanics, Photo-Album schema, widget inventory) or the `event`/`category` API read grant; resolve §16 owner decisions.
2. **Event model extensions.** Migration: `event_type`, `contact_email/phone`, address-privacy columns, `internal_lat/lng`, geocoding columns, `archived_at`. Additive. Tests.
3. **Hide-Address-Until.** Port `publicCoordinates` offset to events; `geocodeEventSafe` at publish; serializer privacy gate + compute-on-read reveal; reminder-subscribe endpoint. Tests asserting exact address absent until reveal (mirror `marketplace-privacy.test.js`).
4. **Signed direct upload endpoint.** `POST /api/uploads/signature` (ownership-scoped). Unit tests (signature validity, authz).
5. **Bulk uploader UI + ordering + tier caps.** Concurrency-limited drag-drop uploader (progress/retry/cancel), `…/images/bulk` + `…/images/order`; enforce GOLD-unlimited / 125-cap. E2E.
6. **Membership tiers.** Add gold/silver/individual plans + numeric columns + capabilities; monthly-listing counter; category-count check; badge/lead-gen/company-profile capabilities. Tests. (**Billing/fees excluded — §16.**)
7. **Search parity + event cards.** Extend `/api/public/events` with `q`/`city`/`state`/`event_type` + tier ranking; add `makeEventCard`. Tests.
8. **Public detail + map + gallery + SEO.** Extend `event.html`: schedule/span, self-hosted gallery/lightbox, MapLibre offset/exact, address-reveal display; emit JSON-LD/OG/sitemap for event pages.
9. **Unified `/all-events` + widgets.** Drive `/all-events` + city pages from `events.js`; tenant-scoped company widgets; owner embeds snippets.
10. **(Optional) per-day schedule; (Optional) SSO handoff; (Large) weekly-email subscriber+scheduler+digest.** Each owner-gated and independently scoped.

---

## 16. Risks and owner decisions requiring approval

**Owner / product decisions:**
1. **Membership vocabulary:** rename/re-value `free/standard/premium` → `gold/silver/individual` (recommended), or add alongside?
2. **SILVER "additional listing fee" + paid upgrades:** these are **financial flows (Stripe stop condition)** — approve separately; this plan enforces quotas only, not charging.
3. **Weekly email promotion:** the single largest net-new subsystem (no scheduler/subscriber/digest exists). Confirm scope + priority, or defer.
4. **SEO ownership:** platform must emit JSON-LD/OG/sitemap for canonical event pages (today SEO is contractually BD's). Confirm the shift + reconcile `bd-integration-architecture.md` §7.
5. **Per-day hours:** BD uses a single span. Add multi-day daily hours as an enhancement, or keep the span (BD parity)?
6. **Event types + categories:** confirm the 6 types and whether events are multi-category (drives `max_categories`).
7. **Shared auth:** native-create + widget-display (recommended, no auth change) vs. building the BD→Railway SSO handoff (needs BD SSO capability confirmed).
8. **Address reveal defaults:** confirm the 24h-before-start default and full option set (pending **[BD-EXPORT]**).
9. **CORS posture:** unify events' restricted BD-origin CORS with auctions' open `*` for the marketplace feed?
10. **Canonical URL:** pretty `/events/:slug` vs current `event.html?slug=`.

**Engineering risks + mitigations:**
- **BD-admin-internal unknowns** → gate Increment 1 on exports/API grant; design columns to reconcile, not guess.
- **Signed-upload security** → secret stays server-side; endpoint enforces ownership + folder scope + type/size preset.
- **Address-privacy regression** → reuse proven auction two-tier model + allowlist serializer; never emit `internal_lat/lng`; privacy tests.
- **Scope creep from weekly-email/SEO** → both are net-new; treat as separately-approved tracks, not bundled with the estate-sale MVP.
- **Financial stop condition** → no charging/fee logic built without explicit owner + Stripe approval.
- **Public-language/vendor rules (CLAUDE.md)** → no "AI"/vendor terms in any visible event UI.
- **Launch coupling** → decouple from the auction launch (Highland Estate OAT live, Stripe TEST); this is additive and independent.

**Launch-timing recommendation:** proceed **after** the auction launch validates. Sequence: Increment 1 (exports/decisions) → 2–5 (model, Hide-Address, signed upload, bulk uploader) as the estate-sale MVP → 6–9 (tiers, search/cards, public page/SEO, unified feed) → 10 (optional/large items) as separately-approved tracks.

---

*Prepared as a read-only audit + implementation plan. No production, BD, or database changes were made; no migrations authored; no implementation begun. **[BD-EXPORT]** items require BD-admin-internal data the read-only API cannot reach; **[OWNER]** items require product/business decisions; financial/billing items require explicit owner + Stripe approval before any work.*
