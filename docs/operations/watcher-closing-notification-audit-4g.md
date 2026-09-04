# Watcher / Closing Notification Audit (Phase 4G §14)

**Question:** Would a marketing "watched item is closing" campaign duplicate an existing transactional notification?

## Current transactional state (audited 2026-09-04)

Pipeline: `notifications_queue` → `src/workers/notificationWorker.js` (content in `src/lib/notificationContent.js`).

| Type | Recipients | When | Status TODAY |
|---|---|---|---|
| `OUTBID` | ONLY the previous high bidder (`bidService.js`) | on every displacing bid | **ACTIVE** — the only live buyer bidding email |
| `ENDING_SOON` | (bidders ≥80% price) ∪ (ALL watchlist users) | 10-min window | **DISABLED** (`return;` guard) |
| `FINAL_SECONDS` | bidders ∪ ALL watchlist users | 10-sec window | **DISABLED** |
| `CLOSE_TO_WINNING` | bidders only | best bid ≥90% | **DISABLED** |
| `AUCTION_BEGINS_SOON` | engaged buyers (bid OR watchlisted any lot in the auction) | start-time milestones | **ACTIVE** (auction-level, NOT per-lot) |
| `WINNING` (per-lot) | winner | at close | **DISABLED** (replaced by Design C combined package) |

`notification_preferences`: `email_enabled`, `sms_enabled`, `follower_emails_enabled` — no per-type or watcher-specific column. `watchlists(user_id, lot_id)`; only `AUCTION_BEGINS_SOON` actively reads it.

## Finding

There **is** a genuine gap: a user who **watchlists a lot but never bids** receives **no per-lot closing/ending-soon notification today** (the transactional producers that would cover it are turned off). `OUTBID` requires having bid; `AUCTION_BEGINS_SOON` is auction-level, not "your watched item closes in X minutes."

## Decision (Phase 4G)

**Do NOT build a marketing duplicate.** The correct fix for a no-bid watcher closing nudge is a **transactional** notification (re-enable/scope the disabled `ENDING_SOON` watcher branch), not a discretionary marketing campaign — marketing must never relabel itself transactional to bypass caps (collision precedence rule #1).

- A `watcher_closing_gap` opportunity detector MAY be added in a later phase, but it stays **WAITING** and its recommendation is **"re-enable the transactional producer"**, not "send marketing."
- If ever built as marketing, it would be strictly gated (collision: transactional > marketing; ≤1 marketing/day) and must not fire when the transactional producer is active.

## Owner action (optional, not marketing)

If the Owner wants no-bid watchers to get per-lot closing notices, re-enable the `enqueueEndingSoon` watchlist branch in `notificationWorker.js` (a transactional change), with a per-user preference. This is a product/notifications decision, not a Marketing Agency task.
