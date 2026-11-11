-- 230_seller_inquiry_item.sql
-- A buyer's question about a specific fixed-price item (owner 2026-11-10): the item page's Contact Seller always works,
-- whether or not the seller's storefront page is published. The inquiry goes into the seller's existing inquiry inbox
-- (seller_inquiries, migration 119) and records which item it is about.
--
-- Additive only: one nullable column and an index. No existing row is changed.
--
-- Rollback: DROP INDEX IF EXISTS idx_seller_inquiries_item; ALTER TABLE seller_inquiries DROP COLUMN marketplace_item_id;

BEGIN;

ALTER TABLE seller_inquiries ADD COLUMN IF NOT EXISTS marketplace_item_id uuid REFERENCES marketplace_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_seller_inquiries_item ON seller_inquiries (marketplace_item_id) WHERE marketplace_item_id IS NOT NULL;

COMMIT;
