-- Migration: 038_create_auction_walkthrough_videos.sql
-- Normalized table for auction walkthrough videos with full admin review lifecycle.
--
-- Visibility rules enforced at the application layer:
--   visible_public    = false by default — never auto-published
--   featured_for_marketing = false by default — requires explicit admin action
--   Public display requires visible_public = true (admin-set only)
--   Marketing usage requires featured_for_marketing = true (admin-set only)

CREATE TABLE IF NOT EXISTS auction_walkthrough_videos (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id            UUID        NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,

  -- Asset
  video_url             TEXT        NOT NULL,
  title                 TEXT,
  caption               TEXT,

  -- Admin review lifecycle
  review_status         TEXT        NOT NULL DEFAULT 'pending_review'
                          CHECK (review_status IN ('pending_review', 'approved', 'rejected')),
  approved_at           TIMESTAMPTZ,
  approved_by           UUID        REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason      TEXT,

  -- Visibility controls — both default false; admin must explicitly enable
  visible_public        BOOLEAN     NOT NULL DEFAULT false,
  featured_for_marketing BOOLEAN    NOT NULL DEFAULT false,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_walkthrough_auction   ON auction_walkthrough_videos(auction_id);
CREATE INDEX IF NOT EXISTS idx_walkthrough_status    ON auction_walkthrough_videos(review_status);
CREATE INDEX IF NOT EXISTS idx_walkthrough_visible   ON auction_walkthrough_videos(visible_public) WHERE visible_public = true;
CREATE INDEX IF NOT EXISTS idx_walkthrough_marketing ON auction_walkthrough_videos(featured_for_marketing) WHERE featured_for_marketing = true;

-- Auto-update updated_at
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_walkthrough_videos_updated_at') THEN
    CREATE TRIGGER trg_walkthrough_videos_updated_at
    BEFORE UPDATE ON auction_walkthrough_videos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END$$;
