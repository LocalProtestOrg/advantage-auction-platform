-- 229_seller_business_categories.sql
-- Professional Seller business categories (owner decision 2026-11-10): "Professional Seller" is the umbrella
-- classification; a seller describes its business with one or more categories (select all that apply) and can change
-- them later. The categories describe the business and never limit which professional tools it may use.
--
-- Additive only: one new column with an empty default. No existing row is changed; a seller with no categories is
-- described by its existing seller_type (src/constants/businessCategories.js categoriesFor). seller_type, its CHECK
-- constraint and every rule that reads it are unchanged.
--
-- Rollback: ALTER TABLE seller_profiles DROP COLUMN business_categories;

BEGIN;

ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS business_categories text[] NOT NULL DEFAULT '{}'::text[];

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_profiles_business_categories_check') THEN
    ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_business_categories_check
      CHECK (business_categories <@ ARRAY['auction_house','estate_sale_company','professional_liquidator',
                                          'retail_resale','gallery_studio','other_professional']::text[]);
  END IF;
END $$;

COMMIT;
