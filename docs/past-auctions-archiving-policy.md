# Past Auctions — Visibility & Archiving Policy

**Surface:** `bid.advantage.bid` (the auction platform). NOT the Brilliant Directories marketing site `advantage.bid`.

## How public Past Auctions visibility works
- The public Past Auctions page (`/past-auctions.html`) and the homepage "Recent Auction Results" section call `GET /api/public/auctions?state=closed`.
- That endpoint returns closed auctions **WHERE `is_archived IS NOT TRUE`**. So **`is_archived` is the visibility switch**: a closed auction is shown publicly only if it is NOT archived.
- Realized prices follow the existing #20.1 rule (anonymous: hidden; logged-in: visible). Closed lots never accept bids (422).

## Current state (curated demo library)
- 6 curated demonstration auctions (`5b00000{1..6}-…`), ~233 lots, all `state='closed'`, `is_archived=false`, marked as **Sample / Example Auction Results**. No payments, invoices, or real buyers.
- All pre-existing test / rehearsal / payment-test / pilot closed auctions remain **archived** (hidden). They were archived previously and stay that way.

## Long-term policy (RECOMMENDED — going forward)
1. **Do NOT auto-archive every closed auction.** The earlier curation seed blanket-archived non-curated closed auctions; that behavior has been **removed** from the seed. The seed now manages only its own curated `5b00000{1..6}` rows and never archives others.
2. **Real auctions should accumulate authentic history.** When genuine auctions close, leave them **non-archived** so they appear in Past Auctions and build real platform history over time.
3. **Archive is for hiding, not housekeeping.** Use `is_archived=true` only to hide an auction that should not be public (test data, cancelled/void events, or a seller/legal request). It is reversible.
4. **Curated demos vs. real history.** As real closed auctions accumulate, the curated demo set can be retired or reduced — at that point archive (or delete) the `5b00000{1..6}` demos. They are clearly labeled sample data and carry no payments/invoices, so removal is clean.
5. **No code path should archive closed auctions automatically.** Archiving remains an explicit admin action (admin tools / a one-off guarded script), never an automatic side effect of closing or of seeding.

## Operational quick-reference
- **Feature a real closed auction:** ensure `is_archived=false` (default on close) — it appears automatically.
- **Hide a closed auction:** set `is_archived=true` (admin).
- **Retire the demo library:** archive or delete `5b00000{1..6}-…` (guarded script / admin).
