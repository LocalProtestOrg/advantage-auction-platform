-- 203: Professional Seller Store Terms & Conditions and Shipping & Pickup Policy (owner requirements 2026-10-16; roadmap
-- §7.2–7.4). ADDITIVE / IDEMPOTENT. Moves no money; changes no existing row.
--   • Each seller organisation writes its OWN policies (two kinds, edited, previewed and published independently).
--     These are the seller's terms, not Advantage.Bid's Buyer Terms, which stay separate and prevail.
--   • Versions are append-only: a draft can be edited; a published version's words are fixed forever; publishing a new
--     version marks the previous one superseded. Nothing is deleted. Every version names its seller (composite key).
--   • Each storefront order records exactly which policy versions (and which platform Buyer Terms version) applied at
--     purchase and when the buyer acknowledged them; that record can never change afterwards.

CREATE TABLE IF NOT EXISTS seller_policy_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID NOT NULL REFERENCES seller_profiles(id),
  kind          TEXT NOT NULL CHECK (kind IN ('store_terms','shipping_pickup')),
  version       INTEGER NOT NULL CHECK (version >= 1),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded','withdrawn')),
  body          TEXT NOT NULL CHECK (length(body) <= 20000),
  content_hash  TEXT NOT NULL,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by  UUID REFERENCES users(id),
  published_at  TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  -- Advantage.Bid override: an administrator may withdraw a published policy from public view (with a written reason);
  -- the words stay on record and the seller can publish a corrected version.
  withdrawn_by     UUID REFERENCES users(id),
  withdrawn_at     TIMESTAMPTZ,
  withdrawn_reason TEXT CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) BETWEEN 5 AND 1000),
  CONSTRAINT uq_seller_policy_versions_id_seller UNIQUE (id, seller_id),
  CONSTRAINT uq_seller_policy_version UNIQUE (seller_id, kind, version),
  CONSTRAINT seller_policy_published_has_time CHECK (status = 'draft' OR (published_at IS NOT NULL AND published_by IS NOT NULL)),
  CONSTRAINT seller_policy_withdrawn_has_reason CHECK (status <> 'withdrawn' OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_policy_one_draft ON seller_policy_versions (seller_id, kind) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_policy_one_published ON seller_policy_versions (seller_id, kind) WHERE status = 'published';

CREATE OR REPLACE FUNCTION seller_policy_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seller policy versions are kept permanently' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a seller policy version starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a seller policy version keeps its seller, kind and version' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by) THEN
    RAISE EXCEPTION 'a published seller policy can never be rewritten; publish a new version' USING ERRCODE = 'check_violation';
  END IF;
  -- An administrator's withdrawal record is fixed once written, and cannot be added to any other status.
  IF (OLD.withdrawn_at IS NOT NULL OR NEW.status <> 'withdrawn') AND (NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by
     OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason) THEN
    RAISE EXCEPTION 'a policy withdrawal record can never be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status IN ('superseded','withdrawn'))) THEN
    RAISE EXCEPTION 'seller policy status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_seller_policy_versions_guard ON seller_policy_versions;
CREATE TRIGGER trg_seller_policy_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON seller_policy_versions
  FOR EACH ROW EXECUTE FUNCTION seller_policy_versions_guard();

-- ── Purchase record of the policies that applied ─────────────────────────────────────────────────────
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS policy_snapshot          JSONB;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS policies_acknowledged_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION marketplace_orders_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot OR NEW.policies_acknowledged_at IS DISTINCT FROM OLD.policies_acknowledged_at THEN
    RAISE EXCEPTION 'the policies recorded for an order can never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_marketplace_orders_policy_guard ON marketplace_orders;
CREATE TRIGGER trg_marketplace_orders_policy_guard BEFORE UPDATE ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_policy_guard();

-- A recorded seller policy must be that order's own seller's policy.
CREATE OR REPLACE FUNCTION marketplace_orders_policy_owner_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k TEXT; vid TEXT;
BEGIN
  IF NEW.policy_snapshot IS NULL THEN RETURN NEW; END IF;
  FOREACH k IN ARRAY ARRAY['store_terms','shipping_pickup'] LOOP
    vid := NEW.policy_snapshot -> k ->> 'version_id';
    IF vid IS NOT NULL AND (vid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (SELECT 1 FROM seller_policy_versions v WHERE v.id = vid::uuid AND v.seller_id = NEW.seller_id AND v.kind = k AND v.status = 'published')) THEN
      RAISE EXCEPTION 'an order can only record its own seller''s % policy', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_marketplace_orders_policy_owner ON marketplace_orders;
CREATE TRIGGER trg_marketplace_orders_policy_owner BEFORE INSERT ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_policy_owner_check();
