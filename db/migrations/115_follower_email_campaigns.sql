-- 115: Professional Seller Follower Email Campaigns.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Lets a PROFESSIONAL seller email the Advantage.Bid users who
-- follow their company when an event (auction / estate sale) they own is PUBLISHED. Advantage.Bid retains
-- full control of the member/contact database: sellers never receive, query, or export follower contact
-- data — targeting + delivery happen entirely server-side through the existing notifications_queue worker.
--
-- Reuses (does NOT duplicate): seller_followers (audience), notification_preferences (opt-out gate),
-- notifications_queue + notificationWorker (delivery). Adds only the marketing-campaign metadata layer,
-- a recipient marketing opt-out distinct from the transactional master switch, a suppression list (for
-- unsubscribe + future bounce handling), and a per-seller admin-revocable privilege flag.

-- 1) New notifications_queue.type: FOLLOWER_EVENT (seller-initiated, event-scoped follower announcement).
--    Non-destructive drop-and-recreate re-enumerating every previously-allowed type (pattern of 083/084/085).
ALTER TABLE notifications_queue DROP CONSTRAINT IF EXISTS notifications_queue_type_check;
ALTER TABLE notifications_queue ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN (
    'OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON',
    'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING',
    'NEW_AUCTION', 'AUCTION_RETURNED_TO_DRAFT', 'AUCTION_REJECTED',
    'PICKUP_SCHEDULED', 'PICKUP_REMINDER',
    'PAYMENT_REMINDER',
    'AUCTION_BEGINS_SOON',
    'FOLLOWER_EVENT'
  ));

-- 2) Per-seller admin-revocable privilege. Default TRUE; professionalism is still required in code
--    (isProfessional(seller_type)). Admin flips this to FALSE to disable a seller's follower-email tool.
ALTER TABLE seller_profiles
  ADD COLUMN IF NOT EXISTS follower_email_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- 3) Recipient-side MARKETING opt-out, distinct from the transactional master switch (email_enabled).
--    A follower may keep transactional email on while opting out of seller follower marketing.
--    Default TRUE (opted in), honored via COALESCE(...,true) exactly like email_enabled.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS follower_emails_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- 4) Suppression list — addresses that must never receive follower marketing (one-click unsubscribe-all,
--    and future SES/SNS bounce/complaint ingestion). Checked at enqueue AND at send.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email      TEXT        PRIMARY KEY,
  reason     TEXT        NOT NULL DEFAULT 'unsubscribe',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5) Campaign metadata. One row per seller-initiated follower announcement, attached to the published
--    thing (event now; auction column reserved for a later phase). Delivery stats are derived on read from
--    notifications_queue (payload->>'campaign_id'); this row carries intent, audience estimate, and status.
CREATE TABLE IF NOT EXISTS follower_campaigns (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id         UUID        NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  event_id          UUID        REFERENCES events(id)   ON DELETE CASCADE,
  auction_id        UUID        REFERENCES auctions(id) ON DELETE CASCADE,  -- reserved (future phase)
  created_by        UUID        REFERENCES users(id)    ON DELETE SET NULL,
  trigger_type      TEXT        NOT NULL DEFAULT 'event_published'
                                CHECK (trigger_type IN ('event_published')),
  status            TEXT        NOT NULL DEFAULT 'scheduled'
                                CHECK (status IN ('scheduled','queued','canceled')),
  custom_message    TEXT,
  audience_estimate INTEGER     NOT NULL DEFAULT 0,   -- eligible followers at opt-in time (approx.)
  targeted_count    INTEGER     NOT NULL DEFAULT 0,   -- queue rows actually enqueued at publish
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  queued_at         TIMESTAMPTZ,
  -- exactly one target must be set (event now, auction later)
  CONSTRAINT follower_campaigns_one_target CHECK ((event_id IS NOT NULL) <> (auction_id IS NOT NULL))
);

-- Duplicate-send protection: at most ONE campaign per event (and per auction) per trigger.
CREATE UNIQUE INDEX IF NOT EXISTS uq_follower_campaigns_event
  ON follower_campaigns(event_id, trigger_type) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_follower_campaigns_auction
  ON follower_campaigns(auction_id, trigger_type) WHERE auction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_follower_campaigns_seller ON follower_campaigns(seller_id, created_at DESC);

-- Fast per-campaign delivery-stat rollups from the queue (payload->>'campaign_id').
CREATE INDEX IF NOT EXISTS idx_notifications_queue_campaign
  ON notifications_queue ((payload->>'campaign_id')) WHERE type = 'FOLLOWER_EVENT';
