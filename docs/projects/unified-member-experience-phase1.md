# Advantage Unified Member Experience — Phase 1 Discovery & Plan

Goal: one cohesive, premium, role-aware Advantage command center across BD + `bid.advantage.bid`, buyers/
sellers/pros/admins — technical ownership may stay split, but the seam should be invisible. Nav:
🏠 Home · 🔨 Auctions · ❤️ Watchlist · 📦 Purchases · 🏪 Sellers · 📈 Sell · 📊 Analytics · 💬 Messages · ⚙️ Account.

This is planning + inventory only. No UI has been changed. Findings are from a read-only repo audit.

## 1. Current-state architecture map
- **Frontend:** static `public/*.html`, vanilla JS IIFEs, **no framework/build**. Each page inlines CSS.
  Shared JS in `public/widgets/shared/` — `buyer-nav.js` (canonical signed-in chrome), `auth-refresh.js`
  (sliding-session JWT), `config.js` (`AAPConfig` remote config), bid kit (`bid-status/bid-utils/
  bid-increment`), `admin-nav.js` (drives the 13 admin pages). No shared stylesheet; recurring tokens:
  bg `#f8fafc`, accent `#2563eb`, nav `#0f172a`, radius 12px, `-apple-system`.
- **Auth:** JWT in `localStorage['token']`, `Authorization: Bearer`. `GET /api/auth/me` →
  `{id, email, role, full_name, phone}`. Roles: **`buyer|seller|admin` only** (CHECK). Server-side authz
  is authoritative (`authMiddleware` → `roleMiddleware(['admin'])` → `requireSellerAgreement`); client
  gating is cosmetic. Org/tenant + capability layer exists but is **dormant** (one-org-per-user, caps not
  enforced) — do NOT build dashboard authz on it yet.
- **Backend:** Express + Postgres (`db.query`), Stripe **TEST**, migrations 001–095. Bridge (094/095) live.

## 2. Role / permission matrix (what actually drives access today)
| Signal | Source | Use |
|---|---|---|
| `users.role` = buyer/seller/admin | JWT `{id,role}` + `/api/auth/me` | Top-level surface branch |
| `seller_type` (private/business/other + admin-only pro types) | `/api/sellers/me` | Seller feature gating (pro fields, pickup rule, edit-lock business-bypass) |
| Seller agreement state | `/api/agreements/onboarding-status` + `requireSellerAgreement` | Seller dashboard gate / onboarding banner |
| `seller_profiles.capabilities` (JSONB) | admin-writable | Data path exists, **enforcement reads `seller_type`, not caps** |
| org/tenant role + capabilities | `resolveActingOrg`, `capabilityService` | Dormant; partner/Events only |
Composition rule for the shell: `role` → surface set; `seller_type`/agreement → seller gates/onboarding; admin → superset (server-guarded).

## 3. Platform capability matrix (buyer)
| Capability | API (existing) | Data | UI today | Reuse for command center |
|---|---|---|---|---|
| Identity | `GET/PATCH /api/auth/me` (self: full_name, phone) | users | account.html | Header identity + Account |
| Watchlist (+ auto-add on bid) | `GET /api/watchlist`, `POST /api/watchlist/{add,remove}` | `watchlists` | watchlist.html | ❤️ Watchlist (annotated lot state ready) |
| My bids (winning/outbid/watching) | `GET /api/lots/my-bids` | `lot_proxy_bids`+`lots` | my-bids.html | 🏠 Home cards + 🔨 Auctions "my bids" |
| Won lot check | `GET /api/lots/:id/winner-status` | lots | lot.html | Purchases status |
| Per-lot invoices | `GET /api/me/invoices`, `/api/invoices/:id/pdf` | `invoices` | dashboard.html | (consolidate → combined) |
| **Combined invoices (auction)** | `GET /api/invoices/mine/combined`, `/combined/:id/pdf` | `buyer_auction_invoices` | invoices.html | 📦 Purchases (primary money surface) |
| Pay | `POST /api/payments/charge-{lot,combined}`, setup-intent, card-on-file, card-summary | `payments`, `card_verifications` | payment/billing/add-card | Purchases pay-now + Account payment methods |
| Following sellers | `GET /api/sellers/following`, `POST/DELETE /:id/follow` | `seller_followers` | dashboard.html | 🏪 Sellers |
| Pickup (read-only advisory) | `GET /api/auctions/:id/summary` (address hidden pre-pay) | auctions | auction-view.html Pickup tab | 📦 Purchases pickup (limited) |
| Notification prefs | **none (unrouted service method)** | `notification_preferences` (2 schemas) | **none** | ⚙️ Account (greenfield build) |

## 4. Platform capability matrix (seller / admin) — condensed
- Seller: `GET /api/sellers/me`, `/me/dashboard` (agreement-gated: auctions+marketing+summary), `/me/audience`,
  `/me/audit`; auction lifecycle `POST /api/auctions` + `PATCH` (edit-lock, **business-type bypass**) + lots;
  onboarding `POST /api/sellers/enroll` (buyer→seller, **no approval queue**); settlements **read live**,
  **writes flag-gated OFF** (`SELLER_SETTLEMENTS_ENABLED`); payout profile (Stripe-ref, admin read-only).
  States: draft·submitted·under_review·published·active·closed·rejected (+ `is_archived` boolean; no cancelled).
- Admin: `role(['admin'])` everywhere; `admin-nav.js`; `admin.js` (~40 routes) + adminUsers/Buyers/Verification/
  Agreements/Settlements/Crm/Pickup/Marketplace/MarketplaceLinks/Partners/Events/LaunchReadiness. Read-only
  assemblers (`settlementReviewService`, `launch-readiness`) are ideal command-center tiles. **Never** surface
  admin controls on buyer/seller pages; **never** add an admin write path to seller banking.

## 5. BD capability matrix (integration-contract-bd.md)
| BD owns (presentation/identity) | Platform owns (authoritative) |
|---|---|
| Member accounts + profile, directory/SEO/city pages, lead capture, marketing funnel | Buyer/bidder + seller accounts, auctions/lots/bids, paddle numbers, **watchlist/favorites**, card verification, payments/invoices/refunds, soft-close, **notification prefs + delivery**, marketing/CRM |
BD API = **read-only REST** (`X-Api-Key`), no SSO, permission-scoped (event/category 403). BD is a
**disableable adapter** — core logic must never depend on BD tables/widgets. Bridge users: `users.email` =
`bd-<id>@bridge.invalid`, real email in `contact_email`, BD member id is the sole identity key.

## 6. Data ownership matrix (source of truth)
| Domain | Source of truth | Dashboard treatment |
|---|---|---|
| Auctions/lots/bids | **Platform** (canonical) | Live reads; never duplicate into BD |
| Watchlist, following, invoices, payments, pickups, notifications | **Platform** | Native |
| Marketplace org directory | Platform `organizations` (+ BD import mirror `source='bd_import'`) | Tenant-scoped by UUID (`linked_seller_profile_id`) |
| Member identity/profile (bridge users) | **BD** | Mirror `contact_email`/`full_name`/`phone`; link out to BD to edit |
| Membership plan, password (bridge users) | **BD** | Link out to BD; no platform edit |
| Messages | **N/A — none exists** | Read-only activity feed (see §10 fork) |

### Account field ownership (per-field decision)
| Field | Owner | Dashboard action |
|---|---|---|
| Name | BD (bridge) / Platform (native) | Editable for native via `PATCH /api/auth/me`; bridge → link out to BD |
| Email | BD (bridge, = identity key) | Read-only mirror (`contact_email`); **never editable on platform** for bridge; native editable is not currently supported (email immutable) |
| Phone | Platform | Editable `PATCH /api/auth/me` (drives SMS/seller) |
| Password | BD (bridge) / Platform (native) | Bridge → link out to BD; native → platform reset |
| Profile photo / plan | BD | Link out to BD |
| Notification prefs | Platform | Build GET/PUT (greenfield) |
| Payment methods | Platform | Manage on platform (Stripe card-on-file) |
| Seller payout profile | Platform | Manage on platform |
No casual two-way sync. For bridge users, BD stays the profile source; the platform mirrors + links out.

## 7. Proposed unified information architecture (role-aware)
- 🏠 **Home** — command center. Buyer: summary chips (Watching/Winning/Outbid/Payment Due/Pickup/Unread) +
  ending-soon + activity. Seller: active/draft/ending-today auctions, bids today, unpaid invoices, quick
  actions. Admin: approvals queue, live auctions, invoice/settlement issues, sync/email health, Stripe mode.
- 🔨 **Auctions** — browse (public feeds) + "auctions I've bid in" (my-bids) + (seller) my auctions by state.
- ❤️ **Watchlist** — `/api/watchlist` (already annotated).
- 📦 **Purchases** — combined invoices (primary), won lots, pay-now, receipts, pickup details + timeline.
- 🏪 **Sellers** — followed sellers + marketplace org profiles (tenant-scoped).
- 📈 **Sell** — non-seller: education + `enroll`; seller: create/manage/settlements/payout.
- 📊 **Analytics** — buyer (bids/watch/won/spend), seller (views/watchers/bids/sell-through/gross), admin
  (platform) — **only on real captured data; no fabricated stats**.
- 💬 **Messages** — v1 read-only activity feed from `notifications_queue` (see §10).
- ⚙️ **Account** — per §6 field ownership; BD-owned fields link out; platform fields editable.

## 8. What can ship immediately on existing APIs vs needs new work
**Immediate (existing APIs):** the shell + role-aware nav; buyer Home cards (my-bids, watchlist, combined
invoices "payment due", following); Watchlist; Purchases (combined invoices + PDF + pay-now); Sellers
(following + marketplace profiles); Sell (sellers/me + enroll + reuse seller dashboard data); Auctions browse
(public feeds). **Needs new (additive) APIs:** notification-preferences `GET/PUT` (wire the existing service
method + reconcile the two schemas); Messages feed `GET /api/me/notifications` (+ read-state); optional Home
aggregation endpoint; buyer analytics aggregate; richer buyer pickup endpoint. **Needs BD-side:** any
BD-owned field edit = deep link to BD; "Log Out Everywhere" only if BD offers a supported method (deferred).

## 9. Risk register
1. **Admin override is role-string-based & pervasive** — keep server guards authoritative; never render an
   admin write path on buyer/seller surfaces.
2. **Two invoice systems** (per-lot vs combined) — consolidate the buyer UI on **combined**; do not alter
   invoicing/payment logic.
3. **Notification-preferences: two schemas, no API/UI** — reconcile to one model before shipping settings.
4. **Duplicate seller dashboards** (`dashboard/seller.html` vs `seller-dashboard.html`) — pick one.
5. **Legacy `dashboard.html`** bypasses `buyer-nav.js`, logs out to dead `/demo.html` — retire/fold in.
6. **Settlements/combined-invoicing are flag-gated** — never surface disabled settlement actions as live.
7. **Dormant org/capability layer** — don't gate real behavior on unenforced capabilities.
8. **Bridge trust model** — never merge by email; never break the verified bridge; keep secret/JWT/code out
   of the browser.
9. **Public Language Standard** — no AI/vendor terms on any rendered dashboard surface; keep internal
   provenance names (`bd_import`, `ai_description`) internal.
10. **[Pre-existing, flag separately — privacy]** discovery found the **full street address is included in the
    UNPAID combined-invoice reminder email** (reveal not gated by payment verification), and the `<$1` card-
    verification rule is an unimplemented stub. Both are outside this initiative but should be fixed
    separately; the address item is a privacy concern.

## 10. Open product decisions (forks)
1. **💬 Messages architecture (needs your call).** No messaging exists. **Recommended v1:** a **read-only
   activity feed** over `notifications_queue` (outbid, payment reminders, new-auction-from-followed-seller,
   seller moderation outcomes) with unread badges — additive, no new subsystem, respects Public-Language. A
   true buyer↔seller **conversation system** is a large net-new build (tables, moderation, privacy review) and
   is a separate decision, deferred. *(Listed in your stop conditions — proceeding with the read-only feed
   only.)*
2. **Invoice consolidation** on the combined model (UI-only, non-destructive) — recommend yes.
3. **Legacy dashboard.html retirement** behind the new shell (parallel route first, retire after parity).

## 11. Visual direction
Premium command-center, not a Bootstrap admin theme and not BD's dated dashboard. Evolve the existing tokens
(`#0f172a`/`#2563eb`/`#f8fafc`, radius 12px) into a small **shared design-system stylesheet** (new — today
every page inlines CSS) + a reusable **member-shell** component (like `admin-nav.js` but richer: responsive
sidebar/topbar, mobile bottom-nav for buyers, identity+role header, notification badge, role-aware links,
logout). Cards + status chips + activity feeds + meaningful empty/loading/error states; tables only in
detailed management views; no horizontal overflow on core buyer pages.

## 12. Phased implementation plan (with acceptance criteria)
- **Phase 2 — Unified shell & nav.** New protected member route (parallel, e.g. `/home` or `/app`, behind a
  flag or as an additive page) with the role-aware member-shell + the 9 nav destinations (stubs OK),
  responsive desktop/mobile nav, identity/role header, loading/empty/error states. *Accept:* buyer/seller/
  admin each see the correct nav; native email/password login and all existing pages still work; mobile nav
  usable; no change to public auction pages.
- **Phase 3 — Buyer experience.** Home cards, Watchlist, Purchases (combined), Sellers, Auctions browse,
  Account (mirror + link-out) on existing APIs. *Accept:* buyer-only user sees accurate live data; no admin/
  seller controls leak; combined invoices pay-now works in TEST.
- **Phase 4 — Seller experience.** Seller command center reusing `/me/dashboard`; create/manage; settlement
  READ; payout profile. *Accept:* seller sees their auctions/metrics; edit-lock + business bypass respected
  server-side; disabled settlement writes not shown as live.
- **Phase 5 — Analytics + activity feed + notification settings.** New additive APIs on **real data only**;
  Messages read-only feed + read-state; reconciled notification-preferences GET/PUT. *Accept:* no fabricated
  stats; prefs persist; feed shows the user's real notifications.
- **Phase 6 — Admin integration.** Admin overview tiles from existing read-only assemblers, isolated from
  buyer/seller pages. *Accept:* admin-only data never reaches non-admins; server authz enforced.

Development rules: inspect before changing; reuse before rebuilding; additive + feature-flagged/parallel
route; add tests for new APIs + permission boundaries; test buyer-only/seller-only/both/admin/native/bridge/
logged-out/mobile; preserve auction/bidding/payment/pickup/settlement/notification behavior; no prod data
changes; don't delete old dashboard until the replacement is proven.
