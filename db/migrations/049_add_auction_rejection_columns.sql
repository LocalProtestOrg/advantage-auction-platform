-- GOV-REJ: columns + state value supporting the terminal Reject workflow.
--
-- A rejected auction is the terminal moderation outcome — the seller is
-- told the auction will not be published in its current form and the
-- record is kept for audit and any required follow-up. Sellers can no
-- longer edit a rejected auction; they must start a new submission if
-- they want to try again. (The rebuild path is not enforced here — it's
-- a UX expectation; the lock is enforced by the existing edit-lock rule
-- which sees state != 'draft' and refuses mutation.)
--
-- rejection_reason is the operator-supplied text shown to the seller on
-- the dashboard banner and quoted in the rejection email.
-- rejected_at and rejected_by give us the timestamp and operator for
-- the audit record and for future compliance reporting.
-- rejected_by uses ON DELETE SET NULL so a user purge doesn't break the
-- auction row.
--
-- The state CHECK constraint also needs to be widened to include
-- 'rejected'. Postgres won't let us ALTER an existing CHECK in place —
-- we have to DROP the inferred constraint and ADD a new one with the
-- same column list plus the new value. We look up the constraint name
-- dynamically because migration 001 didn't pin a stable name. If the
-- discovery fails (constraint already dropped on a partial re-run),
-- the code path is a no-op so the migration stays idempotent.

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS rejected_by      UUID REFERENCES users(id) ON DELETE SET NULL;

-- Replace the state CHECK to add the 'rejected' value. The DO block
-- handles the dynamic constraint name lookup; subsequent re-runs of
-- this migration are no-ops because the new constraint is named
-- explicitly and DROP IF EXISTS guards the recreation.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'auctions'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%state%IN%draft%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE auctions DROP CONSTRAINT %I', cname);
  END IF;
END$$;

ALTER TABLE auctions
  DROP CONSTRAINT IF EXISTS auctions_state_check;

ALTER TABLE auctions
  ADD CONSTRAINT auctions_state_check
  CHECK (state IN ('draft','submitted','under_review','published','active','closed','rejected'));
