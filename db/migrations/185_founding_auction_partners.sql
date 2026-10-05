-- 185: Founding Auction Partner foundation (2026-10-05). ADDITIVE / IDEMPOTENT.
--
-- Advantage.Bid may temporarily waive ITS professional auction platform/software fee for a small, rotating group of
-- Founding Auction Partners. The 3% card-processing fee is never waived and stays the seller's responsibility.
--
-- No second fee engine: the introductory rate is written to the EXISTING per-seller rate
-- (seller_profiles.platform_fee_bps, the Moderation "Platform Fee"), which the publish-time snapshot already freezes
-- into auctions.platform_fee_bps. This table is the audited program record around it: who, which market, why, the
-- introductory and return rates, the dates, and who approved it.
--
-- Cross-program protection: a company handled as a Founding Partner moves into its own acquisition journey
-- (FOUNDING_PARTNER). Claimed Listing sends only to CLAIMED_LISTING companies and Event Partner never cold-invites a
-- company with a relationship, so neither program can message it.
--
-- Nothing here changes a fee, a switch, a journey or a company. The table starts empty.

BEGIN;

-- 1. The new journey.
-- The 169 constraint was declared inline (system-named); drop whichever CHECK lists the journeys, then re-add it.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'acquisition_journey_assignments'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%CLAIMED_LISTING%'
  LOOP
    EXECUTE format('ALTER TABLE acquisition_journey_assignments DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE acquisition_journey_assignments ADD CONSTRAINT acquisition_journey_assignments_journey_check
  CHECK (journey IN ('CLAIMED_LISTING','EVENT_PARTNER','SALES_DIRECT','FOUNDING_PARTNER'));

-- 2. Screening decisions that name the new exclusion.
ALTER TABLE listing_outreach_eligibility_decisions DROP CONSTRAINT IF EXISTS chk_lode_decision;
ALTER TABLE listing_outreach_eligibility_decisions ADD CONSTRAINT chk_lode_decision CHECK (decision IN (
  'ELIGIBLE_UNCLAIMED_LISTING','EXCLUDE_CLAIMED_LISTING','EXCLUDE_EVENT_PARTNER','EXCLUDE_PRO_SELLER','EXCLUDE_PAID_MEMBER',
  'EXCLUDE_SUPPRESSED','EXCLUDE_RECENT_OUTREACH','EXCLUDE_NO_PUBLIC_CONTACT','EXCLUDE_OUT_OF_SCOPE',
  'REVIEW_AMBIGUOUS_IDENTITY','REVIEW_OTHER_RELATIONSHIP','REVIEW_DATA_QUALITY','EXCLUDE_FOUNDING_PARTNER'));
ALTER TABLE event_partner_eligibility_decisions DROP CONSTRAINT IF EXISTS chk_epe_decision;
ALTER TABLE event_partner_eligibility_decisions ADD CONSTRAINT chk_epe_decision CHECK (decision IN (
  'ELIGIBLE_UNAFFILIATED','EXCLUDE_EVENT_PARTNER','EXCLUDE_CLAIMED_LISTING','EXCLUDE_PRO_SELLER',
  'EXCLUDE_SUPPRESSED','EXCLUDE_RECENT_OUTREACH','EXCLUDE_NO_PUBLIC_CONTACT',
  'REVIEW_AMBIGUOUS_IDENTITY','REVIEW_OTHER_RELATIONSHIP','EXCLUDE_LISTING_JOURNEY','EXCLUDE_FOUNDING_PARTNER'));

-- 3. The program record.
--    status: prospect = protected and being handled by staff, no seller account yet, no fee change
--            active   = linked to a professional seller; the introductory rate is on the seller's rate
--            ended    = no longer a Founding Partner (the record and attribution are kept)
CREATE TABLE IF NOT EXISTS founding_partners (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES company_identities(id),
  organization_id             uuid REFERENCES organizations(id) ON DELETE SET NULL,
  seller_profile_id           uuid REFERENCES seller_profiles(id) ON DELETE SET NULL,
  display_name                text NOT NULL,
  status                      text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect','active','ended')),
  market                      text NOT NULL CHECK (market ~ '^[a-z0-9_]{2,40}$'),
  reason                      text NOT NULL CHECK (length(btrim(reason)) >= 5),
  internal_note               text,
  start_date                  date,
  intro_end_date              date,                       -- optional: no duration is assumed
  intro_platform_fee_bps      integer NOT NULL DEFAULT 0 CHECK (intro_platform_fee_bps BETWEEN 0 AND 2500),
  return_platform_fee_bps     integer CHECK (return_platform_fee_bps BETWEEN 0 AND 2500),
  prior_platform_fee_bps      integer,                    -- the seller's stored rate before the intro rate was applied
  relationship_owner_user_id  uuid REFERENCES users(id),  -- the staff member who handles the company
  approved_by                 uuid NOT NULL REFERENCES users(id),
  approved_at                 timestamptz NOT NULL DEFAULT now(),
  fee_applied_at              timestamptz,
  fee_applied_by              uuid REFERENCES users(id),
  fee_restored_at             timestamptz,
  fee_restored_by             uuid REFERENCES users(id),
  ended_at                    timestamptz,
  ended_by                    uuid REFERENCES users(id),
  end_reason                  text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_fp_active_has_seller CHECK (status <> 'active' OR seller_profile_id IS NOT NULL),
  CONSTRAINT chk_fp_end_complete CHECK (status <> 'ended' OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)),
  CONSTRAINT chk_fp_dates CHECK (intro_end_date IS NULL OR start_date IS NULL OR intro_end_date >= start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fp_open_company ON founding_partners (company_id) WHERE status <> 'ended';
CREATE UNIQUE INDEX IF NOT EXISTS uq_fp_open_seller ON founding_partners (seller_profile_id) WHERE status <> 'ended' AND seller_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fp_status ON founding_partners (status, intro_end_date);

-- 4. Durable attribution: the program record an auction was published under (stamped once, at publish).
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS founding_partner_id uuid REFERENCES founding_partners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_auctions_founding_partner ON auctions (founding_partner_id) WHERE founding_partner_id IS NOT NULL;

COMMIT;
