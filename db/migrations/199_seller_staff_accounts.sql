-- 199: Professional Seller staff accounts (owner-approved design 2026-10-16; docs/projects/seller-staff-permissions-design-2026-10-16.md).
-- ADDITIVE / IDEMPOTENT. Moves no money and changes no existing row. Nothing is active until SELLER_STAFF_ENABLED=true.
--   • A staff member belongs to exactly ONE seller company with ONE role (owner decision: one company per person).
--     The owner is never a staff row; the owner stays seller_profiles.user_id.
--   • A membership never moves to another company or another person; its email and creation are fixed; status only
--     moves forward (invited → active | revoked | expired; active ⇄ suspended → removed). Rows are never deleted.
--   • Staff history is append-only and always names the membership's own company (composite key, same pattern as 197).
--   • Sensitive owner actions (inviting staff, changing roles, removing staff, payout changes) need a fresh step-up:
--     the account password plus a one-time code to the owner's verified phone (seller_step_up_challenges).

CREATE TABLE IF NOT EXISTS seller_staff_members (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id          UUID NOT NULL REFERENCES seller_profiles(id),
  user_id            UUID REFERENCES users(id),                 -- set when the invitation is accepted
  invited_email      TEXT NOT NULL CHECK (invited_email = lower(invited_email) AND length(invited_email) BETWEEN 3 AND 320),
  role               TEXT NOT NULL CHECK (role IN ('inventory_manager','fulfillment','finance')),
  status             TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','removed','revoked','expired')),
  invite_token_hash  TEXT UNIQUE,
  invite_expires_at  TIMESTAMPTZ,
  invited_by         UUID NOT NULL REFERENCES users(id),
  invited_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at        TIMESTAMPTZ,
  removed_by         UUID REFERENCES users(id),
  removed_at         TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_seller_staff_members_id_seller UNIQUE (id, seller_id),
  CONSTRAINT seller_staff_members_active_has_user CHECK (status NOT IN ('active','suspended','removed') OR user_id IS NOT NULL)
);
-- One company per person: at most one active or suspended membership for any account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_staff_one_company_per_user ON seller_staff_members (user_id) WHERE status IN ('active','suspended');
-- One open invitation per email per company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_staff_open_invite ON seller_staff_members (seller_id, invited_email) WHERE status = 'invited';
CREATE INDEX IF NOT EXISTS idx_seller_staff_members_seller ON seller_staff_members (seller_id, status);

CREATE OR REPLACE FUNCTION seller_staff_members_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seller staff memberships are kept permanently' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'invited' OR NEW.user_id IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a staff membership starts as an invitation' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM seller_profiles sp WHERE sp.id = NEW.seller_id AND sp.user_id = NEW.invited_by) THEN
      RAISE EXCEPTION 'only the company owner can invite staff' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id OR NEW.invited_email IS DISTINCT FROM OLD.invited_email
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by OR NEW.invited_at IS DISTINCT FROM OLD.invited_at
     OR (OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'a staff membership keeps its company, person and invitation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'invited'   AND NEW.status IN ('active','revoked','expired'))
    OR (OLD.status = 'active'    AND NEW.status IN ('suspended','removed'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('active','removed'))) THEN
    RAISE EXCEPTION 'staff membership status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id IS NOT NULL AND OLD.user_id IS NULL THEN
    -- The company owner (or the owner of any company) cannot also be staff.
    IF EXISTS (SELECT 1 FROM seller_profiles sp WHERE sp.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'a seller company owner cannot be staff of a company' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_seller_staff_members_guard ON seller_staff_members;
CREATE TRIGGER trg_seller_staff_members_guard BEFORE INSERT OR UPDATE OR DELETE ON seller_staff_members
  FOR EACH ROW EXECUTE FUNCTION seller_staff_members_guard();

-- ── Staff history (append-only) ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seller_staff_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      UUID NOT NULL,
  seller_id      UUID NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('invited','invite_resent','invite_revoked','invite_expired','accepted',
                                                 'role_changed','suspended','reinstated','removed','sensitive_action')),
  actor_user_id  UUID,
  actor_role     TEXT NOT NULL CHECK (actor_role IN ('owner','staff','admin','system')),
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_seller_staff_events_member_seller FOREIGN KEY (member_id, seller_id) REFERENCES seller_staff_members (id, seller_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_staff_events_seller ON seller_staff_events (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_staff_events_member ON seller_staff_events (member_id, created_at);

CREATE OR REPLACE FUNCTION seller_staff_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'seller staff history is append-only' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS trg_seller_staff_events_guard ON seller_staff_events;
CREATE TRIGGER trg_seller_staff_events_guard BEFORE UPDATE OR DELETE ON seller_staff_events
  FOR EACH ROW EXECUTE FUNCTION seller_staff_events_guard();

-- ── Step-up verification for sensitive owner actions ─────────────────────────────────────────────────
-- A challenge is created only after the account password is confirmed; it is approved by a one-time code sent to the
-- owner's verified phone, and the approval lasts a few minutes for that sign-in session only. Codes are never stored
-- (HMAC only, or the phone-verification service's reference).
CREATE TABLE IF NOT EXISTS seller_step_up_challenges (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  seller_id      UUID NOT NULL REFERENCES seller_profiles(id),
  session_sid    TEXT NOT NULL,
  phone_last4    TEXT,
  provider       TEXT NOT NULL CHECK (provider IN ('twilio_verify','local_test')),
  provider_ref   TEXT,
  code_hash      TEXT,
  status         TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','approved','failed','expired','superseded','send_failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  expires_at     TIMESTAMPTZ NOT NULL,
  approved_at    TIMESTAMPTZ,
  granted_until  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_step_up_user ON seller_step_up_challenges (user_id, created_at DESC);
