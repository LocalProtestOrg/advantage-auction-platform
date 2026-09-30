-- 181: paid campaigns can FINISH. Adds two terminal states to marketing_paid_campaigns.state:
--   BUDGET_EXHAUSTED  the provider stopped delivery because the authorization / provider spend cap is spent
--   COMPLETED         the provider schedule ended (campaign stop_time or every ad set end_time passed)
-- Set only by paidSpendGovernance.finishCompletedCampaigns on provider evidence (no spend today, provider cap or
-- schedule end). Never restarted automatically (assertNewSpendAllowed refuses a finished campaign).
-- ADDITIVE / IDEMPOTENT: widens one CHECK; changes no row. Every existing state stays valid.

ALTER TABLE marketing_paid_campaigns DROP CONSTRAINT IF EXISTS chk_mpcam_state;
ALTER TABLE marketing_paid_campaigns ADD CONSTRAINT chk_mpcam_state CHECK (state IN (
  'PLANNED','CREATIVE_BLOCKED','READY','ACTIVE','PAUSED','STOPPED','FAILED','COMPLETED','BUDGET_EXHAUSTED'));
