-- 116: Sales Prospect CRM — extend sales_prospects into a full outreach work-queue.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Adds CRM + classification + dedup columns to the existing
-- sales_prospects table (migration 111). No column is dropped or renamed; existing rows keep their values.
--
-- ARCHITECTURAL RULE (sections 25/26): RESEARCH data and SALES-ACTIVITY (CRM) data are separated so a
-- future research REFRESH never overwrites a rep's work. The import/refresh path writes ONLY the research
-- columns below; the CRM-activity columns (contact_status, assigned_rep_user_id, last_contact_at,
-- last_contacted_by_user_id, next_follow_up_at, and sales_prospect_notes) are NEVER touched by import.

-- ── RESEARCH / CLASSIFICATION (safe to refresh) ────────────────────────────────────────────────────
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS business_type    TEXT;  -- 'estate_sale_company'|'auction_house'|'other'
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS opportunity_type TEXT;  -- 'both'|'website'|'online_auction'|'general'
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS lead_priority    TEXT;  -- 'hot'|'warm'|'standard' (derived; manual override locks it)
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS priority_locked  BOOLEAN NOT NULL DEFAULT false;  -- true = rep set priority manually
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS contact_source   TEXT;  -- where the phone/email was found (provenance)
-- dedup keys (derived from name/website/phone; used to prevent duplicate businesses)
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS normalized_name  TEXT;
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS website_domain   TEXT;
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS normalized_phone TEXT;

-- ── CRM ACTIVITY (never touched by research refresh) ───────────────────────────────────────────────
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS last_contacted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- ── Actionable = has at least one outreach method (phone OR email). DB-enforced, never fabricated. ──
-- Every ACTIONABLE prospect necessarily has a phone or email; a research lead with neither is is_actionable=false.
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS is_actionable BOOLEAN
  GENERATED ALWAYS AS (
    (business_phone IS NOT NULL AND btrim(business_phone) <> '') OR
    (business_email IS NOT NULL AND btrim(business_email) <> '')
  ) STORED;

-- ── Light backfill of dedup keys for existing rows (JS import path keeps them current thereafter) ──
UPDATE sales_prospects
   SET normalized_name = NULLIF(regexp_replace(lower(company_name), '[^a-z0-9]+', '', 'g'), '')
 WHERE normalized_name IS NULL AND company_name IS NOT NULL;
UPDATE sales_prospects
   SET website_domain = NULLIF(lower(regexp_replace(regexp_replace(website, '^https?://', '', 'i'), '^www\.', '', 'i')), '')
 WHERE website_domain IS NULL AND website IS NOT NULL AND website <> '';
-- strip a trailing path from the backfilled domain (keep host only)
UPDATE sales_prospects
   SET website_domain = split_part(website_domain, '/', 1)
 WHERE website_domain LIKE '%/%';
UPDATE sales_prospects
   SET normalized_phone = NULLIF(regexp_replace(business_phone, '[^0-9]', '', 'g'), '')
 WHERE normalized_phone IS NULL AND business_phone IS NOT NULL AND business_phone <> '';
-- normalize US 11-digit (leading 1) to 10 digits for dedup
UPDATE sales_prospects
   SET normalized_phone = substr(normalized_phone, 2)
 WHERE length(normalized_phone) = 11 AND left(normalized_phone, 1) = '1';

-- ── Indexes (dedup lookups + work-queue filters) ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sales_prospects_norm_name    ON sales_prospects (normalized_name);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_domain       ON sales_prospects (website_domain) WHERE website_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_prospects_norm_phone   ON sales_prospects (normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_prospects_actionable   ON sales_prospects (is_actionable);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_priority     ON sales_prospects (lead_priority);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_biz_type     ON sales_prospects (business_type);
CREATE INDEX IF NOT EXISTS idx_sales_prospects_followup     ON sales_prospects (next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;
