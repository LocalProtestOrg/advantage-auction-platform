-- Migration: 024_add_final_seconds_type.sql
-- Extends notifications_queue.type CHECK to include 'FINAL_SECONDS'.

ALTER TABLE notifications_queue
  DROP CONSTRAINT IF EXISTS notifications_queue_type_check;

ALTER TABLE notifications_queue
  ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN ('OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON', 'CLOSE_TO_WINNING', 'FINAL_SECONDS'));
