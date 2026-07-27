# Advantage.Bid — Native Event System: Audit & Design

**Status:** Audit + design (read-only investigation complete; **no code written; no migrations; no BD/prod/DB changes**)
**Date:** 2026-07-20
**Author role:** Lead Architect (per standing autonomous authority; this document is a design deliverable, not implementation)
**Scope:** Replace the Brilliant Directories (BD) Event experience with a native Advantage.Bid Event system where **Advantage.Bid PostgreSQL + object storage are the single source of truth** for estate-sale/Event records, images, schedules, locations, publishing, and moderation. Canonical public Event pages live on `bid.advantage.bid`. BD becomes display-only (embedded widgets), with **no duplicate Event records post-launch**.
**Supersedes-relationship:** This extends — does not replace — `docs/projects/local-events-architecture.md` (rev. 3, "decisions locked"), which is the authoritative foundation spec. Where this document adds estate-sale-specific behavior (multi-day schedules, Hide-Address-Until, bulk galleries), those are **additive** to that locked design.

> **Central finding.** The native Event system is **not greenfield — it is ~70% built.** Migration `076_organizations_and_events.sql` already ships the `events`, `event_images`, `event_categories`, `event_markets`, and `organizations`/`organization_members`/`organization_plans` tables; `src/services/eventsService.js` implements the full 5-state moderation lifecycle; `src/routes/{publicEvents,orgEvents,adminEvents}.js` are wired; and `public/org/event-new.html` + `event-edit.html` + the shadow-DOM `public/widgets/events.js` are built and (per `bd-events-embed-integration.md`) live in production. The genuinely-new work is narrow and additive: **(1) multi-day estate-sale schedules with daily hours, (2) a Hide-Address-Until privacy model, and (3) a bulk image uploader** capable of hundreds of images — which requires a signed direct-to-object-storage upload path that **does not exist today** (only TODO stubs in `cloudinaryService.js`).

---

## Table of contents

1. Executive summary
2. Method, access boundaries, and confidence levels
3. BD Event component inventory (observable + documented)
4. BD Event creation workflow (as specified by BD implementation)
5. BD Event detail page workflow
6. BD Event search-results / listing workflow
7. BD image & Photo-Album architecture (and the observed thumbnail defect)
8. Hide-Address-Until — deep dive
9. Location, geocoding & map behavior
10. Marketplace / `/all-events` integration model
11. BD seller/organizer guide & onboarding
12. **Functional Parity Matrix (10 columns)**
13. Reusable Advantage.Bid components (already built)
14. Proposed Railway data model (native Event system)
15. Proposed API endpoints
16. Bulk image-upload architecture (the primary required improvement)
17. Seller/organizer event-creation workflow (native)
18. Public native Event detail page
19. Unified `/all-events` consumer feed
20. BD → Railway migration mapping
21. Implementation increments (10)
22. Risks & mitigations
23. Open questions requiring owner/BD-agent input + launch-timing recommendation

---

## 1. Executive summary

**What exists.** Advantage.Bid already has a working native Events product built on an Organizations business layer (spec: `docs/projects/local-events-architecture.md`; schema: `db/migrations/076_organizations_and_events.sql`). It provides: organization ownership + membership, a 5-state moderation lifecycle (`draft → submitted → published | rejected → archived`) with full audit logging, category + market taxonomies (including an `estate_sales` category), a Cloudinary-backed image gallery with per-plan caps, a public read-only feed with a strict field allowlist and BD-restricted CORS, and an embeddable shadow-DOM widget for BD city pages. Org-facing create/edit pages (`public/org/event-new.html`, `event-edit.html`) and an admin moderation queue (`public/admin/events.html`) are built.

**What BD does that we must match or deliberately drop.** BD's Event feature (observed on the live `Massive Antique Estate Sale TEST` listing at `www.advantage.bid/all-events/massive-antique-estate-sale-test`, and per the BD agent's confirmed `data_type=4, data_id=8` multi-image portfolio architecture) presents: "Sale Start Date & Time" / "Sale End Date & Time", an About/description body, a Contact block (email/website), Category, a **Google-Maps geocoded map**, a **RoyalSlider multi-image gallery** (BD `users_portfolio_groups`/`users_portfolio` Photo-Album model), a **Hide-Address-Until** behavior (address-reveal language is present in the page), and BD's own moderation/field configuration. Several of these specifics — exact Hide-Address-Until option wording/storage, the precise field config, the seller guide text, and BD's `users_portfolio` schema — live inside BD admin and are **not observable via the read-only REST API** (verified: `event`/`category`/`tags` resources return 403; Widget Manager/content/page/template endpoints do not exist). Those items are flagged throughout as **NEEDS BD EXPORT**.

**The three real build items.**
1. **Multi-day schedules + daily hours.** BD estate sales run multiple days with per-day hours ("Fri 9–4, Sat 9–2"). Our `events` table has a single `start_at`/`end_at` only. Needs a child `sale_event_days` table + UI + serializer.
2. **Hide-Address-Until.** Our events currently expose `address` all-or-nothing (the public serializer simply omits `address`, exposing `venue_name`/`city`/`state`/`zip`/`lat`/`lng`). BD offers a *configurable reveal* (e.g., reveal on a date, reveal after registration/approval). We should port the **auction two-tier geocoding-privacy model** (`src/services/geocoding/`: precise `internal_lat/lng` never exposed, a deterministic ~0.10-mile public offset marker) and add an explicit per-event privacy mode + reveal trigger.
3. **Bulk image uploader (the primary required improvement).** BD caps uploads at ~10 at a time; the owner wants hundreds of images, drag-drop, direct-to-object-storage, with progress/retry/cancel/ordering/cover selection. Our current pipeline routes **every image byte through Railway** (`multer` memory → `cloudinaryService.uploadBuffer` → Cloudinary), one file per request, 10 MB each, and enforces per-plan caps of 10/25/50. This must be replaced with a **signed direct-to-Cloudinary** upload path (which does not exist — only TODO comments in `cloudinaryService.js`), a bulk client uploader, and raised/removed caps for estate-sale events.

**Recommendation.** Treat the existing Organizations/Events foundation as the spec-of-record and ship the estate-sale capability as **additive increments** (Section 21). Do **not** rebuild from scratch and do **not** disable the existing Events system. Estimated net-new surface: one migration adding `sale_event_days` + privacy columns + a signed-upload endpoint + a bulk uploader UI + serializer/feed extensions. Everything else (ownership, lifecycle, moderation, taxonomy, audit, widget, public feed) is reused as-is.

---

## 2. Method, access boundaries, and confidence levels

**What I could observe directly (high confidence):**
- The live BD Event detail page HTML (`/all-events/massive-antique-estate-sale-test`, 338,984 bytes) and the `/all-events` search-results HTML — field labels, section structure, map provider, gallery library, and rendered/absent elements.
- The entire Advantage.Bid repository — schema, services, routes, UI, widgets, docs — read exhaustively (three parallel Explore passes).
- The BD read-only REST API surface (previously probed): `user`/`leads` readable; `event`/`category`/`tags` return **403 (exists, not granted)**; Widget Manager / content / page / template / module endpoints **do not exist** as API resources.

**What I could NOT observe (flagged NEEDS BD EXPORT throughout):**
- BD admin-internal configuration: the exact Event **field definitions**, the **Hide-Address-Until option list + storage semantics**, custom PHP templates, Widget Manager contents, the **seller/organizer guide** text, and the BD `users_portfolio`/`users_portfolio_groups` schema (`data_type=4`, `data_id=8` relationship). These require the BD agent to export them, or the owner to grant the `event`/`category` API read permissions.

**Confidence key used in the matrix (Section 12):** `OBSERVED` (saw it rendered), `DOCUMENTED` (in a repo doc or BD-agent statement), `INFERRED` (reasoned from adjacent evidence), `NEEDS BD EXPORT` (BD-admin-internal, unverifiable from here).

**Boundaries honored:** no production, BD, or database writes; no migrations; no implementation; the existing Event system and widgets remain untouched; no Stripe/settlement changes. This file is the only artifact produced.

---

## 3. BD Event component inventory (observable + documented)

The owner's 46-point inventory request maps to the following observable + documented components. Items marked **[EXPORT]** are BD-admin-internal.

**Data & fields (per the live detail page + BD-agent confirmation):**
- Event title (H1).
- Category (BD event category taxonomy) **[EXPORT for full list]**.
- "Sale Start Date & Time" and "Sale End Date & Time" (single start + single end datetime labels). Multi-day estate sales appear to be expressed as a start→end span, not per-day hours **[EXPORT: confirm whether BD stores per-day hours or only a span]**.
- "About" / description (rich text body).
- Contact block: email address, website/external URL.
- Location: venue/address with a **Hide-Address-Until** behavior (address-reveal language observed).
- "Required Field" markers on the create form (field-level validation) **[EXPORT for exact required set]**.
- Multi-image **Photo Album** via BD `users_portfolio_groups` → `users_portfolio` (confirmed `data_type=4`, `data_id=8` for the TEST event).

**Behaviors & surfaces:**
- Google-Maps geocoded map (uses `google.maps`, `maps.googleapis.com`, a `latitude` value).
- RoyalSlider image gallery (`rsMainSlide` / `royalSlider`; 27 gallery signals in the detail HTML).
- Hide-Address-Until reveal ("address will…" language present) **[EXPORT for the trigger + option wording]**.
- BD moderation / publishing workflow **[EXPORT]**.
- BD Widget Manager placement of the "Advantage Live Auctions" widget (Widget 43) on `/auctions` **[owner-managed; not API-accessible]**.

**Search-results / listing surface:**
- `/all-events` search-results grid renders event cards. **Observed defect:** the `Massive Antique Estate Sale TEST` card (result rows ~1981–2021 of the `/all-events` HTML) renders **no `<img>` element at all** — the Photo-Album cover thumbnail is entirely absent (not a broken URL). See Section 7.

**Admin-internal (all [EXPORT]):** field configuration, form layout, help text, category management, Hide-Address-Until settings, seller guide, template/PHP, and any BD-side monetization/featuring of events.

---

## 4. BD Event creation workflow (as specified by BD implementation)

**Observable/documented portions:**
- Entry is via a BD "Create Event" affordance; on the Advantage.Bid side we already provide the deep link `/org/events/new?market=…` (302 → `/org/event-new.html`, query preserved), per `docs/projects/bd-events-embed-integration.md`.
- The BD form captures title, category, start/end datetime ("Sale Start/End Date & Time"), description ("About"), contact (email/website), location/address, images (Photo Album), with "Required Field" markers.

**NEEDS BD EXPORT:** the exact field list, ordering, required-vs-optional flags, help text, the Hide-Address-Until control as presented on the form, the image-upload widget (and its ~10-at-a-time limit), and any category/tag pickers. This is the "authoritative functional specification" the owner referenced; the observable page confirms the *fields exist* but the BD admin form config is the definitive source and must be exported.

**Native equivalent that already exists:** `public/org/event-new.html` (create) + `public/org/event-edit.html` (edit + photos). See Sections 13 and 17.

---

## 5. BD Event detail page workflow

Observed on `www.advantage.bid/all-events/massive-antique-estate-sale-test`:
- **Header:** event title (H1).
- **Dates:** "Sale Start Date & Time" and "Sale End Date & Time" labels with values.
- **About:** description body.
- **Gallery:** RoyalSlider (`rsMainSlide`) multi-image slider fed by the BD Photo Album.
- **Map:** Google-Maps embed geocoded from the address (`google.maps` + `latitude`).
- **Contact:** email + website.
- **Category** chip/label.
- **Address reveal:** "address will…" language — the exact address is gated (Hide-Address-Until).

**Native equivalent that already exists:** `public/event.html?slug=…` renders a native detail page from `GET /api/public/events/:slug`. It currently lacks the multi-day schedule display, the RoyalSlider-equivalent bulk gallery, and the Hide-Address-Until reveal — those are the additive items in Sections 8, 16, 18.

---

## 6. BD Event search-results / listing workflow

- `/all-events` is BD's combined consumer marketplace page. Per the owner's clarified architecture, `/all-events` is intended to display **both** native BD estate-sale listings **and** the live Advantage.Bid auction widget (Widget 43, `[widget=Advantage Live Auctions]`). We do **not** replace BD's native Events module there; we embed the auction widget alongside it.
- The search-results grid renders event cards linking to detail pages.
- **Observed thumbnail defect (Section 7):** the TEST event's card has no image element.

**Post-migration intent:** once native Events are the source of truth, the `/all-events` grid should be fed by the Advantage.Bid public events feed (via a widget, exactly like auctions), so BD holds **no duplicate Event records** — consistent with the CLAUDE.md "Canonical Auction Distribution Architecture" rule, which explicitly names **events**: *"Do not create duplicate native auction or event records on external sites."*

---

## 7. BD image & Photo-Album architecture (and the observed thumbnail defect)

**BD model (per BD agent):** images live in `users_portfolio_groups` (the album) → `users_portfolio` (the images), linked to the event by `data_type=4` (event) + `data_id=8` (this event's id). The detail page renders them through RoyalSlider. **[EXPORT: the full `users_portfolio` schema, image URL columns, ordering, and cover-selection semantics.]**

**Observed defect on `/all-events`:** the `Massive Antique Estate Sale TEST` search-result card contains **no `<img>` element** — the Photo-Album cover is not being passed into the card's image slot. This is a BD template/data-binding gap (the group→image relationship isn't surfaced to the card), **not** a broken URL. It is a concrete example of why owning the Event record natively (with a first-class `is_cover` image and a serializer that always emits `cover_image_url`) removes an entire class of BD template fragility. **[EXPORT: confirm the BD card template's image binding; but do not fix in BD — this migrates away.]**

**Native model that already exists:** `event_images(event_id, url, position, is_cover)` — a first-class gallery table with an explicit cover flag; the public serializer always computes `cover_image_url` via subquery, so the "no thumbnail" defect cannot occur natively.

---

## 8. Hide-Address-Until — deep dive

**BD behavior (observed + partial):** the detail page contains address-reveal language ("address will…"), indicating BD hides the precise street address until some trigger. **NEEDS BD EXPORT:** the exact option set (e.g., *reveal on a date* / *reveal N hours before start* / *reveal after registration* / *never reveal, show approximate only*), the wording, and how BD stores the choice.

**What Advantage.Bid already has for the *auction* domain (the pattern to port):**
- **Two coordinate tiers** (`db/migrations/090_auction_geocoding.sql`): public `lat/lng` = a deterministically **offset** point (~0.10 mi / 161 m), never the property; private `internal_lat/internal_lng` = precise, never exposed publicly.
- **Deterministic offset** (`src/services/geocoding/publicCoordinates.js`): bearing = HMAC-SHA256(auctionId + location_fingerprint), stable across reloads/deploys, rounded to 5 dp.
- **Street-name-only exposure** (`src/routes/auctions.js`): the house number is stripped (`street_address.replace(/^\s*\d+\s*/,'')`) and `street_address` deleted from the public row.
- **Payment-gated full reveal** (`docs/security/location-privacy-policy.md`): full address unlocked only for the paid winning buyer via a payment-gated endpoint; also visible to admin/seller.
- **Supporting columns:** `geocoding_status`, `geocoding_source`, `coordinates_manually_overridden`, `location_fingerprint`.

**What events have today:** **nothing** — no `hide_address`/privacy column; the public serializer simply omits `address` but *does* expose `city/state/zip/lat/lng` as plain columns (and events currently expose full `address` to the owner only). There is no reveal trigger, no offset, no internal/public split.

**Proposed native Hide-Address-Until model (design):**
- Add to the event: `address_privacy_mode` ∈ {`exact` (public venue, show full address), `approximate` (offset marker + city/zip only), `hidden_until` (approximate until a trigger, then exact)}.
- Add `address_reveal_trigger` ∈ {`none`, `on_date`, `hours_before_start`, `on_registration`, `on_approval`} + `address_reveal_at` (timestamptz) / `address_reveal_hours_before` (int). **[EXPORT to match BD's exact option set — this design should be reconciled to BD's before build.]**
- Add `internal_lat/internal_lng` (precise) + keep public `lat/lng` as the **offset** point, reusing `src/services/geocoding/publicCoordinates.js` verbatim (bearing keyed on eventId + fingerprint).
- Public serializer emits the exact `address` **only** when `address_privacy_mode='exact'` OR the reveal trigger has fired; otherwise emits offset `lat/lng` + `city/state/zip` + a human "Address revealed on …" string.
- Estate-sale rationale is already codified in `docs/security/location-privacy-policy.md` ("occupied homes, estates in transition… are targets for theft and trespass") — the same justification extends to estate-sale *events*.

**Owner decision needed:** for events the current design is intentionally public (events are public venues). Estate sales are the exception — confirm whether *all* estate-sale events default to `hidden_until`, and what the default reveal trigger is. (Section 23.)

---

## 9. Location, geocoding & map behavior

**BD:** Google Maps, geocoded from the address, latitude present. **[EXPORT: whether BD stores its own lat/lng or geocodes at render.]**

**Advantage.Bid native (exists for auctions; must be wired for events):**
- `events` already has unused `lat/lng` columns (migration 076) — nothing geocodes them today.
- The auction geocoding service (`src/services/auctionGeocodingService.js`, `src/services/geocoding/index.js`, `mapboxProvider.js`) geocodes at publish behind an adapter, with a precision ladder (street → city/state/zip → zip → city/state), skip-if-fingerprint-unchanged, and never-throw-into-save semantics. It is **not wired to events**.
- Map rendering on Advantage.Bid uses **MapLibre GL JS** (self-hosted, privacy-safe), not Google Maps — so migrating away from BD also removes the Google-Maps dependency and keeps the ~0.10-mi privacy offset intact for estate-sale addresses.

**Design:** wire `geocodeEventSafe(event)` at publish (mirroring `geocodeAuctionSafe`), populate `internal_lat/lng` (precise) + public `lat/lng` (offset), and render with MapLibre. Requires the existing `MAPBOX_GEOCODING_TOKEN` (already discussed for the homepage map — see project memory `project_geocoding_architecture`).

---

## 10. Marketplace / `/all-events` integration model

Per the owner's clarified architecture and CLAUDE.md "Canonical Auction Distribution Architecture":
- `/all-events` (BD) = the combined consumer page showing **native estate-sale Events + the live auction widget**. We embed, we do not replace BD's Events module *pre-migration*.
- **Post-migration**, native Events become source of truth; BD's `/all-events` grid should be fed by an Advantage.Bid **events widget** (exactly like `bd-auctions-init.js` feeds `/auctions`), so **no duplicate Event records** exist in BD. The `public/widgets/events.js` shadow-DOM widget already does this for city pages and can drive `/all-events`.
- Eligibility rule (mirrors auctions): only `status='published'` + not-ended events appear publicly; the public serializer allowlist prevents leaking moderation/owner/plan internals.
- The owner-side action (embedding the widget snippet on `/all-events`) requires BD page-edit access and is owner-managed (BD Widget Manager is not API-accessible).

---

## 11. BD seller/organizer guide & onboarding

**NEEDS BD EXPORT:** BD's seller/organizer guide for creating an event (the step-by-step, screenshots, field help, image-upload instructions, Hide-Address-Until guidance). There is **no** event-organizer onboarding SOP in the repo — the closest is `docs/sop-seller-onboarding.md` (auctions) and the org auto-onboarding described in `local-events-architecture.md` §13 (auto-create org on first event; required name + contact).

**Native equivalent to author (post-design):** a short organizer guide mirroring `docs/sop-seller-onboarding.md`, covering: sign in → create event (auto-creates org) → add photos (bulk) → set schedule/hours → set address privacy → submit for review → admin "Approve & Publish". This should be reconciled against BD's exported guide so we preserve any owner-approved messaging (and honor the CLAUDE.md public-language + no-vendor-names rules).

---

## 12. Functional Parity Matrix (10 columns)

Columns: **Capability** · **BD behavior** · **BD storage** · **Advantage equivalent?** · **Advantage file/table** · **Status** · **Reuse vs Build** · **Gap** · **Increment** · **BD export needed?**

| Capability | BD behavior | BD storage | Advantage equivalent? | Advantage file / table | Status | Reuse / Build | Gap | Incr. | BD export? |
|---|---|---|---|---|---|---|---|---|---|
| Event record / ownership | Event tied to a BD user/profile | BD `events` + user tables | Yes — org-owned event | `events` (076), `organizations` | **Exists** | Reuse | none | — | No |
| Moderation lifecycle | BD publish/approve flow | BD admin | Yes — 5-state + audit | `eventsService.js`, `adminEvents.js` | **Exists** | Reuse | none | — | Config only [EXPORT] |
| Category | Event category | BD taxonomy | Yes — incl. `estate_sales` | `event_categories` (076) | **Exists** | Reuse | Estate subtypes/tags thin | Incr 6 | Full list [EXPORT] |
| Market / geography | City pages | BD | Yes — `event_markets` | `event_markets` (076) | **Exists** | Reuse | none | — | No |
| Start/End datetime | "Sale Start/End Date & Time" | BD event fields | Yes — single span | `events.start_at/end_at` | **Exists** | Reuse | no per-day hours | — | Confirm span-vs-days [EXPORT] |
| **Multi-day schedule + daily hours** | Estate sales run multiple days w/ hours | BD **[EXPORT]** | **No** | — (needs `sale_event_days`) | **Missing** | **Build** | whole feature | **Incr 3** | Yes [EXPORT] |
| About / description | Rich text | BD | Yes | `events.description` | **Exists** | Reuse | rich-text parity | Incr 7 | No |
| Contact (email/website) | Contact block | BD | Partial (external_url) | `events.external_url` | **Partial** | Build (add contact email) | no contact email col | Incr 7 | No |
| Image gallery | RoyalSlider Photo Album | `users_portfolio_groups`/`users_portfolio` (`data_type=4`) | Yes — gallery table | `event_images` (076) | **Exists** | Reuse | see bulk-upload row | — | Schema [EXPORT] |
| Cover thumbnail | Album cover (defect: card `<img>` absent) | BD portfolio | Yes — `is_cover` + serializer | `event_images.is_cover`, `publicEvents.js` | **Exists (better)** | Reuse | BD defect n/a natively | — | No |
| **Bulk upload (hundreds)** | ~10-at-a-time limit | BD | **No** — 1/req, caps 10/25/50, bytes via server | `orgEvents.js` upload, `cloudinaryService.js` | **Missing** | **Build** | signed direct upload + bulk UI + caps | **Incr 4–5** | No |
| Image ordering | Album order | BD | Partial (`position` append-only) | `event_images.position` | **Partial** | Build (reorder UI+endpoint) | no reorder UX | Incr 5 | No |
| **Hide-Address-Until** | Address reveal (options) | BD **[EXPORT]** | **No** (events); Yes (auctions pattern) | `src/services/geocoding/*` (auctions) | **Missing (events)** | **Build (port)** | privacy cols + reveal trigger | **Incr 2** | Yes — option set [EXPORT] |
| Geocoding | Google geocode | BD | Yes (auctions), not wired to events | `auctionGeocodingService.js` | **Partial** | Build (wire to events) | not wired; no offset for events | Incr 2 | No |
| Map render | Google Maps | BD/Google | Yes — MapLibre (self-hosted) | homepage/marketplace MapLibre | **Exists** | Reuse | swap Google→MapLibre | Incr 8 | No |
| Public detail page | BD detail template | BD PHP | Yes | `public/event.html` | **Exists** | Reuse/extend | schedule+gallery+reveal | Incr 8 | No |
| Public feed / API | BD render | BD | Yes — allowlisted feed | `publicEvents.js` | **Exists** | Reuse/extend | add schedule/privacy fields | Incr 8 | No |
| Embeddable widget | BD native module | BD | Yes — shadow-DOM widget | `public/widgets/events.js` | **Exists** | Reuse | drive `/all-events` | Incr 9 | Owner embed |
| Create/edit UI | BD form | BD | Yes | `public/org/event-new/edit.html` | **Exists** | Reuse/extend | schedule + privacy + bulk photos | Incr 5,7 | Field config [EXPORT] |
| Required-field validation | "Required Field" | BD form | Partial (client) | `event-new.html` | **Partial** | Build (match required set) | unknown required set | Incr 7 | Yes [EXPORT] |
| Seller/organizer guide | BD guide | BD **[EXPORT]** | No | — | **Missing** | Build (author) | no SOP | Incr 10 | Yes [EXPORT] |
| Expiration / auto-archive | BD | BD | No (read-time filter only) | `publicEvents.js` filter | **Partial** | Build (scheduler) | no auto-archive | Incr 6 | No |
| `/all-events` unified feed | BD native grid | BD | Widget-fed (design) | `events.js` + auction widget | **Partial** | Build/owner-embed | embed on `/all-events` | Incr 9 | Owner embed |

**Summary counts:** ~14 capabilities **Exist/Reuse**, ~4 **Partial**, ~5 **Build** (of which the three headline items are multi-day schedule, Hide-Address-Until, bulk upload). Roughly **70% reuse**.

---

## 13. Reusable Advantage.Bid components (already built)

Reused **as-is**:
- **Ownership:** `organizations`, `organization_members`, `assertOwner`, auto-onboard-on-first-event, `organizations.seller_profile_id` link to auction sellers.
- **Lifecycle + moderation:** `eventsService.js` (`draft→submitted→published|rejected→archived`, plan-limit enforcement, slug gen, organizer-badge derivation, audit logging) + `adminEvents.js` (publish/reject/return-to-draft/archive queue).
- **Taxonomy:** `event_categories` (incl. `estate_sales`) + `event_markets` (`houston`, `nyc_tristate`), table-driven.
- **Images:** `event_images(event_id,url,position,is_cover)` + Cloudinary `uploadBuffer` + `image_processing_jobs` worker.
- **Public feed:** `publicEvents.js` (allowlisted serializer, BD-restricted CORS, cache), `event.html`, `events.html`.
- **Widget:** `public/widgets/events.js` (shadow DOM, city-page embed).
- **Privacy pattern (from auctions):** `src/services/geocoding/{index,publicCoordinates,mapboxProvider}.js` + `db/migrations/090_auction_geocoding.sql` — the two-tier offset model to port to events.
- **Client uploader mechanics (from auctions):** `public/lot-builder.html` drag-drop + thumbnail + drag-reorder JS (starting point; needs concurrency/progress/retry hardening).
- **Form patterns:** `public/seller-create.html` single-page sectioned form + `TimezoneUtils.localToUtcIso` timezone handling.

Reused **with extension:** the create/edit pages, the public serializer, and the widget (all need the schedule/privacy/bulk-gallery additions).

---

## 14. Proposed Railway data model (native Event system)

**Principle:** additive only; do **not** put events in the auction table (they're already separate — `events`, migration 076). Extend the existing `events` table and add child tables. All new columns nullable/defaulted so the migration is additive and existing rows are valid.

**Extend `events` (new columns):**
- `contact_email TEXT` — BD parity (Contact block).
- `event_type TEXT` — estate-sale subtype (`estate_sale`, `moving_sale`, `downsizing`, `market_fair`, `other`); default `NULL`. **[EXPORT to match BD.]**
- `is_multi_day BOOLEAN NOT NULL DEFAULT FALSE`.
- `address_privacy_mode TEXT NOT NULL DEFAULT 'exact'` CHECK IN (`exact`,`approximate`,`hidden_until`).
- `address_reveal_trigger TEXT DEFAULT 'none'` CHECK IN (`none`,`on_date`,`hours_before_start`,`on_registration`,`on_approval`).
- `address_reveal_at TIMESTAMPTZ`, `address_reveal_hours_before INT`.
- `internal_lat DOUBLE PRECISION`, `internal_lng DOUBLE PRECISION` (precise; never public). Public `lat/lng` become the offset marker.
- `geocoding_status TEXT`, `geocoding_source TEXT`, `location_fingerprint TEXT`, `coordinates_manually_overridden BOOLEAN DEFAULT FALSE` (mirror auctions).
- `archived_at TIMESTAMPTZ` (for auto-archive on expiry).

**New child table `sale_event_days`** (multi-day schedule + daily hours):
```
id UUID PK
event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE
sale_date DATE NOT NULL
opens_at TIME NOT NULL
closes_at TIME NOT NULL
note TEXT              -- e.g. "Half-price day", "Presale by appointment"
position INT NOT NULL DEFAULT 0
UNIQUE(event_id, sale_date, opens_at)
INDEX(event_id)
```
`events.start_at`/`end_at` remain the canonical span (min opens / max closes) for feed sorting + expiry; `sale_event_days` carries the human-readable daily hours.

**Reuse `event_images` as-is** for the gallery; raise the per-plan cap for estate-sale events (config in `organization_plans.max_event_images` — bump to e.g. 300, or make estate-sale events exempt). Optionally add `event_images.width/height/bytes` if the signed-upload flow returns them (nice-to-have for layout, not required).

**Optional `sale_event_tags`** (many-to-many) if BD uses tags — **[EXPORT to confirm].**

No changes to auction/bid/payment/seller tables. One migration, additive.

---

## 15. Proposed API endpoints

**Reuse existing (extend serializers):**
- `GET /api/public/events` / `:slug` (`publicEvents.js`) — add `schedule_days[]`, `address_privacy_mode`, resolved reveal status, offset `lat/lng`, `contact_email`, `event_type`. Keep the strict allowlist; **never** emit `internal_lat/lng` or exact `address` unless the reveal has fired.
- `GET /api/public/event-markets`, `/api/public/event-categories` — unchanged.
- Org portal (`orgEvents.js`): `GET/POST /events`, `GET/PATCH /events/:id`, `POST /events/:id/submit|archive`, `POST /events/:id/images`, `DELETE /events/:id/images/:imageId`.
- Admin (`adminEvents.js`): queue + publish/reject/return-to-draft/archive.

**New:**
- `POST /api/uploads/signature` — returns a Cloudinary signed-upload payload (`signature`, `timestamp`, `api_key`, `cloud_name`, `folder`, allowed formats) so the browser uploads **directly** to object storage. Auth: org owner or seller/admin. (Section 16.)
- `POST /api/org/events/:id/images/bulk` — attach an array of already-uploaded `secure_url`s in one call (replaces N sequential attaches).
- `PATCH /api/org/events/:id/images/order` — persist a reordered `position[]` + set `is_cover`.
- `PUT /api/org/events/:id/schedule` — replace the `sale_event_days[]` set for the event.
- (Internal) `geocodeEventSafe(event)` invoked on publish; optional `POST /api/admin/events/:id/geocode` for manual re-geocode + `setManualCoordinates`.

---

## 16. Bulk image-upload architecture (the primary required improvement)

**Today (the constraint):** every image byte flows browser → `multer` memory (10 MB/file, one file per request) → `cloudinaryService.uploadBuffer` → Cloudinary. Per-plan caps are 10/25/50. There is **no signed/direct upload** (only TODO comments at `cloudinaryService.js:3-8`). Railway is a throughput + memory bottleneck for hundreds of images.

**Target design:**
1. **Signed direct-to-object-storage.** New `POST /api/uploads/signature` calls `cloudinary.utils.api_sign_request({ folder:'event-images', timestamp, ... }, api_secret)` and returns the signed params (never the secret). The browser POSTs each file **directly** to `https://api.cloudinary.com/v1_1/<cloud>/image/upload` — bytes never touch Railway. (Alternative: an unsigned `upload_preset` scoped to the events folder; signed is preferred for control.)
2. **Bulk client uploader** (extend `lot-builder.html`'s drag-drop/thumbnail/reorder JS, adding what it lacks):
   - `<input type="file" multiple>` + drag-drop of hundreds of files.
   - **Concurrency-limited** queue (e.g., 4–6 parallel), not unbounded `Promise.all`.
   - **Per-file progress**, **retry with backoff**, **cancel** (individual + all).
   - Client-side guards: type allowlist, max size, optional downscale before upload.
   - **Ordering + cover selection** via drag-reorder; persists through `PATCH …/images/order`.
3. **Attach in bulk.** After direct uploads resolve, one `POST …/images/bulk` records all `secure_url`s + positions + cover.
4. **Caps.** Raise `max_event_images` for estate-sale events (config-driven; e.g. 300) or exempt them.
5. **Processing (optional).** The existing `image_processing_jobs` worker can generate `q_auto,f_auto` derived URLs for gallery thumbnails; not required for MVP (Cloudinary can transform at delivery-URL time).

**Security/ownership:** the signature endpoint must verify the caller owns the event (org owner) or is seller/admin, and scope the folder to `event-images/<event_id>`; enforce type/size in the preset. No secret leaves the server.

**Result:** hundreds of images, drag-drop, direct-to-object-storage, progress/retry/cancel/ordering/cover — meeting the owner's stated requirement and removing the 10-at-a-time BD limitation.

---

## 17. Seller/organizer event-creation workflow (native)

Reuse `public/org/event-new.html` → `event-edit.html`, extended:
1. **Sign in** (native Railway auth).
2. **Create event** (`event-new.html`): title*, market*, category*/event_type, description ("About"), contact email/website, start/end datetime (timezone-aware). Org auto-created on first event.
3. **Schedule** (new): if multi-day, add per-day rows (date + open/close + note) → `PUT …/schedule`.
4. **Photos** (new bulk uploader): drag hundreds of images, reorder, pick cover (Section 16).
5. **Address privacy** (new): choose `exact` / `approximate` / `hidden_until` + reveal trigger. **[EXPORT to match BD's option set.]**
6. **Submit for review** → `POST …/submit` (enforces plan active-event limit + capability `events`).
7. **Admin "Approve & Publish"** (`adminEvents.js`) → geocode-at-publish fires → event goes public.

Honors CLAUDE.md public-language (no "AI"/vendor terms in visible UI) and the existing edit-lock (edits only in `draft`/`rejected`).

---

## 18. Public native Event detail page

Extend `public/event.html?slug=…`:
- Header (title, category, organizer badge), About, Contact.
- **Schedule block:** render `schedule_days[]` ("Fri Jul 25, 9:00 AM–4:00 PM", etc.) instead of a single span for multi-day sales.
- **Gallery:** a proper multi-image gallery/lightbox (RoyalSlider-equivalent; a lightweight self-hosted gallery, no external CDN — CSP-safe) fed by `event_images` with cover first.
- **Map:** MapLibre marker at the **offset** public point when address is hidden; exact pin only when revealed.
- **Address:** show full `address` only when `address_privacy_mode='exact'` or the reveal trigger has fired; otherwise show city/state/zip + "Exact address revealed on …".

Canonical URL: `https://bid.advantage.bid/event.html?slug=…` (or a prettier `/events/:slug` route) — the single source of truth BD links to.

---

## 19. Unified `/all-events` consumer feed

- **Pre-migration:** `/all-events` (BD) shows BD-native Events **plus** the embedded live auction widget (Widget 43). No changes to BD's Events module.
- **Post-migration:** feed the `/all-events` grid from Advantage.Bid via `public/widgets/events.js` (shadow-DOM, reads `GET /api/public/events`), exactly as `bd-auctions-init.js` feeds `/auctions`. BD then holds **zero duplicate Event records** — satisfying the CLAUDE.md canonical-distribution rule for events.
- Owner action: embed the events-widget snippet on `/all-events` (BD page-edit access; Widget Manager is not API-accessible). Provide the snippet analogous to the auctions one:
  `<script src="https://bid.advantage.bid/widgets/events.js" data-market="all" data-limit="24"></script>`
- Both auctions and events on `/all-events` then read live from `bid.advantage.bid` — one canonical record each, no copies, lifecycle-free on the BD side.

---

## 20. BD → Railway migration mapping

| BD field / concept | BD storage | Native target | Notes |
|---|---|---|---|
| Event title | BD event | `events.title` | direct |
| Category | BD taxonomy | `events.category_slug` | map to `event_categories`; add estate subtypes **[EXPORT list]** |
| Sale Start/End Date & Time | BD event | `events.start_at`/`end_at` | if per-day hours exist in BD → `sale_event_days` **[EXPORT]** |
| About | BD event | `events.description` | rich-text sanitize |
| Contact email / website | BD event | `events.contact_email` / `external_url` | add `contact_email` col |
| Address | BD event | `events.address` + privacy cols | apply `address_privacy_mode` per estate-sale default |
| Hide-Address-Until choice | BD **[EXPORT]** | `address_privacy_mode` + reveal trigger | reconcile option set before migrating |
| Photo Album images | `users_portfolio_groups`/`users_portfolio` (`data_type=4`,`data_id=8`) | `event_images` (`url`,`position`,`is_cover`) | export image URLs + order + cover **[EXPORT]** |
| Lat/lng | BD/Google | `internal_lat/lng` (precise) + offset public `lat/lng` | re-geocode natively; do not import Google coords as public |
| Organizer/owner | BD user | `organizations` (+ `organization_members`) | create/link org; link to `seller_profile_id` if applicable |
| Publish state | BD | `events.status='published'` + `published_at` | set via admin publish, writing audit_log |

**Migration mechanics (design, not to run now):** a one-way import script (pattern: `scripts/import-bd-directory.js`) that reads BD event records via the API **once the `event` read permission is granted**, upserts into `events` + `event_images` + `sale_event_days`, idempotent on a stable `bd_listing_id`/`match_key` (mirror the directory-mirror approach in migration 080/092). After cutover, BD's native Event records are decommissioned/hidden and `/all-events` is fed by the widget — **no duplicates**.

---

## 21. Implementation increments (10)

Each increment is independently shippable, additive, and behind the existing moderation gates. **No coding begins until owner approval + BD exports for the flagged items.**

1. **Foundation reconciliation + exports.** Obtain BD exports (field config, Hide-Address-Until options, `users_portfolio` schema, seller guide) or the `event`/`category` API read permission. Confirm span-vs-per-day-hours. No code.
2. **Address-privacy model.** Migration: add privacy columns + `internal_lat/lng`; port `src/services/geocoding/publicCoordinates.js` offset to events; wire `geocodeEventSafe` at publish; serializer emits offset/exact per mode + reveal. Tests.
3. **Multi-day schedule.** Migration: `sale_event_days`; `PUT …/schedule` endpoint; serializer `schedule_days[]`; `is_multi_day`. Tests.
4. **Signed direct upload endpoint.** `POST /api/uploads/signature` (Cloudinary `api_sign_request`), ownership-scoped folder; unit tests (signature validity, authz).
5. **Bulk uploader UI + ordering.** Extend the org edit page with the concurrency-limited drag-drop uploader (progress/retry/cancel), `…/images/bulk` + `…/images/order`; raise estate-sale image cap. E2E.
6. **Taxonomy + expiration.** Estate-sale subtypes/tags; auto-archive scheduler (published + ended → archived + `archived_at`).
7. **Create/edit form parity.** Add contact email, event_type, required-field set (matched to BD export), rich-text About; validation.
8. **Public detail + map + gallery.** Extend `event.html`: schedule block, self-hosted gallery/lightbox (CSP-safe), MapLibre offset/exact marker, address-reveal display.
9. **`/all-events` widget feed.** Ensure `events.js` can drive `/all-events`; provide the owner embed snippet; verify no duplicate records + live lifecycle.
10. **Organizer guide + migration script + cutover.** Author the organizer SOP (reconciled to BD's); build the idempotent BD→Railway import; dry-run on staging; owner-gated production cutover + BD decommission of native Event records.

---

## 22. Risks & mitigations

- **BD-admin-internal unknowns** (Hide-Address-Until options, field config, `users_portfolio` schema, seller guide). *Mitigation:* gate Increment 1 on BD exports or the `event` API read grant; design columns to be reconciled, not guessed.
- **Signed-upload security** (leaking the Cloudinary secret; unauthorized uploads). *Mitigation:* secret never leaves the server; signature endpoint enforces event ownership + folder scoping + type/size preset.
- **Address-privacy regression** (accidentally exposing exact coords/address). *Mitigation:* reuse the proven auction two-tier model + allowlist serializer; never emit `internal_lat/lng`; add tests asserting exact address absent until reveal (mirror `marketplace-privacy.test.js`).
- **Migration duplication** (BD + native both showing events). *Mitigation:* idempotent import keyed on stable id; cutover flips `/all-events` to the widget and decommissions BD native records; enforce the CLAUDE.md no-duplicate-external-records rule.
- **Plan-cap collision** (bulk upload vs `max_event_images`). *Mitigation:* config-driven cap bump / estate-sale exemption in Increment 5.
- **Public-language + vendor-name rules** (CLAUDE.md). *Mitigation:* no "AI"/vendor terms in any visible event UI; "Uploading photo…" not "Cloudinary".
- **Google-Maps → MapLibre swap** parity. *Mitigation:* MapLibre already used elsewhere; offset marker keeps privacy.

---

## 23. Open questions (owner / BD-agent) + launch-timing recommendation

**Requires BD export (BD agent or `event` API read grant):**
1. Exact Event **field configuration** + required-field set.
2. **Hide-Address-Until** option list, wording, trigger semantics, and storage.
3. Whether BD stores **per-day hours** or only a start→end span.
4. The `users_portfolio`/`users_portfolio_groups` **image schema** (URLs, order, cover) for migration.
5. BD **seller/organizer guide** text (to preserve approved messaging).
6. Full **category/tag** taxonomy for events.

**Requires owner decision:**
7. Do **all** estate-sale events default to `hidden_until`, and what is the default reveal trigger (on-date / hours-before / on-registration)? (Events are otherwise public venues.)
8. Bulk image cap for estate-sale events (e.g., 300) or fully exempt?
9. Pretty canonical route `/events/:slug` vs current `event.html?slug=`?
10. Cutover timing relative to the auction launch (Highland Estate OAT is live; Stripe still TEST).

**Launch-timing recommendation.** The auction launch (OAT in progress) is the current priority and is **independent** of this Event system — do **not** couple them. Recommended sequencing: **after** the auction launch validates, run Increment 1 (BD exports) → ship Increments 2–5 (privacy, schedule, signed upload, bulk uploader) as the estate-sale MVP → then 6–10 (taxonomy, forms, public page, widget feed, migration/cutover). Because the existing Events foundation is already in production and additive, each increment can ship behind the moderation gate without risk to auctions. The single hard external dependency is the BD export (Increment 1); everything else is in-repo, additive, and reuses proven patterns.

---

*Prepared as a read-only audit + design. No production, BD, or database changes were made; no migrations authored; no implementation begun. Items marked **[EXPORT]** require BD-admin-internal data the read-only REST API cannot reach.*
