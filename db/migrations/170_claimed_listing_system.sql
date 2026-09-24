-- 170_claimed_listing_system.sql — ADDITIVE + idempotent.
--
-- CLAIMED LISTING ACTIVATION & CONVERSION (gates L-A..L-C). The listing journey's OWN data set:
-- eligibility, scoring, immutable approved templates, Owner-approved cohorts, per-company sequences,
-- every message in and out, programme suppression, funnel events, activation milestones, the shared
-- company contact lock, staff tasks and reviewed profile changes. Nothing here is shared with the
-- Event Partner tables, and no Event Partner row is written.
--
-- EVERYTHING SHIPS OFF: claimed_listings.sending_enabled = false, inbound off, activation reminders off,
-- no postal address (the send gate fails closed while it is empty). No email can leave from this
-- migration or from the code that reads these tables until the Owner approves a pilot.

BEGIN;

-- ── Eligibility (one row per organization, persisted with reason + signals) ───────────────────────
CREATE TABLE IF NOT EXISTS listing_outreach_eligibility_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  company_id          uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  company_name        text,
  normalized_email    text,
  decision            text NOT NULL,
  reason              text NOT NULL,
  matched_entity_type text,
  matched_entity_id   text,
  matched_on          jsonb NOT NULL DEFAULT '[]'::jsonb,
  signals             jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_lode_decision CHECK (decision IN (
    'ELIGIBLE_UNCLAIMED_LISTING','EXCLUDE_CLAIMED_LISTING','EXCLUDE_EVENT_PARTNER','EXCLUDE_PRO_SELLER',
    'EXCLUDE_SUPPRESSED','EXCLUDE_RECENT_OUTREACH','EXCLUDE_NO_PUBLIC_CONTACT','EXCLUDE_OUT_OF_SCOPE',
    'REVIEW_AMBIGUOUS_IDENTITY','REVIEW_OTHER_RELATIONSHIP','REVIEW_DATA_QUALITY'))
);
CREATE INDEX IF NOT EXISTS idx_lode_decision ON listing_outreach_eligibility_decisions (decision);

-- ── Scoring (deterministic, explainable) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_outreach_scores (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  score           smallint NOT NULL,
  tier            char(1) NOT NULL CHECK (tier IN ('A','B','C')),
  factors         jsonb NOT NULL DEFAULT '{}'::jsonb,
  scored_at       timestamptz NOT NULL DEFAULT now()
);

-- ── Templates: approved versions are immutable ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_outreach_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  version      integer NOT NULL,
  stream       text NOT NULL DEFAULT 'claimed_listing' CHECK (stream IN ('claimed_listing','transactional')),
  subject      text NOT NULL,
  preheader    text,
  body_text    text NOT NULL,
  body_html    text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  notes        text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_key, version),
  CONSTRAINT chk_lot_approval_complete CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION listing_template_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved','retired') AND (
       NEW.subject IS DISTINCT FROM OLD.subject OR NEW.preheader IS DISTINCT FROM OLD.preheader OR
       NEW.body_text IS DISTINCT FROM OLD.body_text OR NEW.body_html IS DISTINCT FROM OLD.body_html OR
       NEW.template_key IS DISTINCT FROM OLD.template_key OR NEW.version IS DISTINCT FROM OLD.version OR
       NEW.stream IS DISTINCT FROM OLD.stream) THEN
    RAISE EXCEPTION 'approved listing template % v% is immutable; create a new version', OLD.template_key, OLD.version;
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'a retired listing template cannot be reinstated; create a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_listing_template_immutable ON listing_outreach_templates;
CREATE TRIGGER trg_listing_template_immutable BEFORE UPDATE ON listing_outreach_templates
  FOR EACH ROW EXECUTE FUNCTION listing_template_immutable();

-- ── Cohorts: the Owner's send lock ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_outreach_cohorts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  description        text,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','active','paused','closed','expired')),
  template_versions  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "E1": "<template uuid>", ... }
  max_sends          integer NOT NULL DEFAULT 0 CHECK (max_sends >= 0),
  sends_used         integer NOT NULL DEFAULT 0 CHECK (sends_used >= 0),
  daily_cap          integer NOT NULL DEFAULT 10 CHECK (daily_cap >= 0),
  autonomous_allowed boolean NOT NULL DEFAULT false,
  assigned_rep_user_id uuid REFERENCES users(id),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  expires_at         timestamptz,
  notes              text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_loc_approval_complete CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS listing_outreach_cohort_members (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id                  uuid NOT NULL REFERENCES listing_outreach_cohorts(id) ON DELETE CASCADE,
  organization_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id                 uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  recipient_email_normalized text,
  status                     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','active','completed','skipped','stopped')),
  skip_reason                text,
  gate_result                jsonb,
  gate_checked_at            timestamptz,
  added_by                   uuid REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, organization_id)
);

-- ── Sequences: one per (organization, cycle) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_outreach_sequences (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id           uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  cohort_id            uuid REFERENCES listing_outreach_cohorts(id) ON DELETE SET NULL,
  cycle_no             smallint NOT NULL DEFAULT 1 CHECK (cycle_no IN (1,2)),
  step                 smallint NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 4),
  state                text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','active','paused','dormant','stopped','completed')),
  next_send_at         timestamptz,
  last_sent_at         timestamptz,
  stop_reason          text,
  retry_count          smallint NOT NULL DEFAULT 0,
  variant              text,
  assigned_rep_user_id uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, cycle_no)
);
CREATE INDEX IF NOT EXISTS idx_los_due ON listing_outreach_sequences (next_send_at) WHERE state IN ('queued','active');

-- ── Messages: every message in and out, idempotent ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_outreach_messages (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id                uuid REFERENCES listing_outreach_sequences(id) ON DELETE SET NULL,
  organization_id            uuid REFERENCES organizations(id) ON DELETE SET NULL,
  company_id                 uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  direction                  text NOT NULL CHECK (direction IN ('outbound','inbound')),
  template_key               text,
  template_version           integer,
  token_id                   uuid REFERENCES organization_claim_tokens(id) ON DELETE SET NULL,
  ses_message_id             text,
  provider_message_id        text,
  recipient_email_normalized text,
  sender_email_normalized    text,
  status                     text NOT NULL CHECK (status IN ('shadow','queued','sent','failed','bounced','complained','received')),
  idempotency_key            text UNIQUE,
  reply_key                  text UNIQUE,
  subject                    text,
  body_text                  text,
  body_html                  text,
  classification             text,
  action_taken               text,
  raw_digest                 text,
  error                      text,
  sent_at                    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lom_org ON listing_outreach_messages (organization_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lom_inbound_provider ON listing_outreach_messages (provider_message_id)
  WHERE direction = 'inbound' AND provider_message_id IS NOT NULL;

-- ── Programme suppression ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_outreach_suppressions (
  normalized_email text PRIMARY KEY,
  company_id       uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  reason           text NOT NULL CHECK (reason IN ('stop_request','unsubscribe','hard_bounce','complaint','not_my_company',
                     'business_closed','wrong_contact','remove_listing','admin','compliance')),
  source           text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_los_company ON listing_outreach_suppressions (company_id) WHERE company_id IS NOT NULL;

-- ── Funnel events (internal + automated flagged, never counted as acquisition) ───────────────────
CREATE TABLE IF NOT EXISTS listing_claim_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  company_id      uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  sequence_id     uuid REFERENCES listing_outreach_sequences(id) ON DELETE SET NULL,
  message_id      uuid REFERENCES listing_outreach_messages(id) ON DELETE SET NULL,
  token_id        uuid REFERENCES organization_claim_tokens(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  visitor_id      text,
  event_key       text NOT NULL CHECK (event_key IN ('sent','delivered','bounced','complained','unsubscribed',
                    'link_fetch','page_view','claim_started','claim_verified','profile_completed','first_event_published',
                    'activated','engaged','pro_interest','pro_application','pro_conversion',
                    'exit_not_my_company','exit_business_closed','exit_wrong_contact','exit_remove_listing',
                    'self_request','help_request','dispute','reply_received')),
  is_internal     boolean NOT NULL DEFAULT false,
  is_automated    boolean NOT NULL DEFAULT false,
  ip_hash         text,
  idempotency_key text UNIQUE,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_lce_org_key ON listing_claim_events (organization_id, event_key, occurred_at DESC);

-- ── Activation milestones ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_activation_progress (
  organization_id              uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  claimed_at                   timestamptz,
  proof_method                 text,
  details_confirmed_at         timestamptz,
  logo_added_at                timestamptz,
  description_owner_written_at timestamptz,
  service_area_set_at          timestamptz,
  first_event_published_at     timestamptz,
  no_sale_scheduled_at         timestamptz,
  profile_completed_at         timestamptz,
  activated_at                 timestamptz,
  engaged_at                   timestamptz,
  reminders_sent               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "A1": ts, "A2": ts, ... }
  imported_description_sha256  text,
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

-- ── One active contact owner per company (shared by every programme) ────────────────────────────
CREATE TABLE IF NOT EXISTS company_contact_locks (
  company_id       uuid PRIMARY KEY REFERENCES company_identities(id) ON DELETE CASCADE,
  holder_type      text NOT NULL CHECK (holder_type IN ('user','system')),
  holder_user_id   uuid REFERENCES users(id),
  sequence_id      uuid REFERENCES listing_outreach_sequences(id) ON DELETE SET NULL,
  reason           text,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  CONSTRAINT chk_lock_holder CHECK ((holder_type = 'user' AND holder_user_id IS NOT NULL) OR (holder_type = 'system'))
);

-- ── Staff tasks (a person, never an automatic reply) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid REFERENCES company_identities(id) ON DELETE SET NULL,
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  task_type        text NOT NULL CHECK (task_type IN ('reply_received','claim_help_request','remove_listing',
                     'wrong_contact_research','tier_a_call','activation_stalled','pro_interest','dispute',
                     'review_ambiguous_identity','review_data_quality','profile_change_review','legal_escalation')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','dismissed')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_at           timestamptz,
  assigned_user_id uuid REFERENCES users(id),
  summary          text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key       text UNIQUE,
  resolution       text,
  resolved_by      uuid REFERENCES users(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listing_tasks_open ON listing_tasks (task_type, due_at) WHERE status IN ('open','in_progress');

-- ── Claimed-listing identity changes go to review (name, website domain, contact email) ─────────
CREATE TABLE IF NOT EXISTS organization_profile_change_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by    uuid REFERENCES users(id),
  field           text NOT NULL CHECK (field IN ('name','website_url','contact_email')),
  old_value       text,
  new_value       text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','superseded')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_opcr_pending ON organization_profile_change_requests (organization_id, field) WHERE status = 'pending';

-- ── Stream attribution: the listing programme has its own SES stream ─────────────────────────────
ALTER TABLE ses_feedback_events DROP CONSTRAINT IF EXISTS chk_ses_feedback_mail_stream;
ALTER TABLE ses_feedback_events ADD CONSTRAINT chk_ses_feedback_mail_stream
  CHECK (mail_stream IS NULL OR mail_stream IN ('transactional','marketing','event_partner','claimed_listing'));

-- ── Config seeds: ALL OFF. Existing values are never overwritten. ───────────────────────────────
INSERT INTO platform_config (key, value, category, description) VALUES
  ('claimed_listings.sending_enabled',        'false'::jsonb, 'claimed_listings', 'Master send switch for Claimed Listing outreach. Owner-only. Default OFF.'),
  ('claimed_listings.inbound_enabled',        'false'::jsonb, 'claimed_listings', 'Process inbound replies to listing outreach. Default OFF.'),
  ('claimed_listings.activation_emails_enabled','false'::jsonb,'claimed_listings', 'Send A2-A4 activation reminders to account holders. Default OFF.'),
  ('claimed_listings.self_request_enabled',   'false'::jsonb, 'claimed_listings', 'Allow the public "Send my claim link" request to email the listing address. Default OFF.'),
  ('claimed_listings.daily_cap',              '10'::jsonb,    'claimed_listings', 'Global daily send cap.'),
  ('claimed_listings.first_cohort_max',       '50'::jsonb,    'claimed_listings', 'Maximum size of the first pilot cohort.'),
  ('claimed_listings.recent_outreach_days',   '90'::jsonb,    'claimed_listings', 'Cross-programme cooldown (days).'),
  ('claimed_listings.sales_outreach_cooldown_days','30'::jsonb,'claimed_listings','1:1 rep email cooldown (days).'),
  ('claimed_listings.token_ttl_days',         '14'::jsonb,    'claimed_listings', 'Claim link lifetime (days).'),
  ('claimed_listings.from_address',           '"listings@advantage.bid"'::jsonb, 'claimed_listings', 'Sender address (must be a verified identity).'),
  ('claimed_listings.from_name',              '"Advantage.Bid Listings"'::jsonb, 'claimed_listings', 'Sender display name.'),
  ('claimed_listings.send_window',            '{"days":[2,3,4],"start":"09:30","end":"11:30"}'::jsonb, 'claimed_listings', 'Recipient-local send window (0=Sun).'),
  ('claimed_listings.health',                 '{"bounce_max":0.03,"complaint_max":0.001,"min_sample":50}'::jsonb, 'claimed_listings', 'Stream health auto-pause thresholds.'),
  ('claimed_listings.min_send_spacing_seconds','90'::jsonb,   'claimed_listings', 'Minimum spacing between sends.'),
  ('claimed_listings.excluded_bd_listing_ids','["29","30","31","32","36","38","43"]'::jsonb, 'claimed_listings', 'National/international houses and data-quality exclusions (BD user ids).'),
  ('claimed_listings.excluded_company_ids',   '[]'::jsonb,    'claimed_listings', 'Company identity ids excluded from outreach.'),
  ('claimed_listings.paid_badge_bd_listing_ids', '["21","22","24","33","34","35","36","37","39","318","319","320","321","322","323","324","325","326","327","328","329","330","331","332","333","334","335","336","337","338","339","340","341","342","343","344","345","346","347","348","349"]'::jsonb,
     'claimed_listings', 'Imported, never-joined listings verified (2026-09-24, scripts/claimed-listing-badge-audit.js) to show a paid plan badge they never bought. Held for review until corrected on the directory (Owner decision O3).'),
  ('claimed_listings.score_weights',          '{"strategic_market":25,"estate_sale_company":15,"auction_house":10,"liquidator":10,"appraiser":5,"operating":15,"reputation":10,"no_website":10,"basic_website":8,"no_online_auctions":8,"corporate_email":5,"large_firm_named_employee":-10}'::jsonb, 'claimed_listings', 'Prospect scoring weights.'),
  ('claimed_listings.paused_reason',          'null'::jsonb,  'claimed_listings', 'Set when the stream health check auto-pauses the programme.'),
  ('email.configuration_sets.claimed_listing','"advantage-bid-claimed-listing"'::jsonb, 'email', 'SES configuration set for the claimed_listing stream.'),
  ('company.postal_address',                  '""'::jsonb,    'company', 'Physical postal address for commercial email footers. Empty = listing outreach cannot send.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
