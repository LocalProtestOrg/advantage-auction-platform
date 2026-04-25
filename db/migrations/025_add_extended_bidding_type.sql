-- Migration: 025_add_extended_bidding_type.sql
-- Extends notifications_queue.type CHECK to include 'EXTENDED_BIDDING'.

ALTER TABLE notifications_queue
  DROP CONSTRAINT IF EXISTS notifications_queue_type_check;

ALTER TABLE notifications_queue
  ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN ('OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON',
                  'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING'));
