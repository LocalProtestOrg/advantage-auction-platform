-- 104_organization_profile_fields.sql — additive + idempotent.
--
-- Phase 3: reusable Professional Profile experience. Rather than ~40 type-specific columns, the
-- extended + type-specific profile fields live in a single JSONB blob (profile_data) validated
-- server-side against src/lib/professionalProfileSchema.js. Every professional type (Appraiser,
-- Auction House, Estate Sale Company, Liquidator, Mover, Clean-out, Consignment, ...) reuses the
-- SAME table + editor; only the applicable sections render. Core identity fields keep their columns.
--
-- Adds:
--   cover_image_url  the public banner (organizations already has logo_url; this adds the cover)
--   profile_data     JSONB bag for tagline/bio/service-area/hours/social/SEO/appraiser fields/etc.
-- Both nullable/defaulted — existing rows unaffected. No users.role change, no billing/Stripe change.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS profile_data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Partial index for the public profile view (published profiles only).
CREATE INDEX IF NOT EXISTS idx_organizations_profile_published
  ON organizations (slug) WHERE (profile_data->>'published') = 'true';
