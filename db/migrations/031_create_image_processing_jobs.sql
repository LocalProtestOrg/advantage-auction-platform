-- Migration: 031_create_image_processing_jobs.sql
-- Tracks AI image enhancement jobs for uploaded lot photos.
-- Each row represents one image through the processing pipeline.

CREATE TABLE IF NOT EXISTS image_processing_jobs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_temp_id         TEXT,
  original_image_url  TEXT        NOT NULL,
  processed_image_url TEXT,
  status              TEXT        NOT NULL DEFAULT 'pending',
  enhancement_type    TEXT        NOT NULL,
  provider            TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_img_jobs_status     ON image_processing_jobs(status);
CREATE INDEX idx_img_jobs_created_at ON image_processing_jobs(created_at);

-- TODO: remove.bg integration — call remove.bg API for background removal jobs
-- TODO: Replicate integration — use Replicate models for complex scene editing
-- TODO: Cloudinary AI — use Cloudinary background removal + auto-crop transforms
-- TODO: shadow generation — add drop shadow via compositing after bg removal
-- TODO: auto crop — detect subject bounding box and center with padding
