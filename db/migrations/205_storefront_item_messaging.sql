-- 205: Milestone Q — secure item-specific buyer-to-seller messaging (roadmap §9). Feature flag STOREFRONT_MESSAGING_ENABLED
-- (unset = off) gates every route; this migration only creates empty tables and widens the notification outbox.
-- ADDITIVE / IDEMPOTENT. Moves no money; changes no existing row.
--   • storefront_conversations: one thread per (item, signed-in buyer), always tied to the item's REAL seller
--     (composite key to marketplace_items) — the seller is never taken from a caller.
--   • storefront_messages: append-only. `body` is exactly what the sender wrote (seen only by the sender and logged
--     reviewers); `delivered_body` is what the other party sees (contact details masked). A message held for review is
--     delivered only when a reviewer releases it; nothing is ever deleted or rewritten.
--   • storefront_message_reviews: append-only review history (release / decline / sender withdrawal / appeal).
--   • storefront_conversation_access_log: every Advantage.Bid support read of a conversation.
--   • storefront_notifications: new events message_to_seller / message_to_buyer referencing a message (sale_paid rows
--     keep referencing their order exactly as before).

CREATE TABLE IF NOT EXISTS storefront_conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        UUID NOT NULL,
  item_id          UUID NOT NULL,
  buyer_user_id    UUID NOT NULL REFERENCES users(id),
  subject_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,       -- item title, inventory number, thumbnail when the thread began
  is_demo          BOOLEAN NOT NULL DEFAULT false,           -- always taken from the item (trigger)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_storefront_conversations_item_seller FOREIGN KEY (item_id, seller_id) REFERENCES marketplace_items (id, seller_id) ON DELETE CASCADE,
  CONSTRAINT uq_storefront_conversation_item_buyer UNIQUE (item_id, buyer_user_id),
  CONSTRAINT uq_storefront_conversations_id_seller UNIQUE (id, seller_id)
);
CREATE INDEX IF NOT EXISTS idx_storefront_conversations_seller ON storefront_conversations (seller_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_storefront_conversations_buyer ON storefront_conversations (buyer_user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS storefront_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL,
  seller_id        UUID NOT NULL,
  sender_role      TEXT NOT NULL CHECK (sender_role IN ('buyer','seller')),
  sender_user_id   UUID NOT NULL REFERENCES users(id),
  body             TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  delivered_body   TEXT,
  status           TEXT NOT NULL CHECK (status IN ('delivered','held','declined','withdrawn')),
  screening        JSONB NOT NULL DEFAULT '{}'::jsonb,       -- rule version, masked kinds, hold rules (kept for review)
  decline_reason   TEXT,                                     -- shown to the sender
  appeal_note      TEXT,
  appealed_at      TIMESTAMPTZ,
  ip_hash          TEXT,                                     -- hashed, for rate limiting only
  is_demo          BOOLEAN NOT NULL DEFAULT false,           -- always taken from the conversation (trigger)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ,
  CONSTRAINT fk_storefront_messages_conversation_seller FOREIGN KEY (conversation_id, seller_id) REFERENCES storefront_conversations (id, seller_id) ON DELETE CASCADE,
  CONSTRAINT uq_storefront_messages_id_seller UNIQUE (id, seller_id),
  CONSTRAINT storefront_messages_delivered_has_body CHECK ((status = 'delivered') = (delivered_body IS NOT NULL AND delivered_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_storefront_messages_conversation ON storefront_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_storefront_messages_held ON storefront_messages (created_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS idx_storefront_messages_sender ON storefront_messages (sender_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS storefront_message_reviews (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID NOT NULL,
  seller_id        UUID NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('released','declined','withdrawn','appealed')),
  actor_user_id    UUID NOT NULL REFERENCES users(id),
  note             TEXT CHECK (note IS NULL OR length(note) BETWEEN 5 AND 1000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_storefront_message_reviews_message_seller FOREIGN KEY (message_id, seller_id) REFERENCES storefront_messages (id, seller_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_storefront_message_reviews_message ON storefront_message_reviews (message_id, created_at);

CREATE TABLE IF NOT EXISTS storefront_conversation_access_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL,
  seller_id        UUID NOT NULL,
  actor_user_id    UUID NOT NULL REFERENCES users(id),
  purpose          TEXT NOT NULL CHECK (purpose IN ('review_queue','conversation_view')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_storefront_conversation_access_conversation_seller FOREIGN KEY (conversation_id, seller_id) REFERENCES storefront_conversations (id, seller_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_storefront_conversation_access_conversation ON storefront_conversation_access_log (conversation_id, created_at);

-- ── Guards ───────────────────────────────────────────────────────────────────────────────────────────
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
    IF OLD.appealed_at IS NOT NULL AND (NEW.appealed_at IS DISTINCT FROM OLD.appealed_at OR NEW.appeal_note IS DISTINCT FROM OLD.appeal_note) THEN
      RAISE EXCEPTION 'a message can be appealed once' USING ERRCODE = 'check_violation';
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

DROP TRIGGER IF EXISTS trg_storefront_conversations_guard ON storefront_conversations;
CREATE TRIGGER trg_storefront_conversations_guard BEFORE INSERT OR UPDATE OR DELETE ON storefront_conversations
  FOR EACH ROW EXECUTE FUNCTION storefront_messaging_guard();
DROP TRIGGER IF EXISTS trg_storefront_messages_guard ON storefront_messages;
CREATE TRIGGER trg_storefront_messages_guard BEFORE INSERT OR UPDATE OR DELETE ON storefront_messages
  FOR EACH ROW EXECUTE FUNCTION storefront_messaging_guard();
DROP TRIGGER IF EXISTS trg_storefront_message_reviews_guard ON storefront_message_reviews;
CREATE TRIGGER trg_storefront_message_reviews_guard BEFORE UPDATE OR DELETE ON storefront_message_reviews
  FOR EACH ROW EXECUTE FUNCTION storefront_messaging_guard();
DROP TRIGGER IF EXISTS trg_storefront_conversation_access_guard ON storefront_conversation_access_log;
CREATE TRIGGER trg_storefront_conversation_access_guard BEFORE UPDATE OR DELETE ON storefront_conversation_access_log
  FOR EACH ROW EXECUTE FUNCTION storefront_messaging_guard();

-- ── Notification outbox: message events ──────────────────────────────────────────────────────────────
ALTER TABLE storefront_notifications ADD COLUMN IF NOT EXISTS message_id UUID;
ALTER TABLE storefront_notifications ALTER COLUMN order_id DROP NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_notifications_event_check') THEN
    ALTER TABLE storefront_notifications DROP CONSTRAINT storefront_notifications_event_check;
  END IF;
  ALTER TABLE storefront_notifications ADD CONSTRAINT storefront_notifications_event_check
    CHECK (event IN ('sale_paid','message_to_seller','message_to_buyer'));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_notifications_subject_check') THEN
    ALTER TABLE storefront_notifications ADD CONSTRAINT storefront_notifications_subject_check
      CHECK ((event = 'sale_paid' AND order_id IS NOT NULL AND message_id IS NULL)
          OR (event IN ('message_to_seller','message_to_buyer') AND message_id IS NOT NULL AND order_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_storefront_notifications_message_seller') THEN
    ALTER TABLE storefront_notifications ADD CONSTRAINT fk_storefront_notifications_message_seller
      FOREIGN KEY (message_id, seller_id) REFERENCES storefront_messages (id, seller_id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_notification_message_once
  ON storefront_notifications (message_id, event, recipient_email) WHERE message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION storefront_notifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- demo status always comes from the order or message itself, never from the writer
    NEW.is_demo := COALESCE((SELECT o.is_demo FROM marketplace_orders o WHERE o.id = NEW.order_id),
                            (SELECT m.is_demo FROM storefront_messages m WHERE m.id = NEW.message_id), false);
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_demo THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'storefront notifications are kept as delivery records' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.event IS DISTINCT FROM OLD.event
     OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email OR NEW.is_demo IS DISTINCT FROM OLD.is_demo
     OR (NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id AND NEW.recipient_user_id IS NOT NULL)
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a storefront notification keeps its seller, order, event and recipient' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sent' AND NEW.status <> 'sent' THEN
    RAISE EXCEPTION 'a sent notification stays sent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
