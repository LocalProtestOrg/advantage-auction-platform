# Phase 4C — Unified Business Administration & Marketplace Plan

> **Status:** Plan for Product Owner review. **No feature implementation beyond the already-prototyped member-shell item (uncommitted, undeployed).** Do not build Phases 2–4 until this plan is approved.
> **Product framing:** one Advantage.Bid product, two workspaces — **Business Administration** (served by BD) and **Marketplace** (served by the app at `https://bid.advantage.bid/app.html#home`). Customer-facing copy never says "Brilliant Directories", "Railway", "bridge", "provisioning", or "organization capability".

> **SCOPE LOCK (PO, 2026-08-05).** Professional business-membership administration **stays in BD for launch**. BD owns: recurring membership billing, payment methods, overdue invoices, renewals/upgrades/cancellations, plan status, the **editable company directory listing**, company logo/cover/contact/about, leads, profile statistics, listing verification. **Railway does NOT** rebuild, duplicate, migrate, or manage any of these, and creates **no** Railway recurring subscription for professional businesses. Railway owns only the **marketplace + event experience** (auctions, estate-sale events, My Events, Create Event, lots, seller activity, messages, analytics, buying/bidding/watchlist/purchases). Railway keeps an **internal organization record** solely for event ownership, permissions, org membership, staff access, and seller attribution — it is **not** a customer-facing company-profile editor and does **not** replace the BD listing. Where Railway needs company info for attribution/display, it uses linked/synced BD data. **BD remains the editable source of truth for the professional company listing.**
>
> **Terminology (customer-facing).** Business Administration = Membership · Billing · Directory Listing · Company Account. Open Marketplace = Auctions · Estate Sales · Events · Lots · Seller Activity · Bidding/Buying. Do **not** use wording implying professional billing or directory-listing management happens in Railway. Replace "Professional Profile" / "Company Profile Management" / "Business Account Administration" (in Railway) with **Seller Workspace · Marketplace Organization · Event Management · Seller Identity · Marketplace Activity**.
>
> **⚠️ Pre-existing conflict to resolve (§7a).** The shipped `/org/profile.html` ("Professional Profile") editor and public `/pro.html` view now **duplicate BD listing management** and violate the lock. They need a PO decision (retire vs. restrict to internal *Seller Identity* fields) — not silently removed here.

---

## 0. What already exists (prototyped last turn — not deployed)
- `GET /api/auth/me` returns a server-authoritative `bd_member` boolean (derived from a `brilliant_directories` external identity) and, for BD members only, `business_admin_url`.
- The unified member shell (`/app.html`) shows a **"Business Administration"** nav item (rail + mobile bottom nav) for BD members, pointing at `BD_MEMBER_ADMIN_URL` (env; default `https://www.advantage.bid/account`).
- Tests + full jest suite green. **This covers only the dashboard surface.** The global placement, BD-side CTA, visual alignment, and notification states below are NOT built.

This plan treats that as the reference implementation for §6 and extends it.

---

## 1. Current BD dashboard inventory by plan
> The exact per-plan module enablement lives in **BD Admin → Member Levels → Dashboard/Menu settings** and cannot be read from this repo. The set below is BD's standard professional-member dashboard module catalogue (matches the Product Owner's list); the per-plan columns are the **proposed** baseline to confirm against BD Admin.

| Native BD module | Bronze | Silver | Gold | Claim Listing | Legacy pro | Appraiser |
|---|---|---|---|---|---|---|
| Membership Plan Name | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sign-ups & Upgrades | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Profile Page link | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Contact Details | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Additional Listing Details | ✓ | ✓ | ✓ | partial | ✓ | ✓ |
| About / Company Info | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Profile / Logo / Cover Photo | ✓ | ✓ | ✓ | limited | ✓ | ✓ |
| Profile Completeness (bar + checklist) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage Listing quick links | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Account Details snapshot | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Embeddable Member Badge | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| QR Code | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Recent Transactions | ✓ | ✓ | ✓ | — (free) | ✓ | ✓ |
| Manage Billing | ✓ | ✓ | ✓ | — (free) | ✓ | ✓ |
| Manage Leads | maybe | ✓ | ✓ | — | ✓ | ✓ |
| Profile Statistics | ✓ | ✓ | ✓ | limited | ✓ | ✓ |
| Verify Listing | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**Action:** export the live per-level dashboard config from BD Admin to replace the "proposed" columns before Phase 3.

## 2. Recommended BD dashboard configuration by plan
- **Preserve all native business-administration modules** (billing, profile, leads, transactions, verification, badge/QR, completeness). These are BD's strengths; do not rebuild them in the Marketplace.
- **Add** a top-of-dashboard **"Open Marketplace"** card (all plans, §5).
- **Reorder** into three groups: (1) *Open Marketplace* card, (2) *Membership & Billing*, (3) *Company Profile & Listing*.
- **Hide only** modules that are clearly irrelevant/redundant for a given level (e.g., Leads/Transactions/Billing on free **Claim Listing**; Badge/QR where a level doesn't grant a public listing). Never hide billing/renewal for paid levels.
- **Appraiser:** keep the appraiser-specific profile/verification; this level is directory-only and must NOT surface seller/event tools (see §12).
- **Rename** (where BD allows menu/label overrides) to the approved lexicon: "Membership & Billing", "Company Profile", "Marketplace Activity".

## 3. Native features to preserve (do not remove)
Membership plan name, sign-ups/upgrades, profile editing, contact/listing details, about, photo/logo/cover upload, completeness bar+checklist, manage-listing quick links, account snapshot, member badge, QR code, recent transactions, manage billing, manage leads, profile statistics, verify listing. **All remain in Business Administration.**

## 4. Proposed visual alignment (BD → resemble the Marketplace shell)
Achieve via **BD custom dashboard header/footer widgets + Custom CSS + menu config only** — no invasive template replacement (upgrade-safe).
- **Tokens to mirror** from `advantage-ds.css`: canvas/surface/ink colors, card radius & shadow, 12–16px spacing scale, button hierarchy (primary/ghost), header treatment, sidebar treatment, empty-state tone, system-ui typography, emoji/icon style.
- **Header widget:** an Advantage.Bid bar with the same brand mark + a workspace label "Business Administration" + the Open Marketplace action.
- **Constraint:** style, don't fork. Overriding BD core templates is fragile and breaks on BD updates; prefer Custom CSS Head + widget slots.

## 5. Open Marketplace implementation (BD side — manual BD action, not in this repo)
- **Placement:** prominent primary action in the BD dashboard **header widget** AND the **first dashboard card**; visible desktop + mobile.
- **Label:** "Open Marketplace". Never a platform name.
- **Destination / correctness:** route through the **authentication bridge launcher**, not a bare app URL. Point at the member-only BD bridge page (`/account/enter-auctions`, which runs the `ADVANTAGE_BRIDGE` widget with dest key `dashboard`) → lands authenticated at `app.html#home`. A plain `https://bid.advantage.bid/app.html#home` link works **only** if a Railway session cookie already exists; without it the member bounces through login. The bridge launcher always mints/refreshes the session → no login prompt.
- **Effective landing:** `app.html#home`.

## 6. Business Administration implementation (Railway side — this repo)
- **Entitlement to show:** `bd_member === true` (has a BD external identity). Independent of seller/event provisioning — every BD member may return to Business Administration even before §12 provisioning.
- **Destination:** `BD_MEMBER_ADMIN_URL` — a **native BD member page**. **Must not** be BD's `default_account_home_url` (`enter-auctions`), which is the bridge INTO the app → would loop. Confirm the exact loop-free BD member slug with BD admin.
- **Return session:** relies on the member's existing BD session (same registrable domain). If the BD session has expired, BD shows its own login — acceptable and expected; we never deep-link past BD auth.

## 7. Global Railway placement map (the key expansion over the prototype)
"Business Administration" must be reachable from **every** authenticated surface, not just dashboard home. Two shared components cover ~all of them:

| Surface | Component | Change |
|---|---|---|
| Unified dashboard (rail + mobile bottom nav) | `member-shell.js` + `member-nav-config.js` | **done (prototype)** |
| Auction pages, lot pages, search, watchlist, my-bids, invoices, billing, categories, ~24 pages | **`buyer-nav.js`** (shared sticky header) → **account/avatar menu (profile pop)** | add "Business Administration" item for BD members (fetch `bd_member` from `/me`) |
| Desktop authenticated header | `buyer-nav.js` account menu | same insertion |
| Mobile navigation | `buyer-nav.js` hamburger mega-menu + `member-shell` bottom nav | add item |
| Org/event workspace | `public/org/portal.js` header | add "Business Administration" tab/link |
| Event detail (`event.html`) | its own header/footer | add link (BD members only) |
| Professional profile editor (`/org/profile.html`) | org portal chrome | inherits portal.js change |

**Single source of truth for visibility:** the `bd_member` flag + `business_admin_url` from `/api/auth/me`; each shared component reads it once and renders conditionally. The account/avatar menu is the highest-leverage insertion (covers the 24 buyer-nav pages at once).

## 8. Mobile behavior
- Shell: item is `primaryMobile` → mobile bottom nav (rail is hidden ≤860px). Bottom nav uses `grid-auto-columns:1fr` (no overflow).
- buyer-nav: item appears in the mobile hamburger mega-menu and the account pop (both render on mobile).
- Touch target ≥44px; label always visible (no icon-only).

## 9. Authentication behavior
- **Marketplace → Business Administration:** plain link to the native BD member page; BD's own session authenticates. Expired BD session → BD login (expected).
- **Business Administration → Marketplace:** bridge launcher (§5) → mints/refreshes the Railway session cookie → `app.html#home`. No second login.
- **Non-professional (native) user:** never sees "Business Administration" (no `bd_member`).
- **No redirect loops:** return URL is a native BD page, never `enter-auctions`.
- **Failure/degrade:** if `/me` fails or `business_admin_url` is null, the item simply doesn't render (fail-closed, no broken link).

## 10. Notification integration feasibility (audit result)
1. **Existing Railway notification/count API:** none. The shell bell is a placeholder ("Wires to your notifications in Phase 5"). Underlying signals exist implicitly (outbid, invoice-due, event moderation state, follows) but there is **no unified unread-count endpoint**.
2. **BD data safely readable from Railway:** BD read-only REST API (`www.advantage.bid/api/v2`, `X-Api-Key`) exposes user + leads; event/category are 403. Billing/invoice status is not confirmed available — must verify.
3. **Railway data safely readable from a BD widget:** yes, via a **server-to-server**, key-authed, member-scoped summary endpoint (never a raw private API in browser JS).
4. **Trusted member identifier:** yes — the bridge's `external_identities` link (BD member id ↔ Railway user) is the join key.
5. **Server-to-server required:** yes, both directions, to avoid exposing private APIs or leaking cross-system detail.
6. **AuthZ:** each summary endpoint authenticates the caller (bridge secret / API key) and scopes strictly to the one member.
7. **Stale status:** short TTL (30–60s) cache + `stale-while-revalidate`; show last-known with a timestamp.
8. **Caching:** yes — per-member count, short TTL.
9. **Unavailable system:** degrade to no-badge (never an error state); the nav item still works.
10. **Accessibility:** count via `aria-live="polite"`, text alternative for any dot; no blinking.

**Conclusion:** full cross-system badges are a **build-required later phase**. Ship navigation first.

## 11. Phased notification plan
- **N0 (now):** navigation only, no badges.
- **N1:** Railway → BD "Open Marketplace" badge for high-value actionable items (new marketplace message, event needs edits/approved/declined, marketplace invoice due, pickup action). Build one member-scoped `GET /api/me/marketplace-activity-summary` (count + top reason), consumed server-side by the BD widget.
- **N2:** BD → Railway "Business Administration" badge (overdue membership invoice, payment-method problem, renewal issue, incomplete required profile, unverified listing, new lead). Needs a BD summary endpoint or the BD API to expose billing/profile status; verify availability first.
- **N3:** unify the shell bell with N1 as the in-app notifications inbox.
- All counts summary-only (no sensitive cross-system detail); graceful no-badge fallback; polite aria-live.

## 12. Professional provisioning dependencies (hard gate)
Per **Phase 4B**: **0 of 336 imported companies are provisioned**; the bridge creates buyer-only identities. Lewis & Maese (`bd_listing_id=350`, org `77c403f5…`) has **no** organization membership, **no** `events` capability, **no** seller profile. Therefore:
- "Business Administration" (return link) is safe to ship now for any `bd_member`.
- **"Open Marketplace" must NOT be presented as fully operational** (My Events / Create Event / seller workspace) until 4B entitlement provisioning is done for eligible members. Until then a professional lands in buyer-only mode.
- **Lewis & Maese = first controlled verification account** for the end-to-end professional experience once 4B lands.

## 13. Accessibility considerations
Keyboard-focusable links with visible focus; `aria-label` on the action; badge counts via `aria-live="polite"` with a text equivalent (never color/dot alone); **no blinking/animation** (respect `prefers-reduced-motion`); ≥44px touch targets; sufficient contrast in both themes; the item is a real `<a>` (not JS-only).

## 14. Analytics plan
Reuse the live GA4 tag. Emit:
- `open_marketplace_click` (BD side) — props: `surface` (header|card), `plan`, `device`.
- `business_admin_click` (Railway side) — props: `surface` (shell_rail|shell_mobile|buyer_nav_menu|org_portal|event_page), `role`, `device`.
- `cross_workspace_attention_shown` / `_click` (N1+) — props: `direction`, `reason`, `count_bucket`.
No PII; counts bucketed.

## 15. Test plan
- **Nav/entitlement (unit):** item present for `bd_member` across shell + buyer-nav + org portal; absent for native users; absent logged-out; label never contains "railway"; mobile-reachable. *(shell portion already covered.)*
- **`/me` contract:** `bd_member` from external identity; `business_admin_url` only for BD members; configurable, never `enter-auctions`.
- **Auth (manual matrix, both directions):** BD→Marketplace via bridge (no 2nd login, no flash); Marketplace→BD (no loop, no login while BD session alive); expired BD session → BD login; expired Railway session → bridge re-mints.
- **Desktop + mobile** on every listed surface.
- **Provisioning (post-4B):** Lewis & Maese sees My Events/Create Event after provisioning; buyer-only before.
- **Notification (N1+):** summary endpoint scoping, stale/unavailable fallback, aria-live.
- Full jest suite; §17 auth matrix from `BD_RAILWAY_INTEGRATION.md`.

## 16. Estimated effort
- Phase 2 (two-way nav, global): **M** — Railway global placement (buyer-nav + org portal + event page) ~S–M; BD Open Marketplace card + header widget ~S–M (manual BD).
- Phase 3 (visual alignment): **M–L** — BD custom widgets + CSS, per-plan testing.
- Phase 4 (notifications N1–N3): **L** — new summary endpoints both directions + BD API verification + caching + a11y.
- Provisioning (4B, prerequisite for "operational"): **M–L** (tracked separately).

## 17. Launch priority
- **Two-way navigation: High** (defines the unified product; low risk; navigation-first).
- **Visual alignment: Medium** (polish; upgrade-safe widgets).
- **Notifications: Medium/Low** (valuable but build-heavy; phase after nav).
- **Professional provisioning (4B): Critical** for professional event creation and for "Open Marketplace" to be truthfully operational.

## 18. Files / widgets / menus / settings / routes that would change
**Railway repo:**
- `public/widgets/shared/buyer-nav.js` — add "Business Administration" to the account menu + mobile mega-menu (BD members; reads `/me`).
- `public/org/portal.js` — add the link to the org portal header.
- `public/event.html` — add the link (BD members).
- `public/widgets/shared/member-nav-config.js`, `public/widgets/shared/member-shell.js` — **done (prototype)**.
- `src/routes/auth.js` (`/me` flag), `src/lib/bridgeConfig.js` (`BD_MEMBER_ADMIN_URL`) — **done (prototype)**.
- `.env.example`, `docs/BD_RAILWAY_INTEGRATION.md §20` — **done (prototype)**.
- **N1+ new route:** `GET /api/me/marketplace-activity-summary` (member-scoped, key-authed for the BD widget).
- Analytics: extend the GA4 event map.

**BD (manual, not in repo):** Open Marketplace card + dashboard header/footer widgets; logged-in menu entry; Custom CSS for visual alignment; per-level dashboard module config; (N2) a BD member-status summary endpoint or BD API billing/profile fields.

**Settings/env:** `BD_MEMBER_ADMIN_URL` (confirm slug); bridge dest key `dashboard` (exists).

---

### Open decisions needed from the Product Owner
1. The exact **loop-free BD member-dashboard slug** for `BD_MEMBER_ADMIN_URL`.
2. **Per-plan dashboard module** confirmations (export from BD Admin) — especially Claim Listing (free) and Appraiser.
3. Approve **navigation-first**, notifications phased (N1→N3).
4. Confirm **Phase 4B provisioning** proceeds so "Open Marketplace" becomes truthfully operational (Lewis & Maese first).
