# Buyer / Seller Experience Separation — Design & Recommendation

**Status:** design + architecture note (NOT implemented this sprint, by owner direction). Priority: clarity
for first-time buyers — a new buyer must not feel they've entered a seller operations system.

## Owner product model (2026-07-26)
1. New individual users → simple **buyer-only** dashboard + navigation.
2. Seller tools **hidden** until the user intentionally begins and sufficiently completes seller onboarding.
3. Buyer+approved-seller → clearly **separated** Buyer and Seller experiences with an obvious
   **"Switch to Buying" / "Switch to Selling"** control (Airbnb Guest/Host model).
4. One account, one login. The switch changes the **active dashboard/nav/cards/tools** — not identity.

## What the current implementation does (as of main@eb730c8)
- The shell nav is driven by a single isomorphic function: `member-nav-config.js` →
  **`visibleNavFor({role, isSeller})`**. This is the exact seam a mode switch needs.
- A **first-time buyer** (no seller profile) already sees a buyer-first experience:
  - Home renders `loadBuyerHome` (buyer command center) — no seller ops.
  - **Analytics is hidden** for non-sellers.
  - **Sell** is present but resolves to an **education/enroll** card ("Start selling" / "How it works"),
    NOT seller tools. So a new buyer is not dropped into a seller operations system.
- A **buyer + seller** sees buyer sections + seller sections in ONE combined nav (Sell → workspace,
  Analytics), plus a compact "Also for you as a buyer" banner on the seller Home. This is the combined
  view the owner wants to eventually split behind a mode switch.
- **Admin** Home routes to the admin command center; Sell tab now shows admin ops (not buyer onboarding).

**Conclusion:** the current experience is already buyer-first for new users (no seller overload), and the
navigation is NOT hard-cemented — it flows through `visibleNavFor`. Nothing done this sprint blocks the
future split.

## Changes already made to protect first-time buyers (this sprint)
- Admin no longer sees the buyer "Become a Seller" onboarding in the Sell tab.
- Dead-end/loop seller CTAs fixed (below), so a buyer exploring "Sell" never hits a broken flow.
- (Existing) Sell for non-sellers is education-only; Analytics hidden for non-sellers.

## Recommended follow-up sprint (Buyer/Seller Mode Switch)
Implement the Airbnb-style switch as a **small, contained** change on the existing seam:
1. **State:** add a client `ab_active_mode` ('buying' | 'selling'), default 'buying'; only offered when
   `isSeller` is true. Persist per device.
2. **Nav:** extend `visibleNavFor({role, isSeller, mode})` — in 'buying' mode a buyer+seller sees the
   buyer set (Home/Auctions/Watchlist/Purchases/Sellers/Account + a "Switch to Selling" control); in
   'selling' mode they see Home(seller)/Sell/Analytics/Account + "Switch to Buying". One function change.
3. **Header control:** a mode toggle in the shell header (visible only when `isSeller`).
4. **Home:** pick `loadBuyerHome` vs `loadSellerHome` from `mode` instead of `isSeller`.
5. **Non-sellers:** never see the switch; unchanged buyer-only experience.
6. **Admin:** separate Admin experience; not part of the buyer/seller switch.
Estimated: one focused sprint, no schema change (mode is client state; seller enablement already server-
authoritative). Tests: nav-by-(role,isSeller,mode), default buying, switch persistence, non-seller never
sees the control.

**Recommendation: schedule as the immediate next sprint.** It is not required for launch (current UX is
already buyer-first and safe), but it delivers the clean Guest/Host separation the owner wants and the
architecture is ready for it.
