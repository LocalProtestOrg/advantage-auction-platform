-- 162_event_partner_segmentation.sql — ADDITIVE + idempotent.
--
-- The Event Partner architecture had a complete send gate (approved cohort, Owner gate, approved
-- template, suppression) but NO relationship segmentation. Nothing asked the question the Owner
-- made a hard requirement: is this company ALREADY in a relationship with Advantage.Bid that
-- excludes cold Event Partner outreach?
--
-- Without it, a business that has already claimed its listing could receive a cold "authorize us"
-- email — mixing two acquisition journeys that the Owner intends to run separately, and making
-- Advantage.Bid look like it does not know its own customers.
--
-- WHY IDENTITY IS RESOLVED ON SEVERAL SIGNALS. Matching on email alone is useless here: a claimed
-- listing may be held by jane@gmail.com while the public business address is info@smithestates.com.
-- The same company has to be recognised through whichever identifier both records happen to share —
-- normalised name, root domain, email domain, phone. When the signals disagree or are too weak to
-- be sure, the decision is REVIEW_*, which does not send.
--
-- Every decision is PERSISTED with its reason and the signals behind it, so an exclusion can always
-- be explained and so the Claimed Listing cohort can be handed to its own future mission intact.

BEGIN;

CREATE TABLE IF NOT EXISTS event_partner_eligibility_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id         uuid        REFERENCES sales_prospects(id) ON DELETE CASCADE,
  company_name        text        NOT NULL,
  normalized_name     text,
  website_domain      text,
  business_email      text,
  normalized_email    text,
  normalized_phone    text,
  decision            text        NOT NULL,
  reason              text        NOT NULL,
  -- What it matched, when it matched something.
  matched_entity_type text,       -- 'organization' | 'seller_profile' | 'authorized_event_source' | 'suppression' | 'outreach'
  matched_entity_id   text,
  matched_on          jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- which signals agreed
  signals             jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- the raw comparison inputs
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prospect_id),
  CONSTRAINT chk_epe_decision CHECK (decision IN (
    'ELIGIBLE_UNAFFILIATED',
    'EXCLUDE_EVENT_PARTNER',
    'EXCLUDE_CLAIMED_LISTING',
    'EXCLUDE_PRO_SELLER',
    'EXCLUDE_SUPPRESSED',
    'EXCLUDE_RECENT_OUTREACH',
    'EXCLUDE_NO_PUBLIC_CONTACT',
    'REVIEW_AMBIGUOUS_IDENTITY',
    'REVIEW_OTHER_RELATIONSHIP'))
);
CREATE INDEX IF NOT EXISTS idx_epe_decision ON event_partner_eligibility_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_epe_domain ON event_partner_eligibility_decisions(website_domain);

-- ---------------------------------------------------------------------------------------------
-- Config. Nothing is switched on here.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  -- A company contacted within this window is not contacted again by this programme.
  ('event_partners.recent_outreach_days', '90', 'marketing'),
  -- The From address for Event Partner mail. Applied only when the identity is deliverable;
  -- otherwise the verified default sender is used rather than risking the programme's reputation.
  ('event_partners.from_address', '"events@advantage.bid"', 'marketing'),
  -- Hard ceiling for the first live cohort. Independent of the daily send ceiling.
  ('event_partners.first_cohort_max', '10', 'marketing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
