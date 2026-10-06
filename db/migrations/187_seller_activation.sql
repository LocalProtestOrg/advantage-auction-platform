-- 187: R-1 Seller Activation with Sasha check-ins (2026-10-06). ADDITIVE / IDEMPOTENT / REVERSIBLE.
--
-- Stage, blocker and next-action owner are COMPUTED from existing platform facts on every pass (seller_profiles,
-- agreements, verification_requests, auctions, lots). Nothing here is a second source of truth for seller status:
--   seller_activation_state    one row per seller profile: the latest computed snapshot (for the Director view) plus
--                              the only facts R-1 owns: activation opt-out and the evaluation timestamps.
--   seller_activation_touches  append-only decision ledger: eligible / suppressed / would contact / contacted /
--                              cancelled / staff attention / complete, with stage, blocker, guard, reason, attempt,
--                              mode (shadow|live) and the Sasha conversation. A row is written when the decision,
--                              stage, blocker or guard CHANGES (not on every pass), and for every send.
--   founding_partners.sasha_assist_released_*   Ty's explicit release of an Auction Partner seller to Sasha. Until
--                              then an Auction Partner seller is Ty-owned regardless of any contact-lock expiry.
--
-- Switches (platform_config, category 'seller_activation'): enabled = true (evaluation runs), mode = 'shadow'
-- (decisions are recorded; NOTHING is sent). Live sending requires mode = 'live', set deliberately by the Owner.
--
-- Rollback: DROP TABLE seller_activation_touches; DROP TABLE seller_activation_state;
--           ALTER TABLE founding_partners DROP COLUMN sasha_assist_released_at, DROP COLUMN sasha_assist_released_by;
--           DELETE FROM platform_config WHERE category = 'seller_activation';

BEGIN;

CREATE TABLE IF NOT EXISTS seller_activation_state (
  seller_profile_id   uuid PRIMARY KEY REFERENCES seller_profiles(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  stage               text NOT NULL CHECK (stage IN ('onboarding_incomplete','ready_no_auction','draft_started','submitted_waiting','activated','excluded')),
  blocker             text,
  next_owner          text CHECK (next_owner IS NULL OR next_owner IN ('seller','advantage','relationship_owner')),
  last_progress_at    timestamptz,
  decision            text,
  guard               text,
  reason              text,
  needs_staff_attention boolean NOT NULL DEFAULT false,
  next_touch_at       timestamptz,
  snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb,
  opted_out_at        timestamptz,
  opted_out_by        uuid REFERENCES users(id),
  opted_out_reason    text,
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sas_stage ON seller_activation_state (stage, needs_staff_attention);

CREATE TABLE IF NOT EXISTS seller_activation_touches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_profile_id   uuid NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  mode                text NOT NULL CHECK (mode IN ('shadow','live')),
  decision            text NOT NULL CHECK (decision IN ('excluded','waiting','suppressed','staff_attention','would_contact',
                        'contacted','cancelled','send_failed','replied','human_takeover','opted_out','complete')),
  stage               text NOT NULL,
  blocker             text,
  next_owner          text,
  guard               text,
  reason              text,
  message_category    text CHECK (message_category IS NULL OR message_category IN ('onboarding_incomplete','ready_no_auction','draft_stalled')),
  attempt             integer,              -- seller-wide touch number this send would be / was (1..3)
  stage_attempt       integer,              -- touch number within the stage (1..2)
  last_progress_at    timestamptz,
  conversation_id     uuid REFERENCES cs_conversations(id) ON DELETE SET NULL,
  conversation_ref    text,
  idempotency_key     text,
  snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sat_seller ON seller_activation_touches (seller_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sat_decision ON seller_activation_touches (decision, created_at DESC);
-- One real send per seller, stage and attempt, ever (duplicate prevention across workers and restarts).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sat_send ON seller_activation_touches (idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE founding_partners ADD COLUMN IF NOT EXISTS sasha_assist_released_at timestamptz;
ALTER TABLE founding_partners ADD COLUMN IF NOT EXISTS sasha_assist_released_by uuid REFERENCES users(id);

INSERT INTO platform_config (key, value, category, description) VALUES
  ('seller_activation.enabled', 'true'::jsonb, 'seller_activation', 'R-1 seller activation: evaluate stalled sellers (no sending unless mode = live).'),
  ('seller_activation.mode', '"shadow"'::jsonb, 'seller_activation', 'shadow = record decisions only, send nothing; live = Sasha sends check-ins.'),
  ('seller_activation.first_touch_hours', '72'::jsonb, 'seller_activation', 'Hours without seller progress before the first check-in.'),
  ('seller_activation.second_touch_days', '7'::jsonb, 'seller_activation', 'Days after the first check-in before the second (only if still stalled).'),
  ('seller_activation.max_per_stage', '2'::jsonb, 'seller_activation', 'Maximum check-ins per activation stage.'),
  ('seller_activation.max_per_seller', '3'::jsonb, 'seller_activation', 'Maximum check-ins per seller overall.'),
  ('seller_activation.daily_cap', '6'::jsonb, 'seller_activation', 'Maximum activation check-ins Sasha sends per day.'),
  ('seller_activation.recent_human_days', '14'::jsonb, 'seller_activation', 'Recent staff or rep communication that blocks a check-in (days).')
ON CONFLICT (key) DO NOTHING;

COMMIT;
