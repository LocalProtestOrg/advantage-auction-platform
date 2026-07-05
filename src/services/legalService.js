'use strict';

/**
 * legalService — per-tenant, versioned legal documents with an acceptance ledger
 * (Constitution §8/§12). A document belongs to an organization (NULL = platform default).
 * Publishing a version unpublishes its siblings. getPublished falls back to the platform
 * default when a Partner has none. Generalizes the older agreement-specific system.
 */

const db = require('../db');
const { svcErr } = require('../utils/apiError');

const DOC_TYPES = ['buyer_terms', 'seller_agreement', 'privacy_policy', 'refund_policy', 'pickup_policy'];

async function upsertDocument(organizationId, docType, title) {
  if (!DOC_TYPES.includes(docType)) throw svcErr(400, 'INVALID_DOC_TYPE', 'Unknown legal document type.');
  if (!title || !String(title).trim()) throw svcErr(400, 'TITLE_REQUIRED', 'A document title is required.');
  const { rows } = await db.query(
    `INSERT INTO legal_documents (organization_id, doc_type, title) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, doc_type) DO UPDATE SET title = EXCLUDED.title RETURNING *`,
    [organizationId || null, docType, title]);
  return rows[0];
}

async function addVersion(documentId, content) {
  if (!content || !String(content).trim()) throw svcErr(400, 'CONTENT_REQUIRED', 'Version content is required.');
  const { rows: n } = await db.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM legal_document_versions WHERE document_id = $1', [documentId]);
  const { rows } = await db.query(
    'INSERT INTO legal_document_versions (document_id, version, content) VALUES ($1, $2, $3) RETURNING *',
    [documentId, n[0].v, content]);
  return rows[0];
}

/** Publish a version (unpublishing siblings) so it becomes the current published doc. */
async function publishVersion(versionId) {
  const { rows } = await db.query('SELECT document_id FROM legal_document_versions WHERE id = $1', [versionId]);
  if (!rows.length) throw svcErr(404, 'VERSION_NOT_FOUND', 'Version not found.');
  const docId = rows[0].document_id;
  await db.query('UPDATE legal_document_versions SET is_published = false WHERE document_id = $1', [docId]);
  const { rows: pub } = await db.query(
    'UPDATE legal_document_versions SET is_published = true, published_at = now() WHERE id = $1 RETURNING *', [versionId]);
  return pub[0];
}

/** Current published version for (org, doc_type); falls back to the platform default. */
async function getPublished(organizationId, docType) {
  const sql = `SELECT v.*, d.doc_type, d.title, d.organization_id
                 FROM legal_document_versions v JOIN legal_documents d ON d.id = v.document_id
                WHERE d.doc_type = $1 AND d.organization_id IS NOT DISTINCT FROM $2 AND v.is_published = true
                ORDER BY v.version DESC LIMIT 1`;
  let { rows } = await db.query(sql, [docType, organizationId || null]);
  if (!rows.length && organizationId) ({ rows } = await db.query(sql, [docType, null]));
  return rows[0] || null;
}

/** Record a user's acceptance of a specific version (idempotent). */
async function accept(userId, versionId, organizationId, ip) {
  const { rows } = await db.query(
    `INSERT INTO legal_acceptances (user_id, document_version_id, organization_id, ip) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, document_version_id) DO NOTHING RETURNING *`,
    [userId, versionId, organizationId || null, ip || null]);
  return rows[0] || { already_accepted: true };
}

module.exports = { DOC_TYPES, upsertDocument, addVersion, publishVersion, getPublished, accept };
