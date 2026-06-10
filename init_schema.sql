-- =============================================================================
-- ⚠️ DEPRECATED — NOT DEPLOYED — DO NOT BUILD NEW FEATURES FROM THIS FILE
-- -----------------------------------------------------------------------------
-- This is an obsolete/alternate schema. It is NOT the schema used by
-- production or staging. Notably, it defines auctions with seller_profile_id /
-- created_by_user_id / status, which DO NOT match the deployed schema.
--
-- PRODUCTION & STAGING USE: db/migrations/*.sql  (canonical).
--   - auctions ownership is auctions.seller_id → seller_profiles.id →
--     seller_profiles.user_id → users.id  (NOT created_by_user_id).
--   - auctions state column is `state` (NOT `status`).
--
-- Retained pre-launch only to avoid breaking any legacy bootstrap reference.
-- Do not edit this to add features; add migrations under db/migrations/ instead.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
email TEXT NOT NULL UNIQUE,
password_hash TEXT NOT NULL,
role TEXT NOT NULL CHECK (role IN ('admin', 'seller', 'buyer')),
is_active BOOLEAN NOT NULL DEFAULT TRUE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seller_profiles (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
display_name TEXT NOT NULL,
business_name TEXT,
phone TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auctions (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
seller_profile_id UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE RESTRICT,
created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
title TEXT NOT NULL,
description TEXT,
status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'published', 'closed', 'cancelled')),
start_time TIMESTAMPTZ,
end_time TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_seller_profiles_user_id ON seller_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_auctions_seller_profile_id ON auctions(seller_profile_id);
CREATE INDEX IF NOT EXISTS idx_auctions_created_by_user_id ON auctions(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
