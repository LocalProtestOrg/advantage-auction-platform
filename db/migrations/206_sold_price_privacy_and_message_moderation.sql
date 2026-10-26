-- 206: Sold-item price privacy (owner decision 2026-10-26, roadmap §12.3 P0) and message moderation (hide + report).
-- ADDITIVE / IDEMPOTENT. Moves no money; changes no existing value.
--   • marketplace_items.show_realized_price_to_members: the seller's per-item choice to let signed-in Advantage.Bid
--     members see the realized sale price of a SOLD item. Default OFF for every item (new, converted, imported).
--     Public pages, APIs and structured data never show a sold item's price; the server enforces it.
--   • storefront_messages.hidden_*: an Advantage.Bid moderator may hide an abusive DELIVERED message from the recipient,
--     once, with a reason; the words and the record are kept. Review history gains 'hidden' and 'reported'.

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS show_realized_price_to_members BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE storefront_messages ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE storefront_messages ADD COLUMN IF NOT EXISTS hidden_by UUID REFERENCES users(id);
ALTER TABLE storefront_messages ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_messages_hidden_reason_length') THEN
    ALTER TABLE storefront_messages ADD CONSTRAINT storefront_messages_hidden_reason_length
      CHECK (hidden_reason IS NULL OR length(hidden_reason) BETWEEN 5 AND 1000);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_message_reviews_action_check') THEN
    ALTER TABLE storefront_message_reviews DROP CONSTRAINT storefront_message_reviews_action_check;
  END IF;
  ALTER TABLE storefront_message_reviews ADD CONSTRAINT storefront_message_reviews_action_check
    CHECK (action IN ('released','declined','withdrawn','appealed','hidden','reported'));
END $$;
-- One open report per person per message (repeat clicks are harmless).
CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_message_report_once ON storefront_message_reviews (message_id, actor_user_id) WHERE action = 'reported';

CREATE OR REPLACE FUNCTION storefront_messaging_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  IF TG_TABLE_NAME = 'storefront_conversations' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_demo := COALESCE((SELECT mi.is_demo FROM marketplace_items mi WHERE mi.id = NEW.item_id), false);
      IF EXISTS (SELECT 1 FROM seller_profiles sp WHERE sp.id = NEW.seller_id AND sp.user_id = NEW.buyer_user_id) THEN
        RAISE EXCEPTION 'a seller cannot open a conversation with their own company' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
      IF OLD.is_demo THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'conversations are kept permanently' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.seller_id IS DISTINCT FROM OLD.seller_id OR NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id
       OR NEW.subject_snapshot IS DISTINCT FROM OLD.subject_snapshot OR NEW.is_demo IS DISTINCT FROM OLD.is_demo OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a conversation keeps its seller, item, buyer and subject' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'storefront_messages' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT sc.buyer_user_id, sc.is_demo, sp.user_id AS owner_user_id INTO c
        FROM storefront_conversations sc JOIN seller_profiles sp ON sp.id = sc.seller_id WHERE sc.id = NEW.conversation_id;
      NEW.is_demo := COALESCE(c.is_demo, false);
      -- The sender must be the conversation's own buyer, or the conversation's own seller company (owner or active staff).
      IF NEW.sender_role = 'buyer' AND NEW.sender_user_id IS DISTINCT FROM c.buyer_user_id THEN
        RAISE EXCEPTION 'only the conversation''s buyer can write as the buyer' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.sender_role = 'seller' AND NEW.sender_user_id IS DISTINCT FROM c.owner_user_id
         AND NOT EXISTS (SELECT 1 FROM seller_staff_members m WHERE m.seller_id = NEW.seller_id AND m.user_id = NEW.sender_user_id AND m.status = 'active') THEN
        RAISE EXCEPTION 'only the conversation''s seller company can write as the seller' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.status NOT IN ('delivered','held') THEN
        RAISE EXCEPTION 'a new message is delivered or held for review' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.hidden_at IS NOT NULL OR NEW.hidden_by IS NOT NULL OR NEW.hidden_reason IS NOT NULL THEN
        RAISE EXCEPTION 'a new message is not hidden' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
      IF OLD.is_demo THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'messages are kept permanently' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
       OR NEW.sender_role IS DISTINCT FROM OLD.sender_role OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
       OR NEW.body IS DISTINCT FROM OLD.body OR NEW.screening IS DISTINCT FROM OLD.screening OR NEW.ip_hash IS DISTINCT FROM OLD.ip_hash
       OR NEW.is_demo IS DISTINCT FROM OLD.is_demo OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a message keeps its conversation, sender and words' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.delivered_body IS NOT NULL AND NEW.delivered_body IS DISTINCT FROM OLD.delivered_body THEN
      RAISE EXCEPTION 'a delivered message is never rewritten' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
      RAISE EXCEPTION 'a delivered message keeps its delivery time' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.appealed_at IS DISTINCT FROM OLD.appealed_at OR NEW.appeal_note IS DISTINCT FROM OLD.appeal_note THEN
      IF NOT (OLD.appealed_at IS NULL AND NEW.appealed_at IS NOT NULL AND NEW.appeal_note IS NOT NULL AND OLD.status = 'declined' AND NEW.status = 'held') THEN
        RAISE EXCEPTION 'a message can be appealed once, after a decline' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.decline_reason IS DISTINCT FROM OLD.decline_reason AND NOT (OLD.status = 'held' AND NEW.status = 'declined' AND NEW.decline_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'a decline reason is written only with the decision' USING ERRCODE = 'check_violation';
    END IF;
    -- Hiding by an Advantage.Bid moderator: once, only a delivered message, with who and why; never undone or rewritten.
    IF NEW.hidden_at IS DISTINCT FROM OLD.hidden_at OR NEW.hidden_by IS DISTINCT FROM OLD.hidden_by OR NEW.hidden_reason IS DISTINCT FROM OLD.hidden_reason THEN
      IF NOT (OLD.hidden_at IS NULL AND OLD.hidden_by IS NULL AND OLD.hidden_reason IS NULL AND NEW.hidden_at IS NOT NULL
              AND NEW.hidden_by IS NOT NULL AND NEW.hidden_reason IS NOT NULL AND OLD.status = 'delivered' AND NEW.status = 'delivered') THEN
        RAISE EXCEPTION 'a message is hidden once, after delivery, with a reason' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'held' AND NEW.status IN ('delivered','declined','withdrawn'))
      OR (OLD.status = 'declined' AND NEW.status = 'held' AND OLD.appealed_at IS NULL AND NEW.appealed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'message status cannot change from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- storefront_message_reviews and storefront_conversation_access_log: append-only (demo rows go with their conversation)
  -- (a cascade from deleting a demo conversation or message finds no remaining real parent)
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'storefront_conversation_access_log' THEN
      IF NOT EXISTS (SELECT 1 FROM storefront_conversations sc WHERE sc.id = OLD.conversation_id AND NOT sc.is_demo) THEN RETURN OLD; END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM storefront_messages m WHERE m.id = OLD.message_id AND NOT m.is_demo) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
