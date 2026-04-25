-- Migration: 023_add_close_to_winning_type.sql
-- Extends notifications_queue.type CHECK to include 'CLOSE_TO_WINNING'.

ALTER TABLE notifications_queue
  DROP CONSTRAINT IF EXISTS notifications_queue_type_check;

ALTER TABLE notifications_queue
  ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN ('OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON', 'CLOSE_TO_WINNING'));
