-- 180: Sasha — Advantage.Bid customer service (email + website chat), Shared Inbox, knowledge layer, run ledger.
-- ADDITIVE / IDEMPOTENT. New cs_* tables only; touches no existing table or outreach data. Everything ships OFF
-- (platform_config sasha.* switches, seeded false) so nothing answers customers until an operator turns it on.

-- ── Conversations: one thread per customer conversation, across email or chat ──────────────────────────
CREATE TABLE IF NOT EXISTS cs_conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                 TEXT NOT NULL UNIQUE,                       -- short human reference, e.g. "S7K2Q9" (subject token)
  channel             TEXT NOT NULL CHECK (channel IN ('email', 'chat')),
  site                TEXT CHECK (site IS NULL OR site IN ('www', 'bid')),   -- chat only: where it started
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'resolved', 'closed', 'ignored')),
  owner               TEXT NOT NULL DEFAULT 'sasha' CHECK (owner IN ('sasha', 'staff')),   -- staff = Sasha stays silent
  assigned_staff_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  handoff_state       TEXT NOT NULL DEFAULT 'none' CHECK (handoff_state IN ('none', 'needed', 'taken', 'resolved')),
  handoff_reason      TEXT,
  subject             TEXT,
  customer_email      TEXT,                                       -- normalized (lowercase); email channel or given in chat
  customer_name       TEXT,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL, -- AUTHENTICATED user (chat session) — authorizes account data
  contact_match_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- email address matches an account — NOT authorization
  chat_token_hash     TEXT UNIQUE,                                -- anonymous chat continuity (sha256 of a random token)
  message_count       INTEGER NOT NULL DEFAULT 0,
  auto_reply_count    INTEGER NOT NULL DEFAULT 0,
  last_customer_at    TIMESTAMPTZ,
  last_message_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cs_conversations_inbox ON cs_conversations (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_conversations_handoff ON cs_conversations (handoff_state) WHERE handoff_state = 'needed';
CREATE INDEX IF NOT EXISTS idx_cs_conversations_email ON cs_conversations (customer_email);
CREATE INDEX IF NOT EXISTS idx_cs_conversations_user ON cs_conversations (user_id);

-- ── Messages: customer, Sasha, staff and internal notes ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cs_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES cs_conversations(id) ON DELETE CASCADE,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note')),
  author_type         TEXT NOT NULL CHECK (author_type IN ('customer', 'sasha', 'staff', 'system')),
  staff_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  body_text           TEXT NOT NULL,
  email_message_id    TEXT,                                       -- RFC Message-ID (inbound, or ours for outbound)
  in_reply_to         TEXT,
  references_header   TEXT,
  inbound_receipt_id  UUID,                                       -- inbound_email_receipts.id (email channel)
  ses_message_id      TEXT,                                       -- outbound SES id
  delivery_status     TEXT CHECK (delivery_status IS NULL OR delivery_status IN ('pending', 'sent', 'failed', 'suppressed', 'not_sent')),
  delivery_error      TEXT,
  auto_sent           BOOLEAN NOT NULL DEFAULT false,             -- sent by Sasha without a person
  attachments         JSONB NOT NULL DEFAULT '[]'::jsonb,         -- metadata only (name/type/size) — contents are never stored or read
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cs_messages_conversation ON cs_messages (conversation_id, created_at);
-- Idempotent inbound email: one message per RFC Message-ID.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_messages_inbound_msgid ON cs_messages (email_message_id) WHERE direction = 'inbound' AND email_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cs_messages_msgid ON cs_messages (email_message_id) WHERE email_message_id IS NOT NULL;

-- ── Engine runs: one row per model turn (observability + cost) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cs_ai_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID REFERENCES cs_conversations(id) ON DELETE CASCADE,
  trigger_message_id  UUID REFERENCES cs_messages(id) ON DELETE SET NULL,
  reply_message_id    UUID REFERENCES cs_messages(id) ON DELETE SET NULL,
  channel             TEXT,
  model               TEXT,
  outcome             TEXT NOT NULL CHECK (outcome IN ('replied', 'handoff', 'suppressed', 'skipped', 'error')),
  outcome_reason      TEXT,
  tools_used          JSONB NOT NULL DEFAULT '[]'::jsonb,         -- tool names + sources (no customer data values)
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd      BIGINT NOT NULL DEFAULT 0,
  latency_ms          INTEGER,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cs_ai_runs_conversation ON cs_ai_runs (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_ai_runs_day ON cs_ai_runs (created_at);

-- ── Handoffs: every time a person is needed ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cs_handoffs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES cs_conversations(id) ON DELETE CASCADE,
  reason_code         TEXT NOT NULL,                              -- customer_request | dispute | legal | privacy | security | fraud | account_change | uncertain | conflict | other
  reason_text         TEXT,
  created_by          TEXT NOT NULL CHECK (created_by IN ('sasha', 'customer', 'staff', 'system')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'taken', 'resolved')),
  taken_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cs_handoffs_open ON cs_handoffs (status) WHERE status <> 'resolved';

-- ── Knowledge layer: approved support guidance on top of live platform facts and help pages ───────────
CREATE TABLE IF NOT EXISTS cs_kb_articles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  audience            TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'buyer', 'seller', 'professional', 'staff')),
  status              TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'approved', 'disabled', 'conflict')),
  conflict_note       TEXT,
  source              TEXT,                                       -- where it came from (owner decision, doc path, staff)
  version             INTEGER NOT NULL DEFAULT 1,
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Inbound mail: the dedicated company-inbox route (inbox@reply.advantage.bid) joins the existing programmes ─
ALTER TABLE inbound_email_receipts DROP CONSTRAINT IF EXISTS inbound_email_receipts_programme_check;
ALTER TABLE inbound_email_receipts ADD CONSTRAINT inbound_email_receipts_programme_check
  CHECK (programme IS NULL OR programme IN ('claimed_listing', 'event_partner', 'unmatched', 'company_inbox'));

-- ── Operational switches (all OFF) and limits ──────────────────────────────────────────────────────────
INSERT INTO platform_config (key, value, category) VALUES
  ('sasha.enabled',                'false'::jsonb, 'sasha'),   -- global stop
  ('sasha.engine_enabled',         'false'::jsonb, 'sasha'),   -- model processing
  ('sasha.email_inbound_enabled',  'false'::jsonb, 'sasha'),   -- accept mail on the company inbox route
  ('sasha.email_autoreply_enabled','false'::jsonb, 'sasha'),   -- send email replies without a person
  ('sasha.chat_bid_enabled',       'false'::jsonb, 'sasha'),   -- chat on bid.advantage.bid
  ('sasha.chat_www_enabled',       'false'::jsonb, 'sasha'),   -- chat on www.advantage.bid (BD)
  ('sasha.daily_budget_usd',       '25'::jsonb,    'sasha')    -- model spend cap per UTC day
ON CONFLICT (key) DO NOTHING;

-- ── Seed guidance (content approved in Owner decisions 1–3, docs/sasha/knowledge-decisions.md) + open conflicts ─
-- Editable/disable-able in Admin → Sasha Settings & Knowledge. ON CONFLICT DO NOTHING: re-running never overwrites edits.
INSERT INTO cs_kb_articles (slug, title, body, audience, status, conflict_note, source) VALUES
('seller-fees', 'What does it cost to sell at auction?',
'Individual sellers: there is no platform fee and no commission. When an item sells, a 3% payment processing fee on the hammer price (the winning bid) is deducted from the payout. There are no listing, photo or setup fees. The buyer pays the buyer''s premium on top of the winning bid.

Professional sellers (auction houses, estate sale companies, professional liquidators): the platform fee is set in the Professional Seller agreement. A 3% payment processing fee applies to the hammer price. Professional sellers set their own buyer''s premium and keep it.

Do not quote a standard professional fee percentage. A professional seller''s own rates may be shared only with that seller in a signed-in chat.',
 'seller', 'approved', NULL, 'Owner decision 1 (2026-09-27)'),
('buyers-premium', 'What is the buyer''s premium?',
'The buyer''s premium is a percentage added to the winning bid. The exact rate and an estimated total are shown on each lot page before bidding.

It is 18% on auctions by individual sellers. Professional sellers set their own rate.

Example (only an example): a $100 winning bid with an 18% premium comes to $118, before any applicable sales tax.

Never state who receives the premium when talking to buyers. For a specific lot, always use that lot''s live rate.',
 'buyer', 'approved', NULL, 'Owner decision 2 (2026-09-27)'),
('card-verification', 'Adding a payment method',
'To bid, a debit or credit card must be saved to the account. Prepaid cards are not accepted.
When a card is added, it is checked with the bank to confirm it is valid. Advantage.Bid does not charge anything to verify it.
Some banks briefly show a small temporary authorization while the card is checked. It is released and never becomes a charge.
Buyers are only charged if they win.
The card can be changed any time in account settings; the new card is checked the same way.

Never name the payment provider. Never mention a random or under-$1 charge.',
 'buyer', 'approved', NULL, 'Owner decision 3 (2026-09-27)'),
('professional-storefront-fee', 'Professional Storefront (fixed-price) seller fee',
'Professional Storefront fixed-price sales have a flat 11% seller fee, calculated on the item selling price only. The 11% includes card processing. Shipping and sales tax are not included in the fee calculation.

This is separate from Professional Seller AUCTION fees (the platform fee set in the Professional Seller agreement plus 3% payment processing on the hammer price). Never combine or confuse the two.

Storefront checkout is not open to buyers yet; if asked, say fixed-price checkout is coming soon and offer a team member for details.',
 'professional', 'conflict',
 'Owner decision 2026-09-28: flat 11% on item price (includes card processing; shipping and tax excluded), not per-seller. Held as interim until the Professional Seller agreement / legal terms disclose it; then set to approved.',
 'Owner decision (2026-09-28)'),
('payout-timing', 'When do sellers get paid?',
'Advantage.Bid processes eligible seller payouts every Thursday. Auction sales become eligible for the first Thursday after pickup or fulfillment is completed and the transaction is otherwise eligible for payout. For Storefront fixed-price sales, the weekly cutoff is Wednesday at 11:59 PM, with eligible sales processed on Thursday.

Say payouts are "processed" on Thursday. Do not promise the money arrives in the bank account on Thursday: bank processing time varies. Sellers can see each settlement in their seller dashboard (https://bid.advantage.bid/seller-settlements.html). If a seller reports a late or missing payout, hand the conversation to the team.',
 'seller', 'approved', NULL,
 'Owner decision (2026-09-28)')
ON CONFLICT (slug) DO NOTHING;
