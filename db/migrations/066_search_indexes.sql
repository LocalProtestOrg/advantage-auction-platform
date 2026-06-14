-- Migration: 066_search_indexes.sql
-- Buyer discovery & search (Phase 2). Additive + idempotent: a text-search
-- extension + trigram (substring/fuzzy) GIN indexes + filter/sort btree indexes.
-- No column or data changes. Safe to re-run.
--
-- Tables are small at pilot scale, so plain CREATE INDEX (brief lock) is fine.
-- For a large production table, prefer CREATE INDEX CONCURRENTLY (cannot run in a
-- transaction) — noted in the cutover/promotion plan.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram indexes — accelerate the substring ILIKE search used by buyer search
-- (auction title/description/city, seller name, lot title/description/maker/category).
CREATE INDEX IF NOT EXISTS idx_auctions_title_trgm       ON auctions       USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_auctions_desc_trgm        ON auctions       USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_auctions_city_trgm        ON auctions       USING gin (city gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sellerprofiles_name_trgm  ON seller_profiles USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_lots_title_trgm           ON lots           USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_lots_desc_trgm            ON lots           USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_lots_maker_trgm           ON lots           USING gin (maker_artist gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_lots_category_trgm        ON lots           USING gin (category gin_trgm_ops);

-- Filter / sort btree indexes for the lot discovery feeds + search.
CREATE INDEX IF NOT EXISTS idx_lots_state_closes    ON lots (state, closes_at);
CREATE INDEX IF NOT EXISTS idx_lots_created         ON lots (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lots_state_bidcount  ON lots (state, bid_count DESC);
CREATE INDEX IF NOT EXISTS idx_lots_category_btree  ON lots (category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auctions_state_addr  ON auctions (address_state, state);
