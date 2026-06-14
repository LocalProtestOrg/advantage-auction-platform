# Sprint-Close Validation Checklist — two-buyer TEST auction

Run on **staging** after the branch is deployed (gate step 4), then repeat the prod
subset after the prod deploy (gate step 8). **Stripe TEST only.** Two buyers: **A** and
**B**. `[AUTO]` = covered by `scripts/stg-sprint-close-validate.js`; `[MANUAL]` =
browser/mobile/audio check a person performs.

## Setup
- [ ] `[AUTO]` Create a small TEST auction (2 lots), near-future start, admin-publish;
      staggered closes (Lot1 start+60s, Lot2 start+120s, end=MAX).

## Registration flow (#5)
- [ ] `[MANUAL]` New buyer: Auction → Register → (Card if needed) → Terms → **returns to the
      auction ready to bid** (no dead-end). Accepting terms redirects back via `next`.
- [ ] `[MANUAL]` Existing card-on-file buyer: card step is **skipped**.
- [ ] `[MANUAL]` Terms acceptance returns to the originating auction/lot.
- [ ] `[AUTO]` `registration-status` → `can_bid:true` after terms + card + register + pickup.

## Account / identity
- [ ] `[AUTO]` Email-based account; `[AUTO]` card-on-file saved via Stripe TEST SetupIntent
      (no charge); `[AUTO]` terms acceptance recorded (current version).

## Bidding + max bidding + ladder (#3, #16)
- [ ] `[AUTO]` A bids, B outbids, A re-leads — current bid + next-min ascend.
- [ ] `[AUTO]` Max/proxy bid accepted; success wording is **"Your Max Bid: $X"**.
- [ ] `[AUTO]` Increment ladder exact: $1/$2.50/$5/$10/$25/$50/$100 bands incl. **>$1000 = $50**.
- [ ] `[AUTO]` Too-low bid → "Bid must be at least $X.XX".

## Winning / Outbid + Increase Your Max Bid (#2, #10)
- [ ] `[AUTO]` `viewer_is_high_bidder` / `viewer_has_bid` / `viewer_max_bid_cents` correct per viewer; no bidder UUIDs exposed.
- [ ] `[MANUAL]` Catalog + lot panel show **green ✓ Winning / red Outbid / Watching / Sold/Closed**.
- [ ] `[MANUAL]` When winning, CTA reads **"Increase Your Max Bid"** (not a normal bid prompt).

## Real-time, no refresh (#1)
- [ ] `[AUTO]` Socket `lot:update` / targeted `lot:winning` / `lot:outbid` arrive (socket.io-client).
- [ ] `[MANUAL]` Bid by B appears on A's **catalog** and **lot page without refresh**; current bid, next-min, countdown update live.
- [ ] `[MANUAL]` Socket disconnected → polling still updates (fallback).

## Anti-snipe / staggered close (#1, #11)
- [ ] `[AUTO]` Late bid (final 2 min) extends only that lot ~2 min; other lot unchanged; `end_time` tracks.
- [ ] `[MANUAL]` Countdown reflects the extension live; lots close on their staggered times; results mode after.

## Emails (#11, #13, delay)
- [ ] `[AUTO]` Outbid/extension emails enqueue; relevance drops stale (lot closed) before send.
- [ ] `[MANUAL]` Received emails show **Lot # + Title**, auction name, image, current bid, direct lot link — **no UUIDs**.
- [ ] `[MANUAL]` No stale outbid/closing-soon email arrives after the lot has closed.

## My Bids / Watchlist (#6)
- [ ] `[AUTO]` `GET /api/lots/my-bids` returns bid lots with photo, lot#, current bid, your max, status, time, link.
- [ ] `[AUTO]` Watchlist add → `GET /api/watchlist` lists it with status; remove works.
- [ ] `[MANUAL]` Both pages render and link back to lots; mobile-usable.

## Nav + bid chime (#6, #14)
- [ ] `[MANUAL]` Shared header (Auctions, My Bids, Watchlist, Account, Back) on all buyer pages; Back works.
- [ ] `[MANUAL]` 🔊 toggle defaults **OFF**; turning on plays a confirmation; chime fires on winning/outbid/extension; not spammy; no autoplay.

## Title/category + video (#12, #15)
- [ ] `[MANUAL]` Lot page shows real category or nothing — **no stray "A"/size code** as a title.
- [ ] `[MANUAL]` "Watch Walkthrough" appears **only when a video exists**; modal player works; absent otherwise.

## Session persistence / renewal (#4, #7)
- [ ] `[MANUAL]` Refreshing the auction/lot page mid-auction does **not** log the bidder out.
- [ ] `[AUTO]` `X-Refreshed-Token` header issued past half-life; client swaps it into localStorage.
- [ ] `[MANUAL]` Countdown appears immediately on first load (not only after refresh).

## Mobile
- [ ] `[MANUAL]` Catalog, lot page, My Bids, Watchlist, registration, nav, status panel, video modal all usable on a phone-width viewport.

## Cleanup
- [ ] `[AUTO]` Archive/remove the TEST auction + throwaway buyers; Stripe customers are TEST.
