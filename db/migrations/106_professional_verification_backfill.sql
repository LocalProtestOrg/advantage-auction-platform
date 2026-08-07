-- 106_professional_verification_backfill.sql
--
-- H-1 follow-up: engage the professional first-sale business-verification requirement for EXISTING
-- professional sellers who were provisioned before the requirement was wired into the seller-type
-- assignment path (verificationService.requireVerificationForProfessional).
--
-- Policy: every Professional Seller (auction_house / estate_sale_company / professional_liquidator) must
-- have Advantage-approved business verification before their first sale can go public. This is enforced at
-- publish time by verificationService.publicationGate, which keys off
-- seller_profiles.verification_required_before_publication.
--
-- SAFETY / SCOPE:
--   • Individual sellers (private/business/other) are NEVER touched.
--   • Only rows that are professional AND not already flagged are updated (idempotent; re-runnable).
--   • Sellers who ALREADY hold an approved verification are intentionally left as-is: setting the flag on
--     them is harmless (the gate opens once an approved verification exists), so this migration does not
--     disturb professionals who are already approved/selling. (Set-them-too is a one-line change if the
--     owner prefers a uniform flag.)
--   • Read-only preview of the impact is the SELECT at the bottom (commented) — run it first.
--
-- DO NOT RUN IN PRODUCTION WITHOUT OWNER APPROVAL. Prepared, not executed.

BEGIN;

UPDATE seller_profiles sp
   SET verification_required_before_publication = true
 WHERE sp.seller_type IN ('auction_house', 'estate_sale_company', 'professional_liquidator')
   AND sp.verification_required_before_publication IS DISTINCT FROM true
   AND NOT EXISTS (
     SELECT 1 FROM verification_requests vr
      WHERE vr.seller_profile_id = sp.id AND vr.status = 'approved'
   );

COMMIT;

-- ── Read-only impact preview (run BEFORE the UPDATE to know the count) ────────────────────────────────
-- SELECT
--   count(*) FILTER (WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator')) AS professionals,
--   count(*) FILTER (WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator')
--                      AND verification_required_before_publication IS DISTINCT FROM true)                    AS professionals_unflagged,
--   count(*) FILTER (WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator')
--                      AND verification_required_before_publication IS DISTINCT FROM true
--                      AND NOT EXISTS (SELECT 1 FROM verification_requests vr
--                                       WHERE vr.seller_profile_id = seller_profiles.id AND vr.status='approved')) AS would_backfill
-- FROM seller_profiles;
