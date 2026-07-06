-- 081: Partner CRM Foundation (Phase 3C.1). ADDITIVE / NON-BREAKING.
-- Tracking-first (records outreach via ANY channel), multi-representative ownership, health
-- scoring cache, CRM pipeline stage (separate from lifecycle_state). Extensible for future
-- opportunity scoring / operational metrics / analytics / financial summaries (additive later).
-- No Stripe/settlement/payment/tax. Idempotent.

-- ── Append-only CRM/communication timeline (any channel; complements audit_log) ──
CREATE TABLE IF NOT EXISTS organization_activity (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  activity_type   TEXT NOT NULL DEFAULT 'note'
                    CHECK (activity_type IN ('outreach','note','status_change','task','system')),
  channel         TEXT CHECK (channel IS NULL OR channel IN ('email','phone','sms','meeting','mail','note','other')),
  direction       TEXT NOT NULL DEFAULT 'internal' CHECK (direction IN ('inbound','outbound','internal')),
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  subject         TEXT,
  body            TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_activity_org ON organization_activity(organization_id, occurred_at DESC);

-- ── Multi-representative ownership (many reps per organization) ──
CREATE TABLE IF NOT EXISTS organization_reps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('owner','manager','rep')),
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  assigned_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_reps_org  ON organization_reps(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_reps_user ON organization_reps(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_reps_primary ON organization_reps(organization_id) WHERE is_primary = true;

-- ── CRM pipeline + follow-up + cached health (on organizations) ──
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS crm_stage         TEXT
  CHECK (crm_stage IS NULL OR crm_stage IN ('prospect','contacted','demo_scheduled','interested','claimed','activated','inactive','former','ambassador'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS next_action_at    TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS health_score      INT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS health_computed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_organizations_crm_stage ON organizations(crm_stage) WHERE crm_stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_health    ON organizations(health_score);
