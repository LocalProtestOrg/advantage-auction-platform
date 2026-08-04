-- 103_professional_memberships.sql — additive + idempotent.
--
-- Phase 2A: Railway-native professional membership billing (first type: Appraiser, $19.99/yr).
--
-- Design goals:
--   * BILLING source-of-truth for recurring professional memberships. No existing table holds Stripe
--     subscription state (customer/subscription/price/status/period/cancel_at_period_end), so this is a
--     new, purpose-built table. It is intentionally GENERIC (membership_type + capability_key) so future
--     professional memberships (auction_house, estate_sale_company, professional_liquidator, ...) reuse
--     the SAME table + the SAME organization-capability grant, with no parallel billing system.
--   * ACCESS is granted through the EXISTING additive capability system (organization_capabilities),
--     never by mutating users.role. The paying user stays the org owner; buyer/seller/admin rights are
--     untouched; admins bypass capability checks. This row only records billing; capabilityService
--     grants/revokes the capability from verified Stripe status.
--
-- Status values mirror Stripe subscription.status so we never invent a conflicting second status system.
-- Membership is derived ONLY from verified Stripe webhooks (never a client success redirect).

-- 1) Catalog the 'appraiser' capability (organization_capabilities.capability references capabilities.key).
INSERT INTO capabilities (key, name, description, sort_order) VALUES
  ('appraiser', 'Appraiser', 'Appraiser professional membership and directory profile', 100)
ON CONFLICT (key) DO NOTHING;

-- 2) The billing table.
CREATE TABLE IF NOT EXISTS professional_memberships (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id),           -- billing/subscription owner
  organization_id        UUID REFERENCES organizations(id),            -- capability owner + public directory profile
  membership_type        TEXT NOT NULL DEFAULT 'appraiser',            -- reusable discriminator (appraiser, auction_house, ...)
  capability_key         TEXT NOT NULL DEFAULT 'appraiser' REFERENCES capabilities(key),
  status                 TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id        TEXT,
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One membership per (user, type): re-subscribing UPSERTs the same row (no duplicate entitlements).
CREATE UNIQUE INDEX IF NOT EXISTS ux_prof_memberships_user_type
  ON professional_memberships (user_id, membership_type);

-- A Stripe subscription maps to exactly one membership row (idempotent webhook upserts).
CREATE UNIQUE INDEX IF NOT EXISTS ux_prof_memberships_subscription
  ON professional_memberships (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prof_memberships_org      ON professional_memberships (organization_id);
CREATE INDEX IF NOT EXISTS idx_prof_memberships_customer ON professional_memberships (stripe_customer_id);
