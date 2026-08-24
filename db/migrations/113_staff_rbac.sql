-- 113_staff_rbac.sql
--
-- Internal staff role-based access control (RBAC). ADDITIVE ONLY, idempotent.
--
-- Design:
--   • `users.role` (buyer/seller/admin) is UNCHANGED. role='admin' remains the unrestricted
--     Super Admin (Owner) and continues to pass every existing role(['admin']) gate — so existing
--     admin access is preserved exactly.
--   • Internal staff get a SEPARATE `staff_role` (nullable). It is the authoritative internal-staff
--     marker, kept logically distinct from marketplace membership. A staff member's marketplace
--     `role` stays a benign value (e.g. 'buyer'); their access is driven by staff_role -> permissions
--     (resolved in src/lib/rbac.js) and enforced by requirePermission middleware.
--   • Permissions are code-defined (rbac.js) and role-composed; per-user overrides are supported via
--     staff_permission_overrides for future flexibility.
--
-- NOTHING here changes buyer/seller/admin authentication or the marketplace. Default state: every
-- existing user has staff_role=NULL (not staff) and staff_active=true (irrelevant unless staff).

ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_active  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Constrain staff_role to the known roles (NULL allowed = not staff). Guarded so re-runs never error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_staff_role') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_staff_role
      CHECK (staff_role IS NULL OR staff_role IN ('super_admin','marketing','auction_ops','auction_approver','finance'));
  END IF;
END$$;

-- Optional per-user permission overrides (future-ready; resolver applies grant/deny on top of role).
CREATE TABLE IF NOT EXISTS staff_permission_overrides (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission        TEXT NOT NULL,
  effect            TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_users_staff_role ON users(staff_role) WHERE staff_role IS NOT NULL;
