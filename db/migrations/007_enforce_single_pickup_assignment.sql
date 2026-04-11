-- Enforce unique assignment per lot
-- Each lot can have only one pickup assignment (no multiple slots per lot)

ALTER TABLE pickup_assignments
ADD CONSTRAINT unique_assignment_per_lot UNIQUE (lot_id);
