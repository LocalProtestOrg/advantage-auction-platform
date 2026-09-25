-- 171_claimed_listing_pilot_readiness.sql
--
-- Claimed Listing: what the first controlled pilot still needed (audit 2026-09-25).
--   * EXCLUDE_PAID_MEMBER: a listing on a paid directory plan the company actually holds never receives
--     acquisition outreach. The plan id is synced from the directory into bd_metadata.subscription_id.
--   * Cohort members can be EXCLUDED from a draft cohort by the reviewing staff member (with a reason).
--   * delivery_issue staff tasks: a send whose outcome is uncertain, or that failed too many times, stops
--     and goes to a person; it is never retried blindly.
--   * Config: which directory plan ids are the free Claim Listing plan, and the send-attempt cap.
--
-- Nothing here enables sending. The four programme switches are not touched.

BEGIN;

ALTER TABLE listing_outreach_eligibility_decisions DROP CONSTRAINT IF EXISTS chk_lode_decision;
ALTER TABLE listing_outreach_eligibility_decisions ADD CONSTRAINT chk_lode_decision CHECK (decision IN (
  'ELIGIBLE_UNCLAIMED_LISTING','EXCLUDE_CLAIMED_LISTING','EXCLUDE_EVENT_PARTNER','EXCLUDE_PRO_SELLER','EXCLUDE_PAID_MEMBER',
  'EXCLUDE_SUPPRESSED','EXCLUDE_RECENT_OUTREACH','EXCLUDE_NO_PUBLIC_CONTACT','EXCLUDE_OUT_OF_SCOPE',
  'REVIEW_AMBIGUOUS_IDENTITY','REVIEW_OTHER_RELATIONSHIP','REVIEW_DATA_QUALITY'));

ALTER TABLE listing_outreach_cohort_members DROP CONSTRAINT IF EXISTS listing_outreach_cohort_members_status_check;
ALTER TABLE listing_outreach_cohort_members ADD CONSTRAINT listing_outreach_cohort_members_status_check
  CHECK (status IN ('pending','queued','active','completed','skipped','stopped','excluded'));
ALTER TABLE listing_outreach_cohort_members ADD COLUMN IF NOT EXISTS excluded_by uuid REFERENCES users(id);
ALTER TABLE listing_outreach_cohort_members ADD COLUMN IF NOT EXISTS excluded_at timestamptz;

ALTER TABLE listing_tasks DROP CONSTRAINT IF EXISTS listing_tasks_task_type_check;
ALTER TABLE listing_tasks ADD CONSTRAINT listing_tasks_task_type_check CHECK (task_type IN ('reply_received','claim_help_request','remove_listing',
  'wrong_contact_research','tier_a_call','activation_stalled','pro_interest','dispute',
  'review_ambiguous_identity','review_data_quality','profile_change_review','legal_escalation','delivery_issue'));

INSERT INTO platform_config (key, value, category, description) VALUES
  ('claimed_listings.claim_plan_ids',     '["7"]'::jsonb, 'claimed_listings', 'Directory plan ids that are the free Claim Listing plan. A listing on any other known plan is a paying (or pending-correction) member and never receives acquisition outreach.'),
  ('claimed_listings.max_send_attempts',  '5'::jsonb,     'claimed_listings', 'Failed delivery attempts per message before the sequence stops and a person reviews it.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
