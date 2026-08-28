-- 117: Representative-based prospect CRM outreach.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Two tables:
--   • sales_rep_profiles    — an approved Advantage.Bid OUTREACH IDENTITY per authorized Sales staff user
--     (display name + approved @advantage.bid reply-to email + enabled flag). This is NOT users.email
--     (their login); it is the server-approved sender identity. Only Admin can create/edit these.
--   • sales_outreach_emails — the authoritative CRM record of each 1:1 prospect outreach email sent
--     through Advantage.Bid (who sent, as which rep identity, to whom, subject/template, body snapshot,
--     and the truthfully-knowable status). One row per send attempt; history is never overwritten.

CREATE TABLE IF NOT EXISTS sales_rep_profiles (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name       TEXT NOT NULL,
  outreach_email     TEXT NOT NULL,                 -- approved @advantage.bid Reply-To identity
  outreach_enabled   BOOLEAN NOT NULL DEFAULT true, -- Admin can disable outreach without deleting the profile
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_rep_profiles_email ON sales_rep_profiles (lower(outreach_email));

CREATE TABLE IF NOT EXISTS sales_outreach_emails (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id         UUID NOT NULL REFERENCES sales_prospects(id) ON DELETE CASCADE,
  rep_user_id         UUID REFERENCES users(id) ON DELETE SET NULL, -- identity the email was sent AS (assigned rep)
  sent_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL, -- actor who actually clicked Send
  rep_display_name    TEXT,               -- snapshot of the rep display name at send time
  from_email          TEXT,               -- technical From (verified sender)
  from_name           TEXT,               -- friendly From display name
  reply_to_email      TEXT,               -- assigned rep's approved reply-to
  recipient_email     TEXT NOT NULL,      -- prospect business email (from the record, never client-supplied)
  subject             TEXT,
  template_key        TEXT,
  body_snapshot       TEXT,               -- final rendered message (immutable record)
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('draft','queued','sent','failed','bounced')),
  provider_message_id TEXT,               -- SES message id when accepted
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_outreach_prospect ON sales_outreach_emails (prospect_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_outreach_rep      ON sales_outreach_emails (rep_user_id);
CREATE INDEX IF NOT EXISTS idx_sales_outreach_status   ON sales_outreach_emails (status);
