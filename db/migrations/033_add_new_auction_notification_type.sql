-- Migration: 033_add_new_auction_notification_type.sql
-- Extends notifications_queue.type CHECK to include 'NEW_AUCTION'.
-- Follows the same drop-and-recreate pattern as migrations 023, 024, 025.
-- All seven existing types must be included or the constraint rejects existing rows.

ALTER TABLE notifications_queue
  DROP CONSTRAINT IF EXISTS notifications_queue_type_check;

ALTER TABLE notifications_queue
  ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN (
    'OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON',
    'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING',
    'NEW_AUCTION'
  ));
