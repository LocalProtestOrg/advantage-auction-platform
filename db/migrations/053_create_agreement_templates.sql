-- Migration: 053_create_agreement_templates.sql
-- Seller Agreement System — Phase A. Agreement templates + IMMUTABLE versions.
-- Additive only. A template has many versions; versions are never updated in
-- place (edits publish a new version_int). agreement_templates.current_version_id
-- is an internal pointer (no FK, to avoid a circular dependency with the
-- versions table); integrity is enforced in the service layer.

CREATE TABLE IF NOT EXISTS agreement_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_type     TEXT NOT NULL CHECK (agreement_type IN (
                       'private','business','auction_house',
                       'estate_sale_company','professional_liquidator','custom')),
  name               TEXT NOT NULL,
  description        TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  current_version_id UUID,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agreement_template_versions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id              UUID NOT NULL REFERENCES agreement_templates(id) ON DELETE CASCADE,
  version_int              INTEGER NOT NULL,
  body_markdown            TEXT NOT NULL,
  variable_schema          JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_terms_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_int)
);

CREATE INDEX IF NOT EXISTS idx_agreement_templates_type ON agreement_templates(agreement_type);
CREATE INDEX IF NOT EXISTS idx_agreement_template_versions_template ON agreement_template_versions(template_id);
