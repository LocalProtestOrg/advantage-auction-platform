-- 083: Buyer-Centric Global Pickup Scheduling — completion + tier on assignments (Launch).
-- ADDITIVE / NON-BREAKING. No destructive changes. The new buyer-centric planner
-- (pickupPlanService) writes assigned_tier + pickup_status; admins mark completion here.
-- Drives off size_category (clean); pickup_category is retired from scheduling.
-- No Stripe/settlement/payment/tax behavior. Idempotent.

ALTER TABLE pickup_assignments ADD COLUMN IF NOT EXISTS assigned_tier TEXT;                                  -- buyer's consolidated tier A/B/C
ALTER TABLE pickup_assignments ADD COLUMN IF NOT EXISTS pickup_status TEXT NOT NULL DEFAULT 'scheduled';     -- scheduled|completed|missed
ALTER TABLE pickup_assignments ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;
ALTER TABLE pickup_assignments ADD COLUMN IF NOT EXISTS completed_by  UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_pickup_assign_buyer  ON pickup_assignments(pickup_schedule_id, buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_pickup_assign_status ON pickup_assignments(pickup_status);

-- missed_pickups: create if absent. (Migration 008 defined it with an INVALID inline
-- `UNIQUE (lot_id) WHERE ...` table constraint — not valid Postgres — so it never got created
-- in production. Recreate correctly here: partial-unique as a proper CREATE UNIQUE INDEX.)
-- Additive + idempotent; a no-op where the table already exists (staging).
CREATE TABLE IF NOT EXISTS missed_pickups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  scheduled_slot_start TIMESTAMPTZ NOT NULL,
  scheduled_slot_end TIMESTAMPTZ NOT NULL,
  missed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rescheduled_to_slot_start TIMESTAMPTZ,
  rescheduled_to_slot_end TIMESTAMPTZ,
  rescheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'missed' CHECK (status IN ('missed','rescheduled','pickup_completed','penalty_waived')),
  penalty_amount_cents INT,
  penalty_applied_at TIMESTAMPTZ,
  storage_fee_cents INT,
  storage_fee_applied_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_missed_per_lot ON missed_pickups(lot_id) WHERE status IN ('missed','rescheduled');
CREATE INDEX IF NOT EXISTS idx_missed_pickups_buyer  ON missed_pickups(buyer_user_id) WHERE status IN ('missed','rescheduled');
CREATE INDEX IF NOT EXISTS idx_missed_pickups_lot    ON missed_pickups(lot_id);
CREATE INDEX IF NOT EXISTS idx_missed_pickups_status ON missed_pickups(status);

COMMENT ON COLUMN pickup_assignments.assigned_tier IS 'Buyer consolidated pickup tier (largest won item: any C->C, else B, else A). Set by pickupPlanService at close.';
COMMENT ON COLUMN pickup_assignments.pickup_status IS 'scheduled | completed | missed. Completion is per-buyer (all a buyer''s lots share one appointment).';

-- Extend notifications_queue.type CHECK to include the pickup notification types (same
-- non-destructive drop-and-recreate pattern as migrations 023/024/050 — all existing types
-- are re-enumerated so no historical row is rejected). Widening only; non-destructive.
ALTER TABLE notifications_queue DROP CONSTRAINT IF EXISTS notifications_queue_type_check;
ALTER TABLE notifications_queue ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN (
    'OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON',
    'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING',
    'NEW_AUCTION', 'AUCTION_RETURNED_TO_DRAFT', 'AUCTION_REJECTED',
    'PICKUP_SCHEDULED', 'PICKUP_REMINDER'
  ));
