-- 111_sales_prospects.sql
--
-- Internal Sales & Marketing Toolbox — outbound prospect pipeline. ADDITIVE ONLY, idempotent.
--
-- These are EXTERNAL recruitment targets (estate-sale companies not yet on Advantage.Bid) that a
-- sales rep is researching/contacting. They are intentionally SEPARATE from `organizations` (the
-- canonical on-platform partner/seller records driven by BD sync + the existing Partner CRM at
-- /api/admin/crm). Mixing cold external prospects into `organizations` would pollute marketplace,
-- events, and auth data — so prospects live in their own table until/unless they convert.
--
-- Internal-only data: never exposed on any public page or unauthenticated API (admin-gated routes +
-- htmlAuthGate). Tri-state flags ('yes'|'no'|'unknown') so we never assume "no auction" from a single
-- source that simply didn't mention it.

CREATE TABLE IF NOT EXISTS sales_prospects (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name         TEXT NOT NULL,
  city                 TEXT,
  state                TEXT,               -- 2-letter, uppercased at write
  zip                  TEXT,
  service_area         TEXT,
  business_phone       TEXT,               -- public business contact only
  business_email       TEXT,               -- public business contact only
  website              TEXT,
  website_status       TEXT,               -- 'none' | 'social_only' | 'directory_only' | 'basic' | 'outdated' | 'active' | 'unknown'
  social_url           TEXT,               -- public business social page (e.g. Facebook business)
  source_url           TEXT,               -- where the lead was found (for rep verification)
  estate_sales_offered   TEXT NOT NULL DEFAULT 'unknown', -- 'yes' | 'no' | 'unknown'
  online_auctions_offered TEXT NOT NULL DEFAULT 'unknown',-- 'yes' | 'no' | 'unknown'
  auction_platform_used  TEXT,             -- free text (competitor/platform name) when known
  independent_website    TEXT NOT NULL DEFAULT 'unknown', -- 'yes' | 'no' | 'unknown'
  prospect_tier        SMALLINT,           -- 1 (golden) .. 4 (lower/competitive); derived, stored for filtering
  lead_score           SMALLINT,           -- 0..100; derived, stored for sorting
  contact_status       TEXT NOT NULL DEFAULT 'new_lead',
  assigned_rep_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_contact_at      TIMESTAMPTZ,
  next_follow_up_at    TIMESTAMPTZ,
  source               TEXT DEFAULT 'manual', -- provenance: 'manual' | 'sample_seed' | '<import batch>'
  converted_seller_profile_id UUID REFERENCES seller_profiles(id) ON DELETE SET NULL, -- set when converted
  last_verified_at     TIMESTAMPTZ,
  created_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only activity/notes timeline for a prospect (contact attempts, notes, status changes).
CREATE TABLE IF NOT EXISTS sales_prospect_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  UUID NOT NULL REFERENCES sales_prospects(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL DEFAULT 'note', -- 'note' | 'call' | 'email' | 'sms' | 'demo' | 'status_change'
  body         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Filter/sort indexes for the geographic + pipeline queries the toolbox runs.
CREATE INDEX IF NOT EXISTS idx_sales_prospects_state         ON sales_prospects (state);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_tier          ON sales_prospects (prospect_tier);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_status        ON sales_prospects (contact_status);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_assigned      ON sales_prospects (assigned_rep_user_id);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_score         ON sales_prospects (lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_sales_prospect_notes_prospect ON sales_prospect_notes (prospect_id, created_at DESC);
