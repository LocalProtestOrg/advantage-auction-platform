-- 157_sales_near_you_entitlements.sql — ADDITIVE + idempotent. Implements the finalized Owner policy
-- for the Sales Near You notification channel:
--
--     EVERYONE MAY SUBSCRIBE. NOT EVERY EVENT MAY SEND.
--
-- Subscriber eligibility, geographic eligibility, EVENT ENTITLEMENT, send authority, content policy and
-- deliverability are six separate concepts. This migration supplies the missing one: a durable record of
-- whether a specific auction or event is entitled to use the Sales Near You email channel at all.
--
-- The defect this corrects. localEventAlertService resolved ANY row passing the canonical visibility
-- predicates — a native auction, an imported auction, an Auction Partner Event, a personally managed
-- estate sale and an imported estate sale were all equally resolvable, and an audience could be built
-- for any of them. Under the finalized policy only a NATIVE Advantage.Bid auction is automatically
-- eligible; everything else needs an explicit entitlement. Nothing autonomous sends today (the only
-- caller is the admin preview/QA surface), so this corrects the architecture BEFORE subscriber
-- acquisition expands rather than after.
--
-- Deliberately NOT decided here, because they are future product decisions: package price, the number of
-- sends a package includes, package naming, bundle economics, upsell copy and refund rules. `max_sends`
-- is nullable precisely so the future purchase can set it without a schema change.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. The obligation engine becomes event-aware.
-- ---------------------------------------------------------------------------------------------
-- marketing_obligations (migration 140) is auction-centric: it carries auction_id only, while
-- marketing_package_purchases already carries an event_id. A personally managed ESTATE SALE is an
-- `events` row, so without this column a future estate-sale marketing package could not express a
-- per-deliverable email obligation at all. Additive; every existing obligation is unaffected.
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_obligation_event ON marketing_obligations(event_id) WHERE event_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. sales_near_you_entitlements — "may THIS event use the channel?"
-- ---------------------------------------------------------------------------------------------
-- One row per granted entitlement. A native Advantage.Bid auction needs NO row: it is eligible by rule
-- (§7), subject to every other gate. Everything else — imported auctions, Auction Partner Events,
-- personally managed estate sales, imported estate sales — needs a row here, and the absence of one is
-- a refusal.
--
-- `source` records WHY the entitlement exists, which keeps the commercial path and the promotional path
-- distinguishable forever:
--   package_obligation    — a purchased marketing package granted it (the future product hook)
--   additional_promotion  — a separately purchased promotion granted it
--   admin_override        — an Owner/Admin promotional grant, with a stated reason
--   partner_agreement     — an approved partner relationship
--
-- A seller never gains access to the subscriber list through any of these. An entitlement authorises the
-- PLATFORM to send on the event's behalf; it is not a key to the audience.
CREATE TABLE IF NOT EXISTS sales_near_you_entitlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind    text        NOT NULL CHECK (subject_kind IN ('auction','event')),
  auction_id      uuid        REFERENCES auctions(id) ON DELETE CASCADE,
  event_id        uuid        REFERENCES events(id)   ON DELETE CASCADE,
  source          text        NOT NULL
    CHECK (source IN ('package_obligation','additional_promotion','admin_override','partner_agreement')),
  -- Provenance back into the commercial architecture (nullable for an admin/partner grant).
  obligation_id   uuid        REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  purchase_kind   text        CHECK (purchase_kind IS NULL OR purchase_kind IN ('package','additional_promotion')),
  purchase_id     uuid,
  status          text        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','exhausted','revoked','expired')),
  -- How many Sales Near You sends this entitlement permits. NULL = not yet decided by product, and the
  -- resolver treats NULL as "no numeric limit expressed here" while every other gate still applies.
  max_sends       integer     CHECK (max_sends IS NULL OR max_sends > 0),
  sends_used      integer     NOT NULL DEFAULT 0 CHECK (sends_used >= 0),
  granted_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  granted_reason  text,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_reason  text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Exactly one subject, and it must match the declared kind — an entitlement can never be ambiguous
-- about what it entitles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sny_entitlement_subject') THEN
    ALTER TABLE sales_near_you_entitlements
      ADD CONSTRAINT chk_sny_entitlement_subject
      CHECK ((subject_kind = 'auction' AND auction_id IS NOT NULL AND event_id IS NULL)
          OR (subject_kind = 'event'   AND event_id   IS NOT NULL AND auction_id IS NULL));
  END IF;
  -- An admin override must say why. A promotional grant with no stated reason is not auditable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sny_override_reason') THEN
    ALTER TABLE sales_near_you_entitlements
      ADD CONSTRAINT chk_sny_override_reason
      CHECK (source <> 'admin_override' OR (granted_by IS NOT NULL AND granted_reason IS NOT NULL));
  END IF;
  -- A revoked entitlement must record when.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sny_revoked') THEN
    ALTER TABLE sales_near_you_entitlements
      ADD CONSTRAINT chk_sny_revoked
      CHECK ((status = 'revoked') = (revoked_at IS NOT NULL));
  END IF;
END $$;

-- At most one LIVE entitlement per subject, so a double purchase cannot silently double the authority.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sny_entitlement_live_auction
  ON sales_near_you_entitlements (auction_id) WHERE auction_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sny_entitlement_live_event
  ON sales_near_you_entitlements (event_id)   WHERE event_id   IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_sny_entitlement_status ON sales_near_you_entitlements(status, source);

-- ---------------------------------------------------------------------------------------------
-- 3. Owner policy configuration.
-- ---------------------------------------------------------------------------------------------
-- The default Sales Near You EMAIL radius becomes 30 miles. This is an email-audience policy and is
-- deliberately INDEPENDENT of paid advertising targeting — they share a number today by coincidence,
-- not by coupling, and live under different keys so changing one never moves the other.
UPDATE platform_config SET value = '30'::jsonb, updated_at = now()
 WHERE key IN ('marketing.email.radius_default_miles', 'marketing.email.local_alert_default_radius_miles');

INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.email.radius_default_miles',            '30', 'marketing'),
  ('marketing.email.local_alert_default_radius_miles','30', 'marketing'),
  -- The canonical deliverable key a future estate-sale marketing package must grant in order to unlock
  -- this channel. Named now so the future purchase has something concrete to reference.
  ('marketing.email.sales_near_you_obligation_key', '"sales_near_you_email"', 'marketing'),
  -- Master switch for the channel itself, separate from A7. OFF: no Sales Near You send may execute,
  -- whatever any entitlement says.
  ('marketing.email.sales_near_you_enabled', 'false', 'marketing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
