# Auction Publish Runbook

**Audience:** Advantage admin. **Goal:** review a submitted auction through governance and publish it correctly. **Advantage publishes auctions — sellers never do.**

## Auction state machine
`draft → submitted → under_review → published → active → closed`
Governance side-states: `rejected`, and **return-to-draft** (back to `draft` from `submitted`/`under_review`).

## Governance review (before publishing)
1. Open admin moderation: `/admin/moderation.html`. Locate the `submitted` auction.
2. Review against business rules:
   - **3 featured lots** selected (admin may override).
   - Every lot has a **size category** (dimensions optional).
   - Lot starting bids (default **$1** unless admin override); **bid increment ladder** valid.
   - **Pickup window** satisfies the seller-type pickup-gap rule (non-professional ≥ 48h after close; never before close).
   - Auction terms / standard sections present and correct (editable).
   - Consignor info stored for recordkeeping.
   - Reserve/shipping options only where admin-enabled.
3. Decision:
   - **Return to draft** (needs seller fixes): `POST /api/admin/auctions/:auctionId/return-to-draft` — unlocks seller editing, notifies seller (`AUCTION_RETURNED_TO_DRAFT`). Include a clear revision note.
   - **Reject** (decline): `POST /api/admin/auctions/:auctionId/reject` with a reason → state `rejected`, notifies seller (`AUCTION_REJECTED`).
   - **Approve & publish:** continue below.

## Publish
- `POST /api/admin/auctions/:auctionId/publish` (metadata/settings adjustments use `PATCH .../publish`).
- Publishing **preserves the seller-provided `start_time`/`end_time`**. Confirm the schedule is correct first — these drive the auto-close scheduler.
- On publish, `NEW_AUCTION` notifications are queued for followers/eligible buyers (sent by `notificationWorker` via SES).

## Post-publish verification (read-only)
- State is `published` (later `active` when `start_time` passes): check via admin auction view or `/api/admin/audit-log`.
- The **state-transition scheduler** in `notificationWorker` promotes `published → active` and drives lot auto-close. Confirm the worker is running (incident runbook).
- Buyer-facing listing visible on `/api/public/auctions`.

## Admin override capability (preserve at all times)
- Admin can edit featured lots, schedule, pickup window, terms, increments — even after seller lock. Every override is audit-logged.

## Pitfalls
| Pitfall | Guidance |
|---|---|
| Publishing with a bad pickup window | Server enforces the gap for non-professional sellers; fix before publish to avoid seller confusion. |
| Wrong start/end time | Publish preserves seller times — correct them first; the scheduler acts on them literally. |
| Featured lots missing/incorrect | Set/override the 3 featured lots before publish. |
| Re-publishing after edits | Use `PATCH .../publish` for adjustments; avoid duplicate publish actions. |

## Audit
Every governance action (return/reject/publish/override) writes to `audit_log`. Spot-check `GET /api/admin/audit-log` after publishing.
