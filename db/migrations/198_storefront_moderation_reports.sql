-- 198: Professional Storefront milestone 2 — listing moderation and buyer item reports.
-- ADDITIVE / IDEMPOTENT. Moves no money and changes no existing value (every item starts with moderation_status 'none').
--   • An administrator may take a listing down (and restore it) with a written reason; every action is kept permanently
--     in marketplace_item_moderation_events, which always names the item's real seller.
--   • A taken-down listing can never be live (database check), so a seller cannot put it back on sale.
--   • Buyers may report a listing; a report is tied to the item's real seller (composite key) and its words never change.
-- Same integrity pattern as migration 197: parties come from the referenced row and are enforced by foreign keys.

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS moderation_reason TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS moderated_by      UUID;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS moderated_at      TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_moderation_status_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_moderation_status_check
      CHECK (moderation_status IN ('none','taken_down'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_taken_down_not_live') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_taken_down_not_live
      CHECK (moderation_status <> 'taken_down' OR status NOT IN ('active','pending_purchase'));
  END IF;
END $$;

-- ── Moderation history (append-only) ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_item_moderation_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL,
  seller_id      UUID NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('takedown','restore','report_dismissed','report_actioned')),
  actor_user_id  UUID NOT NULL,
  reason         TEXT NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  prior_status   TEXT,
  report_id      UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_item_moderation_events_item_seller FOREIGN KEY (item_id, seller_id) REFERENCES marketplace_items (id, seller_id)
);
CREATE INDEX IF NOT EXISTS idx_item_moderation_events_item ON marketplace_item_moderation_events (item_id, created_at);

-- ── Buyer reports about a listing ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_item_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id          UUID NOT NULL,
  seller_id        UUID NOT NULL,
  reporter_user_id UUID NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('prohibited_item','counterfeit','misleading','wrong_category','offensive','other')),
  message          TEXT NOT NULL CHECK (length(message) BETWEEN 5 AND 2000),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  review_note      TEXT,
  reviewed_by      UUID,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_item_reports_item_seller FOREIGN KEY (item_id, seller_id) REFERENCES marketplace_items (id, seller_id)
);
CREATE INDEX IF NOT EXISTS idx_item_reports_status ON marketplace_item_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_reports_item ON marketplace_item_reports (item_id);
-- One open report per person per listing (repeat clicks are harmless).
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_reports_open_per_reporter ON marketplace_item_reports (item_id, reporter_user_id) WHERE status = 'open';

CREATE OR REPLACE FUNCTION marketplace_moderation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'marketplace_item_moderation_events' THEN
    RAISE EXCEPTION 'moderation history is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'listing reports are kept permanently' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.message IS DISTINCT FROM OLD.message OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a listing report keeps its listing, seller, reporter and words' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a reviewed listing report cannot be reopened' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_item_moderation_events_guard ON marketplace_item_moderation_events;
CREATE TRIGGER trg_item_moderation_events_guard BEFORE UPDATE OR DELETE ON marketplace_item_moderation_events
  FOR EACH ROW EXECUTE FUNCTION marketplace_moderation_guard();
DROP TRIGGER IF EXISTS trg_item_reports_guard ON marketplace_item_reports;
CREATE TRIGGER trg_item_reports_guard BEFORE UPDATE OR DELETE ON marketplace_item_reports
  FOR EACH ROW EXECUTE FUNCTION marketplace_moderation_guard();
