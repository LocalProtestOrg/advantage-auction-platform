# Charlie-BD — Checkpoint Log

---

## checkpoint-bd-marketplace-seller-cta-v1 — 2026-05-11

**Commit:** 7d2e50b  **Tag:** `checkpoint-bd-marketplace-seller-cta-v1` (pushed)

**What was done:**
Built the marketplace seller acquisition CTA — a lightweight, config-driven seller
conversion strip for Advantage.Bid marketplace-owned auction experiences. Surfaces
after the lot grid on auction-view.html to convert buyers into seller leads.

**Files created/modified:**

| File | Status | Description |
|---|---|---|
| `public/widgets/shared/marketplace-seller-cta.js` | Created | AAPMarketplaceSellerCta v1 IIFE module |
| `public/auction-view.html` | Modified | Mount point, script tags, initSellerAcquisitionCta() |
| `e2e/charlie-bd-marketplace-seller-cta.spec.js` | Created | ~50 Playwright tests |

**Module architecture:**

| Feature | Implementation |
|---|---|
| Idempotency guard | `_v: 1` check prevents double-init across script re-includes |
| `enabled` flag | Config-driven (`marketplace.seller_cta.enabled`), default true; hard override via opts |
| `is_marketplace` flag | Config-driven (`marketplace.is_marketplace`), default true; hard override via opts; blocks render on white-label |
| Attribution URL | `URL` constructor appends `?source=marketplace_cta&auction_id=<id>` |
| CSS injection | `.msc-*` scoped classes, injected once via `STYLE_ID` guard; 600px mobile breakpoint |
| Click telemetry | `AAPAnalytics.track('seller_cta_click', meta, ctx)` with `cta_variant`, `destination`, `widget_name`, `auction_id` |
| Impression telemetry | `IntersectionObserver` at 25% threshold fires `seller_cta_impression` once then disconnects |
| XSS safety | All copy strings passed through `esc()` before innerHTML assignment |
| Graceful degradation | Swallows all telemetry errors; skips IntersectionObserver if unavailable |

**Test coverage (e2e/charlie-bd-marketplace-seller-cta.spec.js):**

| Describe group | Tests |
|---|---|
| Module load | 3 |
| Rendering | 7 |
| Link behavior | 5 |
| Conditional rendering | 4 |
| Telemetry | 2 |
| Page integration safety | 6 |
| Mobile layout | 2 |
| **Total** | **~29** |

**Integration in auction-view.html:**
- Mount point: `<div id="marketplace-seller-cta-mount">` placed after `.grid-wrap`
- Load order: `analytics.js` → `marketplace-seller-cta.js` → existing scripts
- Init call: `initSellerAcquisitionCta()` wired into the `else` branch of the page auth guard (same path as `loadAuction()`)

**What does NOT change:**
No routes, services, migrations, server.js changes, bidding/payment/auth logic.
All work is additive presentation layer only.

**What's next:**
Charlie-BD is IDLE. See `current-work.md` for candidate next assignments.

---

## Inherited Context (from Bravo-Discovery)

The following assets were created by Bravo-Discovery and are now Charlie-BD's to maintain:

**checkpoint-discovery-phase2-v1 (f9f65c1)** — 2026-05-11
- `public/widgets/featured-auctions.js` created — self-contained widget, zero deps, geolocation opt-in, dark/light theme, XSS-safe
- `public/widgets/featured-auctions.html` created — embed demo page with configuration reference
- `GET /api/public/featured-auctions` is the primary endpoint this widget calls

**checkpoint-public-discovery-v1 (6ccf223)** — 2026-05-11
- `docs/bd-integration-architecture.md` created — planning doc covering API contract, security model, widget modularity, SEO strategy

---

## checkpoint-bd-marketplace-config-v1 — 2026-05-11

*(Commit hash: pending — tag after git commit)*

**What was done:**
Built the first marketplace configuration infrastructure layer — five phases covering
DB schema, admin/public APIs, AAPConfig remote consumption, an admin demo UI, and
full Playwright spec coverage.

**Files created/modified:**

| File | Status | Description |
|---|---|---|
| `db/migrations/041_create_platform_settings.sql` | Created | Key/value store for all marketplace-facing config; 18 seeded defaults |
| `db/migrations/042_create_widget_settings.sql` | Created | Per-widget config overrides; seeded with featured-lots and featured-near-you |
| `db/migrations/043_create_marketing_packages.sql` | Created | Marketing package pricing tiers; 3 seeded tiers (Free / $99 / $249) |
| `src/routes/adminConfig.js` | Created | `/api/admin/config/*` — role-gated CRUD for all three tables; explicit key allowlists |
| `src/routes/admin.js` | Edited | Mounts adminConfig router at `/config` sub-path |
| `src/routes/public.js` | Edited | Adds `GET /api/public/config` and `GET /api/public/config/widgets/:slug` |
| `public/widgets/shared/config.js` | Extended | v2: cache TTL, local override preservation, namespace guard, invalidateCache(), dumpOverrides() |
| `public/admin/marketplace-config.html` | Created | Three-tab admin config UI: Platform Settings / Widget Defaults / Packages |
| `e2e/charlie-bd-marketplace-config.spec.js` | Created | ~75 tests across 13 describe groups |

**API endpoints created:**

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/admin/config/platform` | admin | Read all allowlisted platform settings with metadata |
| `PATCH /api/admin/config/platform` | admin | Upsert marketplace config values (allowlist-enforced) |
| `GET /api/admin/config/widgets` | admin | Read all widget setting records |
| `PATCH /api/admin/config/widgets/:slug` | admin | Merge widget.* settings for a slug |
| `GET /api/admin/config/packages` | admin | Read all marketing packages (active + archived) |
| `POST /api/admin/config/packages` | admin | Create a new package |
| `PATCH /api/admin/config/packages/:id` | admin | Partial update a package |
| `GET /api/public/config` | none | Safe public subset of platform settings (no pricing/ranking) |
| `GET /api/public/config/widgets/:slug` | none | Public widget defaults for a given slug |

**Key allowlist architecture:**

Two distinct allowlists in `adminConfig.js`:
- `PLATFORM_KEY_ALLOWLIST` — 18 keys admin can read/write (includes ranking weights)
- `PUBLIC_KEY_ALLOWLIST` — 16-key subset surfaced at `/api/public/config` (no ranking/pricing)

Non-allowlisted keys (including `stripe.*`, `internal.*`, `payment.*`) are silently dropped
on PATCH and never appear on GET. This is enforced at the route layer, not the DB layer.

**AAPConfig v2 changes:**

| Capability | Implementation |
|---|---|
| Local override preservation | `_localOverrides` map tracked separately from `_store`; `set()` writes to both; `loadRemote()` skips keys in `_localOverrides` |
| Cache TTL | localStorage cache with `aap_cfg_remote` / `aap_cfg_remote_ts` keys; default TTL 300s; configurable per `loadRemote()` call |
| Bypass cache | `{ bypassCache: true }` option forces fresh fetch |
| Cache invalidation | `invalidateCache()` clears localStorage entries |
| Namespace guard | Only `marketplace.*`, `widget.*`, `analytics.*` prefixes are merged from remote |
| Response envelope | Handles both `{ success, data }` and flat object remote responses |
| Debug | `dumpOverrides()` returns only explicitly set keys |
| Idempotency | `_v: 2` sentinel (bumped from 1; existing pages reload without re-init) |

**Test coverage (e2e/charlie-bd-marketplace-config.spec.js):**

| Describe group | Tests |
|---|---|
| Role enforcement | 6 |
| GET /api/admin/config/platform | 4 |
| PATCH /api/admin/config/platform | 4 |
| Widget settings API | 4 |
| Marketing packages API | 7 |
| GET /api/public/config | 5 |
| GET /api/public/config/widgets/:slug | 4 |
| AAPConfig.loadRemote() — basic loading | 3 |
| AAPConfig.loadRemote() — local override preservation | 3 |
| AAPConfig.loadRemote() — graceful fallback | 4 |
| AAPConfig.loadRemote() — cache TTL | 3 |
| Admin demo page | 7 |
| Security | 3 |
| Accessibility | 6 |
| Mobile rendering | 1 |
| Multi-widget coexistence | 2 |
| **Total** | **~76** |

**Widget behavior validated:**
- [x] No Stripe/payment/internal variables in any public response
- [x] Admin-only keys (ranking weights) absent from public config
- [x] PATCH rejects non-allowlisted key combinations with 400
- [x] Config update via PATCH reflected in subsequent GET /api/public/config
- [x] loadRemote() preserves local overrides from set()
- [x] loadRemote() namespace guard blocks injection of non-safe keys
- [x] Cache TTL: second call within TTL uses cache (only 1 network request)
- [x] bypassCache: true forces fresh fetch
- [x] invalidateCache() clears localStorage and forces re-fetch
- [x] Graceful fallback: 404, network abort, invalid JSON all resolve without throwing
- [x] XSS safety: malicious value in config does not execute in admin page
- [x] Admin demo page: three-tab layout, form populated from API, modal for packages
- [x] All form inputs have associated labels (a11y)
- [x] Mobile 375px viewport renders without layout overflow

**No modifications to payment, bidding, or Stripe logic.** All work is additive.
Stripe remains intentionally in sandbox mode.

**What's next:**
Charlie-BD is IDLE. See `current-work.md` for candidate next assignments.

---

## checkpoint-bd-featured-lots-v1 — 2026-05-11

*(Commit hash: pending — tag after git commit)*

**What was done:**
Built a configuration-first widget ecosystem in three phases:
- **Phase A** — Six shared UI components under `public/widgets/shared/components/`
- **Phase B** — `window.AAPConfig` shared configuration singleton
- **Phase C** — `featured-lots.js` widget, demo page, and full Playwright spec

**Files created:**

| File | Description |
|---|---|
| `public/widgets/shared/config.js` | `window.AAPConfig` singleton — `get/set/reset/dump/loadRemote`; reads inline `<script id="aap-config" type="application/json">` on init; 20+ typed marketplace defaults |
| `public/widgets/shared/components/badge.js` | `AAPComponents.Badge` + shared `aapc-root-styles` CSS custom properties for theming; variants: live, upcoming, ships, ending-soon, custom |
| `public/widgets/shared/components/skeleton-card.js` | `AAPComponents.SkeletonCard` — animated pulse loading placeholder |
| `public/widgets/shared/components/empty-state.js` | `AAPComponents.EmptyState` — `role="status"` message element |
| `public/widgets/shared/components/error-state.js` | `AAPComponents.ErrorState` — `role="alert"` error element |
| `public/widgets/shared/components/seller-cta.js` | `AAPComponents.SellerCta` — fully config-driven CTA card; all copy + URL from `AAPConfig` |
| `public/widgets/shared/components/auction-card.js` | `AAPComponents.AuctionCard` — unified card for auction and lot data; config-driven image height, seller visibility, bid display, lot count, distance |
| `public/widgets/featured-lots.js` | Main widget — lot-level featured feed with skeleton loading, config-first data-* + AAPConfig + hardcoded fallback priority chain, inline component fallbacks for standalone embed |
| `public/widgets/demo-featured-lots.html` | Demo page — live preview, 4 embed code snippets (simple / full / inline config / multi-widget), analytics example, full config reference tables |
| `e2e/charlie-bd-featured-lots.spec.js` | ~65 Playwright tests across 13 describe groups |

**API endpoints consumed:**
- `GET /api/public/featured-lots?limit=N[&auction_state=X]`

**Configuration architecture:**

Priority chain for all business variables: `data-* attribute → AAPConfig.get() → hardcoded fallback`

AAPConfig DEFAULTS (all marketplace-facing, none hardcoded in widget):
```
widget.limit, widget.radius_km, widget.geo_timeout_ms
marketplace.badge.live, .upcoming, .ships, .ending_soon, .ending_soon_threshold_min
marketplace.cta.url, .headline, .subtext, .label
marketplace.card.image_height_px, .show_seller, .show_lot_count, .show_bid, .show_distance
marketplace.shipping.show_badge
analytics.enabled, analytics.namespace
```

**Component capabilities delivered:**

| Component | Key feature |
|---|---|
| `Badge` | CSS custom property theming via `.aapc-root` / `.aapc-dark` on grid ancestor; idempotent style injection |
| `SkeletonCard` | `@keyframes aapc-pulse` animation; configurable line count |
| `EmptyState` | Shares `aapc-state-styles` ID with ErrorState to prevent duplicate injection |
| `ErrorState` | `role="alert"` for screen reader announcement |
| `SellerCta` | URL + copy fully from config; `target="_blank" rel="noopener noreferrer"` |
| `AuctionCard` | Caller-supplied `badges` array overrides auto badge generation; Ending Soon badge calculated in caller from `closes_at`; `fmtCents()` for bid display; keyboard accessible (tabindex=0, Enter/Space) |

**Inline fallback pattern:**
`featured-lots.js` carries complete inline implementations of card renderer, CTA, and pulse CSS.
Works as a single `<script>` embed. Shared layer optional; recommended for multi-widget pages.

**Test coverage (e2e/charlie-bd-featured-lots.spec.js):**

| Describe group | Tests |
|---|---|
| Demo page | 2 |
| Phase B — AAPConfig layer | 8 |
| Phase A — Component static assets | 5 |
| Phase A — AuctionCard functional | 6 |
| Phase C — Loading state | 2 |
| Phase C — Lot card rendering | 14 |
| Phase C — Seller CTA card | 5 |
| Phase C — Empty / error states | 3 |
| Security (XSS + auth) | 5 |
| Analytics events | 4 |
| Accessibility | 6 |
| Mobile rendering | 2 |
| Multi-widget coexistence | 3 |
| **Total** | **~65** |

**Widget behavior validated:**
- [x] Loads correctly on embed demo page (full shared layer)
- [x] Loads correctly as standalone single-script embed (inline fallbacks)
- [x] Skeleton loading state renders during fetch
- [x] Empty state renders when API returns zero lots
- [x] Error state renders on network failure / HTTP 500
- [x] No auth tokens used — all `/api/public/*` calls only
- [x] XSS-safe — script injection, onerror injection, src injection tested
- [x] AAPConfig: set/get/reset/dump/inline-block all tested
- [x] Config priority chain: data-* > AAPConfig > hardcoded fallback
- [x] Ending Soon badge fires within threshold, suppressed outside threshold
- [x] Seller CTA: shown when configured, hidden when URL absent
- [x] Analytics events fire on load, card click, CTA click
- [x] Mobile viewport (375px) renders single column
- [x] Multiple widget instances coexist without style collision
- [x] Dark theme via CSS custom properties (no style re-injection)

**No modifications to existing files.** All work is additive.

**What's next:**
Charlie-BD is IDLE. See `current-work.md` for candidate next assignments.

---

## checkpoint-bd-featured-near-you-v1 — 2026-05-11

*(Commit hash: pending — tag after git commit)*

**What was done:**
Built the "Featured Auctions Near You" widget system, the shared utility layer, and
full Playwright spec coverage. This is Charlie-BD's first standalone work cycle.

**Files created:**

| File | Description |
|---|---|
| `public/widgets/shared/utils.js` | `window.AAPWidgetUtils` shared utility namespace — XSS escaping, date/distance formatting, geolocation promise, style injection, event dispatch |
| `public/widgets/featured-near-you.js` | Main widget — geo-aware featured auction feed with skeleton loading, multi-source fallback strategy, seller CTA card, analytics events, CSS custom property theming |
| `public/widgets/demo-featured-near-you.html` | Demo page — live widget preview, 4 embed code snippets, analytics integration example, configuration reference table |
| `e2e/charlie-bd-featured-near-you.spec.js` | 38 Playwright tests across 9 describe groups |

**API endpoints consumed:**
- `GET /api/public/featured-auctions` — primary feed (geo-filtered or national)
- `GET /api/public/auctions/near` — secondary fallback when featured returns 0 near-me results

**Widget capabilities delivered:**

| Capability | Implementation |
|---|---|
| Auto geolocation | `navigator.geolocation.getCurrentPosition` with configurable timeout |
| Graceful fallback | Geo-denied → national feed; zero featured results → `/auctions/near` |
| Configurable radius | `data-radius-km` attribute, clamped 1–800 km |
| Shipping badges | "Ships nationwide" badge when `shippable_lot_count > 0` |
| Featured marketplace ranking | Uses `/featured-auctions` which orders by `marketplace_priority` |
| Distance labels | Formatted via `fmtDistance()` when `distance_km` present |
| Loading state | Animated skeleton cards while fetch is pending |
| Empty state | Clear message when all data sources return 0 results |
| Error state | User-facing error message on network failure |
| Responsive cards | CSS `auto-fill minmax(280px, 1fr)`; single column at ≤480px via media query |
| Seller CTA card | Dashed-border card at end of grid; configurable via `data-seller-cta-*`; hidden by default |
| Analytics hooks | 4 `CustomEvent`s bubble from container: `aap:widget:loaded`, `aap:widget:fallback`, `aap:auction:click`, `aap:cta:click` |
| XSS safety | `esc()` on every API-sourced string inserted via `innerHTML` |
| Geolocation fallback | Handles codes 1 (denied), 2 (unavailable), 3 (timeout) |
| CSS custom property theming | Dark/light via CSS class on grid — supports multiple instances per page |
| Keyboard accessible | `tabindex=0`, Enter/Space activates card click |
| ARIA labels | `aria-label` on cards, grid, CTA card; `aria-busy` on loading grid |

**Shared utility layer:**
`window.AAPWidgetUtils` provides: `esc`, `fmtDate`, `fmtRelativeTime`, `fmtDistance`,
`clamp`, `parseIntSafe`, `parseFloatSafe`, `getGeoPosition`, `injectStyle`, `dispatch`.
Idempotent — second load is a no-op. Each widget carries inline fallbacks so
`shared/utils.js` is optional (recommended when embedding multiple widgets per page).

**Test coverage (e2e/charlie-bd-featured-near-you.spec.js):**

| Describe group | Tests |
|---|---|
| Demo page | 3 |
| Loading skeleton | 2 |
| Card rendering | 11 |
| Seller CTA card | 4 |
| Empty state | 2 |
| Error state | 2 |
| Geolocation denial fallback | 4 |
| Geo near-me fallback | 2 |
| Security | 5 |
| Analytics events | 3 |
| Mobile rendering | 3 |
| Accessibility | 4 |
| Shared utils | 4 |
| **Total** | **49** |

**Widget behavior validated:**
- [x] Loads correctly on embed demo page
- [x] Skeleton loading state renders during fetch
- [x] Empty state renders correctly (national feed + near both return 0)
- [x] API error state renders correctly (network abort / HTTP 500)
- [x] No auth tokens used — verified via request header inspection
- [x] XSS-safe — script injection, onerror injection, src injection all tested
- [x] Only /api/public/* endpoints called — no internal route violations
- [x] Geolocation denial gracefully falls back to national feed
- [x] Geo + empty featured → falls back to /auctions/near
- [x] Mobile viewport (375px) renders single column
- [x] Keyboard navigable (tabindex=0, Enter/Space)
- [x] Analytics events fire on load, fallback, card click, CTA click
- [x] Seller CTA card: shown when configured, hidden by default
- [x] shared/utils.js and featured-near-you.js both accessible as static files

**No modifications to existing files.** All work is additive.

**What's next:**
Charlie-BD is IDLE. See `current-work.md` for candidate next assignments.

---

## Checkpoint Template

```
## checkpoint-bd-[name]-v1 ([commit hash]) — YYYY-MM-DD

**What was done:**
[Description]

**Files created/modified:**
- public/widgets/[name].js
- public/widgets/demo-[name].html

**API endpoints consumed:**
- GET /api/public/[endpoint]

**Tests:** N/N [spec file] PASS; N total suite passing; N pre-existing failures

**Widget behavior validated:**
- [ ] Loads correctly on embed demo page
- [ ] Empty state renders correctly
- [ ] API error state renders correctly
- [ ] No auth tokens used
- [ ] XSS-safe
- [ ] Mobile rendering verified

**What's next:**
[Next candidate widget or task]
```
