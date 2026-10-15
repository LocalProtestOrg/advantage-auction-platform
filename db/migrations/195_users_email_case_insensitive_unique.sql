-- 195_users_email_case_insensitive_unique.sql — one account per email regardless of letter case (security audit
-- 2026-10-15, owner item 6). PREPARED, NOT YET APPLIED: apply only after the read-only duplicate check
-- (scripts/prod-email-case-duplicates-readonly.js) reports 0 groups. On 2026-10-15 production had 0 groups.
--
-- Accounts are never merged or rewritten here. If any case-variant duplicates exist, this migration stops with an
-- error and changes nothing, so staff can resolve them by hand first.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY lower(btrim(email)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'users has emails that differ only by case or spaces; resolve them before applying migration 195';
  END IF;
END $$;

-- Also serves the case-insensitive sign-in lookup (WHERE lower(btrim(email)) = ...).
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_ci ON users (lower(btrim(email)));
