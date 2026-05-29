-- GOV-RET: extend notifications_queue.type CHECK to include the seller-
-- facing AUCTION_RETURNED_TO_DRAFT notification type.
--
-- Same drop-and-recreate pattern as migrations 023, 024, 025, 033. All
-- existing types must be enumerated or the constraint rejects historical
-- rows. The list mirrors migration 033 plus the new value.

ALTER TABLE notifications_queue
  DROP CONSTRAINT IF EXISTS notifications_queue_type_check;

ALTER TABLE notifications_queue
  ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN (
    'OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON',
    'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING',
    'NEW_AUCTION',
    'AUCTION_RETURNED_TO_DRAFT'
  ));
