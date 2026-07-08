-- 085: Batch A — add AUCTION_BEGINS_SOON to notifications_queue.type.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Widens the notifications_queue type CHECK to
-- allow the new engaged-buyer "auction begins soon" reminder (enqueued 60 min and 5 min
-- before start_time to buyers who bid on OR watchlisted a lot in the auction). No data is
-- changed and no other type is removed — every previously-allowed type is re-enumerated so
-- no historical row is rejected. Same non-destructive drop-and-recreate pattern as 083/084.

ALTER TABLE notifications_queue DROP CONSTRAINT IF EXISTS notifications_queue_type_check;
ALTER TABLE notifications_queue ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN (
    'OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON',
    'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING',
    'NEW_AUCTION', 'AUCTION_RETURNED_TO_DRAFT', 'AUCTION_REJECTED',
    'PICKUP_SCHEDULED', 'PICKUP_REMINDER',
    'PAYMENT_REMINDER',
    'AUCTION_BEGINS_SOON'
  ));
