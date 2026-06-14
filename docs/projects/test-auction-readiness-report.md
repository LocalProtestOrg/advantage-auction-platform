# Test Auction Readiness Report — Launch Program (Phases 1–4)

**Branch:** `fix/stabilization-sprint-1` (pushed to `origin`). **Stripe: TEST.**
**Production: untouched** (`main@2a13738`, `started_at 2026-06-12T21:45:01`). No
merge/PR/prod-deploy/DNS change. Buyer Terms v2 not activated.

## 1. What was implemented (this program)
| Phase | Commit | Summary |
|---|---|---|
| 1 — Domain cutover | `ef954e5` | Multi-origin CORS/socket allowlist + decoupled email link base (`publicUrls.js`); buyer cutover is env/DNS-only. |
| 2 — Buyer discovery/search | `416d42d` | `GET /api/public/lots/search`, `/categories`; auction `q` now matches subtitle + **seller name**; trigram + filter indexes (066); `/discovery` audit-logged; `search.html` (text/category/location filters, Lots/Auctions, geolocation Near-me). |
| 3 — Admin buyer management | `540c8cb` | `/api/admin/buyers` (search/profile/suspend/reactivate/revoke/reinstate), audit-logged, **card_on_file boolean only**; `admin/buyers.html`. |
| 4 — Admin auction control | `02ed88c` | Admin-only editable fields (auction_terms, public_auction_type, admin_notes, **bid_increment_cents override**, buyer_premium_bps infra); closed-state guard; seller reassignment; featuring UI; migration 067. |

Prior validated stabilization sprint (preserved, staging-green): My Bids, Watchlist,
buyer nav, bid chime, real-time updates, Winning/Outbid, email enrichment+staleness,
increment ladder, session renewal, registration flow.

## 2. What remains
- **Production promotion** (gated on GO): backup → merge `fix/stabilization-sprint-1 → deploy/seller-studio-1b → main` (FF) → apply **065, 066, 067** via the per-file prod-guarded scripts (NEVER `run-migrations.js`; never 008) → deploy prod → validate.
- **bid.advantage.bid cutover** (config): Railway custom domain + DNS CNAME + set prod `FRONTEND_URL`/`PUBLIC_BASE_URL`, then validate.
- **Buyer-premium CHARGING** (infra ready at 0/unset; gated on Stripe LIVE + Terms v2).
- **Sales tax + exemption** (unbuilt) — Stripe-LIVE blocker (attorney/CPA).
- Minor follow-ups: admin lot-level `is_featured` endpoint; geocoding to populate `lat/lng` for radius; SEO canonicals; `admin.advantage.bid`.

## 3. Public-launch readiness (Stripe TEST)
**Ready, pending promotion + domain config.** All buyer-facing flows (discovery,
search, registration, bidding/max, real-time, Winning/Outbid, My Bids, Watchlist,
emails) and the admin buyer + auction controls are implemented and **staging-validated**.
Gates for public launch: (a) promote the branch to prod (Stripe TEST), (b) configure
`bid.advantage.bid`, (c) pass a final prod TEST auction. Admin auction editing is
sufficient; remaining admin items are non-blocking.

## 4. Stripe LIVE blockers (hard stops)
1. **Sales-tax collection + exemption flow** (unbuilt) — compliance/attorney/CPA gate.
2. **Buyer-premium charging** wired into charge/invoice/live-display **if** a premium will be charged (infra exists; not activated).
3. **Buyer Terms v2** money clauses (premium, auto-charge, payment timing, tax) drafted (attorney) + activated, aligned with the LIVE cutover.
4. Stripe **LIVE keys + LIVE webhook endpoint** configured.
5. Final production **TEST-mode** auction passed.

## 5. Recommended next test-auction plan
1. **Promote to prod (Stripe TEST)** — Neon backup; FF merge; `node scripts/prod-migrate-065.js` → `066` → `067` (each RESULT: PASS); deploy prod from `main`; confirm health.
2. **Configure `bid.advantage.bid`** — Railway custom domain + DNS CNAME + `FRONTEND_URL=https://bid.advantage.bid` + `PUBLIC_BASE_URL`; validate (app loads, socket.io connects, emails link to it, no Railway buyer URLs).
3. **Two-buyer prod TEST auction** (reuse the prod-test-auction harness) covering: registration (continuous, no dead-end), bidding + max bid, **price-banded increments**, real-time no-refresh updates, Winning/Outbid + Increase-Your-Max-Bid, anti-snipe + staggered close + results mode, instant + non-stale emails (Lot#/title/image/link), My Bids, Watchlist, search/discovery (`/search.html`), admin buyer controls (`/admin/buyers.html`), admin auction controls + featuring (`/admin/moderation.html`), bid chime, mobile.
4. **STOP before Stripe LIVE** — do not enable LIVE until §4 blockers clear.

## Reference
- **Buyer URLs:** `/search.html`, `/my-bids.html`, `/watchlist.html`, `/account.html`, `/auction-view.html`, `/lot.html`, `/buyer-terms.html`, `/add-card.html`.
- **Public API:** `/api/public/lots/search`, `/api/public/categories`, `/api/public/auctions[?q=]`, `/api/public/auctions/near`.
- **Admin paths:** `/admin/moderation.html` (auctions + featuring + reassign), `/admin/buyers.html` (buyer mgmt). APIs: `/api/admin/buyers*`, `/api/admin/auctions/:id` (PATCH), `/api/admin/auctions/:id/seller`, `/api/admin/auctions/:id/discovery`.
- **Staging base:** `https://advantage-staging-production.up.railway.app` (running the branch). **Target buyer domain:** `https://bid.advantage.bid` (not yet configured).

## Validation results (all green)
- Unit/integration suite: **181/181** (20 suites).
- Live staging: stabilization 14/14 + browser 9/9; Phase 1 multi-origin CORS (allowed echoed, disallowed rejected); Phase 2 **8/8**; Phase 3 **13/13**; Phase 4 **11/11**.
- Migrations 065/066/067 applied to **staging only**; prod has 058–064; prod unchanged throughout.

## Deployment status
- **Staging:** running `fix/stabilization-sprint-1` (Phases 1–4) via `railway up` (temporary override of its auto-deploy branch).
- **Production:** unchanged (`main@2a13738`). Not promoted. Awaiting explicit GO.
