'use strict';

/**
 * agreementTemplateService — agreement templates with IMMUTABLE versions.
 * Editing a template publishes a NEW version (version_int += 1); existing
 * versions are never mutated, so any agreement that pins a version_id stays
 * reproducible. Phase A: admin authoring only (no send/sign).
 */
const db = require('../db/index');
const { writeAuditLog } = require('../lib/auditLog');

const AGREEMENT_TYPES = [
  'private', 'business', 'auction_house',
  'estate_sale_company', 'professional_liquidator', 'custom',
];

async function createTemplate({ agreement_type, name, description, created_by }) {
  const { rows } = await db.query(
    `INSERT INTO agreement_templates (agreement_type, name, description, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [agreement_type, name, description ?? null, created_by ?? null]
  );
  const tpl = rows[0];
  await writeAuditLog({
    event_type: 'agreement_template_created', entity_type: 'agreement_template',
    entity_id: tpl.id, actor_id: created_by ?? null,
    metadata: { agreement_type, name },
  });
  return tpl;
}

// Publish a new immutable version and point the template at it (transactional).
async function publishVersion(templateId, { body_markdown, variable_schema, effective_terms_defaults, created_by }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query('SELECT id FROM agreement_templates WHERE id = $1 FOR UPDATE', [templateId]);
    if (!t.rows[0]) { await client.query('ROLLBACK'); return null; }

    const v = await client.query(
      'SELECT COALESCE(MAX(version_int), 0) + 1 AS next FROM agreement_template_versions WHERE template_id = $1',
      [templateId]
    );
    const nextVer = v.rows[0].next;

    const ins = await client.query(
      `INSERT INTO agreement_template_versions
         (template_id, version_int, body_markdown, variable_schema, effective_terms_defaults, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
      [templateId, nextVer, body_markdown,
       JSON.stringify(variable_schema ?? []), JSON.stringify(effective_terms_defaults ?? {}), created_by ?? null]
    );
    await client.query(
      'UPDATE agreement_templates SET current_version_id = $1, updated_at = now() WHERE id = $2',
      [ins.rows[0].id, templateId]
    );
    await client.query('COMMIT');

    await writeAuditLog({
      event_type: 'agreement_template_version_published', entity_type: 'agreement_template',
      entity_id: templateId, actor_id: created_by ?? null,
      metadata: { version_int: nextVer, version_id: ins.rows[0].id },
    });
    return ins.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listTemplates() {
  const { rows } = await db.query(
    `SELECT t.*, v.version_int AS current_version_int
       FROM agreement_templates t
       LEFT JOIN agreement_template_versions v ON v.id = t.current_version_id
      ORDER BY t.created_at DESC`
  );
  return rows;
}

async function getTemplate(id) {
  const { rows } = await db.query('SELECT * FROM agreement_templates WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const tpl = rows[0];
  let current_version = null;
  if (tpl.current_version_id) {
    const v = await db.query('SELECT * FROM agreement_template_versions WHERE id = $1', [tpl.current_version_id]);
    current_version = v.rows[0] || null;
  }
  const versions = await db.query(
    'SELECT id, version_int, created_at FROM agreement_template_versions WHERE template_id = $1 ORDER BY version_int DESC',
    [id]
  );
  return { ...tpl, current_version, versions: versions.rows };
}

async function setActive(id, isActive, actorId) {
  const { rows } = await db.query(
    'UPDATE agreement_templates SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [!!isActive, id]
  );
  if (!rows[0]) return null;
  await writeAuditLog({
    event_type: 'agreement_template_active_changed', entity_type: 'agreement_template',
    entity_id: id, actor_id: actorId ?? null, metadata: { is_active: !!isActive },
  });
  return rows[0];
}

module.exports = { AGREEMENT_TYPES, createTemplate, publishVersion, listTemplates, getTemplate, setActive };
