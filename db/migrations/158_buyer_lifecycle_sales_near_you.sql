-- 158_buyer_lifecycle_sales_near_you.sql — ADDITIVE + idempotent. Makes Sales Near You a normal
-- benefit of registering with Advantage.Bid, disclosed in the buyer registration terms.
--
-- The gap this closes. Buyer registration, auction registration, bidding and purchase currently do
-- NOTHING with the subscriber system: production holds 95 users (66 buyers), 45 auction
-- registrations and 392 bids against exactly 1 marketing contact. Every buyer relationship was
-- being discarded.
--
-- THE CONSENT RULE THIS ENFORCES. Enrolment is tied to a terms version that ACTUALLY DISCLOSES the
-- benefit. `includes_sales_near_you` marks which versions do, so the runtime can ask "did this
-- person accept a version that told them about this?" rather than assuming. A buyer who accepted an
-- older version is NOT enrolled and NO historical acceptance is rewritten — they encounter the new
-- term naturally at their next auction registration, which the existing `hasAcceptedCurrentTerms`
-- gate already requires.
--
-- Deliberately NOT done here: no existing acceptance row is modified, no contact is created, no
-- email is sent, and no marketing gate is changed.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Mark which terms versions disclose Sales Near You.
-- ---------------------------------------------------------------------------------------------
-- Default FALSE is the safe answer for every historical version: absence of disclosure means
-- absence of enrolment, which is exactly the behaviour we want for buyers who registered earlier.
ALTER TABLE terms_versions
  ADD COLUMN IF NOT EXISTS includes_sales_near_you boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------
-- 2. Buyer terms v3 — v1 verbatim, plus one new numbered term.
-- ---------------------------------------------------------------------------------------------
-- Built from the version that is ACTUALLY IN FORCE (v1), not from the unused v2 draft. A fuller
-- "Terms of Service — General and Buyers" exists as v2 with is_current = false; promoting it is a
-- separate Owner decision with legal implications and is deliberately not made here.
--
-- The new term is an ordinary numbered clause in the existing voice — a benefit of registering,
-- not a warning. Per Owner instruction it carries no unsubscribe sentence; the unsubscribe and
-- suppression machinery lives in the emails themselves, which is where the legal requirement
-- actually applies.
INSERT INTO terms_versions (kind, version_int, title, body_markdown, is_current, includes_sales_near_you, effective_at)
SELECT 'buyer_terms', 3,
       'Advantage Auction — Buyer Terms & Conditions of Sale (v3)',
$MD$
# Advantage Auction Buyer Terms & Conditions of Sale (Version 3)

By registering to bid you agree to the following. This version adds Sales Near You
notifications as a benefit of registration; a new version requires re-acceptance.

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
11. **Sales Near You.** Registration includes email notifications about qualifying
    upcoming auctions and estate sales near you, generally within 30 miles of your
    location.

These terms will be expanded in a future version.
$MD$,
       false,   -- promoted to current at the end of this migration, once it exists
       true,
       now()
WHERE NOT EXISTS (
  SELECT 1 FROM terms_versions WHERE kind = 'buyer_terms' AND version_int = 3
);

-- Promote v3 and retire the previous current version. Exactly one current version per kind.
UPDATE terms_versions SET is_current = false
 WHERE kind = 'buyer_terms' AND version_int <> 3 AND is_current = true;
UPDATE terms_versions SET is_current = true
 WHERE kind = 'buyer_terms' AND version_int = 3;

-- ---------------------------------------------------------------------------------------------
-- 3. Enrolment evidence.
-- ---------------------------------------------------------------------------------------------
-- One row per (contact, trigger, terms version): WHICH registration event enrolled this person and
-- under WHICH disclosed terms. The marketing_contact_* tables already carry permission provenance;
-- this adds the registration-specific fact they cannot express, so an auditor can answer "why is
-- this buyer receiving Sales Near You?" with a specific accepted version.
CREATE TABLE IF NOT EXISTS buyer_sales_near_you_enrollments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          uuid        NOT NULL REFERENCES marketing_contacts(id) ON DELETE CASCADE,
  user_id             uuid        REFERENCES users(id) ON DELETE SET NULL,
  trigger             text        NOT NULL
    CHECK (trigger IN ('account_registration','auction_registration','admin_backfill')),
  auction_id          uuid        REFERENCES auctions(id) ON DELETE SET NULL,
  terms_version_id    uuid        REFERENCES terms_versions(id) ON DELETE SET NULL,
  terms_version_int   integer,
  terms_accepted_at   timestamptz,
  geography_source    text,        -- where city/state came from ('tax_address', 'signup', ...)
  geography_precision text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- Idempotent per (contact, trigger, terms version): re-registering for a second auction under the
-- same accepted terms records nothing new, so repeated activity cannot inflate the evidence trail.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bsny_enrollment
  ON buyer_sales_near_you_enrollments (contact_id, trigger, COALESCE(terms_version_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_bsny_user ON buyer_sales_near_you_enrollments(user_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Owner gate. Registration-driven enrolment ships ON, because it is a disclosed benefit of
--    registering and collection (never sending) is what it performs. Sending stays governed by
--    marketing.email.sales_near_you_enabled and by per-event entitlement, both unchanged.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.sales_near_you.enroll_on_registration', 'true', 'marketing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
