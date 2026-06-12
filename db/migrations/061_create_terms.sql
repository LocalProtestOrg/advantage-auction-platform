-- Migration: 061_create_terms.sql
-- #21 Minimal versioned Terms & Conditions framework (buyer terms).
-- Decoupled from the seller-agreement tables (053-057) — buyers need a simple
-- versioned doc + click-acceptance ledger, not the signing/PDF machinery.
--
-- terms_versions     : immutable, versioned terms documents (one current per kind).
-- terms_acceptances  : append-only ledger linking a user to an accepted version.
-- Re-acceptance after a version bump is modeled by publishing a new version and
-- flipping is_current; hasAcceptedCurrentTerms() then returns false until the
-- user accepts the new version.

CREATE TABLE IF NOT EXISTS terms_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL DEFAULT 'buyer_terms',
  version_int   INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current    BOOLEAN NOT NULL DEFAULT false,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, version_int)
);

-- At most one current version per kind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_versions_current
  ON terms_versions(kind) WHERE is_current;

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version_id UUID NOT NULL REFERENCES terms_versions(id),
  accepted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address       TEXT,
  user_agent       TEXT,
  UNIQUE (user_id, terms_version_id)   -- one acceptance per user per version (idempotent)
);

CREATE INDEX IF NOT EXISTS idx_terms_acceptances_user ON terms_acceptances(user_id);

-- Seed AAC Buyer Terms v1 (initial launch version; the fully rewritten AAC
-- document supersedes this as a new version later, which triggers re-acceptance).
INSERT INTO terms_versions (kind, version_int, title, body_markdown, is_current)
VALUES (
  'buyer_terms', 1,
  'Advantage Auction — Buyer Terms & Conditions of Sale (v1)',
  $terms$
# Advantage Auction Buyer Terms & Conditions of Sale (Version 1)

By registering to bid you agree to the following. This is the initial launch
version and may be updated; a new version requires re-acceptance.

1. **Account-based bidding.** Bidding requires an active account and login. You
   are responsible for activity under your account.
2. **Binding bids.** Every bid — including proxy/maximum bids — is a binding,
   irrevocable offer to purchase at that price plus applicable buyer premium,
   fees, and taxes.
3. **Proxy / maximum bidding.** A maximum bid authorizes the platform to bid on
   your behalf up to your maximum, in the configured increments.
4. **Timed close & anti-snipe.** Lots close on a timed, staggered schedule. A bid
   placed in the final moments extends that lot's close time. Closing times are
   approximate and may be extended by anti-snipe rules.
5. **Auction registration & card on file.** You may be required to register for an
   auction and keep a valid payment method on file before bidding.
6. **Payment.** Winning buyers authorize charges to their payment method for the
   hammer price, buyer premium, fees, and taxes. Non-payment may result in
   account suspension and loss of bidding privileges.
7. **Pickup obligations.** Buyers must collect won lots within the scheduled
   pickup window. Uncollected lots may be subject to fees or forfeiture.
8. **As-is sale.** All items are sold AS-IS, WHERE-IS, with no warranties except
   as required by law. Descriptions and images are provided in good faith.
9. **Realized-price privacy.** Sold/realized prices are visible only to
   logged-in account holders.
10. **Platform governance.** Advantage Auction may refuse or cancel bids, suspend
    accounts, and administer auctions at its discretion to protect platform
    integrity.

These terms will be expanded in a future version.
  $terms$,
  true
)
ON CONFLICT (kind, version_int) DO NOTHING;
