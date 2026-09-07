-- 137_professional_pricing_agreements.sql — Dedicated Professional Seller NEGOTIATED-PRICING agreement
-- authoring / acceptance / versioning / audit. ADDITIVE + idempotent + production-safe.
--
-- WHAT THIS IS: the authoritative, versioned, immutable-on-acceptance record of a professional seller's
-- negotiated Advantage.Bid PLATFORM/SOFTWARE fee. It does NOT introduce a parallel pricing engine — the
-- RESOLVED current rate continues to live on seller_profiles.platform_fee_bps (kept in sync when an
-- agreement is accepted and effective), so the EXISTING publish-time snapshot (auctions.platform_fee_bps)
-- and settlement engine are reused unchanged. Historical auctions/payouts read their FROZEN snapshot and
-- are never affected by a later agreement/version.
--
-- SEPARATION OF CONCERNS (owner rule): the 4% platform/software fee and the 3% payment-processing fee are
-- DISTINCT. This agreement negotiates ONLY the platform fee; the processing fee is recorded here for a
-- transparent record but is never negotiated and never collapses into a "7% total". Buyer premium is
-- seller-configurable and lives elsewhere (seller_terms) — untouched here. Storefront (11%) and Individual
-- seller economics are NOT governed by this table.

CREATE TABLE IF NOT EXISTS professional_pricing_agreements (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_profile_id          UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  version                    INTEGER NOT NULL,                 -- per-seller incrementing version (1,2,3,…)
  agreement_ref              TEXT NOT NULL,                    -- human identifier, e.g. PSA-<seller8>-v2
  status                     TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('draft','pending','accepted','superseded','expired','revoked')),

  -- Negotiated economics PRESENTED (frozen at issuance; immutable once accepted). Basis points.
  platform_fee_bps           INTEGER NOT NULL CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 2500),
  processing_fee_bps         INTEGER NOT NULL,                 -- processing terms AS PRESENTED (recorded, NOT negotiated)
  processing_basis           TEXT NOT NULL DEFAULT 'standard_passthrough',
  standard_platform_fee_bps  INTEGER,                          -- sitewide default at issuance (Standard vs Negotiated display)
  is_negotiated              BOOLEAN NOT NULL DEFAULT false,   -- platform_fee_bps differs from the sitewide standard
  effective_date             DATE NOT NULL,                    -- when the negotiated rate applies from

  -- Human-facing, plain-language record (Stupid-Easy transparency; not internal pricing-engine jargon).
  terms_summary              TEXT,
  legal_terms_version        TEXT,                             -- applicable Professional Seller Terms version
  pricing_snapshot           JSONB,                            -- full presented pricing frozen at issuance (immutable)

  -- Lifecycle attribution (audit-grade).
  issued_at                  TIMESTAMPTZ,
  issued_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at                TIMESTAMPTZ,
  accepted_by_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_ip                TEXT,
  accepted_user_agent        TEXT,
  superseded_by_id           UUID REFERENCES professional_pricing_agreements(id) ON DELETE SET NULL,
  superseded_at              TIMESTAMPTZ,
  expires_at                 TIMESTAMPTZ,                      -- optional acceptance deadline for a pending offer
  expired_at                 TIMESTAMPTZ,
  revoked_at                 TIMESTAMPTZ,
  revoke_reason              TEXT,
  created_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (seller, version). Versions never collide; history is preserved.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_agreement_seller_version
  ON professional_pricing_agreements(seller_profile_id, version);
CREATE INDEX IF NOT EXISTS idx_pricing_agreement_seller
  ON professional_pricing_agreements(seller_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_agreement_status
  ON professional_pricing_agreements(status);
-- Fast "is there an accepted, effective agreement?" lookup for the publish-time resolver.
CREATE INDEX IF NOT EXISTS idx_pricing_agreement_accepted_effective
  ON professional_pricing_agreements(seller_profile_id, effective_date DESC)
  WHERE status = 'accepted';
