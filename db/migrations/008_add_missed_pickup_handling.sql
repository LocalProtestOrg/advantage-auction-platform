-- Missed pickup handling and rescheduling
-- Tracks missed pickups, rescheduling, and penalty application

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
  status TEXT NOT NULL DEFAULT 'missed' CHECK (status IN ('missed', 'rescheduled', 'pickup_completed', 'penalty_waived')),
  penalty_amount_cents INT,
  penalty_applied_at TIMESTAMPTZ,
  storage_fee_cents INT,
  storage_fee_applied_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Unique lot per missed event (historical tracking allowed with status)
  CONSTRAINT one_active_missed_per_lot UNIQUE (lot_id) WHERE status IN ('missed', 'rescheduled')
);

-- Indexes for efficient lookups
CREATE INDEX idx_missed_pickups_buyer ON missed_pickups(buyer_user_id) WHERE status IN ('missed', 'rescheduled');
CREATE INDEX idx_missed_pickups_lot ON missed_pickups(lot_id);
CREATE INDEX idx_missed_pickups_status ON missed_pickups(status);
CREATE INDEX idx_missed_pickups_missed_at ON missed_pickups(missed_at);
