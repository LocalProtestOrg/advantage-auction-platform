-- 154_event_partner_communications_2a.sql — ADDITIVE + idempotent. Phase 2A of the Event Partner
-- program: the inbound communications plumbing, the conversation model, reply classification storage,
-- the escalation queue, approved-cohort + outreach-proposal artifacts with the double-lock send
-- architecture, Event-Partner-scoped suppression, and the public self-service request with its
-- lightweight trust ladder.
--
-- Deliberately NOT in this migration (Phase 2A is plumbing, not activation):
--   * No email is sent. No sender identity is created. No cohort is approved or populated.
--   * No import source is created, activated or re-owned. No collection begins.
--   * No DNS or mail routing is touched. The apex MX and info@advantage.bid are untouched.
--   * No A15 send capability is granted. A15 gains READ-ONLY classification/threading only.
--   * No historical event is attributed. No claim is issued.
--
-- Separation of concerns (six distinct records, never coupled): outreach suppression, company
-- decline, event-source authorization, authorization revocation, listing ownership, seller
-- activation. STOP does not revoke an authorized source; revocation does not imply an unsubscribe.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. event_partner_threads — one conversation with one company.
-- ---------------------------------------------------------------------------------------------
-- `reply_key` is the per-conversation routing token. It becomes the local part of the Reply-To
-- address on the machine-managed inbound namespace (reply.advantage.bid), which is also what an
-- inbound-parse provider surfaces as MailboxHash. That is what makes an incoming reply resolvable to
-- a company and an authorization WITHOUT a human reading it.
--
-- A thread may exist before an authorization record does (a self-service request that has not yet
-- produced one), so authorization_id is nullable and request_id is available instead.
CREATE TABLE IF NOT EXISTS event_partner_threads (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reply_key                text        NOT NULL UNIQUE,
  authorization_id         uuid        REFERENCES authorized_event_sources(id) ON DELETE SET NULL,
  organization_id          uuid        REFERENCES organizations(id) ON DELETE SET NULL,
  request_id               uuid,       -- FK added after event_partner_requests exists (see below)
  company_email            text,
  company_email_normalized text,
  subject                  text,
  status                   text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','awaiting_company','awaiting_human','closed')),
  last_classification      text,
  last_inbound_at          timestamptz,
  last_outbound_at         timestamptz,
  inbound_count            integer     NOT NULL DEFAULT 0,
  outbound_count           integer     NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ep_threads_auth   ON event_partner_threads(authorization_id) WHERE authorization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ep_threads_status ON event_partner_threads(status);
CREATE INDEX IF NOT EXISTS idx_ep_threads_email  ON event_partner_threads(company_email_normalized);

-- ---------------------------------------------------------------------------------------------
-- 2. event_partner_messages — every message in and out, with its classification and evidence.
-- ---------------------------------------------------------------------------------------------
-- Idempotency: UNIQUE (provider, provider_message_id). A provider that retries a webhook — which they
-- all do — can never create a second row, so a retried delivery cannot re-trigger an automated action.
--
-- Evidence vs. privacy: `raw_evidence_sha256` always records a fingerprint of exactly what arrived, so
-- the record is verifiable. The bodies themselves are retained only until `retain_until`
-- (event_partners.raw_message_retention_days) and are then cleared by the retention sweep, leaving the
-- classification, the headers we depend on, and the fingerprint. We store no attachment content.
CREATE TABLE IF NOT EXISTS event_partner_messages (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id               uuid        NOT NULL REFERENCES event_partner_threads(id) ON DELETE CASCADE,
  direction               text        NOT NULL CHECK (direction IN ('inbound','outbound')),
  provider                text        NOT NULL,                 -- 'postmark' | 'ses' | 'internal'
  provider_message_id     text,
  message_id_header       text,
  in_reply_to             text,
  from_email              text,
  from_name               text,
  to_email                text,
  subject                 text,
  text_body               text,
  html_body               text,
  headers                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  spam_score              numeric(6,2),
  -- Classification is ADVISORY metadata. It never grants, broadens or re-scopes permission.
  classification          text,
  classification_source   text        CHECK (classification_source IS NULL OR classification_source IN ('deterministic','heuristic','human')),
  classification_confidence numeric(4,3),
  classification_signals  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  classified_by           text,                                  -- agent code (e.g. 'A15') or user id
  classified_at           timestamptz,
  -- Automated action actually taken in response (never an authorization).
  action_taken            text,
  raw_evidence_sha256     text,
  retain_until            timestamptz,
  redacted_at             timestamptz,
  received_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ep_messages_provider_id
  ON event_partner_messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ep_messages_thread ON event_partner_messages(thread_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ep_messages_class  ON event_partner_messages(classification);
CREATE INDEX IF NOT EXISTS idx_ep_messages_retain ON event_partner_messages(retain_until)
  WHERE redacted_at IS NULL AND retain_until IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 3. event_partner_suppressions — outreach suppression, scoped to THIS program.
-- ---------------------------------------------------------------------------------------------
-- Deliberately separate from email_suppressions (consumer marketing) and from the authorization
-- registry. A STOP here halts Event Partner outreach and says NOTHING about an already-granted
-- collection permission or about consumer marketing consent. The send path honours BOTH this table
-- and the global email_suppressions table — either one is a hard stop.
CREATE TABLE IF NOT EXISTS event_partner_suppressions (
  normalized_email text        PRIMARY KEY,
  email            text,
  reason           text        NOT NULL
    CHECK (reason IN ('stop_request','decline','hard_bounce','complaint','wrong_contact','admin','compliance')),
  source           text        NOT NULL DEFAULT 'inbound_reply',
  organization_id  uuid        REFERENCES organizations(id) ON DELETE SET NULL,
  message_id       uuid        REFERENCES event_partner_messages(id) ON DELETE SET NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- 4. event_partner_templates — an approved message template VERSION is a database fact.
-- ---------------------------------------------------------------------------------------------
-- The send gate requires an approved template version. Content lives here so approving a template is
-- an auditable act rather than a code deploy, and so a template cannot be edited after approval
-- without producing a new, unapproved version.
CREATE TABLE IF NOT EXISTS event_partner_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text        NOT NULL,
  version      integer     NOT NULL,
  purpose      text        NOT NULL
    CHECK (purpose IN ('initial_outreach','authorization_resend','faq_reply','claim_invitation','verification_request')),
  subject      text        NOT NULL,
  body_text    text        NOT NULL,
  body_html    text,
  status       text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  approved_by  uuid        REFERENCES users(id),
  approved_at  timestamptz,
  notes        text,
  created_by   uuid        REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_key, version)
);
CREATE INDEX IF NOT EXISTS idx_ep_templates_status ON event_partner_templates(template_key, status);

-- ---------------------------------------------------------------------------------------------
-- 5. event_partner_cohorts (+ members) — the approved-cohort lock.
-- ---------------------------------------------------------------------------------------------
-- Lock #1 of the double lock. The send path refuses any recipient who is not a member of a cohort
-- that is approved, unexpired, and bound to an approved template version. Policy alone is not a gate;
-- this table is.
--
-- `autonomous_allowed` is the forward path the Owner asked for: after proven operation, the Marketing
-- Director may operate an approved cohort without per-company approval. It defaults FALSE, so the
-- pilot remains human-approved.
CREATE TABLE IF NOT EXISTS event_partner_cohorts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  description         text,
  status              text        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','active','paused','closed','expired')),
  template_id         uuid        REFERENCES event_partner_templates(id) ON DELETE SET NULL,
  max_sends           integer     NOT NULL DEFAULT 25,
  sends_used          integer     NOT NULL DEFAULT 0,
  daily_send_cap      integer     NOT NULL DEFAULT 10,
  autonomous_allowed  boolean     NOT NULL DEFAULT false,
  approved_by         uuid        REFERENCES users(id),
  approved_at         timestamptz,
  expires_at          timestamptz,
  notes               text,
  created_by          uuid        REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ep_cohorts_status ON event_partner_cohorts(status);

-- An approved cohort must name the approver and the moment, and must carry an approved template.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ep_cohort_approval_complete') THEN
    ALTER TABLE event_partner_cohorts
      ADD CONSTRAINT chk_ep_cohort_approval_complete
      CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND template_id IS NOT NULL));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_partner_cohort_members (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id                 uuid        NOT NULL REFERENCES event_partner_cohorts(id) ON DELETE CASCADE,
  authorization_id          uuid        REFERENCES authorized_event_sources(id) ON DELETE CASCADE,
  organization_id           uuid        REFERENCES organizations(id) ON DELETE SET NULL,
  recipient_email           text        NOT NULL,
  recipient_email_normalized text       NOT NULL,
  status                    text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','eligible','sent','skipped','failed','suppressed')),
  skip_reason               text,
  sent_at                   timestamptz,
  added_by                  uuid        REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, recipient_email_normalized)
);
CREATE INDEX IF NOT EXISTS idx_ep_cohort_members_cohort ON event_partner_cohort_members(cohort_id, status);

-- ---------------------------------------------------------------------------------------------
-- 6. event_partner_outreach_proposals — what A15 is allowed to produce.
-- ---------------------------------------------------------------------------------------------
-- A15 may PROPOSE. A human approves. Nothing sends from a proposal alone; the send gate still
-- re-checks every lock at send time. The rendered subject/body are snapshotted so what was approved is
-- exactly what could later be sent.
CREATE TABLE IF NOT EXISTS event_partner_outreach_proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id        uuid        REFERENCES event_partner_cohorts(id) ON DELETE CASCADE,
  authorization_id uuid        REFERENCES authorized_event_sources(id) ON DELETE CASCADE,
  thread_id        uuid        REFERENCES event_partner_threads(id) ON DELETE SET NULL,
  template_id      uuid        REFERENCES event_partner_templates(id) ON DELETE SET NULL,
  kind             text        NOT NULL DEFAULT 'initial_outreach'
    CHECK (kind IN ('initial_outreach','authorization_resend','faq_reply','claim_invitation')),
  recipient_email  text,
  subject          text        NOT NULL,
  body_text        text        NOT NULL,
  body_html        text,
  status           text        NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','rejected','superseded','sent')),
  proposed_by      text        NOT NULL DEFAULT 'A15',
  approved_by      uuid        REFERENCES users(id),
  approved_at      timestamptz,
  rejected_reason  text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ep_proposals_status ON event_partner_outreach_proposals(status, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 7. event_partner_escalations — the human queue.
-- ---------------------------------------------------------------------------------------------
-- Anything the system must not decide alone lands here: a legal or rights concern, an ambiguous
-- reply, a corrected website (which re-scopes permission), a disputed request, a Path D/E
-- self-service request. Nothing in this table is auto-resolved.
CREATE TABLE IF NOT EXISTS event_partner_escalations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        uuid        REFERENCES event_partner_threads(id) ON DELETE CASCADE,
  message_id       uuid        REFERENCES event_partner_messages(id) ON DELETE SET NULL,
  authorization_id uuid        REFERENCES authorized_event_sources(id) ON DELETE SET NULL,
  request_id       uuid,       -- FK added after event_partner_requests exists (see below)
  reason_code      text        NOT NULL,
  severity         text        NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high')),
  summary          text,
  status           text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_review','resolved','dismissed')),
  assigned_to      uuid        REFERENCES users(id),
  resolution       text,
  resolved_by      uuid        REFERENCES users(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ep_escalations_status ON event_partner_escalations(status, severity, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 8. event_partner_requests — the public self-service door + the lightweight trust ladder.
-- ---------------------------------------------------------------------------------------------
-- The form collects four fields and nothing else: company name, company website, requester name,
-- requester email. `trust_path` records WHICH rung of the ladder decided the outcome, and `signals`
-- records why — so a decision to issue (or withhold) an authorization link is always explainable.
--
-- Critical invariant: a request NEVER authorizes anything. At most it becomes eligible for an
-- authorization link, which is still the deterministic single-use Phase 1 grant.
CREATE TABLE IF NOT EXISTS event_partner_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name              text        NOT NULL,
  company_website           text        NOT NULL,
  requested_domain          text        NOT NULL,
  requester_name            text,
  requester_email           text        NOT NULL,
  requester_email_normalized text       NOT NULL,
  -- a_domain_match | b_official_contact | c_trusted_relationship | d_admin_review | e_blocked
  trust_path                text
    CHECK (trust_path IS NULL OR trust_path IN
          ('a_domain_match','b_official_contact','c_trusted_relationship','d_admin_review','e_blocked')),
  status                    text        NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','awaiting_company_confirmation','verified','needs_admin','approved','rejected','authorized','withdrawn')),
  -- Path B: the official address discovered on the company's OWN public website. The confirmation
  -- link goes here, never to the requester's mailbox.
  official_contact_email    text,
  official_contact_source   text,
  verification_sent_at      timestamptz,
  verified_at               timestamptz,
  verified_via              text
    CHECK (verified_via IS NULL OR verified_via IN ('domain_match','official_contact_link','trusted_relationship','admin_approval')),
  organization_id           uuid        REFERENCES organizations(id) ON DELETE SET NULL,
  authorization_id          uuid        REFERENCES authorized_event_sources(id) ON DELETE SET NULL,
  signals                   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  admin_notes               text,
  reviewed_by               uuid        REFERENCES users(id),
  reviewed_at               timestamptz,
  rejected_reason           text,
  ip_hash                   text,
  user_agent                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ep_requests_status ON event_partner_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ep_requests_domain ON event_partner_requests(requested_domain);

-- Late-bound FKs (the referencing tables were created first so the file reads top-down).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ep_threads_request') THEN
    ALTER TABLE event_partner_threads
      ADD CONSTRAINT fk_ep_threads_request FOREIGN KEY (request_id)
      REFERENCES event_partner_requests(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ep_escalations_request') THEN
    ALTER TABLE event_partner_escalations
      ADD CONSTRAINT fk_ep_escalations_request FOREIGN KEY (request_id)
      REFERENCES event_partner_requests(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 9. event_partner_request_tokens — the Path B confirmation link.
-- ---------------------------------------------------------------------------------------------
-- Same discipline as every other token in this program: 32 bytes of randomness, stored only as
-- sha256, bound to one recipient, expiring, single-use, attempt-counted. Confirming it proves that
-- somebody at the company's OWN published address approved the request. It does not authorize.
CREATE TABLE IF NOT EXISTS event_partner_request_tokens (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                 uuid        NOT NULL REFERENCES event_partner_requests(id) ON DELETE CASCADE,
  token_hash                 text        NOT NULL UNIQUE,
  recipient_email_normalized text        NOT NULL,
  purpose                    text        NOT NULL DEFAULT 'verify_contact'
    CHECK (purpose IN ('verify_contact')),
  expires_at                 timestamptz NOT NULL,
  used_at                    timestamptz,
  used_ip_hash               text,
  attempts                   integer     NOT NULL DEFAULT 0,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ep_request_tokens_request ON event_partner_request_tokens(request_id);
CREATE INDEX IF NOT EXISTS idx_ep_request_tokens_expires ON event_partner_request_tokens(expires_at);

-- ---------------------------------------------------------------------------------------------
-- 10. event_partner_webhook_deliveries — provider callback evidence + replay protection.
-- ---------------------------------------------------------------------------------------------
-- Every provider callback, verified or rejected, is recorded. A forged or invalid callback is stored
-- as rejected rather than silently dropped, so an attack is visible. UNIQUE on the payload digest
-- gives replay protection independent of the provider's own message id.
CREATE TABLE IF NOT EXISTS event_partner_webhook_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text        NOT NULL,
  event_kind          text,
  payload_sha256      text        NOT NULL,
  signature_status    text        NOT NULL
    CHECK (signature_status IN ('verified','unsigned_accepted','rejected_signature','rejected_secret','rejected_source','verify_unavailable')),
  outcome             text        NOT NULL
    CHECK (outcome IN ('accepted','duplicate','rejected','ignored','error')),
  message_id          uuid        REFERENCES event_partner_messages(id) ON DELETE SET NULL,
  remote_ip_hash      text,
  detail              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ep_webhook_payload ON event_partner_webhook_deliveries(provider, payload_sha256);
CREATE INDEX IF NOT EXISTS idx_ep_webhook_created ON event_partner_webhook_deliveries(created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 11. A15 — read-only classification and threading. Still no send authority.
-- ---------------------------------------------------------------------------------------------
-- Added: classify_inbound_reply, record_reply_thread, draft_partner_reply.
-- NOT added (and not grantable in 2A): send_approved_outreach, send_templated_reply, and anything
-- that could grant, broaden or re-scope permission, grant listing ownership, spend, publish
-- unrelated marketing, or answer normal seller/customer service messages.
UPDATE marketing_agents
   SET capabilities = '["draft_partner_outreach","propose_partner_outreach","read_partner_metrics",
                        "classify_inbound_reply","record_reply_thread","draft_partner_reply"]'::jsonb,
       can_publish = false, can_spend = false, can_review = false
 WHERE code = 'A15';

-- ---------------------------------------------------------------------------------------------
-- 12. Owner gates. Every new one ships OFF / at its safe value.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  -- Accept inbound provider callbacks at all. OFF: the webhook answers 404 and stores nothing.
  ('event_partners.inbound_enabled',            'false', 'event_partners'),
  -- The public self-service request form. OFF: the page renders, the endpoint refuses.
  ('event_partners.self_service_enabled',       'false', 'event_partners'),
  -- A15 may attach an advisory classification to an inbound message. OFF: deterministic handling only.
  ('event_partners.a15_classify_enabled',       'false', 'event_partners'),
  -- A15 may draft (never send) a reply. OFF.
  ('event_partners.a15_draft_reply_enabled',    'false', 'event_partners'),
  -- Provider signature verification is REQUIRED by default. A genuine bad signature is always
  -- rejected; only an infrastructure failure to fetch a signing certificate can fail open, and that
  -- is recorded as verify_unavailable rather than as verified.
  ('event_partners.webhook_signature_required', 'true',  'event_partners'),
  -- How long an inbound body is retained before the retention sweep clears it. The classification,
  -- the headers we rely on, and the evidence fingerprint are kept indefinitely.
  ('event_partners.raw_message_retention_days', '90',    'event_partners'),
  -- Hard ceiling on partner outreach per UTC day, independent of any cohort's own cap.
  ('event_partners.daily_send_ceiling',         '25',    'event_partners')
ON CONFLICT (key) DO NOTHING;

COMMIT;
