-- 211_retail_gallery_studio_seller_type.sql
-- Owner decision 2026-11-02: a professional seller type "Retail Shop, Gallery or Studio" (retail_gallery_studio) for
-- antique shops, boutiques, vintage dealers, galleries, working artists and makers, and specialty retailers.
--
-- Only widens two CHECK constraints so the value can be stored. No row changes. The classification (professional), the
-- fee rules, the verification publication gate and the agreement come from code (src/constants/sellerTypes.js), and the
-- agreement is the existing general Seller Agreement (resolveActiveTemplateId falls back to it when no type-specific
-- template exists), so this type receives the same agreement and commercial terms as every professional seller.
--
-- Rollback (only while no row uses the value):
--   ALTER TABLE seller_profiles DROP CONSTRAINT seller_profiles_seller_type_check;
--   ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_seller_type_check CHECK (seller_type IN
--     ('business','private','other','auction_house','estate_sale_company','professional_liquidator'));
--   ALTER TABLE agreement_templates DROP CONSTRAINT agreement_templates_agreement_type_check;
--   ALTER TABLE agreement_templates ADD CONSTRAINT agreement_templates_agreement_type_check CHECK (agreement_type IN
--     ('private','business','auction_house','estate_sale_company','professional_liquidator','custom'));

ALTER TABLE seller_profiles DROP CONSTRAINT IF EXISTS seller_profiles_seller_type_check;
ALTER TABLE seller_profiles
  ADD CONSTRAINT seller_profiles_seller_type_check
  CHECK (seller_type IN (
    'business','private','other',
    'auction_house','estate_sale_company','professional_liquidator','retail_gallery_studio'
  ));

DO $$ BEGIN
  IF to_regclass('agreement_templates') IS NOT NULL THEN
    ALTER TABLE agreement_templates DROP CONSTRAINT IF EXISTS agreement_templates_agreement_type_check;
    ALTER TABLE agreement_templates
      ADD CONSTRAINT agreement_templates_agreement_type_check
      CHECK (agreement_type IN (
        'private','business','auction_house','estate_sale_company','professional_liquidator','retail_gallery_studio','custom'
      ));
  END IF;
END $$;
