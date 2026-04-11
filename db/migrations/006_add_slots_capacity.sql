-- Slots capacity tracking for dynamic assignment
-- Tracks capacity and assigned count per slot to enable efficient, scalable pickup scheduling

CREATE TABLE IF NOT EXISTS slots_capacity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_schedule_id UUID NOT NULL REFERENCES pickup_schedules(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('A','B','C')),
  slot_number INT NOT NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  capacity INT NOT NULL CHECK (capacity > 0),
  assigned INT NOT NULL DEFAULT 0 CHECK (assigned >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(pickup_schedule_id, category, slot_number)
);

-- Index for efficient lookup: find available slots per schedule + category
CREATE INDEX idx_slots_capacity_schedule_cat ON slots_capacity(pickup_schedule_id, category) WHERE assigned < capacity;

-- Index for updates
CREATE INDEX idx_slots_capacity_schedule_cat_num ON slots_capacity(pickup_schedule_id, category, slot_number);
